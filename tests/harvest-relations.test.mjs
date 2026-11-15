// harvest: relations deduced from the TypeScript type graph and the scenario's own `ref:`s.
// Neutral vocabulary on purpose (Widget / Gadget / Sprocket): nothing in the code may know an app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseTsTypes, typeRelations } from '../scripts/lib/ts-types.mjs';
import { mergeGapIntoScenario, runHarvest, formatHarvestReport } from '../scripts/lib/harvest.mjs';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { generateWorld } from '../scripts/lib/world.mjs';
import { createEngine } from '../scripts/lib/contract.mjs';
import { emitYaml } from '../scripts/lib/yaml-emit.mjs';
import { tmpProject } from './helpers.mjs';

const typesWith = (gadgetsMember) => `export type Finish = 'matte' | 'gloss';

export interface Gadget {
  id: number;
  widget_id: number;
  label: string;
  finish: Finish;
}

export interface Sprocket {
  id: number;
  teeth: number;
  spinning: boolean;
}

export interface Widget {
  id: number;
  name: string;
  tags: string[];
  ${gadgetsMember}
}
`;
const WIDGET_LINE = 20; // line of the gadgets member in typesWith()

const baseDoc = (world = { health: 1 }, endpoints = [{ path: '/api/health', entity: 'health' }]) => ({
  name: 'rel', seed: 3, world, endpoints,
});
const gap = (example) => ({ method: 'GET', path: example, example, query: {} });
const merge = (doc, example, types) => mergeGapIntoScenario(doc, gap(example), { parsedTypes: parseTsTypes(types, 'types.ts'), typesLabel: 'types.ts' });
const engineFor = (doc) => createEngine(generateWorld(normalizeScenario(JSON.parse(JSON.stringify(doc)), 'rel.yaml')));
const report = (records) => formatHarvestReport({
  targetUrl: '/', scenarioName: 'rel', roundsRun: 1, stoppedReason: 'no-new-gaps', mutations: [], uninferrable: [],
  discovered: records, written: 'rel.yaml',
});

test('a T[] field creates the child entity with its interface fields, ref: to the parent and embed on the parent endpoint', () => {
  const doc = baseDoc();
  const r = merge(doc, '/api/widgets', typesWith('gadgets: Gadget[];'));
  assert.equal(r.changed, true);
  assert.deepEqual(doc.world.widgets, { total: 5, fields: { name: 'string' }, values: { tags: [['item 1', 'item 2']] } });
  assert.deepEqual(doc.world.gadgets, {
    total: 10,
    ref: 'widgets',
    fields: { widget_id: 'integer', label: 'string', finish: ['matte', 'gloss'] },
  });
  assert.deepEqual(doc.endpoints.at(-1), { path: '/api/widgets', entity: 'widgets', embed: ['gadgets'] });
  assert.deepEqual(r.record.relations.map(({ text, emitted, projection, entity, created, source }) => ({ text, emitted, projection, entity, created, source })), [
    { text: 'Widget.gadgets: Gadget[]', emitted: true, projection: 'embed', entity: 'gadgets', created: true, source: `types:types.ts:${WIDGET_LINE}` },
  ]);

  // The mock answers every widget with the gadgets that point at it, with Gadget's fields.
  const res = engineFor(doc).handle({ pathname: '/api/widgets' });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 5);
  for (const w of res.body) {
    assert.ok(Array.isArray(w.gadgets));
    for (const g of w.gadgets) {
      assert.equal(g.widget_id, w.id);
      assert.equal(typeof g.label, 'string');
      assert.ok(['matte', 'gloss'].includes(g.finish));
    }
  }
  assert.equal(res.body.reduce((n, w) => n + w.gadgets.length, 0), 10);

  const text = report([r.record]);
  assert.match(text, /Relations \(from --types\):/);
  assert.match(text, new RegExp(`GET /api/widgets: Widget\\.gadgets: Gadget\\[\\] → embed \\[gadgets\\] \\(new entity gadgets, ref: widgets\\) \\(types:types\\.ts:${WIDGET_LINE}\\)`));
  assert.doesNotMatch(text, /gadgets \(array of Gadget\)/, 'a relation is not listed as an uninferrable field');
});

test('Array<T>, readonly T[], T[] | null and an optional T[] produce exactly the same scenario', () => {
  const emitted = ['gadgets: Gadget[];', 'gadgets: Array<Gadget>;', 'gadgets?: Gadget[];', 'readonly gadgets: readonly Gadget[];', 'gadgets: Gadget[] | null;']
    .map((member) => {
      const doc = baseDoc();
      merge(doc, '/api/widgets', typesWith(member));
      return emitYaml(doc);
    });
  for (const y of emitted.slice(1)) assert.equal(y, emitted[0]);
  assert.match(emitted[0], /embed:\n\s+- gadgets/);
});

