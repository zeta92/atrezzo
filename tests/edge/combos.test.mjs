// 500 combinations of filters × order × pagination against an oracle written
// separately. Example tests check what someone thought of; this checks what
// nobody thought of.
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
      code: [alpha, beta, gamma, delta]
      title: string
      status: [draft, published, archived]
      score: number
      hidden: boolean
      featured: boolean
    nulls: { score: 6, code: 6 }
endpoints:
  - path: /api/articles
    entity: articles
    filters: [status, code]
    sorts: { by: sort, order: order, fields: [score, code, id] }
    scopes:
      hidden: { field: hidden }
      featured: { field: featured, default: include, when_true: only, when_false: only }
    pagination: { param_limit: limit, param_offset: offset, default_limit: 7, max_limit: 12 }
    shape: envelope
    envelope: { items: data, total: total, page: page, per_page: per_page, total_pages: total_pages }
  - path: /api/article-ids
    entity: articles
    filters: [status, code]
    sorts: { by: sort, order: order, fields: [score, code, id] }
    pluck: id
    pagination: { param_limit: size, param_page: page, default_limit: 5, max_limit: 12 }
    shape: envelope
    envelope: { items: ids, total: total, page: page, total_pages: total_pages }
`;

const dir = tmpProject({ 'combos.yaml': SCENARIO });
const scenario = loadScenario(join(dir, 'combos.yaml'));
const dataset = generateWorld(scenario);
const rows = dataset.entities.articles;
const endpointAt = (path) => dataset.endpoints.find((e) => e.path === path);

/** A ceiling on the number of requests: 500 combinations, not one more. */
const COMBOS = 500;

/**
 * Weighted choices: most queries must return two rows or more, or the order and the
 * slicing are compared on empty lists. Narrow filters (an unknown value, nulls only)
 * and offsets past the end stay in, but rare.
 */
const FILTERS = {
  status: [[null, 5], ['draft', 2], ['published', 3], ['archived', 1], ['draft,archived', 1.5], ['no-such-status', 0.2]],
  code: [[null, 6], ['alpha', 1], ['beta', 1], ['gamma,delta', 1.5], ['alpha,null', 1], ['null', 0.3], ['no-such-code', 0.2]],
  sort: [[null, 1], ['score', 1], ['code', 1], ['id', 1]],
  order: [[null, 1], ['asc', 1], ['desc', 1]],
};
const PATHS = {
  // Offset pagination, two scopes and every envelope key.
  '/api/articles': {
    hidden: [[null, 3], ['true', 2], ['false', 1]],
    featured: [[null, 4], ['true', 1], ['false', 1]],
    limit: [[null, 3], ['2', 2], ['5', 3], ['12', 2], ['50', 1], ['1', 0.3], ['0', 0.2]],
    offset: [[null, 4], ['0', 2], ['1', 2], ['3', 2], ['7', 1], ['59', 0.15], ['500', 0.15]],
  },
  // Page-number pagination and `pluck`.
  '/api/article-ids': {
    size: [[null, 3], ['3', 2], ['4', 2], ['12', 1], ['50', 1], ['0', 0.2]],
    page: [[null, 3], ['1', 3], ['2', 3], ['3', 1], ['40', 0.2]],
  },
};
/** Share of the combinations sent to each endpoint. */
const PATH_WEIGHTS = [['/api/articles', 7], ['/api/article-ids', 3]];

function buildCombos() {
  const rng = createRng('combos-v3');
  const pick = (choices) => {
    const sum = choices.reduce((a, [, w]) => a + w, 0);
    let r = rng.next() * sum;
    for (const [v, w] of choices) { r -= w; if (r < 0) return v; }
    return choices.at(-1)[0];
  };
  const combos = [];
  for (let i = 0; i < COMBOS; i++) {
    const path = pick(PATH_WEIGHTS);
    const q = new URLSearchParams();
    for (const [key, choices] of Object.entries({ ...FILTERS, ...PATHS[path] })) {
      const v = pick(choices);
      if (v !== null) q.set(key, v);
    }
    combos.push({ path, q });
  }
  return combos;
}

const combos = buildCombos();
const engine = createEngine(dataset);
const get = (q, pathname = '/api/articles') => engine.handle({ method: 'GET', pathname, query: q });
/** The list in a response, whatever the endpoint's envelope calls it. */
const itemsOf = (path, body) => (path === '/api/articles' ? body?.data : body?.ids) ?? [];
/** What the comparison sees of a list: ids of rows, or the plucked values themselves. */
const keysOf = (path, list) => (path === '/api/articles' ? list.map((r) => r.id) : list);

test('combos: the generator is useful (most combinations return 2+ rows, and the lists differ)', () => {
  const lists = combos.map(({ path, q }) => keysOf(path, itemsOf(path, get(q, path).body)));
  const multi = lists.filter((l) => l.length >= 2).length;
  const distinct = new Set(lists.filter((l) => l.length >= 2).map((l) => JSON.stringify(l))).size;
  const share = (pred) => combos.filter(pred).length;
  // If this fails, the 500 comparisons below are mostly [] against [] and the test is worthless.
  assert.ok(multi / combos.length >= 0.6, `only ${multi} of ${combos.length} combinations return 2+ rows`);
  assert.ok(distinct >= 20, `only ${distinct} distinct lists of 2+ rows`);
  // Every dimension is really drawn, not just declared.
  for (const [what, n] of [
    ['scopes', share(({ q }) => q.has('hidden') || q.has('featured'))],
    ['page numbers', share(({ q }) => q.has('page'))],
    ['pluck', share(({ path }) => path === '/api/article-ids')],
    ['a,b lists', share(({ q }) => [...q.values()].some((v) => v.includes(',')))],
    ['null filters', share(({ q }) => (q.get('code') ?? '').split(',').includes('null'))],
  ]) assert.ok(n >= 20, `${what} drawn ${n} times`);
});

test('combos: 500 combinations match the oracle (items, total, envelope and header)', () => {
  const failures = [];
  for (const { path, q } of combos) {
    const ep = endpointAt(path);
    const res = get(q, path);
    const expected = oracleList(rows, ep, q);
    const where = `${path}?${q.toString()}`;
    if (res.status !== 200) { failures.push(`${where}: status ${res.status} (${JSON.stringify(res.body)})`); continue; }
    const got = keysOf(path, itemsOf(path, res.body));
    const want = ep.pluck ? expected.items : expected.items.map((r) => r.id);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`${where}: [${got.join(',')}] vs oracle [${want.join(',')}] (total ${expected.total}, limit ${expected.limit})`);
      continue;
    }
    const envelope = { total: expected.total, page: expected.page, total_pages: expected.totalPages };
    if (path === '/api/articles') envelope.per_page = expected.limit;
    for (const [key, value] of Object.entries(envelope)) {
      if (res.body[key] !== value) failures.push(`${where}: ${key} ${res.body[key]}, the oracle says ${value}`);
    }
    if (res.headers['x-total-count'] !== String(expected.total)) failures.push(`${where}: x-total-count ${res.headers['x-total-count']}, the oracle says ${expected.total}`);
  }
  assert.deepEqual(failures.slice(0, 12), [], `${failures.length} of ${combos.length} combinations do not match`);
});

test('combos: consecutive pages do not overlap and cover the world without gaps', () => {
  const failures = [];
  const pageSize = 7;
  for (const status of ['draft', 'published', 'archived']) {
    const total = rows.filter((r) => r.status === status).length;
    const seen = [];
    for (let offset = 0; offset < total; offset += pageSize) {
      // `hidden=true` adds the hidden rows to the default set: every row of that status.
      const q = new URLSearchParams({ status, hidden: 'true', limit: String(pageSize), offset: String(offset) });
      const res = get(q);
      const ids = res.body.data.map((r) => r.id);
      if (ids.length === 0) { failures.push(`${status}@${offset}: empty page with total ${total}`); break; }
      for (const id of ids) {
        if (seen.includes(id)) failures.push(`${status}: id ${id} repeated across pages`);
        seen.push(id);
      }
    }
    if (seen.length !== total) failures.push(`${status}: ${seen.length} rows across all pages, the world has ${total}`);
  }
  assert.deepEqual(failures.slice(0, 8), []);
});

test('combos: walking `total_pages` pages by number gives every id once, in order', () => {
  for (const [size, status] of [['4', null], ['7', 'published'], ['12', 'draft,archived']]) {
    const base = new URLSearchParams({ size, sort: 'id' });
    if (status) base.set('status', status);
    const want = rows.filter((r) => !status || status.split(',').includes(r.status)).map((r) => String(r.id));
    const first = get(base, '/api/article-ids').body;
    assert.equal(first.total_pages, Math.ceil(want.length / Number(size)), `total_pages for size ${size}`);
    const seen = [];
    for (let page = 1; page <= first.total_pages; page++) {
      const q = new URLSearchParams(base);
      q.set('page', String(page));
      const body = get(q, '/api/article-ids').body;
      assert.equal(body.page, page);
      assert.ok(body.ids.length > 0, `page ${page} of ${first.total_pages} is empty`);
      seen.push(...body.ids);
    }
    assert.deepEqual(seen, want.slice().sort((a, b) => Number(a) - Number(b)));
  }
});

test('combos: limit=0 invents no rows and keeps the total', () => {
  const res = get(new URLSearchParams({ limit: '0', hidden: 'true' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 0);
  assert.equal(res.body.total, rows.length);
});

test('combos: a sort outside `fields` is 400, not a silent order by something else', () => {
  // Documented in references/scenario.md: at request time, a field outside
  // `fields` answers 400 (silence here would be the bug).
  const res = get(new URLSearchParams({ sort: 'no-such-field' }));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /is not allowed on \/api\/articles/);
});
