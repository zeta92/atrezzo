import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ROOT, SCENARIO, tmpProject, cli } from './helpers.mjs';

// Minimal 'msw' stub to import the generated handlers without installing msw.
const MSW_STUB = `
export const http = {
  get: (path, resolver) => ({ method: 'GET', path, resolver }),
  head: (path, resolver) => ({ method: 'HEAD', path, resolver }),
  all: (path, resolver) => ({ method: 'ALL', path, resolver }),
  post: (path, resolver) => ({ method: 'POST', path, resolver }),
  put: (path, resolver) => ({ method: 'PUT', path, resolver }),
  patch: (path, resolver) => ({ method: 'PATCH', path, resolver }),
  delete: (path, resolver) => ({ method: 'DELETE', path, resolver }),
};
export const HttpResponse = Object.assign(
  function HttpResponse(body, init) { return { body, ...init }; },
  { json: (body, init) => ({ body, ...init }) },
);
export const delay = async () => {};
`;

test('world writes JSON, MSW handlers and a runtime identical to the engine', () => {
  const dir = tmpProject({ 'scenarios/conciliacion.yaml': SCENARIO });
  const r = cli(['world', 'scenarios/conciliacion.yaml'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /seed 7712/);
  assert.match(r.stdout, /orders\s+40\s+paid=34 pending=3 issue=3/);
  assert.match(r.stdout, /GET \/api\/orders/);
  const gen = join(dir, 'atrezzo/.generated');
  for (const f of ['conciliacion.json', 'conciliacion.handlers.mjs', 'runtime.mjs']) assert.ok(existsSync(join(gen, f)), f);
  assert.equal(readFileSync(join(gen, 'runtime.mjs'), 'utf8'), readFileSync(join(ROOT, 'scripts/lib/contract.mjs'), 'utf8'));
});

test('world is byte-for-byte deterministic across runs', () => {
  const a = tmpProject({ 'e.yaml': SCENARIO });
  const b = tmpProject({ 'e.yaml': SCENARIO });
  cli(['world', 'e.yaml'], a);
  cli(['world', 'e.yaml'], b);
  for (const f of ['conciliacion.json', 'conciliacion.handlers.mjs']) {
    assert.equal(readFileSync(join(a, 'atrezzo/.generated', f), 'utf8'), readFileSync(join(b, 'atrezzo/.generated', f), 'utf8'));
  }
});

test('the generated handlers project exactly like the engine', async () => {
  const dir = tmpProject({ 'e.yaml': SCENARIO });
  cli(['world', 'e.yaml'], dir);
  mkdirSync(join(dir, 'node_modules/msw'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/msw/package.json'), JSON.stringify({ name: 'msw', type: 'module', exports: './index.js' }));
  writeFileSync(join(dir, 'node_modules/msw/index.js'), MSW_STUB);
  const mod = await import(pathToFileURL(join(dir, 'atrezzo/.generated/conciliacion.handlers.mjs')).href);
  // GET y HEAD por ruta (HEAD es lo que pregunta supabase-js al pedir counts), y un 405 al final.
  assert.deepEqual([...new Set(mod.handlers.map((h) => h.path))], ['*/api/orders', '*/api/orders/:id', '*/api/customers', '*/api/customers/:id']);
  assert.deepEqual(mod.handlers.filter((h) => h.method === 'HEAD').map((h) => h.path), ['*/api/orders', '*/api/orders/:id', '*/api/customers', '*/api/customers/:id']);
  const res = mod.handlers[0].resolver({ request: new Request('http://localhost/api/orders?limit=3&status=paid') });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 3);
  assert.ok(res.body.every((p) => p.status === 'paid'));
  assert.equal(res.headers['x-total-count'], '34');
  assert.equal(mod.handlers[0].resolver({ request: new Request('http://localhost/other') }), undefined);
});

test('init: detects the stack, writes the config and does not overwrite it without --force', () => {
  const dir = tmpProject({ 'package.json': JSON.stringify({ dependencies: { next: '15', '@supabase/supabase-js': '2' } }) });
  const r1 = cli(['init'], dir);
  assert.equal(r1.code, 0, r1.stderr);
  assert.match(r1.stdout, /detected stack: next/);
  assert.match(r1.stdout, /@supabase\/supabase-js/);
  assert.match(r1.stdout, /nothing installed/);
  const cfg = JSON.parse(readFileSync(join(dir, 'atrezzo.config.json'), 'utf8'));
  assert.equal(cfg.stack, 'next');
  assert.ok(existsSync(join(dir, 'atrezzo/scenarios')) && existsSync(join(dir, 'atrezzo/handlers')));
  writeFileSync(join(dir, 'atrezzo.config.json'), JSON.stringify({ ...cfg, stack: 'mine' }));
  const r2 = cli(['init'], dir);
  assert.match(r2.stdout, /already exists; use --force/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'atrezzo.config.json'), 'utf8')).stack, 'mine');
  cli(['init', '--force'], dir);
  assert.equal(JSON.parse(readFileSync(join(dir, 'atrezzo.config.json'), 'utf8')).stack, 'next');
});

