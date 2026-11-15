import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseTsTypes, mapTsType, resolveTypeForSegment } from '../scripts/lib/ts-types.mjs';
import { inferPathShape, fieldsFromSelect, mergeGapIntoScenario, runHarvest, formatHarvestReport } from '../scripts/lib/harvest.mjs';
import { loadScenario } from '../scripts/lib/scenario.mjs';
import { generateWorld } from '../scripts/lib/world.mjs';
import { createEngine } from '../scripts/lib/contract.mjs';
import { loadPlaywright, chromeExecutable } from '../scripts/lib/verify.mjs';
import { ROOT, tmpProject, cliAsync } from './helpers.mjs';

const TYPES_FIXTURE = `// Sample client types
export type Priority = 'low' | 'medium' | 'high';
export type IsoDate = string;

export interface BaseEntity {
  id: number;
  created_at: Date;
}

export interface Task extends BaseEntity {
  title: string;
  estimate: number;
  done: boolean;
  priority: Priority;
  due_date: '2025-05-01T10:00:00Z';
  tags: string[];
  meta: Record<string, unknown>;
}

export type Project = {
  id: number;
  name: string;
  status: 'active' | 'archived';
  archived: boolean;
};

export interface TasksResponse {
  items: Task[];
  total: number;
}

export interface ProfileResponse {
  username: string;
  plan: 'free' | 'pro';
}
`;

// ---------- unit tests ----------

test('parseTsTypes & mapTsType: interfaces, type objects, unions, dates, primitive arrays, and line numbers', () => {
  const parsed = parseTsTypes(TYPES_FIXTURE, 'types.ts');
  assert.equal(parsed.objects.get('Task').line, 10);
  assert.equal(parsed.objects.get('Project').line, 20);

  const taskMatch = resolveTypeForSegment(parsed, 'tasks');
  assert.equal(taskMatch.line, 10);
  assert.equal(taskMatch.shape, 'envelope');
  assert.equal(taskMatch.pick, 'items');
  assert.deepEqual(taskMatch.fields, {
    created_at: 'date',
    title: 'string',
    estimate: 'integer',
    done: 'boolean',
    priority: ['low', 'medium', 'high'],
    due_date: 'date',
  });
  assert.deepEqual(taskMatch.values, { tags: [['item 1', 'item 2']] });
  assert.ok(taskMatch.skipped.some((s) => /meta.*Record/.test(s)));

  const projMatch = resolveTypeForSegment(parsed, 'projects');
  assert.equal(projMatch.line, 20);
  assert.equal(projMatch.shape, null);
  assert.deepEqual(projMatch.fields, {
    name: 'string',
    status: ['active', 'archived'],
    archived: 'boolean',
  });

  // Response type without items/data implies singleton shape: object
  const profMatch = resolveTypeForSegment(parsed, 'profile');
  assert.equal(profMatch.shape, 'object');
  assert.deepEqual(profMatch.fields, { username: 'string', plan: ['free', 'pro'] });

  // Direct mapTsType checks
  assert.deepEqual(mapTsType('string | null'), { type: 'string' });
  assert.deepEqual(mapTsType('number'), { type: 'integer' });
  assert.deepEqual(mapTsType('boolean'), { type: 'boolean' });
  assert.deepEqual(mapTsType('ISODate'), { type: 'date' });
  assert.deepEqual(mapTsType('Array<number>'), { arrayValues: [1, 2] });
});

test('inferPathShape & fieldsFromSelect: nested params, detail routes, and PostgREST select', () => {
  assert.deepEqual(inferPathShape('/api/v2/projects/1/views/4/tasks'), {
    path: '/api/v2/projects/:project_id/views/:view_id/tasks',
    params: [{ name: 'project_id', observed: '1' }, { name: 'view_id', observed: '4' }],
    lastSeg: 'tasks',
    detailId: null,
  });
  assert.deepEqual(inferPathShape('/api/users/42'), {
    path: '/api/users',
    params: [],
    lastSeg: 'users',
    detailId: '42',
  });

  const sel = fieldsFromSelect(['id,title,is_done,created_at,tasks(count),*']);
  assert.deepEqual(sel.fields, { title: 'string', is_done: 'boolean', created_at: 'date' });
  assert.deepEqual(sel.skipped, []);
});

