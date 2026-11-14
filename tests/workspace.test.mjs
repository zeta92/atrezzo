import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SCENARIO, tmpProject, cli } from './helpers.mjs';
import { detectWorkspace } from '../scripts/lib/project.mjs';

const pkg = (name, deps = {}, extra = {}) => JSON.stringify({ name, dependencies: deps, ...extra });
const SPEC = 'openapi: 3.0.3\ninfo:\n  title: api\n  version: "1"\npaths: {}\n';

function pnpmMonorepo() {
  return tmpProject({
    'package.json': pkg('mono', {}, { private: true }),
    'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - "services/*"\n  - "packages/*"\n',
    'apps/web/package.json': pkg('web', { react: '18', vite: '5' }, { devDependencies: { msw: '2' } }),
    'apps/web/vite.config.ts': "export default { server: { proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } } } };\n",
    'services/api/package.json': pkg('api', { fastify: '4', '@supabase/supabase-js': '2' }),
    'services/api/openapi.yaml': SPEC,
    'services/api/supabase/config.toml': 'project_id = "api"\n',
    'packages/ui-utils/package.json': pkg('utils', { lodash: '4' }),
    'atrezzo/escenarios/conciliacion.yaml': SCENARIO,
  });
}

test('monorepo pnpm: apps/web es el front, services/api el backend; MSW en web y seed en api', async () => {
  const dir = pnpmMonorepo();
  const d = detectWorkspace(dir);
  assert.equal(d.kind, 'monorepo');
  assert.equal(d.front, 'apps/web');
  assert.equal(d.backend, 'services/api');
  assert.equal(d.candidates.find((c) => c.path === 'packages/ui-utils').role, 'ninguno');

  const r = cli(['init', '--runtime', 'msw,supabase'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /monorepo: pnpm-workspace\.yaml/);
  assert.match(r.stdout, /workspace: front=apps\/web · backend=services\/api · contract=services\/api\/openapi\.yaml/);
  assert.match(r.stdout, /baseUrl del mock: http:\/\/localhost:3000 \(proxy de Vite "\/api" → http:\/\/localhost:3000 en apps\/web\/vite\.config\.ts\)/);
  const cfg = JSON.parse(readFileSync(join(dir, 'atrezzo.config.json'), 'utf8'));
  assert.deepEqual(cfg.workspace, { front: 'apps/web', backend: 'services/api', contract: 'services/api/openapi.yaml' });
  assert.deepEqual(cfg.runtime, ['msw', 'supabase']);
  assert.equal(cfg.mock.port, 3000);
  assert.equal(cfg.mock.apiPrefix, '/api');
  assert.equal(cfg.handlersDir, 'apps/web/src/mocks/atrezzo');

  const w = cli(['world', 'atrezzo/escenarios/conciliacion.yaml'], dir);
  assert.equal(w.code, 0, w.stderr);
  const handlers = join(dir, 'apps/web/src/mocks/atrezzo/conciliacion.handlers.mjs');
  assert.ok(existsSync(handlers), 'handlers MSW en el front');
  assert.match(readFileSync(handlers, 'utf8'), /from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/atrezzo\/\.generated\/conciliacion\.json'/);
  for (const f of ['seed.sql', 'reset.sh', 'schema.sql', 'README.md']) assert.ok(existsSync(join(dir, 'services/api/supabase/atrezzo/conciliacion', f)), `seed en api: ${f}`);
  assert.ok(existsSync(join(dir, 'atrezzo/.generated/conciliacion.json')) && existsSync(join(dir, 'atrezzo/.generated/runtime.mjs')));

  // Los imports relativos resuelven de verdad (con un stub de msw en el front).
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(dir, 'apps/web/node_modules/msw'), { recursive: true });
  writeFileSync(join(dir, 'apps/web/node_modules/msw/package.json'), JSON.stringify({ name: 'msw', type: 'module', exports: './index.js' }));
  writeFileSync(join(dir, 'apps/web/node_modules/msw/index.js'), 'export const http = { get: (p, r) => ({ p, r }) }; export const HttpResponse = { json: (b, i) => ({ b, ...i }) };\n');
  const mod = await import(pathToFileURL(handlers).href);
  assert.equal(mod.dataset.entities.pedidos.length, 40);
  const idx = readFileSync(join(dir, 'apps/web/src/mocks/atrezzo/index.mjs'), 'utf8');
  assert.match(idx, /import\(`\.\/\$\{name\}\.handlers\.mjs`\)/);

  // Con auto, empate msw/supabase a 3: gana msw por prioridad y lo dice.
  const auto = cli(['init', '--force'], dir);
  assert.match(auto.stdout, /Runtime: msw — puntuación 3\/3.*empate con supabase/);
});

test('dos carpetas sin manifiesto (client/ + server/)', () => {
  const dir = tmpProject({
    'client/package.json': pkg('client', { vue: '3', vite: '5' }),
    'client/.env.development': 'VITE_API_URL=http://127.0.0.1:8080/api\n',
    'server/requirements.txt': 'fastapi\n',
    'server/openapi.json': JSON.stringify({ openapi: '3.0.0', paths: {} }),
  });
  const d = detectWorkspace(dir);
  assert.equal(d.kind, 'carpetas');
  assert.equal(d.front, 'client');
  assert.equal(d.backend, 'server');
  const r = cli(['init'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /carpetas hermanas: client\/ \+ server\//);
  assert.match(r.stdout, /baseUrl del mock: http:\/\/127\.0\.0\.1:8080 \(VITE_API_URL=http:\/\/127\.0\.0\.1:8080\/api en client\/\.env\.development\)/);
  const cfg = JSON.parse(readFileSync(join(dir, 'atrezzo.config.json'), 'utf8'));
  assert.deepEqual(cfg.workspace, { front: 'client', backend: 'server', contract: 'server/openapi.json' });
  assert.equal(cfg.runtime, 'builtin');
  assert.match(r.stdout, /Siguiente paso: atrezzo import server\/openapi\.json/);
});

test('ambiguo: dos paquetes con pinta de front → exit 2 con la tabla y pidiendo --front/--backend', () => {
  const dir = tmpProject({
    'package.json': pkg('mono', {}, { workspaces: ['apps/*'] }),
    'apps/web/package.json': pkg('web', { react: '18', vite: '5' }),
    'apps/admin/package.json': pkg('admin', { vue: '3', vite: '5' }),
    'apps/api/package.json': pkg('api', { express: '4' }),
  });
  const r = cli(['init'], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /No elijo por ti: hay 2 candidatos a front \(apps\/admin, apps\/web\)/);
  assert.match(r.stderr, /paquete\s+front\s+backend\s+rol/);
  assert.match(r.stderr, /apps\/admin\s+2\s+0\s+front/);
  assert.match(r.stderr, /apps\/web\s+3\s+0\s+front/);
  assert.match(r.stderr, /atrezzo init --front <ruta> --backend <ruta>/);
  assert.ok(!existsSync(join(dir, 'atrezzo.config.json')), 'no escribe nada si no decide');
  const half = cli(['init', '--backend', 'apps/api'], dir);
  assert.equal(half.code, 2, 'solo --backend con fronts ambiguos tampoco elige');
  assert.match(half.stderr, /has pasado --backend pero no --front/);
  const ok = cli(['init', '--front', 'apps/admin', '--backend', 'apps/api'], dir);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'atrezzo.config.json'), 'utf8')).workspace, { front: 'apps/admin', backend: 'apps/api' });
});

