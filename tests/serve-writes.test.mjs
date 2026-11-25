// `writes:` through the real `atrezzo serve` process (ephemeral port): the world changes and later reads see it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpProject } from './helpers.mjs';
import { request, getJson, postJson, del } from './helpers/http.mjs';
import { startServe } from './helpers/serve.mjs';

const CONFIG = JSON.stringify({
  version: 1, runtime: 'builtin', scenariosDir: 'scenarios', handlersDir: 'atrezzo/handlers', generatedDir: 'atrezzo/.generated',
  mock: { baseUrl: 'http://127.0.0.1:4010', port: 4010 }, verify: { driver: 'http' },
});

// DELETE and PUT declare no `mutate`: their route is the contract endpoint, so the entity is inferred.
const POSTS = `name: posts
seed: 11
world:
  posts:
    total: 5
    fields:
      title: string
      kind: [draft, published, archived]
endpoints:
  - path: /api/posts
    entity: posts
  - path: /api/notes
    entity: posts
    detail: false
writes: { "POST /api/posts": { expect: { status: 201, echo: true }, mutate: { entity: posts, set: { kind: archived } } }, "DELETE /api/posts/:id": { expect: { status: 204 } } }
`;
const EXTRA = `  "PATCH /api/posts/:id":
    mutate: { entity: posts, set: { kind: published } }
  "PUT /api/posts/:id":
    expect: { status: 200, echo: true }
  "POST /api/ping":
    expect: { status: 202, body: { queued: true } }
  "POST /api/notes":
    expect: { status: 200 }
    mutate: false
`;
// Block-style writes added after the flow map: rewrite as a single block map.
const SCENARIO = POSTS.replace(/^writes: .*$/m, `writes:
  "POST /api/posts":
    expect: { status: 201, echo: true }
    mutate: { entity: posts, set: { kind: archived } }
  "DELETE /api/posts/:id":
    expect: { status: 204 }
${EXTRA}`);

let srv; let url;
const reset = () => postJson(`${url}/__atrezzo/reset`, '');
const JSON_H = { 'content-type': 'application/json' };
const send = async (method, path, body) => {
  const r = await request(url + path, { method, headers: JSON_H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, headers: r.headers, body: r.text ? JSON.parse(r.text) : null };
};

before(async () => {
  const dir = tmpProject({ 'atrezzo.config.json': CONFIG, 'scenarios/posts.yaml': SCENARIO });
  srv = await startServe(dir);
  url = srv.url;
});
after(() => srv?.stop());

test('banner lists every write with its inferred entity', () => {
  const log = srv.log();
  assert.match(log, /POST \/api\/posts {2}\(→ 201 · create posts\)/);
  assert.match(log, /DELETE \/api\/posts\/:id {2}\(→ 204 · delete posts, inferred from GET \/api\/posts\)/);
  assert.match(log, /PUT \/api\/posts\/:id {2}\(→ 200 · update posts, inferred from GET \/api\/posts\)/);
  assert.match(log, /POST \/api\/ping {2}\(→ 202\)/);
  assert.match(log, /POST \/api\/notes {2}\(→ 200\)/);
});

test('POST creates: declared status, echo of the new row, count grows, the row is readable', async () => {
  await reset();
  const r = await send('POST', '/api/posts', { title: 'Hello', kind: 'draft', ignored: 1 });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { id: 6, title: 'Hello', kind: 'archived' });
  assert.equal((await getJson(`${url}/__atrezzo/state`)).body.counts.posts, 6);
  assert.equal((await getJson(`${url}/api/posts`)).body.length, 6);
  assert.deepEqual((await getJson(`${url}/api/posts/6`)).body, { id: 6, title: 'Hello', kind: 'archived' });
});

test('PATCH modifies: payload plus mutate.set applied, persisted for later reads', async () => {
  await reset();
  const r = await send('PATCH', '/api/posts/2', { title: 'Edited' });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, 2);
  assert.equal(r.body.title, 'Edited');
  assert.equal(r.body.kind, 'published');
  assert.deepEqual((await getJson(`${url}/api/posts/2`)).body, r.body);
});

test('PUT without mutate updates the endpoint entity (inferred)', async () => {
  await reset();
  const r = await send('PUT', '/api/posts/4', { title: 'Replaced' });
  assert.equal(r.status, 200);
  assert.equal(r.body.title, 'Replaced');
  assert.equal((await getJson(`${url}/api/posts/4`)).body.title, 'Replaced');
});

