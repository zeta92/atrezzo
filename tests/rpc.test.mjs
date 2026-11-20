// `rpc:` PostgREST functions: `serve` (real process) and the generated MSW handlers answer
// POST /rpc/<fn> and /rest/v1/rpc/<fn>; `match` checks arguments; an undeclared function is a gap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpProject, cli } from './helpers.mjs';
import { request, getJson } from './helpers/http.mjs';
import { startServe } from './helpers/serve.mjs';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { generateWorld } from '../scripts/lib/world.mjs';
import { hintFor } from '../scripts/lib/misses.mjs';

const CONFIG = JSON.stringify({
  version: 1, runtime: 'builtin', scenariosDir: 'scenarios', handlersDir: 'atrezzo/handlers', generatedDir: 'atrezzo/.generated',
  mock: { baseUrl: 'http://127.0.0.1:4010', port: 4010 }, verify: { driver: 'http' },
});

const BASE = `name: panel
seed: 3
world:
  items:
    total: 2
    fields:
      title: string
endpoints:
  - path: /rest/v1/items
    entity: items
`;
const SCENARIO = `${BASE}rpc:
  is_feature_on:
    expect: { status: 200 }
    body: true
  feature_settings:
    body: { mode: compact, limit: 5 }
    match: { feature: beta, level: 2 }
  touch_session:
    expect: { status: 204 }
`;

