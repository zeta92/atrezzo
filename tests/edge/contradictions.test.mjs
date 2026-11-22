// Contradictory scenarios: each one has to fail with exit 3 and a message that
// names the field. An impossible scenario accepted in silence is worse than a
// missing mock: the world exists, and it lies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { cli, tmpProject } from '../helpers.mjs';

const run = (yaml) => {
  const dir = tmpProject({ 's.yaml': yaml });
  return cli(['world', join(dir, 's.yaml')], dir);
};

const cases = [
  {
    name: 'a distribution that does not add up to the total',
    yaml: `name: x\nseed: 1\nworld:\n  orders:\n    total: 10\n    distribution_field: status\n    distribution: { paid: 3, pending: 3 }\n    fields: { status: [paid, pending] }\nendpoints:\n  - path: /api/orders\n    entity: orders\n`,
    match: /distribution/
  },
  {
    name: 'more nulls than rows',
    yaml: `name: x\nseed: 1\nworld:\n  orders:\n    total: 3\n    nulls: { amount: 9 }\n    fields: { amount: number }\nendpoints:\n  - path: /api/orders\n    entity: orders\n`,
    match: /nulls/
  },
  {
    // A real cycle: each derive reads its `c_id` from the other entity, so neither can be built
    // first. Every key is valid on its own; only the cycle check can reject it.
    name: 'a circular derive between two entities (via a shared parent)',
    yaml: `name: x\nseed: 1\nworld:\n  c: { total: 2, fields: { name: string } }\n  a:\n    total: 2\n    ref: [b, c]\n    fields: { name: string }\n    derive: { c_id: { from: b, field: c_id } }\n  b:\n    total: 2\n    ref: [a, c]\n    fields: { name: string }\n    derive: { c_id: { from: a, field: c_id } }\nendpoints:\n  - path: /api/a\n    entity: a\n`,
    match: /world\.a\.derive\.c_id\.from.*"b" references "a".*cannot be built first/
  },
  {
    name: 'an embed of an entity that does not point at this one',
    yaml: `name: x\nseed: 1\nworld:\n  customers: 2\n  orders: { total: 4, ref: customers }\nendpoints:\n  - path: /api/orders\n    entity: orders\n    embed: [customers]\n`,
    match: /do(es)? not reference|does not reference/i
  },
  {
    name: 'a sorts.by that clashes with a pagination parameter',
    yaml: `name: x\nseed: 1\nworld:\n  orders: { total: 4, fields: { amount: number } }\nendpoints:\n  - path: /api/orders\n    entity: orders\n    pagination: { param_limit: limit, param_offset: offset }\n    sorts: { by: limit, order: order, fields: [amount] }\n`,
    match: /conflict/i
  },
  {
    name: 'an endpoint with a field that does not exist',
    yaml: `name: x\nseed: 1\nworld:\n  orders:\n    total: 2\n    fields: { amount: number }\nendpoints:\n  - path: /api/orders\n    entity: orders\n    filters: [no_such_field]\n`,
    match: /no_such_field|does not exist/
  },
  {
    name: 'a reference to an entity that is not in the world',
    yaml: `name: x\nseed: 1\nworld:\n  orders:\n    total: 2\n    ref: ghosts\n    fields: { amount: number }\nendpoints:\n  - path: /api/orders\n    entity: orders\n`,
    match: /ghosts/
  }
];

for (const c of cases) {
  test(`contradictions: ${c.name} ⇒ exit 3 naming the field`, () => {
    const r = run(c.yaml);
    assert.equal(r.code, 3, `expected 3, got ${r.code}\n${r.stdout}\n${r.stderr}`);
    const all = `${r.stdout}\n${r.stderr}`;
    assert.match(all, c.match);
  });
}

test('contradictions: seed_first on a field with values: is not one (it takes the first value)', () => {
  // Documented in references/scenario.md: seed_first reads the values: vocabulary, so this is a
  // way to pin a field, not a clash. Rejecting it would be the bug.
  const dir = tmpProject({ 's.yaml': `name: x\nseed: 1\nworld:\n  w:\n    total: 4\n    fields: { label: string }\n    values: { label: [first, second, third] }\n    seed_first: [label]\nendpoints:\n  - path: /api/w\n    entity: w\n` });
  const r = cli(['world', join(dir, 's.yaml')], dir);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  const world = JSON.parse(readFileSync(join(dir, 'atrezzo/.generated/x.json'), 'utf8'));
  assert.deepEqual(world.entities.w.map((row) => row.label), ['first', 'first', 'first', 'first']);
});
