import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadScenario, normalizeScenario } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { generateWorld, scenarioHash } from '../scripts/lib/world.mjs';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { recordEndpoint } from '../scripts/lib/record.mjs';
import { AtrezzoError, EXIT } from '../scripts/lib/errors.mjs';
import { SCENARIO, tmpProject, cli, cliAsync } from './helpers.mjs';
import { request, postJson } from './helpers/http.mjs';

const MARKET_FIXTURE = {
  status: 200,
  contentType: 'application/json; charset=utf-8',
  body: {
    id: 'mkt-99',
    status: 'open',
    market: {
      name: 'Madrid',
      open: true,
      session: {
        phase: 'continuous',
        halted: false,
      },
    },
    items: [
      { id: 101, sku: 'A-1', locked: false, price: 42.5 },
      { id: 102, sku: 'B-2', locked: false, price: 19.75 },
    ],
    notes: null,
  },
};

const BASE_SCENARIO = `name: market-state
seed: 123
world:
  customers: 1
endpoints:
  - path: /api/market
    entity: customers
    passthrough:
      fixture: market
      patch:
        status: paused
`;

function startUpstream(handler) {
  const srv = createServer(handler);
  return new Promise((ok) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      ok({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => srv.close(() => done())),
      });
    });
  });
}