test('mergeGapIntoScenario: preference types -> select= -> guess, singleton heuristic, and preserves existing keys', () => {
  const doc = {
    name: 'demo',
    description: 'keep me',
    seed: 99,
    now: '2025-02-01T00:00:00Z',
    world: { projects: 3 },
    endpoints: [{ path: '/api/projects', entity: 'projects', sort: '-id' }],
    entry: 'home',
    path: ['home'],
    expect: [{ selector: '.row', count: 3 }],
  };
  const parsed = parseTsTypes(TYPES_FIXTURE, 'types.ts');

  // 1) --types match with nested param binding to existing `projects`
  const r1 = mergeGapIntoScenario(
    doc,
    { method: 'GET', path: '/api/v2/projects/:id/tasks', example: '/api/v2/projects/1/tasks', query: { done: 'true', limit: '10', offset: '0' } },
    { parsedTypes: parsed, typesLabel: 'types.ts' },
  );
  assert.equal(r1.changed, true);
  assert.equal(r1.record.source, 'types:types.ts:10');
  assert.equal(r1.record.path, '/api/v2/projects/:project_id/tasks');
  assert.equal(doc.world.tasks.ref, 'projects');
  assert.deepEqual(doc.world.tasks.values, { tags: [['item 1', 'item 2']] });

  // 2) select= fallback when --types does not match
  const r2 = mergeGapIntoScenario(
    doc,
    { method: 'GET', path: '/api/notes', example: '/api/notes', query: { select: 'id,heading,updated_at' } },
    { parsedTypes: parsed, typesLabel: 'types.ts' },
  );
  assert.equal(r2.record.source, 'select=');
  assert.deepEqual(doc.world.notes.fields, { heading: 'string', updated_at: 'date' });

  // 3) guess fallback + singleton heuristic (`info`, `user`, `me`, `config`, `settings`)
  const r3 = mergeGapIntoScenario(
    doc,
    { method: 'GET', path: '/api/config', example: '/api/config', query: {} },
    {},
  );
  assert.equal(r3.record.source, 'guess');
  assert.equal(r3.record.shape, 'object');
  assert.equal(r3.record.entity, 'configs');
  assert.ok(r3.record.fields.includes('id'));

  // Existing keys preserved untouched
  assert.equal(doc.description, 'keep me');
  assert.equal(doc.seed, 99);
  assert.equal(doc.entry, 'home');
  assert.deepEqual(doc.endpoints[0], { path: '/api/projects', entity: 'projects', sort: '-id' });

  // Resulting world & endpoints generate valid data
  const dataset = generateWorld(loadScenarioFromObj(doc));
  const engine = createEngine(dataset);
  const t = engine.handle({ pathname: '/api/v2/projects/1/tasks' });
  assert.equal(t.status, 200);
  assert.ok(Array.isArray(t.body.items));
  assert.deepEqual(t.body.items[0].tags, ['item 1', 'item 2']);
  assert.equal(engine.handle({ pathname: '/api/config' }).status, 200);
  assert.ok(!Array.isArray(engine.handle({ pathname: '/api/config' }).body));
});

import { normalizeScenario } from '../scripts/lib/scenario.mjs';
const loadScenarioFromObj = (doc) => normalizeScenario(doc, 'test.yaml');

