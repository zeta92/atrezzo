import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { ROOT, tmpProject, cli } from './helpers.mjs';
import { emitYaml } from '../scripts/lib/yaml-emit.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { inferScenario, loadSpec } from '../scripts/lib/openapi.mjs';
import { loadScenario, normalizeScenario } from '../scripts/lib/scenario.mjs';
import { generateWorld } from '../scripts/lib/world.mjs';
import { createEngine } from '../scripts/lib/contract.mjs';

const PETSTORE = join(ROOT, 'tests/fixtures/petstore.yaml');

test('emitYaml: ida y vuelta con nuestro parser, comillas donde hacen falta', () => {
  const value = {
    openapi: '3.1.0', n: 3, f: 1.5, t: true, nada: null, vacio: {}, lista: [],
    raros: ['yes', 'no', '123', '2025-01-01', 'a: b', '#x', '- y', '', ' sp', 'Ferretería Norte', '{x}', 'a,b', "it's"],
    '/api/orders': { get: { responses: { 200: { description: 'ok' } } } },
    anidada: [{ a: 1, b: [1, 2] }, [3, 4], { c: { d: 'e' } }],
  };
  const text = emitYaml(value);
  assert.deepEqual(parseYaml(text), JSON.parse(JSON.stringify(value)));
  assert.match(text, /^ {2}- "yes"$/m);
  assert.match(text, /^ {2}- "2025-01-01"$/m);
  assert.match(text, /^ {6}"200":$/m);
  assert.equal(emitYaml(value), text);
});

test('import petstore: endpoints, envoltorio {data}, rutas ignoradas con motivo y TODO', () => {
  const r = inferScenario(loadSpec(PETSTORE), { name: 'api', file: 'petstore.yaml' });
  assert.equal(r.prefix, '/api');
  assert.match(r.baseInfo, /servers\[0\]\.url = "\/api", relativa/);
  const [pets, owners] = r.doc.endpoints;
  assert.equal(r.doc.endpoints.length, 2);
  assert.equal(pets.path, '/api/pets');
  assert.equal(pets.entity, 'pets');
  assert.equal(pets.pick, null);
  assert.deepEqual(pets.filters, ['status']);
  assert.deepEqual(pets.pagination, { param_limit: 'limit', param_offset: 'offset', default_limit: 20, max_limit: 100 });
  assert.equal(pets.detail, '/pets/{petId}');
  assert.ok(pets.paramNotes.some((n) => /\?tag sin enum/.test(n)));
  const petEntity = r.doc.entities.find((e) => e.name === 'pets');
  assert.deepEqual(petEntity.campos, { name: 'texto', tag: 'texto', status: ['available', 'pending', 'sold'], createdAt: 'fecha' });
  assert.deepEqual(petEntity.skipped, ['owner (objeto anidado)']);
  assert.equal(owners.path, '/api/owners');
  assert.equal(owners.pick, 'data');
  assert.deepEqual(owners.wrapperOthers, ['total']);
  assert.deepEqual(owners.pagination, { param_page: 'page', param_limit: 'per_page', default_limit: 10 });
  assert.deepEqual(r.doc.entities.find((e) => e.name === 'owners').campos, { name: 'texto', email: 'email' });
  const ignored = Object.fromEntries(r.ignored.map((i) => [`${i.method} ${i.path}`, i.reason]));
  assert.match(ignored['POST /pets'], /mutación no soportada/);
  assert.match(ignored['GET /health'], /sin esquema/);
  assert.match(ignored['GET /pets/{petId}/photo'], /respuesta binaria\/no JSON \(image\/png\)/);
  assert.ok(r.notes.some((n) => /owners\.id: el spec dice string \(uuid\)/.test(n)));
});

test('import CLI: escribe un escenario válido que world genera y el motor sirve con el envoltorio', () => {
  const dir = tmpProject({});
  const r = cli(['import', PETSTORE], dir);
  assert.equal(r.code, 0, r.stderr);
  for (const s of [/Endpoints inferidos \(2\)/, /envoltorio \{data: \[\.\.\.\]\} → pick: data/, /Ignoradas \(3\):/, /POST \/pets: mutación/, /GET \/health: 200 sin esquema/, /respuesta binaria/, /Escrito: atrezzo\/escenarios\/api\.yaml \(escenario válido\)/]) assert.match(r.stdout, s);
  const file = join(dir, 'atrezzo/escenarios/api.yaml');
  const yaml = readFileSync(file, 'utf8');
  assert.match(yaml, /^expect: \[\]$/m);
  assert.match(yaml, /^ {4}pick: data/m);
  const sc = loadScenario(file);
  const engine = createEngine(generateWorld(sc));
  const page2 = engine.handle({ pathname: '/api/owners', query: { page: '2' } });
  assert.deepEqual(Object.keys(page2.body), ['data', 'total', 'limit', 'offset']);
  assert.equal(page2.body.data.length, 10);
  assert.equal(page2.body.data[0].id, 11);
  assert.equal(page2.body.offset, 10);
  assert.equal(engine.handle({ pathname: '/api/owners', query: { page: '0' } }).status, 400);
  const avail = engine.handle({ pathname: '/api/pets', query: { status: 'available', limit: '100' } });
  assert.equal(avail.body.length, 10);
  assert.ok(avail.body.every((p) => p.status === 'available' && typeof p.name === 'string' && !('nombre' in p)));
  // Determinista y sin pisar.
  const again = cli(['import', PETSTORE], dir);
  assert.equal(again.code, 3);
  assert.match(again.stderr, /ya existe; usa --force/);
  cli(['import', PETSTORE, '--force'], dir);
  assert.equal(readFileSync(file, 'utf8'), yaml);
  const w = cli(['world', 'atrezzo/escenarios/api.yaml'], dir);
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stdout, /GET \/api\/owners {2}owners · paginación: per_page\/page \(por página\) · orden: id · envoltorio: data/);
});

