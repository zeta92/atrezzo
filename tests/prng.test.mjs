import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRng } from '../scripts/lib/prng.mjs';
import { ROOT } from './helpers.mjs';

const seq = (seed, n = 50, stream) => { const r = createRng(seed, stream); return Array.from({ length: n }, () => r.next()); };

test('misma semilla ⇒ misma secuencia', () => {
  assert.deepEqual(seq(7712), seq(7712));
  assert.deepEqual(seq('texto'), seq('texto'));
});

test('semillas distintas ⇒ secuencias distintas', () => {
  assert.notDeepEqual(seq(7712), seq(7713));
  assert.notDeepEqual(seq(1), seq(2));
});

test('streams independientes con la misma semilla', () => {
  assert.notDeepEqual(seq(7712, 20, 'entity:pedidos'), seq(7712, 20, 'entity:clientes'));
  assert.deepEqual(seq(7712, 20, 'entity:pedidos'), seq(7712, 20, 'entity:pedidos'));
});

test('valores dorados: el algoritmo no cambia entre versiones', () => {
  const r = createRng(42);
  const got = Array.from({ length: 5 }, () => r.int(0, 1_000_000));
  // Si esto falla, cambiaría el mundo de todos los escenarios commiteados.
  assert.deepEqual(got, [645581, 144259, 33316, 764051, 101285]);
});

test('int, shuffle y sample respetan rangos y no mutan la entrada', () => {
  const r = createRng(5);
  for (let i = 0; i < 1000; i++) { const v = r.int(3, 7); assert.ok(v >= 3 && v <= 7 && Number.isInteger(v)); }
  const input = [1, 2, 3, 4, 5, 6];
  const out = r.shuffle(input);
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...out].sort(), input);
  const s = r.sample(10, 4);
  assert.equal(new Set(s).size, 4);
  assert.throws(() => r.int(5, 1), RangeError);
});

test('la generación no usa Math.random() ni Date.now()', () => {
  const dir = join(ROOT, 'scripts', 'lib');
  for (const f of ['prng.mjs', 'world.mjs', 'contract.mjs', 'scenario.mjs', 'codegen.mjs']) {
    const src = readFileSync(join(dir, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/Math\.random\s*\(/.test(src), `${f} usa Math.random()`);
    assert.ok(!/Date\.now\s*\(/.test(src), `${f} usa Date.now()`);
    assert.ok(!/new Date\(\s*\)/.test(src), `${f} usa new Date() sin argumento`);
  }
  assert.ok(readdirSync(dir).length > 0);
});
