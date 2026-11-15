import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { createMissStore, missPattern, guessShape, findInSpec, hintFor, maskQuery, safeSearch, MISS_CAP } from '../scripts/lib/misses.mjs';
import { loadSpec } from '../scripts/lib/openapi.mjs';
import { loadScenario } from '../scripts/lib/scenario.mjs';
import { doctor } from '../scripts/lib/doctor.mjs';
import { loadPlaywright, chromeExecutable } from '../scripts/lib/verify.mjs';
import { ROOT, tmpProject, cli, cliAsync } from './helpers.mjs';
import { request, getJson, postJson, del } from './helpers/http.mjs';
import { startServe } from './helpers/serve.mjs';

const CATALOGO = `name: catalogo
seed: 3
world:
  products: 5
endpoints:
  - path: /api/products
    entity: products
`;
const PATCH = `  - path: /api/users
    entity: users
`;
const PATCH_WORLD = (yaml) => yaml.replace('world:\n', 'world:\n  users: 4\n') + PATCH;

const CONFIG = (extra = {}) => JSON.stringify({
  version: 1, runtime: 'builtin', scenariosDir: 'scenarios', handlersDir: 'atrezzo/handlers', generatedDir: 'atrezzo/.generated',
  mock: { baseUrl: 'http://127.0.0.1:4010', port: 4010, static: '.' }, verify: { driver: 'http' }, ...extra,
}, null, 2);

async function startServer(opts = {}) {
  const dir = tmpProject({ 'scenarios/catalogo.yaml': CATALOGO });
  const file = join(dir, 'atrezzo/.atrezzo/misses.json');
  const mock = createMockServer({ scenariosDir: join(dir, 'scenarios'), missesFile: file, ...opts });
  const url = `http://127.0.0.1:${(await mock.listen(0)).port}`;
  return { dir, file, mock, url };
}

// ---------- units ----------

test('missPattern collapses ids and the trailing slash; guessShape collection vs detail', () => {
  assert.equal(missPattern('/api/users/42/'), '/api/users/:id');
  assert.equal(missPattern('/api/users/3f2a9c1e-1b2c-4d5e-8f90-1234567890ab/orders'), '/api/users/:id/orders');
  assert.equal(missPattern('/api/me'), '/api/me');
  assert.equal(guessShape('/api/users'), 'collection');
  assert.equal(guessShape('/api/users/:id'), 'detail');
  assert.equal(guessShape('/api/me'), 'detail');
  assert.equal(guessShape('/api/status'), 'detail');
});

test('maskQuery/safeSearch: secret-looking names and values come out as ***', () => {
  const q = new URLSearchParams('token=abc&page=2&api_key=x&q=eyJhbGciOi.eyJzdWIi.sig&h=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6');
  assert.deepEqual(maskQuery(q), { token: '***', page: '2', api_key: '***', q: '***', h: '***' });
  assert.equal(safeSearch(new URLSearchParams('token=abc&page=2')), '?token=***&page=2');
});

test('store: dedupe by METHOD+path, collapsed ids and an entry cap', () => {
  const s = createMissStore(null);
  s.record({ method: 'GET', pathname: '/api/users/1', status: 404 });
  s.record({ method: 'GET', pathname: '/api/users/2', status: 404 });
  s.record({ method: 'HEAD', pathname: '/api/users/3/', status: 404 });
  assert.equal(s.list().length, 1);
  assert.equal(s.list()[0].path, '/api/users/:id');
  assert.equal(s.list()[0].times, 3);
  for (let i = 0; i < MISS_CAP + 20; i++) s.record({ method: 'GET', pathname: `/api/r${i}`, status: 404 });
  assert.equal(s.list().length, MISS_CAP);
});

test('findInSpec / hintFor: contract has the route ⇒ import; it does not ⇒ skill; mutation ⇒ stub', () => {
  const spec = loadSpec(join(ROOT, 'tests/fixtures/petstore.yaml'));
  assert.deepEqual(findInSpec(spec, 'GET', '/api/pets/:id'), { path: '/pets/{petId}', method: true });
  assert.equal(findInSpec(spec, 'GET', '/api/invoices'), null);
  const opts = { spec, contract: 'api/openapi.yaml', scenarios: [loadScenario(join(tmpProject({ 'c.yaml': CATALOGO }), 'c.yaml'))] };
  assert.match(hintFor({ method: 'GET', path: '/api/pets' }, opts), /contract has it \(GET \/pets\) → atrezzo import api\/openapi.yaml/);
  assert.match(hintFor({ method: 'GET', path: '/api/invoices' }, opts), /skill \/atrezzo:gap/);
  assert.match(hintFor({ method: 'POST', path: '/api/pets' }, opts), /mutation.*--on-miss stub/);
  assert.match(hintFor({ method: 'GET', path: '/api/products/2' }, opts), /already declared by scenario catalogo/);
});

