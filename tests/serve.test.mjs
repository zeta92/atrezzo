import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { SCENARIO, SMALL, tmpProject } from './helpers.mjs';

let mock; let url;
before(async () => {
  const dir = tmpProject({ 'escenarios/conciliacion.yaml': SCENARIO, 'escenarios/pequeno.yaml': SMALL, 'public/index.html': '<h1>hola</h1>' });
  mock = createMockServer({ scenariosDir: join(dir, 'escenarios'), scenario: 'conciliacion', staticDir: join(dir, 'public') });
  url = `http://127.0.0.1:${(await mock.listen(0)).port}`;
});
after(() => mock.close());

const getJson = async (p) => { const r = await fetch(url + p); return { status: r.status, headers: r.headers, body: await r.json() }; };

test('HTTP real: limit/offset y cabecera X-Total-Count', async () => {
  const r = await getJson('/api/orders?limit=5&offset=35');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((x) => x.id), [36, 37, 38, 39, 40]);
  assert.equal(r.headers.get('x-total-count'), '40');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('mismo motor que los handlers: serve == engine', async () => {
  const { createEngine } = await import('../scripts/lib/contract.mjs');
  const direct = createEngine(mock.state.dataset).handle({ pathname: '/api/orders', query: new URLSearchParams('estado=pendiente') });
  assert.deepEqual((await getJson('/api/orders?estado=pendiente')).body, direct.body);
});

test('reset cambia de escenario sin reiniciar y los conteos cambian', async () => {
  const before = await getJson('/__atrezzo/state');
  assert.equal(before.body.escenario, 'conciliacion');
  assert.equal(before.body.counts.pedidos, 40);
  const r = await fetch(`${url}/__atrezzo/reset`, { method: 'POST', body: JSON.stringify({ escenario: 'pequeno' }) });
  assert.equal(r.status, 200);
  const after = await getJson('/__atrezzo/state');
  assert.equal(after.body.escenario, 'pequeno');
  assert.deepEqual(after.body.counts, { clientes: 1, pedidos: 5 });
  assert.equal((await getJson('/api/orders')).body.length, 5);
  assert.equal((await getJson('/api/orders?estado=incidencia')).body.length, 1);
  // y de vuelta
  await fetch(`${url}/__atrezzo/reset?escenario=conciliacion`, { method: 'POST' });
  assert.equal((await getJson('/api/orders?limit=100')).body.length, 40);
});

test('reset a escenario inexistente ⇒ 400 y el estado no cambia', async () => {
  const r = await fetch(`${url}/__atrezzo/reset`, { method: 'POST', body: '{"escenario":"nada"}' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /no encontrado/);
  assert.equal((await getJson('/__atrezzo/state')).body.escenario, 'conciliacion');
});

test('rutas fuera de contrato ⇒ 404 explicativo; estáticos servidos', async () => {
  const r = await getJson('/api/facturas');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /no está en el contrato/);
  const html = await fetch(`${url}/`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /hola/);
  assert.equal((await fetch(`${url}/..%2f..%2fetc/passwd`)).status, 403);
});