test('simple patch: replaces top-level field in fixture and keeps the rest byte-for-byte', async () => {
  const dir = tmpProject({
    'atrezzo/scenarios/market-state.yaml': BASE_SCENARIO,
    'atrezzo/fixtures/market.json': JSON.stringify(MARKET_FIXTURE, null, 2),
  });
  const srv = createMockServer({
    scenariosDir: join(dir, 'atrezzo/scenarios'),
    fixturesDir: join(dir, 'atrezzo/fixtures'),
    scenario: 'market-state',
  });
  const base = `http://127.0.0.1:${(await srv.listen(0)).port}`;
  try {
    const res = await request(`${base}/api/market`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');

    const expectedBody = {
      ...MARKET_FIXTURE.body,
      status: 'paused',
    };
    assert.equal(res.text, JSON.stringify(expectedBody));
    assert.deepEqual(JSON.parse(res.text), expectedBody);
    // Exact key order preserved
    assert.deepEqual(Object.keys(JSON.parse(res.text)), Object.keys(MARKET_FIXTURE.body));
  } finally {
    await srv.close();
  }
});

test('nested patch: updates deep dot-paths and array indices while keeping everything else byte-for-byte', async () => {
  const yaml = `name: locked-item
seed: 123
endpoints:
  - path: /api/market
    passthrough:
      fixture: market
      patch:
        "market.open": false
        "market.session.halted": true
        "items.0.locked": true
`;
  const dir = tmpProject({
    'atrezzo/scenarios/locked-item.yaml': yaml,
    'atrezzo/fixtures/market.json': JSON.stringify(MARKET_FIXTURE, null, 2),
  });
  const srv = createMockServer({
    scenariosDir: join(dir, 'atrezzo/scenarios'),
    fixturesDir: join(dir, 'atrezzo/fixtures'),
    scenario: 'locked-item',
  });
  const base = `http://127.0.0.1:${(await srv.listen(0)).port}`;
  try {
    const stateRes = await request(`${base}/__atrezzo/state`);
    assert.equal(stateRes.status, 200);
    assert.deepEqual(JSON.parse(stateRes.text).passthrough, { '/api/market': 'market' });

    const res = await request(`${base}/api/market`);
    assert.equal(res.status, 200);
    const expected = structuredClone(MARKET_FIXTURE.body);
    expected.market.open = false;
    expected.market.session.halted = true;
    expected.items[0].locked = true;
    assert.equal(res.text, JSON.stringify(expected));

    // Empty array patch ("empty market")
    const emptyYaml = yaml.replace(
      '        "items.0.locked": true\n',
      '        "items": []\n',
    );
    writeFileSync(join(dir, 'atrezzo/scenarios/locked-item.yaml'), emptyYaml);
    const reload = await postJson(`${base}/__atrezzo/reload`);
    assert.equal(reload.status, 200);
    const afterEmpty = await request(`${base}/api/market`);
    expected.items = [];
    assert.equal(afterEmpty.text, JSON.stringify(expected));

    // Undeclared route/detail does not accidentally match
    assert.equal((await request(`${base}/api/market/1`)).status, 404);
  } finally {
    await srv.close();
  }
});

test('missing fixture: fails loudly with clear error in loadScenario, serve, world and CLI', () => {
  const dir = tmpProject({
    'atrezzo/scenarios/missing.yaml': `name: missing-fix
seed: 1
endpoints:
  - path: /api/market
    passthrough:
      fixture: does-not-exist
      patch:
        "market.open": false
`,
  });

  assert.throws(
    () => loadScenario(join(dir, 'atrezzo/scenarios/missing.yaml'), { fixturesDir: join(dir, 'atrezzo/fixtures') }),
    (err) => err instanceof AtrezzoError
      && err.exitCode === EXIT.INVALID
      && /\/api\/market/.test(err.message)
      && /does-not-exist/.test(err.message)
      && /does not exist/.test(err.message),
  );

  assert.throws(
    () => createMockServer({
      scenariosDir: join(dir, 'atrezzo/scenarios'),
      fixturesDir: join(dir, 'atrezzo/fixtures'),
      scenario: 'missing-fix',
    }),
    /does-not-exist.*does not exist/,
  );

  const w = cli(['world', 'atrezzo/scenarios/missing.yaml'], dir);
  assert.equal(w.code, 3);
  assert.match(w.stderr, /does-not-exist/);
  assert.match(w.stderr, /does not exist/);
});

test('patch on non-existent path: fails loudly with clear error for top-level, nested, scalar traversal and out-of-bounds index', () => {
  const makeDir = (patchYaml) => tmpProject({
    'atrezzo/scenarios/bad-patch.yaml': `name: bad-patch
seed: 1
endpoints:
  - path: /api/market
    passthrough:
      fixture: market
      patch:
${patchYaml}
`,
    'atrezzo/fixtures/market.json': JSON.stringify(MARKET_FIXTURE, null, 2),
  });

  for (const [label, patchLine, expectedRe] of [
    ['missing top-level key', '        nonexistent: 1', /nonexistent.*does not exist/],
    ['missing intermediate key', '        "unknown.nested": 1', /unknown.*does not exist/],
    ['missing leaf key', '        "market.closed_reason": "holiday"', /market\.closed_reason.*does not exist/],
    ['traverse into null', '        "notes.text": "x"', /cannot (traverse|patch) "text" on null/],
    ['traverse into boolean', '        "market.open.flag": true', /cannot (traverse|patch) "flag" on boolean/],
    ['array index out of bounds', '        "items.9.locked": true', /index 9 does not exist/],
    ['non-numeric array key', '        "items.first.locked": true', /path "first" does not exist in array/],
  ]) {
    const dir = makeDir(patchLine);
    assert.throws(
      () => loadScenario(join(dir, 'atrezzo/scenarios/bad-patch.yaml'), { fixturesDir: join(dir, 'atrezzo/fixtures') }),
      (err) => err instanceof AtrezzoError && err.exitCode === EXIT.INVALID && expectedRe.test(err.message),
      label,
    );
    const r = cli(['world', 'atrezzo/scenarios/bad-patch.yaml'], dir);
    assert.equal(r.code, 3, label);
    assert.match(r.stderr, expectedRe, label);
  }
});

test('passthrough validation: rejects invalid schema combinations and preserves hash for scenarios without passthrough', () => {
  const baseHash = scenarioHash(normalizeScenario(parseYaml(SCENARIO, 's.yaml'), 's.yaml'));
  const unchangedHash = scenarioHash(normalizeScenario(parseYaml(SCENARIO, 's.yaml'), 's.yaml'));
  assert.equal(baseHash, unchangedHash);

  const badYaml = (block) => `name: bad
seed: 1
world:
  items: 2
endpoints:
${block}
`;
  assert.throws(() => normalizeScenario(parseYaml(badYaml('  - path: /api/x\n    passthrough: {}'), 'b.yaml'), 'b.yaml'), /passthrough\.fixture/);
  assert.throws(() => normalizeScenario(parseYaml(badYaml('  - path: /api/x\n    passthrough: { fixture: "../secret" }'), 'b.yaml'), 'b.yaml'), /invalid fixture name/);
  assert.throws(() => normalizeScenario(parseYaml(badYaml('  - path: /api/x\n    passthrough: { fixture: ok, patch: { "a..b": 1 } }'), 'b.yaml'), 'b.yaml'), /invalid patch path/);
  assert.throws(() => normalizeScenario(parseYaml(badYaml('  - path: /api/x\n    passthrough: { fixture: ok, patch: { "__proto__.polluted": 1 } }'), 'b.yaml'), 'b.yaml'), /invalid patch path/);
  assert.throws(() => normalizeScenario(parseYaml(badYaml('  - path: /api/x\n    entity: items\n    error: { status: 500 }\n    passthrough: { fixture: ok }'), 'b.yaml'), 'b.yaml'), /cannot combine "passthrough" with "error"/);
  assert.throws(() => normalizeScenario(parseYaml(badYaml('  - path: /api/x\n    detail: true\n    passthrough: { fixture: ok }'), 'b.yaml'), 'b.yaml'), /cannot combine "detail: true" with "passthrough"/);
  assert.throws(() => normalizeScenario(parseYaml(badYaml('  - path: /api/x\n    filters: [id]\n    passthrough: { fixture: ok }'), 'b.yaml'), 'b.yaml'), /incompatible with "passthrough" without "entity"/);
});

test('atrezzo record: captures real status, content-type and body without saving request/response credentials', async () => {
  let receivedAuth = null;
  let receivedCookie = null;
  const upstream = await startUpstream((req, res) => {
    receivedAuth = req.headers.authorization;
    receivedCookie = req.headers.cookie;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': 'session=super-secret-cookie; HttpOnly',
      'x-api-key': 'upstream-secret',
      'x-request-id': 'req-42',
    });
    res.end(JSON.stringify(MARKET_FIXTURE.body));
  });

  const dir = tmpProject({
    'atrezzo/scenarios/market.yaml': `name: market
seed: 7
endpoints:
  - path: /api/market
    passthrough:
      fixture: market-cap
      patch:
        "market.open": false
`,
  });

  try {
    const rec = await cliAsync(
      [
        'record',
        `${upstream.url}/v1/market?api_key=leak-in-query`,
        '--scenario', 'atrezzo/scenarios/market.yaml',
        '--endpoint', '/api/market',
        '--header', 'Authorization: Bearer top-secret-token',
        '--header', '@-',
      ],
      dir,
      {},
      'Cookie: session=stdin-secret\n',
    );
    assert.equal(rec.code, 0, rec.stderr);
    assert.equal(receivedAuth, 'Bearer top-secret-token');
    assert.equal(receivedCookie, 'session=stdin-secret');
    // Secrets never leak to stdout or stderr
    assert.doesNotMatch(rec.stdout + rec.stderr, /top-secret-token|stdin-secret|leak-in-query|super-secret-cookie|upstream-secret/);
    assert.match(rec.stdout, /Authorization: \*\*\*/);
    assert.match(rec.stdout, /Cookie: \*\*\*/);

    const fixturePath = join(dir, 'atrezzo/fixtures/market-cap.json');
    assert.ok(existsSync(fixturePath));
    const saved = JSON.parse(readFileSync(fixturePath, 'utf8'));
    assert.deepEqual(Object.keys(saved), ['status', 'contentType', 'body']);
    assert.equal(saved.status, 200);
    assert.equal(saved.contentType, 'application/json; charset=utf-8');
    assert.deepEqual(saved.body, MARKET_FIXTURE.body);

    const rawSaved = readFileSync(fixturePath, 'utf8');
    assert.doesNotMatch(rawSaved, /set-cookie|x-api-key|x-request-id|authorization|top-secret-token|stdin-secret|super-secret-cookie|upstream-secret|leak-in-query/i);

    // Now serve using the recorded fixture + existing patch in the scenario
    const srv = createMockServer({
      scenariosDir: join(dir, 'atrezzo/scenarios'),
      fixturesDir: join(dir, 'atrezzo/fixtures'),
      scenario: 'market',
    });
    const base = `http://127.0.0.1:${(await srv.listen(0)).port}`;
    try {
      const res = await request(`${base}/api/market`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.text);
      assert.equal(body.market.open, false);
      assert.deepEqual(body.items, MARKET_FIXTURE.body.items);
    } finally {
      await srv.close();
    }
  } finally {
    await upstream.close();
  }
});

