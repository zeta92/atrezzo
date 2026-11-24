import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadScenario, normalizeScenario } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { generateWorld, scenarioHash } from '../scripts/lib/world.mjs';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { recordEndpoint } from '../scripts/lib/record.mjs';
import { getAdapter } from '../scripts/lib/runtimes/index.mjs';
import { DEFAULT_CONFIG, loadConfig } from '../scripts/lib/config.mjs';
import { AtrezzoError, EXIT } from '../scripts/lib/errors.mjs';
import { resolveEffectiveDirs, resolveFixturesDir } from '../scripts/lib/passthrough.mjs';
import { SCENARIO, tmpProject, cli, cliAsync } from './helpers.mjs';
import { getJson, request, postJson } from './helpers/http.mjs';
import { startServe } from './helpers/serve.mjs';

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
export const http = {
  get: (path, resolver) => ({ method: 'GET', path, resolver }),
  head: (path, resolver) => ({ method: 'HEAD', path, resolver }),
  all: (path, resolver) => ({ method: 'ALL', path, resolver }),
};
export const delay = async () => {};
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
export const http = {
  get: (path, resolver) => ({ method: 'GET', path, resolver }),
  head: (path, resolver) => ({ method: 'HEAD', path, resolver }),
  all: (path, resolver) => ({ method: 'ALL', path, resolver }),
};
export const delay = async () => {};
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

test('serve --scenarios discovers sibling external fixtures when --dir points to a project with its own fixturesDir', async () => {
  const externalBody = { id: 'ord-44', source: 'external-bundle', status: 'confirmed' };
  const root = tmpProject({
    'project/atrezzo.config.json': JSON.stringify({
      ...DEFAULT_CONFIG,
      runtime: 'builtin',
    }, null, 2),
    'bundle/scenarios/order.yaml': `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`,
    'bundle/fixtures/order.json': JSON.stringify({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: externalBody,
    }, null, 2),
  });

  const srv = await startServe(root, ['--dir', 'project', '--scenarios', 'bundle/scenarios']);
  try {
    const res = await getJson(`${srv.url}/api/order`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(res.body, externalBody);
  } finally {
    srv.stop();
  }
});

test('serve --fixtures is a CWD-relative override that beats project config, bundle config and sibling fixtures, and persists across reload/reset', async () => {
  const projectBody = { id: 'ord-project', source: 'project' };
  const bundleConfigBody = { id: 'ord-bundle-cfg', source: 'bundle-config' };
  const siblingBody = { id: 'ord-sibling', source: 'bundle-sibling' };
  const overrideBody = { id: 'ord-override', source: 'explicit-override', version: 1 };
  const secondOverrideBody = { id: 'inv-override', source: 'explicit-override' };

  const root = tmpProject({
    'project/atrezzo.config.json': JSON.stringify({
      ...DEFAULT_CONFIG,
      runtime: 'builtin',
      fixturesDir: 'project-fixtures',
    }, null, 2),
    'project/atrezzo/scenarios/order.yaml': `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`,
    'project/project-fixtures/order.json': JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: projectBody }),
    'bundle/atrezzo.config.json': JSON.stringify({
      ...DEFAULT_CONFIG,
      runtime: 'builtin',
      scenariosDir: 'scenarios',
      fixturesDir: 'bundle-cfg-fixtures',
    }, null, 2),
    'bundle/scenarios/order.yaml': `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`,
    'bundle/scenarios/invoice.yaml': `name: invoice
seed: 1
endpoints:
  - path: /api/invoice
    passthrough:
      fixture: invoice
`,
    'bundle/bundle-cfg-fixtures/order.json': JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: bundleConfigBody }),
    'bundle/fixtures/order.json': JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: siblingBody }),
    'override-fixtures/order.json': JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: overrideBody }),
    'override-fixtures/invoice.json': JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: secondOverrideBody }),
  });

  // 1) --fixtures beats bundle config, bundle sibling, and project config (with --scenarios)
  const srv = await startServe(root, ['--dir', 'project', '--scenarios', 'bundle/scenarios', '--fixtures', 'override-fixtures', '--scenario', 'order']);
  try {
    const res = await getJson(`${srv.url}/api/order`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, overrideBody);

    // Reload picks up updated fixture from the same resolved override dir
    const updatedBody = { ...overrideBody, version: 2 };
    writeFileSync(
      join(root, 'override-fixtures/order.json'),
      JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: updatedBody }),
    );
    const reloaded = await postJson(`${srv.url}/__atrezzo/reload`);
    assert.equal(reloaded.status, 200);
    assert.deepEqual((await getJson(`${srv.url}/api/order`)).body, updatedBody);

    // Reset to another scenario in the same bundle still uses the same resolved override dir
    const reset = await postJson(`${srv.url}/__atrezzo/reset`, JSON.stringify({ scenario: 'invoice' }));
    assert.equal(reset.status, 200);
    assert.deepEqual((await getJson(`${srv.url}/api/invoice`)).body, secondOverrideBody);
  } finally {
    srv.stop();
  }

  // 2) --fixtures beats project config even without --scenarios
  const srvProject = await startServe(root, ['--dir', 'project', '--fixtures', 'override-fixtures']);
  try {
    const res = await getJson(`${srvProject.url}/api/order`);
    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'explicit-override');
  } finally {
    srvProject.stop();
  }

  // 3) Missing explicit --fixtures fails loudly (exit 3)
  const missing = cli(['serve', '--dir', 'project', '--fixtures', 'does-not-exist'], root);
  assert.equal(missing.code, EXIT.INVALID);
  assert.match(missing.stderr, /Fixtures directory.*does-not-exist.*does not exist/);
});

