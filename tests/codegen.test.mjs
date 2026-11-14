import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ROOT, SCENARIO, tmpProject, cli } from './helpers.mjs';

// Stub mínimo de 'msw' para importar los handlers generados sin instalar msw.
const MSW_STUB = `
export const http = { get: (path, resolver) => ({ method: 'GET', path, resolver }) };
export const HttpResponse = { json: (body, init) => ({ body, ...init }) };
`;

test('world escribe JSON, handlers MSW y runtime idéntico al motor', () => {
  const dir = tmpProject({ 'escenarios/conciliacion.yaml': SCENARIO });
  const r = cli(['world', 'escenarios/conciliacion.yaml'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /semilla 7712/);
  assert.match(r.stdout, /pedidos\s+40\s+pagado=34 pendiente=3 incidencia=3/);
  assert.match(r.stdout, /GET \/api\/orders/);
  const gen = join(dir, 'atrezzo/.generated');
  for (const f of ['conciliacion.json', 'conciliacion.handlers.mjs', 'runtime.mjs']) assert.ok(existsSync(join(gen, f)), f);
  assert.equal(readFileSync(join(gen, 'runtime.mjs'), 'utf8'), readFileSync(join(ROOT, 'scripts/lib/contract.mjs'), 'utf8'));
});

test('world es determinista byte a byte entre ejecuciones', () => {
  const a = tmpProject({ 'e.yaml': SCENARIO });
  const b = tmpProject({ 'e.yaml': SCENARIO });
  cli(['world', 'e.yaml'], a);
  cli(['world', 'e.yaml'], b);
  for (const f of ['conciliacion.json', 'conciliacion.handlers.mjs']) {
    assert.equal(readFileSync(join(a, 'atrezzo/.generated', f), 'utf8'), readFileSync(join(b, 'atrezzo/.generated', f), 'utf8'));
  }
});

test('los handlers generados proyectan igual que el motor', async () => {
  const dir = tmpProject({ 'e.yaml': SCENARIO });
  cli(['world', 'e.yaml'], dir);
  mkdirSync(join(dir, 'node_modules/msw'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/msw/package.json'), JSON.stringify({ name: 'msw', type: 'module', exports: './index.js' }));
  writeFileSync(join(dir, 'node_modules/msw/index.js'), MSW_STUB);
  const mod = await import(pathToFileURL(join(dir, 'atrezzo/.generated/conciliacion.handlers.mjs')).href);
  assert.deepEqual(mod.handlers.map((h) => h.path), ['*/api/orders', '*/api/orders/:id', '*/api/customers', '*/api/customers/:id']);
  const res = mod.handlers[0].resolver({ request: new Request('http://localhost/api/orders?limit=3&estado=pagado') });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 3);
  assert.ok(res.body.every((p) => p.estado === 'pagado'));
  assert.equal(res.headers['x-total-count'], '34');
  assert.equal(mod.handlers[0].resolver({ request: new Request('http://localhost/otra') }), undefined);
});

test('init: detecta stack, escribe config y no la pisa sin --force', () => {
  const dir = tmpProject({ 'package.json': JSON.stringify({ dependencies: { next: '15', '@supabase/supabase-js': '2' } }) });
  const r1 = cli(['init'], dir);
  assert.equal(r1.code, 0, r1.stderr);
  assert.match(r1.stdout, /stack detectado: next/);
  assert.match(r1.stdout, /@supabase\/supabase-js/);
  assert.match(r1.stdout, /no se ha instalado nada/);
  const cfg = JSON.parse(readFileSync(join(dir, 'atrezzo.config.json'), 'utf8'));
  assert.equal(cfg.stack, 'next');
  assert.ok(existsSync(join(dir, 'atrezzo/escenarios')) && existsSync(join(dir, 'atrezzo/handlers')));
  writeFileSync(join(dir, 'atrezzo.config.json'), JSON.stringify({ ...cfg, stack: 'mio' }));
  const r2 = cli(['init'], dir);
  assert.match(r2.stdout, /ya existe; usa --force/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'atrezzo.config.json'), 'utf8')).stack, 'mio');
  cli(['init', '--force'], dir);
  assert.equal(JSON.parse(readFileSync(join(dir, 'atrezzo.config.json'), 'utf8')).stack, 'next');
});

test('doctor: config válida, escenarios y estado de generación', () => {
  const dir = tmpProject({ 'package.json': '{}' });
  cli(['init'], dir);
  writeFileSync(join(dir, 'atrezzo/escenarios/conciliacion.yaml'), SCENARIO);
  let r = cli(['doctor'], dir);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /atrezzo\.config\.json válido/);
  assert.match(r.stdout, /escenario conciliacion\.yaml — sin generar/);
  cli(['world', 'atrezzo/escenarios/conciliacion.yaml'], dir);
  r = cli(['doctor'], dir);
  assert.match(r.stdout, /generado al día/);
  writeFileSync(join(dir, 'atrezzo/escenarios/roto.yaml'), 'name: x\n');
  r = cli(['doctor'], dir);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /ERROR escenario roto\.yaml inválido/);
  writeFileSync(join(dir, 'atrezzo.config.json'), '{"version": 2}');
  r = cli(['doctor'], dir);
  assert.match(r.stdout, /atrezzo\.config\.json inválido/);
});