test('atrezzo record: --write updates scenario and default fixture name uses endpoint slug', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(206, { 'content-type': 'text/plain; charset=utf-8', 'x-secret': 'nope' });
    res.end('plain-text-payload');
  });

  const dir = tmpProject({
    'atrezzo/scenarios/demo.yaml': `name: demo
seed: 1
world:
  orders: 2
endpoints:
  - path: /api/orders
    entity: orders
`,
  });

  try {
    // Unknown endpoint without --write fails clearly
    const bad = await cliAsync(
      ['record', `${upstream.url}/status`, '--scenario', 'atrezzo/scenarios/demo.yaml', '--endpoint', '/api/health'],
      dir,
    );
    assert.equal(bad.code, 3);
    assert.match(bad.stderr, /\/api\/health.*not declared/);

    // With --write, adds endpoint and writes default fixture name `api-health.json`
    const ok = await cliAsync(
      ['record', `${upstream.url}/status`, '--scenario', 'atrezzo/scenarios/demo.yaml', '--endpoint', '/api/health', '--write'],
      dir,
    );
    assert.equal(ok.code, 0, ok.stderr);
    const saved = JSON.parse(readFileSync(join(dir, 'atrezzo/fixtures/api-health.json'), 'utf8'));
    assert.deepEqual(saved, { status: 206, contentType: 'text/plain; charset=utf-8', body: 'plain-text-payload' });

    const updated = loadScenario(join(dir, 'atrezzo/scenarios/demo.yaml'), { fixturesDir: join(dir, 'atrezzo/fixtures') });
    const ep = updated.endpoints.find((e) => e.path === '/api/health');
    assert.deepEqual(ep.passthrough, { fixture: 'api-health' });
  } finally {
    await upstream.close();
  }
});

