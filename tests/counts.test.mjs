// Embedded relation counts (`select=*,child(count)`) and count-only requests (`head=true`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildState, createMockServer } from '../scripts/lib/serve.mjs';
import { tmpProject, cli } from './helpers.mjs';
import { request } from './helpers/http.mjs';

// Three cases; documents, deadlines and notifications ref the case; tags ref nothing;
// invoices ref customers, not cases.
const CASES = `name: expedientes
seed: 4242
now: 2025-03-01T09:00:00Z
world:
  expedientes: 3
  documentos:
    total: 6
    ref: expedientes
  plazos:
    total: 5
    ref: expedientes
  notificaciones:
    total: 4
    ref: expedientes
  etiquetas: 2
  customers: 2
  invoices:
    total: 3
    ref: customers
endpoints:
  - path: /rest/v1/expedientes
    entity: expedientes
    filters: [id]
  - path: /rest/v1/documentos
    entity: documentos
    filters: [expediente_id]
  - path: /rest/v1/plazos
    entity: plazos
    filters: [expediente_id]
  - path: /rest/v1/notificaciones
    entity: notificaciones
    filters: [expediente_id]
`;

let state; let engine; let dir;
before(() => {
  dir = tmpProject({ 'scenarios/expedientes.yaml': CASES });
  state = buildState(join(dir, 'scenarios/expedientes.yaml'));
  engine = state.engine;
});

const get = (path) => {
  const u = new URL(path, 'http://localhost');
  return engine.handle({ pathname: u.pathname, query: u.searchParams });
};
/** Rows a direct call to the child endpoint returns for one parent. */
const direct = (child, id) => get(`/rest/v1/${child}?expediente_id=${id}`).body.length;

test('counts: select=*,child(count) embeds [{count: n}] and n equals the direct child call for that parent', () => {
  const r = get('/rest/v1/expedientes?select=*,documentos(count)');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 3);
  for (const row of r.body) {
    assert.deepEqual(row.documentos, [{ count: direct('documentos', row.id) }], `expediente ${row.id}`);
  }
  // the world holds six documents, every one of them is counted under its case
  assert.equal(r.body.reduce((s, row) => s + row.documentos[0].count, 0), 6);
  assert.ok(r.body.every((row) => row.documentos[0].count > 0), 'at least as many children as parents ⇒ every case has one');
  // `select` was fully honoured: not reported as ignored
  assert.equal(r.headers['x-atrezzo-ignored'], undefined);
});

test('counts: several children at once, as the case list asks for them', () => {
  const r = get('/rest/v1/expedientes?select=*,documentos(count),plazos(count),notificaciones(count)');
  for (const row of r.body) {
    for (const child of ['documentos', 'plazos', 'notificaciones']) {
      assert.deepEqual(row[child], [{ count: direct(child, row.id) }], `${child} of expediente ${row.id}`);
    }
  }
  assert.deepEqual(['documentos', 'plazos', 'notificaciones'].map((c) => r.body.reduce((s, row) => s + row[c][0].count, 0)), [6, 5, 4]);
});

test('counts: alias:child(count) puts the count under the alias', () => {
  const r = get('/rest/v1/expedientes?select=*,total:documentos(count),plazos(count)');
  for (const row of r.body) {
    assert.deepEqual(row.total, [{ count: direct('documentos', row.id) }]);
    assert.deepEqual(row.plazos, [{ count: direct('plazos', row.id) }]);
    assert.equal(row.documentos, undefined, 'the alias replaces the name');
  }
});

test('counts: detail route and filters keep the counts, the world stays untouched', () => {
  const one = get('/rest/v1/expedientes/2?select=*,documentos(count)');
  assert.deepEqual(one.body.documentos, [{ count: direct('documentos', 2) }]);
  const filtered = get('/rest/v1/expedientes?id=2&select=*,documentos(count)');
  assert.deepEqual(filtered.body, [one.body]);
  // projections copy rows: the dataset (and so the generated JSON and its hash) never gains a count
  assert.ok(state.dataset.entities.expedientes.every((row) => !('documentos' in row)));
  assert.equal(buildState(join(dir, 'scenarios/expedientes.yaml')).dataset.hash, state.dataset.hash);
});

test('counts: select without any (count) leaves the rows untouched', () => {
  const plain = get('/rest/v1/expedientes').body;
  for (const select of ['*', 'id,name', '*,documentos(id,name)', '*,documentos(*)', '*,documentos( count )']) {
    const r = get(`/rest/v1/expedientes?select=${encodeURIComponent(select)}`);
    assert.deepEqual(r.body, plain, select);
  }
  // a select the mock does not honour completely is still reported as ignored
  assert.equal(get('/rest/v1/expedientes?select=id,name').headers['x-atrezzo-ignored'], 'select');
  assert.equal(get('/rest/v1/expedientes?select=*').headers['x-atrezzo-ignored'], undefined);
});