test('serve fixture resolution: project config vs sibling fixture distinction, bundle layouts, and bounded discovery', async () => {
  const projectCustomBody = { source: 'project-config-fixtures' };
  const projectSiblingBody = { source: 'project-sibling-decoy' };
  const bundleAtrezzoBody = { source: 'bundle-atrezzo-fixtures' };
  const bundleConfigBody = { source: 'bundle-config-fixtures' };

  const root = tmpProject({
    // Project with custom fixturesDir AND a decoy sibling atrezzo/fixtures/
    'project/atrezzo.config.json': JSON.stringify({
      ...DEFAULT_CONFIG,
      runtime: 'builtin',
      fixturesDir: 'custom-fixtures',
    }, null, 2),
    'project/atrezzo/scenarios/order.yaml': `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`,
    'project/custom-fixtures/order.json': JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: projectCustomBody }),
    'project/atrezzo/fixtures/order.json': JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: projectSiblingBody }),

    // External bundle nested INSIDE project/ with its own atrezzo/fixtures (must NOT walk up to project/atrezzo.config.json)
    'project/nested-atrezzo-bundle/scenarios/order.yaml': `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`,
    'project/nested-atrezzo-bundle/atrezzo/fixtures/order.json': JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: bundleAtrezzoBody }),

    // External bundle nested INSIDE project/ with bundle-local config fixturesDir
    'project/configured-bundle/atrezzo.config.json': JSON.stringify({
      ...DEFAULT_CONFIG,
      runtime: 'builtin',
      scenariosDir: 'scenarios',
      fixturesDir: 'bundle-custom',
    }, null, 2),
    'project/configured-bundle/scenarios/order.yaml': `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`,
    'project/configured-bundle/bundle-custom/order.json': JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: bundleConfigBody }),
    'project/configured-bundle/fixtures/order.json': JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: { source: 'bundle-sibling-decoy' } }),

    // External bundle nested INSIDE project/ with NO fixtures at all (must fail against bundle path, NOT walk up to project/custom-fixtures)
    'project/missing-bundle/scenarios/order.yaml': `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`,
  });

  // 1) Without --scenarios: preserves project config fixturesDir (NOT sibling project/atrezzo/fixtures)
  const srvDefault = await startServe(root, ['--dir', 'project']);
  try {
    assert.deepEqual((await getJson(`${srvDefault.url}/api/order`)).body, projectCustomBody);
  } finally {
    srvDefault.stop();
  }

  // 1b) Passing --scenarios equal to project's own configured scenariosDir also preserves project config fixturesDir
  const srvSameScenarios = await startServe(root, ['--dir', 'project', '--scenarios', 'project/atrezzo/scenarios']);
  try {
    assert.deepEqual((await getJson(`${srvSameScenarios.url}/api/order`)).body, projectCustomBody);
  } finally {
    srvSameScenarios.stop();
  }

  // 2) External bundle with bundle/atrezzo/fixtures nested inside project: discovers bundle/atrezzo/fixtures and keeps it on reload/reset
  const srvBundleAtrezzo = await startServe(root, ['--dir', 'project', '--scenarios', 'project/nested-atrezzo-bundle/scenarios']);
  try {
    assert.deepEqual((await getJson(`${srvBundleAtrezzo.url}/api/order`)).body, bundleAtrezzoBody);
    const updatedBundleBody = { source: 'bundle-atrezzo-fixtures-reloaded' };
    writeFileSync(
      join(root, 'project/nested-atrezzo-bundle/atrezzo/fixtures/order.json'),
      JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: updatedBundleBody }),
    );
    assert.equal((await postJson(`${srvBundleAtrezzo.url}/__atrezzo/reload`)).status, 200);
    assert.deepEqual((await getJson(`${srvBundleAtrezzo.url}/api/order`)).body, updatedBundleBody);
    assert.equal((await postJson(`${srvBundleAtrezzo.url}/__atrezzo/reset`, JSON.stringify({ scenario: 'order' }))).status, 200);
    assert.deepEqual((await getJson(`${srvBundleAtrezzo.url}/api/order`)).body, updatedBundleBody);
  } finally {
    srvBundleAtrezzo.stop();
  }

  // 3) External bundle with bundle-local atrezzo.config.json: honours bundle config fixturesDir
  const srvBundleCfg = await startServe(root, ['--dir', 'project', '--scenarios', 'project/configured-bundle/scenarios']);
  try {
    assert.deepEqual((await getJson(`${srvBundleCfg.url}/api/order`)).body, bundleConfigBody);
  } finally {
    srvBundleCfg.stop();
  }

  // 4) Bounded discovery: missing bundle fixture fails with bundle path, never walks up to project/atrezzo.config.json
  const missingRes = cli(['serve', '--dir', 'project', '--scenarios', 'project/missing-bundle/scenarios'], root);
  assert.equal(missingRes.code, EXIT.INVALID);
  assert.match(missingRes.stderr, /missing-bundle\/atrezzo\/fixtures\/order\.json/);
  assert.doesNotMatch(missingRes.stderr, /custom-fixtures/);
});

