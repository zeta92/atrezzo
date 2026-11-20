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
import { getAdapter } from '../scripts/lib/runtimes/index.mjs';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
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
    assert.deepEqual(Object.keys(saved), ['status', 'contentType', 'hasBody', 'body']);
    assert.equal(saved.status, 200);
    assert.equal(saved.contentType, 'application/json; charset=utf-8');
    assert.equal(saved.hasBody, true);
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
    assert.deepEqual(saved, { status: 206, contentType: 'text/plain; charset=utf-8', hasBody: true, body: 'plain-text-payload' });

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

test('atrezzo record and playback distinguish JSON null from empty/bodiless responses across serve, MSW, WireMock and Prism', async () => {
  const upstream = await startUpstream((req, res) => {
    if (req.url === '/nullable') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('null');
      return;
    }
    if (req.url === '/empty-200') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end();
      return;
    }
    if (req.url === '/no-content') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/json-string') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify('hello'));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const dir = tmpProject({
    'atrezzo/scenarios/edge.yaml': `name: edge
seed: 1
endpoints:
  - path: /api/nullable
    passthrough:
      fixture: nullable
  - path: /api/empty-200
    passthrough:
      fixture: empty-200
  - path: /api/no-content
    passthrough:
      fixture: no-content
  - path: /api/json-string
    passthrough:
      fixture: json-string
`,
  });

  try {
    for (const [ep, upPath] of [
      ['/api/nullable', '/nullable'],
      ['/api/empty-200', '/empty-200'],
      ['/api/no-content', '/no-content'],
      ['/api/json-string', '/json-string'],
    ]) {
      const rec = await cliAsync(
        ['record', `${upstream.url}${upPath}`, '--scenario', 'atrezzo/scenarios/edge.yaml', '--endpoint', ep],
        dir,
      );
      assert.equal(rec.code, 0, rec.stderr);
    }

    const nullableFix = JSON.parse(readFileSync(join(dir, 'atrezzo/fixtures/nullable.json'), 'utf8'));
    const empty200Fix = JSON.parse(readFileSync(join(dir, 'atrezzo/fixtures/empty-200.json'), 'utf8'));
    const noContentFix = JSON.parse(readFileSync(join(dir, 'atrezzo/fixtures/no-content.json'), 'utf8'));
    const jsonStringFix = JSON.parse(readFileSync(join(dir, 'atrezzo/fixtures/json-string.json'), 'utf8'));

    assert.deepEqual(nullableFix, { status: 200, contentType: 'application/json; charset=utf-8', hasBody: true, body: null });
    assert.deepEqual(empty200Fix, { status: 200, contentType: 'application/json; charset=utf-8', hasBody: false, body: null });
    assert.deepEqual(noContentFix, { status: 204, contentType: 'application/json; charset=utf-8', hasBody: false, body: null });
    assert.deepEqual(jsonStringFix, { status: 200, contentType: 'application/json; charset=utf-8', hasBody: true, body: 'hello' });

    // Serve over HTTP preserves exact bodies
    const srv = createMockServer({
      scenariosDir: join(dir, 'atrezzo/scenarios'),
      fixturesDir: join(dir, 'atrezzo/fixtures'),
      scenario: 'edge',
    });
    const base = `http://127.0.0.1:${(await srv.listen(0)).port}`;
    try {
      const rNull = await request(`${base}/api/nullable`);
      assert.equal(rNull.status, 200);
      assert.equal(rNull.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(rNull.text, 'null');
      assert.equal(JSON.parse(rNull.text), null);

      const rEmpty = await request(`${base}/api/empty-200`);
      assert.equal(rEmpty.status, 200);
      assert.equal(rEmpty.text, '');

      const r204 = await request(`${base}/api/no-content`);
      assert.equal(r204.status, 204);
      assert.equal(r204.text, '');

      const rJsonStr = await request(`${base}/api/json-string`);
      assert.equal(rJsonStr.status, 200);
      assert.equal(rJsonStr.text, '"hello"');
      assert.equal(JSON.parse(rJsonStr.text), 'hello');
    } finally {
      await srv.close();
    }

    // MSW handlers distinguish bodiless new HttpResponse(null) vs HttpResponse.json(null)
    const w = cli(['world', 'atrezzo/scenarios/edge.yaml'], dir);
    assert.equal(w.code, 0, w.stderr);
    mkdirSync(join(dir, 'node_modules/msw'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/msw/package.json'), JSON.stringify({ name: 'msw', type: 'module', exports: './index.js' }));
    writeFileSync(join(dir, 'node_modules/msw/index.js'), `
export const http = { get: (path, resolver) => ({ method: 'GET', path, resolver }) };
export class HttpResponse {
  constructor(body, init) { this.kind = 'raw'; this.body = body; Object.assign(this, init); }
  static json(body, init) { return { kind: 'json', body, ...init }; }
}
`);
    const mod = await import(pathToFileURL(join(dir, 'atrezzo/.generated/edge.handlers.mjs')).href);
    const callMsw = (p) => mod.handlers.find((h) => h.path === `*${p}`).resolver({ request: new Request(`http://localhost${p}`) });

    const mswNull = callMsw('/api/nullable');
    assert.equal(mswNull.kind, 'json');
    assert.equal(mswNull.body, null);

    const mswEmpty = callMsw('/api/empty-200');
    assert.equal(mswEmpty.kind, 'raw');
    assert.equal(mswEmpty.body, null);

    const msw204 = callMsw('/api/no-content');
    assert.equal(msw204.kind, 'raw');
    assert.equal(msw204.body, null);

    const mswStr = callMsw('/api/json-string');
    assert.equal(mswStr.kind, 'json');
    assert.equal(mswStr.body, 'hello');

    // WireMock & Prism preserve JSON null vs bodiless
    const sc = loadScenario(join(dir, 'atrezzo/scenarios/edge.yaml'), { fixturesDir: join(dir, 'atrezzo/fixtures') });
    const ds = generateWorld(sc);
    const cfg = { ...DEFAULT_CONFIG, _dir: dir };

    const wm = getAdapter('wiremock').emit({ dataset: ds, config: cfg, requests: [] });
    const wmFiles = Object.fromEntries(wm.files.map((f) => [f.path, f.content]));
    const nullMapping = JSON.parse(wmFiles['atrezzo/.generated/wiremock/edge/mappings/api-nullable.json']).mappings[0];
    assert.equal(nullMapping.response.bodyFileName, 'edge/api-nullable/passthrough.json');
    assert.equal(wmFiles['atrezzo/.generated/wiremock/edge/__files/edge/api-nullable/passthrough.json'], 'null\n');

    const emptyMapping = JSON.parse(wmFiles['atrezzo/.generated/wiremock/edge/mappings/api-empty-200.json']).mappings[0];
    assert.equal(emptyMapping.response.bodyFileName, undefined);
    assert.equal(wmFiles['atrezzo/.generated/wiremock/edge/__files/edge/api-empty-200/passthrough.json'], undefined);

    const prismOut = getAdapter('prism').emit({ dataset: ds, config: cfg });
    const oas = parseYaml(prismOut.files[0].content);
    assert.equal(oas.paths['/api/nullable'].get.responses['200'].content['application/json'].examples.scenario.value, null);
    assert.equal(oas.paths['/api/empty-200'].get.responses['200'].content, undefined);
  } finally {
    await upstream.close();
  }
});

test('fixture validation: rejects invalid hasBody values or hasBody: false with non-null body', () => {
  for (const [label, fixtureObj, expectedRe] of [
    ['non-boolean hasBody', { status: 200, contentType: 'application/json', hasBody: 'yes', body: null }, /"hasBody" must be a boolean/],
    ['hasBody false with non-null body', { status: 200, contentType: 'application/json', hasBody: false, body: { a: 1 } }, /"hasBody: false" cannot be combined/],
    ['hasBody true without body', { status: 200, contentType: 'application/json', hasBody: true }, /missing "body" field/],
  ]) {
    const dir = tmpProject({
      'atrezzo/scenarios/bad-fix.yaml': `name: bad-fix
seed: 1
endpoints:
  - path: /api/x
    passthrough:
      fixture: x
`,
      'atrezzo/fixtures/x.json': JSON.stringify(fixtureObj),
    });
    assert.throws(
      () => loadScenario(join(dir, 'atrezzo/scenarios/bad-fix.yaml'), { fixturesDir: join(dir, 'atrezzo/fixtures') }),
      (err) => err instanceof AtrezzoError && err.exitCode === EXIT.INVALID && expectedRe.test(err.message),
      label,
    );
  }
});
