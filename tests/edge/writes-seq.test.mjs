// Secuencias de escrituras contra el motor, con invariantes después de CADA
// paso: la integridad referencial no se rompe y `reset` devuelve el mundo
// inicial. Un 204 que deja hijos huérfanos es un bug aunque el POST esté verde.
//
// En proceso (createEngine) a propósito: 200 secuencias por HTTP tardarían
// minutos y lo que se prueba es el motor, no el transporte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadScenario } from '../../scripts/lib/scenario.mjs';
import { generateWorld, checkIntegrity } from '../../scripts/lib/world.mjs';
import { createEngine } from '../../scripts/lib/contract.mjs';
import { createRng } from '../../scripts/lib/prng.mjs';
import { tmpProject } from '../helpers.mjs';

const SCENARIO = `name: secuencias
seed: 5
now: 2025-03-01T09:00:00Z
world:
  customers:
    total: 4
    fields:
      name: string
      email: email
  orders:
    total: 10
    ref: customers
    fields:
      reference: string
      amount: number
      notes: string
endpoints:
  - path: /api/customers
    entity: customers
  - path: /api/orders
    entity: orders
writes:
  "POST /api/orders":
    expect: { status: 201, echo: true }
    mutate: { entity: orders, set: { amount: 10 } }
  "PATCH /api/orders/:id":
    expect: { status: 200, echo: true }
    mutate: { entity: orders }
  "DELETE /api/orders/:id":
    expect: { status: 204 }
    mutate: { entity: orders }
  "DELETE /api/customers/:id":
    expect: { status: 204 }
    mutate: { entity: customers }
`;

const dir = tmpProject({ 'secuencias.yaml': SCENARIO });
const dataset = generateWorld(loadScenario(join(dir, 'secuencias.yaml')));

const fresh = () => createEngine(dataset);
const call = (engine, method, pathname, body) => engine.handle({
  method, pathname, query: new URLSearchParams(), headers: { 'content-type': 'application/json' }, body
});
const entitiesOf = (engine) => engine.dataset.entities;
const integrity = (engine) => checkIntegrity({ ...engine.dataset, entities: entitiesOf(engine) });

/** Hijos huérfanos: un pedido que apunta a un cliente que ya no está. */
const orphans = (engine) => {
  const ids = new Set(entitiesOf(engine).customers.map((c) => c.id));
  return entitiesOf(engine).orders.filter((o) => o.customer_id !== null && !ids.has(o.customer_id)).map((o) => o.id);
};

test('writes: el mundo inicial está íntegro y reset devuelve el mismo mundo', () => {
  const engine = fresh();
  assert.deepEqual(integrity(engine), []);
  const before = JSON.stringify(entitiesOf(engine));
  call(engine, 'DELETE', '/api/orders/1');
  engine.reset();
  assert.equal(JSON.stringify(entitiesOf(engine)), before);
});

test('writes: borrar un cliente con pedidos no deja huérfanos (409 o cascada explícita)', () => {
  const engine = fresh();
  const customer = entitiesOf(engine).customers.find((c) => entitiesOf(engine).orders.some((o) => o.customer_id === c.id));
  assert.ok(customer, 'hay un cliente con pedidos');
  const res = call(engine, 'DELETE', `/api/customers/${customer.id}`);
  const gone = orphans(engine);
  assert.deepEqual(gone, [], `el DELETE respondió ${res.status} y dejó ${gone.length} pedidos huérfanos (ids ${gone.join(',')})`);
  if (res.status === 204) {
    assert.ok(!entitiesOf(engine).orders.some((o) => o.customer_id === customer.id), 'si se permite borrar, los hijos se van con él');
  } else {
    assert.equal(res.status, 409, 'solo 409 es una negativa honesta');
    assert.match(res.body.error, /point at it|children|referenc|in use/i);
  }
});

test('writes: crear un hijo con una FK inexistente es 422, no una fila rota', () => {
  const engine = fresh();
  const before = entitiesOf(engine).orders.length;
  const res = call(engine, 'POST', '/api/orders', { reference: 'x', amount: 1, customer_id: 9999 });
  const lost = orphans(engine);
  assert.deepEqual(lost, [], `respondió ${res.status} y dejó huérfanos`);
  if (res.status === 201) assert.fail('aceptó un customer_id inexistente');
  assert.equal(res.status, 422, `esperaba 422, respondió ${res.status}`);
  assert.match(res.body.error, /customer_id/);
  assert.equal(entitiesOf(engine).orders.length, before, 'no escribe nada');
});

test('writes: 200 secuencias aleatorias mantienen la integridad y reset vuelve al inicio', () => {
  const rng = createRng('secuencias-v1');
  const engine = fresh();
  const start = JSON.stringify(entitiesOf(engine));
  const failures = [];
  for (let seq = 0; seq < 200 && failures.length <= 5; seq++) {
    const pick = (n) => rng.int(0, n - 1);
    const steps = 3 + pick(3);
    for (let s = 0; s < steps; s++) {
      const st = entitiesOf(engine);
      const action = pick(6);
      let res;
      if (action === 0) {
        res = call(engine, 'POST', '/api/orders', { reference: `s${seq}`, amount: 1, customer_id: st.customers[pick(st.customers.length)].id });
      } else if (action === 1 && st.orders.length) {
        res = call(engine, 'PATCH', `/api/orders/${st.orders[pick(st.orders.length)].id}`, { amount: pick(100) });
      } else if (action === 2 && st.orders.length) {
        res = call(engine, 'DELETE', `/api/orders/${st.orders[pick(st.orders.length)].id}`);
      } else if (action === 3 && st.customers.length) {
        res = call(engine, 'DELETE', `/api/customers/${st.customers[pick(st.customers.length)].id}`);
      } else if (action === 4) {
        engine.reset();
        res = { status: 200 };
      } else {
        res = call(engine, 'GET', '/api/orders');
      }
      const lost = orphans(engine);
      if (lost.length) failures.push(`seq ${seq} paso ${s}: ${res.status} dejó huérfanos ${lost.join(',')}`);
      const broken = integrity(engine);
      if (broken.length) failures.push(`seq ${seq} paso ${s}: integridad rota (${broken.slice(0, 2).join(' · ')})`);
      if (failures.length > 5) break;
    }
    engine.reset();
    if (JSON.stringify(entitiesOf(engine)) !== start) failures.push(`seq ${seq}: reset no devolvió el mundo inicial`);
  }
  assert.deepEqual(failures, []);
});
