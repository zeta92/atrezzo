// harvest, fourth pass: what kept a harvested view from rendering. Path parameters bound by name in the
// map form of `filters`, the response envelope found by trying, query flags kept out of the filters, and a
// detail id widened into the world before it is judged.
// Neutral vocabulary on purpose (Widget / Gadget): nothing in the code may know an app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseTsTypes } from '../scripts/lib/ts-types.mjs';
import { mergeGapIntoScenario, runHarvest, formatHarvestReport, isQueryFlag } from '../scripts/lib/harvest.mjs';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { generateWorld } from '../scripts/lib/world.mjs';
import { createEngine } from '../scripts/lib/contract.mjs';
import { tmpProject } from './helpers.mjs';

const TYPES = `export interface Gadget {
  id: number;
  widget_id: number;
  label: string;
}

export interface Widget {
  id: number;
  name: string;
  gadgets: Array<Gadget> | null;
}
`;
const PARTS = '/api/widgets/:widget_id/gadgets/:gadget_id/parts';

const baseDoc = () => ({ name: 'gaps', seed: 4, world: { health: 1 }, endpoints: [{ path: '/api/health', entity: 'health' }] });
const gap = (example, query = {}) => ({ method: 'GET', path: example, example, query });
const merge = (doc, example, query) => mergeGapIntoScenario(doc, gap(example, query), { parsedTypes: parseTsTypes(TYPES, 'types.ts'), typesLabel: 'types.ts' });
const datasetFor = (doc) => generateWorld(normalizeScenario(JSON.parse(JSON.stringify(doc)), 'gaps.yaml'));
const report = (records) => formatHarvestReport({
  targetUrl: '/', scenarioName: 'gaps', roundsRun: 1, stoppedReason: 'no-new-gaps', mutations: [], uninferrable: [],
  discovered: records, written: 'gaps.yaml',
});
const scenarioYaml = 'name: gaps\nseed: 4\nworld:\n  health: 1\nendpoints:\n  - path: /api/health\n    entity: health\n';

// ---------- 1. path parameters are bound by name, always in the map form ----------

test('a path with two parameters and query filters emits filters as a map and answers rows filtered by both', () => {
  const doc = baseDoc();
  merge(doc, '/api/widgets');
  const r = merge(doc, '/api/widgets/2/gadgets/3/parts', { colour: 'red' });
  assert.equal(r.record.path, PARTS);
  const ep = doc.endpoints.at(-1);
  assert.deepEqual(ep.filters, { ':widget_id': 'widget_id', ':gadget_id': 'gadget_id', colour: 'colour' },
    'never the list form: with two parameters it binds nothing');
  assert.deepEqual(doc.world.parts.ref, ['widgets', 'gadgets']);

  const dataset = datasetFor(doc);
  const engine = createEngine(dataset);
  const parts = dataset.entities.parts;
  const { widget_id: w, gadget_id: g } = parts[0];
  const expected = parts.filter((p) => p.widget_id === w && p.gadget_id === g);
  assert.ok(parts.some((p) => p.widget_id === w && p.gadget_id !== g), 'the fixture has parts of the same widget under other gadgets');
  const res = engine.handle({ pathname: `/api/widgets/${w}/gadgets/${g}/parts` });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((p) => p.id), expected.map((p) => p.id), 'exactly the parts of widget w AND gadget g');
  for (const p of res.body) assert.deepEqual([p.widget_id, p.gadget_id], [w, g]);
  // Same gadget under every other widget: each answer holds only rows of that widget AND that gadget.
  for (let other = 1; other <= dataset.entities.widgets.length; other++) {
    const r = engine.handle({ pathname: `/api/widgets/${other}/gadgets/${g}/parts` });
    assert.deepEqual(r.body.map((p) => p.id), parts.filter((p) => p.widget_id === other && p.gadget_id === g).map((p) => p.id));
  }

  // A query filter still applies on top of both parameters.
  const filtered = engine.handle({ pathname: `/api/widgets/${w}/gadgets/${g}/parts`, query: { colour: 'blue' } });
  assert.equal(filtered.status, 200);
});

test('a parameter for a segment the world does not model is bound to a field of its own name, not left open', () => {
  const doc = baseDoc();
  merge(doc, '/api/widgets');
  merge(doc, '/api/widgets/2/bins/9/parts');
  const ep = doc.endpoints.at(-1);
  assert.equal(ep.path, '/api/widgets/:widget_id/bins/:bin_id/parts');
  assert.deepEqual(ep.filters, { ':widget_id': 'widget_id', ':bin_id': 'bin_id' });
  assert.equal(doc.world.parts.fields.bin_id, 'integer');
  assert.deepEqual(doc.world.parts.values.bin_id, [9]);

  const engine = createEngine(datasetFor(doc));
  const seen = engine.handle({ pathname: '/api/widgets/2/bins/9/parts' });
  assert.ok(seen.body.length > 0, 'the observed URL has rows');
  for (const p of seen.body) assert.deepEqual([p.widget_id, p.bin_id], [2, 9]);
  assert.deepEqual(engine.handle({ pathname: '/api/widgets/2/bins/8/parts' }).body, [], 'another bin is another subset');

  // A single-parameter path is bound explicitly too.
  const single = merge(doc, '/api/widgets/3/gadgets');
  assert.equal(single.record.entity, 'gadgets');
  assert.deepEqual(doc.endpoints.at(-1).filters, { ':widget_id': 'widget_id' });
});

