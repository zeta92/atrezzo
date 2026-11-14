import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { generateWorld, checkIntegrity } from '../scripts/lib/world.mjs';
import { datasetJson } from '../scripts/lib/codegen.mjs';
import { SCENARIO } from './helpers.mjs';

const scenario = (text = SCENARIO) => normalizeScenario(parseYaml(text, 't.yaml'), 't.yaml');

test('exact counts from the scenario', () => {
  const d = generateWorld(scenario());
  assert.equal(d.entities.clientes.length, 3);
  assert.equal(d.entities.pedidos.length, 40);
  assert.equal(d.entities.usuarios.length, 2);
});

test('status distribution honored exactly', () => {
  const d = generateWorld(scenario());
  const counts = {};
  for (const p of d.entities.pedidos) counts[p.estado] = (counts[p.estado] ?? 0) + 1;
  assert.deepEqual(counts, { pagado: 34, pendiente: 3, incidencia: 3 });
});

test('referential integrity: every client_id exists and every customer has orders', () => {
  const d = generateWorld(scenario());
  const ids = new Set(d.entities.clientes.map((c) => c.id));
  for (const p of d.entities.pedidos) assert.ok(ids.has(p.client_id), `client_id ${p.client_id} does not exist`);
  for (const id of ids) assert.ok(d.entities.pedidos.some((p) => p.client_id === id), `customer ${id} has no orders`);
  assert.deepEqual(checkIntegrity(d), []);
});

test('unique, consecutive ids; amounts within range with 2 decimals', () => {
  const d = generateWorld(scenario());
  assert.deepEqual(d.entities.pedidos.map((p) => p.id), Array.from({ length: 40 }, (_, i) => i + 1));
  for (const p of d.entities.pedidos) {
    assert.ok(p.importe >= 20 && p.importe <= 900, `importe ${p.importe}`);
    assert.equal(Math.round(p.importe * 100) / 100, p.importe);
    assert.equal(p.moneda, 'EUR');
  }
});

test('byte-for-byte determinism: same seed ⇒ same JSON', () => {
  assert.equal(datasetJson(generateWorld(scenario())), datasetJson(generateWorld(scenario())));
});

test('different seed ⇒ different data with the same counts', () => {
  const a = generateWorld(scenario());
  const b = generateWorld(scenario(SCENARIO.replace('seed: 7712', 'seed: 1')));
  assert.notDeepEqual(a.entities.pedidos, b.entities.pedidos);
  assert.equal(b.entities.pedidos.filter((p) => p.estado === 'incidencia').length, 3);
});

test('injected "now": dates depend on the scenario, not the clock', () => {
  const a = generateWorld(scenario());
  const later = generateWorld(scenario(SCENARIO.replace('now: 2025-03-01T09:00:00Z', 'now: 2026-03-01T09:00:00Z')));
  for (const p of a.entities.pedidos) assert.ok(p.creado_en <= '2025-03-01T09:00:00.000Z');
  assert.notEqual(a.entities.pedidos[0].creado_en, later.entities.pedidos[0].creado_en);
});

test('no order predates its customer', () => {
  const d = generateWorld(scenario());
  const born = Object.fromEntries(d.entities.clientes.map((c) => [c.id, c.creado_en]));
  for (const p of d.entities.pedidos) assert.ok(p.creado_en >= born[p.client_id]);
});

test('adding an entity does not change the others (per-entity streams)', () => {
  const a = generateWorld(scenario());
  const b = generateWorld(scenario(SCENARIO.replace('  usuarios: 2', '  usuarios: 2\n  productos: 5')));
  assert.deepEqual(a.entities.pedidos, b.entities.pedidos);
  assert.equal(b.entities.productos.length, 5);
});

test('explicit nulls: exactly n records with the field set to null', () => {
  const d = generateWorld(scenario(SCENARIO.replace('  usuarios: 2', '  usuarios: { total: 4, nulls: { email: 2 } }')));
  assert.equal(d.entities.usuarios.filter((u) => u.email === null).length, 2);
});