test('counts: an unknown embedded name and a child that does not ref the parent leave the rows untouched', () => {
  const plain = get('/rest/v1/expedientes').body;
  for (const select of ['*,facturas(count)', '*,etiquetas(count)', '*,invoices(count)', '*,expedientes(count)', '*,constructor(count)']) {
    const r = get(`/rest/v1/expedientes?select=${encodeURIComponent(select)}`);
    assert.deepEqual(r.body, plain, select);
    assert.equal(r.headers['x-atrezzo-ignored'], 'select', select);
  }
  // mixed: the valid count is added, the unknown one is not invented
  const mixed = get('/rest/v1/expedientes?select=*,documentos(count),facturas(count)').body;
  for (const row of mixed) {
    assert.deepEqual(Object.keys(row), [...Object.keys(plain[0]), 'documentos']);
  }
});

// ---------- count only: head=true over real HTTP ----------

let mock; let url;
before(async () => {
  mock = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'expedientes' });
  url = `http://127.0.0.1:${(await mock.listen(0)).port}`;
});
after(() => mock.close());

const PREFER = { prefer: 'count=exact' };

test('head=true + Prefer: count=exact ⇒ 200, empty body, Content-Range 0-(n-1)/n', async () => {
  const r = await request(`${url}/rest/v1/documentos?select=*&head=true`, { headers: PREFER });
  assert.equal(r.status, 200);
  assert.equal(r.text, '');
  assert.equal(r.headers.get('content-range'), '0-5/6');
  assert.match(r.headers.get('access-control-expose-headers'), /content-range/);
  assert.equal(r.headers.get('x-atrezzo-ignored'), null, 'select=* and head are understood');
  // head=true alone counts the same way
  const bare = await request(`${url}/rest/v1/documentos?head=true`);
  assert.equal(bare.text, '');
  assert.equal(bare.headers.get('content-range'), '0-5/6');
});

test('head=true respects the endpoint filters and agrees with the embedded count', async () => {
  const embedded = get('/rest/v1/expedientes?select=*,documentos(count)').body;
  for (const row of embedded) {
    const r = await request(`${url}/rest/v1/documentos?expediente_id=${row.id}&head=true`, { headers: PREFER });
    const n = row.documentos[0].count;
    assert.equal(r.status, 200);
    assert.equal(r.text, '');
    assert.equal(r.headers.get('content-range'), `0-${n - 1}/${n}`, `expediente ${row.id}`);
  }
});

test('head=true with an empty result ⇒ Content-Range 0-0/0 and no rows', async () => {
  const r = await request(`${url}/rest/v1/documentos?expediente_id=99&head=true`, { headers: PREFER });
  assert.equal(r.status, 200);
  assert.equal(r.text, '');
  assert.equal(r.headers.get('content-range'), '0-0/0');
  assert.equal(r.headers.get('x-total-count'), '0');
});

test('a HEAD request with Prefer: count=exact (how supabase-js counts) gets the same Content-Range', async () => {
  const r = await request(`${url}/rest/v1/plazos?select=*&expediente_id=1`, { method: 'HEAD', headers: PREFER });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-range'), `0-${direct('plazos', 1) - 1}/${direct('plazos', 1)}`);
  // without head=true or Prefer, a GET still returns the rows and no Content-Range
  const g = await request(`${url}/rest/v1/plazos?expediente_id=1`);
  assert.equal(JSON.parse(g.text).length, direct('plazos', 1));
  assert.equal(g.headers.get('content-range'), null);
});

test('the generated MSW handlers inherit counts and count-only answers', async () => {
  const gen = tmpProject({ 'e.yaml': CASES });
  assert.equal(cli(['world', 'e.yaml'], gen).code, 0);
  mkdirSync(join(gen, 'node_modules/msw'), { recursive: true });
  writeFileSync(join(gen, 'node_modules/msw/package.json'), JSON.stringify({ name: 'msw', type: 'module', exports: './index.js' }));
  writeFileSync(join(gen, 'node_modules/msw/index.js'), `
export const http = {
  get: (path, resolver) => ({ method: 'GET', path, resolver }),
  head: (path, resolver) => ({ method: 'HEAD', path, resolver }),
  all: (path, resolver) => ({ method: 'ALL', path, resolver }),
};
export const delay = async () => {};
export class HttpResponse { constructor(body, init) { this.body = body; Object.assign(this, init); } static json(body, init) { return { body, ...init }; } }
`);
  const mod = await import(pathToFileURL(join(gen, 'atrezzo/.generated/expedientes.handlers.mjs')).href);
  const list = mod.handlers.find((h) => h.path === '*/rest/v1/expedientes');
  const res = list.resolver({ request: new Request('http://localhost/rest/v1/expedientes?select=*,documentos(count)') });
  assert.deepEqual(res.body.map((row) => row.documentos[0].count), get('/rest/v1/expedientes?select=*,documentos(count)').body.map((row) => row.documentos[0].count));
  const docs = mod.handlers.find((h) => h.path === '*/rest/v1/documentos');
  const head = docs.resolver({ request: new Request('http://localhost/rest/v1/documentos?head=true', { headers: PREFER }) });
  const msw = await import(pathToFileURL(join(gen, 'node_modules/msw/index.js')).href);
  assert.ok(head instanceof msw.HttpResponse, 'a bodiless HttpResponse, not HttpResponse.json(null)');
  assert.equal(head.body, null);
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-range'], '0-5/6');
});
