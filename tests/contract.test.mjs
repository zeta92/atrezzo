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