test('monorepo sin ningún front → exit 2; dos repos con rutas explícitas fuera de la raíz', () => {
  const dir = tmpProject({ 'turbo.json': '{}', 'package.json': pkg('m', {}, { workspaces: ['services/*'] }), 'services/a/package.json': pkg('a', { express: '4' }) });
  const r = cli(['init'], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no hay ningún candidato a front/);

  const parent = tmpProject({ 'web/package.json': pkg('web', { react: '18', msw: '2' }), 'api/openapi.yaml': SPEC });
  const r2 = cli(['init', '--front', '.', '--backend', '../api', '--contract', '../api/openapi.yaml'], join(parent, 'web'));
  assert.equal(r2.code, 0, r2.stderr);
  const cfg = JSON.parse(readFileSync(join(parent, 'web/atrezzo.config.json'), 'utf8'));
  assert.deepEqual(cfg.workspace, { front: '.', backend: '../api', contract: '../api/openapi.yaml' });
  assert.equal(cfg.runtime, 'msw');
  assert.equal(cfg.handlersDir, 'atrezzo/handlers');
  const bad = cli(['init', '--force', '--front', 'nope'], join(parent, 'web'));
  assert.equal(bad.code, 3);
  assert.match(bad.stderr, /--front nope: no existe/);
});
