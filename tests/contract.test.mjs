import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { generateWorld } from '../scripts/lib/world.mjs';
import { createEngine } from '../scripts/lib/contract.mjs';
import { SCENARIO } from './helpers.mjs';

const dataset = generateWorld(normalizeScenario(parseYaml(SCENARIO, 't.yaml'), 't.yaml'));
const engine = createEngine(dataset);
const get = (path) => {
  const u = new URL(path, 'http://x');
  return engine.handle({ method: 'GET', pathname: u.pathname, query: u.searchParams });
};
const ids = (r) => r.body.map((x) => x.id);

test('limit/offset return the expected window', () => {
  const r = get('/api/orders?limit=12');
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(r.headers['x-total-count'], '40');
  assert.deepEqual(ids(get('/api/orders?limit=5&offset=10')), [11, 12, 13, 14, 15]);
});

test('consecutive pages cover everything without overlap', () => {
  const all = [];
  for (let off = 0; off < 40; off += 12) all.push(...ids(get(`/api/orders?limit=12&offset=${off}`)));
  assert.deepEqual(all, Array.from({ length: 40 }, (_, i) => i + 1));
});

test('limit above the total returns everything', () => {
  assert.equal(get('/api/orders?limit=1000').body.length, 40);
});

test('out-of-range offset returns []', () => {
  const r = get('/api/orders?limit=10&offset=40');
  assert.deepEqual(r.body, []);
  assert.equal(r.headers['x-total-count'], '40');
  assert.deepEqual(get('/api/orders?offset=999').body, []);
});

test('invalid limit/offset ⇒ 400 with a reason', () => {
  const r = get('/api/orders?limit=-3');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /limit/);
  assert.equal(get('/api/orders?offset=abc').status, 400);
});

test('equality filters and comma-separated lists', () => {
  const inc = get('/api/orders?status=issue');
  assert.equal(inc.body.length, 3);
  assert.ok(inc.body.every((p) => p.status === 'issue'));
  assert.equal(get('/api/orders?status=issue,pending').body.length, 6);
  const c1 = get('/api/orders?customer_id=1');
  assert.ok(c1.body.length > 0 && c1.body.every((p) => p.customer_id === 1));
  assert.equal(get('/api/orders?status=issue&limit=2').body.length, 2);
});

test('undeclared parameters are ignored and reported in a header', () => {
  const r = get('/api/orders?color=red');
  assert.equal(r.body.length, 40);
  assert.equal(r.headers['x-atrezzo-ignored'], 'color');
});

test('stable, deterministic sort', () => {
  const ds = { ...dataset, endpoints: [{ ...dataset.endpoints[0], sort: [{ field: 'status', dir: 'asc' }] }] };
  const e = createEngine(ds);
  const run = () => e.handle({ pathname: '/api/orders', query: new URLSearchParams() }).body.map((p) => p.id);
  const a = run();
  assert.deepEqual(a, run());
  // within each status, the original id order is kept (stability)
  const body = e.handle({ pathname: '/api/orders', query: new URLSearchParams() }).body;
  for (const status of ['issue', 'paid', 'pending']) {
    const group = body.filter((p) => p.status === status).map((p) => p.id);
    assert.deepEqual(group, [...group].sort((x, y) => x - y));
  }
  assert.deepEqual([...new Set(body.map((p) => p.status))], ['issue', 'paid', 'pending']);
});

test('descending sort', () => {
  const ds = { ...dataset, endpoints: [{ ...dataset.endpoints[0], sort: [{ field: 'created_at', dir: 'desc' }] }] };
  const body = createEngine(ds).handle({ pathname: '/api/orders' }).body;
  for (let i = 1; i < body.length; i++) assert.ok(body[i - 1].created_at >= body[i].created_at);
});

test('detail /:id exists or 404s; include embeds the parent', () => {
  assert.equal(get('/api/orders/7').body.id, 7);
  assert.equal(get('/api/orders/999').status, 404);
  const ds = { ...dataset, endpoints: [{ ...dataset.endpoints[0], include: ['customers'] }] };
  const row = createEngine(ds).handle({ pathname: '/api/orders/1' }).body;
  assert.equal(row.customer.id, row.customer_id);
});

test('writes ⇒ 405 (the mock does not implement business rules)', () => {
  assert.equal(engine.handle({ method: 'POST', pathname: '/api/orders' }).status, 405);
  assert.equal(engine.handle({ pathname: '/api/other' }), null);
});

