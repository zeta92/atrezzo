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

// ---------- empty strings (`fields.<f>: { type: string, empty }`) ----------

const withEmpty = (fieldsYaml, total = 200) => SCENARIO.replace(
  '  users: 2',
  `  users: 2\n  notes:\n    total: ${total}\n    fields:\n${fieldsYaml}`,
);

test('empty strings: a proportion empties about that share of the rows', () => {
  const d = generateWorld(scenario(withEmpty('      title: string\n      description: { type: string, empty: 0.4 }')));
  const rows = d.entities.notes;
  const empty = rows.filter((r) => r.description === '').length;
  assert.ok(Math.abs(empty / rows.length - 0.4) <= 0.05, `${empty} empty of ${rows.length}`);
  for (const r of rows) {
    assert.equal(typeof r.description, 'string');
    assert.notEqual(r.title, '');
  }
  // empty: 0 never empties anything.
  const none = generateWorld(scenario(withEmpty('      description: { type: string, empty: 0 }')));
  assert.ok(none.entities.notes.every((r) => r.description !== ''));
});

test('empty strings: empty: true empties every row; empty: 1 too', () => {
  for (const v of ['true', '1']) {
    const d = generateWorld(scenario(withEmpty(`      description: { type: string, empty: ${v} }`, 7)));
    assert.deepEqual(d.entities.notes.map((r) => r.description), Array(7).fill(''));
  }
});

test('empty strings: deterministic, own stream, other fields and hashes untouched', () => {
  const text = withEmpty('      title: string\n      description: { type: string, empty: 0.4 }');
  const a = generateWorld(scenario(text));
  const b = generateWorld(scenario(text));
  assert.equal(a.hash, b.hash);
  assert.equal(datasetJson(a), datasetJson(b));

  // Same rows without `empty`: every other field keeps its value, and the non-empty descriptions too.
  const plainText = withEmpty('      title: string\n      description: string');
  const plain = generateWorld(scenario(plainText));
  a.entities.notes.forEach((r, i) => {
    const p = plain.entities.notes[i];
    assert.equal(r.title, p.title);
    if (r.description !== '') assert.equal(r.description, p.description);
  });
  for (const name of ['customers', 'orders', 'users']) assert.deepEqual(a.entities[name], plain.entities[name]);

  // A scenario that does not use it keeps its normalized form (and its hash): `{ type: string }` = `string`.
  assert.deepEqual(scenario(withEmpty('      title: string\n      description: { type: string }')), scenario(plainText));
  assert.notEqual(scenarioHash(scenario(text)), scenarioHash(scenario(plainText)));

  // Another seed picks other rows.
  const other = generateWorld(scenario(text.replace('seed: 7712', 'seed: 1')));
  assert.notDeepEqual(
    a.entities.notes.map((r) => r.description === ''),
    other.entities.notes.map((r) => r.description === ''),
  );
});

test('empty strings: compatible with nulls (a row is null or empty, never both)', () => {
  const text = withEmpty('      description: { type: string, empty: 0.5 }', 10).replace(
    '    fields:\n      description',
    '    nulls: { description: 3 }\n    fields:\n      description',
  );
  const rows = generateWorld(scenario(text)).entities.notes;
  assert.equal(rows.filter((r) => r.description === null).length, 3);
  assert.equal(rows.filter((r) => r.description === '').length, 5);
  // The nulls land on the same rows as without `empty`.
  const plainRows = generateWorld(scenario(text.replace('{ type: string, empty: 0.5 }', 'string'))).entities.notes;
  assert.deepEqual(rows.map((r) => r.description === null), plainRows.map((r) => r.description === null));
  // empty: true with nulls: every row that is not null is empty.
  const all = generateWorld(scenario(text.replace('empty: 0.5', 'empty: true'))).entities.notes;
  assert.equal(all.filter((r) => r.description === null).length, 3);
  assert.equal(all.filter((r) => r.description === '').length, 7);
});

test('empty strings: conditional fields can match the empty value', () => {
  const text = withEmpty('      description: { type: string, empty: 0.5 }\n      has_description: { default: [true], when: { description: "" }, value: [false] }', 20);
  for (const r of generateWorld(scenario(text)).entities.notes) assert.equal(r.has_description, r.description !== '');
});

