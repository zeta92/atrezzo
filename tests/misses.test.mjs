import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { createMissStore, missPattern, guessShape, findInSpec, hintFor, maskQuery, safeSearch, MISS_CAP } from '../scripts/lib/misses.mjs';
import { loadSpec } from '../scripts/lib/openapi.mjs';
import { loadScenario } from '../scripts/lib/scenario.mjs';
import { doctor } from '../scripts/lib/doctor.mjs';
import { loadPlaywright, chromeExecutable } from '../scripts/lib/verify.mjs';
import { ROOT, CLI, tmpProject, cli, cliAsync } from './helpers.mjs';

const CATALOGO = `name: catalogo
seed: 3
world:
  productos: 5
endpoints:
  - path: /api/products
    entity: productos
`;
const PATCH = `  - path: /api/users
    entity: usuarios
`;
const PATCH_WORLD = (yaml) => yaml.replace('world:\n', 'world:\n  usuarios: 4\n') + PATCH;

const CONFIG = (extra = {}) => JSON.stringify({
  version: 1, runtime: 'builtin', scenariosDir: 'escenarios', handlersDir: 'atrezzo/handlers', generatedDir: 'atrezzo/.generated',
  mock: { baseUrl: 'http://127.0.0.1:4010', port: 4010, static: '.' }, verify: { driver: 'http' }, ...extra,
}, null, 2);

const json = async (r) => ({ status: r.status, headers: r.headers, body: await r.json() });

async function startServer(opts = {}) {
  const dir = tmpProject({ 'escenarios/catalogo.yaml': CATALOGO });
  const file = join(dir, 'atrezzo/.atrezzo/misses.json');
  const mock = createMockServer({ scenariosDir: join(dir, 'escenarios'), missesFile: file, ...opts });
  const url = `http://127.0.0.1:${(await mock.listen(0)).port}`;
  return { dir, file, mock, url };
}

// ---------- unidades ----------

test('missPattern colapsa ids y la barra final; guessShape colección vs detalle', () => {
  assert.equal(missPattern('/api/users/42/'), '/api/users/:id');
  assert.equal(missPattern('/api/users/3f2a9c1e-1b2c-4d5e-8f90-1234567890ab/orders'), '/api/users/:id/orders');
  assert.equal(missPattern('/api/me'), '/api/me');
  assert.equal(guessShape('/api/users'), 'collection');
  assert.equal(guessShape('/api/users/:id'), 'detail');
  assert.equal(guessShape('/api/me'), 'detail');
  assert.equal(guessShape('/api/status'), 'detail');
});

test('maskQuery/safeSearch: nombres y valores con pinta de secreto salen como ***', () => {
  const q = new URLSearchParams('token=abc&page=2&api_key=x&q=eyJhbGciOi.eyJzdWIi.sig&h=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6');
  assert.deepEqual(maskQuery(q), { token: '***', page: '2', api_key: '***', q: '***', h: '***' });
  assert.equal(safeSearch(new URLSearchParams('token=abc&page=2')), '?token=***&page=2');
});

test('store: dedupe por METHOD+ruta, ids colapsados y tope de registros', () => {
  const s = createMissStore(null);
  s.record({ method: 'GET', pathname: '/api/users/1', status: 404 });
  s.record({ method: 'GET', pathname: '/api/users/2', status: 404 });
  s.record({ method: 'HEAD', pathname: '/api/users/3/', status: 404 });
  assert.equal(s.list().length, 1);
  assert.equal(s.list()[0].path, '/api/users/:id');
  assert.equal(s.list()[0].times, 3);
  for (let i = 0; i < MISS_CAP + 20; i++) s.record({ method: 'GET', pathname: `/api/r${i}`, status: 404 });
  assert.equal(s.list().length, MISS_CAP);
});

test('findInSpec / hintFor: contrato con la ruta ⇒ import; sin ella ⇒ skill; mutación ⇒ stub', () => {
  const spec = loadSpec(join(ROOT, 'tests/fixtures/petstore.yaml'));
  assert.deepEqual(findInSpec(spec, 'GET', '/api/pets/:id'), { path: '/pets/{petId}', method: true });
  assert.equal(findInSpec(spec, 'GET', '/api/invoices'), null);
  const opts = { spec, contract: 'api/openapi.yaml', scenarios: [loadScenario(join(tmpProject({ 'c.yaml': CATALOGO }), 'c.yaml'))] };
  assert.match(hintFor({ method: 'GET', path: '/api/pets' }, opts), /contrato lo tiene \(GET \/pets\) → atrezzo import api\/openapi.yaml/);
  assert.match(hintFor({ method: 'GET', path: '/api/invoices' }, opts), /skill \/atrezzo:hueco/);
  assert.match(hintFor({ method: 'POST', path: '/api/pets' }, opts), /mutación.*--on-miss stub/);
  assert.match(hintFor({ method: 'GET', path: '/api/products/2' }, opts), /ya lo declara el escenario catalogo/);
});