test('doctor: valid config, scenarios and generation state', () => {
  const dir = tmpProject({ 'package.json': '{}' });
  cli(['init'], dir);
  writeFileSync(join(dir, 'atrezzo/scenarios/conciliacion.yaml'), SCENARIO);
  let r = cli(['doctor'], dir);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /atrezzo\.config\.json valid/);
  assert.match(r.stdout, /scenario conciliacion\.yaml — not generated/);
  cli(['world', 'atrezzo/scenarios/conciliacion.yaml'], dir);
  r = cli(['doctor'], dir);
  assert.match(r.stdout, /generated, up to date/);
  writeFileSync(join(dir, 'atrezzo/scenarios/roto.yaml'), 'name: x\n');
  r = cli(['doctor'], dir);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /ERROR scenario roto\.yaml invalid/);
  writeFileSync(join(dir, 'atrezzo.config.json'), '{"version": 2}');
  r = cli(['doctor'], dir);
  assert.match(r.stdout, /atrezzo\.config\.json invalid/);
});

test('MSW handlers apply writes to the in-memory world, serve updated GETs, and reset restores initial state', async () => {
  const scenarioWithWrites = `${SCENARIO}
writes:
  "POST /api/orders":
    expect: { status: 201, echo: true }
    mutate: { entity: orders, set: { status: "nuevo" } }
  "PATCH /api/orders/:id":
    expect: { status: 200, echo: true }
    mutate: { entity: orders, set: { status: "enviado" } }
  "DELETE /api/orders/:id":
    expect: { status: 204 }
    mutate: { entity: orders }
`;
  const dir = tmpProject({ 'e.yaml': scenarioWithWrites });
  const r = cli(['world', 'e.yaml'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /POST \/api\/orders/);

  mkdirSync(join(dir, 'node_modules/msw'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/msw/package.json'), JSON.stringify({ name: 'msw', type: 'module', exports: './index.js' }));
  writeFileSync(join(dir, 'node_modules/msw/index.js'), MSW_STUB);

  const mod = await import(pathToFileURL(join(dir, 'atrezzo/.generated/conciliacion.handlers.mjs')).href);
  const findHandler = (method, path) => mod.handlers.find((h) => h.method === method && h.path === path);
  const getList = findHandler('GET', '*/api/orders');
  const getDetail = findHandler('GET', '*/api/orders/:id');
  const postOrder = findHandler('POST', '*/api/orders');
  const patchOrder = findHandler('PATCH', '*/api/orders/:id');
  const delOrder = findHandler('DELETE', '*/api/orders/:id');
  const resetHandler = findHandler('POST', '*/__atrezzo/reset');
  assert.ok(postOrder && patchOrder && delOrder && resetHandler);

  // POST creates order #41
  const created = await postOrder.resolver({
    request: new Request('http://localhost/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customer_id: 1, amount: 77 }),
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.id, 41);
  assert.equal(created.body.status, 'nuevo');

  // Subsequent GET reads see order #41
  const nuevoList = getList.resolver({ request: new Request('http://localhost/api/orders?status=nuevo') });
  assert.equal(nuevoList.body.length, 1);
  assert.equal(nuevoList.body[0].id, 41);
  assert.equal(getDetail.resolver({ request: new Request('http://localhost/api/orders/41') }).body.status, 'nuevo');

  // PATCH updates order #41
  const patched = await patchOrder.resolver({
    request: new Request('http://localhost/api/orders/41', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 120 }),
    }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.status, 'enviado');
  assert.equal(getDetail.resolver({ request: new Request('http://localhost/api/orders/41') }).body.amount, 120);

  // DELETE removes order #41 with 204 null body
  const deleted = await delOrder.resolver({ request: new Request('http://localhost/api/orders/41', { method: 'DELETE' }) });
  assert.equal(deleted.status, 204);
  assert.equal(deleted.body, null);
  assert.equal(getDetail.resolver({ request: new Request('http://localhost/api/orders/41') }).status, 404);

  // Create another, then reset via /__atrezzo/reset handler restores initial 40 orders
  await postOrder.resolver({
    request: new Request('http://localhost/api/orders', {
      method: 'POST',
      body: JSON.stringify({ customer_id: 1, amount: 50 }),
    }),
  });
  assert.equal(getList.resolver({ request: new Request('http://localhost/api/orders?status=nuevo') }).body.length, 1);
  const resetRes = await resetHandler.resolver({ request: new Request('http://localhost/__atrezzo/reset', { method: 'POST' }) });
  assert.equal(resetRes.status, 200);
  assert.equal(getList.resolver({ request: new Request('http://localhost/api/orders?status=nuevo') }).body.length, 0);
  assert.equal(getList.resolver({ request: new Request('http://localhost/api/orders') }).headers['x-total-count'], '40');
});