test('empty strings: preserved when the same conditional field has a matching override', () => {
  // All rows match `when: { locked: true }` and assign "texto": `empty` still keeps its share.
  const partial = withEmpty(
    '      locked: [true]\n      note: { default: string, when: { locked: true }, value: "texto", empty: 0.4 }',
    10,
  );
  const partialRows = generateWorld(scenario(partial)).entities.notes;
  assert.equal(partialRows.filter((r) => r.note === '').length, 4);
  assert.equal(partialRows.filter((r) => r.note === 'texto').length, 6);

  // `empty: true` with an always-matching conditional leaves every row empty.
  const all = withEmpty(
    '      locked: [true]\n      note: { default: string, when: { locked: true }, value: "texto", empty: true }',
    10,
  );
  assert.deepEqual(generateWorld(scenario(all)).entities.notes.map((r) => r.note), Array(10).fill(''));

  // With `nulls` + `empty` + conditional on the same field, nulls and empty rows are both preserved.
  const withNulls = withEmpty(
    '      locked: [true]\n      note: { default: string, when: { locked: true }, value: "texto", empty: 0.5 }',
    10,
  ).replace('    fields:\n', '    nulls: { note: 3 }\n    fields:\n');
  const mixedRows = generateWorld(scenario(withNulls)).entities.notes;
  assert.equal(mixedRows.filter((r) => r.note === null).length, 3);
  assert.equal(mixedRows.filter((r) => r.note === '').length, 5);
  assert.equal(mixedRows.filter((r) => r.note === 'texto').length, 2);

  // Downstream conditional fields observe the preserved "" rather than the skipped override.
  const chained = withEmpty(
    '      locked: [true]\n      note: { default: string, when: { locked: true }, value: "texto", empty: 0.4 }\n      is_empty_note: { default: [false], when: { note: "" }, value: [true] }',
    10,
  );
  for (const r of generateWorld(scenario(chained)).entities.notes) {
    assert.equal(r.is_empty_note, r.note === '');
  }
});