// ---------- server ----------

test('gap recorded and deduplicated: 3 identical requests ⇒ times 3, one entry, actionable 404', async () => {
  const { file, mock, url } = await startServer();
  try {
    let last;
    for (let i = 0; i < 3; i++) last = await getJson(`${url}/api/users`, { headers: { referer: 'http://localhost:5173/admin?sid=s3cr3t' } });
    assert.equal(last.status, 404);
    assert.deepEqual(last.body, {
      error: 'GET /api/users is not in the contract of scenario "catalogo"',
      atrezzo: { miss: true, gap: 'GET /api/users', times: 3, next: 'atrezzo misses', endpoints: ['/api/products'] },
    });
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(disk), ['GET /api/users']);
    const m = disk['GET /api/users'];
    assert.equal(m.times, 3);
    assert.equal(m.resolved, false);
    assert.equal(m.referer, 'http://localhost:5173/admin', 'the referer is stored without its query');
    assert.ok(m.first_seen <= m.last_seen);
    for (const k of ['method', 'path', 'query', 'times', 'first_seen', 'last_seen', 'referer', 'accept', 'resolved']) assert.ok(k in m, k);
    assert.equal(readFileSync(join(file, '../.gitignore'), 'utf8'), '*\n');
    const st = await getJson(`${url}/__atrezzo/state`);
    assert.deepEqual(st.body.misses, { total: 1, unresolved: 1 });
    const api = await getJson(`${url}/__atrezzo/misses`);
    assert.equal(api.body.unresolved, 1);
    assert.equal(api.body.misses[0].times, 3);
    // missing static files (favicon) are not API gaps
    assert.equal((await request(`${url}/favicon.ico`)).status, 404);
    // a write to a contract route is a gap too (405)
    const w = await postJson(`${url}/api/products`, '{}');
    assert.equal(w.status, 405);
    assert.equal(w.body.atrezzo.gap, 'POST /api/products');
    assert.equal((await getJson(`${url}/__atrezzo/misses`)).body.misses.length, 2);
    const cleared = await del(`${url}/__atrezzo/misses`);
    assert.equal(cleared.status, 200);
    assert.deepEqual((await getJson(`${url}/__atrezzo/misses`)).body, { misses: [], unresolved: 0 });
  } finally { await mock.close(); }
});

test('the 404 and misses.json do not leak query secrets (?token=abc ⇒ "***")', async () => {
  const { file, mock, url } = await startServer();
  const logs = [];
  try {
    const r = await request(`${url}/api/users?token=abc&page=2`);
    const text = r.text;
    assert.equal(r.status, 404);
    assert.doesNotMatch(text, /abc/);
    const m = (await getJson(`${url}/__atrezzo/misses`)).body.misses[0];
    assert.deepEqual(m.query, { token: '***', page: '2' });
    assert.doesNotMatch(readFileSync(file, 'utf8'), /abc/);
  } finally { await mock.close(); }
  // and neither does the serve log
  const dir = tmpProject({ 'scenarios/catalogo.yaml': CATALOGO });
  const m2 = createMockServer({ scenariosDir: join(dir, 'scenarios'), log: (s) => logs.push(s) });
  const u2 = `http://127.0.0.1:${(await m2.listen(0)).port}`;
  await request(`${u2}/api/users?token=abc`);
  await request(`${u2}/api/products?token=abc`);
  await m2.close();
  assert.ok(logs.length >= 2);
  assert.ok(logs.every((l) => !l.includes('abc')), logs.join('\n'));
});

