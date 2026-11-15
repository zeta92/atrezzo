// `shape: object`: endpoints whose response is one row (GET /info, GET /user), not a collection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { generateWorld } from '../scripts/lib/world.mjs';
import { createEngine } from '../scripts/lib/contract.mjs';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { tmpProject } from './helpers.mjs';
import { getJson } from './helpers/http.mjs';

// What an SPA asks for before anything else: its config and the current user.
const BOOT = `name: boot
seed: 20261115
world:
  info:
    total: 1
    fields: { version: string, frontend_url: url }
  users: 4
  projects: 0
endpoints:
  - path: /api/v2/info
    entity: info
    shape: object
  - path: /api/v2/user
    entity: users
    shape: object
    filters: [id, role]
    sort: -id
  - path: /api/v2/projects
    entity: projects
    shape: object
  - path: /api/v2/users
    entity: users
`;

const parse = (yaml) => normalizeScenario(parseYaml(yaml, 't.yaml'), 't.yaml');
const dataset = generateWorld(parse(BOOT));
const engine = createEngine(dataset);
const get = (path) => {
  const u = new URL(path, 'http://x');
  return engine.handle({ method: 'GET', pathname: u.pathname, query: u.searchParams });
};

test('shape: object returns the row as a JSON object with the entity fields, not an array', () => {
  const r = get('/api/v2/info');
  assert.equal(r.status, 200);
  assert.ok(r.body !== null && typeof r.body === 'object' && !Array.isArray(r.body), `got ${JSON.stringify(r.body)}`);
  assert.deepEqual(Object.keys(r.body).sort(), [...dataset.schema.info.fields].sort());
  assert.deepEqual(Object.keys(r.body).sort(), ['frontend_url', 'id', 'version']);
  assert.deepEqual(r.body, dataset.entities.info[0]);
  assert.equal(typeof r.body.version, 'string');
  assert.equal(r.miss, undefined);
  // the collection route of the same entity is still a list
  assert.ok(Array.isArray(get('/api/v2/users').body));
});

test('shape: object honours filters and sort and answers the first row', () => {
  // sort: -id ⇒ the highest id comes first
  assert.equal(get('/api/v2/user').body.id, 4);
  assert.equal(get('/api/v2/user?role=operator').body.id, 4);
  // the flow passes ?id= to pick the logged-in user (no header semantics)
  const one = get('/api/v2/user?id=1');
  assert.equal(one.status, 200);
  assert.deepEqual(one.body, dataset.entities.users.find((u) => u.id === 1));
  assert.equal(one.body.role, 'admin');
  // several matches ⇒ the first after sort, never a list
  const many = get('/api/v2/user?id=1,2,3');
  assert.equal(many.body.id, 3);
  assert.ok(!Array.isArray(many.body));
  // undeclared parameters are still reported
  assert.equal(get('/api/v2/user?color=red').headers['x-atrezzo-ignored'], 'color');
  // a filter that matches nothing is a plain 404, not a gap: the entity exists
  const none = get('/api/v2/user?id=99');
  assert.equal(none.status, 404);
  assert.match(none.body.error, /no users matches id=99/);
  assert.equal(none.miss, undefined);
  assert.equal(none.body.atrezzo, undefined);
});

test('shape: object on an empty entity answers 404 with the miss body and serve records the gap', async () => {
  const direct = get('/api/v2/projects');
  assert.equal(direct.status, 404);
  assert.equal(direct.miss, true);
  assert.equal(direct.body.atrezzo.miss, true);

  const dir = tmpProject({ 'scenarios/boot.yaml': BOOT });
  const mock = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'boot' });
  const url = `http://127.0.0.1:${(await mock.listen(0)).port}`;
  try {
    const r = await getJson(`${url}/api/v2/projects`);
    assert.equal(r.status, 404);
    assert.match(r.body.error, /projects has no rows in scenario "boot"/);
    // same shape as any other gap
    assert.equal(r.body.atrezzo.miss, true);
    assert.equal(r.body.atrezzo.gap, 'GET /api/v2/projects');
    assert.equal(r.body.atrezzo.times, 1);
    assert.equal(r.body.atrezzo.next, 'atrezzo misses');
    assert.ok(r.body.atrezzo.endpoints.includes('/api/v2/projects'));
    const gaps = (await getJson(`${url}/__atrezzo/misses`)).body;
    assert.equal(gaps.unresolved, 1);
    assert.deepEqual(gaps.misses.map((m) => [`${m.method} ${m.path}`, m.resolved]), [['GET /api/v2/projects', false]]);
    // a served singleton is not a gap
    assert.equal((await getJson(`${url}/api/v2/info`)).status, 200);
    assert.equal((await getJson(`${url}/__atrezzo/misses`)).body.misses.length, 1);
  } finally {
    await mock.close();
  }
});

test('shape: object on a detail route keeps today\'s behaviour', () => {
  const asList = createEngine(generateWorld(parse(BOOT.replace(/shape: object\n {4}filters: \[id, role\]/, 'filters: [id, role]'))));
  assert.ok(Array.isArray(asList.handle({ method: 'GET', pathname: '/api/v2/user', query: new URLSearchParams() }).body), 'the baseline is the same endpoint with shape: array');
  for (const path of ['/api/v2/user/2', '/api/v2/user/99']) {
    const a = get(path);
    const b = asList.handle({ method: 'GET', pathname: path, query: new URLSearchParams() });
    assert.equal(a.status, b.status, path);
    assert.deepEqual(a.body, b.body, path);
  }
  assert.deepEqual(get('/api/v2/user/2').body, dataset.entities.users.find((u) => u.id === 2));
  assert.equal(get('/api/v2/user/99').status, 404);
});

test('shape: object is validated: no pagination or pick, unknown shapes name the valid ones', () => {
  const bad = (ep) => () => parse(`name: x\nseed: 1\nworld:\n  users: 2\nendpoints:\n  - path: /u\n    entity: users\n${ep}`);
  const issues = (fn) => { try { fn(); } catch (e) { return e.issues.join('\n'); } return assert.fail('expected an invalid scenario'); };
  assert.match(issues(bad('    shape: object\n    pagination: { param_limit: limit }\n')), /field "endpoints\[0\]\.pagination": incompatible with shape: object/);
  assert.match(issues(bad('    shape: object\n    pick: data\n')), /field "endpoints\[0\]\.pick": incompatible with shape: object/);
  assert.match(issues(bad('    shape: single\n')), /field "endpoints\[0\]\.shape": must be "array", "envelope", "object"/);
});