test('empty strings: validation errors', () => {
  const bad = (fieldsYaml) => {
    try {
      scenario(withEmpty(fieldsYaml, 5));
    } catch (e) {
      assert.ok(e instanceof AtrezzoError);
      assert.equal(e.exitCode, 3);
      return e.issues.join('\n');
    }
    assert.fail('expected validation error');
  };
  assert.match(bad('      count: { type: integer, empty: 0.2 }'), /notes\.fields\.count\.empty": only string fields can be empty \(this one is integer\)/);
  assert.match(bad('      kind: { type: [a, b], empty: 0.2 }'), /notes\.fields\.kind\.empty": only string fields can be empty/);
  assert.match(bad('      link: { type: url, empty: true }'), /notes\.fields\.link\.empty": only string fields can be empty \(this one is url\)/);
  assert.match(bad('      description: { type: string, empty: 1.5 }'), /notes\.fields\.description\.empty": must be a number between 0 and 1 or true/);
  assert.match(bad('      description: { type: string, empty: -0.1 }'), /notes\.fields\.description\.empty": must be a number between 0 and 1 or true/);
  assert.match(bad('      description: { type: string, empty: false }'), /notes\.fields\.description\.empty": must be a number between 0 and 1 or true/);
  assert.match(bad('      description: { type: string, empty: "0.4" }'), /notes\.fields\.description\.empty": must be a number between 0 and 1 or true/);
  assert.match(bad('      description: { empty: 0.4 }'), /notes\.fields\.description\.type": required/);
  assert.match(bad('      description: { type: string, empty: 0.4, nope: 1 }'), /notes\.fields\.description\.nope/);
  assert.match(bad('      flag: boolean\n      label: { default: [a, b], when: { flag: true }, value: [a], empty: 0.3 }'), /notes\.fields\.label\.empty": only string fields can be empty/);
});

// ---------- explicit row ids (`world.<entity>.ids`) ----------

test('explicit ids: generated rows use declared ids while keeping all non-id fields identical', () => {
  const base = generateWorld(scenario());
  const withIds = generateWorld(scenario(
    SCENARIO.replace('  customers: 3', '  customers: { total: 3, ids: ["cust-a", "cust-b", "cust-c"] }'),
  ));

  assert.deepEqual(withIds.entities.customers.map((c) => c.id), ['cust-a', 'cust-b', 'cust-c']);
  assert.deepEqual(
    withIds.entities.customers.map(({ id: _id, ...rest }) => rest),
    base.entities.customers.map(({ id: _id, ...rest }) => rest),
  );
});

test('explicit ids: child foreign keys only reference the declared parent ids (#43)', () => {
  const d = generateWorld(scenario(
    SCENARIO
      .replace('  customers: 3', '  customers: { total: 2, ids: ["cust-a", "cust-b"] }')
      .replace('  users: 2', '  users: 2\n  invoices: { total: 6, ref: customers }'),
  ));
  const parentIds = ['cust-a', 'cust-b'];

  assert.deepEqual(d.entities.customers.map((c) => c.id), parentIds);
  for (const child of ['orders', 'invoices']) {
    assert.ok(d.entities[child].length > 0, `${child} has no rows`);
    for (const row of d.entities[child]) {
      assert.ok(parentIds.includes(row.customer_id), `${child}.customer_id ${row.customer_id} is not an explicit customer id`);
    }
  }
});

test('explicit ids: positive integer ids replace customer ids and orders reference every one (#43)', () => {
  const expectedIds = [900001, 900010, 900100];
  const d = generateWorld(scenario(
    SCENARIO.replace('  customers: 3', '  customers: { total: 3, ids: [900001, 900010, 900100] }'),
  ));

  assert.deepEqual(d.entities.customers.map((c) => c.id), expectedIds);
  assert.ok(d.entities.orders.length > 0, 'orders has no rows');

  const idSet = new Set(expectedIds);
  const referenced = new Set();
  for (const order of d.entities.orders) {
    assert.ok(idSet.has(order.customer_id), `order ${order.id} customer_id ${order.customer_id} is not an explicit customer id`);
    referenced.add(order.customer_id);
  }
  for (const id of expectedIds) {
    assert.ok(referenced.has(id), `customer ${id} has no orders`);
  }
});

test('explicit ids: no child order predates its explicitly identified parent (#43)', () => {
  const parentCreated = '2025-02-28T23:59:00Z';
  const now = '2025-03-01T09:00:00Z';
  const d = generateWorld(scenario(
    SCENARIO.replace(
      '  customers: 3',
      `  customers:\n    total: 2\n    ids: ["cust-a", "cust-b"]\n    fields: { created_at: ["${parentCreated}"] }`,
    ),
  ));
  const born = new Map(d.entities.customers.map((c) => [c.id, Date.parse(c.created_at)]));

  assert.ok(SCENARIO.includes(`now: ${now}`), 'base scenario "now" changed');
  for (const [id, ms] of born) assert.equal(ms, Date.parse(parentCreated), `customer ${id} created_at is not the declared value`);
  assert.ok(d.entities.orders.length > 0, 'orders has no rows');
  for (const o of d.entities.orders) {
    assert.ok(born.has(o.customer_id), `order ${o.id} customer_id ${o.customer_id} is not an explicit customer id`);
    const ms = Date.parse(o.created_at);
    assert.ok(ms >= born.get(o.customer_id), `order ${o.id} created_at ${o.created_at} predates customer ${o.customer_id}`);
    assert.ok(ms <= Date.parse(now), `order ${o.id} created_at ${o.created_at} is after now`);
  }
});

test('explicit ids: auth.user.id may reference a declared string id (#43)', () => {
  const s = scenario(
    SCENARIO
      .replace('  customers: 3', '  customers: { total: 3, ids: ["cust-a", "cust-b", "cust-c"] }')
      .replace('world:\n', 'auth: { user: { entity: customers, id: "cust-a" } }\nworld:\n'),
  );

  assert.equal(s.auth.user.id, 'cust-a', 'normalized auth.user.id must be the explicit string id');
});

test('explicit ids: a conditional field may match on a declared string id (#43)', () => {
  const d = generateWorld(scenario(
    SCENARIO.replace(
      '  customers: 3',
      '  customers: { total: 3, ids: ["cust-a", "cust-b", "cust-c"], fields: { flag: { default: [false], when: { id: cust-a }, value: true } } }',
    ),
  ));

  const rows = d.entities.customers;
  assert.deepEqual(rows.map((c) => c.id), ['cust-a', 'cust-b', 'cust-c']);
  const target = rows.find((c) => c.id === 'cust-a');
  assert.ok(target, 'row with id "cust-a" must exist');
  assert.equal(target.flag, true, 'row "cust-a" must have flag true');
});

test('explicit ids: a foreign-key conditional matches the target entity declared ids (#43)', () => {
  const d = generateWorld(scenario(
    SCENARIO
      .replace('  customers: 3', '  customers: { total: 3, ids: ["cust-a", "cust-b", "cust-c"] }')
      .replace(
        '  users: 2',
        '  users: 2\n  invoices: { total: 6, ref: customers, fields: { flag: { default: [false], when: { customer_id: cust-a }, value: true } } }',
      ),
  ));

  const invoices = d.entities.invoices;
  assert.ok(invoices.some((i) => i.customer_id === 'cust-a'), 'at least one invoice must reference "cust-a"');
  for (const i of invoices) {
    assert.equal(i.flag, i.customer_id === 'cust-a', `invoice ${i.id} (customer_id ${i.customer_id}) has flag ${i.flag}`);
  }
});

test('explicit ids: normalization rejects duplicate declared ids (#43)', () => {
  const yaml = `name: dup-ids
seed: 1
world:
  customers: { total: 2, ids: ["cust-a", "cust-a"] }
endpoints:
  - path: /api/customers
    entity: customers
`;

  assert.throws(
    () => normalizeScenario(parseYaml(yaml, 't.yaml'), 't.yaml'),
    (e) => e instanceof AtrezzoError
      && e.exitCode === 3
      && e.issues.some((issue) => /duplicate id/i.test(issue)),
  );
});

test('explicit ids: normalization rejects malformed ids arrays (#43)', () => {
  const normalizeWithIds = (total, ids) => normalizeScenario({
    name: 'malformed-ids',
    seed: 1,
    world: {
      customers: { total, ids },
    },
    endpoints: [
      { path: '/api/customers', entity: 'customers' },
    ],
  }, 't.yaml');

  assert.throws(
    () => normalizeWithIds(2, ['cust-a']),
    (e) => e instanceof AtrezzoError
      && e.exitCode === 3
      && e.issues.some((issue) => /length \(1\) does not match total \(2\)/i.test(issue)),
  );

  assert.throws(
    () => normalizeWithIds(2, ['cust-a', 2]),
    (e) => e instanceof AtrezzoError
      && e.exitCode === 3
      && e.issues.some((issue) => /mixed id types/i.test(issue)),
  );

  assert.throws(
    () => normalizeWithIds(1, ['bad/id']),
    (e) => e instanceof AtrezzoError
      && e.exitCode === 3
      && e.issues.some((issue) => /invalid string id "bad\/id"/i.test(issue)),
  );

  assert.throws(
    () => normalizeWithIds(1, ['café']),
    (e) => e instanceof AtrezzoError
      && e.exitCode === 3
      && e.issues.some((issue) => /invalid string id/i.test(issue)),
  );

  assert.throws(
    () => normalizeWithIds(1, ['x|y']),
    (e) => e instanceof AtrezzoError
      && e.exitCode === 3
      && e.issues.some((issue) => /invalid string id/i.test(issue)),
  );

  assert.throws(
    () => normalizeWithIds(1, ['a%2Fb']),
    (e) => e instanceof AtrezzoError
      && e.exitCode === 3
      && e.issues.some((issue) => /invalid string id/i.test(issue)),
  );

  assert.throws(
    () => normalizeWithIds(1, ['a'.repeat(201)]),
    (e) => e instanceof AtrezzoError
      && e.exitCode === 3
      && e.issues.some((issue) => /invalid string id/i.test(issue) && /maximum 200 characters/i.test(issue)),
  );

  assert.throws(
    () => normalizeWithIds(1, [0]),
    (e) => e instanceof AtrezzoError
      && e.exitCode === 3
      && e.issues.some((issue) => /invalid numeric id 0/i.test(issue)),
  );
});