// ---------- 2. the response envelope is found by trying ----------

/** A fake page whose view only advances when /api/widgets answers `{ items: [...] }`. */
const envelopePage = (log) => async () => {
  let dom = ['div#app'];
  return {
    page: {
      on: () => {},
      off: () => {},
      evaluate: async () => dom,
      goto: async (u) => {
        const base = new URL(u).origin;
        dom = ['div#app'];
        const r1 = await fetch(`${base}/api/widgets`);
        if (!r1.ok) { log.push('widgets 404'); return; }
        const body = await r1.json();
        if (!Array.isArray(body?.items)) { log.push(Array.isArray(body) ? 'widgets array: stuck' : `widgets ${Object.keys(body)[0]}: stuck`); return; }
        log.push('widgets items: advanced');
        dom = [...dom, 'ul.widgets', 'li[data-testid="widget-row"]'];
        const r2 = await fetch(`${base}/api/widgets/${body.items[0].id}/gadgets`);
        if (!r2.ok) { log.push('gadgets 404'); return; }
        log.push('gadgets rendered');
        dom = [...dom, 'li.gadget'];
      },
    },
    close: async () => {},
  };
};

test('a page that only advances with { items: [...] }: the second attempt wins and the report says so', async () => {
  const dir = tmpProject({ 's.yaml': scenarioYaml });
  const log = [];
  const res = await runHarvest({ url: '/', scenarioFile: 's.yaml', rounds: 8, cwd: dir, pageFactory: envelopePage(log) });
  try {
    assert.deepEqual(log, [
      'widgets 404', // round 1: gap
      'widgets array: stuck', // round 2: attempt 1 (array) does not advance
      'widgets items: advanced', 'gadgets 404', // round 3: attempt 2 (items) does
      'widgets items: advanced', 'gadgets rendered', // round 4: the next gap is answered, the view advances
    ]);
    assert.equal(res.stoppedReason, 'no-new-gaps');
    assert.equal(res.roundsRun, 4);
    const widgets = res.scenario.endpoints.find((e) => e.path === '/api/widgets');
    assert.deepEqual(widgets, { path: '/api/widgets', entity: 'widgets', shape: 'envelope', pick: 'items' });
    assert.match(res.yaml, /- path: \/api\/widgets\n {4}entity: widgets\n {4}shape: envelope\n {4}pick: items\n/);
    const gadgets = res.scenario.endpoints.find((e) => e.path === '/api/widgets/:widget_id/gadgets');
    assert.equal(gadgets.pick, undefined, 'the array that made the view advance is kept as is');

    const rec = res.discovered.find((d) => d.path === '/api/widgets');
    assert.deepEqual(rec.responseShape, { result: 'advanced', attempts: ['array', 'items'], form: 'items' });
    const text = formatHarvestReport(res);
    assert.match(text, /Response shape \(the page did not advance with a plain array\):\n {2}- GET \/api\/widgets: shape: envelope, pick: items \(attempt 2 of 6: array → items; the first form that made the page advance\)/);
    assert.doesNotMatch(text, /GET \/api\/widgets\/:widget_id\/gadgets: shape: envelope/);
  } finally {
    rmSync(join(res.tempFile, '..'), { recursive: true, force: true });
  }
});

test('when no envelope makes the page advance, the endpoint stays an array and the report says so', async () => {
  const dir = tmpProject({ 's.yaml': scenarioYaml });
  const bodies = [];
  const res = await runHarvest({
    url: '/', scenarioFile: 's.yaml', rounds: 10, cwd: dir,
    pageFactory: async () => ({
      page: {
        on: () => {}, off: () => {}, evaluate: async () => ['div#app'],
        goto: async (u) => {
          const r = await fetch(`${new URL(u).origin}/api/widgets`);
          if (r.ok) { const b = await r.json(); bodies.push(Array.isArray(b) ? 'array' : Object.keys(b)[0]); }
        },
      },
      close: async () => {},
    }),
  });
  try {
    assert.deepEqual(bodies, ['array', 'items', 'data', 'results', 'records', 'rows'], 'each common envelope, in order');
    assert.equal(res.roundsRun, 7);
    assert.deepEqual(res.scenario.endpoints.at(-1), { path: '/api/widgets', entity: 'widgets' });
    assert.match(formatHarvestReport(res), /GET \/api\/widgets: the page did not advance with any response form \(array → items → data → results → records → rows\); left as array/);
  } finally {
    rmSync(join(res.tempFile, '..'), { recursive: true, force: true });
  }
});

