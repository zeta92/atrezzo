// Paths with parameters in the middle (`/projects/:project_id/views/:view_id/tasks`) and
// `embed:` (the child rows that point at each row), the two things a "detail with tabs" view needs.
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

// The Vikunja project screen: the project row carries its views, and the list view asks for the
// tasks of one project through one of its views.
const BOARD = `name: board
seed: 20261115
world:
  projects: 3
  views: { total: 2, ref: projects }
  tasks: { total: 24, ref: [projects, views] }
  teams: 2
  members: { total: 7, ref: teams }
endpoints:
  - path: /api/v2/projects
    entity: projects
    embed: [views]
  - path: /api/v2/projects/:project_id/views/:view_id/tasks
    entity: tasks
  - path: /api/v2/projects/:id/views
    entity: views
  - path: /api/v2/teams
    entity: teams
    embed: members
  - path: /api/v2/boards/:project/lists/:view/tasks
    entity: tasks
    filters: [id]
  - path: /api/v2/any/:project_id/views/:view_id/tasks
    entity: tasks
    filters: { ":view_id": null }
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
  const ep = scenario.endpoints.find((e) => e.path.endsWith('/:view_id/tasks') && e.path.includes('/projects/'));
  assert.deepEqual(ep.params, [{ name: 'project_id', field: 'project_id' }, { name: 'view_id', field: 'view_id' }]);
  let seen = 0;
  for (const p of W.projects) {
    for (const v of W.views) {
      const r = get(`/api/v2/projects/${p.id}/views/${v.id}/tasks`);
      assert.equal(r.status, 200);
      const want = W.tasks.filter((t) => t.project_id === p.id && t.view_id === v.id);
      assert.deepEqual(r.body.map((t) => t.id), want.map((t) => t.id), `project ${p.id} view ${v.id}`);
      assert.equal(r.headers['x-total-count'], String(want.length));
      seen += want.length;
    }
  }
  assert.equal(seen, W.tasks.length, 'every task is reachable through exactly one (project, view) pair');
  // query filters and pagination still apply on top of the parameters (here: none declared ⇒ ignored)
  assert.equal(get('/api/v2/projects/1/views/1/tasks?done=false').headers['x-atrezzo-ignored'], 'done');
  // a value no row has is an empty list, not a 404: the route exists
  assert.deepEqual(get('/api/v2/projects/99/views/1/tasks').body, []);
});

test('the detail route of a parameterised path answers only rows under its parameters', () => {
  const view = W.views[0];
  assert.deepEqual(get(`/api/v2/projects/${view.project_id}/views/${view.id}`).body, view);
  const other = W.projects.find((p) => p.id !== view.project_id);
  const r = get(`/api/v2/projects/${other.id}/views/${view.id}`);
  assert.equal(r.status, 404);
  assert.match(r.body.error, new RegExp(`views ${view.id} does not exist under project_id=${other.id}`));
});

test('a bare :id (single parameter) names the segment before it; :name falls back to <name>_id; null accepts any value', () => {
  const views = scenario.endpoints.find((e) => e.path === '/api/v2/projects/:id/views');
  assert.deepEqual(views.params, [{ name: 'id', field: 'project_id' }]);
  for (const p of W.projects) assert.deepEqual(get(`/api/v2/projects/${p.id}/views`).body, W.views.filter((v) => v.project_id === p.id));

  const short = scenario.endpoints.find((e) => e.path.startsWith('/api/v2/boards/'));
  assert.deepEqual(short.params, [{ name: 'project', field: 'project_id' }, { name: 'view', field: 'view_id' }]);
  const t = W.tasks[3];
  assert.deepEqual(get(`/api/v2/boards/${t.project_id}/lists/${t.view_id}/tasks?id=${t.id}`).body, [t]);

  const any = scenario.endpoints.find((e) => e.path.startsWith('/api/v2/any/'));
  assert.deepEqual(any.params, [{ name: 'project_id', field: 'project_id' }, { name: 'view_id', field: null }]);
  assert.deepEqual(get('/api/v2/any/2/views/whatever/tasks').body.map((x) => x.id), W.tasks.filter((x) => x.project_id === 2).map((x) => x.id));
});

test('an unknown parameter name is rejected with the fields it looked for and the way to map it', () => {
  const base = 'name: x\nseed: 1\nworld:\n  projects: 2\n  tasks: { total: 3, ref: projects }\nendpoints:\n';
  const msg = issues(`${base}  - path: /api/projects/:owner/tasks\n    entity: tasks\n`);
  assert.match(msg, /field "endpoints\[0\]\.path": parameter ":owner" binds to no field of "tasks" \(looked for "owner", "owner_id"; fields: id, name, project_id, created_at\); rename it after a field or map it: filters: \{ ":owner": <field> \}/);
  // two parameters, one unknown: no guessing for the second either
  assert.match(issues(`${base}  - path: /api/projects/:project_id/boards/:board_id/tasks\n    entity: tasks\n`), /parameter ":board_id" binds to no field of "tasks" \(looked for "board_id"/);
  // a bare :id whose segment names no field
  assert.match(issues(`${base}  - path: /api/boards/:id/tasks\n    entity: tasks\n`), /parameter ":id" binds to no field of "tasks" \(looked for "board_id"/);
  // with several parameters a bare :id is not guessed, even when the segment would name a field…
  const two = `${base}  - path: /api/projects/:id/lists/:list/tasks\n    entity: tasks\n`;
  assert.match(issues(two), /parameter ":id" binds to no field of "tasks" \(a path with several parameters does not guess what a bare ":id" names/);
  // …and the explicit map makes the same path valid
  const mapped = parse(`${two}    filters: { ":id": project_id, ":list": null }\n`);
  assert.deepEqual(mapped.endpoints[0].params, [{ name: 'id', field: 'project_id' }, { name: 'list', field: null }]);
  // the map form is checked too
  assert.match(issues(`${base}  - path: /api/p/:pid/tasks\n    entity: tasks\n    filters: { ":pid": owner_id }\n`), /field "endpoints\[0\]\.filters\.:pid": field "owner_id" does not exist in "tasks"/);
  assert.match(issues(`${base}  - path: /api/p/:pid/tasks\n    entity: tasks\n    filters: { ":nope": project_id, ":pid": project_id }\n`), /":nope" is not a parameter of "\/api\/p\/:pid\/tasks" \(parameters: :pid\)/);
  assert.match(issues(`${base}  - path: /api/tasks/:id\n    entity: tasks\n`), /a trailing "\/:id" is the detail route/);
  assert.match(issues(`${base}  - path: /api/p:x/tasks\n    entity: tasks\n`), /"p:x": a parameter is a whole segment/);
  assert.match(issues(`${base}  - path: /api/projects/:project_id/tasks\n    entity: tasks\n  - path: /api/projects/:id/tasks\n    entity: tasks\n`), /field "endpoints\[1\]\.path": duplicate/);
  // the explicit map wins over the naming rule
  const ok = parse(`${base}  - path: /api/p/:pid/tasks\n    entity: tasks\n    filters: { ":pid": project_id, name: name }\n`);
  assert.deepEqual(ok.endpoints[0].params, [{ name: 'pid', field: 'project_id' }]);
  assert.deepEqual(ok.endpoints[0].filters, ['name']);
});

test('embed adds the child rows that point at each row: zero, one and many', () => {
  const projects = get('/api/v2/projects').body;
  const counts = projects.map((p) => p.views.length).sort();
  assert.deepEqual(counts, [0, 1, 1], '3 projects, 2 views: one project has none');
  for (const p of projects) {
    assert.ok(Array.isArray(p.views));
    assert.deepEqual(p.views, W.views.filter((v) => v.project_id === p.id), `project ${p.id}`);
  }
  const empty = projects.find((p) => p.views.length === 0);
  assert.deepEqual(empty.views, []);
  const one = projects.find((p) => p.views.length === 1);
  assert.equal(one.views[0].project_id, one.id);
  // rows, not counts, and copies: the world is not touched
  assert.ok(typeof one.views[0].name === 'string');
  one.views[0].name = 'mutated';
  assert.notEqual(W.views.find((v) => v.id === one.views[0].id).name, 'mutated');

  const teams = get('/api/v2/teams').body;
  assert.equal(teams.reduce((n, t) => n + t.members.length, 0), 7);
  assert.ok(teams.some((t) => t.members.length > 1), 'many');
  for (const t of teams) assert.deepEqual(t.members.map((m) => m.id), W.members.filter((m) => m.team_id === t.id).map((m) => m.id));
  // the detail route embeds too
  assert.deepEqual(get(`/api/v2/projects/${one.id}`).body.views, one.views.map((v) => W.views.find((w) => w.id === v.id)));
  // and the world rows themselves gain no "views" key
  assert.equal(W.projects[0].views, undefined);
});

test('embed of an entity that does not ref the parent is rejected', () => {
  const base = 'name: x\nseed: 1\nworld:\n  projects: 2\n  tags: 3\n  views: { total: 2, ref: projects }\nendpoints:\n';
  assert.match(issues(`${base}  - path: /api/projects\n    entity: projects\n    embed: [tags]\n`), /field "endpoints\[0\]\.embed\[0\]": "tags" does not reference "projects" \(its refs: none\); embed lists the child rows that point at each row: add ref: projects to world\.tags/);
  assert.match(issues(`${base}  - path: /api/projects\n    entity: projects\n    embed: [boards]\n`), /"boards" is not declared in world/);
  assert.match(issues(`${base}  - path: /api/views\n    entity: views\n    embed: [projects]\n`), /"projects" does not reference "views"/);
  assert.match(issues(`${base}  - path: /api/projects\n    entity: projects\n    embed: [views, views]\n`), /"views" is listed twice/);
});

test('serve answers the Vikunja project screen: the project with its views, then the tasks of one view', async () => {
  const dir = tmpProject({ 'scenarios/board.yaml': BOARD });
  const mock = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'board' });
  const url = `http://127.0.0.1:${(await mock.listen(0)).port}`;
  try {
    let tasks = 0;
    for (const id of [1, 2, 3]) {
      const project = (await getJson(`${url}/api/v2/projects/${id}`)).body;
      assert.ok(Array.isArray(project.views));
      for (const v of project.views) {
        const r = await getJson(`${url}/api/v2/projects/${id}/views/${v.id}/tasks`);
        assert.equal(r.status, 200);
        assert.ok(r.body.every((t) => t.project_id === id && t.view_id === v.id));
        tasks += r.body.length;
      }
    }
    assert.ok(tasks > 0, 'the walk reached some tasks');
    // a parameterised route that is served is not a gap
    assert.equal((await getJson(`${url}/__atrezzo/misses`)).body.misses.length, 0);
    const gap = await getJson(`${url}/api/v2/projects/1/buckets`);
    assert.equal(gap.status, 404);
    assert.equal(gap.body.atrezzo.gap, 'GET /api/v2/projects/:id/buckets');
  } finally {
    await mock.close();
  }
});

