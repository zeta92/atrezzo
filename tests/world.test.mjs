import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { generateWorld, checkIntegrity } from '../scripts/lib/world.mjs';
import { datasetJson } from '../scripts/lib/codegen.mjs';
import { SCENARIO } from './helpers.mjs';

const scenario = (text = SCENARIO) => normalizeScenario(parseYaml(text, 't.yaml'), 't.yaml');

test('exact counts from the scenario', () => {
  const d = generateWorld(scenario());
  assert.equal(d.entities.customers.length, 3);
  assert.equal(d.entities.orders.length, 40);
  assert.equal(d.entities.users.length, 2);
});

test('status distribution honored exactly', () => {
  const d = generateWorld(scenario());
  const counts = {};
  for (const p of d.entities.orders) counts[p.status] = (counts[p.status] ?? 0) + 1;
  assert.deepEqual(counts, { paid: 34, pending: 3, issue: 3 });
});

test('referential integrity: every customer_id exists and every customer has orders', () => {
  const d = generateWorld(scenario());
  const ids = new Set(d.entities.customers.map((c) => c.id));
  for (const p of d.entities.orders) assert.ok(ids.has(p.customer_id), `customer_id ${p.customer_id} does not exist`);
  for (const id of ids) assert.ok(d.entities.orders.some((p) => p.customer_id === id), `customer ${id} has no orders`);
  assert.deepEqual(checkIntegrity(d), []);
});

test('unique, consecutive ids; amounts within range with 2 decimals', () => {
  const d = generateWorld(scenario());
  assert.deepEqual(d.entities.orders.map((p) => p.id), Array.from({ length: 40 }, (_, i) => i + 1));
  for (const p of d.entities.orders) {
    assert.ok(p.amount >= 20 && p.amount <= 900, `amount ${p.amount}`);
    assert.equal(Math.round(p.amount * 100) / 100, p.amount);
    assert.equal(p.currency, 'EUR');
  }
});

test('byte-for-byte determinism: same seed ⇒ same JSON', () => {
  assert.equal(datasetJson(generateWorld(scenario())), datasetJson(generateWorld(scenario())));
});

test('different seed ⇒ different data with the same counts', () => {
  const a = generateWorld(scenario());
  const b = generateWorld(scenario(SCENARIO.replace('seed: 7712', 'seed: 1')));
  assert.notDeepEqual(a.entities.orders, b.entities.orders);
  assert.equal(b.entities.orders.filter((p) => p.status === 'issue').length, 3);
});

test('injected "now": dates depend on the scenario, not the clock', () => {
  const a = generateWorld(scenario());
  const later = generateWorld(scenario(SCENARIO.replace('now: 2025-03-01T09:00:00Z', 'now: 2026-03-01T09:00:00Z')));
  for (const p of a.entities.orders) assert.ok(p.created_at <= '2025-03-01T09:00:00.000Z');
  assert.notEqual(a.entities.orders[0].created_at, later.entities.orders[0].created_at);
});

test('no order predates its customer', () => {
  const d = generateWorld(scenario());
  const born = Object.fromEntries(d.entities.customers.map((c) => [c.id, c.created_at]));
  for (const p of d.entities.orders) assert.ok(p.created_at >= born[p.customer_id]);
});

test('adding an entity does not change the others (per-entity streams)', () => {
  const a = generateWorld(scenario());
  const b = generateWorld(scenario(SCENARIO.replace('  users: 2', '  users: 2\n  products: 5')));
  assert.deepEqual(a.entities.orders, b.entities.orders);
  assert.equal(b.entities.products.length, 5);
});

test('explicit nulls: exactly n records with the field set to null', () => {
  const d = generateWorld(scenario(SCENARIO.replace('  users: 2', '  users: { total: 4, nulls: { email: 2 } }')));
  assert.equal(d.entities.users.filter((u) => u.email === null).length, 2);
});

test('built-in templates use English entity and field names', () => {
  const d = generateWorld(scenario(SCENARIO.replace('  users: 2', '  users: 2\n  products: 2')));
  assert.deepEqual(d.schema.customers.fields, ['id', 'name', 'email', 'city', 'created_at']);
  assert.deepEqual(d.schema.orders.fields, ['id', 'reference', 'customer_id', 'status', 'amount', 'currency', 'created_at']);
  assert.deepEqual(d.schema.users.fields, ['id', 'name', 'email', 'role', 'created_at']);
  assert.deepEqual(d.schema.products.fields, ['id', 'name', 'sku', 'price', 'currency', 'stock']);
  assert.equal(d.schema.orders.singular, 'order');
  assert.match(d.entities.orders[0].reference, /^ORD-\d{5}$/);
  assert.deepEqual([...new Set(d.entities.users.map((u) => u.role))].sort(), ['admin', 'operator']);
});

test('generic entities get an English singular for their foreign key', () => {
  const s = scenario(SCENARIO.replace('  users: 2', '  users: 2\n  categories: 2\n  invoices: { total: 3, ref: categories }\n  boxes: { total: 1, ref: invoices }'));
  const d = generateWorld(s);
  assert.equal(d.schema.categories.fk, 'category_id');
  assert.ok(d.schema.invoices.fields.includes('category_id'));
  assert.ok(d.schema.boxes.fields.includes('invoice_id'));
  assert.equal(d.schema.boxes.singular, 'box');
  assert.deepEqual(checkIntegrity(d), []);
});

test('a created_at declared in fields is a typed date, not the template timestamp', () => {
  const withFields = SCENARIO.replace('  users: 2', '  users: 2\n  events: { total: 5, fields: { created_at: date, title: string } }');
  const a = generateWorld(scenario(withFields));
  const b = generateWorld(scenario(withFields.replace('title: string', 'title: string, extra: string')));
  // Typed values come from the fields:<entity> stream: the main entity stream is untouched.
  assert.deepEqual(a.entities.events.map((e) => e.created_at), b.entities.events.map((e) => e.created_at));
  assert.deepEqual(a.entities.orders, generateWorld(scenario()).entities.orders);
});
