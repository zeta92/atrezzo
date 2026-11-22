import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { normalizeScenario, loadFlow } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { generateWorld, scenarioHash } from '../scripts/lib/world.mjs';
import { createEngine } from '../scripts/lib/contract.mjs';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { runVerify } from '../scripts/lib/verify.mjs';
import { openapiDocument } from '../scripts/lib/runtimes/prism.mjs';
import { AtrezzoError } from '../scripts/lib/errors.mjs';
import { SCENARIO, tmpProject } from './helpers.mjs';

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

test('auth: $user.<field> validates field type compatibility in direct filters and { from, where }', () => {
  const parseErr = (filterBlock, extraWorld = '', userEntity = 'authors') => {
    const yaml = `name: bad-user-types
seed: 1
auth: { user: { entity: ${userEntity}, id: 1 } }
world:
  groups: { total: 2, fields: { name: string, active: boolean } }
  authors:
    total: 2
    ref: groups
    fields:
      name: string
      active: boolean
      balance: number
      level: integer
      email: email
      role: [admin, editor]
      badge: { default: string, when: { active: true }, value: vip }
  users: 2
  articles:
    total: 4
    ref: [authors, groups]
    fields:
      title: string
      active: boolean
      score: number
      published_at: date
      contact_email: email
      role: [admin, viewer]
${extraWorld}endpoints:
  - path: /api/articles
    entity: articles
    filters: ${filterBlock}
`;
    try {
      normalizeScenario(parseYaml(yaml, 'bad-types.yaml'), 'bad-types.yaml');
    } catch (e) {
      assert.ok(e instanceof AtrezzoError);
      assert.equal(e.exitCode, 3);
      return e.message;
    }
    assert.fail(`expected scenario validation error for: ${filterBlock}`);
  };

  // Direct filters: incompatible types
  assert.match(parseErr('{ author_id: "$user.name" }'), /filters\.author_id": "\$user\.name" \(authors\.name: string\) is incompatible with field "author_id" in "articles"/);
  assert.match(parseErr('{ title: "$user.id" }'), /filters\.title": "\$user\.id" \(authors\.id: integer 1\.\.2\) is incompatible with field "title" in "articles" \(string\)/);
  assert.match(parseErr('{ author_id: "$user.active" }'), /filters\.author_id": "\$user\.active" \(authors\.active: boolean\) is incompatible with field "author_id" in "articles"/);
  assert.match(parseErr('{ author_id: "$user.balance" }'), /filters\.author_id": "\$user\.balance" \(authors\.balance: number\) is incompatible with field "author_id" in "articles"/);
  assert.match(parseErr('{ published_at: "$user.email" }'), /filters\.published_at": "\$user\.email" \(authors\.email: email\) is incompatible with field "published_at" in "articles" \(date\)/);
  assert.match(parseErr('{ active: "$user.role" }'), /filters\.active": "\$user\.role" \(authors\.role: enum \["admin","editor"\]\) is incompatible with field "active" in "articles" \(boolean\)/);
  assert.match(parseErr('{ author_id: "$user.badge" }'), /filters\.author_id": "\$user\.badge" \(authors\.badge: string\) is incompatible with field "author_id" in "articles"/);
  // Template users.email (inferred as email) vs date
  assert.match(parseErr('{ published_at: "$user.email" }', '', 'users'), /filters\.published_at": "\$user\.email" \(users\.email: email\) is incompatible with field "published_at" in "articles" \(date\)/);

  // World-resolved filters { from, where }: incompatible $user.<field> (scalar and inside list)
  assert.match(parseErr('{ group_id: { from: groups, where: { id: "$user.name" } } }'), /where\.id": "\$user\.name" \(authors\.name: string\) is incompatible with field "id" in "groups" \(integer 1\.\.2\)/);
  assert.match(parseErr('{ group_id: { from: groups, where: { name: "$user.id" } } }'), /where\.name": "\$user\.id" \(authors\.id: integer 1\.\.2\) is incompatible with field "name" in "groups" \(string\)/);
  assert.match(parseErr('{ group_id: { from: groups, where: { active: "$user.name" } } }'), /where\.active": "\$user\.name" \(authors\.name: string\) is incompatible with field "active" in "groups" \(boolean\)/);
  assert.match(parseErr('{ group_id: { from: groups, where: { id: [1, "$user.name"] } } }'), /where\.id": "\$user\.name" \(authors\.name: string\) is incompatible with field "id" in "groups" \(integer 1\.\.2\)/);

  // Compatible types succeed (boolean, string, enum, email->email, template email->string, integer->number, conditional)
  const okYaml = `name: ok-user-types
seed: 5
auth: { user: { entity: users, id: 1 } }
world:
  groups: { total: 2, fields: { name: string, active: boolean } }
  users: 2
  articles:
    total: 6
    ref: groups
    fields:
      owner_name: string
      contact_email: email
      raw_email: string
      role: [admin, operator]
      score: number
endpoints:
  - path: /api/by-name
    entity: articles
    filters: { owner_name: "$user.name" }
  - path: /api/by-email
    entity: articles
    filters: { contact_email: "$user.email", raw_email: "$user.email" }
  - path: /api/by-role
    entity: articles
    filters: { role: "$user.role" }
  - path: /api/by-score
    entity: articles
    filters: { score: "$user.id" }
  - path: /api/by-group-name
    entity: articles
    filters: { group_id: { from: groups, where: { name: "$user.name", active: true } } }
`;
  const okDs = generateWorld(normalizeScenario(parseYaml(okYaml, 'ok-types.yaml'), 'ok-types.yaml'));
  const okEng = createEngine(okDs);
  assert.equal(okEng.handle({ method: 'GET', pathname: '/api/by-role' }).status, 200);
  assert.equal(okEng.handle({ method: 'GET', pathname: '/api/by-email' }).status, 200);
  assert.equal(okEng.handle({ method: 'GET', pathname: '/api/by-score' }).status, 200);
  assert.equal(okEng.handle({ method: 'GET', pathname: '/api/by-group-name' }).status, 200);
});

// ---------- Custom envelope keys (`shape: envelope` + `envelope: { items, total, page, per_page }`) ----------

const ENVELOPE_SCENARIO = `name: custom-envelopes
seed: 3131
now: 2025-03-01T09:00:00Z
world:
  authors: 2
  articles:
    total: 15
    ref: authors
    fields:
      title: string
      status: [draft, published]
endpoints:
  - path: /api/articles
    entity: articles
    filters: [status, author_id]
    pagination: { param_limit: limit, param_offset: offset }
    sort: id
    shape: envelope
    envelope: { items: articles, total: articlesCount }
  - path: /api/paged-articles
    entity: articles
    filters: [status]
    pagination: { param_page: page, param_limit: per_page, default_limit: 4 }
    sort: id
    shape: envelope
    envelope: { items: articles, total: articlesCount, page: currentPage, per_page: pageSize }
  - path: /api/offset-paged
    entity: articles
    pagination: { param_limit: limit, param_offset: offset, default_limit: 5 }
    shape: envelope
    envelope: { items: rows, total: count, page: page }
  - path: /api/unpaginated-paged
    entity: articles
    shape: envelope
    envelope: { items: records, total: totalRecords, page: page, per_page: perPage }
  - path: /api/meta-articles
    entity: articles
    pagination: { param_page: page, param_limit: per_page, default_limit: 3 }
    shape: envelope
    envelope: { items: data, total: meta.total, page: meta.page, per_page: meta.per_page }
  - path: /api/default-envelope
    entity: articles
    pagination: { param_limit: limit, param_offset: offset }
    shape: envelope
`;

const envNorm = normalizeScenario(parseYaml(ENVELOPE_SCENARIO, 'env.yaml'), 'env.yaml');
const envDataset = generateWorld(envNorm);
const envEngine = createEngine(envDataset);
const getEnv = (path) => {
  const u = new URL(path, 'http://x');
  return envEngine.handle({ method: 'GET', pathname: u.pathname, query: u.searchParams });
};

test('envelope: custom keys without page/per_page return exact keys and omit page fields', () => {
  const r = getEnv('/api/articles?limit=3&offset=2');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['articles', 'articlesCount']);
  assert.deepEqual(r.body.articles.map((a) => a.id), [3, 4, 5]);
  assert.equal(r.body.articlesCount, 15);
  assert.equal(r.headers['x-total-count'], '15');

  // Filters update articlesCount consistently with X-Total-Count
  const pub = envDataset.entities.articles.filter((a) => a.status === 'published');
  const filtered = getEnv('/api/articles?status=published&limit=2&offset=0');
  assert.equal(filtered.status, 200);
  assert.deepEqual(Object.keys(filtered.body), ['articles', 'articlesCount']);
  assert.equal(filtered.body.articlesCount, pub.length);
  assert.equal(filtered.headers['x-total-count'], String(pub.length));
  assert.deepEqual(filtered.body.articles.map((a) => a.id), pub.slice(0, 2).map((a) => a.id));

  // Nested path key such as { data, meta: { total, page, per_page } }
  const meta = getEnv('/api/meta-articles?page=2&per_page=4');
  assert.equal(meta.status, 200);
  assert.deepEqual(Object.keys(meta.body), ['data', 'meta']);
  assert.deepEqual(meta.body.data.map((a) => a.id), [5, 6, 7, 8]);
  assert.deepEqual(meta.body.meta, { total: 15, page: 2, per_page: 4 });
});

test('envelope: custom keys with page and per_page (both page-based and offset-based)', () => {
  // Default page (1) and default_limit (4)
  const p1 = getEnv('/api/paged-articles');
  assert.equal(p1.status, 200);
  assert.deepEqual(Object.keys(p1.body), ['articles', 'articlesCount', 'currentPage', 'pageSize']);
  assert.deepEqual(p1.body.articles.map((a) => a.id), [1, 2, 3, 4]);
  assert.equal(p1.body.articlesCount, 15);
  assert.equal(p1.body.currentPage, 1);
  assert.equal(p1.body.pageSize, 4);

  // Explicit page & per_page query params
  const p2 = getEnv('/api/paged-articles?page=2&per_page=5');
  assert.equal(p2.status, 200);
  assert.deepEqual(p2.body.articles.map((a) => a.id), [6, 7, 8, 9, 10]);
  assert.equal(p2.body.articlesCount, 15);
  assert.equal(p2.body.currentPage, 2);
  assert.equal(p2.body.pageSize, 5);

  // Offset-based pagination derives 1-based page and omits per_page when not declared
  const off = getEnv('/api/offset-paged?limit=5&offset=10');
  assert.equal(off.status, 200);
  assert.deepEqual(Object.keys(off.body), ['rows', 'count', 'page']);
  assert.deepEqual(off.body.rows.map((a) => a.id), [11, 12, 13, 14, 15]);
  assert.equal(off.body.count, 15);
  assert.equal(off.body.page, 3);

  // Endpoint without pagination: page is 1 and per_page is null
  const unpag = getEnv('/api/unpaginated-paged');
  assert.equal(unpag.status, 200);
  assert.deepEqual(Object.keys(unpag.body), ['records', 'totalRecords', 'page', 'perPage']);
  assert.equal(unpag.body.records.length, 15);
  assert.equal(unpag.body.totalRecords, 15);
  assert.equal(unpag.body.page, 1);
  assert.equal(unpag.body.perPage, null);

  // Default envelope without `envelope:` keeps `{ data, total, limit, offset }` and scenarios without it keep their hash
  const def = getEnv('/api/default-envelope?limit=3&offset=1');
  assert.deepEqual(Object.keys(def.body), ['data', 'total', 'limit', 'offset']);
  assert.equal(def.body.total, 15);
  const shortNorm = normalizeScenario(parseYaml(SCENARIO, 's.yaml'), 's.yaml');
  assert.equal(shortNorm.endpoints[0].envelope, undefined);
  assert.equal(scenarioHash(shortNorm), dataset.hash);

  // Prism OpenAPI schema matches custom envelope keys (including nested meta)
  const oas = openapiDocument(envDataset, { mock: { baseUrl: 'http://127.0.0.1:4010' } });
  const articlesSchema = oas.paths['/api/articles'].get.responses[200].content['application/json'].schema;
  assert.deepEqual(Object.keys(articlesSchema.properties), ['articles', 'articlesCount']);
  assert.deepEqual(articlesSchema.required, ['articles', 'articlesCount']);
  const metaSchema = oas.paths['/api/meta-articles'].get.responses[200].content['application/json'].schema;
  assert.deepEqual(Object.keys(metaSchema.properties.meta.properties), ['total', 'page', 'per_page']);
});

test('envelope: validation rejects empty keys, duplicates, nested conflicts, pick conflicts, and non-envelope shape', () => {
  const parseErr = (epExtra) => {
    const yaml = `name: bad-env
seed: 1
world:
  articles: 3
endpoints:
  - path: /api/articles
    entity: articles
${epExtra}`;
    try {
      normalizeScenario(parseYaml(yaml, 'bad-env.yaml'), 'bad-env.yaml');
    } catch (e) {
      assert.ok(e instanceof AtrezzoError);
      assert.equal(e.exitCode, 3);
      return e.message;
    }
    assert.fail(`expected scenario validation error for:\n${epExtra}`);
  };

  assert.match(parseErr('    envelope: { items: articles, total: articlesCount }\n'), /envelope": requires shape: "envelope" \(got none \(default "array"\)\)/);
  assert.match(parseErr('    shape: array\n    envelope: { items: articles, total: articlesCount }\n'), /envelope": requires shape: "envelope" \(got "array"\)/);
  assert.match(parseErr('    shape: object\n    envelope: { items: articles, total: articlesCount }\n'), /envelope": requires shape: "envelope" \(got "object"\)/);
  assert.match(parseErr('    shape: envelope\n    pick: articles\n    envelope: { items: articles, total: articlesCount }\n'), /cannot combine "pick" with "envelope"/);
  assert.match(parseErr('    shape: envelope\n    envelope: {}\n'), /envelope": must be a non-empty map/);
  assert.match(parseErr('    shape: envelope\n    envelope: articles\n'), /envelope": must be a non-empty map/);
  assert.match(parseErr('    shape: envelope\n    envelope: { items: articles, offset: skip }\n'), /envelope\.offset": unknown field \(allowed: items, total, page, per_page, total_pages\)/);
  assert.match(parseErr('    shape: envelope\n    envelope: { items: "", total: articlesCount }\n'), /envelope\.items": must be a non-empty key name/);
  assert.match(parseErr('    shape: envelope\n    envelope: { items: "   ", total: articlesCount }\n'), /envelope\.items": must be a non-empty key name/);
  assert.match(parseErr('    shape: envelope\n    envelope: { items: articles, total: null }\n'), /envelope\.total": must be a non-empty key name/);
  assert.match(parseErr('    shape: envelope\n    envelope: { items: articles, total: "meta..total" }\n'), /envelope\.total": invalid key "meta\.\.total"/);
  assert.match(parseErr('    shape: envelope\n    envelope: { items: articles, total: articles }\n'), /envelope\.total": duplicate key "articles" \(already used by "items"\)/);
  assert.match(parseErr('    shape: envelope\n    envelope: { items: articles, total: articlesCount, page: articlesCount }\n'), /envelope\.page": duplicate key "articlesCount" \(already used by "total"\)/);
  assert.match(parseErr('    shape: envelope\n    envelope: { total: data }\n'), /envelope\.total": duplicate key "data" \(already used by "items" default\)/);
  assert.match(parseErr('    shape: envelope\n    envelope: { items: meta, total: meta.total }\n'), /envelope\.total": key "meta\.total" conflicts with nested key "meta"/);
});

test('envelope: serve and verify handle custom envelope keys identically (with and without page)', async () => {
  const dir = tmpProject({
    'scenarios/custom-envelopes.yaml': ENVELOPE_SCENARIO,
    'flow.yaml': `scenario: scenarios/custom-envelopes.yaml
steps:
  - screen: feed
    requests:
      articles: GET /api/articles?limit=5&offset=0
      paged: GET /api/paged-articles?page=2&per_page=4
      meta: GET /api/meta-articles?page=1&per_page=3
    expect:
      - selector: "[data-testid=article-row]"
        count: 5
        data: { request: articles }
      - selector: "[data-testid=paged-row]"
        count: 4
        data: { request: paged, pick: articles }
      - selector: "[data-testid=meta-row]"
        count: 3
        data: { request: meta }
`,
    'flow-ko.yaml': `scenario: scenarios/custom-envelopes.yaml
steps:
  - screen: feed
    requests:
      articles: GET /api/articles?limit=4&offset=0
    expect:
      - selector: "[data-testid=published]"
        count: ${envDataset.entities.articles.filter((a) => a.status === 'published').length}
        data: { request: articles, where: { status: published } }
`,
  });
  const mock = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'custom-envelopes' });
  const url = `http://127.0.0.1:${(await mock.listen(0)).port}`;
  try {
    for (const path of [
      '/api/articles?limit=3&offset=2',
      '/api/paged-articles?page=2&per_page=5',
      '/api/meta-articles?page=2&per_page=4',
      '/api/default-envelope?limit=3&offset=1',
    ]) {
      const res = await fetch(`${url}${path}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      const expected = getEnv(path);
      assert.deepEqual(body, expected.body, path);
      assert.equal(res.headers.get('x-total-count'), expected.headers['x-total-count'], path);
    }

    const ok = await runVerify(loadFlow(join(dir, 'flow.yaml')), { url, driver: 'http' });
    assert.equal(ok.exitCode, 0);
    assert.deepEqual(ok.rows.map((r) => [r.obtained, r.status]), [[5, 'OK'], [4, 'OK'], [3, 'OK']]);

    // When paginated, verify --diagnose inspects the unpaginated custom envelope too
    const ko = await runVerify(loadFlow(join(dir, 'flow-ko.yaml')), { url, driver: 'http', diagnose: true });
    const pubTotal = envDataset.entities.articles.filter((a) => a.status === 'published').length;
    const pubPage1 = envDataset.entities.articles.slice(0, 4).filter((a) => a.status === 'published').length;
    if (pubPage1 < pubTotal) {
      assert.equal(ko.exitCode, 1);
      assert.ok(ko.rows[0].hypotheses.some((h) => h.type === 'pagination-mismatch'));
    } else {
      assert.equal(ko.exitCode, 0);
    }
  } finally {
    await mock.close();
  }
});

// ---------- Child counts (`counts: { <name>: { entity, on } }`) ----------

const COUNTS_SCENARIO = `name: kanban-counts
seed: 5150
now: 2025-03-01T09:00:00Z
world:
  boards: 2
  buckets:
    total: 5
    ref: boards
    counts:
      notes: { entity: notes, on: bucket_id }
    fields:
      title: string
      archived: boolean
  tasks:
    total: 18
    ref: buckets
    nulls: { bucket_id: 3 }
    fields:
      title: string
  notes:
    total: 7
    ref: buckets
    fields:
      body: string
endpoints:
  - path: /api/buckets
    entity: buckets
    filters: [id, board_id, archived]
    pagination: { param_limit: limit, param_offset: offset }
    sort: id
    counts:
      tasks: { entity: tasks, on: bucket_id }
      count: { entity: tasks, on: bucket_id }
  - path: /api/boards/:board_id/buckets
    entity: buckets
    filters: [archived]
    counts:
      tasks_total: { entity: tasks, on: bucket_id }
  - path: /api/buckets-envelope
    entity: buckets
    pagination: { param_limit: limit, param_offset: offset, default_limit: 2 }
    shape: envelope
    counts:
      tasks: { entity: tasks, on: bucket_id }
  - path: /api/first-bucket
    entity: buckets
    filters: [archived]
    sort: id
    shape: object
    counts:
      count: { entity: tasks, on: bucket_id }
  - path: /api/buckets-entity-only
    entity: buckets
`;

const countsNorm = normalizeScenario(parseYaml(COUNTS_SCENARIO, 'counts.yaml'), 'counts.yaml');
const countsDataset = generateWorld(countsNorm);
const countsEngine = createEngine(countsDataset);
const getCounts = (path) => {
  const u = new URL(path, 'http://x');
  return countsEngine.handle({ method: 'GET', pathname: u.pathname, query: u.searchParams });
};

test('counts: endpoint and entity counts expose numeric tasks_count / declared names matching world rows', () => {
  const expectedTasks = (bucketId) => countsDataset.entities.tasks.filter((t) => t.bucket_id === bucketId).length;
  const expectedNotes = (bucketId) => countsDataset.entities.notes.filter((n) => n.bucket_id === bucketId).length;

  const r = getCounts('/api/buckets');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 5);
  for (const row of r.body) {
    assert.equal(typeof row.tasks_count, 'number');
    assert.equal(typeof row.count, 'number');
    assert.equal(typeof row.notes_count, 'number');
    assert.equal(row.tasks_count, expectedTasks(row.id));
    assert.equal(row.count, expectedTasks(row.id));
    assert.equal(row.notes_count, expectedNotes(row.id));
  }
  // Null bucket_id tasks (3 of 18) are excluded; remaining 15 sum across the 5 buckets
  assert.equal(r.body.reduce((s, row) => s + row.tasks_count, 0), 15);
  assert.equal(r.body.reduce((s, row) => s + row.notes_count, 0), 7);

  // Entity-only endpoint inherits world.buckets.counts without endpoint-level counts
  const entOnly = getCounts('/api/buckets-entity-only');
  assert.equal(entOnly.status, 200);
  for (const row of entOnly.body) {
    assert.equal(row.notes_count, expectedNotes(row.id));
    assert.equal(row.tasks_count, undefined);
  }

  // Deterministic across runs and never mutates dataset.entities; scenarios without counts keep their hash
  const again = createEngine(generateWorld(normalizeScenario(parseYaml(COUNTS_SCENARIO, 'counts.yaml'), 'counts.yaml')));
  assert.deepEqual(again.handle({ pathname: '/api/buckets', query: new URLSearchParams() }).body, r.body);
  assert.ok(countsDataset.entities.buckets.every((b) => !('tasks_count' in b) && !('count' in b) && !('notes_count' in b)));

  const shortNorm = normalizeScenario(parseYaml(SCENARIO, 's.yaml'), 's.yaml');
  assert.equal(shortNorm.endpoints[0].counts, undefined);
  assert.equal(shortNorm.world[0].counts, undefined);
  assert.equal(scenarioHash(shortNorm), dataset.hash);
});

test('counts: respects endpoint filters and pagination without filtering or limiting counted world rows', () => {
  const expectedTasks = (bucketId) => countsDataset.entities.tasks.filter((t) => t.bucket_id === bucketId).length;
  const expectedNotes = (bucketId) => countsDataset.entities.notes.filter((n) => n.bucket_id === bucketId).length;

  // Pagination limit=2 still counts all world tasks for each returned bucket
  const limited = getCounts('/api/buckets?limit=2&offset=1');
  assert.equal(limited.status, 200);
  assert.equal(limited.body.length, 2);
  assert.deepEqual(limited.body.map((b) => b.id), [2, 3]);
  for (const row of limited.body) {
    assert.equal(row.tasks_count, expectedTasks(row.id));
    assert.equal(row.count, expectedTasks(row.id));
  }

  // Query filter on parent rows respects filter and keeps world counts
  const activeBuckets = countsDataset.entities.buckets.filter((b) => b.archived === false);
  assert.ok(activeBuckets.length > 0 && activeBuckets.length < 5);
  const filtered = getCounts('/api/buckets?archived=false');
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.map((b) => b.id), activeBuckets.map((b) => b.id));
  for (const row of filtered.body) {
    assert.equal(row.tasks_count, expectedTasks(row.id));
    assert.equal(row.notes_count, expectedNotes(row.id));
  }

  // Path parameter route (/api/boards/1/buckets) + custom name tasks_total
  const board1Buckets = countsDataset.entities.buckets.filter((b) => b.board_id === 1);
  const byParam = getCounts('/api/boards/1/buckets');
  assert.equal(byParam.status, 200);
  assert.deepEqual(byParam.body.map((b) => b.id), board1Buckets.map((b) => b.id));
  for (const row of byParam.body) {
    assert.equal(row.tasks_total, expectedTasks(row.id));
    assert.equal(row.notes_count, expectedNotes(row.id));
  }

  // Detail route, envelope shape, and object shape all include the counts
  const detail = getCounts('/api/buckets/3');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.tasks_count, expectedTasks(3));
  assert.equal(detail.body.count, expectedTasks(3));

  const env = getCounts('/api/buckets-envelope?limit=2&offset=0');
  assert.equal(env.status, 200);
  assert.equal(env.body.total, 5);
  assert.equal(env.body.data.length, 2);
  for (const row of env.body.data) assert.equal(row.tasks_count, expectedTasks(row.id));

  const single = getCounts('/api/first-bucket?archived=false');
  assert.equal(single.status, 200);
  assert.equal(single.body.id, activeBuckets[0].id);
  assert.equal(single.body.count, expectedTasks(activeBuckets[0].id));

  // Prism OpenAPI schema declares count fields as required integers
  const oas = openapiDocument(countsDataset, { mock: { baseUrl: 'http://127.0.0.1:4010' } });
  const bucketSchema = oas.paths['/api/buckets'].get.responses[200].content['application/json'].schema.items;
  const extra = bucketSchema.allOf[1];
  assert.deepEqual(extra.properties.tasks_count, { type: 'integer' });
  assert.deepEqual(extra.properties.count, { type: 'integer' });
  assert.deepEqual(extra.properties.notes_count, { type: 'integer' });
  assert.ok(extra.required.includes('tasks_count') && extra.required.includes('count') && extra.required.includes('notes_count'));
});

test('counts: empty child world or parent rows with zero children yield 0', () => {
  const emptyChildrenYaml = `name: empty-child-counts
seed: 12
world:
  buckets: 3
  tasks:
    total: 0
    ref: buckets
endpoints:
  - path: /api/buckets
    entity: buckets
    counts:
      tasks: { entity: tasks, on: bucket_id }
      count: { entity: tasks, on: bucket_id }
`;
  const dsEmptyChild = generateWorld(normalizeScenario(parseYaml(emptyChildrenYaml, 'ec.yaml'), 'ec.yaml'));
  const engEmptyChild = createEngine(dsEmptyChild);
  const res = engEmptyChild.handle({ method: 'GET', pathname: '/api/buckets' });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 3);
  for (const row of res.body) {
    assert.strictEqual(row.tasks_count, 0);
    assert.strictEqual(row.count, 0);
  }

  // Fewer children than parents (or all FKs null) also yields 0 for uncovered parents
  const partialYaml = `name: partial-counts
seed: 12
world:
  buckets: 4
  tasks:
    total: 2
    ref: buckets
    nulls: { bucket_id: 2 }
endpoints:
  - path: /api/buckets
    entity: buckets
    counts:
      tasks: { entity: tasks, on: bucket_id }
`;
  const dsPartial = generateWorld(normalizeScenario(parseYaml(partialYaml, 'p.yaml'), 'p.yaml'));
  const engPartial = createEngine(dsPartial);
  const partialRes = engPartial.handle({ method: 'GET', pathname: '/api/buckets' });
  assert.equal(partialRes.status, 200);
  assert.deepEqual(partialRes.body.map((b) => b.tasks_count), [0, 0, 0, 0]);

  // Empty parent and empty child world
  const emptyBothYaml = `name: empty-both
seed: 12
world:
  buckets: 0
  tasks: { total: 0, ref: buckets }
endpoints:
  - path: /api/buckets
    entity: buckets
    counts:
      tasks: { entity: tasks, on: bucket_id }
`;
  const dsBoth = generateWorld(normalizeScenario(parseYaml(emptyBothYaml, 'eb.yaml'), 'eb.yaml'));
  const bothRes = createEngine(dsBoth).handle({ method: 'GET', pathname: '/api/buckets' });
  assert.equal(bothRes.status, 200);
  assert.deepEqual(bothRes.body, []);
});

test('counts: validation rejects undeclared entity, nonexistent or non-FK field, wrong target FK, and duplicates', () => {
  const parseErr = (yaml) => {
    try {
      normalizeScenario(parseYaml(yaml, 'bad-counts.yaml'), 'bad-counts.yaml');
    } catch (e) {
      assert.ok(e instanceof AtrezzoError);
      assert.equal(e.exitCode, 3);
      return e.message;
    }
    assert.fail(`expected scenario validation error for:\n${yaml}`);
  };

  const base = (epExtra, worldExtra = '') => `name: bad-counts
seed: 1
world:
  boards: 2
  buckets: 3
  tasks:
    total: 5
    ref: [buckets, boards]
    fields: { title: string }
${worldExtra}endpoints:
  - path: /api/buckets
    entity: buckets
${epExtra}`;

  assert.match(parseErr(base('    counts: { tasks: { entity: ghosts, on: bucket_id } }\n')), /counts\.tasks\.entity": "ghosts" is not declared in world/);
  assert.match(parseErr(base('    counts: { tasks: { entity: tasks, on: missing_id } }\n')), /counts\.tasks\.on": field "missing_id" does not exist in "tasks"/);
  assert.match(parseErr(base('    counts: { tasks: { entity: tasks, on: title } }\n')), /counts\.tasks\.on": "title" is not a foreign key of "tasks"/);
  assert.match(parseErr(base('    counts: { tasks: { entity: tasks, on: board_id } }\n')), /counts\.tasks\.on": "board_id" is a foreign key to "boards", not "buckets"/);
  assert.match(parseErr(base('    counts: { tasks: { entity: tasks } }\n')), /counts\.tasks\.on": required; foreign key field on "tasks" pointing to "buckets"/);
  assert.match(parseErr(base('    counts: { tasks: { on: bucket_id } }\n')), /counts\.tasks\.entity": required; a declared world entity/);
  assert.match(parseErr(base('    counts: { tasks: { entity: tasks, on: bucket_id, extra: 1 } }\n')), /counts\.tasks\.extra": unknown field/);
  assert.match(parseErr(base('    counts: {}\n')), /endpoints\[0\]\.counts": must be a non-empty map/);
  assert.match(parseErr(base('    counts: { tasks: { entity: tasks, on: bucket_id }, tasks_count: { entity: tasks, on: bucket_id } }\n')), /duplicate output field "tasks_count"/);
  assert.match(parseErr(base('    pluck: name\n    counts: { tasks: { entity: tasks, on: bucket_id } }\n')), /pluck": incompatible with counts/);

  // Count field colliding with existing parent field (endpoint or entity level)
  assert.match(parseErr(base('    counts: { name: { entity: tasks, on: bucket_id } }\n')), /counts\.name": "name" is already a field of "buckets"/);
  assert.match(parseErr(`name: bad-field-collision
seed: 1
world:
  buckets:
    total: 3
    fields: { title: string, count: integer, tasks_count: integer }
  tasks:
    total: 5
    ref: buckets
endpoints:
  - path: /api/buckets
    entity: buckets
    counts:
      count: { entity: tasks, on: bucket_id }
`), /counts\.count": "count" is already a field of "buckets"/);
  assert.match(parseErr(`name: bad-ent-field-collision
seed: 1
world:
  buckets:
    total: 3
    fields: { title: string, tasks_count: integer }
    counts:
      tasks: { entity: tasks, on: bucket_id }
  tasks:
    total: 5
    ref: buckets
endpoints:
  - path: /api/buckets
    entity: buckets
`), /world\.buckets\.counts\.tasks": "tasks_count" is already a field of "buckets"/);

  // Count field colliding with embed or include on the same endpoint
  assert.match(parseErr(`name: bad-embed-count-collision
seed: 1
world:
  buckets:
    total: 3
    fields: { title: string }
  tasks:
    total: 5
    ref: buckets
  notes:
    total: 4
    ref: buckets
endpoints:
  - path: /api/buckets
    entity: buckets
    embed: [tasks]
    counts:
      tasks: { entity: notes, on: bucket_id }
`), /count field "tasks" conflicts with embedded "tasks"/);
  assert.match(parseErr(`name: bad-include-count-collision
seed: 1
world:
  boards: 2
  buckets:
    total: 3
    ref: boards
    fields: { title: string }
  tasks:
    total: 5
    ref: buckets
endpoints:
  - path: /api/buckets
    entity: buckets
    include: [boards]
    counts:
      board: { entity: tasks, on: bucket_id }
`), /count field "board" conflicts with included "board"/);

  // Inherited world.<entity>.counts combined with pluck on an endpoint
  assert.match(parseErr(`name: bad-ent-counts-pluck
seed: 1
world:
  buckets:
    total: 3
    counts:
      tasks: { entity: tasks, on: bucket_id }
  tasks:
    total: 5
    ref: buckets
endpoints:
  - path: /api/bucket-ids
    entity: buckets
    pluck: id
`), /endpoints\[0\]\.pluck": incompatible with counts/);

  // Entity-level validation rejects nonexistent FK too
  assert.match(parseErr(`name: bad-ent-counts
seed: 1
world:
  buckets:
    total: 3
    counts:
      tasks: { entity: tasks, on: missing_fk }
  tasks:
    total: 5
    ref: buckets
endpoints:
  - path: /api/buckets
    entity: buckets
`), /world\.buckets\.counts\.tasks\.on": field "missing_fk" does not exist in "tasks"/);
});

// ---------- Business writes (`writes: { "METHOD /path": { expect, mutate } }`) ----------

const WRITES_SCENARIO = `name: writes-orders
seed: 7712
now: 2025-03-01T09:00:00Z
world:
  customers: 3
  orders:
    total: 5
    distribution: { paid: 3, pending: 1, issue: 1 }
    amount: { min: 20, max: 500, currency: EUR }
endpoints:
  - path: /api/orders
    entity: orders
    filters: [status, customer_id]
    pagination: { param_limit: limit, param_offset: offset }
    sort: id
    include: [customers]
  - path: /api/customers
    entity: customers
    counts:
      orders: { entity: orders, on: customer_id }
writes:
  "POST /api/orders":
    expect: { status: 201, echo: true }
    mutate: { entity: orders, set: { status: "nuevo" } }
  "POST /api/customers/:customer_id/orders":
    expect: { status: 201, echo: true }
    mutate: { entity: orders, set: { status: "nuevo" } }
  "PATCH /api/orders/:id":
    expect: { status: 200, echo: true }
    mutate: { entity: orders, set: { status: "enviado" } }
  "PUT /api/orders/:id":
    expect: { status: 200, echo: true }
    mutate: { entity: orders }
  "DELETE /api/orders/:id":
    expect: { status: 204 }
    mutate: { entity: orders }
  "POST /api/orders/:id/cancel":
    expect: { status: 200, body: { cancelled: true } }
    mutate: { entity: orders, action: update, set: { status: "cancelled" } }
  "POST /api/customers":
    expect: { status: 201, echo: true }
    mutate: { entity: customers }
  "POST /api/echo-only":
    expect: { status: 200, echo: true }
`;

test('writes: POST creates, PATCH/PUT updates, DELETE removes, and reset restores initial world', () => {
  const norm = normalizeScenario(parseYaml(WRITES_SCENARIO, 'w.yaml'), 'w.yaml');
  const ds = generateWorld(norm);
  const eng = createEngine(ds);

  // Scenarios without writes keep their exact normalized form and hash
  const plainNorm = normalizeScenario(parseYaml(SCENARIO, 's.yaml'), 's.yaml');
  assert.equal(plainNorm.writes, undefined);
  assert.equal(scenarioHash(plainNorm), dataset.hash);

  // POST creates a new row with next id (6) and set overrides (status: "nuevo")
  const created = eng.handle({
    method: 'POST',
    pathname: '/api/orders',
    body: { customer_id: 2, amount: 149.5, status: 'paid' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.id, 6);
  assert.equal(created.body.customer_id, 2);
  assert.equal(created.body.amount, 149.5);
  assert.equal(created.body.status, 'nuevo');

  // Subsequent GET reads see the newly created row (list, filter, detail, counts, include)
  const listNuevo = eng.handle({ method: 'GET', pathname: '/api/orders', query: { status: 'nuevo' } });
  assert.equal(listNuevo.status, 200);
  assert.equal(listNuevo.body.length, 1);
  assert.equal(listNuevo.body[0].id, 6);
  assert.equal(listNuevo.body[0].customer.id, 2);
  const detail6 = eng.handle({ method: 'GET', pathname: '/api/orders/6' });
  assert.equal(detail6.status, 200);
  assert.equal(detail6.body.status, 'nuevo');
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/orders' }).headers['x-total-count'], '6');

  // Customer count index was invalidated and reflects the new order
  const c2Before = ds.entities.orders.filter((o) => o.customer_id === 2).length;
  const cust2 = eng.handle({ method: 'GET', pathname: '/api/customers/2' });
  assert.equal(cust2.body.orders_count, c2Before + 1);

  // Nested POST binds :customer_id from path as integer
  const nestedCreated = eng.handle({ method: 'POST', pathname: '/api/customers/3/orders', body: { amount: 88 } });
  assert.equal(nestedCreated.status, 201);
  assert.equal(nestedCreated.body.id, 7);
  assert.equal(nestedCreated.body.customer_id, 3);
  assert.equal(nestedCreated.body.status, 'nuevo');

  // PATCH changes the targeted row in memory and subsequent GET reflects it
  const patched = eng.handle({ method: 'PATCH', pathname: '/api/orders/6', body: { amount: 200 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.id, 6);
  assert.equal(patched.body.amount, 200);
  assert.equal(patched.body.status, 'enviado');
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/orders/6' }).body.status, 'enviado');
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/orders/6' }).body.amount, 200);

  // PUT updates row while preserving existing fields
  const putRes = eng.handle({ method: 'PUT', pathname: '/api/orders/1', body: { status: 'review', amount: 310 } });
  assert.equal(putRes.status, 200);
  assert.equal(putRes.body.id, 1);
  assert.equal(putRes.body.status, 'review');
  assert.equal(putRes.body.reference, ds.entities.orders[0].reference);

  // Custom RPC-style POST with action: update and static body
  const cancelRes = eng.handle({ method: 'POST', pathname: '/api/orders/2/cancel' });
  assert.equal(cancelRes.status, 200);
  assert.deepEqual(cancelRes.body, { cancelled: true });
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/orders/2' }).body.status, 'cancelled');

  // DELETE removes the row; subsequent GET returns 404; second DELETE returns 404
  const delRes = eng.handle({ method: 'DELETE', pathname: '/api/orders/6' });
  assert.equal(delRes.status, 204);
  assert.equal(delRes.body, null);
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/orders/6' }).status, 404);
  assert.equal(eng.handle({ method: 'DELETE', pathname: '/api/orders/6' }).status, 404);
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/orders' }).headers['x-total-count'], '6');

  // Missing row on PATCH/PUT returns 404
  assert.equal(eng.handle({ method: 'PATCH', pathname: '/api/orders/999', body: { amount: 1 } }).status, 404);

  // Undeclared write method on existing path returns 405 with accurate Allow header
  const disallowed = eng.handle({ method: 'DELETE', pathname: '/api/orders' });
  assert.equal(disallowed.status, 405);
  assert.equal(disallowed.headers.allow, 'GET, POST');

  // reset() restores the exact initial world and id counters without mutating input dataset
  eng.reset();
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/orders' }).headers['x-total-count'], '5');
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/orders/6' }).status, 404);
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/orders/1' }).body.status, ds.entities.orders[0].status);
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/customers/2' }).body.orders_count, c2Before);
  assert.equal(eng.handle({ method: 'POST', pathname: '/api/orders', body: { customer_id: 1 } }).body.id, 6);
  assert.equal(ds.entities.orders.length, 5);
});

test('writes: determinism — response body does not depend on key arrival order or cross-entity write order', () => {
  const ds = generateWorld(normalizeScenario(parseYaml(WRITES_SCENARIO, 'w.yaml'), 'w.yaml'));
  const e1 = createEngine(ds);
  const e2 = createEngine(ds);

  // Different key arrival order in request body produces byte-for-byte identical JSON
  const r1 = e1.handle({ method: 'POST', pathname: '/api/orders', body: { amount: 55, customer_id: 1, reference: 'ORD-NEW', extra_z: 1, extra_a: 2 } });
  const r2 = e2.handle({ method: 'POST', pathname: '/api/orders', body: { extra_a: 2, reference: 'ORD-NEW', extra_z: 1, customer_id: 1, amount: 55 } });
  assert.equal(JSON.stringify(r1.body), JSON.stringify(r2.body));
  assert.deepEqual(Object.keys(r1.body), ['id', 'reference', 'customer_id', 'status', 'amount', 'customer']);
  assert.equal('extra_a' in r1.body, false);
  assert.equal('extra_z' in r1.body, false);

  // Echo-only write sorts keys deterministically regardless of arrival order
  const eo1 = e1.handle({ method: 'POST', pathname: '/api/echo-only', body: { z: 1, a: { d: 4, c: 3 } } });
  const eo2 = e2.handle({ method: 'POST', pathname: '/api/echo-only', body: { a: { c: 3, d: 4 }, z: 1 } });
  assert.equal(JSON.stringify(eo1.body), JSON.stringify(eo2.body));

  // Cross-entity arrival order: creating a customer before vs after an order yields the same order response body
  e1.reset();
  e2.reset();
  const orderFirst = e1.handle({ method: 'POST', pathname: '/api/orders', body: { customer_id: 1, amount: 42 } });
  e1.handle({ method: 'POST', pathname: '/api/customers', body: { name: 'Acme' } });

  e2.handle({ method: 'POST', pathname: '/api/customers', body: { name: 'Acme' } });
  const orderSecond = e2.handle({ method: 'POST', pathname: '/api/orders', body: { customer_id: 1, amount: 42 } });
  assert.equal(JSON.stringify(orderFirst.body), JSON.stringify(orderSecond.body));

  // Different arrival order of PATCHes on distinct rows keeps GET sort deterministic and response bodies identical
  e1.reset();
  e2.reset();
  const p1A = e1.handle({ method: 'PATCH', pathname: '/api/orders/1', body: { amount: 111 } });
  const p1B = e1.handle({ method: 'PATCH', pathname: '/api/orders/2', body: { amount: 222 } });
  const p2B = e2.handle({ method: 'PATCH', pathname: '/api/orders/2', body: { amount: 222 } });
  const p2A = e2.handle({ method: 'PATCH', pathname: '/api/orders/1', body: { amount: 111 } });
  assert.equal(JSON.stringify(p1A.body), JSON.stringify(p2A.body));
  assert.equal(JSON.stringify(p1B.body), JSON.stringify(p2B.body));
  assert.equal(
    JSON.stringify(e1.handle({ method: 'GET', pathname: '/api/orders' }).body),
    JSON.stringify(e2.handle({ method: 'GET', pathname: '/api/orders' }).body),
  );
});

test('writes: unknown request fields are dropped and echo: true matches subsequent GET projection', () => {
  const ds = generateWorld(normalizeScenario(parseYaml(WRITES_SCENARIO, 'w.yaml'), 'w.yaml'));
  const eng = createEngine(ds);

  const created = eng.handle({
    method: 'POST',
    pathname: '/api/orders',
    body: { customer_id: 2, amount: 149.5, unknown_field: 'should-not-leak', extra: { nested: 1 } },
  });
  assert.equal(created.status, 201);
  assert.equal('unknown_field' in created.body, false);
  assert.equal('extra' in created.body, false);
  const fetchedCreated = eng.handle({ method: 'GET', pathname: `/api/orders/${created.body.id}` });
  assert.equal(fetchedCreated.status, 200);
  assert.deepEqual(created.body, fetchedCreated.body);
  assert.equal(JSON.stringify(created.body), JSON.stringify(fetchedCreated.body));
  assert.equal('unknown_field' in eng.dataset.entities.orders.at(-1), false);

  const patched = eng.handle({
    method: 'PATCH',
    pathname: `/api/orders/${created.body.id}`,
    body: { amount: 250, unknown_patch_field: true },
  });
  assert.equal(patched.status, 200);
  assert.equal('unknown_patch_field' in patched.body, false);
  const fetchedPatched = eng.handle({ method: 'GET', pathname: `/api/orders/${created.body.id}` });
  assert.deepEqual(patched.body, fetchedPatched.body);
  assert.equal(JSON.stringify(patched.body), JSON.stringify(fetchedPatched.body));

  const putRes = eng.handle({
    method: 'PUT',
    pathname: '/api/orders/1',
    body: { amount: 333, unknown_put_field: 'nope' },
  });
  assert.equal(putRes.status, 200);
  assert.equal('unknown_put_field' in putRes.body, false);
  const fetchedPut = eng.handle({ method: 'GET', pathname: '/api/orders/1' });
  assert.deepEqual(putRes.body, fetchedPut.body);
  assert.equal(JSON.stringify(putRes.body), JSON.stringify(fetchedPut.body));

  const createdCustomer = eng.handle({
    method: 'POST',
    pathname: '/api/customers',
    body: { name: 'Beta Co', bogus: 42 },
  });
  assert.equal(createdCustomer.status, 201);
  assert.equal('bogus' in createdCustomer.body, false);
  const fetchedCustomer = eng.handle({ method: 'GET', pathname: `/api/customers/${createdCustomer.body.id}` });
  assert.deepEqual(createdCustomer.body, fetchedCustomer.body);
  assert.equal(JSON.stringify(createdCustomer.body), JSON.stringify(fetchedCustomer.body));
});

test('writes: validation rejects missing method, unsupported method, unknown entity, unknown fields, and invalid expect/mutate', () => {
  const parseErr = (writesBlock, extraWorld = '') => {
    const yaml = `name: bad-writes
seed: 1
world:
  customers: 2
  orders:
    total: 3
    ref: customers
    fields: { title: string, status: [open, closed] }
${extraWorld}endpoints:
  - path: /api/orders
    entity: orders
writes:
${writesBlock}`;
    try {
      normalizeScenario(parseYaml(yaml, 'bad-writes.yaml'), 'bad-writes.yaml');
    } catch (e) {
      assert.ok(e instanceof AtrezzoError);
      assert.equal(e.exitCode, 3);
      return e.message;
    }
    assert.fail(`expected scenario validation error for:\n${writesBlock}`);
  };

  assert.match(parseErr('  "/api/orders":\n    expect: { status: 201 }\n'), /must include an explicit HTTP method \(POST, PUT, PATCH, DELETE\)/);
  assert.match(parseErr('  "GET /api/orders":\n    expect: { status: 200 }\n'), /method "GET" is not supported in writes; use POST, PUT, PATCH, DELETE/);
  assert.match(parseErr('  "post /api/orders":\n    expect: { status: 201 }\n'), /method "post" is not supported in writes/);
  assert.match(parseErr('  "POST api/orders":\n    expect: { status: 201 }\n'), /must start with "\/"/);
  assert.match(parseErr('  "POST /api/orders?x=1":\n    expect: { status: 201 }\n'), /must not contain whitespace, query or fragment/);
  assert.match(parseErr('  "PATCH /api/orders/:id":\n    expect: { status: 200 }\n  "PATCH /api/orders/:order_id":\n    expect: { status: 200 }\n'), /duplicate write route/);
  assert.match(parseErr('  "POST /api/orders":\n    expect: { status: 201 }\n    mutate: { entity: ghosts, set: { status: "nuevo" } }\n'), /mutate\.entity": "ghosts" is not declared in world/);
  assert.match(parseErr('  "POST /api/orders":\n    expect: { status: 201 }\n    mutate: { set: { status: "nuevo" } }\n'), /mutate\.entity": required; a declared world entity/);
  assert.match(parseErr('  "POST /api/orders":\n    expect: { status: 201 }\n    mutate: { entity: orders, set: { missing_field: "x" } }\n'), /mutate\.set\.missing_field": field "missing_field" does not exist in "orders"/);
  assert.match(parseErr('  "POST /api/orders":\n    expect: { status: 201 }\n    mutate: { entity: orders, set: { id: 99 } }\n'), /mutate\.set\.id": "id" is managed by atrezzo/);
  assert.match(parseErr('  "POST /api/orders":\n    expect: { status: 201 }\n    mutate: { entity: orders, set: { status: { nested: 1 } } }\n'), /mutate\.set\.status": must be a scalar value/);
  assert.match(parseErr('  "PATCH /api/orders/:ghost_id":\n    expect: { status: 200 }\n    mutate: { entity: orders, set: { status: "nuevo" } }\n'), /parameter ":ghost_id" does not match any field of "orders"/);
  assert.match(parseErr('  "DELETE /api/orders/:id":\n    expect: { status: 204 }\n    mutate: { entity: orders, set: { status: "x" } }\n'), /mutate\.set": "set" cannot be used with delete/);
  assert.match(parseErr('  "POST /api/orders":\n    expect: { status: 201 }\n    mutate: { entity: orders, where: { status: open } }\n'), /mutate\.where": "where" cannot be used with create/);
  assert.match(parseErr('  "DELETE /api/orders":\n    expect: { status: 204 }\n    mutate: { entity: orders, where: { bogus: 1 } }\n'), /mutate\.where\.bogus": field "bogus" does not exist in "orders"/);
  assert.match(parseErr('  "POST /api/orders":\n    expect: { status: 201, echo: true, body: { ok: true } }\n'), /use "echo: true" or "body", not both/);
  assert.match(parseErr('  "DELETE /api/orders/:id":\n    expect: { status: 204, echo: true }\n    mutate: { entity: orders }\n'), /status 204 cannot have a response body/);
  assert.match(parseErr('  "POST /api/orders":\n    expect: { status: 999 }\n'), /expect\.status": must be an integer HTTP status between 200 and 599/);
  assert.match(parseErr('  "POST /api/orders": {}\n'), /must declare "expect" and\/or "mutate"/);

  // Empty writes map or missing auth user
  assert.throws(
    () => normalizeScenario(parseYaml('name: e\nseed: 1\nworld:\n  orders: 2\nendpoints:\n  - path: /api/orders\n    entity: orders\nwrites: {}\n', 'e.yaml'), 'e.yaml'),
    (e) => e instanceof AtrezzoError && /field "writes": must be a non-empty map/.test(e.message),
  );
  assert.throws(
    () => normalizeScenario(parseYaml('name: e\nseed: 1\nworld:\n  orders: 2\nendpoints:\n  - path: /api/orders\n    entity: orders\nwrites:\n  "POST /api/orders":\n    expect: { status: 201 }\n    mutate: { entity: orders, set: { status: "$user.name" } }\n', 'e.yaml'), 'e.yaml'),
    (e) => e instanceof AtrezzoError && /requires a top-level "auth: \{ user: \{ entity, id \} \}"/.test(e.message),
  );
});

test('writes: no mutate on a contract endpoint route ⇒ entity inferred; elsewhere or with mutate: false ⇒ stateless', () => {
  const norm = (writesBlock, endpointsExtra = '') => normalizeScenario(parseYaml(`name: infer
seed: 1
world:
  boards: 2
  cards:
    total: 4
    ref: boards
    fields: { title: string }
  profile:
    total: 1
    fields: { title: string }
endpoints:
  - path: /api/cards
    entity: cards
  - path: /api/boards/:board_id/cards
    entity: cards
  - path: /api/profile
    entity: profile
    shape: object
${endpointsExtra}writes:
${writesBlock}`, 'i.yaml'), 'i.yaml').writes;

  const w = norm(`  "POST /api/cards": { expect: { status: 201 } }
  "PATCH /api/cards/:id": { expect: { status: 200 } }
  "DELETE /api/cards/:id": { expect: { status: 204 } }
  "POST /api/boards/:board_id/cards": { expect: { status: 201 } }
  "PATCH /api/profile": { expect: { status: 200 } }
  "POST /api/login": { expect: { status: 200 } }
  "POST /api/cards/:id/archive": { expect: { status: 200 } }
  "DELETE /api/cards": { expect: { status: 204 } }
  "PUT /api/cards/:id": { expect: { status: 200 }, mutate: false }
`);
  const by = Object.fromEntries(w.map((x) => [`${x.method} ${x.path}`, x]));
  assert.deepEqual(by['POST /api/cards'].mutate, { entity: 'cards', action: 'create' });
  assert.equal(by['POST /api/cards'].inferred, '/api/cards');
  assert.deepEqual(by['PATCH /api/cards/:id'].mutate, { entity: 'cards', action: 'update' });
  assert.deepEqual(by['PATCH /api/cards/:id'].params, [{ name: 'id', field: 'id' }]);
  assert.deepEqual(by['DELETE /api/cards/:id'].mutate, { entity: 'cards', action: 'delete' });
  assert.deepEqual(by['POST /api/boards/:board_id/cards'].params, [{ name: 'board_id', field: 'board_id' }]);
  assert.equal(by['POST /api/boards/:board_id/cards'].inferred, '/api/boards/:board_id/cards');
  assert.deepEqual(by['PATCH /api/profile'].mutate, { entity: 'profile', action: 'update' });
  for (const k of ['POST /api/login', 'POST /api/cards/:id/archive', 'DELETE /api/cards', 'PUT /api/cards/:id']) {
    assert.equal(by[k].mutate, undefined, k);
    assert.equal(by[k].inferred, undefined, k);
  }
  assert.deepEqual(by['PUT /api/cards/:id'].params, [{ name: 'id', field: null }]);

  // the engine applies the inferred delete
  const ds = generateWorld(normalizeScenario(parseYaml(`name: d
seed: 1
world:
  cards: 3
endpoints:
  - path: /api/cards
    entity: cards
writes:
  "DELETE /api/cards/:id": { expect: { status: 204 } }
`, 'd.yaml'), 'd.yaml'));
  const engine = createEngine(ds);
  assert.equal(engine.handle({ method: 'DELETE', pathname: '/api/cards/2' }).status, 204);
  assert.equal(engine.handle({ pathname: '/api/cards/2' }).status, 404);
  assert.equal(engine.handle({ pathname: '/api/cards' }).body.length, 2);

  assert.throws(
    () => norm('  "POST /api/cards": { mutate: true }\n'),
    (e) => e instanceof AtrezzoError && /must be a map \{ entity, action, set, where \} or false/.test(e.message),
  );
});

test('writes: inference follows match() precedence on overlapping routes (list before detail, fewest params)', () => {
  // 1. Detail route declared before a matching shape: object list route: GET and PATCH both resolve the list route.
  const listBeatsDetail = normalizeScenario(parseYaml(`name: list-beats-detail
seed: 1
world:
  boards: 2
  board_pages:
    total: 2
    fields: { slug: string, title: string }
endpoints:
  - path: /api/boards
    entity: boards
  - path: /api/boards/:slug
    entity: board_pages
    shape: object
    filters: { ":slug": id }
writes:
  "PATCH /api/boards/:id": { expect: { status: 200 } }
  "DELETE /api/boards/:id": { expect: { status: 204 } }
`, 'lbd.yaml'), 'lbd.yaml');
  const lbdWrites = Object.fromEntries(listBeatsDetail.writes.map((w) => [`${w.method} ${w.path}`, w]));
  assert.deepEqual(lbdWrites['PATCH /api/boards/:id'].mutate, { entity: 'board_pages', action: 'update' });
  assert.equal(lbdWrites['PATCH /api/boards/:id'].inferred, '/api/boards/:slug');
  assert.equal(lbdWrites['DELETE /api/boards/:id'].mutate, undefined);
  const lbdEngine = createEngine(generateWorld(listBeatsDetail));
  assert.equal(lbdEngine.match('/api/boards/1').ep.entity, 'board_pages');
  assert.equal(lbdEngine.handle({ method: 'PATCH', pathname: '/api/boards/1', body: { title: 'Updated' } }).status, 200);
  assert.equal(lbdEngine.handle({ pathname: '/api/boards/1' }).body.title, 'Updated');

  // 2. More literal list route declared after a parameterized one: fewest params wins (including when ineligible).
  const literalWins = normalizeScenario(parseYaml(`name: literal-wins
seed: 1
world:
  posts:
    total: 2
    fields: { section: string, title: string }
  board_posts:
    total: 2
    fields: { title: string }
endpoints:
  - path: /api/:section/posts
    entity: posts
  - path: /api/boards/posts
    entity: board_posts
writes:
  "POST /api/boards/posts": { expect: { status: 201 } }
`, 'lw.yaml'), 'lw.yaml');
  assert.deepEqual(literalWins.writes[0].mutate, { entity: 'board_posts', action: 'create' });
  assert.equal(literalWins.writes[0].inferred, '/api/boards/posts');
  assert.equal(createEngine(generateWorld(literalWins)).match('/api/boards/posts').ep.entity, 'board_posts');

  const literalErrorWins = normalizeScenario(parseYaml(`name: literal-error-wins
seed: 1
world:
  posts:
    total: 2
    fields: { section: string, title: string }
  board_posts:
    total: 2
    fields: { title: string }
endpoints:
  - path: /api/:section/posts
    entity: posts
  - path: /api/boards/posts
    entity: board_posts
    error: { status: 403 }
writes:
  "POST /api/boards/posts": { expect: { status: 201 } }
`, 'lew.yaml'), 'lew.yaml');
  assert.equal(literalErrorWins.writes[0].mutate, undefined);

  // 3. Broad list route (or ineligible list route) shadows a detail route on GET ⇒ detail write stays stateless.
  const shadowedDetail = normalizeScenario(parseYaml(`name: shadowed-detail
seed: 1
world:
  boards: 2
  pages:
    total: 2
    fields: { section: string, slug: string }
endpoints:
  - path: /api/:section/:slug
    entity: pages
    shape: object
  - path: /api/boards
    entity: boards
writes:
  "PATCH /api/boards/:id": { expect: { status: 200 } }
  "DELETE /api/boards/:id": { expect: { status: 204 } }
`, 'sd.yaml'), 'sd.yaml');
  for (const w of shadowedDetail.writes) assert.equal(w.mutate, undefined, `${w.method} ${w.path}`);
  assert.equal(createEngine(generateWorld(shadowedDetail)).match('/api/boards/1').ep.entity, 'pages');

  // 4. Overlapping detail routes: fewest parameters wins in both match() and inference.
  const detailLiteralWins = normalizeScenario(parseYaml(`name: detail-literal-wins
seed: 1
world:
  sections:
    total: 2
    fields: { section: string }
  boards: 2
endpoints:
  - path: /api/:section
    entity: sections
    filters: { ":section": section }
  - path: /api/boards
    entity: boards
writes:
  "DELETE /api/boards/:id": { expect: { status: 204 } }
`, 'dlw.yaml'), 'dlw.yaml');
  assert.deepEqual(detailLiteralWins.writes[0].mutate, { entity: 'boards', action: 'delete' });
  assert.equal(detailLiteralWins.writes[0].inferred, '/api/boards');
  assert.equal(createEngine(generateWorld(detailLiteralWins)).match('/api/boards/1').ep.entity, 'boards');
});

// ---------- scopes: query parameters with set semantics ----------

const SCOPED = (scopeBlock, extra = '') => `name: scoped
seed: 31
world:
  widgets:
    total: 30
    fields: { name: string, finish: [matte, gloss], archived: boolean }
endpoints:
  - path: /api/widgets
    entity: widgets
    filters: [finish]
    pagination: { param_limit: limit, param_offset: offset }
    sorts: { by: sort_by, fields: [id, name] }
${scopeBlock}
  - path: /api/plain
    entity: widgets
    filters: [finish]
    pagination: { param_limit: limit, param_offset: offset }
${extra}`;

const scopedEngine = (scopeBlock, extra) => {
  const ds = generateWorld(normalizeScenario(parseYaml(SCOPED(scopeBlock, extra), 's.yaml'), 's.yaml'));
  const e = createEngine(ds);
  const req = (path, method = 'GET') => {
    const u = new URL(path, 'http://x');
    return e.handle({ method, pathname: u.pathname, query: u.searchParams });
  };
  return { ds, req, rows: ds.entities.widgets };
};

test('scopes: ?param=true adds the archived rows, false keeps only the others, absent answers the endpoint default', () => {
  const { req, rows } = scopedEngine('    scopes: { is_archived: { field: archived } }');
  const archived = rows.filter((r) => r.archived === true).map((r) => r.id);
  const live = rows.filter((r) => r.archived !== true).map((r) => r.id);
  assert.ok(archived.length > 0 && live.length > 0, 'the world holds both kinds of rows');

  const absent = req('/api/widgets');
  assert.equal(absent.status, 200);
  assert.deepEqual(ids(absent), live, 'default: exclude hides archived rows');
  assert.equal(absent.headers['x-total-count'], String(live.length));

  const withTrue = req('/api/widgets?is_archived=true');
  assert.deepEqual(ids(withTrue), rows.map((r) => r.id), 'true widens the set to every row');
  assert.equal(withTrue.headers['x-total-count'], String(rows.length));
  assert.ok(withTrue.body.some((r) => r.archived === true));

  const withFalse = req('/api/widgets?is_archived=false');
  assert.deepEqual(ids(withFalse), live);
  assert.ok(withFalse.body.every((r) => r.archived !== true));

  for (const r of [absent, withTrue, withFalse]) assert.equal(r.headers['x-atrezzo-ignored'], undefined);
  // the detail route is not scoped: an archived row is still reachable by id
  assert.equal(req(`/api/widgets/${archived[0]}`).status, 200);
});

test('scopes: absent changes nothing with default: include, and endpoints without scopes keep their behaviour and hash', () => {
  const { req } = scopedEngine('    scopes: { is_archived: { field: archived, default: include } }');
  const scoped = req('/api/widgets?limit=7&offset=3&finish=matte');
  const plain = req('/api/plain?limit=7&offset=3&finish=matte');
  assert.deepEqual(scoped.body, plain.body);
  assert.deepEqual(scoped.headers, plain.headers);
  // without scopes the parameter is still an unknown one
  assert.equal(req('/api/plain?is_archived=true').headers['x-atrezzo-ignored'], 'is_archived');
  // a scenario without scopes normalizes without a `scopes` key (hash unchanged)
  const n = normalizeScenario(parseYaml(SCOPED(''), 's.yaml'), 's.yaml');
  assert.ok(n.endpoints.every((ep) => !('scopes' in ep)));
  assert.equal(scenarioHash(n), scenarioHash(normalizeScenario(parseYaml(SCOPED(''), 's.yaml'), 's.yaml')));
});

test('scopes: invalid values answer 400; empty means absent', () => {
  const { req, rows } = scopedEngine('    scopes: { is_archived: archived }');
  for (const q of ['maybe', '1', 'yes', 'null']) {
    const r = req(`/api/widgets?is_archived=${q}`);
    assert.equal(r.status, 400, q);
    assert.match(r.body.error, /"is_archived" must be "true" or "false"/);
  }
  const conflict = req('/api/widgets?is_archived=true&is_archived=false');
  assert.equal(conflict.status, 400);
  assert.match(conflict.body.error, /conflicting values/);
  assert.equal(req('/api/widgets?is_archived=TRUE').body.length, rows.length, 'case-insensitive');
  assert.deepEqual(ids(req('/api/widgets?is_archived=')), ids(req('/api/widgets')));
});

test('scopes: combine with filters, sort, pagination, head=true and shape: object; the count reflects the resulting set', () => {
  const { req, rows } = scopedEngine('    scopes: { is_archived: archived }', `  - path: /api/first-widget
    entity: widgets
    shape: object
    scopes: { is_archived: { field: archived, default: include, when_true: only } }
`);
  const matteAll = rows.filter((r) => r.finish === 'matte');
  const matteLive = matteAll.filter((r) => r.archived !== true);

  const page = req('/api/widgets?is_archived=true&finish=matte&sort_by=-id&limit=3&offset=1');
  assert.equal(page.status, 200);
  assert.deepEqual(ids(page), matteAll.map((r) => r.id).reverse().slice(1, 4));
  assert.equal(page.headers['x-total-count'], String(matteAll.length));
  assert.equal(page.headers['x-atrezzo-ignored'], undefined);

  assert.equal(req('/api/widgets?finish=matte&limit=2').headers['x-total-count'], String(matteLive.length));
  assert.equal(req('/api/widgets?is_archived=false&finish=matte').headers['x-total-count'], String(matteLive.length));

  const head = req('/api/widgets?is_archived=true&head=true');
  assert.equal(head.headers['x-total-count'], String(rows.length));
  assert.equal(head.headers['x-atrezzo-ignored'], undefined);

  const firstArchived = rows.find((r) => r.archived === true);
  assert.equal(req('/api/first-widget?is_archived=true').body.id, firstArchived.id, 'when_true: only');
  assert.equal(req('/api/first-widget').body.id, rows[0].id, 'default: include');
});

test('scopes: when_true: only narrows to the archived rows; when_false: add widens a default: exclude set', () => {
  const { req, rows } = scopedEngine('    scopes: { is_archived: { field: archived, when_true: only, when_false: add } }');
  assert.deepEqual(ids(req('/api/widgets?is_archived=true')), rows.filter((r) => r.archived === true).map((r) => r.id));
  // default exclude ∪ rows with archived ≠ true = still the non-archived rows
  assert.deepEqual(ids(req('/api/widgets?is_archived=false')), rows.filter((r) => r.archived !== true).map((r) => r.id));
  const inc = scopedEngine('    scopes: { show_live: { field: archived, default: include, when_false: only } }');
  assert.deepEqual(ids(inc.req('/api/widgets?show_live=false')), inc.rows.filter((r) => r.archived !== true).map((r) => r.id));
});

test('scopes: scenario validation (boolean field, actions, parameter collisions)', () => {
  const bad = (block, re) => assert.throws(
    () => normalizeScenario(parseYaml(SCOPED(block), 's.yaml'), 's.yaml'),
    (e) => e instanceof AtrezzoError && re.test(e.message),
    block,
  );
  bad('    scopes: { is_archived: { field: hidden } }', /scopes\.is_archived\.field": field "hidden" does not exist/);
  bad('    scopes: { is_archived: { field: finish } }', /scopes\.is_archived\.field": field "finish" is not a boolean/);
  bad('    scopes: { is_archived: {} }', /scopes\.is_archived\.field": required/);
  bad('    scopes: { is_archived: { field: archived, when_true: maybe } }', /scopes\.is_archived\.when_true": must be "add" or "only"/);
  bad('    scopes: { is_archived: { field: archived, default: hide } }', /scopes\.is_archived\.default": must be "exclude" or "include"/);
  bad('    scopes: { is_archived: { field: archived, colour: red } }', /scopes\.is_archived/);
  bad('    scopes: { finish: archived }', /parameter "finish" conflicts with a declared filter/);
  bad('    scopes: { limit: archived }', /parameter "limit" conflicts with a pagination parameter/);
  bad('    scopes: { sort_by: archived }', /parameter "sort_by" conflicts with a sort parameter/);
  bad('    scopes: []', /scopes": must be a map/);
});

// ---------- wrap: singleton wrapper (`shape: object` + `wrap: <key>`) ----------

test('wrap: shape: object + wrap wraps singleton, includes/counts, and derived detail route; 404s and unwrapped control stay intact', () => {
  const WRAP_SCENARIO = `name: conduit-wrap
seed: 42
world:
  authors:
    total: 2
    fields: { username: string, bio: string }
  articles:
    total: 3
    ref: authors
    fields: { slug: string, title: string }
    values: { slug: [first-post, second-post, third-post] }
    values_order: cycle
  comments:
    total: 5
    ref: articles
    fields: { body: string }
  profiles: 0
endpoints:
  - path: /api/articles/:slug
    entity: articles
    include: [authors]
    counts:
      comments: { entity: comments, on: article_id }
    shape: object
    wrap: article
  - path: /api/article
    entity: articles
    include: [authors]
    counts:
      comments: { entity: comments, on: article_id }
    shape: object
    wrap: article
    detail: true
  - path: /api/article-raw
    entity: articles
    include: [authors]
    counts:
      comments: { entity: comments, on: article_id }
    shape: object
    detail: true
  - path: /api/profile
    entity: profiles
    shape: object
    wrap: profile
`;
  const ds = generateWorld(normalizeScenario(parseYaml(WRAP_SCENARIO, 'wrap.yaml'), 'wrap.yaml'));
  const eng = createEngine(ds);
  const req = (path) => {
    const u = new URL(path, 'http://x');
    return eng.handle({ method: 'GET', pathname: u.pathname, query: u.searchParams });
  };

  // Wrapped parameterized singleton carries world fields, include, and counts inside { article: ... }
  const wrapped = req('/api/articles/second-post');
  assert.equal(wrapped.status, 200);
  assert.deepEqual(Object.keys(wrapped.body), ['article']);
  const expectedRow2 = ds.entities.articles.find((a) => a.slug === 'second-post');
  const expectedAuthor2 = ds.entities.authors.find((a) => a.id === expectedRow2.author_id);
  const expectedComments2 = ds.entities.comments.filter((c) => c.article_id === expectedRow2.id).length;
  assert.deepEqual(wrapped.body.article, { ...expectedRow2, author: expectedAuthor2, comments_count: expectedComments2 });

  // Control: identical endpoint without wrap returns the raw row directly
  const raw = req('/api/article-raw');
  assert.equal(raw.status, 200);
  assert.equal(raw.body.article, undefined);
  assert.equal(raw.body.id, ds.entities.articles[0].id);
  assert.equal(raw.body.title, ds.entities.articles[0].title);
  assert.deepEqual(raw.body.author, ds.entities.authors.find((a) => a.id === ds.entities.articles[0].author_id));

  // Unwrapped singleton vs wrapped singleton match on inner row
  const wrappedFirst = req('/api/article');
  assert.equal(wrappedFirst.status, 200);
  assert.deepEqual(wrappedFirst.body, { article: raw.body });

  // Derived detail route (`detail: true`) also wraps under the same key
  const detailWrapped = req(`/api/article/${expectedRow2.id}`);
  assert.equal(detailWrapped.status, 200);
  assert.deepEqual(detailWrapped.body, { article: wrapped.body.article });

  const detailParamWrapped = req(`/api/articles/second-post/${expectedRow2.id}`);
  assert.equal(detailParamWrapped.status, 200);
  assert.deepEqual(detailParamWrapped.body, { article: wrapped.body.article });

  // Control detail route without wrap stays raw
  const detailRaw = req(`/api/article-raw/${expectedRow2.id}`);
  assert.equal(detailRaw.status, 200);
  assert.deepEqual(detailRaw.body, wrapped.body.article);

  // 404s stay unwrapped: empty entity (with miss: true), unmatched filter/param, and missing detail id
  const empty = req('/api/profile');
  assert.equal(empty.status, 404);
  assert.equal(empty.miss, true);
  assert.equal(empty.body.profile, undefined);
  assert.equal(empty.body.atrezzo.miss, true);
  assert.equal(empty.body.atrezzo.gap, 'GET /api/profile');

  const noMatch = req('/api/articles/nonexistent-slug');
  assert.equal(noMatch.status, 404);
  assert.equal(noMatch.body.article, undefined);
  assert.match(noMatch.body.error, /no articles matches/);

  const missingDetail = req('/api/article/999');
  assert.equal(missingDetail.status, 404);
  assert.equal(missingDetail.body.article, undefined);
  assert.match(missingDetail.body.error, /articles 999 does not exist/);
});

test('envelope: total_pages is derived from the total and the page size', () => {
  const yaml = `name: total-pages
seed: 7
world:
  lineas: { total: 60, fields: { nombre: string } }
endpoints:
  - path: /api/lineas
    entity: lineas
    pagination: { param_page: page, param_limit: per_page, default_limit: 25 }
    sort: id
    shape: envelope
    envelope: { items: rows, total: total, page: page, total_pages: pages }
  - path: /api/lineas-sin-paginar
    entity: lineas
    shape: envelope
    envelope: { items: rows, total: total, total_pages: pages }
`;
  const sc = normalizeScenario(parseYaml(yaml, 'tp.yaml'), 'tp.yaml');
  const engine = createEngine(generateWorld(sc));
  const get = (p) => {
    const u = new URL(p, 'http://x');
    return engine.handle({ method: 'GET', pathname: u.pathname, query: u.searchParams });
  };
  const p1 = get('/api/lineas');
  assert.deepEqual([p1.body.total, p1.body.page, p1.body.pages, p1.body.rows.length], [60, 1, 3, 25]);
  const p3 = get('/api/lineas?page=3');
  assert.deepEqual([p3.body.page, p3.body.pages, p3.body.rows.length], [3, 3, 10]);
  const sinPaginar = get('/api/lineas-sin-paginar');
  assert.deepEqual([sinPaginar.body.total, sinPaginar.body.pages], [60, 1], 'sin paginación es una página');
});
