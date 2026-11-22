// builtin ↔ msw parity: the same request, through `serve` and through the
// generated handlers, has to give the same status, body and headers. This is
// the test that turns the README's promise into evidence.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { tmpProject, cli } from './helpers.mjs';
import { request } from './helpers/http.mjs';

const SCENARIO = `name: paridad
seed: 7
now: 2025-03-01T09:00:00Z
world:
  customers:
    total: 3
    fields:
      name: string
  orders:
    total: 8
    ref: customers
    fields:
      reference: string
      amount: number
endpoints:
  - path: /api/orders
    entity: orders
    filters: [customer_id]
    pagination: { param_limit: limit, param_offset: offset, default_limit: 3 }
    sort: [amount]
    shape: envelope
    envelope: { items: data, total: total }
    latency: 120
  - path: /api/customers
    entity: customers
writes:
  "PATCH /api/orders/:id":
    expect: { status: 200, echo: true }
    mutate: { entity: orders, set: { amount: 1 } }
rpc:
  do_thing:
    expect: { status: 200 }
    body: { ok: true }
`;

// `msw` stub: runs the handlers in order, as MSW does, and records the
// `delay()` waits so they can be compared with `serve`'s latency.
const MSW_STUB = `
const waits = [];
export const __waits = waits;
export const delay = async (ms) => { waits.push(ms); };
const handler = (method) => (path, resolver) => ({ method, path, resolver });
export const http = { get: handler('GET'), head: handler('HEAD'), all: handler('ALL'), post: handler('POST'), patch: handler('PATCH'), delete: handler('DELETE'), put: handler('PUT'), options: handler('OPTIONS') };
export const HttpResponse = Object.assign(
  function HttpResponse(body, init) { return { body, ...init }; },
  { json: (body, init) => ({ body, ...init }) },
);
`;

let dir; let mock; let baseUrl; let handlers;

const matches = (pattern, method, pathname) => {
  if (pattern.method !== 'ALL' && pattern.method !== method) return false;
  const p = pattern.path.replace(/^\*/, '').split('/').filter(Boolean);
  const got = pathname.split('/').filter(Boolean);
  if (p.length !== got.length) return false;
  return p.every((seg, i) => (seg.startsWith(':') ? got[i].length > 0 : seg === got[i]));
};

/** Like MSW: the first handler that answers wins. */
async function viaHandlers(method, pathname, search = '', { headers = {}, body } = {}) {
  const url = `http://localhost${pathname}${search}`;
  for (const h of handlers) {
    if (!matches(h, method, pathname)) continue;
    const res = await h.resolver({ request: new Request(url, { method, headers, body }) });
    if (res) return res;
  }
  return null;
}

/** The very same request (method, path, query, headers, body) through `serve` and through the handlers. */
async function both(method, path, search = '', { headers = {}, body } = {}) {
  const served = await request(`${baseUrl}${path}${search}`, { method, headers, body });
  const msw = await viaHandlers(method, path, search, { headers, body });
  return { served, msw };
}

const COMPARED_HEADERS = ['x-total-count', 'content-range', 'allow'];
// `serve` sends CORS headers on every answer; the handlers only on the preflight, where they matter.
const PREFLIGHT_HEADERS = ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers'];

/** Same status and same compared headers; the body too unless it is a 405 (serve adds its gap report there). */
function assertSame({ served, msw }, label) {
  assert.ok(msw, `${label}: the handlers answer this route`);
  assert.equal(msw.status, served.status, `${label}: status`);
  const mswHeaders = new Headers(msw.headers ?? {});
  const compared = served.status === 204 ? [...COMPARED_HEADERS, ...PREFLIGHT_HEADERS] : COMPARED_HEADERS;
  for (const h of compared) assert.equal(mswHeaders.get(h), served.headers.get(h), `${label}: ${h}`);
  if (served.status === 405) {
    assert.match(served.text ? JSON.parse(served.text).error : '', /not in the contract/, `${label}: serve error`);
    assert.match(msw.body?.error ?? '', /not in the contract/, `${label}: msw error`);
  } else if (served.text === '') {
    assert.equal(msw.body ?? null, null, `${label}: no body in msw either`);
  } else {
    assert.deepEqual(msw.body, JSON.parse(served.text), `${label}: body`);
  }
}

