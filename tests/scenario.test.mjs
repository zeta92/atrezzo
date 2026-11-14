import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlError } from '../scripts/lib/yaml.mjs';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { AtrezzoError } from '../scripts/lib/errors.mjs';
import { SCENARIO, tmpProject, cli } from './helpers.mjs';

const norm = (text) => normalizeScenario(parseYaml(text, 'e.yaml'), 'e.yaml');
const errorOf = (fn) => { try { fn(); } catch (e) { return e; } assert.fail('expected an error'); };

test('YAML parser: scenario format structures', () => {
  const doc = parseYaml(SCENARIO);
  assert.equal(doc.seed, 7712);
  assert.deepEqual(doc.world.pedidos.distribution, { pagado: 34, pendiente: 3, incidencia: 3 });
  assert.deepEqual(doc.path, ['dashboard', 'lista']);
  assert.equal(doc.expect[0].selector, '[data-testid=order-row]');
  assert.deepEqual(doc.endpoints[0].filters, ['estado', 'client_id']);
  assert.deepEqual(parseYaml('a: "x # not a comment" # yes\nb: |\n  l1\n  l2\n'), { a: 'x # not a comment', b: 'l1\nl2\n' });
  assert.deepEqual(parseYaml('k:\n- 1\n- two\n'), { k: [1, 'two'] });
});

test('broken YAML ⇒ YamlError with line number', () => {
  const e = errorOf(() => parseYaml('name: x\nworld:\n  clientes: 3\n   pedidos: 4\n', 'roto.yaml'));
  assert.ok(e instanceof YamlError);
  assert.match(e.message, /roto\.yaml \(line 4\)/);
  assert.match(errorOf(() => parseYaml('a: {b: 1\n')).message, /unterminated/);
  assert.match(errorOf(() => parseYaml('a: 1\na: 2\n')).message, /duplicate key "a"/);
  assert.match(errorOf(() => parseYaml('a:\n\tb: 1\n')).message, /tab in indentation/);
  assert.match(errorOf(() => parseYaml('a: *anchor\n')).message, /aliases/);
});

test('a valid scenario is normalized with defaults', () => {
  const s = norm(SCENARIO);
  assert.equal(s.name, 'conciliacion');
  assert.equal(s.now, '2025-03-01T09:00:00.000Z');
  assert.deepEqual(s.world.find((w) => w.name === 'pedidos').refs, ['clientes']);
  assert.deepEqual(s.endpoints[1].sort, [{ field: 'id', dir: 'asc' }]);
  assert.equal(s.expect.length, 2);
});

test('endpoint without entity ⇒ error naming the field', () => {
  const e = errorOf(() => norm(SCENARIO.replace('    entity: clientes\n', '')));
  assert.ok(e instanceof AtrezzoError);
  assert.equal(e.exitCode, 3);
  assert.match(e.message, /field "endpoints\[1\]\.entity": missing/);
});

test('expect without selector ⇒ error', () => {
  const e = errorOf(() => norm(SCENARIO.replace('  - selector: "[data-testid=order-row]"\n    count: 12', '  - count: 12')));
  assert.match(e.message, /field "expect\[0\]\.selector": missing/);
});

test('strict validations accumulate, each with its reason', () => {
  const bad = SCENARIO
    .replace('pagado: 34', 'pagado: 33')
    .replace('filters: [estado, client_id]', 'filters: [estadoo]')
    .replace('    count: 3\n', '    count: 3\n    min: 1\n')
    .replace('seed: 7712', 'seed: -1')
    .replace('name: conciliacion', 'name: conciliacion\ncolor: blue');
  const e = errorOf(() => norm(bad));
  assert.match(e.message, /field "world\.pedidos\.distribution": sum \(39\) does not match total \(40\)/);
  assert.match(e.message, /field "endpoints\[0\]\.filters\[0\]": field "estadoo" does not exist in "pedidos"/);
  assert.match(e.message, /use an exact "count" or "min"\/"max", not both/);
  assert.match(e.message, /field "seed"/);
  assert.match(e.message, /field "color": unknown field/);
});

test('unknown entity and reference to an empty entity', () => {
  assert.match(errorOf(() => norm(SCENARIO.replace('entity: clientes', 'entity: facturas'))).message, /"facturas" is not declared in world/);
  assert.match(errorOf(() => norm(SCENARIO.replace('  clientes: 3', '  clientes: 0'))).message, /has 0 items; the ids would not exist/);
});

test('min/max are accepted', () => {
  const s = norm(SCENARIO.replace('    count: 12\n', '    min: 10\n    max: 12\n'));
  assert.deepEqual([s.expect[0].min, s.expect[0].max], [10, 12]);
  assert.match(errorOf(() => norm(SCENARIO.replace('    count: 12\n', '    min: 13\n    max: 12\n'))).message, /min \(13\) is greater than max \(12\)/);
});

test('CLI: invalid scenario ⇒ exit 3 and message on stderr', () => {
  const dir = tmpProject({
    'roto.yaml': 'name: x\nseed: 1\nworld:\n  clientes: [\n',
    'sin-entidad.yaml': SCENARIO.replace('    entity: pedidos\n', ''),
    'sin-selector.yaml': SCENARIO.replace('  - selector: "[data-testid=badge-incidencia]"\n', '  - label: no selector\n'),
  });
  const r1 = cli(['world', 'roto.yaml'], dir);
  assert.equal(r1.code, 3);
  assert.match(r1.stderr, /invalid YAML/);
  const r2 = cli(['world', 'sin-entidad.yaml'], dir);
  assert.equal(r2.code, 3);
  assert.match(r2.stderr, /endpoints\[0\]\.entity": missing/);
  const r3 = cli(['world', 'sin-selector.yaml'], dir);
  assert.equal(r3.code, 3);
  assert.match(r3.stderr, /expect\[1\]\.selector": missing/);
  const r4 = cli(['world', 'no-existe.yaml'], dir);
  assert.equal(r4.code, 3);
  assert.match(r4.stderr, /does not exist/);
});
