// 500 combinaciones de filtros × orden × paginación contra un oráculo escrito
// aparte. Los tests de ejemplo comprueban lo que alguien pensó; esto comprueba
// lo que nadie pensó.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScenario } from '../../scripts/lib/scenario.mjs';
import { generateWorld } from '../../scripts/lib/world.mjs';
import { createEngine } from '../../scripts/lib/contract.mjs';
import { createRng } from '../../scripts/lib/prng.mjs';
import { oracleList } from './oracle.mjs';
import { tmpProject } from '../helpers.mjs';
import { join } from 'node:path';

const SCENARIO = `name: combos
seed: 1234
now: 2025-03-01T09:00:00Z
world:
  articles:
    total: 60
    distribution_field: status
    distribution: { draft: 20, published: 30, archived: 10 }
    fields:
      code: string
      title: string
      status: [draft, published, archived]
      score: number
endpoints:
  - path: /api/articles
    entity: articles
    filters: [status, code]
    sorts: { by: sort, order: order, fields: [score, code, id] }
    pagination: { param_limit: limit, param_offset: offset, default_limit: 7, max_limit: 12 }
    shape: envelope
    envelope: { items: data, total: total }
`;

const dir = tmpProject({ 'combos.yaml': SCENARIO });
const scenario = loadScenario(join(dir, 'combos.yaml'));
const dataset = generateWorld(scenario);
const ep = dataset.endpoints[0];
const rows = dataset.entities.articles;

/** Un techo para el número de peticiones: 500 combinaciones, ni una más. */
const COMBOS = 500;

function buildCombos() {
  const rng = createRng('combos-v1');
  const int = (n) => Math.floor(rng.next() * n);
  const pick = (list) => list[int(list.length)];
  const statuses = [null, 'draft', 'published', 'archived', 'no-existe'];
  const codes = [null, String(rows[0].code), String(rows[rows.length - 1].code), 'no-existe'];
  const sortFields = [null, 'score', 'code', 'id'];
  const orders = [null, 'asc', 'desc'];
  const limits = [null, '0', '1', '5', '12', '50'];
  const offsets = [null, '0', '1', '7', '59', '60', '500'];
  const combos = [];
  for (let i = 0; i < COMBOS; i++) {
    const q = new URLSearchParams();
    const status = pick(statuses);
    if (status !== null) q.set('status', status);
    const code = pick(codes);
    if (code !== null) q.set('code', code);
    const sort = pick(sortFields);
    if (sort !== null) q.set('sort', sort);
    const order = pick(orders);
    if (order !== null) q.set('order', order);
    const limit = pick(limits);
    if (limit !== null) q.set('limit', limit);
    const offset = pick(offsets);
    if (offset !== null) q.set('offset', offset);
    combos.push(q);
  }
  return combos;
}

const combos = buildCombos();
const engine = createEngine(dataset);
const get = (q) => engine.handle({ method: 'GET', pathname: '/api/articles', query: q });

test('combos: 500 combinaciones coinciden con el oráculo (items, total y cabecera)', () => {
  const failures = [];
  for (const q of combos) {
    const res = get(q);
    const expected = oracleList(rows, ep, q);
    const where = `?${q.toString()}`;
    if (res.status !== 200) { failures.push(`${where}: status ${res.status}`); continue; }
    const got = res.body.data;
    if (got.length !== expected.items.length) {
      failures.push(`${where}: ${got.length} items, el oráculo dice ${expected.items.length} (total ${expected.total}, limit ${expected.limit})`);
      continue;
    }
    if (got.length && JSON.stringify(got.map((r) => r.id)) !== JSON.stringify(expected.items.map((r) => r.id))) {
      failures.push(`${where}: ids [${got.map((r) => r.id).join(',')}] vs oráculo [${expected.items.map((r) => r.id).join(',')}]`);
      continue;
    }
    if (res.body.total !== expected.total) failures.push(`${where}: total ${res.body.total}, el oráculo dice ${expected.total}`);
    if (res.headers['x-total-count'] !== String(expected.total)) failures.push(`${where}: x-total-count ${res.headers['x-total-count']}, el oráculo dice ${expected.total}`);
  }
  assert.deepEqual(failures.slice(0, 12), [], `${failures.length} de ${combos.length} combinaciones no cuadran`);
});

test('combos: páginas consecutivas no se solapan y cubren el mundo sin huecos', () => {
  const failures = [];
  const pageSize = 7;
  for (const status of ['draft', 'published', 'archived']) {
    const total = rows.filter((r) => r.status === status).length;
    const seen = [];
    for (let offset = 0; offset < total; offset += pageSize) {
      const q = new URLSearchParams({ status, limit: String(pageSize), offset: String(offset) });
      const res = get(q);
      const ids = res.body.data.map((r) => r.id);
      if (ids.length === 0) { failures.push(`${status}@${offset}: página vacía con total ${total}`); break; }
      for (const id of ids) {
        if (seen.includes(id)) failures.push(`${status}: id ${id} repetido entre páginas`);
        seen.push(id);
      }
    }
    if (seen.length !== total) failures.push(`${status}: ${seen.length} filas entre todas las páginas, el mundo tiene ${total}`);
  }
  assert.deepEqual(failures.slice(0, 8), []);
});

test('combos: limit=0 no inventa filas ni rompe el total', () => {
  const res = get(new URLSearchParams({ limit: '0' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 0);
  assert.equal(res.body.total, rows.length);
});

test('combos: un sort fuera de `fields` es 400, no un orden silencioso por otra cosa', () => {
  // Documentado en references/scenario.md: a request time, a field outside
  // `fields` answers 400 (silencio aquí sería el bug).
  const res = get(new URLSearchParams({ sort: 'no-existe' }));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /is not allowed on \/api\/articles/);
});