// ---------- servidor ----------

test('hueco registrado y deduplicado: 3 peticiones iguales ⇒ times 3, un registro, 404 accionable', async () => {
  const { file, mock, url } = await startServer();
  try {
    let last;
    for (let i = 0; i < 3; i++) last = await json(await fetch(`${url}/api/users`, { headers: { referer: 'http://localhost:5173/admin?sid=s3cr3t' } }));
    assert.equal(last.status, 404);
    assert.deepEqual(last.body, {
      error: 'GET /api/users no está en el contrato del escenario "catalogo"',
      atrezzo: { miss: true, hueco: 'GET /api/users', veces: 3, siguiente: 'atrezzo misses', endpoints: ['/api/products'] },
    });
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(disk), ['GET /api/users']);
    const m = disk['GET /api/users'];
    assert.equal(m.times, 3);
    assert.equal(m.resolved, false);
    assert.equal(m.referer, 'http://localhost:5173/admin', 'el referer se guarda sin query');
    assert.ok(m.first_seen <= m.last_seen);
    for (const k of ['method', 'path', 'query', 'times', 'first_seen', 'last_seen', 'referer', 'accept', 'resolved']) assert.ok(k in m, k);
    assert.equal(readFileSync(join(file, '../.gitignore'), 'utf8'), '*\n');
    const st = await json(await fetch(`${url}/__atrezzo/state`));
    assert.deepEqual(st.body.misses, { total: 1, sinResolver: 1 });
    const api = await json(await fetch(`${url}/__atrezzo/misses`));
    assert.equal(api.body.sinResolver, 1);
    assert.equal(api.body.misses[0].times, 3);
    // estáticos que no existen (favicon) no son huecos de la API
    assert.equal((await fetch(`${url}/favicon.ico`)).status, 404);
    // una escritura sobre una ruta del contrato también es un hueco (405)
    const w = await json(await fetch(`${url}/api/products`, { method: 'POST', body: '{}' }));
    assert.equal(w.status, 405);
    assert.equal(w.body.atrezzo.hueco, 'POST /api/products');
    assert.equal((await json(await fetch(`${url}/__atrezzo/misses`))).body.misses.length, 2);
    const del = await fetch(`${url}/__atrezzo/misses`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual((await json(await fetch(`${url}/__atrezzo/misses`))).body, { misses: [], sinResolver: 0 });
  } finally { await mock.close(); }
});

test('el 404 y misses.json no filtran secretos de la query (?token=abc ⇒ "***")', async () => {
  const { file, mock, url } = await startServer();
  const logs = [];
  try {
    const r = await fetch(`${url}/api/users?token=abc&page=2`);
    const text = await r.text();
    assert.equal(r.status, 404);
    assert.doesNotMatch(text, /abc/);
    const m = (await json(await fetch(`${url}/__atrezzo/misses`))).body.misses[0];
    assert.deepEqual(m.query, { token: '***', page: '2' });
    assert.doesNotMatch(readFileSync(file, 'utf8'), /abc/);
  } finally { await mock.close(); }
  // y el log de serve tampoco
  const dir = tmpProject({ 'escenarios/catalogo.yaml': CATALOGO });
  const m2 = createMockServer({ scenariosDir: join(dir, 'escenarios'), log: (s) => logs.push(s) });
  const u2 = `http://127.0.0.1:${(await m2.listen(0)).port}`;
  await fetch(`${u2}/api/users?token=abc`);
  await fetch(`${u2}/api/products?token=abc`);
  await m2.close();
  assert.ok(logs.length >= 2);
  assert.ok(logs.every((l) => !l.includes('abc')), logs.join('\n'));
});