test('MSW handlers, the Prism document and the misses hint understand parameterised paths', () => {
  const src = handlersSource(dataset);
  assert.match(src, /http\.get\('\*\/api\/v2\/projects\/:project_id\/views\/:view_id\/tasks', project\)/);
  assert.match(src, /http\.get\('\*\/api\/v2\/projects\/:id\/views\/:row_id', project\)/, 'the detail segment does not reuse :id');
  assert.match(src, /embeds: views/);

  const doc = openapiDocument(dataset, { mock: { baseUrl: 'http://127.0.0.1:4010' } });
  const op = doc.paths['/api/v2/projects/{project_id}/views/{view_id}/tasks'].get;
  assert.deepEqual(op.parameters.filter((x) => x.in === 'path').map((x) => x.name), ['project_id', 'view_id']);
  assert.ok(Array.isArray(op.responses[200].content['application/json'].examples.scenario.value));
  assert.ok(doc.paths['/api/v2/projects/{id}/views/{row_id}']);

  assert.deepEqual(coveringScenarios([scenario], '/api/v2/projects/:id/views/:id/tasks'), ['board']);
  assert.deepEqual(coveringScenarios([scenario], '/api/v2/projects/:id/views/:id/tasks/:id'), ['board']);
  assert.deepEqual(coveringScenarios([scenario], '/api/v2/projects/:id/buckets'), []);
});