test('import: --base manda sobre servers, --format json, y TODO cuando no hay colección', () => {
  const spec = {
    openapi: '3.0.0', info: { title: 'Inv' }, servers: [{ url: 'https://api.example.com/v2/' }],
    paths: {
      '/stock': { get: { responses: { 200: { description: 'x', content: { 'application/json': { schema: { type: 'object', additionalProperties: { type: 'integer' } } } } } } } },
      '/tags': { get: { responses: { 200: { description: 'x', content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } } } } },
      '/products': { get: { parameters: [{ name: 'kind', in: 'query', schema: { type: 'string', enum: ['a', 'b'] } }], responses: { 200: { description: 'x', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, price: { type: 'number' } } } }, next: { type: 'string' } } } } } } } } },
    },
  };
  const dir = tmpProject({ 'inv.json': JSON.stringify(spec) });
  const r = cli(['import', 'inv.json', '--name', 'inv', '--format', 'json'], dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Base: \/v2 \(servers\[0\]\.url = "https:\/\/api\.example\.com\/v2\/", absoluta: me quedo con la ruta\)/);
  assert.match(r.stdout, /GET \/v2\/stock: devuelve un mapa clave→valor/);
  assert.match(r.stdout, /GET \/v2\/tags: array de valores string/);
  assert.match(r.stdout, /\?kind \(enum\) no tiene campo homónimo/);
  const doc = JSON.parse(readFileSync(join(dir, 'atrezzo/escenarios/inv.json'), 'utf8'));
  assert.deepEqual(doc.endpoints, [{ path: '/v2/products', entity: 'products', pick: 'items', detail: false }]);
  const b = cli(['import', 'inv.json', '--name', 'inv2', '--base', '/api/'], dir);
  assert.match(b.stdout, /GET \/api\/products → products/);
  const yaml = readFileSync(join(dir, 'atrezzo/escenarios/inv2.yaml'), 'utf8');
  assert.match(yaml, /# TODO: GET \/api\/stock — devuelve un mapa/);
  assert.match(yaml, /# TODO: GET \/api\/tags — array de valores string/);
});

test('import: sin ninguna colección deja el escenario marcado e inválido (exit 3), nunca en silencio', () => {
  const dir = tmpProject({ 's.json': JSON.stringify({ openapi: '3.0.0', paths: { '/me': { get: { responses: { 200: { description: 'x', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } } } } } }) });
  const r = cli(['import', 's.json', '--name', 'yo'], dir);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /escenario INVÁLIDO todavía: completa los TODO/);
  assert.match(readFileSync(join(dir, 'atrezzo/escenarios/yo.yaml'), 'utf8'), /# TODO: no se ha podido inferir ninguna entidad/);
});

test('import sin argumento usa workspace.contract de la config', () => {
  const dir = tmpProject({ 'api/openapi.yaml': readFileSync(PETSTORE, 'utf8') });
  writeFileSync(join(dir, 'atrezzo.config.json'), JSON.stringify({ version: 1, scenariosDir: 'atrezzo/escenarios', handlersDir: 'atrezzo/handlers', generatedDir: 'atrezzo/.generated', workspace: { contract: 'api/openapi.yaml' } }));
  const r = cli(['import'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Importado api\/openapi\.yaml/);
});

test('escenario: campos tipados sustituyen los de la plantilla y validan tipos', () => {
  const base = { name: 'x', seed: 1, endpoints: [{ path: '/api/users', entity: 'users' }] };
  const sc = normalizeScenario({ ...base, world: { users: { total: 3, campos: { username: 'texto', active: 'booleano', uid: 'uuid', role: ['a', 'b'] } } } });
  const rows = generateWorld(sc).entities.users;
  assert.deepEqual(Object.keys(rows[0]), ['id', 'username', 'active', 'uid', 'role']);
  assert.match(rows[0].uid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => normalizeScenario({ ...base, world: { users: { total: 1, campos: { id: 'entero', x: 'fecha_rara' } } } }), (e) => /campos\.id.*lo asigna atrezzo/.test(e.message) && /campos\.x.*tipo desconocido/.test(e.message));
  assert.throws(() => normalizeScenario({ ...base, world: { users: 1 }, endpoints: [{ path: '/u', entity: 'users', pagination: { param_page: 'page' } }] }), /default_limit.*obligatorio con "param_page"/);
  assert.throws(() => normalizeScenario({ ...base, world: { users: 1 }, endpoints: [{ path: '/u', entity: 'users', shape: 'array', pick: 'items' }] }), /incompatible con shape: array/);
});