test('harvest reports mutations without mocking them and leaves original untouched without --write', async () => {
  const dir = tmpProject({
    's.yaml': 'name: app\nseed: 1\nworld:\n  health: 1\nendpoints:\n  - path: /api/health\n    entity: health\n',
  });
  let hit = false;
  const fakeFactory = async () => ({
    page: {
      on: () => {},
      off: () => {},
      goto: async (u) => {
        if (!hit) {
          hit = true;
          const base = new URL(u).origin;
          await fetch(`${base}/api/health`, { method: 'POST', body: '{}' });
          await fetch(`${base}/api/widgets`);
        }
      },
    },
    close: async () => {},
  });

  const res = await runHarvest({
    url: '/',
    scenarioFile: 's.yaml',
    write: false,
    cwd: dir,
    pageFactory: fakeFactory,
  });
  try {
    assert.equal(res.written, null);
    assert.ok(existsSync(res.tempFile));
    assert.equal(res.mutations.length, 1);
    assert.equal(res.mutations[0].method, 'POST');
    assert.equal(res.discovered.length, 1);
    assert.equal(res.discovered[0].path, '/api/widgets');
    const report = formatHarvestReport(res);
    assert.match(report, /GET \/api\/widgets/);
    assert.match(report, /guess/);
    assert.match(report, /POST \/api\/health: write not mocked/);
    assert.match(report, /Temporary copy:/);
    // Original scenario file was NOT touched
    assert.doesNotMatch(readFileSync(join(dir, 's.yaml'), 'utf8'), /widgets/);
  } finally {
    rmSync(join(res.tempFile, '..'), { recursive: true, force: true });
  }
});

test('harvest is deterministic and captures requests retried after a failed request', async () => {
  const mkDir = () => tmpProject({
    's.yaml': 'name: app\nseed: 5\nworld:\n  health: 1\nendpoints:\n  - path: /api/health\n    entity: health\n',
  });
  const runOnce = async () => {
    const dir = mkDir();
    let round = 0;
    const res = await runHarvest({
      url: '/',
      scenarioFile: 's.yaml',
      cwd: dir,
      pageFactory: async () => ({
        page: {
          on: () => {},
          off: () => {},
          goto: async (u) => {
            round++;
            const base = new URL(u).origin;
            if (round === 1) {
              await fetch(`${base}/api/alpha?status=open`);
              // Fallback/retry made after a failed request:
              await fetch(`${base}/api/alpha?status=open`);
              await fetch(`${base}/api/beta?select=id,label`);
            }
          },
        },
        close: async () => {},
      }),
    });
    const yaml = res.yaml;
    rmSync(join(res.tempFile, '..'), { recursive: true, force: true });
    return yaml;
  };
  const y1 = await runOnce();
  const y2 = await runOnce();
  assert.equal(y1, y2);
  assert.match(y1, /\/api\/alpha/);
  assert.match(y1, /\/api\/beta/);
  assert.match(y1, /label: string/);
});

// ---------- real Chromium + builtin runtime integration tests ----------

const realPw = await loadPlaywright(ROOT);
const realChrome = realPw && (chromeExecutable(realPw.name) ?? (realPw.name !== 'playwright-core' ? 'bundled' : null));
const skipReal = !realPw ? 'playwright(-core) not installed in the repo' : !realChrome || (realChrome !== 'bundled' && !existsSync(realChrome)) ? 'no Chromium (set ATREZZO_CHROME)' : false;

const CHAINED_HTML = `<!doctype html>
<html>
<body>
  <div id="status">loading</div>
  <ul id="items"></ul>
  <script>
    (async () => {
      const r1 = await fetch('/api/info');
      if (!r1.ok) { document.getElementById('status').textContent = 'failed-1'; return; }
      const info = await r1.json();
      document.getElementById('status').textContent = 'step-1';
      const badge = document.createElement('div');
      badge.textContent = 'step-1-ready';
      document.body.appendChild(badge);

      const r2 = await fetch('/api/projects');
      if (!r2.ok) { document.getElementById('status').textContent = 'failed-2'; return; }
      const projects = await r2.json();
      document.getElementById('status').textContent = 'step-2';

      const firstId = projects[0]?.id ?? 1;
      const r3 = await fetch('/api/projects/' + firstId + '/tasks');
      if (!r3.ok) { document.getElementById('status').textContent = 'failed-3'; return; }
      const tasks = await r3.json();
      const ul = document.getElementById('items');
      for (const t of tasks) {
        const li = document.createElement('li');
        li.setAttribute('data-testid', 'task-row');
        li.textContent = t.name || t.title || String(t.id);
        ul.appendChild(li);
      }
      document.getElementById('status').setAttribute('data-done', 'true');
      document.getElementById('status').textContent = 'rendered:' + info.id + ':' + tasks.length;
    })();
  </script>
</body>
</html>
`;

