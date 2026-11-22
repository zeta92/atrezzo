// Real parity: the generated handlers run on real `msw/node` (not a stub) and
// are compared with `serve`. Skipped unless ATREZZO_PARITY=real, because it
// installs msw from the registry and the repo has no dependencies.
//
// In CI, .github/workflows/parity-real.yml runs it nightly. Locally:
//   ATREZZO_PARITY=real node --test tests/parity-real.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { tmpProject, cli } from './helpers.mjs';
import { request } from './helpers/http.mjs';

const REAL = process.env.ATREZZO_PARITY === 'real';
const SKIP = REAL ? false : 'ATREZZO_PARITY=real not set (installs msw, network required)';

const SCENARIO = `name: paridad-real
seed: 11
now: 2025-03-01T09:00:00Z
world:
  customers:
    total: 3
    fields:
      name: string
  orders:
    total: 9
    ref: customers
    fields:
      reference: string
      amount: number
endpoints:
  - path: /api/orders
    entity: orders
    filters: [customer_id]
    pagination: { param_limit: limit, param_offset: offset, default_limit: 4 }
    sort: [amount]
    shape: envelope
    envelope: { items: data, total: total, total_pages: pages }
    latency: 40
  - path: /api/customers
    entity: customers
writes:
  "PATCH /api/orders/:id":
    expect: { status: 200, echo: true }
    mutate: { entity: orders, set: { amount: 2 } }
rpc:
  do_thing:
    expect: { status: 200 }
    body: { ok: true }
`;

let dir; let mock; let baseUrl; let server; let handlers;

before(async () => {
  if (!REAL) return;
  dir = tmpProject({
    'package.json': JSON.stringify({ name: 'parity', type: 'module', private: true }),
    'atrezzo.config.json': JSON.stringify({ version: 1, stack: 'other', runtime: 'msw', scenariosDir: 'scenarios', handlersDir: 'handlers', generatedDir: '.generated' }),
    'scenarios/paridad-real.yaml': SCENARIO
  });
  const install = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', 'msw@2'], { cwd: dir, encoding: 'utf8', timeout: 180_000 });
  assert.equal(install.status, 0, `npm install msw failed: ${install.stderr?.slice(-800)}`);
  const w = cli(['world', join(dir, 'scenarios/paridad-real.yaml'), '--dir', dir]);
  assert.equal(w.code, 0, w.stderr);

  const { handlers: hs } = await import(pathToFileURL(join(dir, '.generated/paridad-real.handlers.mjs')).href);
  handlers = hs;
  // msw is resolved from the temporary project: the repo has no node_modules of its own.
  const { createRequire } = await import('node:module');
  const fromProject = createRequire(join(dir, 'package.json'));
  const { setupServer } = await import(pathToFileURL(fromProject.resolve('msw/node')).href);
  server = setupServer(...handlers);
  server.listen({ onUnhandledRequest: 'error' });

  mock = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'paridad-real' });
  baseUrl = `http://127.0.0.1:${(await mock.listen(0)).port}`;
});

after(() => {
  if (!REAL) return;
  server?.close();
  mock?.close();
});

/**
 * The very same request (method, path, query, headers, body) through `serve` and through real msw.
 * `msw/node` intercepts the global fetch: the second one goes through MSW's real routing.
 */
async function both(method, path, search = '', { headers = {}, body } = {}) {
  const served = await request(`${baseUrl}${path}${search}`, { method, headers, body });
  // Guard: the serve side must really come from serve (msw would otherwise answer both).
  assert.equal(served.headers.get('cache-control'), 'no-store', 'the serve request reached serve');
  const res = await fetch(`http://localhost:4010${path}${search}`, { method, headers, body });
  const viaMsw = { status: res.status, headers: res.headers, text: method === 'HEAD' ? '' : await res.text() };
  return { served, viaMsw };
}

const COMPARED_HEADERS = ['x-total-count', 'content-range', 'allow'];
// `serve` sends CORS headers on every answer; the handlers only on the preflight, where they matter.
const PREFLIGHT_HEADERS = ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers'];

/** Same status and same compared headers; the body too unless it is a 405 (serve adds its gap report there). */
function assertSame({ served, viaMsw }, label) {
  assert.equal(viaMsw.status, served.status, `${label}: status`);
  const compared = served.status === 204 ? [...COMPARED_HEADERS, ...PREFLIGHT_HEADERS] : COMPARED_HEADERS;
  for (const h of compared) assert.equal(viaMsw.headers.get(h), served.headers.get(h), `${label}: ${h}`);
  if (served.status === 405) {
    assert.match(JSON.parse(served.text).error, /not in the contract/, `${label}: serve error`);
    assert.match(JSON.parse(viaMsw.text).error, /not in the contract/, `${label}: msw error`);
  } else if (served.text === '') {
    assert.equal(viaMsw.text, '', `${label}: no body in msw either`);
  } else {
    assert.deepEqual(JSON.parse(viaMsw.text), JSON.parse(served.text), `${label}: body`);
  }
}

const COUNT = { headers: { prefer: 'count=exact' } };
const cases = [
  ['GET', '/api/orders', ''],
  ['GET', '/api/orders', '?limit=2'],
  ['GET', '/api/orders', '?limit=2&offset=4'],
  ['GET', '/api/orders', '?customer_id=1'],
  ['GET', '/api/customers', ''],
  ['GET', '/api/customers', '', COUNT],
  ['HEAD', '/api/orders', ''],
  ['HEAD', '/api/orders', '', COUNT],
  // Undeclared methods: 405 with the same `Allow` (they used to escape to the network in msw).
  ['DELETE', '/api/orders', ''], // collection
  ['DELETE', '/api/customers/1', ''], // detail route
  ['DELETE', '/api/orders/3', ''], // detail route with a declared write (Allow: GET, PATCH)
  ['GET', '/rpc/do_thing', ''], // PostgREST function answers POST only
  // CORS preflight: 204 on both sides, not 405.
  ['OPTIONS', '/api/orders', '', { headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' } }],
  // A declared rpc keeps winning over the fallback.
  ['POST', '/rpc/do_thing', '', { headers: { 'content-type': 'application/json' }, body: '{}' }],
];

for (const [method, path, search, opts] of cases) {
  const label = `${method} ${path}${search}${opts?.headers?.prefer ? ' (prefer: count=exact)' : ''}`;
  test(`real msw parity: ${label}`, { skip: SKIP, timeout: 30_000 }, async () => {
    assertSame(await both(method, path, search, opts), label);
  });
}

test('real msw parity: a declared write answers the same, and the next GET sees it', { skip: SKIP, timeout: 30_000 }, async () => {
  const target = (await (await fetch('http://localhost:4010/api/orders?limit=50')).json()).data[0];
  const r = await both('PATCH', `/api/orders/${target.id}`, '', { body: JSON.stringify({ amount: 2 }), headers: { 'content-type': 'application/json' } });
  assert.equal(r.served.status, 200);
  assertSame(r, `PATCH /api/orders/${target.id}`);
  const after = await (await fetch('http://localhost:4010/api/orders?limit=50')).json();
  assert.equal(after.data.find((x) => x.id === target.id).amount, 2);
});
