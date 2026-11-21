// 0.10: what a response can say that a flat list of rows cannot.
//   - `embed` entries with their own `embed` (children of children), at most 4 levels, no cycles;
//   - `pluck: <field>`: a list of plain values (as strings) instead of rows;
//   - `values_order: cycle`: a list of values handed out in the written order, the same on every seed;
//   - `error: { status, body }`: an endpoint that always answers that error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { normalizeScenario, loadFlow } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { generateWorld, scenarioHash } from '../scripts/lib/world.mjs';
import { createEngine } from '../scripts/lib/contract.mjs';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { handlersSource } from '../scripts/lib/codegen.mjs';
import { openapiDocument } from '../scripts/lib/runtimes/prism.mjs';
import { emit as emitWiremock } from '../scripts/lib/runtimes/wiremock.mjs';
import { runVerify, formatReport } from '../scripts/lib/verify.mjs';
import { tmpProject } from './helpers.mjs';
import { getJson } from './helpers/http.mjs';

const parse = (yaml) => normalizeScenario(parseYaml(yaml, 't.yaml'), 't.yaml');
const issues = (yaml) => { try { parse(yaml); } catch (e) { return e.issues.join('\n'); } return assert.fail('expected an invalid scenario'); };
const engineOf = (yaml) => {
  const scenario = parse(yaml);
  const dataset = generateWorld(scenario);
  const engine = createEngine(dataset);
  const get = (path, headers) => {
    const u = new URL(path, 'http://x');
    return engine.handle({ method: 'GET', pathname: u.pathname, query: u.searchParams, headers });
  };
  return { scenario, dataset, engine, get };
};
const strip = (row, keys) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

// ---------- nested embed ----------

const SHELF = `name: shelf
seed: 41
world:
  sections: 3
  items: { total: 9, ref: sections }
  tags: { total: 18, ref: items }
  notes: { total: 24, ref: tags }
endpoints:
  - path: /api/sections
    entity: sections
    embed:
      - entity: items
        embed: [tags]
  - path: /api/deep
    entity: sections
    embed:
      - entity: items
        embed:
          - entity: tags
            embed: [notes]
  - path: /api/flat
    entity: sections
    embed: [items]
`;

test('embed of two levels: sections[i].items[j].tags are the full child rows of each item', () => {
  const { dataset, get } = engineOf(SHELF);
  const W = dataset.entities;
  const body = get('/api/sections').body;
  assert.equal(body.length, 3);
  let tags = 0;
  for (const section of body) {
    const items = W.items.filter((r) => r.section_id === section.id);
    assert.deepEqual(section.items.map((it) => strip(it, ['tags'])), items, 'every item row, every field, world order');
    for (const item of section.items) {
      assert.deepEqual(item.tags, W.tags.filter((t) => t.item_id === item.id));
      assert.deepEqual(Object.keys(item.tags[0] ?? { id: 0, name: '', item_id: 0, created_at: '' }).sort(), ['created_at', 'id', 'item_id', 'name']);
      tags += item.tags.length;
    }
  }
  assert.equal(tags, W.tags.length, 'every tag hangs from exactly one item');
  // the detail route nests too, and the short form keeps its one-level answer
  assert.deepEqual(get('/api/sections/2').body, body[1]);
  assert.ok(get('/api/flat').body.every((s) => s.items.every((it) => !('tags' in it))));
});