test('scalars and arrays of scalars never become an embed', () => {
  const types = `export type Mood = 'calm' | 'loud';
export type Stamp = string;
export interface Widget {
  id: number;
  name: string;
  tags: string[];
  scores: Array<number>;
  mood: Mood;
  moods: Mood[];
  stamp: Stamp;
  made: Date;
  meta: Record<string, unknown>;
}
`;
  const parsed = parseTsTypes(types, 'types.ts');
  assert.deepEqual(typeRelations(parsed, 'Widget'), []);

  const doc = baseDoc();
  const r = merge(doc, '/api/widgets', types);
  const ep = doc.endpoints.at(-1);
  assert.equal(ep.embed, undefined);
  assert.equal(ep.include, undefined);
  assert.deepEqual(Object.keys(doc.world), ['health', 'widgets']);
  assert.deepEqual(r.record.relations, []);
  assert.deepEqual(doc.world.widgets.fields, { name: 'string', mood: ['calm', 'loud'], stamp: 'string', made: 'date' });
  assert.ok(r.record.uninferrable.some((u) => /^meta \(Record/.test(u)), 'a generic stays an uninferrable field, not a relation');
});

test('a relation whose type is not declared in the file is reported with its reason and changes nothing', () => {
  const withRel = baseDoc();
  const r = merge(withRel, '/api/widgets', typesWith('parts: Part[];\n  keeper: Keeper;'));
  const without = baseDoc();
  merge(without, '/api/widgets', typesWith(''));
  assert.deepEqual(withRel, without, 'the scenario is the same as if the relation were not in the type');
  assert.deepEqual(r.record.relations.map((x) => [x.text, x.emitted, x.reason]), [
    ['Widget.parts: Part[]', false, '"Part" is not declared in types.ts'],
    ['Widget.keeper: Keeper', false, '"Keeper" is not declared in types.ts'],
  ]);
  const text = report([r.record]);
  assert.doesNotMatch(text, /Relations \(from --types\)/);
  assert.match(text, /GET \/api\/widgets: Widget\.parts: Part\[\] → relation not mocked \(missing entity \+ ref\): "Part" is not declared in types\.ts \(types:types\.ts:20\)/);
  assert.match(text, /Widget\.keeper: Keeper → relation not mocked \(missing entity \+ ref\): "Keeper" is not declared in types\.ts \(types:types\.ts:21\)/);
});

test('a world entity that already refs the parent and stands for the type is reused as is, never duplicated', () => {
  const world = { widgets: 3, gadgets: { total: 7, ref: 'widgets', fields: { colour: 'string' } }, health: 1 };
  const doc = baseDoc(JSON.parse(JSON.stringify(world)));
  const r = merge(doc, '/api/widgets', typesWith('gadgets: Gadget[];'));
  assert.deepEqual(Object.keys(doc.world), ['widgets', 'gadgets', 'health']);
  assert.deepEqual(doc.world.gadgets, world.gadgets, 'reused untouched: same total, ref and fields');
  assert.deepEqual(doc.endpoints.at(-1).embed, ['gadgets']);
  assert.equal(r.record.relations[0].created, undefined);
  const res = engineFor(doc).handle({ pathname: '/api/widgets' });
  assert.equal(res.body.reduce((n, w) => n + w.gadgets.length, 0), 7);

  // A world entity for the type that does not ref the parent: reported, not duplicated, not modified.
  const loose = { widgets: 3, gadgets: { total: 4 }, health: 1 };
  const doc2 = baseDoc(JSON.parse(JSON.stringify(loose)));
  const r2 = merge(doc2, '/api/widgets', typesWith('gadgets: Gadget[];'));
  assert.deepEqual(doc2.world.gadgets, loose.gadgets);
  assert.deepEqual(Object.keys(doc2.world), ['widgets', 'gadgets', 'health']);
  assert.equal(doc2.endpoints.at(-1).embed, undefined);
  assert.equal(r2.record.relations[0].reason, 'world.gadgets stands for "Gadget" but has no ref: widgets');

  // The field name decides the embedded key: a field that differs from the entity is not faked.
  const doc3 = baseDoc();
  const r3 = merge(doc3, '/api/widgets', typesWith('parts: Gadget[];'));
  assert.equal(doc3.world.gadgets, undefined);
  assert.equal(doc3.endpoints.at(-1).embed, undefined);
  assert.equal(r3.record.relations[0].reason, 'embed would answer "gadgets", the type reads "parts"');
});

test('a T field includes the parent row when a world entity for T exists and the entity refs it', () => {
  const types = `${typesWith('gadgets: Gadget[];')}
export interface Bolt {
  id: number;
  widget: Widget;
  holder?: Widget | null;
}
`;
  const doc = baseDoc();
  merge(doc, '/api/widgets', types);
  // Gadget gets its own route: same entity as the embed, plus the parent row via include.
  const withParent = types.replace('  finish: Finish;\n}', '  finish: Finish;\n  widget: Widget;\n}');
  const rg = merge(doc, '/api/gadgets', withParent);
  assert.equal(rg.record.entity, 'gadgets');
  assert.deepEqual(doc.endpoints.at(-1), { path: '/api/gadgets', entity: 'gadgets', include: ['widgets'] });
  assert.equal(doc.world.gadgets.ref, 'widgets');

  // A new entity gets the ref; a field named differently from the parent's singular is reported.
  const rb = merge(doc, '/api/bolts', types);
  assert.equal(doc.world.bolts.ref, 'widgets');
  assert.deepEqual(doc.endpoints.at(-1).include, ['widgets']);
  assert.deepEqual(rb.record.relations.map((x) => [x.field, x.emitted, x.reason ?? x.projection]), [
    ['widget', true, 'include'],
    ['holder', false, 'include would answer "widget", the type reads "holder"'],
  ]);

  const res = engineFor(doc).handle({ pathname: '/api/bolts' });
  for (const b of res.body) assert.equal(b.widget.id, b.widget_id);
});

test('the nested route the app requests binds to the same entity as the embed, with its interface fields', async () => {
  const types = typesWith('gadgets: Gadget[];');
  // The direct child route projects the embedded entity, it does not create another one.
  const doc = baseDoc();
  merge(doc, '/api/widgets', types);
  const before = Object.keys(doc.world);
  const rc = merge(doc, '/api/widgets/2/gadgets', types);
  assert.equal(rc.record.entity, 'gadgets');
  assert.equal(rc.record.path, '/api/widgets/:widget_id/gadgets');
  assert.deepEqual(Object.keys(doc.world), before);
  assert.equal(doc.world.gadgets.ref, 'widgets');

  // End to end: the app can only build the deep URL from a row it has already read (widget.gadgets[0].id).
  const dir = tmpProject({
    's.yaml': 'name: rel\nseed: 9\nworld:\n  health: 1\nendpoints:\n  - path: /api/health\n    entity: health\n',
    'types.ts': types,
  });
  const deepStatuses = [];
  const res = await runHarvest({
    url: '/',
    scenarioFile: 's.yaml',
    typesFile: 'types.ts',
    cwd: dir,
    pageFactory: async () => ({
      page: {
        on: () => {},
        off: () => {},
        goto: async (u) => {
          const base = new URL(u).origin;
          const r1 = await fetch(`${base}/api/widgets`);
          if (!r1.ok) return;
          const widget = (await r1.json())[0];
          const gadget = widget.gadgets?.[0];
          if (!gadget) return; // without the embed the next step cannot even be requested
          const r2 = await fetch(`${base}/api/widgets/${widget.id}/gadgets/${gadget.id}/sprockets`);
          deepStatuses.push(r2.status);
        },
      },
      close: async () => {},
    }),
  });
  try {
    assert.deepEqual(res.discovered.map((d) => d.path), ['/api/widgets', '/api/widgets/:widget_id/gadgets/:gadget_id/sprockets']);
    assert.deepEqual(deepStatuses, [404, 200], 'round 2 reaches the deep route, round 3 gets it answered');
    const w = res.scenario.world;
    assert.deepEqual(Object.keys(w), ['health', 'widgets', 'gadgets', 'sprockets']);
    assert.deepEqual(w.sprockets.ref, ['widgets', 'gadgets'], 'the :gadget_id segment binds to the embedded entity');
    assert.deepEqual(w.sprockets.fields, { teeth: 'integer', spinning: 'boolean' });
    assert.deepEqual(res.scenario.endpoints.find((e) => e.path === '/api/widgets').embed, ['gadgets']);
    const text = formatHarvestReport(res);
    assert.match(text, /Widget\.gadgets: Gadget\[\] → embed \[gadgets\]/);
  } finally {
    rmSync(join(res.tempFile, '..'), { recursive: true, force: true });
  }
});

test('decisions depend only on the type graph: renaming every type and route yields the same scenario, renamed', () => {
  const rename = (s) => s.replace(/Widget/g, 'Alpha').replace(/widget/g, 'alpha').replace(/Gadget/g, 'Beta').replace(/gadget/g, 'beta');
  const types = typesWith('gadgets: Gadget[];');
  const a = baseDoc();
  merge(a, '/api/widgets', types);
  merge(a, '/api/widgets/1/gadgets', types);
  const b = baseDoc();
  merge(b, '/api/alphas', rename(types));
  merge(b, '/api/alphas/1/betas', rename(types));
  assert.equal(emitYaml(b), rename(emitYaml(a)));
});
