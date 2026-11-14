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

test('emitYaml: round-trips through our parser, quoting where needed', () => {
  const value = {
    openapi: '3.1.0', n: 3, f: 1.5, t: true, nothing: null, empty: {}, list: [],
    odd: ['yes', 'no', '123', '2025-01-01', 'a: b', '#x', '- y', '', ' sp', 'Ferretería Norte', '{x}', 'a,b', "it's"],
    '/api/orders': { get: { responses: { 200: { description: 'ok' } } } },
    nested: [{ a: 1, b: [1, 2] }, [3, 4], { c: { d: 'e' } }],
  };
  const text = emitYaml(value);
  assert.deepEqual(parseYaml(text), JSON.parse(JSON.stringify(value)));
  assert.match(text, /^ {2}- "yes"$/m);
  assert.match(text, /^ {2}- "2025-01-01"$/m);
  assert.match(text, /^ {6}"200":$/m);
  assert.equal(emitYaml(value), text);
});

test('import petstore: endpoints, {data} envelope, ignored routes with reasons, and TODOs', () => {
  const r = inferScenario(loadSpec(PETSTORE), { name: 'api', file: 'petstore.yaml' });
  assert.equal(r.prefix, '/api');
  assert.match(r.baseInfo, /servers\[0\]\.url = "\/api", relative/);
  const [pets, owners] = r.doc.endpoints;
  assert.equal(r.doc.endpoints.length, 2);
  assert.equal(pets.path, '/api/pets');
  assert.equal(pets.entity, 'pets');
  assert.equal(pets.pick, null);
  assert.deepEqual(pets.filters, ['status']);
  assert.deepEqual(pets.pagination, { param_limit: 'limit', param_offset: 'offset', default_limit: 20, max_limit: 100 });
  assert.equal(pets.detail, '/pets/{petId}');
  assert.ok(pets.paramNotes.some((n) => /\?tag without enum/.test(n)));
  const petEntity = r.doc.entities.find((e) => e.name === 'pets');
  assert.deepEqual(petEntity.fields, { name: 'string', tag: 'string', status: ['available', 'pending', 'sold'], createdAt: 'date' });
  assert.deepEqual(petEntity.skipped, ['owner (nested object)']);
  assert.equal(owners.path, '/api/owners');
  assert.equal(owners.pick, 'data');
  assert.deepEqual(owners.wrapperOthers, ['total']);
  assert.deepEqual(owners.pagination, { param_page: 'page', param_limit: 'per_page', default_limit: 10 });
  assert.deepEqual(r.doc.entities.find((e) => e.name === 'owners').fields, { name: 'string', email: 'email' });
  const ignored = Object.fromEntries(r.ignored.map((i) => [`${i.method} ${i.path}`, i.reason]));
  assert.match(ignored['POST /pets'], /mutation not supported/);
  assert.match(ignored['GET /health'], /without schema/);
  assert.match(ignored['GET /pets/{petId}/photo'], /binary\/non-JSON response \(image\/png\)/);
  assert.ok(r.notes.some((n) => /owners\.id: the spec says string \(uuid\)/.test(n)));
});

test('import CLI: writes a valid scenario that world generates and the engine serves with the envelope', () => {
  const dir = tmpProject({});
  const r = cli(['import', PETSTORE], dir);
  assert.equal(r.code, 0, r.stderr);
  for (const s of [/Inferred endpoints \(2\)/, /envelope \{data: \[\.\.\.\]\} → pick: data/, /Ignored \(3\):/, /POST \/pets: mutation/, /GET \/health: 200 without schema/, /binary\/non-JSON response/, /Written: atrezzo\/escenarios\/api\.yaml \(valid scenario\)/]) assert.match(r.stdout, s);
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
  // Deterministic, and never overwrites silently.
  const again = cli(['import', PETSTORE], dir);
  assert.equal(again.code, 3);
  assert.match(again.stderr, /already exists; use --force/);
  cli(['import', PETSTORE, '--force'], dir);
  assert.equal(readFileSync(file, 'utf8'), yaml);
  const w = cli(['world', 'atrezzo/escenarios/api.yaml'], dir);
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stdout, /GET \/api\/owners {2}owners · pagination: per_page\/page \(by page\) · sort: id · envelope: data/);
});