test('external bundle config fixturesDir escaping the bundle root via .. is rejected, never honoured', () => {
  const root = tmpProject({
    'project/atrezzo.config.json': JSON.stringify({ ...DEFAULT_CONFIG, runtime: 'builtin' }, null, 2),
    'workspace/bundle/atrezzo.config.json': JSON.stringify({
      ...DEFAULT_CONFIG,
      runtime: 'builtin',
      scenariosDir: 'scenarios',
      fixturesDir: '../../outside',
    }, null, 2),
    'workspace/bundle/scenarios/order.yaml': `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`,
    // Target of the escape exists, so an unguarded resolver would happily serve it.
    'outside/order.json': JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: { source: 'outside-bundle' } }),
  });

  assert.throws(
    () => resolveEffectiveDirs({
      dir: join(root, 'project'),
      scenarios: join(root, 'workspace/bundle/scenarios'),
    }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /fixturesDir/);
      assert.match(err.message, /\.\.\/\.\.\/outside/);
      assert.match(err.message, /escap\w*.*bundle/i);
      return true;
    },
  );
});

test('external bundle atrezzo/fixtures symlinked outside the bundle root is rejected, never followed', () => {
  const root = tmpProject({
    'project/atrezzo.config.json': JSON.stringify({ ...DEFAULT_CONFIG, runtime: 'builtin' }, null, 2),
    'workspace/bundle/scenarios/order.yaml': `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`,
    // Target of the symlink exists, so an unguarded resolver would happily serve it.
    'outside/fixtures/order.json': JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: { source: 'outside-bundle' } }),
  });
  mkdirSync(join(root, 'workspace/bundle/atrezzo'), { recursive: true });
  // 'junction' keeps this working on Windows without symlink privileges; ignored on POSIX.
  symlinkSync(join(root, 'outside/fixtures'), join(root, 'workspace/bundle/atrezzo/fixtures'), 'junction');

  assert.throws(
    () => resolveEffectiveDirs({
      dir: join(root, 'project'),
      scenarios: join(root, 'workspace/bundle/scenarios'),
    }),
    (err) => {
      assert.ok(err instanceof AtrezzoError, `expected AtrezzoError, got ${err?.constructor?.name}: ${err?.message}`);
      assert.match(err.message, /atrezzo[\\/]fixtures/);
      assert.match(err.message, /escap\w*.*bundle/i);
      return true;
    },
  );
});