test('POST /__atrezzo/reload picks up the edited YAML without restarting; resolved turns true once served', async () => {
  const { dir, file, mock, url } = await startServer();
  try {
    assert.equal((await request(`${url}/api/users`)).status, 404);
    writeFileSync(join(dir, 'scenarios/catalogo.yaml'), PATCH_WORLD(CATALOGO));
    assert.equal((await request(`${url}/api/users`)).status, 404, 'without reload the old scenario stays');
    const rl = await postJson(`${url}/__atrezzo/reload`);
    assert.equal(rl.status, 200);
    assert.deepEqual(rl.body.endpoints, ['/api/products', '/api/users']);
    assert.deepEqual(rl.body.counts, { users: 4, products: 5 });
    assert.deepEqual(rl.body.misses, { total: 1, unresolved: 1 }, 'reload marks nothing: serving the route does');
    const ok = await getJson(`${url}/api/users`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.length, 4);
    const m = JSON.parse(readFileSync(file, 'utf8'))['GET /api/users'];
    assert.equal(m.resolved, true);
    assert.equal(m.times, 2);
    assert.deepEqual((await getJson(`${url}/__atrezzo/state`)).body.misses, { total: 1, unresolved: 0 });
    // reload with broken YAML ⇒ 400 and the previous state stays
    writeFileSync(join(dir, 'scenarios/catalogo.yaml'), 'name: catalogo\nseed: x\n');
    const bad = await postJson(`${url}/__atrezzo/reload`);
    assert.equal(bad.status, 400);
    assert.equal((await request(`${url}/api/users`)).status, 200);
    assert.equal((await request(`${url}/__atrezzo/reload`)).status, 405);
  } finally { await mock.close(); }
});

test('--on-miss stub: 200, [] for collections, {} for details, x-atrezzo-stub header, still recording', async () => {
  const { mock, url } = await startServer({ onMiss: 'stub' });
  try {
    const col = await getJson(`${url}/api/users`);
    assert.equal(col.status, 200);
    assert.deepEqual(col.body, []);
    assert.equal(col.headers.get('x-atrezzo-stub'), 'true');
    const det = await getJson(`${url}/api/users/7`);
    assert.deepEqual(det.body, {});
    assert.equal(det.headers.get('x-atrezzo-stub'), 'true');
    const post = await postJson(`${url}/api/products`, '{}');
    assert.equal(post.status, 200);
    assert.deepEqual(post.body, {});
    const real = await request(`${url}/api/products`);
    assert.equal(real.headers.get('x-atrezzo-stub'), null, 'what is in the contract is not a stub');
    const list = (await getJson(`${url}/__atrezzo/misses`)).body;
    assert.deepEqual(list.misses.map((m) => `${m.method} ${m.path}`).sort(), ['GET /api/users', 'GET /api/users/:id', 'POST /api/products']);
    assert.ok(list.misses.every((m) => m.status === 200));
  } finally { await mock.close(); }
  assert.throws(() => createMockServer({ scenariosDir: join(tmpProject({ 'e/c.yaml': CATALOGO }), 'e'), onMiss: 'nope' }), /--on-miss/);
});

// ---------- CLI ----------

test('atrezzo misses --json with one entry; text with a suggestion; --clear empties; doctor warns', () => {
  const dir = tmpProject({ 'atrezzo.config.json': CONFIG({ workspace: { contract: 'api/openapi.yaml' } }), 'scenarios/catalogo.yaml': CATALOGO, 'api/openapi.yaml': readFileSync(join(ROOT, 'tests/fixtures/petstore.yaml'), 'utf8') });
  const store = createMissStore(join(dir, 'atrezzo/.atrezzo/misses.json'));
  store.record({ method: 'GET', pathname: '/api/invoices', query: new URLSearchParams('token=abc'), status: 404 });
  const j = cli(['misses', '--json'], dir);
  assert.equal(j.code, 0, j.stderr);
  const doc = JSON.parse(j.stdout);
  assert.equal(doc.unresolved, 1);
  assert.equal(doc.misses.length, 1);
  assert.equal(doc.misses[0].path, '/api/invoices');
  assert.deepEqual(doc.misses[0].query, { token: '***' });

  store.record({ method: 'GET', pathname: '/api/pets', status: 404 });
  store.record({ method: 'GET', pathname: '/api/pets', status: 404 });
  const t = cli(['misses'], dir);
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /GET \/api\/pets\s+2 times\s+unresolved.*→ the contract has it \(GET \/pets\) → atrezzo import api\/openapi.yaml/);
  assert.match(t.stdout, /GET \/api\/invoices\s+1 time\s+unresolved.*→ not in the contract → add the endpoint to the scenario \(skill \/atrezzo:gap\)/);
  assert.match(t.stdout, /2 gaps · 2 unresolved/);

  const d = doctor(dir);
  const w = d.checks.find((c) => /gap/.test(c.label));
  assert.equal(w.level, 'warn');
  assert.match(w.label, /2 unresolved gaps \(of 2 recorded\)/);
  assert.match(w.detail, /GET \/api\/pets \(2×\)/);

  const c = cli(['misses', '--clear'], dir);
  assert.equal(c.code, 0);
  assert.match(c.stdout, /2 gaps cleared/);
  assert.deepEqual(JSON.parse(cli(['misses', '--json'], dir).stdout), { misses: [], unresolved: 0 });
  assert.match(cli(['misses'], dir).stdout, /No gaps recorded/);
  assert.ok(!doctor(dir).checks.some((x) => /gap/.test(x.label)));
});

