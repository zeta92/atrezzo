import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { generateWorld, scenarioHash } from '../scripts/lib/world.mjs';
import { createEngine } from '../scripts/lib/contract.mjs';
import { AtrezzoError } from '../scripts/lib/errors.mjs';
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

test('sorts: order without by on an endpoint with empty sort returns 400 instead of throwing', () => {
  const emptySortDataset = {
    ...sortedDataset,
    endpoints: [{ ...sortedDataset.endpoints[0], sort: [] }],
  };
  const eng = createEngine(emptySortDataset);
  const res = eng.handle({ method: 'GET', pathname: '/api/orders', query: new URLSearchParams('order_by=desc') });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot apply "order_by" without "sort_by"/);
});

// ---------- World-resolved filters (`filters: { <fk>: { from, where } }`) ----------

const WORLD_FILTER_SCENARIO = `name: world-filters
seed: 4242
now: 2025-03-01T09:00:00Z
world:
  groups: 2
  sources:
    total: 6
    fields:
      name: string
      active: boolean
      tier: [core, extra, archive]
  items:
    total: 30
    ref: [sources, groups]
    nulls: { source_id: 3 }
    fields:
      title: string
      status: [draft, live]
endpoints:
  - path: /api/feed
    entity: items
    filters:
      source_id: { from: sources, where: { active: true } }
  - path: /api/combined
    entity: items
    filters:
      source_id: { from: sources, where: { active: true } }
      status: status
    pagination: { param_limit: limit, param_offset: offset }
    sort: id
    sorts: { by: sort_by, order: order_by, fields: [id, status] }
  - path: /api/core-feed
    entity: items
    filters: { source_id: { from: sources, where: { active: true, tier: [core, extra] } } }
  - path: /api/empty-feed
    entity: items
    filters: { source_id: { from: sources, where: { tier: bogus } } }
  - path: /api/groups/:group_id/items
    entity: items
    filters:
      source_id: { from: sources, where: { active: true } }
      status: status
    pagination: { param_limit: limit, param_offset: offset }
  - path: /api/featured
    entity: items
    filters:
      source_id: { from: sources, where: { active: true } }
      status: status
    sort: id
    shape: object
  - path: /api/empty-featured
    entity: items
    filters: { source_id: { from: sources, where: { tier: bogus } } }
    shape: object
`;

const wfScenario = normalizeScenario(parseYaml(WORLD_FILTER_SCENARIO, 'wf.yaml'), 'wf.yaml');
const wfDataset = generateWorld(wfScenario);
const wfEngine = createEngine(wfDataset);
const getWF = (path, headers) => {
  const u = new URL(path, 'http://x');
  return wfEngine.handle({ method: 'GET', pathname: u.pathname, query: u.searchParams, headers });
};

test('world-resolved filter selects rows whose FK matches `from` rows satisfying `where`, without query params', () => {
  const activeIds = new Set(wfDataset.entities.sources.filter((s) => s.active === true).map((s) => s.id));
  assert.ok(activeIds.size > 0 && activeIds.size < wfDataset.entities.sources.length);
  const nullSourceItems = wfDataset.entities.items.filter((it) => it.source_id === null);
  assert.equal(nullSourceItems.length, 3);
  const expected = wfDataset.entities.items.filter((it) => it.source_id !== null && activeIds.has(it.source_id));
  assert.ok(expected.length > 0 && expected.length < wfDataset.entities.items.length);

  const res = getWF('/api/feed');
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), expected.map((it) => it.id));
  assert.equal(res.headers['x-total-count'], String(expected.length));
  assert.ok(res.body.every((it) => it.source_id !== null && activeIds.has(it.source_id)));
  assert.ok(nullSourceItems.every((n) => !res.body.some((it) => it.id === n.id)));

  // No query param exists for the resolved filter: passing ?source_id=1 is ignored
  const withParam = getWF('/api/feed?source_id=1');
  assert.equal(withParam.status, 200);
  assert.deepEqual(ids(withParam), expected.map((it) => it.id));
  assert.equal(withParam.headers['x-atrezzo-ignored'], 'source_id');

  // head=true and HEAD + Prefer: count=exact count only the resolved rows
  const head = getWF('/api/feed?head=true');
  assert.equal(head.status, 200);
  assert.equal(head.headers['x-total-count'], String(expected.length));
  const headMethod = wfEngine.handle({ method: 'HEAD', pathname: '/api/feed', headers: { prefer: 'count=exact' } });
  assert.equal(headMethod.status, 200);
  assert.equal(headMethod.body, null);
  assert.equal(headMethod.headers['x-total-count'], String(expected.length));
  assert.equal(headMethod.headers['content-range'], `0-${expected.length - 1}/${expected.length}`);

  // Multi-key + list value in `where`
  const coreIds = new Set(wfDataset.entities.sources.filter((s) => s.active === true && ['core', 'extra'].includes(s.tier)).map((s) => s.id));
  const coreExpected = wfDataset.entities.items.filter((it) => it.source_id !== null && coreIds.has(it.source_id));
  assert.deepEqual(ids(getWF('/api/core-feed')), coreExpected.map((it) => it.id));

  // Empty `where` match answers [] with X-Total-Count: 0
  const empty = getWF('/api/empty-feed');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, []);
  assert.equal(empty.headers['x-total-count'], '0');
});

