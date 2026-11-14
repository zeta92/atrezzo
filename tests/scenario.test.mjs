import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlError } from '../scripts/lib/yaml.mjs';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { AtrezzoError } from '../scripts/lib/errors.mjs';
import { SCENARIO, tmpProject, cli } from './helpers.mjs';

const norm = (text) => normalizeScenario(parseYaml(text, 'e.yaml'), 'e.yaml');
const errorOf = (fn) => { try { fn(); } catch (e) { return e; } assert.fail('se esperaba un error'); };

test('parser YAML: estructuras del formato de escenario', () => {
  const doc = parseYaml(SCENARIO);
  assert.equal(doc.seed, 7712);
  assert.deepEqual(doc.world.pedidos.distribucion, { pagado: 34, pendiente: 3, incidencia: 3 });
  assert.deepEqual(doc.path, ['dashboard', 'lista']);
  assert.equal(doc.expect[0].selector, '[data-testid=order-row]');
  assert.deepEqual(doc.endpoints[0].filters, ['estado', 'client_id']);
  assert.deepEqual(parseYaml('a: "x # no es comentario" # sí\nb: |\n  l1\n  l2\n'), { a: 'x # no es comentario', b: 'l1\nl2\n' });
  assert.deepEqual(parseYaml('k:\n- 1\n- two\n'), { k: [1, 'two'] });
});

test('YAML roto ⇒ YamlError con línea', () => {
  const e = errorOf(() => parseYaml('name: x\nworld:\n  clientes: 3\n   pedidos: 4\n', 'roto.yaml'));
  assert.ok(e instanceof YamlError);
  assert.match(e.message, /roto\.yaml \(línea 4\)/);
  assert.match(errorOf(() => parseYaml('a: {b: 1\n')).message, /sin cerrar/);
  assert.match(errorOf(() => parseYaml('a: 1\na: 2\n')).message, /clave duplicada "a"/);
  assert.match(errorOf(() => parseYaml('a:\n\tb: 1\n')).message, /tabulador/);
  assert.match(errorOf(() => parseYaml('a: *ancla\n')).message, /alias/);
});

test('escenario válido se normaliza con valores por defecto', () => {
  const s = norm(SCENARIO);
  assert.equal(s.name, 'conciliacion');
  assert.equal(s.now, '2025-03-01T09:00:00.000Z');
  assert.deepEqual(s.world.find((w) => w.name === 'pedidos').refs, ['clientes']);
  assert.deepEqual(s.endpoints[1].sort, [{ field: 'id', dir: 'asc' }]);
  assert.equal(s.expect.length, 2);
});

test('endpoint sin entidad ⇒ error que nombra el campo', () => {
  const e = errorOf(() => norm(SCENARIO.replace('    entity: clientes\n', '')));
  assert.ok(e instanceof AtrezzoError);
  assert.equal(e.exitCode, 3);
  assert.match(e.message, /campo "endpoints\[1\]\.entity": falta/);
});

test('expect sin selector ⇒ error', () => {
  const e = errorOf(() => norm(SCENARIO.replace('  - selector: "[data-testid=order-row]"\n    count: 12', '  - count: 12')));
  assert.match(e.message, /campo "expect\[0\]\.selector": falta/);
});

test('validaciones estrictas acumuladas con motivo', () => {
  const bad = SCENARIO
    .replace('pagado: 34', 'pagado: 33')
    .replace('filters: [estado, client_id]', 'filters: [estadoo]')
    .replace('    count: 3\n', '    count: 3\n    min: 1\n')
    .replace('seed: 7712', 'seed: -1')
    .replace('name: conciliacion', 'name: conciliacion\ncolor: azul');
  const e = errorOf(() => norm(bad));
  assert.match(e.message, /campo "world\.pedidos\.distribucion": la suma \(39\) no coincide con total \(40\)/);
  assert.match(e.message, /campo "endpoints\[0\]\.filters\[0\]": el campo "estadoo" no existe en "pedidos"/);
  assert.match(e.message, /usa "count" exacto o "min"\/"max", no ambos/);
  assert.match(e.message, /campo "seed"/);
  assert.match(e.message, /campo "color": campo desconocido/);
});

test('entidad desconocida y referencia a entidad vacía', () => {
  assert.match(errorOf(() => norm(SCENARIO.replace('entity: clientes', 'entity: facturas'))).message, /"facturas" no está declarada en world/);
  assert.match(errorOf(() => norm(SCENARIO.replace('  clientes: 3', '  clientes: 0'))).message, /tiene 0 elementos; los ids no existirían/);
});

test('min/max se aceptan', () => {
  const s = norm(SCENARIO.replace('    count: 12\n', '    min: 10\n    max: 12\n'));
  assert.deepEqual([s.expect[0].min, s.expect[0].max], [10, 12]);
  assert.match(errorOf(() => norm(SCENARIO.replace('    count: 12\n', '    min: 13\n    max: 12\n'))).message, /min \(13\) es mayor que max \(12\)/);
});

test('CLI: escenario inválido ⇒ exit 3 y mensaje en stderr', () => {
  const dir = tmpProject({
    'roto.yaml': 'name: x\nseed: 1\nworld:\n  clientes: [\n',
    'sin-entidad.yaml': SCENARIO.replace('    entity: pedidos\n', ''),
    'sin-selector.yaml': SCENARIO.replace('  - selector: "[data-testid=badge-incidencia]"\n', '  - label: sin selector\n'),
  });
  const r1 = cli(['world', 'roto.yaml'], dir);
  assert.equal(r1.code, 3);
  assert.match(r1.stderr, /YAML inválido/);
  const r2 = cli(['world', 'sin-entidad.yaml'], dir);
  assert.equal(r2.code, 3);
  assert.match(r2.stderr, /endpoints\[0\]\.entity": falta/);
  const r3 = cli(['world', 'sin-selector.yaml'], dir);
  assert.equal(r3.code, 3);
  assert.match(r3.stderr, /expect\[1\]\.selector": falta/);
  const r4 = cli(['world', 'no-existe.yaml'], dir);
  assert.equal(r4.code, 3);
  assert.match(r4.stderr, /no existe/);
});
