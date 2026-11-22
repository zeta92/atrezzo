// Write sequences against the engine, with invariants after EVERY step: the
// expected status, referential integrity, and `reset` going back to the initial
// world. A 204 that leaves orphans is a bug even if the POST is green.
//
// In process (createEngine) on purpose: 200 sequences over HTTP would take
// minutes, and what is under test is the engine, not the transport.
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

/** Orphans: an order pointing at a customer that is gone. */
const orphans = (engine) => {
  const ids = new Set(entitiesOf(engine).customers.map((c) => c.id));
  return entitiesOf(engine).orders.filter((o) => o.customer_id !== null && !ids.has(o.customer_id)).map((o) => o.id);
};

test('writes: the initial world is sound and reset gives back the same world', () => {
  const engine = fresh();
  assert.deepEqual(integrity(engine), []);
  const before = JSON.stringify(entitiesOf(engine));
  assert.equal(call(engine, 'DELETE', '/api/orders/1').status, 204);
  engine.reset();
  assert.equal(JSON.stringify(entitiesOf(engine)), before);
});

test('writes: deleting a customer with orders leaves no orphans (409)', () => {
  const engine = fresh();
  const customer = entitiesOf(engine).customers.find((c) => entitiesOf(engine).orders.some((o) => o.customer_id === c.id));
  assert.ok(customer, 'there is a customer with orders');
  const res = call(engine, 'DELETE', `/api/customers/${customer.id}`);
  assert.equal(res.status, 409, 'only a 409 is an honest refusal');
  assert.match(res.body.error, /point at it/);
  assert.deepEqual(orphans(engine), []);
});

test('writes: a foreign key that does not exist, or is missing, is 422 and writes nothing', () => {
  const engine = fresh();
  const before = JSON.stringify(entitiesOf(engine));
  for (const body of [
    { reference: 'x', amount: 1, customer_id: 9999 },
    { reference: 'x', amount: 1, customer_id: '9999' },
    { reference: 'x', amount: 1, customer_id: 'abc' },
    { reference: 'x', amount: 1 },
  ]) {
    const res = call(engine, 'POST', '/api/orders', body);
    assert.equal(res.status, 422, `POST ${JSON.stringify(body)} answered ${res.status}`);
    assert.match(res.body.error, /customer_id/);
    assert.equal(JSON.stringify(entitiesOf(engine)), before, `POST ${JSON.stringify(body)} wrote something`);
  }
  const patch = call(engine, 'PATCH', '/api/orders/1', { customer_id: 9999 });
  assert.equal(patch.status, 422);
  assert.equal(JSON.stringify(entitiesOf(engine)), before, 'the PATCH wrote something');
});

test('writes: a foreign key sent as a string is stored with the type of the ids', () => {
  const engine = fresh();
  const target = entitiesOf(engine).customers[0].id;
  const created = call(engine, 'POST', '/api/orders', { reference: 'x', amount: 1, customer_id: String(target) });
  assert.equal(created.status, 201);
  assert.equal(created.body.customer_id, target);
  const updated = call(engine, 'PATCH', '/api/orders/1', { customer_id: String(target) });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.customer_id, target);
  assert.deepEqual(integrity(engine), []);
});

test('writes: a POST without a nullable foreign key stores null', () => {
  const nullableDir = tmpProject({ 's.yaml': SCENARIO.replace('    ref: customers\n', '    ref: customers\n    nulls: { customer_id: 2 }\n') });
  const engine = createEngine(generateWorld(loadScenario(join(nullableDir, 's.yaml'))));
  const res = call(engine, 'POST', '/api/orders', { reference: 'x', amount: 1 });
  assert.equal(res.status, 201);
  assert.equal(res.body.customer_id, null);
  const stored = entitiesOf(engine).orders.find((o) => o.id === res.body.id);
  assert.ok(Object.hasOwn(stored, 'customer_id') && stored.customer_id === null, 'the key is written as null, not left out');
  assert.deepEqual(checkIntegrity({ ...engine.dataset, entities: entitiesOf(engine) }), []);
});