test('real Chromium: fixture app with three chained endpoints → harvest discovers all three and renders', { skip: skipReal, timeout: 90_000 }, async () => {
  const dir = tmpProject({
    'index.html': CHAINED_HTML,
    // Starts with /api/info whose entity has 0 rows (singleton 404 gap) so all 3 chained calls fail in sequence.
    'scenario.yaml': 'name: chained\nseed: 11\nworld:\n  infos: 0\nendpoints:\n  - path: /api/info\n    entity: infos\n    shape: object\n',
  });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));

  const res = await cliAsync(['harvest', '/', '--scenario', 'scenario.yaml', '--static', '.', '--write'], dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /GET \/api\/info/);
  assert.match(res.stdout, /GET \/api\/projects/);
  assert.match(res.stdout, /GET \/api\/projects\/:project_id\/tasks/);
  assert.match(res.stdout, /Updated: scenario\.yaml/);

  const sc = loadScenario(join(dir, 'scenario.yaml'));
  assert.equal(sc.endpoints.length, 3);
  assert.deepEqual(sc.endpoints.map((e) => e.path), ['/api/info', '/api/projects', '/api/projects/:project_id/tasks']);

  // Verify the page actually renders completely against the harvested scenario (stopped at round 1 by --until).
  const check = await runHarvest({
    url: '/',
    scenarioFile: 'scenario.yaml',
    until: '[data-done=true]',
    staticDir: '.',
    cwd: dir,
  });
  try {
    assert.equal(check.stoppedReason, 'until');
    assert.equal(check.roundsRun, 1);
    assert.equal(check.discovered.length, 0);
  } finally {
    if (check.tempFile) rmSync(join(check.tempFile, '..'), { recursive: true, force: true });
  }
});

test('real Chromium: --types populates entity fields from TypeScript interface and prints types:<file>:<line>', { skip: skipReal, timeout: 90_000 }, async () => {
  const html = `<!doctype html>
<html><body>
  <div id="out"></div>
  <script>
    (async () => {
      const r = await fetch('/api/tasks');
      if (!r.ok) return;
      const body = await r.json();
      const rows = body.items ?? body;
      document.getElementById('out').textContent = rows.map(x => x.title + ':' + x.estimate + ':' + x.priority).join(',');
      document.getElementById('out').setAttribute('data-loaded', '1');
    })();
  </script>
</body></html>`;

  const dir = tmpProject({
    'index.html': html,
    'types.ts': TYPES_FIXTURE,
    'scenario.yaml': 'name: typed\nseed: 7\nworld:\n  health: 1\nendpoints:\n  - path: /api/health\n    entity: health\n',
  });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));

  const res = await cliAsync(['harvest', '/', '--scenario', 'scenario.yaml', '--static', '.', '--types', 'types.ts', '--write'], dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /GET \/api\/tasks\s+tasks\s+envelope\s+types:types\.ts:10/);
  assert.match(res.stdout, /Could not infer/);
  assert.match(res.stdout, /meta/);

  const sc = loadScenario(join(dir, 'scenario.yaml'));
  const tasks = sc.world.find((e) => e.name === 'tasks');
  assert.ok(tasks);
  assert.deepEqual(tasks.fields, {
    created_at: 'date',
    title: 'string',
    estimate: 'integer',
    done: 'boolean',
    priority: ['low', 'medium', 'high'],
    due_date: 'date',
  });
  assert.deepEqual(tasks.pools, { tags: [['item 1', 'item 2']] });
});

test('real Chromium: --until stops harvest early as soon as selector appears', { skip: skipReal, timeout: 90_000 }, async () => {
  const dir = tmpProject({
    'index.html': CHAINED_HTML,
    'scenario.yaml': 'name: early\nseed: 3\nworld:\n  infos: 0\nendpoints:\n  - path: /api/info\n    entity: infos\n    shape: object\n',
  });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));

  // Stop as soon as text=step-1-ready appears (after /api/info succeeds in round 2, before /api/projects or /tasks are added).
  const res = await cliAsync(['harvest', '/', '--scenario', 'scenario.yaml', '--static', '.', '--until', 'text=step-1-ready', '--rounds', '5', '--write'], dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /2 rounds · stopped: until/);

  const sc = loadScenario(join(dir, 'scenario.yaml'));
  assert.equal(sc.endpoints.length, 1, 'stopped early before adding /api/projects or /api/projects/:project_id/tasks');
});