test('world-resolved filter combines with normal query filters and sort', () => {
  const activeIds = new Set(wfDataset.entities.sources.filter((s) => s.active === true).map((s) => s.id));
  const expectedLive = wfDataset.entities.items.filter((it) => it.source_id !== null && activeIds.has(it.source_id) && it.status === 'live');
  assert.ok(expectedLive.length > 0);

  const r = getWF('/api/combined?status=live');
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), expectedLive.map((it) => it.id));
  assert.equal(r.headers['x-total-count'], String(expectedLive.length));
  assert.equal(r.headers['x-atrezzo-ignored'], undefined);

  const rEq = getWF('/api/combined?status=eq.live&sort_by=id&order_by=desc');
  assert.equal(rEq.status, 200);
  assert.deepEqual(ids(rEq), [...expectedLive.map((it) => it.id)].reverse());

  // Short-form scenarios keep their exact normalized filters and hash
  const shortNorm = normalizeScenario(parseYaml(SCENARIO, 's.yaml'), 's.yaml');
  assert.deepEqual(shortNorm.endpoints[0].filters, ['status', 'customer_id']);
  assert.equal(shortNorm.endpoints[0].worldFilters, undefined);
  assert.equal(scenarioHash(shortNorm), dataset.hash);
});

test('world-resolved filter combines with pagination and keeps accurate X-Total-Count', () => {
  const activeIds = new Set(wfDataset.entities.sources.filter((s) => s.active === true).map((s) => s.id));
  const expectedIds = wfDataset.entities.items
    .filter((it) => it.source_id !== null && activeIds.has(it.source_id))
    .map((it) => it.id);
  assert.ok(expectedIds.length > 3);

  const p1 = getWF('/api/combined?limit=3&offset=0');
  assert.equal(p1.status, 200);
  assert.equal(p1.headers['x-total-count'], String(expectedIds.length));
  assert.deepEqual(ids(p1), expectedIds.slice(0, 3));

  const p2 = getWF('/api/combined?limit=3&offset=3');
  assert.equal(p2.status, 200);
  assert.equal(p2.headers['x-total-count'], String(expectedIds.length));
  assert.deepEqual(ids(p2), expectedIds.slice(3, 6));

  // Combined with query filter + pagination
  const liveIds = wfDataset.entities.items
    .filter((it) => it.source_id !== null && activeIds.has(it.source_id) && it.status === 'live')
    .map((it) => it.id);
  const pl = getWF('/api/combined?status=live&limit=2&offset=1');
  assert.equal(pl.status, 200);
  assert.equal(pl.headers['x-total-count'], String(liveIds.length));
  assert.deepEqual(ids(pl), liveIds.slice(1, 3));
});

