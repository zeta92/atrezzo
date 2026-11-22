// doctor: a path parameter that binds to a field with a single value cannot select one row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doctor } from '../scripts/lib/doctor.mjs';
import { tmpProject } from './helpers.mjs';

const project = (scenario) => tmpProject({
  'atrezzo.config.json': JSON.stringify({ runtime: 'msw' }),
  'atrezzo/scenarios/s.yaml': scenario
});

test('doctor: a path parameter bound to a single-valued field warns that it cannot select a row', () => {
  const dir = project(`name: slugs
seed: 1
world:
  articles:
    total: 23
    fields: { slug: [how-to-train-your-dragon], title: string }
endpoints:
  - path: /api/articles/:slug
    entity: articles
`);
  const { checks } = doctor(dir);
  const w = checks.find((c) => /binds ":slug" to "slug" with a single value across 23 rows/.test(c.label));
  assert.ok(w, `warning present in: ${checks.map((c) => c.label).join(' | ')}`);
  assert.equal(w.level, 'warn');
  assert.match(w.detail, /values:/);
});

test('doctor: a field with distinct values is not a warning', () => {
  const dir = project(`name: slugs-distintos
seed: 1
world:
  articles:
    total: 23
    fields: { slug: uuid, title: string }
endpoints:
  - path: /api/articles/:slug
    entity: articles
`);
  const { checks } = doctor(dir);
  assert.ok(!checks.some((c) => /single value across/.test(c.label)), 'no false positive with uuid');
});

test('doctor: a parameter mapped to no field is ignored by this check', () => {
  const dir = project(`name: suelto
seed: 1
world:
  articles:
    total: 5
    fields: { slug: [solo], title: string }
endpoints:
  - path: /api/articles/any/:id
    entity: articles
    filters: { ":id": null }
`);
  const { checks } = doctor(dir);
  assert.ok(!checks.some((c) => /single value across/.test(c.label)));
});