test('embed of three levels reaches the notes of each tag; 4 levels is the limit', () => {
  const { dataset, get } = engineOf(SHELF);
  const notes = get('/api/deep').body.flatMap((s) => s.items.flatMap((it) => it.tags.flatMap((t) => {
    assert.deepEqual(t.notes, dataset.entities.notes.filter((n) => n.tag_id === t.id));
    return t.notes;
  })));
  assert.equal(notes.length, dataset.entities.notes.length);

  const chain = (levels) => {
    const names = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'].slice(0, levels + 1);
    const world = names.map((n, i) => `  ${n}: ${i ? `{ total: 2, ref: ${names[i - 1]} }` : 2}`).join('\n');
    let embed = `[${names.at(-1)}]`;
    for (let i = names.length - 2; i >= 1; i--) embed = `[{ entity: ${names[i]}, embed: ${embed} }]`;
    return `name: chain\nseed: 1\nworld:\n${world}\nendpoints:\n  - path: /api/l0\n    entity: l0\n    embed: ${embed}\n`;
  };
  const four = engineOf(chain(4)).get('/api/l0').body;
  assert.ok(Array.isArray(four[0].l1[0].l2[0].l3[0].l4), 'four levels below the endpoint answer');
  assert.match(issues(chain(5)), /embed nests at most 4 levels below the endpoint's entity \(l0 → l1 → l2 → l3 → l4 → l5\)/);
});

test('an embed cycle is an invalid scenario that names the path forming it', () => {
  const yaml = `name: loop
seed: 1
world:
  alphas: { total: 2, ref: betas }
  betas: { total: 2, ref: alphas }
endpoints:
  - path: /api/alphas
    entity: alphas
    embed:
      - entity: betas
        embed: [alphas]
`;
  assert.match(issues(yaml), /field "endpoints\[0\]\.embed\[0\]\.embed\[0\]": cycle: alphas → betas → alphas/);
  // each level checks its own ref: and its own keys
  assert.match(issues(SHELF.replace('embed: [tags]', 'embed: [notes]')), /"notes" does not reference "items" \(its refs: tags\)/);
  assert.match(issues(SHELF.replace('      - entity: items\n        embed: [tags]', '      - entity: items\n        with: [tags]')), /embed\[0\]\.with": unknown field \(allowed: entity, embed\)/);
  assert.match(issues(SHELF.replace('      - entity: items\n        embed: [tags]', '      - embed: [tags]')), /embed\[0\]\.entity": required/);
});

test('a nested entry without children normalizes to the short form (same hash as before 0.10)', () => {
  const short = parse(SHELF.replace(/ {6}- entity: items\n {8}embed: \[tags\]/, '      - items'));
  const long = parse(SHELF.replace(/ {6}- entity: items\n {8}embed: \[tags\]/, '      - entity: items'));
  assert.deepEqual(long.endpoints[0].embed, ['items']);
  assert.equal(scenarioHash(long), scenarioHash(short));
  assert.deepEqual(parse(SHELF).endpoints[0].embed, [{ entity: 'items', embed: ['tags'] }]);
});

test('MSW comments and the Prism schema describe the nested embed', () => {
  const { dataset } = engineOf(SHELF);
  assert.match(handlersSource(dataset), /\/api\/deep → sections · embeds: items\(tags\(notes\)\)/);
  const doc = openapiDocument(dataset, { mock: { baseUrl: 'http://127.0.0.1:4010' } });
  const item = doc.paths['/api/sections'].get.responses[200].content['application/json'].schema.items;
  const items = item.allOf[1].properties.items.items;
  assert.equal(items.allOf[0].$ref, '#/components/schemas/Item');
  assert.equal(items.allOf[1].properties.tags.items.$ref, '#/components/schemas/Tag');
});

// ---------- pluck ----------

const EVENTS = `name: feed
seed: 5
world:
  events:
    total: 3
    fields: { kind: [live, later], rank: integer }
    values_order: cycle
    nulls: { rank: 1 }
endpoints:
  - path: /api/events
    entity: events
    pluck: id
    filters: [kind]
  - path: /api/events-desc
    entity: events
    pluck: id
    filters: [kind]
    sort: -id
  - path: /api/event-page
    entity: events
    pluck: id
    shape: envelope
    pick: items
    pagination: { param_limit: limit, param_offset: offset }
  - path: /api/event-ranks
    entity: events
    pluck: rank
  - path: /api/first-event
    entity: events
    pluck: kind
    shape: object
`;

test('pluck: id answers ["1","2","3"] as strings, keeping filters and sort', () => {
  const { get } = engineOf(EVENTS);
  assert.deepEqual(get('/api/events').body, ['1', '2', '3']);
  assert.deepEqual(get('/api/events?kind=live').body, ['1', '3'], 'cycle: rows 1 and 3 are live');
  assert.deepEqual(get('/api/events-desc').body, ['3', '2', '1']);
  assert.deepEqual(get('/api/events-desc?kind=in.(live)').body, ['3', '1']);
  assert.ok(get('/api/events').body.includes(String(2)), 'what a client comparing includes(String(id)) needs');
  assert.equal(get('/api/events').headers['x-total-count'], '3');
});

test('pluck with envelope, pagination, detail and object', () => {
  const { get, dataset } = engineOf(EVENTS);
  assert.deepEqual(get('/api/event-page').body, { items: ['1', '2', '3'], total: 3, limit: null, offset: 0 });
  assert.deepEqual(get('/api/event-page?limit=2&offset=1').body, { items: ['2', '3'], total: 3, limit: 2, offset: 1 });
  assert.equal(get('/api/events/2').body, '2', 'the detail route answers the single value');
  assert.equal(get('/api/first-event').body, 'live');
  // a null stays null; every other value is a string
  const ranks = get('/api/event-ranks').body;
  assert.deepEqual(ranks, dataset.entities.events.map((e) => (e.rank === null ? null : String(e.rank))));
  assert.equal(ranks.filter((r) => r === null).length, 1);
  // .single() still gets one value or a 406
  assert.equal(get('/api/events?kind=later', { accept: 'application/vnd.pgrst.object+json' }).body, '2');
});

test('pluck of a field the entity lacks, or next to include/embed, is an invalid scenario', () => {
  assert.match(issues(EVENTS.replace('pluck: rank', 'pluck: score')), /field "endpoints\[3\]\.pluck": field "score" does not exist in "events" \(fields: id, kind, rank\)/);
  assert.match(issues(EVENTS.replace('pluck: rank', 'pluck: [rank]')), /endpoints\[3\]\.pluck": must be a field name/);
  assert.match(issues(`${SHELF}    pluck: id\n`), /endpoints\[2\]\.pluck": incompatible with embed: a plucked response is a list of values, not rows/);
});

test('the Prism document declares a plucked list as strings', () => {
  const { dataset } = engineOf(EVENTS);
  const doc = openapiDocument(dataset, { mock: { baseUrl: 'http://127.0.0.1:4010' } });
  assert.deepEqual(doc.paths['/api/events'].get.responses[200].content['application/json'].schema, { type: 'array', items: { type: 'string' } });
  assert.deepEqual(doc.paths['/api/event-ranks'].get.responses[200].content['application/json'].schema.items, { type: ['string', 'null'] });
});

// ---------- values_order ----------

const SLOTS = (seed, order = '    values_order: cycle\n') => `name: slots
seed: ${seed}
world:
  slots:
    total: 7
    fields: { label: [alpha, beta, gamma], title: string, open: boolean }
    values: { code: ["9001", "9002"] }
${order}endpoints:
  - path: /api/slots
    entity: slots
`;

const TEAMS = (seed, order = '    values_order: { cycle: { by: team_id } }\n') => `name: teams
seed: ${seed}
world:
  teams: 3
  members:
    total: 15
    ref: teams
    fields: { role: [owner, reader, guest], name: string }
${order}endpoints:
  - path: /api/members
    entity: members
`;

test('values_order: cycle hands out every list in the written order, the same on two seeds', () => {
  for (const seed of [1, 987654]) {
    const rows = generateWorld(parse(SLOTS(seed))).entities.slots;
    assert.deepEqual(rows.map((r) => r.label), ['alpha', 'beta', 'gamma', 'alpha', 'beta', 'gamma', 'alpha']);
    assert.deepEqual(rows.map((r) => r.code), ['9001', '9002', '9001', '9002', '9001', '9002', '9001']);
  }
});

test('without values_order (or with random) the lists stay drawn at random, and the other fields do not move', () => {
  const cycled = generateWorld(parse(SLOTS(1))).entities.slots;
  const drawn = generateWorld(parse(SLOTS(1, ''))).entities.slots;
  assert.notDeepEqual(drawn.map((r) => r.label), cycled.map((r) => r.label));
  assert.deepEqual(drawn.map((r) => [r.title, r.open]), cycled.map((r) => [r.title, r.open]), 'only the listed fields change');
  const random = parse(SLOTS(1, '    values_order: random\n'));
  assert.equal(scenarioHash(random), scenarioHash(parse(SLOTS(1, ''))), 'the default changes nothing, not even the hash');
});

const rolesPerTeam = (seed, order) => {
  const rows = generateWorld(parse(TEAMS(seed, order))).entities.members;
  const groups = new Map();
  for (const r of rows) { const g = groups.get(r.team_id) ?? []; g.push(r.role); groups.set(r.team_id, g); }
  return groups;
};
const cycleOf = (n) => Array.from({ length: n }, (_, i) => ['owner', 'reader', 'guest'][i % 3]);

test('values_order: { cycle: { by: <field> } } restarts the sequence for every group', () => {
  for (const seed of [1, 987654]) {
    const groups = rolesPerTeam(seed);
    assert.equal(groups.size, 3, 'three teams');
    assert.ok([...groups.values()].every((g) => g.length >= 2), 'every team has at least two members');
    for (const [team, roles] of groups) assert.deepEqual(roles, cycleOf(roles.length), `team ${team}, seed ${seed}`);
  }
});

test('values_order: the flat cycle does not restart per group, and the hash differs', () => {
  const flat = rolesPerTeam(1, '    values_order: cycle\n');
  assert.ok([...flat.values()].some((roles) => roles[0] !== 'owner'), 'some team starts mid-sequence without by');
  assert.notEqual(scenarioHash(parse(TEAMS(1))), scenarioHash(parse(TEAMS(1, '    values_order: cycle\n'))));
});

test('values_order: a bad "by" or an unknown key under cycle is invalid', () => {
  assert.match(issues(TEAMS(1, '    values_order: { cycle: { by: nope } }\n')),
    /world\.members\.values_order\.cycle\.by": field does not exist in "members"/);
  assert.match(issues(TEAMS(1, '    values_order: { cycle: { sort: id } }\n')),
    /world\.members\.values_order\.cycle\.sort": unknown field \(allowed: by\)/);
  assert.match(issues(TEAMS(1, '    values_order: { random: {} }\n')),
    /world\.members\.values_order": must be "random" or "cycle" or a map like \{ cycle: \{ by: <field> \} \}/);
});

test('values_order without a field with a list of values, or with an unknown value, is invalid', () => {
  assert.match(issues(SLOTS(1).replace('values_order: cycle', 'values_order: sorted')), /world\.slots\.values_order": must be "random" or "cycle"; got "sorted"/);
  const none = 'name: plain\nseed: 1\nworld:\n  boxes: { total: 2, fields: { width: integer, open: boolean }, values_order: cycle }\nendpoints:\n  - path: /api/boxes\n    entity: boxes\n';
  assert.match(issues(none), /world\.boxes\.values_order": "boxes" has no field with a list of values/);
});

// ---------- error ----------

const OUTAGE = (error = 'error: { status: 503, body: { code: "SERVICE_DOWN", retryAfter: 30 } }') => `name: outage
seed: 3
world:
  submissions: 4
  reports: 5
endpoints:
  - path: /api/submit
    entity: submissions
    ${error}
  - path: /api/fail
    entity: submissions
    error: { status: 500 }
  - path: /api/reports
    entity: reports
`;

test('error answers its exact status and body on the list and the detail route', () => {
  const { get } = engineOf(OUTAGE());
  for (const path of ['/api/submit', '/api/submit?limit=2', '/api/submit/1']) {
    const r = get(path);
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { code: 'SERVICE_DOWN', retryAfter: 30 });
    assert.equal(r.headers['x-atrezzo-error'], 'declared');
  }
  assert.deepEqual(get('/api/fail').body, { error: '500' }, 'body defaults to { error: "<status>" }');
  assert.equal(get('/api/fail').status, 500);
});

test('error leaves the world and the other endpoints alone', () => {
  const withError = engineOf(OUTAGE());
  const without = engineOf(OUTAGE('detail: true'));
  assert.deepEqual(withError.dataset.entities, without.dataset.entities);
  assert.deepEqual(withError.get('/api/reports').body, without.get('/api/reports').body);
  assert.equal(without.get('/api/submit').status, 200);
});

test('an invalid error is an invalid scenario', () => {
  for (const [bad, why] of [
    ['error: { status: 200 }', /endpoints\[0\]\.error\.status": required; an HTTP error status, an integer between 400 and 599; got 200/],
    ['error: { status: 600 }', /got 600/],
    ['error: { status: "503" }', /got "503"/],
    ['error: { body: { a: 1 } }', /error\.status": required/],
    ['error: { status: 503, retry: 1 }', /error\.retry": unknown field \(allowed: status, body\)/],
    ['error: 503', /endpoints\[0\]\.error": must be a map \{ status: 400-599, body: <JSON, optional> \}; got number/],
  ]) assert.match(issues(OUTAGE(bad)), why, bad);
});

test('serve reports the declared errors and answers them; verify takes them as answers (KO when data was expected)', async () => {
  const dir = tmpProject({
    'scenarios/outage.yaml': OUTAGE(),
    'flow.yaml': `scenario: scenarios/outage.yaml
steps:
  - screen: form
    requests:
      submit: GET /api/submit
      reports: GET /api/reports
    expect:
      - selector: "[data-testid=submission]"
        count: 2
        data: { request: submit }
      - selector: "[data-testid=submission-error]"
        count: 0
        data: { request: submit }
      - selector: "[data-testid=report]"
        count: 5
        data: { request: reports }
`,
  });
  const mock = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'outage' });
  const url = `http://127.0.0.1:${(await mock.listen(0)).port}`;
  try {
    const state = (await getJson(`${url}/__atrezzo/state`)).body;
    assert.deepEqual(state.errors, { '/api/submit': 503, '/api/fail': 500 });
    const r = await getJson(`${url}/api/submit`);
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { code: 'SERVICE_DOWN', retryAfter: 30 });
    assert.match(r.headers.get('access-control-expose-headers'), /x-atrezzo-error/);
    assert.equal((await getJson(`${url}/__atrezzo/misses`)).body.misses.length, 0, 'a declared error is not a gap');

    const res = await runVerify(loadFlow(join(dir, 'flow.yaml')), { url, driver: 'http', diagnose: true });
    assert.deepEqual(res.rows.map((x) => x.status), ['KO', 'OK', 'OK']);
    assert.equal(res.rows[0].obtained, 0);
    assert.match(res.rows[0].note, /submit answered the error the scenario declares \(503\): 0 rows/);
    assert.equal(res.rows[0].hypotheses[0].type, 'declared-error');
    assert.equal(res.exitCode, 1);
    assert.match(formatReport(res), /2 OK · 1 KO · 0 not verified → RED/);
  } finally {
    await mock.close();
  }
  // a scenario without error: keeps /state as it was (no errors key)
  const plain = createMockServer({ scenariosDir: join(tmpProject({ 's/a.yaml': OUTAGE('detail: true').replace(/  - path: \/api\/fail\n    entity: submissions\n    error: \{ status: 500 \}\n/, '') }), 's') });
  const purl = `http://127.0.0.1:${(await plain.listen(0)).port}`;
  try { assert.equal((await getJson(`${purl}/__atrezzo/state`)).body.errors, undefined); } finally { await plain.close(); }
});

test('Prism and WireMock carry the declared error instead of rows', () => {
  const { dataset } = engineOf(OUTAGE());
  const doc = openapiDocument(dataset, { mock: { baseUrl: 'http://127.0.0.1:4010' } });
  const list = doc.paths['/api/submit'].get.responses;
  assert.deepEqual(Object.keys(list), ['503']);
  assert.deepEqual(list[503].content['application/json'].examples.scenario.value, { code: 'SERVICE_DOWN', retryAfter: 30 });
  assert.deepEqual(Object.keys(doc.paths['/api/submit/{id}'].get.responses), ['503']);

  const out = emitWiremock({ dataset, config: { generatedDir: '.gen', mock: { port: 4010 } } });
  const file = out.files.find((f) => f.path.endsWith('mappings/api-submit.json'));
  const [mapping] = JSON.parse(file.content).mappings;
  assert.equal(mapping.response.status, 503);
  assert.deepEqual(mapping.response.jsonBody, { code: 'SERVICE_DOWN', retryAfter: 30 });
  assert.ok(new RegExp(mapping.request.urlPathPattern).test('/api/submit/7'));
  assert.ok(out.notes.some((n) => /\/api\/submit: declared error 503/.test(n)));
});