test('POST /__atrezzo/reload recoge el YAML modificado sin reiniciar; resolved pasa a true al servirlo', async () => {
  const { dir, file, mock, url } = await startServer();
  try {
    assert.equal((await fetch(`${url}/api/users`)).status, 404);
    writeFileSync(join(dir, 'escenarios/catalogo.yaml'), PATCH_WORLD(CATALOGO));
    assert.equal((await fetch(`${url}/api/users`)).status, 404, 'sin reload sigue el escenario viejo');
    const rl = await json(await fetch(`${url}/__atrezzo/reload`, { method: 'POST' }));
    assert.equal(rl.status, 200);
    assert.deepEqual(rl.body.endpoints, ['/api/products', '/api/users']);
    assert.deepEqual(rl.body.counts, { usuarios: 4, productos: 5 });
    assert.deepEqual(rl.body.misses, { total: 1, sinResolver: 1 }, 'reload no marca nada: lo marca servirlo');
    const ok = await json(await fetch(`${url}/api/users`));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.length, 4);
    const m = JSON.parse(readFileSync(file, 'utf8'))['GET /api/users'];
    assert.equal(m.resolved, true);
    assert.equal(m.times, 2);
    assert.deepEqual((await json(await fetch(`${url}/__atrezzo/state`))).body.misses, { total: 1, sinResolver: 0 });
    // reload con YAML roto ⇒ 400 y se queda el estado anterior
    writeFileSync(join(dir, 'escenarios/catalogo.yaml'), 'name: catalogo\nseed: x\n');
    const bad = await json(await fetch(`${url}/__atrezzo/reload`, { method: 'POST' }));
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${url}/api/users`)).status, 200);
    assert.equal((await fetch(`${url}/__atrezzo/reload`)).status, 405);
  } finally { await mock.close(); }
});

test('--on-miss stub: 200, [] en colecciones, {} en detalle, cabecera x-atrezzo-stub y sigue registrando', async () => {
  const { mock, url } = await startServer({ onMiss: 'stub' });
  try {
    const col = await json(await fetch(`${url}/api/users`));
    assert.equal(col.status, 200);
    assert.deepEqual(col.body, []);
    assert.equal(col.headers.get('x-atrezzo-stub'), 'true');
    const det = await json(await fetch(`${url}/api/users/7`));
    assert.deepEqual(det.body, {});
    assert.equal(det.headers.get('x-atrezzo-stub'), 'true');
    const post = await json(await fetch(`${url}/api/products`, { method: 'POST', body: '{}' }));
    assert.equal(post.status, 200);
    assert.deepEqual(post.body, {});
    const real = await fetch(`${url}/api/products`);
    assert.equal(real.headers.get('x-atrezzo-stub'), null, 'lo que está en el contrato no es stub');
    const list = (await json(await fetch(`${url}/__atrezzo/misses`))).body;
    assert.deepEqual(list.misses.map((m) => `${m.method} ${m.path}`).sort(), ['GET /api/users', 'GET /api/users/:id', 'POST /api/products']);
    assert.ok(list.misses.every((m) => m.status === 200));
  } finally { await mock.close(); }
  assert.throws(() => createMockServer({ scenariosDir: join(tmpProject({ 'e/c.yaml': CATALOGO }), 'e'), onMiss: 'nada' }), /--on-miss/);
});

// ---------- CLI ----------

test('atrezzo misses --json con un registro; texto con propuesta; --clear vacía; doctor avisa', () => {
  const dir = tmpProject({ 'atrezzo.config.json': CONFIG({ workspace: { contract: 'api/openapi.yaml' } }), 'escenarios/catalogo.yaml': CATALOGO, 'api/openapi.yaml': readFileSync(join(ROOT, 'tests/fixtures/petstore.yaml'), 'utf8') });
  const store = createMissStore(join(dir, 'atrezzo/.atrezzo/misses.json'));
  store.record({ method: 'GET', pathname: '/api/invoices', query: new URLSearchParams('token=abc'), status: 404 });
  const j = cli(['misses', '--json'], dir);
  assert.equal(j.code, 0, j.stderr);
  const doc = JSON.parse(j.stdout);
  assert.equal(doc.sinResolver, 1);
  assert.equal(doc.misses.length, 1);
  assert.equal(doc.misses[0].path, '/api/invoices');
  assert.deepEqual(doc.misses[0].query, { token: '***' });

  store.record({ method: 'GET', pathname: '/api/pets', status: 404 });
  store.record({ method: 'GET', pathname: '/api/pets', status: 404 });
  const t = cli(['misses'], dir);
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /GET \/api\/pets\s+2 veces\s+sin resolver.*→ el contrato lo tiene \(GET \/pets\) → atrezzo import api\/openapi.yaml/);
  assert.match(t.stdout, /GET \/api\/invoices\s+1 vez\s+sin resolver.*→ no está en el contrato → añade el endpoint al escenario \(skill \/atrezzo:hueco\)/);
  assert.match(t.stdout, /2 huecos · 2 sin resolver/);

  const d = doctor(dir);
  const w = d.checks.find((c) => /hueco/.test(c.label));
  assert.equal(w.level, 'warn');
  assert.match(w.label, /2 huecos sin resolver \(de 2 registrados\)/);
  assert.match(w.detail, /GET \/api\/pets \(2×\)/);

  const c = cli(['misses', '--clear'], dir);
  assert.equal(c.code, 0);
  assert.match(c.stdout, /2 huecos borrados/);
  assert.deepEqual(JSON.parse(cli(['misses', '--json'], dir).stdout), { misses: [], sinResolver: 0 });
  assert.match(cli(['misses'], dir).stdout, /Sin huecos registrados/);
  assert.ok(!doctor(dir).checks.some((x) => /hueco/.test(x.label)));
});

// ---------- end-to-end: página → 404 → misses → parche → world + reload → verde ----------

const PAGE = `<!doctype html><meta charset="utf-8"><title>usuarios</title>
<ul id="lista"></ul>
<script type="module">
  const r = await fetch('/api/users');
  const lista = document.getElementById('lista');
  if (!r.ok) {
    const e = await r.json();
    lista.after(Object.assign(document.createElement('p'), { textContent: 'Error ' + r.status + ': ' + e.error }));
  } else {
    for (const u of await r.json()) {
      const li = Object.assign(document.createElement('li'), { textContent: u.nombre + ' · ' + u.email });
      li.dataset.testid = 'user-row';
      lista.append(li);
    }
  }
  const listo = document.createElement('i');
  listo.hidden = true;
  listo.dataset.testid = 'listo';
  document.body.append(listo);
</script>`;

const FLOW = `escenario: escenarios/catalogo.yaml
steps:
  - screen: usuarios
    visit: /
    wait_for: "[data-testid=listo]"
    requests:
      usuarios: GET /api/users
    expect:
      - selector: "[data-testid=user-row]"
        count: 4
        data: { request: usuarios }
`;

const realPw = await loadPlaywright(ROOT);
const realChrome = realPw && (chromeExecutable(realPw.name) ?? (realPw.name !== 'playwright-core' ? 'bundled' : null));
const skipReal = !realPw ? 'playwright(-core) no instalado en el repo' : !realChrome || (realChrome !== 'bundled' && !existsSync(realChrome)) ? 'sin Chromium (define ATREZZO_CHROME)' : false;

function serveChild(dir) {
  return new Promise((ok, ko) => {
    const child = spawn(process.execPath, [CLI, 'serve', '--port', '0'], { cwd: dir });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
      if (m && !child.url) { child.url = `http://127.0.0.1:${m[1]}`; ok(child); }
    });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('exit', (code) => { if (!child.url) ko(new Error(`serve salió con ${code}: ${buf}`)); });
    child.log = () => buf;
  });
}