test('shape envelope', () => {
  const ds = { ...dataset, endpoints: [{ ...dataset.endpoints[0], shape: 'envelope' }] };
  const r = createEngine(ds).handle({ pathname: '/api/orders', query: { limit: '3', offset: '1' } });
  assert.deepEqual(r.body.data.map((x) => x.id), [2, 3, 4]);
  assert.equal(r.body.total, 40);
});

// ---------- PostgREST operator prefixes (supabase-js: `.eq()`, `.neq()`, `.in()`, `.like()`) ----------

const getH = (path, headers) => {
  const u = new URL(path, 'http://x');
  return engine.handle({ method: 'GET', pathname: u.pathname, query: u.searchParams, headers });
};

test('eq. prefix filters like a bare equality (supabase-js always sends it)', () => {
  const prefixed = get('/api/orders?status=eq.issue');
  const bare = get('/api/orders?status=issue');
  assert.equal(prefixed.status, 200);
  assert.deepEqual(ids(prefixed), ids(bare));
  assert.equal(prefixed.body.length, 3);
  assert.equal(get('/api/orders?customer_id=eq.1').body.every((o) => o.customer_id === 1), true);
});

test('neq. / gt. / in. / like. are applied, not compared literally', () => {
  assert.equal(get('/api/orders?status=neq.issue').body.length, 37);
  assert.equal(get('/api/orders?status=neq.issue').body.every((o) => o.status !== 'issue'), true);
  const gt = get('/api/orders?customer_id=gt.1');
  assert.ok(gt.body.length > 0 && gt.body.every((o) => o.customer_id > 1));
  const inList = get('/api/orders?customer_id=in.(1,2)');
  assert.ok(inList.body.length > 0 && inList.body.every((o) => [1, 2].includes(o.customer_id)));
  assert.equal(inList.body.length, get('/api/orders?customer_id=1,2').body.length);
  const like = get('/api/orders?status=like.iss*');
  assert.equal(like.body.length, 3);
  assert.equal(get('/api/orders?status=ilike.ISS*').body.length, 3);
});