test('#44 external bundle (atrezzo/scenarios and flat scenarios layouts): atrezzo/fixtures (DEFAULT_FIXTURES_DIR) keeps precedence over sibling fixtures and is the default when neither exists', () => {
  const scenarioYaml = `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`;
  const fixtureJson = JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: { source: 'x' } });
  const root = tmpProject({
    'project/atrezzo.config.json': JSON.stringify({ ...DEFAULT_CONFIG, runtime: 'builtin' }, null, 2),
    // (a) both bundle/atrezzo/fixtures and sibling bundle/fixtures exist
    'both/atrezzo/scenarios/order.yaml': scenarioYaml,
    'both/atrezzo/fixtures/order.json': fixtureJson,
    'both/fixtures/order.json': fixtureJson,
    // (b) neither exists
    'neither/atrezzo/scenarios/order.yaml': scenarioYaml,
    // Flat layout <bundle>/scenarios:
    // (c) both bundle/atrezzo/fixtures and sibling bundle/fixtures exist
    'flat-both/scenarios/order.yaml': scenarioYaml,
    'flat-both/atrezzo/fixtures/order.json': fixtureJson,
    'flat-both/fixtures/order.json': fixtureJson,
    // (d) neither exists
    'flat-neither/scenarios/order.yaml': scenarioYaml,
  });

  const both = resolveEffectiveDirs({
    dir: join(root, 'project'),
    scenarios: join(root, 'both/atrezzo/scenarios'),
  });
  assert.equal(both.fixturesDir, join(root, 'both/atrezzo/fixtures'));

  const neither = resolveEffectiveDirs({
    dir: join(root, 'project'),
    scenarios: join(root, 'neither/atrezzo/scenarios'),
  });
  assert.equal(neither.fixturesDir, join(root, 'neither/atrezzo/fixtures'));

  const flatBoth = resolveEffectiveDirs({
    dir: join(root, 'project'),
    scenarios: join(root, 'flat-both/scenarios'),
  });
  assert.equal(flatBoth.fixturesDir, join(root, 'flat-both/atrezzo/fixtures'));

  const flatNeither = resolveEffectiveDirs({
    dir: join(root, 'project'),
    scenarios: join(root, 'flat-neither/scenarios'),
  });
  assert.equal(flatNeither.fixturesDir, join(root, 'flat-neither/atrezzo/fixtures'));
});