test('import: --base overrides servers, --format json, and TODO when there is no collection', () => {
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
  assert.match(r.stdout, /Base: \/v2 \(servers\[0\]\.url = "https:\/\/api\.example\.com\/v2\/", absolute: keeping the path\)/);
  assert.match(r.stdout, /GET \/v2\/stock: returns a key→value map/);
  assert.match(r.stdout, /GET \/v2\/tags: array of string values/);
  assert.match(r.stdout, /\?kind \(enum\) has no field with the same name/);
  const doc = JSON.parse(readFileSync(join(dir, 'atrezzo/escenarios/inv.json'), 'utf8'));
  assert.deepEqual(doc.endpoints, [{ path: '/v2/products', entity: 'products', pick: 'items', detail: false }]);
  const b = cli(['import', 'inv.json', '--name', 'inv2', '--base', '/api/'], dir);
  assert.match(b.stdout, /GET \/api\/products → products/);
  const yaml = readFileSync(join(dir, 'atrezzo/escenarios/inv2.yaml'), 'utf8');
  assert.match(yaml, /# TODO: GET \/api\/stock — returns a key→value map/);
  assert.match(yaml, /# TODO: GET \/api\/tags — array of string values/);
});

test('import: with no collection the scenario is marked and invalid (exit 3), never silently', () => {
  const dir = tmpProject({ 's.json': JSON.stringify({ openapi: '3.0.0', paths: { '/me': { get: { responses: { 200: { description: 'x', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } } } } } }) });
  const r = cli(['import', 's.json', '--name', 'yo'], dir);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /scenario still INVALID: complete the TODOs/);
  assert.match(readFileSync(join(dir, 'atrezzo/escenarios/yo.yaml'), 'utf8'), /# TODO: no entity could be inferred/);
});

test('import without an argument uses workspace.contract from the config', () => {
  const dir = tmpProject({ 'api/openapi.yaml': readFileSync(PETSTORE, 'utf8') });
  writeFileSync(join(dir, 'atrezzo.config.json'), JSON.stringify({ version: 1, scenariosDir: 'atrezzo/escenarios', handlersDir: 'atrezzo/handlers', generatedDir: 'atrezzo/.generated', workspace: { contract: 'api/openapi.yaml' } }));
  const r = cli(['import'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Imported api\/openapi\.yaml/);
});

test('scenario: typed fields replace the template ones and types are validated', () => {
  const base = { name: 'x', seed: 1, endpoints: [{ path: '/api/users', entity: 'users' }] };
  const sc = normalizeScenario({ ...base, world: { users: { total: 3, fields: { username: 'string', active: 'boolean', uid: 'uuid', role: ['a', 'b'] } } } });
  const rows = generateWorld(sc).entities.users;
  assert.deepEqual(Object.keys(rows[0]), ['id', 'username', 'active', 'uid', 'role']);
  assert.match(rows[0].uid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => normalizeScenario({ ...base, world: { users: { total: 1, fields: { id: 'integer', x: 'weird_date' } } } }), (e) => /fields\.id.*atrezzo assigns the id/.test(e.message) && /fields\.x.*unknown type/.test(e.message));
  assert.throws(() => normalizeScenario({ ...base, world: { users: 1 }, endpoints: [{ path: '/u', entity: 'users', pagination: { param_page: 'page' } }] }), /default_limit.*required with "param_page"/);
  assert.throws(() => normalizeScenario({ ...base, world: { users: 1 }, endpoints: [{ path: '/u', entity: 'users', shape: 'array', pick: 'items' }] }), /incompatible with shape: array/);
});
