// A world that does not contradict itself: fks derived from another fk of the same row (`derive`),
// and enums / booleans seeded by their first declared value (`seed_first`).
// Neutral vocabulary on purpose (Widget / Gadget / Piece): nothing in the code may know an app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { generateWorld, checkIntegrity, scenarioHash } from '../scripts/lib/world.mjs';
import { createEngine } from '../scripts/lib/contract.mjs';
import { AtrezzoError } from '../scripts/lib/errors.mjs';
import { mergeGapIntoScenario, formatHarvestReport } from '../scripts/lib/harvest.mjs';
import { parseTsTypes } from '../scripts/lib/ts-types.mjs';
import { emitYaml } from '../scripts/lib/yaml-emit.mjs';

const clone = (o) => JSON.parse(JSON.stringify(o));

/** widgets ← gadgets ← pieces, pieces referencing both: the shape of `/widgets/:w/gadgets/:g/pieces`. */
const doc = ({ seed = 11, pieces = {}, widgets = {}, gadgets = {} } = {}) => ({
  name: 'coherence',
  seed,
  world: {
    widgets: { total: 4, fields: { name: 'string', finish: ['matte', 'gloss', 'satin'], is_retired: 'boolean' }, ...widgets },
    gadgets: { total: 9, ref: 'widgets', fields: { label: 'string', mode: ['list', 'grid', 'board'] }, ...gadgets },
    pieces: { total: 60, ref: ['widgets', 'gadgets'], fields: { title: 'string' }, ...pieces },
  },
  endpoints: [
    { path: '/api/widgets', entity: 'widgets' },
    { path: '/api/widgets/:widget_id/gadgets', entity: 'gadgets' },
    { path: '/api/widgets/:widget_id/gadgets/:gadget_id/pieces', entity: 'pieces' },
  ],
});
const DERIVE = { derive: { widget_id: { from: 'gadgets', field: 'widget_id' } } };

const world = (d) => generateWorld(normalizeScenario(clone(d), 't.yaml'));
const issuesOf = (d) => {
  try { normalizeScenario(clone(d), 't.yaml'); } catch (e) {
    assert.ok(e instanceof AtrezzoError, e.stack);
    return e.issues.join('\n');
  }
  assert.fail('the scenario should be invalid');
};

test('without derive the two fks of a row are drawn apart and can contradict each other (the bug)', () => {
  const w = world(doc());
  const gadgetOf = new Map(w.entities.gadgets.map((g) => [g.id, g.widget_id]));
  assert.ok(w.entities.pieces.some((p) => gadgetOf.get(p.gadget_id) !== p.widget_id));
});

test('derive copies the parent fk through the child: every piece belongs to the widget of its gadget, whatever the seed', () => {
  for (const seed of [11, 4242]) {
    const w = world(doc({ seed, pieces: DERIVE }));
    const gadgetOf = new Map(w.entities.gadgets.map((g) => [g.id, g.widget_id]));
    assert.equal(w.entities.pieces.length, 60);
    for (const p of w.entities.pieces) assert.equal(p.widget_id, gadgetOf.get(p.gadget_id), `seed ${seed}: piece ${p.id}`);
    assert.deepEqual(checkIntegrity(w), []);
    // Every gadget still gets pieces: the drawn fk keeps its coverage.
    for (const g of w.entities.gadgets) assert.ok(w.entities.pieces.some((p) => p.gadget_id === g.id), `seed ${seed}: gadget ${g.id} has no pieces`);
  }
});

test('the nested route answers exactly the pieces of that gadget, and a gadget under another widget answers []', () => {
  const w = world(doc({ pieces: DERIVE }));
  const engine = createEngine(w);
  const g = w.entities.gadgets[0];
  const res = engine.handle({ pathname: `/api/widgets/${g.widget_id}/gadgets/${g.id}/pieces` });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((p) => p.id), w.entities.pieces.filter((p) => p.gadget_id === g.id).map((p) => p.id));
  assert.ok(res.body.length > 0);
  const other = w.entities.widgets.find((x) => x.id !== g.widget_id);
  assert.deepEqual(engine.handle({ pathname: `/api/widgets/${other.id}/gadgets/${g.id}/pieces` }).body, []);
});

