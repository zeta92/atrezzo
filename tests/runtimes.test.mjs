import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chownSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { SCENARIO, tmpProject, cli } from './helpers.mjs';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { generateWorld } from '../scripts/lib/world.mjs';
import { createEngine } from '../scripts/lib/contract.mjs';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { projectContext } from '../scripts/lib/project.mjs';
import { chooseRuntime, emitRuntimes, getAdapter, RUNTIME_IDS } from '../scripts/lib/runtimes/index.mjs';

const pkg = (deps = {}, extra = {}) => JSON.stringify({ name: 'x', dependencies: deps, ...extra });
const scenario = normalizeScenario(parseYaml(SCENARIO));
const dataset = generateWorld(scenario);
const config = { ...DEFAULT_CONFIG, _dir: '/proyecto' };

function choose(files) {
  const dir = tmpProject(files);
  return chooseRuntime(projectContext(dir, {}));
}

// ---------- detección ----------

test('matriz de detección: Vite+MSW → msw', () => {
  const c = choose({ 'package.json': pkg({ react: '18', vite: '5', msw: '2' }) });
  assert.equal(c.id, 'msw');
  assert.match(c.why, /msw en package\.json/);
});

test('matriz de detección: proyecto con supabase/ → supabase', () => {
  const c = choose({ 'package.json': pkg({ react: '18' }), 'supabase/migrations/001.sql': 'select 1;' });
  assert.equal(c.id, 'supabase');
  assert.match(c.why, /carpeta supabase\//);
  const full = choose({ 'package.json': pkg({ '@supabase/supabase-js': '2' }), 'supabase/config.toml': 'project_id = "x"\n', '.env.local': 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\n' });
  assert.equal(full.id, 'supabase');
  assert.equal(full.ranking.find((r) => r.id === 'supabase').score, 3);
});

test('matriz de detección: openapi.yaml sin msw → builtin, con el motivo (prism queda como posible)', () => {
  const c = choose({ 'package.json': pkg({ express: '4' }), 'openapi.yaml': 'openapi: 3.0.3\npaths: {}\n' });
  assert.equal(c.id, 'builtin');
  const prism = c.ranking.find((r) => r.id === 'prism');
  assert.equal(prism.score, 1);
  assert.match(prism.reason, /contrato openapi\.yaml.*atrezzo import/);
  assert.deepEqual(c.tied, ['prism']);
  assert.match(c.why, /empate con prism; desempate por prioridad fija/);
  // Con prism-cli en dependencias, prism sí gana.
  assert.equal(choose({ 'package.json': pkg({}, { devDependencies: { '@stoplight/prism-cli': '5' } }), 'openapi.yaml': 'x: 1\n' }).id, 'prism');
});

test('matriz de detección: proyecto vacío → builtin', () => {
  const c = choose({});
  assert.equal(c.id, 'builtin');
  assert.ok(c.ranking.filter((r) => r.id !== 'builtin').every((r) => r.score === 0));
});

test('matriz de detección: wiremock por dependencia, por carpetas y por docker-compose', () => {
  assert.equal(choose({ 'package.json': pkg({}, { devDependencies: { 'wiremock-captain': '3' } }) }).id, 'wiremock');
  assert.equal(choose({ 'wiremock/mappings/a.json': '{}', 'wiremock/__files/a.json': '{}' }).id, 'wiremock');
  const c = choose({ 'docker-compose.yml': 'services:\n  mock:\n    image: wiremock/wiremock:3.13.2\n' });
  assert.equal(c.id, 'wiremock');
  assert.match(c.why, /docker-compose\.yml/);
});

test('init --runtime auto imprime lo encontrado, el motivo y las alternativas', () => {
  const dir = tmpProject({ 'package.json': pkg({ react: '18', vite: '5', msw: '2', '@supabase/supabase-js': '2' }) });
  const r = cli(['init'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Runtime: msw — puntuación 3\/3: msw en package\.json/);
  assert.match(r.stdout, /→ msw\s+3\/3/);
  assert.match(r.stdout, /supabase\s+2\/3\s+@supabase\/supabase-js en package\.json/);
  assert.match(r.stdout, /alternativas con señales: supabase → atrezzo init --force --runtime msw,supabase/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'atrezzo.config.json'), 'utf8')).runtime, 'msw');
  const bad = cli(['init', '--force', '--runtime', 'json-server'], dir);
  assert.equal(bad.code, 3);
  assert.match(bad.stderr, /"json-server" no existe/);
});

test('atrezzo runtimes lista adaptadores, disponibilidad y arranque', () => {
  const dir = tmpProject({ 'package.json': pkg({ msw: '2' }) });
  const r = cli(['runtimes'], dir);
  assert.equal(r.code, 0, r.stderr);
  for (const id of RUNTIME_IDS) assert.match(r.stdout, new RegExp(`${id}\\s+\\d/3`));
  assert.match(r.stdout, /msw\s+3\/3 detectado/);
  assert.match(r.stdout, /builtin\s+1\/3 posible/);
  assert.match(r.stdout, /arranque: npx @stoplight\/prism-cli mock/);
});

// ---------- emisión ----------

test('cada adaptador emite sus ficheros y es determinista byte a byte', () => {
  const expected = {
    builtin: [],
    msw: ['atrezzo/.generated/conciliacion.handlers.mjs'],
    supabase: ['schema.sql', 'seed.sql', 'reset.sh', 'README.md'].map((f) => `atrezzo/.generated/supabase/conciliacion/${f}`),
    prism: ['atrezzo/.generated/conciliacion.openapi.yaml'],
  };
  for (const id of RUNTIME_IDS) {
    const a = getAdapter(id).emit({ dataset, scenario, config, dir: '/nada' });
    const b = getAdapter(id).emit({ dataset: generateWorld(normalizeScenario(parseYaml(SCENARIO))), scenario, config, dir: '/nada' });
    assert.deepEqual(a, b, `${id} no es determinista`);
    assert.ok(a.start, `${id} sin orden de arranque`);
    assert.ok(Array.isArray(a.notes));
    if (expected[id]) assert.deepEqual(a.files.map((f) => f.path), expected[id], id);
  }
  const wm = getAdapter('wiremock').emit({ dataset, scenario, config, dir: '/nada' });
  assert.ok(wm.files.some((f) => f.path === 'atrezzo/.generated/wiremock/conciliacion/mappings/api-orders.json'));
  assert.ok(wm.files.every((f) => /\/(mappings|__files)\//.test(f.path)));
});

test('world escribe siempre JSON + runtime.mjs y después lo del runtime configurado', () => {
  const dir = tmpProject({ 'atrezzo.config.json': JSON.stringify({ ...DEFAULT_CONFIG, runtime: 'prism' }), 'e.yaml': SCENARIO });
  const r = cli(['world', 'e.yaml'], dir);
  assert.equal(r.code, 0, r.stderr);
  const gen = join(dir, 'atrezzo/.generated');
  assert.deepEqual(readdirSync(gen).sort(), ['conciliacion.json', 'conciliacion.openapi.yaml', 'runtime.mjs']);
  assert.match(r.stdout, /Runtime prism:\n  arranque: npx @stoplight\/prism-cli mock atrezzo\/\.generated\/conciliacion\.openapi\.yaml --port 4010/);
  assert.match(r.stdout, /NO filtra ni pagina/);
});

test('serve: con un runtime no servible imprime cómo arrancarlo y sale con 2', () => {
  const dir = tmpProject({ 'atrezzo.config.json': JSON.stringify({ ...DEFAULT_CONFIG, runtime: 'wiremock' }), 'atrezzo/escenarios/conciliacion.yaml': SCENARIO });
  const r = cli(['serve', '--escenario', 'conciliacion'], dir);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /wiremock: docker run --rm -p 4010:8080 -v "\$PWD\/atrezzo\/\.generated\/wiremock\/conciliacion:\/home\/wiremock"/);
  assert.match(r.stdout, /atrezzo serve --runtime builtin/);
});

// ---------- supabase ----------

test('supabase: seed.sql con tantas filas como el mundo, ids estables y SQL bien formado', () => {
  const { files } = getAdapter('supabase').emit({ dataset, scenario, config, dir: '/nada' });
  const seed = files.find((f) => f.path.endsWith('seed.sql')).content;
  const schema = files.find((f) => f.path.endsWith('schema.sql')).content;
  assert.match(seed, /^BEGIN;$/m);
  assert.match(seed, /^COMMIT;$/m);
  assert.match(seed, /^TRUNCATE TABLE "usuarios", "pedidos", "clientes" RESTART IDENTITY CASCADE;$/m);
  // Filas: cada tupla "(id, ...)" de los INSERT, por tabla.
  for (const [name, rows] of Object.entries(dataset.entities)) {
    const block = seed.split(`-- ${name}: `)[1].split(/\nDO \$\$/)[0];
    const ids = [...block.matchAll(/^ {2}\((\d+), /gm)].map((m) => Number(m[1]));
    assert.deepEqual(ids, rows.map((r) => r.id), `${name}: ids`);
  }
  // Padres antes que hijos y fk declarada.
  assert.ok(seed.indexOf('INSERT INTO "clientes"') < seed.indexOf('INSERT INTO "pedidos"'));
  assert.match(schema, /"client_id" bigint NOT NULL REFERENCES "clientes" \("id"\)/);
  assert.match(schema, /"creado_en" timestamptz NOT NULL/);
  // Comillas: las del texto van duplicadas y el fichero no deja cadenas abiertas.
  const stripped = seed.replace(/'(?:[^']|'')*'/g, '');
  assert.ok(!stripped.includes("'"), 'comilla sin cerrar');
  assert.equal((stripped.match(/\(/g) || []).length, (stripped.match(/\)/g) || []).length, 'paréntesis desbalanceados');
  const reset = files.find((f) => f.path.endsWith('reset.sh'));
  assert.equal(reset.mode, 0o755);
  assert.match(reset.content, /ATREZZO_ALLOW_REMOTE/);
});

const PG_BIN = ['17', '16', '15', '14'].map((v) => `/usr/lib/postgresql/${v}/bin`).find((d) => existsSync(join(d, 'initdb')));
const canPg = PG_BIN && process.getuid?.() === 0 && spawnSync('psql', ['--version']).status === 0;

test('supabase: reset.sh carga el seed en un Postgres real, dos veces (idempotente)', { skip: canPg ? false : 'sin Postgres local (initdb + psql como root)' }, () => {
  const proj = tmpProject({ 'atrezzo.config.json': JSON.stringify({ ...DEFAULT_CONFIG, runtime: 'supabase' }), 'e.yaml': SCENARIO });
  assert.equal(cli(['world', 'e.yaml'], proj).code, 0);
  const pg = mkdtempSync(join(tmpdir(), 'atrezzo-pg-'));
  chownSync(pg, Number(spawnSync('id', ['-u', 'postgres'], { encoding: 'utf8' }).stdout.trim()), 0);
  const port = String(56000 + (process.pid % 1000));
  const su = (cmd) => spawnSync('su', ['postgres', '-c', cmd], { encoding: 'utf8' });
  try {
    assert.equal(su(`${PG_BIN}/initdb -D ${pg}/data -A trust -U postgres`).status, 0);
    assert.equal(su(`${PG_BIN}/pg_ctl -D ${pg}/data -w -o "-p ${port} -k ${pg} -c listen_addresses=" -l ${pg}/log start`).status, 0);
    const env = { ...process.env, DATABASE_URL: `postgresql://postgres@localhost:${port}/postgres?host=${pg}` };
    const reset = join(proj, 'atrezzo/.generated/supabase/conciliacion/reset.sh');
    for (let i = 0; i < 2; i++) {
      const r = spawnSync('sh', [reset], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /restaurado \(45 filas\)/);
    }
    const q = spawnSync('psql', [env.DATABASE_URL, '-tAc', "select (select count(*) from clientes)||','||(select count(*) from pedidos)||','||(select count(*) from pedidos where estado='incidencia')||','||(select referencia from pedidos where id=1)"], { encoding: 'utf8' });
    assert.equal(q.stdout.trim(), `3,40,3,${dataset.entities.pedidos[0].referencia}`);
  } finally {
    su(`${PG_BIN}/pg_ctl -D ${pg}/data -m immediate stop`);
    rmSync(pg, { recursive: true, force: true });
  }
});

// ---------- prism ----------

test('prism: OpenAPI 3.1 parseable, con los paths del escenario y required coherentes', () => {
  const { files } = getAdapter('prism').emit({ dataset, scenario, config, dir: '/nada' });
  const doc = parseYaml(files[0].content);
  assert.equal(doc.openapi, '3.1.0');
  assert.deepEqual(Object.keys(doc.paths), ['/api/orders', '/api/orders/{id}', '/api/customers', '/api/customers/{id}']);
  const list = doc.paths['/api/orders'].get;
  assert.deepEqual(list.parameters.map((p) => p.name), ['estado', 'client_id', 'limit', 'offset']);
  const media = list.responses['200'].content['application/json'];
  const ex = media.examples.escenario.value;
  assert.deepEqual(ex, createEngine(dataset).handle({ pathname: '/api/orders', query: {} }).body);
  assert.equal(media.examples['estado-incidencia'].value.length, 3);
  for (const [name, schema] of Object.entries(doc.components.schemas)) {
    for (const f of schema.required) assert.ok(f in schema.properties, `${name}.${f} required sin property`);
    const entity = Object.keys(dataset.schema).find((e) => dataset.schema[e].singular.toLowerCase() === name.toLowerCase());
    for (const row of dataset.entities[entity]) for (const f of schema.required) assert.notEqual(row[f], null, `${name}.${f} es required pero hay nulos`);
  }
});

test('prism: el YAML también lo lee un parser YAML estándar (PyYAML) igual que el nuestro', { skip: spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'sin python3 + PyYAML' }, () => {
  const { files } = getAdapter('prism').emit({ dataset, scenario, config, dir: '/nada' });
  const r = spawnSync('python3', ['-c', 'import sys, json, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'], { input: files[0].content, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), parseYaml(files[0].content));
});

// ---------- wiremock ----------

test('wiremock: mappings con urlPath + bodyFileName, templating con transformers y fallback 501', () => {
  const requests = ['/api/orders?limit=12', '/api/orders?estado=incidencia&limit=12'];
  const { files, notes } = getAdapter('wiremock').emit({ dataset, scenario, config, dir: '/nada', requests });
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));
  const root = 'atrezzo/.generated/wiremock/conciliacion';
  const { mappings } = JSON.parse(byPath[`${root}/mappings/api-orders.json`]);
  const engine = createEngine(dataset);
  const lists = mappings.filter((m) => m.request.urlPath === '/api/orders' && m.response.bodyFileName);
  assert.ok(lists.length >= 8);
  for (const m of lists) {
    const body = byPath[`${root}/__files/${m.response.bodyFileName}`];
    assert.ok(body, `falta __files/${m.response.bodyFileName}`);
    const q = Object.fromEntries(Object.entries(m.request.queryParameters).filter(([, v]) => v.equalTo !== undefined).map(([k, v]) => [k, v.equalTo]));
    const r = engine.handle({ pathname: '/api/orders', query: q });
    assert.deepEqual(JSON.parse(body), r.body, m.name);
    assert.equal(m.response.headers['x-total-count'], r.headers['x-total-count']);
    for (const k of ['estado', 'client_id', 'limit', 'offset']) assert.ok(k in m.request.queryParameters, `${m.name}: ${k} sin equalTo/absent`);
  }
  assert.ok(lists.some((m) => m.request.queryParameters.estado.equalTo === 'incidencia' && m.request.queryParameters.limit.equalTo === '12'), 'la combinación del flujo');
  const detail = mappings.find((m) => m.request.urlPathPattern?.includes('(1|2|'));
  assert.deepEqual(detail.response.transformers, ['response-template']);
  assert.match(detail.response.bodyFileName, /\{\{request\.pathSegments\.\[2\]\}\}\.json$/);
  assert.ok(byPath[`${root}/__files/conciliacion/api-orders/id/40.json`]);
  const fallback = mappings.find((m) => m.response.status === 501);
  assert.equal(fallback.request.urlPath, '/api/orders');
  assert.ok(fallback.priority > lists[0].priority);
  assert.ok(fallback.response.jsonBody.error);
  assert.ok(notes.some((n) => /NO ejecuta la proyección/.test(n)));
  assert.ok(notes.some((n) => /paginación sin default_limit/.test(n)));
});