// ---------- end-to-end: page → 404 → misses → patch → world + reload → green ----------

const PAGE = readFileSync(new URL('./fixtures/page.html', import.meta.url), 'utf8');

const FLOW = `scenario: scenarios/catalogo.yaml
steps:
  - screen: users
    visit: /
    wait_for: "[data-testid=ready]"
    requests:
      users: GET /api/users
    expect:
      - selector: "[data-testid=user-row]"
        count: 4
        data: { request: users }
`;

const realPw = await loadPlaywright(ROOT);
const realChrome = realPw && (chromeExecutable(realPw.name) ?? (realPw.name !== 'playwright-core' ? 'bundled' : null));
const skipReal = !realPw ? 'playwright(-core) not installed in the repo' : !realChrome || (realChrome !== 'bundled' && !existsSync(realChrome)) ? 'no Chromium (set ATREZZO_CHROME)' : false;

test('end-to-end (real Chromium): 404 recorded → scenario patch → world + reload → the page renders and the gap is resolved', { skip: skipReal, timeout: 90_000 }, async (t) => {
  const dir = tmpProject({ 'atrezzo.config.json': CONFIG(), 'scenarios/catalogo.yaml': CATALOGO, 'index.html': PAGE, 'flow.yaml': FLOW });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  const srv = await startServe(dir);
  t.after(() => srv.stop());
  const say = (s) => t.diagnostic(s);

  // 1) the page requests /api/users, which does not exist ⇒ red, and the gap is recorded
  const v1 = await cliAsync(['verify', 'flow.yaml', '--driver', 'playwright', '--no-reset', '--url', srv.url], dir);
  say(`verify before the patch: exit ${v1.code}`);
  assert.notEqual(v1.code, 0, v1.stdout);
  const m1 = await cliAsync(['misses'], dir);
  say(m1.stdout);
  assert.match(m1.stdout, /GET \/api\/users\s+\d+ times?\s+unresolved/);
  const j1 = JSON.parse((await cliAsync(['misses', '--json'], dir)).stdout);
  assert.equal(j1.misses[0].referer, `${srv.url}/`, 'the page caused the gap (referer)');

  // 2) scenario patch (entity + endpoint; the world generates the data) → world → reload
  writeFileSync(join(dir, 'scenarios/catalogo.yaml'), PATCH_WORLD(CATALOGO));
  const w = await cliAsync(['world', 'scenarios/catalogo.yaml'], dir);
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stdout, /GET \/api\/users/);
  const rl = (await postJson(`${srv.url}/__atrezzo/reload`)).body;
  say(`reload: endpoints ${rl.endpoints.join(', ')} · generated: ${rl.generated}`);
  assert.equal(rl.generated, 'up to date');

  // 3) the screen renders (no reset: what it shows comes from the reload) and the gap shows as resolved
  const v2 = await cliAsync(['verify', 'flow.yaml', '--driver', 'playwright', '--no-reset', '--url', srv.url], dir);
  say(v2.stdout);
  assert.equal(v2.code, 0, v2.stdout + v2.stderr);
  const j2 = JSON.parse((await cliAsync(['misses', '--json'], dir)).stdout);
  assert.equal(j2.unresolved, 0);
  assert.equal(j2.misses[0].resolved, true);
  assert.match(srv.log(), /gap GET \/api\/users resolved/);
});
