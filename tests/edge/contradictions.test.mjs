// Escenarios contradictorios: cada uno tiene que fallar con exit 3 y un mensaje
// que nombre el campo. Un escenario imposible aceptado en silencio es peor que
// un mock que falta: el mundo existe y miente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cli, tmpProject } from '../helpers.mjs';

const run = (yaml) => {
  const dir = tmpProject({ 's.yaml': yaml });
  return cli(['world', join(dir, 's.yaml')], dir);
};

const cases = [
  {
    name: 'una distribución que no suma el total',
    yaml: `name: x\nseed: 1\nworld:\n  orders:\n    total: 10\n    distribution_field: status\n    distribution: { paid: 3, pending: 3 }\n    fields: { status: [paid, pending] }\nendpoints:\n  - path: /api/orders\n    entity: orders\n`,
    match: /distribution/
  },
  {
    name: 'más nulos que filas',
    yaml: `name: x\nseed: 1\nworld:\n  orders:\n    total: 3\n    nulls: { amount: 9 }\n    fields: { amount: number }\nendpoints:\n  - path: /api/orders\n    entity: orders\n`,
    match: /nulls/
  },
  {
    name: 'un derive circular entre dos entidades',
    yaml: `name: x\nseed: 1\nworld:\n  a:\n    total: 2\n    ref: b\n    fields: { name: string }\n    derive: { parent: from_b }\n  b:\n    total: 2\n    ref: a\n    fields: { name: string }\n    derive: { parent: from_a }\nendpoints:\n  - path: /api/a\n    entity: a\n`,
    match: /derive|ref/i
  },
  {
    name: 'un embed de quien no apunta a esta entidad',
    yaml: `name: x\nseed: 1\nworld:\n  customers: 2\n  orders: { total: 4, ref: customers }\nendpoints:\n  - path: /api/orders\n    entity: orders\n    embed: [customers]\n`,
    match: /do(es)? not reference|does not reference/i
  },
  {
    name: 'un sorts.by que choca con un parámetro de paginación',
    yaml: `name: x\nseed: 1\nworld:\n  orders: { total: 4, fields: { amount: number } }\nendpoints:\n  - path: /api/orders\n    entity: orders\n    pagination: { param_limit: limit, param_offset: offset }\n    sorts: { by: limit, order: order, fields: [amount] }\n`,
    match: /conflict/i
  },
  {
    name: 'un endpoint con un campo que no existe',
    yaml: `name: x\nseed: 1\nworld:\n  orders:\n    total: 2\n    fields: { amount: number }\nendpoints:\n  - path: /api/orders\n    entity: orders\n    filters: [no_existe]\n`,
    match: /no_existe|does not exist/
  },
  {
    name: 'una referencia a una entidad que no está en el mundo',
    yaml: `name: x\nseed: 1\nworld:\n  orders:\n    total: 2\n    ref: fantasmas\n    fields: { amount: number }\nendpoints:\n  - path: /api/orders\n    entity: orders\n`,
    match: /fantasmas/
  }
];

for (const c of cases) {
  test(`contradicciones: ${c.name} ⇒ exit 3 nombrando el campo`, () => {
    const r = run(c.yaml);
    assert.equal(r.code, 3, `esperaba 3, salió ${r.code}\n${r.stdout}\n${r.stderr}`);
    const all = `${r.stdout}\n${r.stderr}`;
    assert.match(all, c.match);
  });
}
