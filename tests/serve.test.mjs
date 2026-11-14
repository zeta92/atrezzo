import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { SCENARIO, SMALL, tmpProject } from './helpers.mjs';

let mock; let url;
before(async () => {
  const dir = tmpProject({ 'scenarios/conciliacion.yaml': SCENARIO, 'scenarios/pequeno.yaml': SMALL, 'public/index.html': '<h1>hello</h1>' });
  mock = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'conciliacion', staticDir: join(dir, 'public') });
  url = `http://127.0.0.1:${(await mock.listen(0)).port}`;
});
after(() => mock.close());

const getJson = async (p) => { const r = await fetch(url + p); return { status: r.status, headers: r.headers, body: await r.json() }; };

test('real HTTP: limit/offset and X-Total-Count header', async () => {
  const r = await getJson('/api/orders?limit=5&offset=35');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((x) => x.id), [36, 37, 38, 39, 40]);
  assert.equal(r.headers.get('x-total-count'), '40');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('same engine as the handlers: serve == engine', async () => {
  const { createEngine } = await import('../scripts/lib/contract.mjs');
  const direct = createEngine(mock.state.dataset).handle({ pathname: '/api/orders', query: new URLSearchParams('status=pending') });
  assert.deepEqual((await getJson('/api/orders?status=pending')).body, direct.body);
});

test('reset switches scenario without restarting and the counts change', async () => {
  const before = await getJson('/__atrezzo/state');
  assert.equal(before.body.scenario, 'conciliacion');
  assert.equal(before.body.counts.orders, 40);
  const r = await fetch(`${url}/__atrezzo/reset`, { method: 'POST', body: JSON.stringify({ scenario: 'pequeno' }) });
  assert.equal(r.status, 200);
  const after = await getJson('/__atrezzo/state');
  assert.equal(after.body.scenario, 'pequeno');
  assert.deepEqual(after.body.counts, { customers: 1, orders: 5 });
  assert.equal((await getJson('/api/orders')).body.length, 5);
  assert.equal((await getJson('/api/orders?status=issue')).body.length, 1);
  // and back
  await fetch(`${url}/__atrezzo/reset?scenario=conciliacion`, { method: 'POST' });
  assert.equal((await getJson('/api/orders?limit=100')).body.length, 40);
});

test('reset to an unknown scenario ⇒ 400 and the state does not change', async () => {
  const r = await fetch(`${url}/__atrezzo/reset`, { method: 'POST', body: '{"scenario":"nada"}' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not found/);
  assert.equal((await getJson('/__atrezzo/state')).body.scenario, 'conciliacion');
});

test('routes outside the contract ⇒ explanatory 404; static files served', async () => {
  const r = await getJson('/api/facturas');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /is not in the contract/);
  const html = await fetch(`${url}/`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /hello/);
  assert.equal((await fetch(`${url}/..%2f..%2fetc/passwd`)).status, 403);
});