test('the derived fk is no longer drawn: the other fields and the other entities are unchanged, same seed ⇒ same rows', () => {
  const plain = world(doc());
  const derived = world(doc({ pieces: DERIVE }));
  assert.deepEqual(derived.entities.widgets, plain.entities.widgets);
  assert.deepEqual(derived.entities.gadgets, plain.entities.gadgets);
  assert.deepEqual(derived.entities.pieces.map((p) => [p.gadget_id, p.title]), plain.entities.pieces.map((p) => [p.gadget_id, p.title]));
  assert.deepEqual(world(doc({ pieces: DERIVE })), derived);
  // `field` defaults to the derived fk's own name; the short form names only the entity.
  assert.deepEqual(world(doc({ pieces: { derive: { widget_id: { from: 'gadgets' } } } })).entities, derived.entities);
  assert.deepEqual(world(doc({ pieces: { derive: { widget_id: 'gadgets' } } })).entities, derived.entities);
});

test('a scenario without derive or seed_first keeps its normalized form and its hash', () => {
  const n = normalizeScenario(clone(doc()), 't.yaml');
  for (const spec of n.world) {
    assert.equal(Object.hasOwn(spec, 'derive'), false);
    assert.equal(Object.hasOwn(spec, 'seedFirst'), false);
  }
  assert.notEqual(scenarioHash(n), scenarioHash(normalizeScenario(clone(doc({ pieces: DERIVE })), 't.yaml')));
});

