// La matriz de capacidades: cobertura del DSL, documento generado y avisos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENDPOINT_KEYS, loadScenario } from '../scripts/lib/scenario.mjs';
import {
  CAPABILITIES, KEY_COVERAGE, SCENARIO_KEY_COVERAGE, STATES,
  degradations, renderCapabilities, stateOf, usedCapabilities
} from '../scripts/lib/capabilities.mjs';
import { ROOT, cli, tmpProject } from './helpers.mjs';

const FIXTURES = join(ROOT, 'tests', 'fixtures', 'capabilities');
const FIXTURE_SCENARIO = join(FIXTURES, 'prism-wiremock', 'scenarios', 'capabilities.yaml');

test('capabilities: every scenario key has a capability (a new DSL key breaks this test)', () => {
  const ids = new Set(CAPABILITIES.map((c) => c.id));
  for (const k of ENDPOINT_KEYS) {
    assert.ok(Object.hasOwn(KEY_COVERAGE, k), `endpoint key "${k}" has no entry in KEY_COVERAGE`);
    const cap = KEY_COVERAGE[k];
    assert.ok(cap === 'core' || ids.has(cap), `endpoint key "${k}" points at unknown capability "${cap}"`);
  }
  for (const [k, cap] of Object.entries(SCENARIO_KEY_COVERAGE)) {
    assert.ok(ids.has(cap), `scenario key "${k}" points at unknown capability "${cap}"`);
  }
  for (const cap of CAPABILITIES) {
    for (const [rt, st] of Object.entries(cap.states)) {
      assert.ok(STATES.includes(st), `${cap.id} × ${rt}: unknown state "${st}"`);
    }
    assert.ok(Object.keys(cap.states).length >= 4, `${cap.id}: missing runtime columns`);
    for (const rt of Object.keys(cap.states)) {
      if (cap.states[rt] !== 'same') assert.ok(cap.notes?.[rt], `${cap.id} × ${rt} is "${cap.states[rt]}" without a note`);
    }
  }
});

test('capabilities: builtin is always "same" and an unknown id throws', () => {
  for (const cap of CAPABILITIES) assert.equal(stateOf(cap.id, 'builtin'), 'same');
  assert.throws(() => stateOf('no-existe', 'msw'), /unknown capability/);
});

test('capabilities: references/capabilities.md matches the module byte for byte', () => {
  const onDisk = readFileSync(join(ROOT, 'references', 'capabilities.md'), 'utf8');
  assert.equal(onDisk, renderCapabilities(), 'stale docs: run node scripts/cli.mjs capabilities --write');
});

test('capabilities: the fixture uses writes, rpc, streams and latency', () => {
  const sc = loadScenario(FIXTURE_SCENARIO);
  const used = usedCapabilities(sc).map((c) => c.id);
  for (const id of ['writes', 'rpc', 'streams', 'latency', 'pagination', 'sorts', 'scopes', 'envelope', 'filters']) {
    assert.ok(used.includes(id), `expected "${id}" in ${used.join(', ')}`);
  }
  const prism = degradations(sc, 'prism').map((d) => d.id);
  assert.ok(prism.includes('writes') && prism.includes('rpc') && prism.includes('streams'));
  const note = degradations(sc, 'prism').find((d) => d.id === 'writes');
  assert.match(note.note, /no emite las rutas de escritura/);
  assert.deepEqual(degradations(sc, 'builtin'), []);
});

test('capabilities: a scenario without the capabilities produces no warnings', () => {
  const dir = tmpProject({
    's.yaml': 'name: simple\nseed: 1\nworld:\n  items: 3\nendpoints:\n  - path: /api/items\n    entity: items\n'
  });
  const sc = loadScenario(join(dir, 's.yaml'));
  for (const rt of ['msw', 'supabase', 'prism', 'wiremock']) {
    const ids = degradations(sc, rt).map((d) => d.id);
    assert.ok(!ids.includes('writes'), `${rt} should not warn about writes: ${ids.join(', ')}`);
  }
});

test('CLI world --strict: exit 3 when the runtime is degraded, 0 without the flag', () => {
  const strict = cli(['world', FIXTURE_SCENARIO, '--dir', join(FIXTURES, 'prism-wiremock'), '--strict']);
  assert.equal(strict.code, 3, strict.stderr);
  assert.match(strict.stderr, /not reproduced by prism, wiremock/);
  assert.match(strict.stderr, /prism: streams/);

  const plain = cli(['world', FIXTURE_SCENARIO, '--dir', join(FIXTURES, 'prism-wiremock')]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /Degraded in prism: writes/);
});

test('CLI capabilities --check: 0 when the docs are current, 3 when they are not', () => {
  const ok = cli(['capabilities', '--check'], ROOT);
  assert.equal(ok.code, 0, ok.stderr);

  const dir = tmpProject({ 'references/capabilities.md': 'viejo\n' });
  const stale = cli(['capabilities', '--check'], dir);
  assert.equal(stale.code, 3);
  assert.match(stale.stderr, /is stale/);
});

test('CLI doctor: warns per capability the scenario uses and the runtime does not reproduce', () => {
  const r = cli(['doctor', '--dir', join(FIXTURES, 'prism-wiremock')]);
  const all = r.stdout + r.stderr;
  assert.match(all, /capacidades × prism: writes/, all);
  assert.match(all, /capacidades × wiremock: rpc/, all);
});