test('#44 external bundle with scenariosDir not literally named "scenarios" (<bundle>/mock-scenarios): atrezzo/fixtures (DEFAULT_FIXTURES_DIR) keeps precedence over sibling fixtures and is the default when neither exists', () => {
  const scenarioYaml = `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`;
  const fixtureJson = JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: { source: 'x' } });
  const root = tmpProject({
    'project/atrezzo.config.json': JSON.stringify({ ...DEFAULT_CONFIG, runtime: 'builtin' }, null, 2),
    // (a) both bundle/atrezzo/fixtures and sibling bundle/fixtures exist
    'other-both/mock-scenarios/order.yaml': scenarioYaml,
    'other-both/atrezzo/fixtures/order.json': fixtureJson,
    'other-both/fixtures/order.json': fixtureJson,
    // (b) neither exists
    'other-neither/mock-scenarios/order.yaml': scenarioYaml,
  });

  const otherBoth = resolveEffectiveDirs({
    dir: join(root, 'project'),
    scenarios: join(root, 'other-both/mock-scenarios'),
  });
  assert.equal(otherBoth.fixturesDir, join(root, 'other-both/atrezzo/fixtures'));

  const otherNeither = resolveEffectiveDirs({
    dir: join(root, 'project'),
    scenarios: join(root, 'other-neither/mock-scenarios'),
  });
  assert.equal(otherNeither.fixturesDir, join(root, 'other-neither/atrezzo/fixtures'));
});

test('resolveFixturesDir keeps the bounded ancestor project config lookup for scenarios outside scenariosDir', () => {
  const dir = tmpProject({
    'atrezzo.config.json': JSON.stringify({
      ...DEFAULT_CONFIG,
      runtime: 'builtin',
      fixturesDir: 'custom-fixtures',
    }, null, 2),
    'specs/order.yaml': `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`,
  });

  assert.equal(
    resolveFixturesDir(join(dir, 'specs/order.yaml')),
    join(dir, 'custom-fixtures'),
  );
});

test('#44 resolveFixturesDir without config: the scenario directory\'s own fixtures/ beats the parent sibling fixtures/', () => {
  const fixtureJson = JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: { source: 'x' } });
  const dir = tmpProject({
    'specs/order.yaml': `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`,
    'specs/fixtures/order.json': fixtureJson,
    'fixtures/order.json': fixtureJson,
  });

  assert.equal(
    resolveFixturesDir(join(dir, 'specs/order.yaml')),
    join(dir, 'specs/fixtures'),
  );
});

test('#44 resolveFixturesDir without config: a root-level scenario with no fixture dirs defaults to <project>/atrezzo/fixtures, not the project parent', () => {
  const dir = tmpProject({
    'order.yaml': `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`,
  });

  assert.equal(
    resolveFixturesDir(join(dir, 'order.yaml')),
    join(dir, 'atrezzo/fixtures'),
  );
});

test('#44 resolveFixturesDir without config: <scenarioDir>/atrezzo/fixtures (documented default layout) beats <scenarioDir>/fixtures', () => {
  const fixtureJson = JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: { source: 'x' } });
  const dir = tmpProject({
    'specs/order.yaml': `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
`,
    'specs/atrezzo/fixtures/order.json': fixtureJson,
    'specs/fixtures/order.json': fixtureJson,
  });

  assert.equal(
    resolveFixturesDir(join(dir, 'specs/order.yaml')),
    join(dir, 'specs/atrezzo/fixtures'),
  );
});

test('#44 resolveEffectiveDirs with a valid project config and --scenarios pointing at the project dir keeps the config fixturesDir instead of discovering from the parent', () => {
  const fixtureJson = JSON.stringify({ status: 200, contentType: 'application/json; charset=utf-8', body: { source: 'x' } });
  const root = tmpProject({
    'fixtures/order.json': fixtureJson,
    'atrezzo/fixtures/order.json': fixtureJson,
    'app/atrezzo.config.json': JSON.stringify({
      ...DEFAULT_CONFIG,
      runtime: 'builtin',
      fixturesDir: 'custom-fixtures',
    }, null, 2),
    'app/custom-fixtures/order.json': fixtureJson,
  });
  const project = join(root, 'app');

  const dirs = resolveEffectiveDirs({ cfg: loadConfig(project), dir: project, scenarios: project });
  assert.equal(dirs.fixturesDir, join(project, 'custom-fixtures'));
  assert.equal(dirs.fixturesSource, 'atrezzo.config.json');
});
