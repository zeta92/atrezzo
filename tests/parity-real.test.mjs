// Paridad de verdad: los handlers generados corren sobre `msw/node` real (no un
// stub) y se comparan con `serve`. Se salta salvo que ATREZZO_PARITY=real, porque
// instala msw desde el registro y el repo no tiene dependencias.
//
// En CI lo lanza .github/workflows/parity-real.yml, nocturno. En local:
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
  // msw se resuelve desde el proyecto temporal: el repo no tiene node_modules propio.
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

const cases = [
  ['GET', '/api/orders', ''],
  ['GET', '/api/orders', '?limit=2'],
  ['GET', '/api/orders', '?limit=2&offset=4'],
  ['GET', '/api/orders', '?customer_id=1'],
  ['GET', '/api/customers', ''],
  ['HEAD', '/api/orders', '']
];

for (const [method, path, search] of cases) {
  test(`real msw parity: ${method} ${path}${search}`, { skip: SKIP, timeout: 30_000 }, async () => {
    const served = await request(`${baseUrl}${path}${search}`, { method });
    // `msw/node` intercepta el fetch global: esta petición pasa por el enrutado real de MSW.
    const viaMsw = await fetch(`http://localhost:4010${path}${search}`, { method, headers: { prefer: 'count=exact' } });
    const mswText = method === 'HEAD' ? '' : await viaMsw.text();
    assert.equal(viaMsw.status, served.status, `${method} ${path}${search}: status`);
    if (method !== 'HEAD') {
      assert.deepEqual(JSON.parse(mswText), JSON.parse(served.text), `${method} ${path}${search}: body`);
    } else {
      assert.equal(mswText, '', 'HEAD has no body in msw either');
      assert.equal(served.text, '');
    }
    assert.equal(viaMsw.headers.get('x-total-count'), served.headers.get('x-total-count'), 'x-total-count');
  });
}

test('real msw parity: an undeclared method is 405', { skip: SKIP, timeout: 30_000 }, async () => {
  const viaMsw = await fetch('http://localhost:4010/api/orders', { method: 'DELETE' });
  const served = await request(`${baseUrl}/api/orders`, { method: 'DELETE' });
  assert.equal(viaMsw.status, 405);
  assert.equal(served.status, 405);
});

test('real msw parity: a declared write reaches the world and the next GET sees it', { skip: SKIP, timeout: 30_000 }, async () => {
  const before = await (await fetch('http://localhost:4010/api/orders?limit=50')).json();
  const target = before.data[0];
  const patched = await fetch(`http://localhost:4010/api/orders/${target.id}`, { method: 'PATCH', body: JSON.stringify({ amount: 2 }), headers: { 'content-type': 'application/json' } });
  assert.equal(patched.status, 200);
  const after = await (await fetch('http://localhost:4010/api/orders?limit=50')).json();
  assert.equal(after.data.find((r) => r.id === target.id).amount, 2);
});
