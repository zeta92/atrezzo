// Paths with parameters in the middle (`/cabinets/:cabinet_id/drawers/:drawer_id/items`) and
// `embed:` (the child rows that point at each row), the two things a "detail with tabs" screen needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { generateWorld } from '../scripts/lib/world.mjs';
import { createEngine } from '../scripts/lib/contract.mjs';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { handlersSource } from '../scripts/lib/codegen.mjs';
import { openapiDocument } from '../scripts/lib/runtimes/prism.mjs';
import { coveringScenarios } from '../scripts/lib/misses.mjs';
import { tmpProject } from './helpers.mjs';
import { getJson } from './helpers/http.mjs';

// A detail screen: the parent row carries its children, and the list screen asks for the entries of
// one parent through one of its children.
const BOARD = `name: board
seed: 20261115
world:
  cabinets: 3
  drawers: { total: 2, ref: cabinets }
  items: { total: 24, ref: [cabinets, drawers] }
  groups: 2
  people: { total: 7, ref: groups }
endpoints:
  - path: /api/cabinets
    entity: cabinets
    embed: [drawers]
  - path: /api/cabinets/:cabinet_id/drawers/:drawer_id/items
    entity: items
  - path: /api/cabinets/:id/drawers
    entity: drawers
  - path: /api/groups
    entity: groups
    embed: people
  - path: /api/boards/:cabinet/lists/:drawer/items
    entity: items
    filters: [id]
  - path: /api/any/:cabinet_id/drawers/:drawer_id/items
    entity: items
    filters: { ":drawer_id": null }
`;

const parse = (yaml) => normalizeScenario(parseYaml(yaml, 't.yaml'), 't.yaml');
const scenario = parse(BOARD);
const dataset = generateWorld(scenario);
const engine = createEngine(dataset);
const get = (path) => {
  const u = new URL(path, 'http://x');
  return engine.handle({ method: 'GET', pathname: u.pathname, query: u.searchParams });
};
const issues = (yaml) => { try { parse(yaml); } catch (e) { return e.issues.join('\n'); } return assert.fail('expected an invalid scenario'); };
const W = dataset.entities;

test('a two-parameter path binds each parameter to its <name> field and filters by both', () => {
  const ep = scenario.endpoints.find((e) => e.path.endsWith('/:drawer_id/items') && e.path.includes('/cabinets/'));
  assert.deepEqual(ep.params, [{ name: 'cabinet_id', field: 'cabinet_id' }, { name: 'drawer_id', field: 'drawer_id' }]);
  let seen = 0;
  for (const p of W.cabinets) {
    for (const v of W.drawers) {
      const r = get(`/api/cabinets/${p.id}/drawers/${v.id}/items`);
      assert.equal(r.status, 200);
      const want = W.items.filter((t) => t.cabinet_id === p.id && t.drawer_id === v.id);
      assert.deepEqual(r.body.map((t) => t.id), want.map((t) => t.id), `cabinet ${p.id} drawer ${v.id}`);
      assert.equal(r.headers['x-total-count'], String(want.length));
      seen += want.length;
    }
  }
  assert.equal(seen, W.items.length, 'every item is reachable through exactly one (cabinet, drawer) pair');
  // query filters and pagination still apply on top of the parameters (here: none declared ⇒ ignored)
  assert.equal(get('/api/cabinets/1/drawers/1/items?done=false').headers['x-atrezzo-ignored'], 'done');
  // a value no row has is an empty list, not a 404: the route exists
  assert.deepEqual(get('/api/cabinets/99/drawers/1/items').body, []);
});

test('the detail route of a parameterised path answers only rows under its parameters', () => {
  const drawer = W.drawers[0];
  assert.deepEqual(get(`/api/cabinets/${drawer.cabinet_id}/drawers/${drawer.id}`).body, drawer);
  const other = W.cabinets.find((p) => p.id !== drawer.cabinet_id);
  const r = get(`/api/cabinets/${other.id}/drawers/${drawer.id}`);
  assert.equal(r.status, 404);
  assert.match(r.body.error, new RegExp(`drawers ${drawer.id} does not exist under cabinet_id=${other.id}`));
});