test('world + MSW handlers + parameterized passthrough route serve identical patched response', async () => {
  const dir = tmpProject({
    'atrezzo/scenarios/item.yaml': `name: item-locked
seed: 5
endpoints:
  - path: /api/items/:id
    passthrough:
      fixture: item-42
      patch:
        "locked": true
        "meta.reason": "compliance_hold"
`,
    'atrezzo/fixtures/item-42.json': JSON.stringify({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: { id: 42, name: 'Widget', locked: false, meta: { reason: null, owner: 'alice' } },
    }, null, 2),
  });

  const w = cli(['world', 'atrezzo/scenarios/item.yaml'], dir);
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stdout, /GET \/api\/items\/:id\s+passthrough: item-42/);

  mkdirSync(join(dir, 'node_modules/msw'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/msw/package.json'), JSON.stringify({ name: 'msw', type: 'module', exports: './index.js' }));
  writeFileSync(join(dir, 'node_modules/msw/index.js'), `
export const http = { get: (path, resolver) => ({ method: 'GET', path, resolver }) };
export const HttpResponse = Object.assign(
  function HttpResponse(body, init) { return { body, ...init }; },
  { json: (body, init) => ({ body, ...init }) },
);
`);
  const mod = await import(pathToFileURL(join(dir, 'atrezzo/.generated/item-locked.handlers.mjs')).href);
  const mswRes = mod.handlers[0].resolver({ request: new Request('http://localhost/api/items/42') });
  assert.equal(mswRes.status, 200);
  assert.deepEqual(mswRes.body, { id: 42, name: 'Widget', locked: true, meta: { reason: 'compliance_hold', owner: 'alice' } });

  const doc = cli(['doctor'], dir);
  assert.equal(doc.code, 0, doc.stdout);
});