const JSON_H = { 'content-type': 'application/json' };
const call = async (url, path, body, method = 'POST') => {
  const r = await request(url + path, { method, headers: JSON_H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, headers: r.headers, text: r.text, body: r.text ? JSON.parse(r.text) : null };
};

let srv; let url;
before(async () => {
  const dir = tmpProject({ 'atrezzo.config.json': CONFIG, 'scenarios/panel.yaml': SCENARIO });
  srv = await startServe(dir);
  url = srv.url;
});
after(() => srv?.stop());

test('serve: a declared function answers its body on /rpc/<fn> and /rest/v1/rpc/<fn>, input ignored', async () => {
  for (const path of ['/rest/v1/rpc/is_feature_on', '/rpc/is_feature_on']) {
    const r = await call(url, path, { anything: 'goes' });
    assert.equal(r.status, 200, path);
    assert.equal(r.body, true, path);
    assert.equal(r.headers.get('x-atrezzo-scenario'), 'panel');
  }
  assert.equal((await call(url, '/rest/v1/rpc/is_feature_on')).body, true, 'no body at all');
  const empty = await call(url, '/rest/v1/rpc/touch_session', {});
  assert.equal(empty.status, 204);
  assert.equal(empty.text, '');
  const state = await getJson(`${url}/__atrezzo/state`);
  assert.deepEqual(state.body.rpc, ['is_feature_on', 'feature_settings', 'touch_session']);
});

test('serve: with match, the declared arguments must arrive with that value, otherwise 400', async () => {
  const ok = await call(url, '/rest/v1/rpc/feature_settings', { feature: 'beta', level: 2, extra: 'ignored' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { mode: 'compact', limit: 5 });
  const wrong = await call(url, '/rest/v1/rpc/feature_settings', { feature: 'other', level: 2 });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.message, /argument "feature" must be "beta" \(got "other"\)/);
  assert.deepEqual(wrong.body.atrezzo, { rpc: 'feature_settings', match: { feature: 'beta', level: 2 } });
  const missing = await call(url, '/rest/v1/rpc/feature_settings', { feature: 'beta' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.message, /"level" must be 2 \(got nothing\)/);
  const typed = await call(url, '/rest/v1/rpc/feature_settings', { feature: 'beta', level: '2' });
  assert.equal(typed.status, 400, 'the value is compared as JSON: "2" is not 2');
});

test('serve: an undeclared function answers 404 and is recorded in misses', async () => {
  await request(`${url}/__atrezzo/misses`, { method: 'DELETE' });
  const r = await call(url, '/rest/v1/rpc/unknown_fn', { x: 1 });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'PGRST202');
  assert.equal(r.body.atrezzo.miss, true);
  assert.equal(r.body.atrezzo.gap, 'POST /rest/v1/rpc/unknown_fn');
  assert.deepEqual(r.body.atrezzo.rpc, ['is_feature_on', 'feature_settings', 'touch_session']);
  assert.match(r.body.error, /not declared under rpc:/);
  const misses = await getJson(`${url}/__atrezzo/misses`);
  assert.equal(misses.body.unresolved, 1);
  assert.equal(misses.body.misses[0].method, 'POST');
  assert.equal(misses.body.misses[0].path, '/rest/v1/rpc/unknown_fn');
  assert.match(hintFor(misses.body.misses[0]), /declare it under rpc: \{ unknown_fn:/);
});

test('serve: a declared function only answers POST', async () => {
  const r = await call(url, '/rest/v1/rpc/is_feature_on', undefined, 'GET');
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'POST');
});

// Minimal 'msw' stub to import the generated handlers without installing msw.
const MSW_STUB = `
export const http = {
  get: (path, resolver) => ({ method: 'GET', path, resolver }),
  post: (path, resolver) => ({ method: 'POST', path, resolver }),
};
export const HttpResponse = Object.assign(
  function HttpResponse(body, init) { return { body, ...init }; },
  { json: (body, init) => ({ body, ...init }) },
);
`;

test('MSW handlers answer the same functions as serve', async () => {
  const dir = tmpProject({ 'panel.yaml': SCENARIO });
  const w = cli(['world', 'panel.yaml'], dir);
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stdout, /RPC is_feature_on {2}→ 200/);
  mkdirSync(join(dir, 'node_modules/msw'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/msw/package.json'), JSON.stringify({ name: 'msw', type: 'module', exports: './index.js' }));
  writeFileSync(join(dir, 'node_modules/msw/index.js'), MSW_STUB);
  const mod = await import(pathToFileURL(join(dir, 'atrezzo/.generated/panel.handlers.mjs')).href);
  const rpc = mod.handlers.find((h) => h.method === 'POST' && h.path === '*/rpc/:fn');
  assert.ok(rpc, 'one POST handler for every function');
  const post = (path, body) => rpc.resolver({ request: new Request(`http://localhost${path}`, { method: 'POST', headers: JSON_H, body: JSON.stringify(body) }) });

  for (const path of ['/rest/v1/rpc/is_feature_on', '/rpc/is_feature_on']) {
    const r = await post(path, {});
    assert.equal(r.status, 200);
    assert.equal(r.body, true);
  }
  assert.equal((await post('/rest/v1/rpc/feature_settings', { feature: 'beta', level: 2 })).status, 200);
  assert.equal((await post('/rest/v1/rpc/feature_settings', { feature: 'nope', level: 2 })).status, 400);
  const gap = await post('/rest/v1/rpc/unknown_fn', {});
  assert.equal(gap.status, 404);
  assert.equal(gap.body.atrezzo.miss, true);
  assert.equal(await post('/api/rpc/is_feature_on', {}), undefined, 'not a PostgREST route: MSW moves on');
});

test('scenario: rpc is validated and absent rpc keeps the hash', () => {
  const doc = (rpc) => ({ name: 'x', seed: 1, world: { items: { total: 1 } }, endpoints: [{ path: '/api/items', entity: 'items' }], ...(rpc === undefined ? {} : { rpc }) });
  const bad = (rpc, re) => assert.throws(() => normalizeScenario(doc(rpc)), (e) => e.issues?.some((i) => re.test(i)) || assert.fail(JSON.stringify(e.issues)));
  bad({}, /"rpc": must be a non-empty map/);
  bad({ 'rpc/f': { body: 1 } }, /function name/);
  bad({ f: { body: 1, extra: true } }, /extra/);
  bad({ f: { expect: { status: 99 } } }, /between 200 and 599/);
  bad({ f: { expect: { status: 204 }, body: 1 } }, /cannot have a response body/);
  bad({ f: { match: {} } }, /non-empty map/);
  assert.throws(() => normalizeScenario({ ...doc({ f: { body: 1 } }), writes: { 'POST /rest/v1/rpc/f': { expect: { status: 200 } } } }), (e) => e.issues.some((i) => /conflicts with writes/.test(i)));
  const plain = normalizeScenario(doc(undefined));
  assert.equal('rpc' in plain, false);
  assert.equal(generateWorld(plain).hash, generateWorld(normalizeScenario(doc(undefined))).hash);
  const withRpc = normalizeScenario(doc({ f: { body: false } }));
  assert.deepEqual(withRpc.rpc, [{ fn: 'f', expect: { status: 200 }, body: false }]);
  assert.notEqual(generateWorld(withRpc).hash, generateWorld(plain).hash);
});