test('writes: 200 random sequences answer the expected status, keep integrity, and reset goes back to the start', () => {
  const rng = createRng('sequences-v2');
  const engine = fresh();
  const start = JSON.stringify(entitiesOf(engine));
  const failures = [];
  const seen = new Map();
  const pick = (n) => rng.int(0, n - 1);
  const anyOf = (list) => list[pick(list.length)];

  /** One request, its expected status, and the checks that follow every step. */
  const step = (where, method, path, body, expected) => {
    const before = JSON.stringify(entitiesOf(engine));
    const res = call(engine, method, path, body);
    const key = `${method} ${path.split('/')[2]} ${res.status}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (res.status !== expected) failures.push(`${where}: ${method} ${path} ${JSON.stringify(body ?? null)} answered ${res.status}, expected ${expected}`);
    if (res.status >= 400 && JSON.stringify(entitiesOf(engine)) !== before) failures.push(`${where}: ${res.status} changed the world`);
    const lost = orphans(engine);
    if (lost.length) failures.push(`${where}: ${res.status} left orphans ${lost.join(',')}`);
    const broken = integrity(engine);
    if (broken.length) failures.push(`${where}: integrity broken (${broken.slice(0, 2).join(' · ')})`);
    return res;
  };

  for (let seq = 0; seq < 200 && failures.length <= 5; seq++) {
    const steps = 4 + pick(7);
    for (let s = 0; s < steps && failures.length <= 5; s++) {
      const where = `seq ${seq} step ${s}`;
      const { customers, orders } = entitiesOf(engine);
      const customerIds = customers.map((c) => c.id);
      const missingId = Math.max(0, ...customerIds, ...orders.map((o) => o.id)) + 100;
      const action = pick(11);
      if (action === 0 && customers.length) {
        step(where, 'POST', '/api/orders', { reference: `s${seq}`, amount: 1, customer_id: anyOf(customerIds) }, 201);
      } else if (action === 1 && customers.length) {
        step(where, 'POST', '/api/orders', { reference: `s${seq}`, amount: 1, customer_id: String(anyOf(customerIds)) }, 201);
      } else if (action === 2) {
        const body = anyOf([{ customer_id: missingId }, { customer_id: String(missingId) }, { customer_id: 'abc' }, {}]);
        step(where, 'POST', '/api/orders', { reference: `s${seq}`, amount: 1, ...body }, 422);
      } else if (action === 3 && orders.length) {
        step(where, 'PATCH', `/api/orders/${anyOf(orders).id}`, { amount: pick(100) }, 200);
      } else if (action === 4 && orders.length) {
        const bad = pick(2) === 0;
        if (!bad && !customers.length) continue;
        step(where, 'PATCH', `/api/orders/${anyOf(orders).id}`, { customer_id: bad ? missingId : anyOf(customerIds) }, bad ? 422 : 200);
      } else if (action === 5 && orders.length) {
        step(where, 'DELETE', `/api/orders/${anyOf(orders).id}`, undefined, 204);
      } else if (action === 6) {
        step(where, 'DELETE', `/api/orders/${missingId}`, undefined, 404);
      } else if (action === 7 && customers.length) {
        const c = anyOf(customers);
        step(where, 'DELETE', `/api/customers/${c.id}`, undefined, orders.some((o) => o.customer_id === c.id) ? 409 : 204);
      } else if (action === 8 && customers.length) {
        // Empty a customer first, then delete it: the delete that integrity allows.
        const c = anyOf(customers);
        for (const o of orders.filter((x) => x.customer_id === c.id)) step(where, 'DELETE', `/api/orders/${o.id}`, undefined, 204);
        step(where, 'DELETE', `/api/customers/${c.id}`, undefined, 204);
      } else if (action === 9) {
        engine.reset();
      } else {
        step(where, 'GET', '/api/orders', undefined, 200);
      }
    }
    engine.reset();
    if (JSON.stringify(entitiesOf(engine)) !== start) failures.push(`seq ${seq}: reset did not give back the initial world`);
  }
  assert.deepEqual(failures, []);
  // Every branch was really exercised, not just the happy path.
  for (const key of [
    'POST orders 201', 'POST orders 422', 'PATCH orders 200', 'PATCH orders 422', 'DELETE orders 204',
    'DELETE orders 404', 'DELETE customers 204', 'DELETE customers 409', 'GET orders 200',
  ]) {
    assert.ok((seen.get(key) ?? 0) >= 5, `${key} happened ${seen.get(key) ?? 0} times: ${[...seen].map(([k, n]) => `${k}=${n}`).join(', ')}`);
  }
});