test('derive with a "from" that is not in ref: is an invalid scenario with a clear message', () => {
  const d = doc({ pieces: { ref: ['widgets'], fields: { title: 'string', gadget_id: 'integer' }, ...DERIVE } });
  assert.match(issuesOf(d), /world\.pieces\.derive\.widget_id\.from": "gadgets" is not in the ref: of "pieces" \(ref: widgets\)/);
});

test('derive validation: a field that is not a fk, a missing or wrong source field, a self source, a cycle', () => {
  assert.match(issuesOf(doc({ pieces: { derive: { title: { from: 'gadgets' } } } })),
    /pieces\.derive\.title": "title" is not a foreign key of "pieces" \(its foreign keys: widget_id, gadget_id\)/);
  assert.match(issuesOf(doc({ pieces: { derive: { widget_id: { from: 'gadgets', field: 'colour' } } } })),
    /pieces\.derive\.widget_id\.field": field "colour" does not exist in "gadgets"/);
  assert.match(issuesOf(doc({ pieces: { derive: { widget_id: { from: 'gadgets', field: 'label' } } } })),
    /"gadgets\.label" is not a reference to "widgets".*add ref: widgets to world\.gadgets/);
  assert.match(issuesOf(doc({ pieces: { derive: { widget_id: { from: 'widgets' } } } })),
    /pieces\.derive\.widget_id\.from": "widget_id" already points at "widgets"/);
  assert.match(issuesOf(doc({ pieces: { derive: { widget_id: { from: 'gadgets', bogus: 1 } } } })),
    /pieces\.derive\.widget_id\.bogus": unknown field/);
  assert.match(issuesOf(doc({ pieces: { derive: [] } })), /pieces\.derive": must be a non-empty map/);
  // gadgets ↔ pieces would be built in a loop.
  assert.match(issuesOf(doc({ gadgets: { ref: ['widgets', 'pieces'] }, pieces: DERIVE })),
    /pieces\.derive\.widget_id\.from": "gadgets" references "pieces"/);
});

test('seed_first: true gives every row the first value of each enum and false for each boolean', () => {
  for (const seed of [11, 4242]) {
    const w = world(doc({ seed, widgets: { seed_first: true }, gadgets: { seed_first: true } }));
    for (const x of w.entities.widgets) {
      assert.equal(x.finish, 'matte');
      assert.equal(x.is_retired, false);
      assert.equal(typeof x.name, 'string');
    }
    for (const g of w.entities.gadgets) assert.equal(g.mode, 'list');
  }
  // Without the key everything is drawn as before.
  const drawn = world(doc());
  assert.ok(new Set(drawn.entities.widgets.map((x) => x.finish)).size > 1 || new Set(drawn.entities.widgets.map((x) => x.is_retired)).size > 1);
});

test('seed_first with a list seeds only those fields; the rest of the row is unchanged', () => {
  const plain = world(doc());
  const w = world(doc({ widgets: { seed_first: ['is_retired'] } }));
  for (const [i, x] of w.entities.widgets.entries()) {
    assert.equal(x.is_retired, false);
    assert.equal(x.finish, plain.entities.widgets[i].finish);
    assert.equal(x.name, plain.entities.widgets[i].name);
  }
  // A `values:` vocabulary is seeded by its first value too.
  const v = world(doc({ widgets: { values: { finish: ['satin', 'gloss'] }, seed_first: ['finish'] } }));
  for (const x of v.entities.widgets) assert.equal(x.finish, 'satin');
});

test('seed_first with a field that is not an enum or a boolean is an invalid scenario', () => {
  assert.match(issuesOf(doc({ widgets: { seed_first: ['name'] } })),
    /world\.widgets\.seed_first\[0\]": "name" is not an enum, a boolean or a field with values: \(seedable: finish, is_retired\)/);
  assert.match(issuesOf(doc({ widgets: { seed_first: ['colour'] } })), /seed_first\[0\]": field "colour" does not exist in "widgets"/);
  assert.match(issuesOf(doc({ gadgets: { seed_first: ['widget_id'] } })), /seed_first\[0\]": "widget_id" is a foreign key/);
  assert.match(issuesOf(doc({ pieces: { seed_first: true } })), /world\.pieces\.seed_first": "pieces" has no enum, boolean or values: field to seed/);
  assert.match(issuesOf(doc({ widgets: { seed_first: 'yes' } })), /seed_first": must be true, false or a non-empty list/);
});


// ---------- harvest: the nesting of the route is the declaration of coherence ----------

const harvestDoc = (gadgets = { total: 6, ref: 'widgets', fields: { label: 'string' } }) => ({
  name: 'coherence',
  seed: 5,
  world: { widgets: { total: 3, fields: { name: 'string' } }, gadgets },
  endpoints: [
    { path: '/api/widgets', entity: 'widgets' },
    { path: '/api/widgets/:widget_id/gadgets', entity: 'gadgets' },
  ],
});
const gap = (example) => ({ method: 'GET', path: example, example, query: {} });
const PIECE_TYPES = `export type Finish = 'matte' | 'gloss';

export interface Widget {
  id: number;
  name: string;
}

export interface Piece {
  id: number;
  title: string;
  finish: Finish;
  is_retired: boolean;
}
`;
const report = (records, notes = []) => formatHarvestReport({
  targetUrl: '/', scenarioName: 'coherence', roundsRun: 1, stoppedReason: 'no-new-gaps', mutations: [], uninferrable: notes,
  discovered: records, written: 'coherence.yaml',
});

test('harvest: a three-level route derives the outer fk through the inner parent, and the world stays coherent', () => {
  const doc = harvestDoc();
  const r = mergeGapIntoScenario(doc, gap('/api/widgets/1/gadgets/2/pieces'));
  assert.equal(r.changed, true);
  assert.deepEqual(doc.world.pieces.ref, ['widgets', 'gadgets']);
  assert.deepEqual(doc.world.pieces.derive, { widget_id: { from: 'gadgets', field: 'widget_id' } });
  assert.deepEqual(doc.endpoints.at(-1).filters, { ':widget_id': 'widget_id', ':gadget_id': 'gadget_id' });
  assert.deepEqual(r.record.derived, [{ field: 'widget_id', from: 'gadgets', parent: 'widgets' }]);
  assert.match(emitYaml(doc), /derive:\n {6}widget_id:\n {8}from: gadgets\n {8}field: widget_id/);

  for (const seed of [5, 977]) {
    const w = generateWorld(normalizeScenario(clone({ ...doc, seed }), 'h.yaml'));
    const gadgetOf = new Map(w.entities.gadgets.map((g) => [g.id, g.widget_id]));
    for (const p of w.entities.pieces) assert.equal(p.widget_id, gadgetOf.get(p.gadget_id), `seed ${seed}: piece ${p.id}`);
  }
  assert.match(report([r.record]), /Coherence \(from the path nesting\):\n {2}- GET \/api\/widgets\/:widget_id\/gadgets\/:gadget_id\/pieces: pieces\.widget_id derive: \{ from: gadgets, field: widget_id \} \(every piece belongs to the widget of its gadget\)/);

  // Two levels nest nothing to derive.
  const two = harvestDoc();
  delete two.endpoints[1];
  two.endpoints = two.endpoints.filter(Boolean);
  const r2 = mergeGapIntoScenario(two, gap('/api/widgets/1/gadgets'));
  assert.equal(two.world.gadgets.derive, undefined);
  assert.equal(r2.record.derived, undefined);
});

test('harvest: the observed URL has rows when its gadget belongs to its widget; otherwise the note names the URL that does', () => {
  const owner = generateWorld(normalizeScenario(clone(harvestDoc()), 'h.yaml')).entities.gadgets[1].widget_id;
  const other = owner === 1 ? 2 : 1;

  const good = harvestDoc();
  const ok = mergeGapIntoScenario(good, gap(`/api/widgets/${owner}/gadgets/2/pieces`));
  assert.deepEqual(ok.notes, []);
  const res = createEngine(generateWorld(normalizeScenario(clone(good), 'h.yaml'))).handle({ pathname: `/api/widgets/${owner}/gadgets/2/pieces` });
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0);
  for (const p of res.body) assert.deepEqual([p.widget_id, p.gadget_id], [owner, 2]);

  const bad = harvestDoc();
  const ko = mergeGapIntoScenario(bad, gap(`/api/widgets/${other}/gadgets/2/pieces`));
  assert.deepEqual(ko.notes, [`GET /api/widgets/${other}/gadgets/2/pieces: in this world (seed 5) gadgets 2 has widget_id ${owner}, so this URL answers []; /api/widgets/${owner}/gadgets/2/pieces has rows`]);
});

test('harvest: an inner parent without the ref to the outer one gets it, because the path nests them', () => {
  const doc = harvestDoc({ total: 6, fields: { label: 'string' } });
  const r = mergeGapIntoScenario(doc, gap('/api/widgets/1/gadgets/2/pieces'));
  assert.equal(doc.world.gadgets.ref, 'widgets');
  assert.deepEqual(r.record.derived, [{ field: 'widget_id', from: 'gadgets', parent: 'widgets', addedRef: true }]);
  normalizeScenario(clone(doc), 'h.yaml');
  assert.match(report([r.record]), /; ref: widgets added to gadgets\)/);
});

test('harvest: only the shape of the route decides; renaming every entity and route yields the same scenario, renamed', () => {
  const rename = (s) => s.replace(/widget/g, 'alpha').replace(/gadget/g, 'beta').replace(/piece/g, 'gamma');
  const a = harvestDoc();
  mergeGapIntoScenario(a, gap('/api/widgets/1/gadgets/2/pieces'));
  const b = JSON.parse(rename(JSON.stringify(harvestDoc())));
  mergeGapIntoScenario(b, gap('/api/alphas/1/betas/2/gammas'));
  assert.equal(emitYaml(b), rename(emitYaml(a)));
});

test('harvest: an entity created from --types with an enum or a boolean gets seed_first: true, and its rows start at the first value', () => {
  const types = parseTsTypes(PIECE_TYPES, 'types.ts');
  const doc = harvestDoc();
  const r = mergeGapIntoScenario(doc, gap('/api/widgets/1/gadgets/2/pieces'), { parsedTypes: types, typesLabel: 'types.ts' });
  assert.deepEqual(doc.world.pieces.fields, { title: 'string', finish: ['matte', 'gloss'], is_retired: 'boolean' });
  assert.equal(doc.world.pieces.seed_first, true);
  assert.deepEqual(doc.world.pieces.derive, { widget_id: { from: 'gadgets', field: 'widget_id' } });
  assert.equal(r.record.seedFirst, true);
  const w = generateWorld(normalizeScenario(clone(doc), 'h.yaml'));
  for (const p of w.entities.pieces) {
    assert.equal(p.finish, 'matte');
    assert.equal(p.is_retired, false);
  }
  assert.match(report([r.record]), /Seeded by first value \(seed_first: true; enums and booleans from --types\): pieces/);

  // A type with neither an enum nor a boolean is left drawn as before.
  const plain = { name: 'coherence', seed: 5, world: { health: 1 }, endpoints: [{ path: '/api/health', entity: 'health' }] };
  mergeGapIntoScenario(plain, gap('/api/widgets'), { parsedTypes: types, typesLabel: 'types.ts' });
  assert.equal(plain.world.widgets.seed_first, undefined);
});