test('harvest --storage: ${…} in storage file or key exits 3 without navigating and never expands env', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('ok');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const appUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const dir = tmpProject({
      's.yaml': 'name: app\nseed: 1\nworld:\n  health: 1\nendpoints:\n  - path: /api/health\n    entity: health\n',
      'bad-val.json': '{"local":{"token":"${API_TOKEN}"},"session":{}}',
      'bad-key.json': '{"local":{},"session":{"${KEY}":"v"}}',
    });

    const r1 = await cliAsync(['harvest', appUrl, '--scenario', 's.yaml', '--storage', 'bad-val.json'], dir, { API_TOKEN: 'env-secret-must-not-leak' });
    assert.equal(r1.code, 3, r1.stdout + r1.stderr);
    assert.match(r1.stderr, /storage\.local\.token.*\$\{…\} is not expanded: atrezzo reads no environment variables/s);
    assert.equal(seen.length, 0, 'must not navigate when storage is invalid');
    assert.ok(!(r1.stdout + r1.stderr).includes('env-secret-must-not-leak'));

    const r2 = await cliAsync(['harvest', appUrl, '--scenario', 's.yaml', '--storage', 'bad-key.json'], dir);
    assert.equal(r2.code, 3, r2.stdout + r2.stderr);
    assert.match(r2.stderr, /storage\.session\.\$\{KEY\}.*\$\{…\} is not expanded/s);
    assert.equal(seen.length, 0);

    const r3 = await cliAsync(['harvest', appUrl, '--scenario', 's.yaml', '--storage', '@-'], dir, { API_TOKEN: 'env-secret-must-not-leak' }, '{"local":{"token":"${API_TOKEN}"}}');
    assert.equal(r3.code, 3, r3.stdout + r3.stderr);
    assert.match(r3.stderr, /storage\.local\.token.*\$\{…\} is not expanded/s);
    assert.equal(seen.length, 0);
    assert.ok(!(r3.stdout + r3.stderr).includes('env-secret-must-not-leak'));
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});

test('harvest --storage: report prints storage keys and never prints values', async () => {
  const dir = tmpProject({
    's.yaml': 'name: app\nseed: 1\nworld:\n  health: 1\nendpoints:\n  - path: /api/health\n    entity: health\n',
    'storage.json': '{"local":{"token":"super-secret-jwt-999"},"session":{"csrf":"secret-csrf-123"}}',
  });
  const initScripts = [];
  const res = await runHarvest({
    url: '/',
    scenarioFile: 's.yaml',
    storageFile: 'storage.json',
    cwd: dir,
    pageFactory: async () => ({
      context: { addInitScript: async (s) => { initScripts.push(s); } },
      page: {
        on: () => {},
        off: () => {},
        goto: async () => {},
      },
      close: async () => {},
    }),
  });
  try {
    assert.equal(initScripts.length, 1);
    assert.deepEqual(res.storage, { local: ['token'], session: ['csrf'] });
    const report = formatHarvestReport(res);
    assert.match(report, /Storage \(keys\): local: token · session: csrf/);
    assert.ok(!report.includes('super-secret-jwt-999'), 'local value must never be printed');
    assert.ok(!report.includes('secret-csrf-123'), 'session value must never be printed');
    assert.ok(!JSON.stringify(res).includes('super-secret-jwt-999'), 'result must not expose values');
    assert.ok(!JSON.stringify(res).includes('secret-csrf-123'), 'result must not expose values');
  } finally {
    rmSync(join(res.tempFile, '..'), { recursive: true, force: true });
  }
});