test('DELETE without mutate removes the row; reset brings it back', async () => {
  await reset();
  const r = await del(`${url}/api/posts/3`);
  assert.equal(r.status, 204);
  assert.equal(r.body, null);
  assert.equal((await getJson(`${url}/api/posts/3`)).status, 404);
  assert.equal((await getJson(`${url}/api/posts`)).body.length, 4);
  assert.equal((await del(`${url}/api/posts/3`)).status, 404); // already gone

  const rs = await reset();
  assert.equal(rs.status, 200);
  assert.equal(rs.body.counts.posts, 5);
  const back = await getJson(`${url}/api/posts/3`);
  assert.equal(back.status, 200);
  assert.equal(back.body.id, 3);
});

test('reset also restores the id counter and undoes creates and updates', async () => {
  await reset();
  const before = (await getJson(`${url}/api/posts`)).body;
  await send('POST', '/api/posts', { title: 'A' });
  await send('PATCH', '/api/posts/1', { title: 'B' });
  await reset();
  assert.deepEqual((await getJson(`${url}/api/posts`)).body, before);
  assert.equal((await send('POST', '/api/posts', { title: 'C' })).body.id, 6);
});

test('expect.body wins; a route that is not an endpoint stays stateless', async () => {
  await reset();
  const r = await send('POST', '/api/ping', { anything: true });
  assert.equal(r.status, 202);
  assert.deepEqual(r.body, { queued: true });
  assert.equal((await getJson(`${url}/__atrezzo/state`)).body.counts.posts, 5);
});

test('mutate: false keeps an endpoint write stateless and answers {}', async () => {
  await reset();
  const r = await send('POST', '/api/notes', { title: 'X' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {});
  assert.equal((await getJson(`${url}/api/notes`)).body.length, 5);
});

test('undeclared method on a contract route ⇒ 405 with Allow; unknown route ⇒ 404; both list the writes', async () => {
  await reset();
  const r405 = await send('POST', '/api/posts/2', {});
  assert.equal(r405.status, 405);
  assert.deepEqual(r405.headers.get('allow').split(', ').sort(), ['DELETE', 'GET', 'PATCH', 'PUT']);
  assert.equal(r405.body.atrezzo.miss, true);
  assert.ok(r405.body.atrezzo.writes.includes('DELETE /api/posts/:id'));

  const r404 = await send('DELETE', '/api/comments/1');
  assert.equal(r404.status, 404);
  assert.equal(r404.body.atrezzo.miss, true);
  assert.ok(r404.body.atrezzo.writes.includes('POST /api/posts'));
});

test('405 for a method writes: cannot declare (TRACE) does not advise writes:; POST 405 still does', async () => {
  await reset();
  const trace = await send('TRACE', '/api/posts/2');
  assert.equal(trace.status, 405);
  assert.match(trace.body.error, /cannot be declared under writes:/);
  assert.doesNotMatch(trace.body.error, /add it under writes:/);

  const post = await send('POST', '/api/posts/2', {});
  assert.equal(post.status, 405);
  assert.match(post.body.error, /add it under writes:/);
});

test('a plain GET is untouched by the writes declaration', async () => {
  await reset();
  const list = await getJson(`${url}/api/posts`);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('x-total-count'), '5');
  assert.deepEqual(list.body.map((p) => p.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(Object.keys(list.body[0]), ['id', 'title', 'kind']);
});

test('the user flow-map scenario (DELETE with expect only) deletes too', async () => {
  const dir = tmpProject({ 'atrezzo.config.json': CONFIG, 'scenarios/posts.yaml': POSTS });
  const s = await startServe(dir);
  try {
    const created = await request(`${s.url}/api/posts`, { method: 'POST', body: '{"title":"N"}' });
    assert.equal(created.status, 201);
    assert.equal((await getJson(`${s.url}/__atrezzo/state`)).body.counts.posts, 6);
    assert.equal((await del(`${s.url}/api/posts/3`)).status, 204);
    assert.equal((await getJson(`${s.url}/api/posts/3`)).status, 404);
    assert.equal((await request(`${s.url}/api/posts/2`, { method: 'PATCH', body: '{}' })).status, 405);
    await postJson(`${s.url}/__atrezzo/reset`, '');
    assert.equal((await getJson(`${s.url}/api/posts/3`)).status, 200);
  } finally { s.stop(); }
});
