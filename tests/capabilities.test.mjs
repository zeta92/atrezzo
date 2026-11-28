// The capability matrix: DSL coverage, the generated document and the warnings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENDPOINT_KEYS, SCENARIO_KEYS, loadScenario } from '../scripts/lib/scenario.mjs';
import {
  CAPABILITIES, KEY_COVERAGE, SCENARIO_KEY_COVERAGE, STATES,
  degradations, renderCapabilities, stateOf, usedCapabilities
} from '../scripts/lib/capabilities.mjs';
import { ROOT, cli, tmpProject } from './helpers.mjs';

const FIXTURES = join(ROOT, 'tests', 'fixtures', 'capabilities');
const FIXTURE_SCENARIO = join(FIXTURES, 'prism-wiremock', 'scenarios', 'capabilities.yaml');

/** A throwaway copy of the committed prism-wiremock fixture, so CLI runs never dirty the repo. */
function fixtureCopy() {
  const dir = tmpProject();
  cpSync(join(FIXTURES, 'prism-wiremock'), dir, { recursive: true });
  return { dir, scenario: join(dir, 'scenarios', 'capabilities.yaml') };
}

test('capabilities: every scenario key has a capability (a new DSL key breaks this test)', () => {
  const ids = new Set(CAPABILITIES.map((c) => c.id));
  for (const k of ENDPOINT_KEYS) {
    assert.ok(Object.hasOwn(KEY_COVERAGE, k), `endpoint key "${k}" has no entry in KEY_COVERAGE`);
    const cap = KEY_COVERAGE[k];
    assert.ok(cap === 'core' || ids.has(cap), `endpoint key "${k}" points at unknown capability "${cap}"`);
  }
  for (const k of SCENARIO_KEYS) {
    assert.ok(Object.hasOwn(SCENARIO_KEY_COVERAGE, k), `scenario key "${k}" has no entry in SCENARIO_KEY_COVERAGE`);
    const cap = SCENARIO_KEY_COVERAGE[k];
    assert.ok(cap === 'core' || ids.has(cap), `scenario key "${k}" points at unknown capability "${cap}"`);
  }
  for (const k of Object.keys(SCENARIO_KEY_COVERAGE)) {
    assert.ok(SCENARIO_KEYS.includes(k), `SCENARIO_KEY_COVERAGE has "${k}", which is not a scenario key`);
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
  assert.match(note.note, /write routes are not emitted/);
  assert.equal(note.state, 'different', 'no 501 is emitted: at run time it is a silent 404');
  assert.deepEqual(degradations(sc, 'builtin'), []);
});

test('capabilities: include, a single path parameter and error are detected', () => {
  const dir = tmpProject({
    's.yaml': [
      'name: detect', 'seed: 1', 'world:', '  customers: 2', '  orders:', '    total: 4', '    ref: customers',
      'endpoints:',
      '  - path: /api/orders', '    entity: orders', '    include: [customers]',
      '  - path: /api/customers/:customer_id/orders', '    entity: orders',
      '  - path: /api/customers', '    entity: customers', '    error: { status: 503 }', ''
    ].join('\n')
  });
  const sc = loadScenario(join(dir, 's.yaml'));
  const used = usedCapabilities(sc).map((c) => c.id);
  assert.ok(used.includes('relations'), `include counts as relations: ${used.join(', ')}`);
  assert.ok(used.includes('nested-routes'), `one path parameter counts: ${used.join(', ')}`);
  assert.ok(degradations(sc, 'supabase').some((d) => d.id === 'passthrough-error'), 'supabase does not emit error:');
  assert.ok(degradations(sc, 'wiremock').some((d) => d.id === 'nested-routes' && d.state === 'different'));
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

test('capabilities: response-headers is detected from endpoint headers and passthrough fixture headers', () => {
  const dir = tmpProject({
    'atrezzo/fixtures/market.json': JSON.stringify({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: { ok: true },
      headers: {
        'X-Fixture-Header': 'from-fixture',
        'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/']
      }
    }),
    'atrezzo/fixtures/plain.json': JSON.stringify({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: { ok: true },
      headers: {}
    }),
    'combined.yaml': [
      'name: response-headers-demo', 'seed: 1', 'world:', '  items: 2',
      'endpoints:',
      '  - path: /api/items', '    entity: items', '    headers:', '      X-RateLimit-Remaining: "42"',
      '  - path: /api/market', '    passthrough: { fixture: market }', ''
    ].join('\n'),
    'endpoint-only.yaml': [
      'name: endpoint-headers-only', 'seed: 1', 'world:', '  items: 2',
      'endpoints:',
      '  - path: /api/items', '    entity: items', '    headers:', '      Cache-Control: no-store', ''
    ].join('\n'),
    'fixture-only.yaml': [
      'name: fixture-headers-only', 'seed: 1',
      'endpoints:',
      '  - path: /api/market', '    passthrough: { fixture: market }', ''
    ].join('\n'),
    'empty-headers.yaml': [
      'name: empty-headers', 'seed: 1', 'world:', '  items: 2',
      'endpoints:',
      '  - path: /api/items', '    entity: items', '    headers: {}',
      '  - path: /api/plain', '    passthrough: { fixture: plain }', ''
    ].join('\n')
  });

  const sc = loadScenario(join(dir, 'combined.yaml'));
  const cap = usedCapabilities(sc).find((c) => c.id === 'response-headers');
  assert.ok(cap, 'expected response-headers capability to be used');
  assert.equal(cap.label, 'response headers (endpoint and passthrough fixture)');
  assert.deepEqual(cap.states, {
    msw: 'partial',
    supabase: 'declined',
    prism: 'partial',
    wiremock: 'same'
  });
  assert.equal(stateOf('response-headers', 'builtin'), 'same');
  assert.equal(stateOf('response-headers', 'msw'), 'partial');
  assert.equal(stateOf('response-headers', 'supabase'), 'declined');
  assert.equal(stateOf('response-headers', 'prism'), 'partial');
  assert.equal(stateOf('response-headers', 'wiremock'), 'same');

  const mswDeg = degradations(sc, 'msw').find((d) => d.id === 'response-headers');
  assert.ok(mswDeg, 'expected msw degradation for response-headers');
  assert.equal(mswDeg.state, 'partial');
  assert.match(mswDeg.note, /Set-Cookie/);

  const supabaseDeg = degradations(sc, 'supabase').find((d) => d.id === 'response-headers');
  assert.ok(supabaseDeg, 'expected supabase degradation for response-headers');
  assert.equal(supabaseDeg.state, 'declined');
  assert.match(supabaseDeg.note, /PostgREST/);

  const prismDeg = degradations(sc, 'prism').find((d) => d.id === 'response-headers');
  assert.ok(prismDeg, 'expected prism degradation for response-headers');
  assert.equal(prismDeg.state, 'partial');
  assert.match(prismDeg.note, /Set-Cookie/);

  assert.equal(
    degradations(sc, 'wiremock').find((d) => d.id === 'response-headers'),
    undefined,
    'wiremock should not warn about response-headers'
  );

  const epOnly = loadScenario(join(dir, 'endpoint-only.yaml'));
  assert.ok(usedCapabilities(epOnly).some((c) => c.id === 'response-headers'));

  const fixOnly = loadScenario(join(dir, 'fixture-only.yaml'));
  assert.ok(usedCapabilities(fixOnly).some((c) => c.id === 'response-headers'));

  const empty = loadScenario(join(dir, 'empty-headers.yaml'));
  assert.ok(!usedCapabilities(empty).some((c) => c.id === 'response-headers'));
});

test('capabilities: response-headers is detected from write expect.headers and cases[].expect.headers', () => {
  const dir = tmpProject({
    'write-only.yaml': [
      'name: write-headers-only',
      'seed: 1',
      'world:',
      '  items: 2',
      'endpoints:',
      '  - path: /api/items',
      '    entity: items',
      'writes:',
      '  "POST /api/login":',
      '    expect:',
      '      status: 200',
      '      body: { ok: true }',
      '      headers:',
      '        set-cookie: "sid=abc; Path=/; HttpOnly"',
      '    mutate: false',
      ''
    ].join('\n'),
    'write-empty-headers.yaml': [
      'name: write-empty-headers',
      'seed: 1',
      'world:',
      '  items: 2',
      'endpoints:',
      '  - path: /api/items',
      '    entity: items',
      'writes:',
      '  "POST /api/login":',
      '    mutate: false',
      '    expect: { status: 200, headers: {} }',
      '  "POST /api/logout":',
      '    cases:',
      '      - when: { all: true }',
      '        expect: { status: 200, body: { ok: true }, headers: {} }',
      '        mutate: false',
      ''
    ].join('\n'),
    'write-case-only.yaml': [
      'name: write-case-headers-only',
      'seed: 1',
      'world:',
      '  items: 2',
      'endpoints:',
      '  - path: /api/items',
      '    entity: items',
      'writes:',
      '  "POST /api/login":',
      '    cases:',
      '      - when: { email: "bad@example.com" }',
      '        expect:',
      '          status: 401',
      '          body: { error: "invalid_credentials" }',
      '        mutate: false',
      '      - when: { email: "ok@example.com" }',
      '        expect:',
      '          status: 200',
      '          body: { ok: true }',
      '          headers:',
      '            set-cookie: "sid=ok; Path=/; HttpOnly"',
      '        mutate: false',
      ''
    ].join('\n')
  });

  const writeOnly = loadScenario(join(dir, 'write-only.yaml'));
  const writeUsed = usedCapabilities(writeOnly).map((c) => c.id);
  assert.ok(
    writeUsed.includes('response-headers'),
    `expected response-headers from write expect.headers: ${writeUsed.join(', ')}`
  );

  const writeEmpty = loadScenario(join(dir, 'write-empty-headers.yaml'));
  assert.ok(
    !usedCapabilities(writeEmpty).some((c) => c.id === 'response-headers'),
    'empty write header maps must not activate response-headers'
  );

  const writeCaseOnly = loadScenario(join(dir, 'write-case-only.yaml'));
  assert.equal(writeCaseOnly.writes[0].expect, undefined);
  const writeCaseUsed = usedCapabilities(writeCaseOnly).map((c) => c.id);
  assert.ok(
    writeCaseUsed.includes('response-headers'),
    `expected response-headers from cases[].expect.headers: ${writeCaseUsed.join(', ')}`
  );
});

test('CLI world --strict: exit 3 when the runtime is degraded and nothing written, 0 without the flag', () => {
  const { dir, scenario } = fixtureCopy();
  const out = join(dir, 'strict-out');
  const strict = cli(['world', scenario, '--dir', dir, '--out', out, '--strict']);
  assert.equal(strict.code, 3, strict.stderr);
  assert.match(strict.stderr, /not reproduced by prism, wiremock/);
  assert.match(strict.stderr, /prism: streams/);
  assert.ok(!existsSync(out), 'a failing --strict must not write the generated tree');

  const plain = cli(['world', scenario, '--dir', dir]);
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
  const { dir } = fixtureCopy();
  const r = cli(['doctor', '--dir', dir]);
  const all = r.stdout + r.stderr;
  assert.match(all, /capacidades × prism: writes/, all);
  assert.match(all, /capacidades × wiremock: rpc/, all);
});