const GUARDED_HTML = `<!doctype html>
<html>
<body>
  <div id="app">loading</div>
  <ul id="projects"></ul>
  <script>
    (async () => {
      if (location.pathname === '/login') {
        document.getElementById('app').setAttribute('data-view', 'login');
        document.getElementById('app').textContent = 'login-screen';
        return;
      }
      if (!localStorage.getItem('token')) {
        location.replace('/login');
        return;
      }
      const r1 = await fetch('/api/me');
      if (!r1.ok) { document.getElementById('app').textContent = 'missing-me'; return; }
      const me = await r1.json();

      const r2 = await fetch('/api/projects');
      if (!r2.ok) { document.getElementById('app').textContent = 'missing-projects'; return; }
      const projects = await r2.json();

      const ul = document.getElementById('projects');
      for (const p of projects) {
        const li = document.createElement('li');
        li.textContent = p.name || String(p.id);
        ul.appendChild(li);
      }
      document.getElementById('app').setAttribute('data-view', 'dashboard');
      document.getElementById('app').textContent = 'dashboard:' + me.id + ':' + projects.length;
    })();
  </script>
</body>
</html>
`;

test('real Chromium: guarded page without --storage only sees /login; with --storage discovers both endpoints and mounts view', { skip: skipReal, timeout: 90_000 }, async () => {
  const dir = tmpProject({
    'index.html': GUARDED_HTML,
    'scenario.yaml': 'name: guarded\nseed: 4\nworld:\n  health: 1\nendpoints:\n  - path: /api/health\n    entity: health\n',
    'storage.json': '{"local":{"token":"jwt-secret-fixture-value"},"session":{}}',
  });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));

  // Without --storage: guard redirects to /login, never hits /api/me or /api/projects.
  const withoutStorage = await runHarvest({
    url: '/',
    scenarioFile: 'scenario.yaml',
    staticDir: '.',
    until: '[data-view=login]',
    cwd: dir,
  });
  try {
    assert.equal(withoutStorage.stoppedReason, 'until');
    assert.equal(withoutStorage.roundsRun, 1);
    assert.deepEqual(withoutStorage.discovered, []);
    assert.equal(withoutStorage.storage, undefined);
    assert.doesNotMatch(formatHarvestReport(withoutStorage), /Storage \(keys\)/);
  } finally {
    if (withoutStorage.tempFile) rmSync(join(withoutStorage.tempFile, '..'), { recursive: true, force: true });
  }

  // With --storage: addInitScript seeds localStorage.token before first navigation,
  // discovers both endpoints, finishes with the dashboard mounted, and prints keys only.
  const withStorage = await cliAsync(
    ['harvest', '/', '--scenario', 'scenario.yaml', '--static', '.', '--storage', 'storage.json', '--until', '[data-view=dashboard]', '--write'],
    dir,
  );
  assert.equal(withStorage.code, 0, withStorage.stdout + withStorage.stderr);
  assert.match(withStorage.stdout, /Storage \(keys\): local: token/);
  assert.match(withStorage.stdout, /stopped: until/);
  assert.match(withStorage.stdout, /GET \/api\/me/);
  assert.match(withStorage.stdout, /GET \/api\/projects/);
  assert.ok(!(withStorage.stdout + withStorage.stderr).includes('jwt-secret-fixture-value'));

  const sc = loadScenario(join(dir, 'scenario.yaml'));
  assert.deepEqual(sc.endpoints.map((e) => e.path), ['/api/health', '/api/me', '/api/projects']);

  // Also verify --storage @- reads storage from stdin and keeps the value out of output.
  const fromStdin = await cliAsync(
    ['harvest', '/', '--scenario', 'scenario.yaml', '--static', '.', '--storage', '@-', '--until', '[data-view=dashboard]', '--write'],
    dir,
    {},
    '{"local":{"token":"stdin-secret-value-777"},"session":{}}',
  );
  assert.equal(fromStdin.code, 0, fromStdin.stdout + fromStdin.stderr);
  assert.match(fromStdin.stdout, /Storage \(keys\): local: token/);
  assert.match(fromStdin.stdout, /1 round · stopped: until/);
  assert.ok(!(fromStdin.stdout + fromStdin.stderr).includes('stdin-secret-value-777'));
});