before(async () => {
  dir = tmpProject({
    'atrezzo.config.json': JSON.stringify({ version: 1, stack: 'other', runtime: 'msw', scenariosDir: 'scenarios', handlersDir: 'handlers', generatedDir: '.generated' }),
    'scenarios/paridad.yaml': SCENARIO,
    'node_modules/msw/package.json': JSON.stringify({ name: 'msw', type: 'module', exports: './index.js' }),
    'node_modules/msw/index.js': MSW_STUB
  });
  const r = cli(['world', join(dir, 'scenarios/paridad.yaml'), '--dir', dir]);
  assert.equal(r.code, 0, r.stderr);
  handlers = (await import(pathToFileURL(join(dir, '.generated/paridad.handlers.mjs')).href)).handlers;
  mock = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'paridad' });
  baseUrl = `http://127.0.0.1:${(await mock.listen(0)).port}`;
});

after(() => mock.close());

const cases = [
  ['GET', '/api/orders', ''],
  ['GET', '/api/orders', '?limit=2'],
  ['GET', '/api/orders', '?limit=2&offset=2'],
  ['GET', '/api/orders', '?customer_id=2'],
  ['GET', '/api/customers', ''],
  ['GET', '/api/customers', '', { headers: { prefer: 'count=exact' } }],
];

for (const [method, path, search, opts] of cases) {
  test(`parity: ${method} ${path}${search}${opts ? ' (prefer: count=exact)' : ''} answers the same in serve and msw`, async () => {
    assertSame(await both(method, path, search, opts), `${method} ${path}${search}`);
  });
}

test('parity: HEAD answers 200 with no body in both (supabase-js count=exact)', async () => {
  const r = await both('HEAD', '/api/orders', '', { headers: { prefer: 'count=exact' } });
  assert.ok(r.msw, 'HEAD has a handler (it used to fall through to the network)');
  assert.equal(r.served.status, 200);
  assert.equal(r.served.text, '');
  assert.ok(r.served.headers.get('content-range'), 'count=exact asks for content-range');
  assertSame(r, 'HEAD /api/orders');
});

// Undeclared methods: 405 with the same `Allow` on every contract route (they used to escape to the network in msw).
const notAllowed = [
  ['DELETE', '/api/customers', 'GET'], // collection
  ['DELETE', '/api/customers/1', 'GET'], // detail route
  ['DELETE', '/api/orders/3', 'GET, PATCH'], // detail route with a declared write
  ['GET', '/rpc/do_thing', 'POST'], // PostgREST function answers POST only
];

for (const [method, path, allow] of notAllowed) {
  test(`parity: ${method} ${path} is 405 (Allow: ${allow}) in both`, async () => {
    const r = await both(method, path);
    assert.equal(r.served.status, 405);
    assert.equal(r.served.headers.get('allow'), allow);
    assertSame(r, `${method} ${path}`);
  });
}

test('parity: OPTIONS (CORS preflight) answers 204 in both, not 405', async () => {
  const r = await both('OPTIONS', '/api/orders', '', { headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' } });
  assert.equal(r.served.status, 204);
  assertSame(r, 'OPTIONS /api/orders');
});

test('parity: a declared write still wins over the 405 fallback', async () => {
  const r = await both('PATCH', '/api/orders/3', '', { body: JSON.stringify({ amount: 1 }), headers: { 'content-type': 'application/json' } });
  assert.equal(r.served.status, 200);
  assertSame(r, 'PATCH /api/orders/3');
});

test('parity: a declared rpc still wins over the 405 fallback', async () => {
  const r = await both('POST', '/rpc/do_thing', '', { body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(r.served.status, 200);
  assertSame(r, 'POST /rpc/do_thing');
});

test('parity: latency is waited by the handlers too, not only by serve', async () => {
  const { __waits } = await import(pathToFileURL(join(dir, 'node_modules/msw/index.js')).href);
  __waits.length = 0;
  await viaHandlers('GET', '/api/orders');
  assert.deepEqual(__waits, [120], 'delay(120) was called');

  const t0 = Date.now();
  await request(`${baseUrl}/api/orders`);
  assert.ok(Date.now() - t0 >= 100, 'serve waits the same 120 ms');
});