test('a bare :id (single parameter) names the segment before it; :name falls back to <name>_id; null accepts any value', () => {
  const drawers = scenario.endpoints.find((e) => e.path === '/api/cabinets/:id/drawers');
  assert.deepEqual(drawers.params, [{ name: 'id', field: 'cabinet_id' }]);
  for (const p of W.cabinets) assert.deepEqual(get(`/api/cabinets/${p.id}/drawers`).body, W.drawers.filter((v) => v.cabinet_id === p.id));

  const short = scenario.endpoints.find((e) => e.path.startsWith('/api/boards/'));
  assert.deepEqual(short.params, [{ name: 'cabinet', field: 'cabinet_id' }, { name: 'drawer', field: 'drawer_id' }]);
  const t = W.items[3];
  assert.deepEqual(get(`/api/boards/${t.cabinet_id}/lists/${t.drawer_id}/items?id=${t.id}`).body, [t]);

  const any = scenario.endpoints.find((e) => e.path.startsWith('/api/any/'));
  assert.deepEqual(any.params, [{ name: 'cabinet_id', field: 'cabinet_id' }, { name: 'drawer_id', field: null }]);
  assert.deepEqual(get('/api/any/2/drawers/whatever/items').body.map((x) => x.id), W.items.filter((x) => x.cabinet_id === 2).map((x) => x.id));
});