test('wiremock: world recoge las peticiones de los flujos del escenario', () => {
  const dir = tmpProject({
    'atrezzo.config.json': JSON.stringify({ ...DEFAULT_CONFIG, runtime: 'wiremock' }),
    'atrezzo/escenarios/conciliacion.yaml': SCENARIO,
    'flujo.yaml': 'escenario: atrezzo/escenarios/conciliacion.yaml\nsteps:\n  - screen: lista\n    requests:\n      p: GET /api/orders?estado=incidencia&limit=2\n',
  });
  const r = cli(['world', 'atrezzo/escenarios/conciliacion.yaml'], dir);
  assert.equal(r.code, 0, r.stderr);
  const body = join(dir, 'atrezzo/.generated/wiremock/conciliacion/__files/conciliacion/api-orders/estado-incidencia__limit-2.json');
  assert.equal(JSON.parse(readFileSync(body, 'utf8')).length, 2);
  assert.match(r.stdout, /Runtime wiremock:/);
});

test('supabase en world: reset.sh queda ejecutable', () => {
  const dir = tmpProject({ 'atrezzo.config.json': JSON.stringify({ ...DEFAULT_CONFIG, runtime: ['msw', 'supabase'] }), 'e.yaml': SCENARIO });
  assert.equal(cli(['world', 'e.yaml'], dir).code, 0);
  assert.equal(statSync(join(dir, 'atrezzo/.generated/supabase/conciliacion/reset.sh')).mode & 0o777, 0o755);
  assert.ok(existsSync(join(dir, 'atrezzo/.generated/conciliacion.handlers.mjs')));
  const out = emitRuntimes(['msw', 'supabase'], { dataset, scenario, config, dir: '/nada' });
  assert.deepEqual(out.map((o) => o.id), ['msw', 'supabase']);
});