test('an unknown prefix is still a literal value (no silent widening)', () => {
  const r = get('/api/orders?status=bogus.issue');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

// ---------- `.single()`: Accept: application/vnd.pgrst.object+json ----------

test('object Accept returns the single row as an object', () => {
  const r = getH('/api/orders?customer_id=1&limit=1', { accept: 'application/vnd.pgrst.object+json' });
  assert.equal(r.status, 200);
  assert.ok(!Array.isArray(r.body));
  assert.equal(typeof r.body.id, 'number');
});

test('object Accept with zero or many rows ⇒ 406 PGRST116', () => {
  const many = getH('/api/orders?status=issue', { accept: 'application/vnd.pgrst.object+json' });
  assert.equal(many.status, 406);
  assert.equal(many.body.code, 'PGRST116');
  const none = getH('/api/orders?status=bogus', { accept: 'application/vnd.pgrst.object+json' });
  assert.equal(none.status, 406);
  assert.equal(none.body.code, 'PGRST116');
});

// ---------- Dynamic sorting (`sorts`) ----------

const SORTED_SCENARIO = `name: sortable
seed: 7712
now: 2025-03-01T09:00:00Z
world:
  customers: 3
  orders:
    total: 40
    distribution: { paid: 34, pending: 3, issue: 3 }
    amount: { min: 20, max: 900, currency: EUR }
endpoints:
  - path: /api/orders
    entity: orders
    filters: [status, customer_id]
    pagination: { param_limit: limit, param_offset: offset }
    sort: id
    sorts: { by: sort_by, order: order_by, fields: [id, status, created_at] }
  - path: /api/by-prefix
    entity: orders
    pagination: { param_limit: limit, param_offset: offset }
    sorts: { by: sort, fields: [id, amount, created_at] }
  - path: /api/by-dot
    entity: orders
    pagination: { param_limit: limit, param_offset: offset }
    sorts: { by: order, fields: [id, created_at] }
  - path: /api/static-only
    entity: orders
    sort: -id
`;

const sortedDataset = generateWorld(normalizeScenario(parseYaml(SORTED_SCENARIO, 's.yaml'), 's.yaml'));
const sortedEngine = createEngine(sortedDataset);
const getS = (path) => {
  const u = new URL(path, 'http://x');
  return sortedEngine.handle({ method: 'GET', pathname: u.pathname, query: u.searchParams });
};

test('sorts: ascending and descending via by + order parameters, not listed in x-atrezzo-ignored', () => {
  const asc = getS('/api/orders?sort_by=id&order_by=asc');
  assert.equal(asc.status, 200);
  assert.deepEqual(ids(asc), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal(asc.headers['x-atrezzo-ignored'], undefined);

  const desc = getS('/api/orders?sort_by=id&order_by=desc');
  assert.equal(desc.status, 200);
  assert.deepEqual(ids(desc), Array.from({ length: 40 }, (_, i) => 40 - i));
  assert.equal(desc.headers['x-atrezzo-ignored'], undefined);

  // omit order_by ⇒ defaults to asc
  const defDir = getS('/api/orders?sort_by=created_at');
  assert.equal(defDir.status, 200);
  for (let i = 1; i < defDir.body.length; i++) assert.ok(defDir.body[i - 1].created_at <= defDir.body[i].created_at);

  // only order_by=desc ⇒ applies desc to default sort field
  const onlyOrder = getS('/api/orders?order_by=desc');
  assert.equal(onlyOrder.status, 200);
  assert.deepEqual(ids(onlyOrder), Array.from({ length: 40 }, (_, i) => 40 - i));
});

test('sorts: supports -field and field.asc|desc syntaxes', () => {
  const neg = getS('/api/by-prefix?sort=-amount');
  assert.equal(neg.status, 200);
  for (let i = 1; i < neg.body.length; i++) assert.ok(neg.body[i - 1].amount >= neg.body[i].amount);
  assert.equal(neg.headers['x-atrezzo-ignored'], undefined);

  const dotDesc = getS('/api/by-dot?order=created_at.desc');
  assert.equal(dotDesc.status, 200);
  for (let i = 1; i < dotDesc.body.length; i++) assert.ok(dotDesc.body[i - 1].created_at >= dotDesc.body[i].created_at);
  assert.equal(dotDesc.headers['x-atrezzo-ignored'], undefined);

  const dotAsc = getS('/api/by-dot?order=created_at.asc');
  assert.equal(dotAsc.status, 200);
  for (let i = 1; i < dotAsc.body.length; i++) assert.ok(dotAsc.body[i - 1].created_at <= dotAsc.body[i].created_at);
});

test('sorts: applies before pagination', () => {
  const page = getS('/api/orders?sort_by=id&order_by=desc&limit=5&offset=5');
  assert.equal(page.status, 200);
  assert.deepEqual(ids(page), [35, 34, 33, 32, 31]);
  assert.equal(page.headers['x-total-count'], '40');

  const negPage = getS('/api/by-prefix?sort=-id&limit=4&offset=2');
  assert.equal(negPage.status, 200);
  assert.deepEqual(ids(negPage), [38, 37, 36, 35]);
});

test('sorts: disallowed field or invalid order ⇒ 400 with clear error (never silent)', () => {
  const badField = getS('/api/orders?sort_by=amount&order_by=asc');
  assert.equal(badField.status, 400);
  assert.match(badField.body.error, /amount.*not allowed.*sortable|allowed: id, status, created_at/);

  const badNeg = getS('/api/by-prefix?sort=-status');
  assert.equal(badNeg.status, 400);
  assert.match(badNeg.body.error, /"status" is not allowed/);

  const badDot = getS('/api/by-dot?order=amount.desc');
  assert.equal(badDot.status, 400);
  assert.match(badDot.body.error, /"amount" is not allowed/);

  const badOrder = getS('/api/orders?sort_by=id&order_by=sideways');
  assert.equal(badOrder.status, 400);
  assert.match(badOrder.body.error, /"order_by" must be "asc" or "desc"; got "sideways"/);

  const badDotOrder = getS('/api/by-dot?order=id.sideways');
  assert.equal(badDotOrder.status, 400);
  assert.match(badDotOrder.body.error, /must be "asc" or "desc"; got "sideways"/);

  const conflict = getS('/api/orders?sort_by=-id&order_by=asc');
  assert.equal(conflict.status, 400);
  assert.match(conflict.body.error, /conflicting sort order/);
});

test('without sorts: query sort params keep being ignored and static sort applies', () => {
  const r = getS('/api/static-only?sort_by=id&order_by=asc');
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-atrezzo-ignored'], 'sort_by,order_by');
  assert.deepEqual(ids(r), Array.from({ length: 40 }, (_, i) => 40 - i));

  const r2 = get('/api/orders?sort_by=id&order_by=desc');
  assert.equal(r2.status, 200);
  assert.equal(r2.headers['x-atrezzo-ignored'], 'sort_by,order_by');
  assert.deepEqual(ids(r2), Array.from({ length: 40 }, (_, i) => i + 1));
});