test('an unknown parameter name is rejected with the fields it looked for and the way to map it', () => {
  const base = 'name: x\nseed: 1\nworld:\n  cabinets: 2\n  items: { total: 3, ref: cabinets }\nendpoints:\n';
  const msg = issues(`${base}  - path: /api/cabinets/:owner/items\n    entity: items\n`);
  assert.match(msg, /field "endpoints\[0\]\.path": parameter ":owner" binds to no field of "items" \(looked for "owner", "owner_id"; fields: id, name, cabinet_id, created_at\); rename it after a field or map it: filters: \{ ":owner": <field> \}/);
  // two parameters, one unknown: no guessing for the second either
  assert.match(issues(`${base}  - path: /api/cabinets/:cabinet_id/boards/:board_id/items\n    entity: items\n`), /parameter ":board_id" binds to no field of "items" \(looked for "board_id"/);
  // a bare :id whose segment names no field
  assert.match(issues(`${base}  - path: /api/boards/:id/items\n    entity: items\n`), /parameter ":id" binds to no field of "items" \(looked for "board_id"/);
  // with several parameters a bare :id is not guessed, even when the segment would name a field…
  const two = `${base}  - path: /api/cabinets/:id/lists/:list/items\n    entity: items\n`;
  assert.match(issues(two), /parameter ":id" binds to no field of "items" \(a path with several parameters does not guess what a bare ":id" names/);
  // …and the explicit map makes the same path valid
  const mapped = parse(`${two}    filters: { ":id": cabinet_id, ":list": null }\n`);
  assert.deepEqual(mapped.endpoints[0].params, [{ name: 'id', field: 'cabinet_id' }, { name: 'list', field: null }]);
  // the map form is checked too
  assert.match(issues(`${base}  - path: /api/p/:pid/items\n    entity: items\n    filters: { ":pid": owner_id }\n`), /field "endpoints\[0\]\.filters\.:pid": field "owner_id" does not exist in "items"/);
  assert.match(issues(`${base}  - path: /api/p/:pid/items\n    entity: items\n    filters: { ":nope": cabinet_id, ":pid": cabinet_id }\n`), /":nope" is not a parameter of "\/api\/p\/:pid\/items" \(parameters: :pid\)/);
  assert.match(issues(`${base}  - path: /api/items/:id\n    entity: items\n`), /a trailing "\/:id" is the detail route/);
  assert.match(issues(`${base}  - path: /api/p:x/items\n    entity: items\n`), /"p:x": a parameter is a whole segment/);
  assert.match(issues(`${base}  - path: /api/cabinets/:cabinet_id/items\n    entity: items\n  - path: /api/cabinets/:id/items\n    entity: items\n`), /field "endpoints\[1\]\.path": duplicate/);
  // the explicit map wins over the naming rule
  const ok = parse(`${base}  - path: /api/p/:pid/items\n    entity: items\n    filters: { ":pid": cabinet_id, name: name }\n`);
  assert.deepEqual(ok.endpoints[0].params, [{ name: 'pid', field: 'cabinet_id' }]);
  assert.deepEqual(ok.endpoints[0].filters, ['name']);
});

test('embed adds the child rows that point at each row: zero, one and many', () => {
  const cabinets = get('/api/cabinets').body;
  const counts = cabinets.map((p) => p.drawers.length).sort();
  assert.deepEqual(counts, [0, 1, 1], '3 cabinets, 2 drawers: one cabinet has none');
  for (const p of cabinets) {
    assert.ok(Array.isArray(p.drawers));
    assert.deepEqual(p.drawers, W.drawers.filter((v) => v.cabinet_id === p.id), `cabinet ${p.id}`);
  }
  const empty = cabinets.find((p) => p.drawers.length === 0);
  assert.deepEqual(empty.drawers, []);
  const one = cabinets.find((p) => p.drawers.length === 1);
  assert.equal(one.drawers[0].cabinet_id, one.id);
  // rows, not counts, and copies: the world is not touched
  assert.ok(typeof one.drawers[0].name === 'string');
  one.drawers[0].name = 'mutated';
  assert.notEqual(W.drawers.find((v) => v.id === one.drawers[0].id).name, 'mutated');

  const groups = get('/api/groups').body;
  assert.equal(groups.reduce((n, t) => n + t.people.length, 0), 7);
  assert.ok(groups.some((t) => t.people.length > 1), 'many');
  for (const t of groups) assert.deepEqual(t.people.map((m) => m.id), W.people.filter((m) => m.group_id === t.id).map((m) => m.id));
  // the detail route embeds too
  assert.deepEqual(get(`/api/cabinets/${one.id}`).body.drawers, one.drawers.map((v) => W.drawers.find((w) => w.id === v.id)));
  // and the world rows themselves gain no "drawers" key
  assert.equal(W.cabinets[0].drawers, undefined);
});

test('embed of an entity that does not ref the parent is rejected', () => {
  const base = 'name: x\nseed: 1\nworld:\n  cabinets: 2\n  tags: 3\n  drawers: { total: 2, ref: cabinets }\nendpoints:\n';
  assert.match(issues(`${base}  - path: /api/cabinets\n    entity: cabinets\n    embed: [tags]\n`), /field "endpoints\[0\]\.embed\[0\]": "tags" does not reference "cabinets" \(its refs: none\); embed lists the child rows that point at each row: add ref: cabinets to world\.tags/);
  assert.match(issues(`${base}  - path: /api/cabinets\n    entity: cabinets\n    embed: [boards]\n`), /"boards" is not declared in world/);
  assert.match(issues(`${base}  - path: /api/drawers\n    entity: drawers\n    embed: [cabinets]\n`), /"cabinets" does not reference "drawers"/);
  assert.match(issues(`${base}  - path: /api/cabinets\n    entity: cabinets\n    embed: [drawers, drawers]\n`), /"drawers" is listed twice/);
});

test('serve answers a detail screen: the parent with its children, then the entries of one child', async () => {
  const dir = tmpProject({ 'scenarios/board.yaml': BOARD });
  const mock = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'board' });
  const url = `http://127.0.0.1:${(await mock.listen(0)).port}`;
  try {
    let items = 0;
    for (const id of [1, 2, 3]) {
      const cabinet = (await getJson(`${url}/api/cabinets/${id}`)).body;
      assert.ok(Array.isArray(cabinet.drawers));
      for (const v of cabinet.drawers) {
        const r = await getJson(`${url}/api/cabinets/${id}/drawers/${v.id}/items`);
        assert.equal(r.status, 200);
        assert.ok(r.body.every((t) => t.cabinet_id === id && t.drawer_id === v.id));
        items += r.body.length;
      }
    }
    assert.ok(items > 0, 'the walk reached some items');
    // a parameterised route that is served is not a gap
    assert.equal((await getJson(`${url}/__atrezzo/misses`)).body.misses.length, 0);
    const gap = await getJson(`${url}/api/cabinets/1/buckets`);
    assert.equal(gap.status, 404);
    assert.equal(gap.body.atrezzo.gap, 'GET /api/cabinets/:id/buckets');
  } finally {
    await mock.close();
  }
});

test('MSW handlers, the Prism document and the misses hint understand parameterised paths', () => {
  const src = handlersSource(dataset);
  assert.match(src, /http\.get\('\*\/api\/cabinets\/:cabinet_id\/drawers\/:drawer_id\/items', project\)/);
  assert.match(src, /http\.get\('\*\/api\/cabinets\/:id\/drawers\/:row_id', project\)/, 'the detail segment does not reuse :id');
  assert.match(src, /embeds: drawers/);

  const doc = openapiDocument(dataset, { mock: { baseUrl: 'http://127.0.0.1:4010' } });
  const op = doc.paths['/api/cabinets/{cabinet_id}/drawers/{drawer_id}/items'].get;
  assert.deepEqual(op.parameters.filter((x) => x.in === 'path').map((x) => x.name), ['cabinet_id', 'drawer_id']);
  assert.ok(Array.isArray(op.responses[200].content['application/json'].examples.scenario.value));
  assert.ok(doc.paths['/api/cabinets/{id}/drawers/{row_id}']);

  assert.deepEqual(coveringScenarios([scenario], '/api/cabinets/:id/drawers/:id/items'), ['board']);
  assert.deepEqual(coveringScenarios([scenario], '/api/cabinets/:id/drawers/:id/items/:id'), ['board']);
  assert.deepEqual(coveringScenarios([scenario], '/api/cabinets/:id/buckets'), []);
});