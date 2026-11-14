import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { generateWorld } from '../scripts/lib/world.mjs';
import { createEngine } from '../scripts/lib/contract.mjs';
import { SCENARIO } from './helpers.mjs';

const dataset = generateWorld(normalizeScenario(parseYaml(SCENARIO, 't.yaml'), 't.yaml'));
const engine = createEngine(dataset);
const get = (path) => {
  const u = new URL(path, 'http://x');
  return engine.handle({ method: 'GET', pathname: u.pathname, query: u.searchParams });
};
const ids = (r) => r.body.map((x) => x.id);

test('limit/offset devuelven la ventana esperada', () => {
  const r = get('/api/orders?limit=12');
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(r.headers['x-total-count'], '40');
  assert.deepEqual(ids(get('/api/orders?limit=5&offset=10')), [11, 12, 13, 14, 15]);
});

test('páginas consecutivas cubren todo sin solapes', () => {
  const all = [];
  for (let off = 0; off < 40; off += 12) all.push(...ids(get(`/api/orders?limit=12&offset=${off}`)));
  assert.deepEqual(all, Array.from({ length: 40 }, (_, i) => i + 1));
});

test('limit mayor que el total devuelve todo', () => {
  assert.equal(get('/api/orders?limit=1000').body.length, 40);
});

test('offset fuera de rango devuelve []', () => {
  const r = get('/api/orders?limit=10&offset=40');
  assert.deepEqual(r.body, []);
  assert.equal(r.headers['x-total-count'], '40');
  assert.deepEqual(get('/api/orders?offset=999').body, []);
});

test('limit/offset inválidos ⇒ 400 con motivo', () => {
  const r = get('/api/orders?limit=-3');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /limit/);
  assert.equal(get('/api/orders?offset=abc').status, 400);
});

test('filtros por igualdad y lista separada por comas', () => {
  const inc = get('/api/orders?estado=incidencia');
  assert.equal(inc.body.length, 3);
  assert.ok(inc.body.every((p) => p.estado === 'incidencia'));
  assert.equal(get('/api/orders?estado=incidencia,pendiente').body.length, 6);
  const c1 = get('/api/orders?client_id=1');
  assert.ok(c1.body.length > 0 && c1.body.every((p) => p.client_id === 1));
  assert.equal(get('/api/orders?estado=incidencia&limit=2').body.length, 2);
});

test('parámetros no declarados se ignoran y se informa en cabecera', () => {
  const r = get('/api/orders?color=rojo');
  assert.equal(r.body.length, 40);
  assert.equal(r.headers['x-atrezzo-ignored'], 'color');
});

test('orden estable y determinista', () => {
  const ds = { ...dataset, endpoints: [{ ...dataset.endpoints[0], sort: [{ field: 'estado', dir: 'asc' }] }] };
  const e = createEngine(ds);
  const run = () => e.handle({ pathname: '/api/orders', query: new URLSearchParams() }).body.map((p) => p.id);
  const a = run();
  assert.deepEqual(a, run());
  // dentro de cada estado, se conserva el orden original por id (estabilidad)
  const body = e.handle({ pathname: '/api/orders', query: new URLSearchParams() }).body;
  for (const estado of ['incidencia', 'pagado', 'pendiente']) {
    const group = body.filter((p) => p.estado === estado).map((p) => p.id);
    assert.deepEqual(group, [...group].sort((x, y) => x - y));
  }
  assert.deepEqual([...new Set(body.map((p) => p.estado))], ['incidencia', 'pagado', 'pendiente']);
});

test('orden descendente', () => {
  const ds = { ...dataset, endpoints: [{ ...dataset.endpoints[0], sort: [{ field: 'creado_en', dir: 'desc' }] }] };
  const body = createEngine(ds).handle({ pathname: '/api/orders' }).body;
  for (let i = 1; i < body.length; i++) assert.ok(body[i - 1].creado_en >= body[i].creado_en);
});

test('detalle /:id existe o da 404; include embebe el padre', () => {
  assert.equal(get('/api/orders/7').body.id, 7);
  assert.equal(get('/api/orders/999').status, 404);
  const ds = { ...dataset, endpoints: [{ ...dataset.endpoints[0], include: ['clientes'] }] };
  const row = createEngine(ds).handle({ pathname: '/api/orders/1' }).body;
  assert.equal(row.cliente.id, row.client_id);
});

test('escrituras ⇒ 405 (el mock no implementa reglas de negocio)', () => {
  assert.equal(engine.handle({ method: 'POST', pathname: '/api/orders' }).status, 405);
  assert.equal(engine.handle({ pathname: '/api/otra' }), null);
});

test('shape envelope', () => {
  const ds = { ...dataset, endpoints: [{ ...dataset.endpoints[0], shape: 'envelope' }] };
  const r = createEngine(ds).handle({ pathname: '/api/orders', query: { limit: '3', offset: '1' } });
  assert.deepEqual(r.body.data.map((x) => x.id), [2, 3, 4]);
  assert.equal(r.body.total, 40);
});
