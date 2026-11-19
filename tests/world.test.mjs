import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { generateWorld, checkIntegrity, scenarioHash } from '../scripts/lib/world.mjs';
import { AtrezzoError } from '../scripts/lib/errors.mjs';
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

test('conditional field: applies when condition matches and keeps default when false', () => {
  const base = SCENARIO.replace(
    '  users: 2',
    '  users: 2\n  boards: { total: 20, fields: { name: string, is_archived: boolean, max_permission: [2] } }',
  );
  const cond = SCENARIO.replace(
    '  users: 2',
    '  users: 2\n  boards: { total: 20, fields: { name: string, is_archived: boolean, max_permission: { default: [2], when: { is_archived: true }, value: [0] } } }',
  );
  const wBase = generateWorld(scenario(base));
  const wCond = generateWorld(scenario(cond));
  const archived = wCond.entities.boards.filter((b) => b.is_archived === true);
  const active = wCond.entities.boards.filter((b) => b.is_archived === false);
  assert.ok(archived.length > 0 && active.length > 0, 'both true and false rows exist');
  for (const row of archived) assert.equal(row.max_permission, 0);
  for (const row of active) assert.equal(row.max_permission, 2);
  // Other fields and other entities stay identical to the unconditional world.
  assert.deepEqual(wCond.entities.boards.map((b) => [b.name, b.is_archived]), wBase.entities.boards.map((b) => [b.name, b.is_archived]));
  assert.deepEqual(wCond.entities.orders, wBase.entities.orders);
});

test('conditional field: works with values_order, seed_first, multi-value lists, and nulls', () => {
  const yaml = SCENARIO.replace(
    '  users: 2',
    `  users: 2
  widgets:
    total: 6
    fields:
      is_archived: [false, true]
      tier: [basic, pro]
      max_permission: { default: [2], when: { is_archived: true }, value: [0, 1] }
      badge: { default: string, when: { is_archived: true, tier: pro }, value: [locked] }
    values_order: cycle`,
  );
  const w = generateWorld(scenario(yaml));
  for (const row of w.entities.widgets) {
    if (row.is_archived) {
      assert.ok([0, 1].includes(row.max_permission));
      if (row.tier === 'pro') assert.equal(row.badge, 'locked');
      else assert.notEqual(row.badge, 'locked');
    } else {
      assert.equal(row.max_permission, 2);
      assert.notEqual(row.badge, 'locked');
    }
  }
  // seed_first fixes is_archived to false so the conditional value is never applied.
  const seeded = generateWorld(scenario(yaml.replace('values_order: cycle', 'seed_first: [is_archived]')));
  for (const row of seeded.entities.widgets) {
    assert.equal(row.is_archived, false);
    assert.equal(row.max_permission, 2);
  }
  // nulls on condition field + null conditional value: when matches null when nulls is declared.
  const nullable = generateWorld(scenario(SCENARIO.replace(
    '  users: 2',
    '  users: 2\n  items:\n    total: 8\n    fields:\n      is_archived: boolean\n      note: { default: string, when: { is_archived: null }, value: [null] }\n    nulls: { is_archived: 3 }',
  )));
  assert.equal(nullable.entities.items.filter((r) => r.is_archived === null).length, 3);
  for (const row of nullable.entities.items) {
    if (row.is_archived === null) assert.equal(row.note, null);
    else assert.equal(typeof row.note, 'string');
  }
});

test('conditional field: determinism (same seed = same hash and rows) and untouched hash without the key', () => {
  const plain = scenario(SCENARIO);
  assert.equal(scenarioHash(plain), scenarioHash(scenario(SCENARIO)));

  const withCond = SCENARIO.replace(
    '  users: 2',
    '  users: 2\n  boards: { total: 10, fields: { is_archived: boolean, max_permission: { default: [2], when: { is_archived: true }, value: [0, 1] } } }',
  );
  const s1 = scenario(withCond);
  const s2 = scenario(withCond);
  const w1 = generateWorld(s1);
  const w2 = generateWorld(s2);
  assert.equal(w1.hash, w2.hash);
  assert.equal(datasetJson(w1), datasetJson(w2));

  const changed = scenario(withCond.replace('value: [0, 1]', 'value: [0]'));
  assert.notEqual(scenarioHash(s1), scenarioHash(changed));
});