test('end-to-end (Chromium real): 404 registrado → parche al escenario → world + reload → la página pinta y el hueco queda resuelto', { skip: skipReal, timeout: 90_000 }, async (t) => {
  const dir = tmpProject({ 'atrezzo.config.json': CONFIG(), 'escenarios/catalogo.yaml': CATALOGO, 'index.html': PAGE, 'flujo.yaml': FLOW });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  const srv = await serveChild(dir);
  t.after(() => srv.kill());
  const say = (s) => t.diagnostic(s);

  // 1) la página pide /api/users, que no existe ⇒ rojo, y el hueco queda registrado
  const v1 = await cliAsync(['verify', 'flujo.yaml', '--driver', 'playwright', '--no-reset', '--url', srv.url], dir);
  say(`verify antes del parche: exit ${v1.code}`);
  assert.notEqual(v1.code, 0, v1.stdout);
  const m1 = await cliAsync(['misses'], dir);
  say(m1.stdout);
  assert.match(m1.stdout, /GET \/api\/users\s+\d+ (vez|veces)\s+sin resolver/);
  const j1 = JSON.parse((await cliAsync(['misses', '--json'], dir)).stdout);
  assert.equal(j1.misses[0].referer, `${srv.url}/`, 'el hueco lo provocó la página (referer)');

  // 2) parche al escenario (entidad + endpoint; los datos los genera el mundo) → world → reload
  writeFileSync(join(dir, 'escenarios/catalogo.yaml'), PATCH_WORLD(CATALOGO));
  const w = await cliAsync(['world', 'escenarios/catalogo.yaml'], dir);
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stdout, /GET \/api\/users/);
  const rl = await fetch(`${srv.url}/__atrezzo/reload`, { method: 'POST' }).then((r) => r.json());
  say(`reload: endpoints ${rl.endpoints.join(', ')} · generado: ${rl.generado}`);
  assert.equal(rl.generado, 'al día');

  // 3) la pantalla pinta (sin reset: lo que ve es fruto del reload) y el hueco sale resuelto
  const v2 = await cliAsync(['verify', 'flujo.yaml', '--driver', 'playwright', '--no-reset', '--url', srv.url], dir);
  say(v2.stdout);
  assert.equal(v2.code, 0, v2.stdout + v2.stderr);
  const j2 = JSON.parse((await cliAsync(['misses', '--json'], dir)).stdout);
  assert.equal(j2.sinResolver, 0);
  assert.equal(j2.misses[0].resolved, true);
  assert.match(srv.log(), /hueco GET \/api\/users resuelto/);
});