// ---------- 3. query flags are not filters ----------

test('sort_by / order_by / filter_timezone and other flags stay out of filters and are reported as flags', () => {
  const doc = baseDoc();
  merge(doc, '/api/widgets');
  const query = { sort_by: 'due_date', order_by: 'desc', filter_timezone: 'UTC', colour: 'red', is_open: 'true', archived: 'false', withCounts: '1', has_gadgets: '1', order_id: '3' };
  const r = merge(doc, '/api/widgets/2/gadgets/3/parts', query);
  assert.deepEqual(doc.endpoints.at(-1).filters, { ':widget_id': 'widget_id', ':gadget_id': 'gadget_id', colour: 'colour', order_id: 'order_id' });
  for (const flag of ['sort_by', 'order_by', 'filter_timezone', 'is_open', 'archived', 'withCounts', 'has_gadgets']) {
    assert.equal(doc.world.parts.fields?.[flag], undefined, `${flag} is not a field`);
  }
  const text = report([r.record]);
  for (const flag of ['sort_by', 'order_by', 'filter_timezone', 'is_open', 'archived', 'withCounts', 'has_gadgets']) {
    assert.match(text, new RegExp(`GET ${PARTS.replace(/\//g, '\\/')}: query parameter "${flag}" left out of the filters \\(a flag, not a subset of rows\\)`));
  }
  assert.doesNotMatch(text, /"colour" left out|"order_id" left out/);

  assert.equal(isQueryFlag('sorted'), true);
  assert.equal(isQueryFlag('created_by'), true);
  assert.equal(isQueryFlag('status', ['open', 'true']), true, 'any boolean value');
  assert.equal(isQueryFlag('status', ['open']), false);
  assert.equal(isQueryFlag('filter_id'), false, 'a foreign key is a subset of rows');
});

// ---------- 4. a detail id is widened into the world before it is judged ----------

test('a detail with id 7 on an entity just created: the detail is served and total >= 7', async () => {
  const dir = tmpProject({ 's.yaml': scenarioYaml });
  const statuses = [];
  let dom = [];
  const res = await runHarvest({
    url: '/', scenarioFile: 's.yaml', cwd: dir,
    pageFactory: async () => ({
      page: {
        on: () => {}, off: () => {},
        evaluate: async () => dom,
        goto: async (u) => {
          const base = new URL(u).origin;
          const list = await fetch(`${base}/api/widgets`);
          const detail = await fetch(`${base}/api/widgets/7`);
          const body = detail.ok ? await detail.json() : null;
          statuses.push([list.status, detail.status, body?.id ?? null]);
          dom = list.ok && body ? ['li.widget', 'section#widget-detail'] : ['p.error'];
        },
      },
      close: async () => {},
    }),
  });
  try {
    // Round 1 creates widgets (5 rows) from the list gap; the detail gap of the same round widens it to 7.
    assert.deepEqual(statuses, [[404, 404, null], [200, 200, 7]]);
    assert.ok(res.scenario.world.widgets.total >= 7);
    assert.deepEqual(res.scenario.endpoints.at(-1), { path: '/api/widgets', entity: 'widgets' }, 'detail on by default');
    assert.deepEqual(res.discovered.map((d) => [d.path, d.source]), [['/api/widgets', 'guess'], ['/api/widgets', 'existing (total 5 → 7)']]);
    assert.doesNotMatch(formatHarvestReport(res), /not in "widgets"|not mocked/);
  } finally {
    rmSync(join(res.tempFile, '..'), { recursive: true, force: true });
  }
});

test('a detail is widened from 0 rows and past the old cap; only an id atrezzo cannot number is reported', () => {
  const doc = { name: 'gaps', seed: 4, world: { widgets: 0 }, endpoints: [{ path: '/api/widgets', entity: 'widgets' }] };
  const r = merge(doc, '/api/widgets/7');
  assert.equal(r.changed, true);
  assert.equal(doc.world.widgets.total, 7);
  assert.equal(r.record.source, 'existing (total 0 → 7)');
  assert.equal(createEngine(datasetFor(doc)).handle({ pathname: '/api/widgets/7' }).body.id, 7);

  const fresh = baseDoc();
  merge(fresh, '/api/gadgets/70');
  assert.equal(fresh.world.gadgets.total, 70, 'a first-seen detail creates the entity with enough rows');

  const already = merge(doc, '/api/widgets/3');
  assert.deepEqual([already.changed, already.notes], [false, []], 'the row exists: nothing to do, nothing to report');

  const uuid = '0b7f6c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f';
  const u = merge(doc, `/api/widgets/${uuid}`);
  assert.equal(u.changed, false);
  assert.deepEqual(u.notes, [`GET /api/widgets/${uuid}: detail id ${uuid} not mocked (not numeric: atrezzo rows have ids 1..total)`]);
});