test('world-resolved filter validation: undeclared from, non-FK field, mismatched FK, and unknown where field fail', () => {
  const parseErr = (filterLine) => {
    const yaml = `name: bad-wf
seed: 1
world:
  groups: 2
  sources: { total: 3, fields: { name: string, active: boolean } }
  items: { total: 6, ref: [sources, groups], fields: { title: string, status: [draft, live] } }
endpoints:
  - path: /api/items
    entity: items
    filters: ${filterLine}
`;
    try {
      normalizeScenario(parseYaml(yaml, 'bad.yaml'), 'bad.yaml');
    } catch (e) {
      assert.ok(e instanceof AtrezzoError);
      assert.equal(e.exitCode, 3);
      return e.message;
    }
    assert.fail(`expected scenario validation error for: ${filterLine}`);
  };

  assert.match(parseErr('{ source_id: { from: unknown, where: { active: true } } }'), /filters\.source_id\.from": "unknown" is not declared in world/);
  assert.match(parseErr('{ status: { from: sources, where: { active: true } } }'), /filters\.status": "status" is not a foreign key of "items"/);
  assert.match(parseErr('{ bogus_id: { from: sources, where: { active: true } } }'), /filters\.bogus_id": "bogus_id" is not a foreign key of "items"/);
  assert.match(parseErr('{ group_id: { from: sources, where: { active: true } } }'), /filters\.group_id\.from": "group_id" is a foreign key to "groups", not "sources"/);
  assert.match(parseErr('{ source_id: { from: sources, where: { missing_col: true } } }'), /filters\.source_id\.where\.missing_col": field "missing_col" does not exist in "sources"/);
  assert.match(parseErr('{ source_id: { from: sources, where: {} } }'), /filters\.source_id\.where": required; must be a non-empty map/);
  assert.match(parseErr('{ source_id: { from: sources } }'), /filters\.source_id\.where": required; must be a non-empty map/);
  assert.match(parseErr('{ source_id: { where: { active: true } } }'), /filters\.source_id\.from": required; a declared world entity/);
  assert.match(parseErr('{ source_id: { from: sources, where: { active: true }, extra: 1 } }'), /filters\.source_id\.extra": unknown field/);
  assert.match(parseErr('{ source_id: { from: sources, where: { active: [] } } }'), /filters\.source_id\.where\.active": must be a scalar value or a non-empty list/);
});

test('world-resolved filter combines with path parameters and shape: object', () => {
  const activeIds = new Set(wfDataset.entities.sources.filter((s) => s.active === true).map((s) => s.id));
  const group1Expected = wfDataset.entities.items.filter(
    (it) => it.group_id === 1 && it.source_id !== null && activeIds.has(it.source_id),
  );
  assert.ok(group1Expected.length > 0);

  const g1 = getWF('/api/groups/1/items');
  assert.equal(g1.status, 200);
  assert.deepEqual(ids(g1), group1Expected.map((it) => it.id));
  assert.equal(g1.headers['x-total-count'], String(group1Expected.length));

  const g1Live = getWF('/api/groups/1/items?status=live&limit=2&offset=0');
  const g1LiveExpected = group1Expected.filter((it) => it.status === 'live');
  assert.equal(g1Live.status, 200);
  assert.equal(g1Live.headers['x-total-count'], String(g1LiveExpected.length));
  assert.deepEqual(ids(g1Live), g1LiveExpected.slice(0, 2).map((it) => it.id));

  // shape: object returns the first row after world filter (and query filter)
  const allActive = wfDataset.entities.items.filter((it) => it.source_id !== null && activeIds.has(it.source_id));
  const feat = getWF('/api/featured');
  assert.equal(feat.status, 200);
  assert.equal(feat.body.id, allActive[0].id);

  const featLive = getWF('/api/featured?status=live');
  assert.equal(featLive.status, 200);
  assert.equal(featLive.body.id, allActive.find((it) => it.status === 'live').id);

  const featNoneQuery = getWF('/api/featured?status=nonexistent');
  assert.equal(featNoneQuery.status, 404);
  assert.match(featNoneQuery.body.error, /no items matches status=nonexistent/);

  const featEmptyWorld = getWF('/api/empty-featured');
  assert.equal(featEmptyWorld.status, 404);
  assert.equal(featEmptyWorld.miss, undefined);
  assert.match(featEmptyWorld.body.error, /no items matches world filter in scenario "world-filters"/);
});

test('world-resolved filter rejects type-incompatible values in where and accepts compatible ones', () => {
  const parseErr = (filterLine, extraWorld = '') => {
    const yaml = `name: bad-wf-types
seed: 1
world:
  groups: 2
  sources: { total: 3, ref: groups, nulls: { group_id: 1 }, fields: { name: string, active: boolean, tier: [core, extra] } }
  users: 2
  products: 2
  items: { total: 6, ref: [sources, users, products], fields: { title: string, status: [draft, live] } }${extraWorld}
endpoints:
  - path: /api/items
    entity: items
    filters: ${filterLine}
`;
    try {
      normalizeScenario(parseYaml(yaml, 'bad.yaml'), 'bad.yaml');
    } catch (e) {
      assert.ok(e instanceof AtrezzoError);
      assert.equal(e.exitCode, 3);
      return e.message;
    }
    assert.fail(`expected scenario validation error for: ${filterLine}`);
  };

  assert.match(parseErr('{ source_id: { from: sources, where: { active: "true" } } }'), /where\.active": value "true" is incompatible with field "active" in "sources"/);
  assert.match(parseErr('{ source_id: { from: sources, where: { active: 1 } } }'), /where\.active": value 1 is incompatible with field "active" in "sources"/);
  assert.match(parseErr('{ source_id: { from: sources, where: { active: null } } }'), /where\.active": value null is incompatible with field "active" in "sources"/);
  assert.match(parseErr('{ source_id: { from: sources, where: { active: [true, "false"] } } }'), /where\.active": value "false" is incompatible with field "active" in "sources"/);
  assert.match(parseErr('{ source_id: { from: sources, where: { id: "1" } } }'), /where\.id": value "1" is incompatible with field "id" in "sources"/);
  assert.match(parseErr('{ source_id: { from: sources, where: { id: null } } }'), /where\.id": value null is incompatible with field "id" in "sources"/);
  assert.match(parseErr('{ source_id: { from: sources, where: { group_id: "1" } } }'), /where\.group_id": value "1" is incompatible with field "group_id" in "sources"/);
  assert.match(parseErr('{ source_id: { from: sources, where: { tier: 123 } } }'), /where\.tier": value 123 is incompatible with field "tier" in "sources"/);
  assert.match(parseErr('{ user_id: { from: users, where: { role: 1 } } }'), /where\.role": value 1 is incompatible with field "role" in "users"/);
  assert.match(parseErr('{ product_id: { from: products, where: { stock: "5" } } }'), /where\.stock": value "5" is incompatible with field "stock" in "products"/);

  // Compatible types (id, nullable FK, template entity role, numeric stock) succeed and match rows
  const okYaml = `name: ok-wf-types
seed: 7
world:
  groups: 2
  sources: { total: 4, ref: groups, nulls: { group_id: 1 }, fields: { name: string, active: boolean } }
  users: 3
  items: { total: 8, ref: [sources, users], fields: { title: string } }
endpoints:
  - path: /api/by-id
    entity: items
    filters: { source_id: { from: sources, where: { id: [1, 2] } } }
  - path: /api/null-group
    entity: items
    filters: { source_id: { from: sources, where: { group_id: null } } }
  - path: /api/admin-items
    entity: items
    filters: { user_id: { from: users, where: { role: admin } } }
`;
  const okDs = generateWorld(normalizeScenario(parseYaml(okYaml, 'ok.yaml'), 'ok.yaml'));
  const okEng = createEngine(okDs);
  const byId = okEng.handle({ method: 'GET', pathname: '/api/by-id' });
  assert.equal(byId.status, 200);
  assert.ok(byId.body.length > 0 && byId.body.every((it) => it.source_id === 1 || it.source_id === 2));

  const nullGroupSourceIds = new Set(okDs.entities.sources.filter((s) => s.group_id === null).map((s) => s.id));
  assert.equal(nullGroupSourceIds.size, 1);
  const nullGroupRes = okEng.handle({ method: 'GET', pathname: '/api/null-group' });
  assert.equal(nullGroupRes.status, 200);
  assert.ok(nullGroupRes.body.every((it) => nullGroupSourceIds.has(it.source_id)));

  const adminRes = okEng.handle({ method: 'GET', pathname: '/api/admin-items' });
  assert.equal(adminRes.status, 200);
  assert.ok(adminRes.body.length > 0 && adminRes.body.every((it) => it.user_id === 1));
});

// ---------- Seeded auth user (`auth: { user: { entity, id } }`, `$user.<field>`) ----------

const AUTH_SCENARIO = `name: auth-user
seed: 9191
now: 2025-03-01T09:00:00Z
auth:
  user:
    entity: authors
    id: 2
world:
  groups:
    total: 3
    fields: { name: string, owner_id: integer }
  authors:
    total: 4
    ref: groups
    fields: { name: string, handle: string }
  articles:
    total: 24
    ref: [authors, groups]
    fields:
      title: string
      status: [draft, published]
endpoints:
  - path: /api/user
    entity: authors
    shape: object
    filters: { id: "$user.id" }
  - path: /api/me
    entity: authors
    shape: object
    filters: { id: "$user.id" }
    sort: id
  - path: /api/my-articles
    entity: articles
    filters:
      author_id: "$user.id"
      status: status
    pagination: { param_limit: limit, param_offset: offset }
    sort: id
  - path: /api/group-articles
    entity: articles
    filters:
      group_id: "$user.group_id"
  - path: /api/owned-group-articles
    entity: articles
    filters:
      group_id: { from: groups, where: { id: "$user.group_id" } }
`;

const authNorm = normalizeScenario(parseYaml(AUTH_SCENARIO, 'auth.yaml'), 'auth.yaml');
const authDataset = generateWorld(authNorm);
const authEngine = createEngine(authDataset);
const getAuth = (path, headers) => {
  const u = new URL(path, 'http://x');
  return authEngine.handle({ method: 'GET', pathname: u.pathname, query: u.searchParams, headers });
};

test('auth: engine exposes seeded user row and /api/user & /api/me return it instead of the first row', () => {
  const expectedUser = authDataset.entities.authors.find((a) => a.id === 2);
  assert.ok(expectedUser);
  assert.deepEqual(authEngine.currentUser, expectedUser);

  for (const path of ['/api/user', '/api/me']) {
    const res = getAuth(path);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, expectedUser);
    assert.notEqual(res.body.id, authDataset.entities.authors[0].id);
  }

  // Without auth, behaviour and hash remain unchanged and currentUser is null
  assert.equal(engine.currentUser, null);
  const shortNorm = normalizeScenario(parseYaml(SCENARIO, 's.yaml'), 's.yaml');
  assert.equal(shortNorm.auth, undefined);
  assert.equal(scenarioHash(shortNorm), dataset.hash);
});

test('auth: $user.<field> filter returns only rows matching the seeded user and combines with query filters and pagination', () => {
  const userArticles = authDataset.entities.articles.filter((a) => a.author_id === 2);
  assert.ok(userArticles.length > 0 && userArticles.length < authDataset.entities.articles.length);

  const res = getAuth('/api/my-articles');
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), userArticles.map((a) => a.id));
  assert.equal(res.headers['x-total-count'], String(userArticles.length));
  assert.ok(res.body.every((a) => a.author_id === 2));

  // Query parameter of the same name cannot override the $user filter and is reported as ignored
  const override = getAuth('/api/my-articles?author_id=1');
  assert.equal(override.status, 200);
  assert.deepEqual(ids(override), userArticles.map((a) => a.id));
  assert.equal(override.headers['x-atrezzo-ignored'], 'author_id');

  // Combines with query filters, pagination, and count-only requests
  const published = userArticles.filter((a) => a.status === 'published');
  const pubRes = getAuth('/api/my-articles?status=published&limit=2&offset=1');
  assert.equal(pubRes.status, 200);
  assert.equal(pubRes.headers['x-total-count'], String(published.length));
  assert.deepEqual(ids(pubRes), published.slice(1, 3).map((a) => a.id));

  const head = getAuth('/api/my-articles?head=true');
  assert.equal(head.status, 200);
  assert.equal(head.headers['x-total-count'], String(userArticles.length));
  const headMethod = authEngine.handle({ method: 'HEAD', pathname: '/api/my-articles', headers: { prefer: 'count=exact' } });
  assert.equal(headMethod.status, 200);
  assert.equal(headMethod.headers['content-range'], `0-${userArticles.length - 1}/${userArticles.length}`);

  // Non-id $user.<field> and $user.<field> inside { from, where }
  const userGroup = authEngine.currentUser.group_id;
  const groupExpected = authDataset.entities.articles.filter((a) => a.group_id === userGroup);
  assert.ok(groupExpected.length > 0);
  assert.deepEqual(ids(getAuth('/api/group-articles')), groupExpected.map((a) => a.id));
  assert.deepEqual(ids(getAuth('/api/owned-group-articles')), groupExpected.map((a) => a.id));
});

test('auth: validation rejects nonexistent id, undeclared entity, malformed auth, and invalid $user references', () => {
  const parseErr = (yaml) => {
    try {
      normalizeScenario(parseYaml(yaml, 'bad-auth.yaml'), 'bad-auth.yaml');
    } catch (e) {
      assert.ok(e instanceof AtrezzoError);
      assert.equal(e.exitCode, 3);
      return e.message;
    }
    assert.fail('expected scenario validation error');
  };

  assert.match(parseErr(`name: bad
seed: 1
auth: { user: { entity: authors, id: 99 } }
world:
  authors: 4
endpoints:
  - path: /api/user
    entity: authors
`), /auth\.user\.id": id 99 does not exist in "authors" \(valid ids: 1\.\.4\)/);

  assert.match(parseErr(`name: bad
seed: 1
auth: { user: { entity: authors, id: 0 } }
world:
  authors: 4
endpoints:
  - path: /api/user
    entity: authors
`), /auth\.user\.id": required; integer >= 1/);

  assert.match(parseErr(`name: bad
seed: 1
auth: { user: { entity: authors, id: 1 } }
world:
  authors: 0
endpoints:
  - path: /api/authors
    entity: authors
`), /auth\.user\.id": entity "authors" has 0 rows in world; id 1 does not exist/);

  assert.match(parseErr(`name: bad
seed: 1
auth: { user: { entity: ghosts, id: 1 } }
world:
  authors: 2
endpoints:
  - path: /api/authors
    entity: authors
`), /auth\.user\.entity": "ghosts" is not declared in world/);

  assert.match(parseErr(`name: bad
seed: 1
auth: {}
world:
  authors: 2
endpoints:
  - path: /api/authors
    entity: authors
`), /auth\.user": required; must be a map \{ entity, id \}/);

  assert.match(parseErr(`name: bad
seed: 1
auth: { user: { entity: authors, id: 1 }, extra: true }
world:
  authors: 2
endpoints:
  - path: /api/authors
    entity: authors
`), /auth\.extra": unknown field/);

  assert.match(parseErr(`name: bad
seed: 1
world:
  authors: 2
  articles: { total: 4, ref: authors }
endpoints:
  - path: /api/articles
    entity: articles
    filters: { author_id: "$user.id" }
`), /filters\.author_id": "\$user\.id" requires a top-level "auth: \{ user: \{ entity, id \} \}"/);

  assert.match(parseErr(`name: bad
seed: 1
auth: { user: { entity: authors, id: 1 } }
world:
  authors: 2
  articles: { total: 4, ref: authors }
endpoints:
  - path: /api/articles
    entity: articles
    filters: { author_id: "$user.missing_col" }
`), /filters\.author_id": field "missing_col" does not exist in auth user entity "authors"/);

  assert.match(parseErr(`name: bad
seed: 1
auth: { user: { entity: authors, id: 1 } }
world:
  authors: 2
  articles: { total: 4, ref: authors }
endpoints:
  - path: /api/articles
    entity: articles
    filters: { author_id: "$user" }
`), /filters\.author_id": invalid user token "\$user"; expected "\$user\.<field>"/);

  assert.match(parseErr(`name: bad
seed: 1
auth: { user: { entity: authors, id: 1 } }
world:
  authors: 2
  articles: { total: 4, ref: authors }
endpoints:
  - path: /api/articles
    entity: articles
    filters: { missing_fk: "$user.id" }
`), /filters\.missing_fk": field "missing_fk" does not exist in "articles"/);
});

test('auth: nullable $user field does not match null rows on other entities', () => {
  const nullYaml = `name: auth-null
seed: 1
auth: { user: { entity: authors, id: 1 } }
world:
  groups: 2
  authors: { total: 1, ref: groups, nulls: { group_id: 1 } }
  articles: { total: 4, ref: groups, nulls: { group_id: 2 } }
endpoints:
  - path: /api/group-articles
    entity: articles
    filters: { group_id: "$user.group_id" }
  - path: /api/group-singleton
    entity: articles
    shape: object
    filters: { group_id: "$user.group_id" }
`;
  const ds = generateWorld(normalizeScenario(parseYaml(nullYaml, 'n.yaml'), 'n.yaml'));
  const eng = createEngine(ds);
  assert.equal(eng.currentUser.group_id, null);
  const res = eng.handle({ method: 'GET', pathname: '/api/group-articles' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
  const single = eng.handle({ method: 'GET', pathname: '/api/group-singleton' });
  assert.equal(single.status, 404);
  assert.match(single.body.error, /no articles matches user filter/);
});