test('conditional field: validation errors', () => {
  const bad = (fieldsYaml) => {
    const text = SCENARIO.replace('  users: 2', `  users: 2\n  boards:\n    total: 5\n    fields:\n${fieldsYaml}`);
    try {
      scenario(text);
    } catch (e) {
      assert.ok(e instanceof AtrezzoError);
      assert.equal(e.exitCode, 3);
      return e.issues.join('\n');
    }
    assert.fail('expected validation error');
  };

  // Unknown field in when
  assert.match(
    bad('      is_archived: boolean\n      max_permission: { default: [2], when: { missing_flag: true }, value: [0] }'),
    /boards\.fields\.max_permission\.when\.missing_flag": field "missing_flag" does not exist in "boards"/,
  );
  // Impossible when: boolean field compared to non-boolean
  assert.match(
    bad('      is_archived: boolean\n      max_permission: { default: [2], when: { is_archived: "true" }, value: [0] }'),
    /boards\.fields\.max_permission\.when\.is_archived": value "true" is impossible for field "is_archived" \(boolean\)/,
  );
  assert.match(
    bad('      is_archived: boolean\n      max_permission: { default: [2], when: { is_archived: 1 }, value: [0] }'),
    /boards\.fields\.max_permission\.when\.is_archived": value 1 is impossible for field "is_archived" \(boolean\)/,
  );
  assert.match(
    bad('      is_archived: boolean\n      max_permission: { default: [2], when: { is_archived: null }, value: [0] }'),
    /boards\.fields\.max_permission\.when\.is_archived": value null is impossible for field "is_archived" \(boolean\)/,
  );
  // Impossible when: enum value outside enum
  assert.match(
    bad('      kind: [open, closed]\n      max_permission: { default: [2], when: { kind: bogus }, value: [0] }'),
    /boards\.fields\.max_permission\.when\.kind": value "bogus" is impossible for field "kind"/,
  );
  // Impossible when: distribution field with undeclared status
  assert.throws(
    () => scenario(SCENARIO.replace('  users: 2', '  users: 2\n  boards: { total: 4, distribution: { open: 2, closed: 2 }, fields: { max_permission: { default: [2], when: { status: archived }, value: [0] } } }')),
    (e) => e instanceof AtrezzoError && /when\.status": value "archived" is impossible/.test(e.issues.join('\n')),
  );
  // Incompatible value for default type
  assert.match(
    bad('      is_archived: boolean\n      max_permission: { default: [2], when: { is_archived: true }, value: ["none"] }'),
    /boards\.fields\.max_permission\.value": value "none" is incompatible with type \[2\]/,
  );
  assert.match(
    bad('      is_archived: boolean\n      flag: { default: boolean, when: { is_archived: true }, value: [1] }'),
    /boards\.fields\.flag\.value": value 1 is incompatible with type boolean/,
  );
  assert.match(
    bad('      is_archived: boolean\n      count: { default: integer, when: { is_archived: true }, value: [1.5] }'),
    /boards\.fields\.count\.value": value 1\.5 is incompatible with type integer/,
  );
  // Self-reference and cycles (2-node and 3-node)
  assert.match(
    bad('      max_permission: { default: [2], when: { max_permission: 2 }, value: [0] }'),
    /boards\.fields\.max_permission\.when\.max_permission": field "max_permission" cannot reference itself/,
  );
  assert.match(
    bad('      a: { default: [1, 2], when: { b: 1 }, value: [2] }\n      b: { default: [1, 2], when: { a: 2 }, value: [1] }'),
    /cycle in conditional fields/,
  );
  assert.match(
    bad('      a: { default: [1, 2], when: { b: 1 }, value: [2] }\n      b: { default: [1, 2], when: { c: 2 }, value: [1] }\n      c: { default: [1, 2], when: { a: 1 }, value: [2] }'),
    /cycle in conditional fields: a → b → c → a/,
  );
  // Out-of-range id and foreign key bounds
  assert.match(
    bad('      flag: { default: boolean, when: { id: 6 }, value: true }'),
    /boards\.fields\.flag\.when\.id": value 6 is impossible for field "id" \(integer 1\.\.5\)/,
  );
  assert.match(
    bad('      flag: { default: boolean, when: { id: 0 }, value: true }'),
    /boards\.fields\.flag\.when\.id": value 0 is impossible for field "id" \(integer 1\.\.5\)/,
  );
  assert.throws(
    () => scenario(SCENARIO.replace('  users: 2', '  users: 2\n  boards: { total: 4, ref: customers, fields: { flag: { default: boolean, when: { customer_id: 999 }, value: true } } }')),
    (e) => e instanceof AtrezzoError && /when\.customer_id": value 999 is impossible for field "customer_id" \(integer 1\.\.3 \(customers\)\)/.test(e.issues.join('\n')),
  );
  assert.throws(
    () => scenario(SCENARIO.replace('  users: 2', '  users: 2\n  boards: { total: 4, ref: customers, fields: { flag: { default: boolean, when: { customer_id: [1, 4] }, value: true } } }')),
    (e) => e instanceof AtrezzoError && /when\.customer_id": value 4 is impossible for field "customer_id" \(integer 1\.\.3 \(customers\)\)/.test(e.issues.join('\n')),
  );
  assert.throws(
    () => scenario(SCENARIO.replace('  users: 2', '  users: 2\n  boards: { total: 4, ref: customers, fields: { flag: { default: boolean, when: { customer_id: null }, value: true } } }')),
    (e) => e instanceof AtrezzoError && /when\.customer_id": value null is impossible for field "customer_id" \(integer 1\.\.3 \(customers\)\)/.test(e.issues.join('\n')),
  );
  // Missing keys / unknown keys / empty maps
  assert.match(
    bad('      is_archived: boolean\n      max_permission: { default: [2], when: {}, value: [0] }'),
    /boards\.fields\.max_permission\.when": required; must be a non-empty map/,
  );
  assert.match(
    bad('      is_archived: boolean\n      max_permission: { default: [2], when: { is_archived: true }, value: [0], extra: 1 }'),
    /boards\.fields\.max_permission\.extra": unknown field/,
  );
});

test('conditional field: in-bounds id, foreign key, and acyclic multi-step chain work deterministically', () => {
  const yaml = SCENARIO.replace(
    '  users: 2',
    `  users: 2
  boards:
    total: 4
    ref: customers
    fields:
      tier: [basic, pro]
      a: { default: [0], when: { id: [1, 4], customer_id: 3 }, value: [10] }
      b: { default: [0], when: { a: 10 }, value: [20] }
      c: { default: [0], when: { a: 10, b: 20, tier: pro }, value: [30] }
      d: { default: [0], when: { customer_id: null }, value: [99] }
    nulls: { customer_id: 1 }`,
  );
  const w = generateWorld(scenario(yaml));
  for (const row of w.entities.boards) {
    if (row.customer_id === null) assert.equal(row.d, 99);
    else assert.equal(row.d, 0);
    if ((row.id === 1 || row.id === 4) && row.customer_id === 3) {
      assert.equal(row.a, 10);
      assert.equal(row.b, 20);
      assert.equal(row.c, row.tier === 'pro' ? 30 : 0);
    } else {
      assert.equal(row.a, 0);
      assert.equal(row.b, 0);
      assert.equal(row.c, 0);
    }
  }
});
