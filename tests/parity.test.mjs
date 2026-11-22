// Paridad builtin ↔ msw: la misma petición, por `serve` y por los handlers
// generados, tiene que dar el mismo estado, el mismo cuerpo y las mismas
// cabeceras. Es la prueba que convierte la promesa del README en evidencia.
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
`;

// Stub de `msw`: ejecuta los handlers en orden, como hace MSW, y apunta las
// esperas de `delay()` para poder compararlas con la latencia de `serve`.
const MSW_STUB = `
const waits = [];
export const __waits = waits;
export const delay = async (ms) => { waits.push(ms); };
const handler = (method) => (path, resolver) => ({ method, path, resolver });
export const http = { get: handler('GET'), head: handler('HEAD'), all: handler('ALL'), post: handler('POST'), patch: handler('PATCH'), delete: handler('DELETE'), put: handler('PUT') };
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

/** Como MSW: el primer handler que contesta gana. */
async function viaHandlers(method, pathname, search = '') {
  const url = `http://localhost${pathname}${search}`;
  for (const h of handlers) {
    if (!matches(h, method, pathname)) continue;
    const res = await h.resolver({ request: new Request(url, { method }) });
    if (res) return res;
  }
  return null;
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
  ['GET', '/api/customers', '']
];

for (const [method, path, search] of cases) {
  test(`parity: ${method} ${path}${search} answers the same in serve and msw`, async () => {
    const served = await request(`${baseUrl}${path}${search}`, { method });
    const msw = await viaHandlers(method, path, search);
    assert.ok(msw, 'the handlers answer this route');
    assert.equal(msw.status, served.status);
    assert.deepEqual(JSON.parse(served.text), msw.body);
    assert.equal(msw.headers['x-total-count'], served.headers.get('x-total-count'), 'x-total-count');
  });
}

test('parity: HEAD answers 200 with no body in both (supabase-js count=exact)', async () => {
  const served = await request(`${baseUrl}/api/orders`, { method: 'HEAD', headers: { prefer: 'count=exact' } });
  const msw = await viaHandlers('HEAD', '/api/orders');
  assert.ok(msw, 'HEAD has a handler (it used to fall through to the network)');
  assert.equal(msw.status, served.status);
  assert.equal(served.status, 200);
  assert.equal(served.text, '');
  assert.equal(msw.body ?? null, null);
  assert.equal(msw.headers['x-total-count'], served.headers.get('x-total-count'));
});

test('parity: an undeclared method is 405 in both (it used to pass through in msw)', async () => {
  const served = await request(`${baseUrl}/api/customers`, { method: 'DELETE' });
  const msw = await viaHandlers('DELETE', '/api/customers');
  assert.ok(msw, 'the fallback answers instead of letting the request escape');
  assert.equal(served.status, 405);
  assert.equal(msw.status, 405);
  assert.match(msw.body.error, /not in the contract/);
});

test('parity: a declared write still wins over the 405 fallback', async () => {
  const msw = await viaHandlers('PATCH', '/api/orders/3');
  assert.equal(msw.status, 200);
  const served = await request(`${baseUrl}/api/orders/3`, { method: 'PATCH', body: JSON.stringify({ amount: 1 }), headers: { 'content-type': 'application/json' } });
  assert.equal(served.status, 200);
  assert.deepEqual(msw.body, JSON.parse(served.text));
});

test('parity: latency is waited by the handlers too, not only by serve', async () => {
  const mod = await import(pathToFileURL(join(dir, '.generated/paridad.handlers.mjs')).href);
  await viaHandlers('GET', '/api/orders');
  const { __waits } = await import(pathToFileURL(join(dir, 'node_modules/msw/index.js')).href);
  assert.ok(__waits.includes(120), `delay(120) was called: ${__waits.join(', ')}`);

  const t0 = Date.now();
  await request(`${baseUrl}/api/orders`);
  assert.ok(Date.now() - t0 >= 100, 'serve waits the same 120 ms');
});
