// Issue #42: body-conditioned write branches (`writes["METHOD /path"].cases`).
// Covers validation, compatibility/hash stability, engine semantics (exact JSON,
// any-of, first-match, fallback, no-match 422 without body echo, no-mutation,
// branch-specific path-param binding), builtin <-> MSW parity, CLI banners,
// and runtime capability/degradation reporting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { normalizeScenario, loadScenario } from '../scripts/lib/scenario.mjs';
import { generateWorld, scenarioHash, checkIntegrity } from '../scripts/lib/world.mjs';
import { createEngine } from '../scripts/lib/contract.mjs';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { AtrezzoError } from '../scripts/lib/errors.mjs';
import { degradations, stateOf, usedCapabilities } from '../scripts/lib/capabilities.mjs';
import { tmpProject, cli } from './helpers.mjs';
import { request } from './helpers/http.mjs';
import { startServe } from './helpers/serve.mjs';

const MSW_STUB = `
const handler = (method) => (path, resolver) => ({ method, path, resolver });
export const http = {
  get: handler('GET'), head: handler('HEAD'), all: handler('ALL'),
  post: handler('POST'), patch: handler('PATCH'), delete: handler('DELETE'),
  put: handler('PUT'), options: handler('OPTIONS'),
};
export const HttpResponse = Object.assign(
  function HttpResponse(body, init) { return { body, ...init }; },
  { json: (body, init) => ({ body, ...init }) },
);
export const delay = async () => {};
`;

function parseScenario(yaml, file = 'cases.yaml') {
  return normalizeScenario(parseYaml(yaml, file), file);
}

function parseErr(writesBlock, { extraWorld = '', extraEndpoints = '', extraRoot = '' } = {}) {
  const yaml = `name: bad-write-cases
seed: 1
${extraRoot}world:
  customers:
    total: 2
    fields: { name: string, email: email }
  orders:
    total: 3
    ref: customers
    fields: { reference: string, status: [open, closed] }
  products:
    total: 2
    fields: { name: string, sku: string }
${extraWorld}endpoints:
  - path: /api/customers
    entity: customers
  - path: /api/orders
    entity: orders
${extraEndpoints}writes:
${writesBlock}`;
  try {
    parseScenario(yaml, 'bad-write-cases.yaml');
  } catch (e) {
    assert.ok(e instanceof AtrezzoError, `expected AtrezzoError, got ${e}`);
    assert.equal(e.exitCode, 3);
    return e.message;
  }
  assert.fail(`expected scenario validation error for:\n${writesBlock}`);
}

// ---------- 1. Validation ----------

test('write cases validation: rejects empty/non-list cases, unknown keys, missing/invalid when, incomplete expect, and missing/inferred mutate', () => {
  // cases must be a non-empty list
  assert.match(parseErr('  "POST /api/customers":\n    cases: []\n'), /cases": must be a non-empty list/);
  assert.match(parseErr('  "POST /api/customers":\n    cases: {}\n'), /cases": must be a non-empty list/);
  assert.match(parseErr('  "POST /api/customers":\n    cases: "nope"\n'), /cases": must be a non-empty list/);

  // case entry must be a map with allowed keys only
  assert.match(parseErr('  "POST /api/customers":\n    cases:\n      - "bad"\n'), /cases\[0\]": must be a map/);
  assert.match(
    parseErr(`  "POST /api/customers":
    cases:
      - when: { email: "taken@example.com" }
        expect: { status: 409 }
        mutate: false
        bogus: 1
`),
    /cases\[0\]\.bogus": unknown field/,
  );

  // when must be a non-empty map; empty list any-of is rejected
  assert.match(
    parseErr(`  "POST /api/customers":
    cases:
      - expect: { status: 409 }
        mutate: false
`),
    /cases\[0\]\.when": required; must be a non-empty map/,
  );
  assert.match(
    parseErr(`  "POST /api/customers":
    cases:
      - when: {}
        expect: { status: 409 }
        mutate: false
`),
    /cases\[0\]\.when": required; must be a non-empty map/,
  );
  assert.match(
    parseErr(`  "POST /api/customers":
    cases:
      - when: { email: [] }
        expect: { status: 409 }
        mutate: false
`),
    /cases\[0\]\.when\.email": must be a JSON value or a non-empty list/,
  );

  // expect must be present and complete (status required — never defaulted or inherited)
  assert.match(
    parseErr(`  "POST /api/customers":
    expect: { status: 201, echo: true }
    cases:
      - when: { email: "taken@example.com" }
        mutate: false
`),
    /cases\[0\]\.expect": required; must be a map/,
  );
  assert.match(
    parseErr(`  "POST /api/customers":
    expect: { status: 201, echo: true }
    cases:
      - when: { email: "taken@example.com" }
        expect: { body: { error: "taken" } }
        mutate: false
`),
    /cases\[0\]\.expect\.status": required; must be an integer HTTP status between 200 and 599/,
  );
  assert.match(
    parseErr(`  "POST /api/customers":
    cases:
      - when: { email: "taken@example.com" }
        expect: { status: 204, body: { ok: true } }
        mutate: false
`),
    /cases\[0\]\.expect": status 204 cannot have a response body/,
  );
  assert.match(
    parseErr(`  "POST /api/customers":
    cases:
      - when: { email: "taken@example.com" }
        expect: { status: 200, echo: true, body: { ok: true } }
        mutate: false
`),
    /cases\[0\]\.expect": use "echo: true" or "body", not both/,
  );

  // mutate is REQUIRED inside every case (map or false); never inferred even on contract route POST /api/customers
  assert.match(
    parseErr(`  "POST /api/customers":
    cases:
      - when: { email: "taken@example.com" }
        expect: { status: 409, body: { error: "taken" } }
`),
    /cases\[0\]\.mutate": required; must be a map \{ entity, action, set, where \} or false/,
  );
  assert.match(
    parseErr(`  "POST /api/customers":
    cases:
      - when: { email: "taken@example.com" }
        expect: { status: 409 }
        mutate: true
`),
    /cases\[0\]\.mutate": must be a map \{ entity, action, set, where \} or false/,
  );
  assert.match(
    parseErr(`  "POST /api/customers":
    cases:
      - when: { email: "taken@example.com" }
        expect: { status: 201, echo: true }
        mutate: { entity: ghosts }
`),
    /cases\[0\]\.mutate\.entity": "ghosts" is not declared in world/,
  );
  assert.match(
    parseErr(`  "POST /api/customers":
    cases:
      - when: { email: "ok@example.com" }
        expect: { status: 201, echo: true }
        mutate: { entity: customers, set: { missing_col: "x" } }
`),
    /cases\[0\]\.mutate\.set\.missing_col": field "missing_col" does not exist in "customers"/,
  );
});

test('write cases validation: rejects duplicate predicates and statically unreachable shadowed cases, allows reachable overlaps', () => {
  // Exact duplicate predicate
  assert.match(
    parseErr(`  "POST /api/customers":
    cases:
      - when: { email: "taken@example.com" }
        expect: { status: 409, body: { error: "first" } }
        mutate: false
      - when: { email: "taken@example.com" }
        expect: { status: 422, body: { error: "second" } }
        mutate: false
`),
    /cases\[1\]\.when": duplicate "when" predicate \(already declared in cases\[0\]\)/,
  );

  // Duplicate with reversed key order / single-element list equivalence
  assert.match(
    parseErr(`  "POST /api/customers":
    cases:
      - when: { a: 1, b: "x" }
        expect: { status: 409 }
        mutate: false
      - when: { b: ["x"], a: 1 }
        expect: { status: 422 }
        mutate: false
`),
    /cases\[1\]\.when": duplicate "when" predicate \(already declared in cases\[0\]\)/,
  );

  // Broader predicate before narrower predicate -> unreachable
  assert.match(
    parseErr(`  "POST /api/customers":
    cases:
      - when: { role: "admin" }
        expect: { status: 403 }
        mutate: false
      - when: { role: "admin", tier: "pro" }
        expect: { status: 201, echo: true }
        mutate: { entity: customers }
`),
    /cases\[1\]\.when": unreachable case: already matched by cases\[0\]\.when/,
  );

  // Any-of list before an element already covered by that list -> unreachable
  assert.match(
    parseErr(`  "POST /api/customers":
    cases:
      - when: { email: ["a@x.com", "b@x.com"] }
        expect: { status: 409 }
        mutate: false
      - when: { email: "b@x.com" }
        expect: { status: 422 }
        mutate: false
`),
    /cases\[1\]\.when": unreachable case: already matched by cases\[0\]\.when/,
  );

  // Reachable overlaps ARE valid: narrower before broader, partially overlapping lists, distinct keys
  const ok = parseScenario(`name: valid-overlaps
seed: 1
world:
  customers: 2
endpoints:
  - path: /api/customers
    entity: customers
writes:
  "POST /api/customers":
    cases:
      - when: { role: "admin", tier: "pro" }
        expect: { status: 201, body: { branch: "admin-pro" } }
        mutate: false
      - when: { role: "admin" }
        expect: { status: 403, body: { branch: "admin-other" } }
        mutate: false
      - when: { code: ["A", "B"] }
        expect: { status: 409, body: { branch: "ab" } }
        mutate: false
      - when: { code: ["B", "C"] }
        expect: { status: 422, body: { branch: "bc" } }
        mutate: false
`);
  assert.equal(ok.writes[0].cases.length, 4);
});

test('write cases validation: branch-specific path-param binding validation', () => {
  // Stateless branch (`mutate: false`) does NOT require `:ghost_id` to bind;
  // mutating branch targeting `products` DOES fail when `:customer_id` cannot bind to `products`!
  assert.match(
    parseErr(`  "POST /api/customers/:customer_id/orders":
    cases:
      - when: { reject: true }
        expect: { status: 403, body: { error: "nope" } }
        mutate: false
      - when: { create_order: true }
        expect: { status: 201, echo: true }
        mutate: { entity: orders }
      - when: { touch_product: true }
        expect: { status: 200, echo: true }
        mutate: { entity: products, action: update }
`),
    /cases\[2\]": parameter ":customer_id" does not match any field of "products"/,
  );

  // Valid route where one case is stateless, one mutates orders (:customer_id -> customer_id),
  // and one mutates customers (:customer_id -> id)!
  const ok = parseScenario(`name: branch-params
seed: 1
world:
  customers:
    total: 2
    fields: { name: string, email: email }
  orders:
    total: 3
    ref: customers
    fields: { reference: string, status: [open, closed] }
endpoints:
  - path: /api/customers
    entity: customers
  - path: /api/orders
    entity: orders
writes:
  "POST /api/customers/:customer_id/orders":
    cases:
      - when: { mode: "dry_run" }
        expect: { status: 200, body: { dryRun: true } }
        mutate: false
      - when: { mode: "create_order" }
        expect: { status: 201, echo: true }
        mutate: { entity: orders, action: create, set: { status: "open" } }
      - when: { mode: "rename_customer" }
        expect: { status: 200, echo: true }
        mutate: { entity: customers, action: update }
`);
  const w = ok.writes[0];
  assert.equal(w.cases[0].params, undefined);
  assert.deepEqual(w.cases[1].params, [{ name: 'customer_id', field: 'customer_id' }]);
  assert.deepEqual(w.cases[2].params, [{ name: 'customer_id', field: 'id' }]);
});

// ---------- 2. Compatibility & Hash Preservation ----------

test('write cases compatibility: scenarios without cases keep exact normalized form and hash', () => {
  const plainYaml = `name: compat-check
seed: 42
now: 2025-03-01T09:00:00Z
world:
  users:
    total: 3
    fields: { name: string, email: email }
endpoints:
  - path: /api/users
    entity: users
writes:
  "POST /api/users":
    expect: { status: 201, echo: true }
  "DELETE /api/users/:id":
    expect: { status: 204 }
`;
  const norm = parseScenario(plainYaml, 'compat.yaml');
  assert.equal(Object.hasOwn(norm.writes[0], 'cases'), false);
  assert.equal(Object.hasOwn(norm.writes[1], 'cases'), false);
  // Exact expected normalized shape & hash stability
  assert.deepEqual(norm.writes[0], {
    method: 'POST',
    path: '/api/users',
    expect: { status: 201, echo: true },
    mutate: { entity: 'users', action: 'create' },
    inferred: '/api/users',
  });
  const ds1 = generateWorld(norm);
  const ds2 = generateWorld(parseScenario(plainYaml, 'compat.yaml'));
  assert.equal(ds1.hash, ds2.hash);
  assert.equal(scenarioHash(norm), ds1.hash);

  // Adding cases changes the hash; cases-only on a contract endpoint does NOT infer rule-level fallback mutate
  const withCasesYaml = `name: compat-check
seed: 42
now: 2025-03-01T09:00:00Z
world:
  users:
    total: 3
    fields: { name: string, email: email }
endpoints:
  - path: /api/users
    entity: users
writes:
  "POST /api/users":
    cases:
      - when: { email: "taken@example.com" }
        expect: { status: 409, body: { error: "taken" } }
        mutate: false
  "DELETE /api/users/:id":
    expect: { status: 204 }
`;
  const normCases = parseScenario(withCasesYaml, 'compat-cases.yaml');
  assert.notEqual(scenarioHash(normCases), scenarioHash(norm));
  assert.equal(normCases.writes[0].expect, undefined);
  assert.equal(normCases.writes[0].mutate, undefined);
  assert.equal(normCases.writes[0].inferred, undefined);
});

// ---------- 3. Engine Behavior ----------

const ENGINE_SCENARIO = `name: reg-cases
seed: 19
now: 2025-03-01T09:00:00Z
world:
  customers:
    total: 2
    fields: { name: string, email: email, role: [member, admin] }
  orders:
    total: 3
    ref: customers
    fields: { reference: string, status: [open, closed] }
endpoints:
  - path: /api/customers
    entity: customers
  - path: /api/orders
    entity: orders
writes:
  "POST /api/customers":
    cases:
      - when: { email: ["taken@example.com", "reserved@example.com"] }
        expect: { status: 409, body: { errors: { email: ["has already been taken"] } } }
        mutate: false
      - when: { role: "admin", invite: "VIP" }
        expect: { status: 201, echo: true }
        mutate: { entity: customers, action: create, set: { role: "admin" } }
      - when: { role: "admin" }
        expect: { status: 403, body: { error: "invite required for admin" } }
        mutate: false
      - when: { count: 1, active: true, note: null, meta: { a: 1, b: 2 } }
        expect: { status: 202, echo: true }
        mutate: false
    expect: { status: 201, echo: true }
    mutate: { entity: customers, set: { role: "member" } }
  "POST /api/strict-register":
    cases:
      - when: { email: "taken@example.com" }
        expect: { status: 409, body: { error: "occupied" } }
        mutate: false
      - when: { email: "fresh@example.com" }
        expect: { status: 201, echo: true }
        mutate: { entity: customers, action: create, set: { role: "member" } }
  "POST /api/customers/:customer_id/orders":
    cases:
      - when: { mode: "reject" }
        expect: { status: 403, body: { error: "blocked" } }
        mutate: false
      - when: { mode: "create_order" }
        expect: { status: 201, echo: true }
        mutate: { entity: orders, action: create, set: { status: "open" } }
      - when: { mode: "rename_customer" }
        expect: { status: 200, echo: true }
        mutate: { entity: customers, action: update }
`;

test('write cases engine: exact JSON equality, any-of, first-match, fallback, and error case no-mutation', () => {
  const ds = generateWorld(parseScenario(ENGINE_SCENARIO, 'reg.yaml'));
  const eng = createEngine(ds);
  const snapshot = () => JSON.stringify(eng.dataset.entities);
  const initial = snapshot();

  // 1. Any-of list match on error case (`mutate: false`): returns 409 and does NOT mutate world or ID counter
  for (const email of ['taken@example.com', 'reserved@example.com']) {
    const r = eng.handle({ method: 'POST', pathname: '/api/customers', body: { name: 'Dup', email, password: 'secret' } });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { errors: { email: ['has already been taken'] } });
    assert.equal(snapshot(), initial, 'error case must not mutate world');
  }

  // 2. First-match: { role: "admin", invite: "VIP" } matches case[1] (creates admin with id 3), NOT case[2]
  const vip = eng.handle({
    method: 'POST',
    pathname: '/api/customers',
    body: { name: 'Root', email: 'root@example.com', role: 'admin', invite: 'VIP' },
  });
  assert.equal(vip.status, 201);
  assert.equal(vip.body.id, 3, 'ID counter was not incremented by earlier 409 error cases');
  assert.equal(vip.body.role, 'admin');
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/customers/3' }).body.email, 'root@example.com');

  // 3. Second overlapping case: { role: "admin" } without invite: "VIP" matches case[2] (403, no mutation)
  const before403 = snapshot();
  const nonVip = eng.handle({
    method: 'POST',
    pathname: '/api/customers',
    body: { name: 'Nope', email: 'nope@example.com', role: 'admin' },
  });
  assert.equal(nonVip.status, 403);
  assert.deepEqual(nonVip.body, { error: 'invite required for admin' });
  assert.equal(snapshot(), before403);

  // 4. Exact JSON equality (nested object key-order independent, strict types, explicit null vs missing key)
  const exactOk = eng.handle({
    method: 'POST',
    pathname: '/api/customers',
    body: { meta: { b: 2, a: 1 }, note: null, active: true, count: 1, extra: 'ignored' },
  });
  assert.equal(exactOk.status, 202);
  assert.deepEqual(exactOk.body, { active: true, count: 1, extra: 'ignored', meta: { a: 1, b: 2 }, note: null });

  // Type mismatches & missing null key must NOT match case[3] -> fall through to fallback (201, creates member)
  for (const badBody of [
    { count: '1', active: true, note: null, meta: { a: 1, b: 2 }, name: 'StrCount', email: 's1@example.com' },
    { count: 1, active: 'true', note: null, meta: { a: 1, b: 2 }, name: 'StrBool', email: 's2@example.com' },
    { count: 1, active: true, meta: { a: 1, b: 2 }, name: 'MissingNote', email: 's3@example.com' },
    { count: 1, active: true, note: 'null', meta: { a: 1, b: 2 }, name: 'StrNull', email: 's4@example.com' },
    { count: 1, active: true, note: null, meta: { a: 1, b: 2, c: 3 }, name: 'ExtraNested', email: 's5@example.com' },
  ]) {
    const fb = eng.handle({ method: 'POST', pathname: '/api/customers', body: badBody });
    assert.equal(fb.status, 201, `expected fallback 201 for ${JSON.stringify(badBody)}`);
    assert.equal(fb.body.role, 'member');
    assert.equal(fb.body.email, badBody.email);
  }

  assert.deepEqual(checkIntegrity({ ...eng.dataset, entities: eng.dataset.entities }), []);

  // reset restores exact initial state
  eng.reset();
  assert.equal(snapshot(), initial);
});

test('write cases engine: no-match without fallback returns deterministic 422 without echoing request body and mutates nothing', () => {
  const ds = generateWorld(parseScenario(ENGINE_SCENARIO, 'reg.yaml'));
  const eng = createEngine(ds);
  const initial = JSON.stringify(eng.dataset.entities);

  const secretBody1 = { email: 'unknown@example.com', password: 'super-secret-password-999', token: 'tok_live_abc' };
  const secretBody2 = { completely: 'different', payload: 12345 };

  const r1 = eng.handle({ method: 'POST', pathname: '/api/strict-register', body: secretBody1 });
  const r2 = eng.handle({ method: 'POST', pathname: '/api/strict-register', body: secretBody2 });
  const r3 = eng.handle({ method: 'POST', pathname: '/api/strict-register', body: {} });

  for (const [label, r] of [['secret1', r1], ['secret2', r2], ['empty', r3]]) {
    assert.equal(r.status, 422, `${label}: status`);
    const serialized = JSON.stringify(r.body);
    assert.equal(serialized.includes('unknown@example.com'), false, `${label}: must not echo email`);
    assert.equal(serialized.includes('super-secret-password-999'), false, `${label}: must not echo password`);
    assert.equal(serialized.includes('tok_live_abc'), false, `${label}: must not echo token`);
    assert.equal(serialized.includes('completely'), false, `${label}: must not echo request keys`);
    assert.match(r.body.error, /POST \/api\/strict-register/);
    assert.match(r.body.error, /did not match any declared case/);
    assert.equal(r.body.atrezzo?.unmatchedCase, true);
    assert.equal(r.body.atrezzo?.cases, 2);
  }

  // Byte-for-byte deterministic across distinct unmatched payloads
  assert.equal(JSON.stringify(r1.body), JSON.stringify(r2.body));
  assert.equal(JSON.stringify(r1.body), JSON.stringify(r3.body));
  // World completely untouched
  assert.equal(JSON.stringify(eng.dataset.entities), initial);

  // Matching mutating case works right after unmatched 422s with unchanged next ID (3)
  const ok = eng.handle({ method: 'POST', pathname: '/api/strict-register', body: { name: 'Fresh', email: 'fresh@example.com' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.id, 3);
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/customers/3' }).body.name, 'Fresh');

  // Non-object JSON body still returns 400
  const arr = eng.handle({ method: 'POST', pathname: '/api/strict-register', body: [1, 2] });
  assert.equal(arr.status, 400);
});

test('write cases engine: raw body matched before mutate.set, inferred fallback, mutate: false fallback, and DELETE 204 case', () => {
  const ds = generateWorld(parseScenario(`name: fallback-variants
seed: 7
world:
  customers:
    total: 2
    fields: { name: string, email: email, role: [member, admin] }
endpoints:
  - path: /api/customers
    entity: customers
writes:
  "POST /api/customers":
    cases:
      - when: { role: "admin" }
        expect: { status: 201, echo: true }
        mutate: { entity: customers, action: create, set: { role: "member" } }
    expect: { status: 201, echo: true }
  "DELETE /api/customers/:id":
    cases:
      - when: { force: false }
        expect: { status: 409, body: { error: "confirmation required" } }
        mutate: false
      - when: { force: true }
        expect: { status: 204 }
        mutate: { entity: customers, action: delete }
  "POST /api/audit":
    cases:
      - when: { dry: true }
        expect: { status: 200, body: { dry: true } }
        mutate: false
    expect: { status: 202, body: { queued: true } }
    mutate: false
`, 'fv.yaml'));
  // Rule-level fallback inferred on POST /api/customers; case[0] did not infer
  assert.equal(ds.writes[0].inferred, '/api/customers');
  assert.deepEqual(ds.writes[0].mutate, { entity: 'customers', action: 'create' });

  const eng = createEngine(ds);
  // Raw body has role: "admin" -> matches case[0], even though mutate.set overrides stored role to "member"
  const c1 = eng.handle({ method: 'POST', pathname: '/api/customers', body: { name: 'Override', email: 'o@x.com', role: 'admin' } });
  assert.equal(c1.status, 201);
  assert.equal(c1.body.role, 'member');

  // Unmatched POST -> inferred fallback creates row
  const c2 = eng.handle({ method: 'POST', pathname: '/api/customers', body: { name: 'Normal', email: 'n@x.com', role: 'member' } });
  assert.equal(c2.status, 201);
  assert.equal(c2.body.id, 4);

  // DELETE with force: false -> 409 and row remains
  assert.equal(eng.handle({ method: 'DELETE', pathname: '/api/customers/4', body: { force: false } }).status, 409);
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/customers/4' }).status, 200);
  // DELETE with force: true -> 204 null body and row removed
  const delOk = eng.handle({ method: 'DELETE', pathname: '/api/customers/4', body: { force: true } });
  assert.equal(delOk.status, 204);
  assert.equal(delOk.body, null);
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/customers/4' }).status, 404);

  // Stateless mutate: false fallback
  const fb = eng.handle({ method: 'POST', pathname: '/api/audit', body: { dry: false } });
  assert.equal(fb.status, 202);
  assert.deepEqual(fb.body, { queued: true });
});

test('write cases engine: branch-specific path-param binding executes distinct targets on one route', () => {
  const ds = generateWorld(parseScenario(ENGINE_SCENARIO, 'reg.yaml'));
  const eng = createEngine(ds);
  const initial = JSON.stringify(eng.dataset.entities);

  // Stateless branch
  const blocked = eng.handle({ method: 'POST', pathname: '/api/customers/1/orders', body: { mode: 'reject' } });
  assert.equal(blocked.status, 403);
  assert.equal(JSON.stringify(eng.dataset.entities), initial);

  // Create order branch (:customer_id -> orders.customer_id)
  const created = eng.handle({ method: 'POST', pathname: '/api/customers/2/orders', body: { mode: 'create_order', reference: 'ORD-NEW' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.customer_id, 2);
  assert.equal(created.body.reference, 'ORD-NEW');
  assert.equal(created.body.status, 'open');

  // Update customer branch (:customer_id -> customers.id)
  const renamed = eng.handle({ method: 'POST', pathname: '/api/customers/2/orders', body: { mode: 'rename_customer', name: 'Renamed Co' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.id, 2);
  assert.equal(renamed.body.name, 'Renamed Co');
  assert.equal(eng.handle({ method: 'GET', pathname: '/api/customers/2' }).body.name, 'Renamed Co');

  // Unmatched body -> 422, no fallback, no mutation
  const beforeUnmatched = JSON.stringify(eng.dataset.entities);
  const unmatched = eng.handle({ method: 'POST', pathname: '/api/customers/2/orders', body: { mode: 'other' } });
  assert.equal(unmatched.status, 422);
  assert.equal(JSON.stringify(eng.dataset.entities), beforeUnmatched);
});

test('write cases engine (#45): branch and fallback expect.headers preserve multi-value Set-Cookie and omit headers on unmatched 422', () => {
  const scenario = normalizeScenario({
    name: 'write-case-headers',
    seed: 1,
    world: {
      customers: { total: 1 },
    },
    endpoints: [
      { path: '/api/customers', entity: 'customers' },
    ],
    writes: {
      'POST /api/login': {
        cases: [
          {
            when: { action: 'login' },
            expect: {
              status: 200,
              body: { ok: true },
              headers: {
                'x-outcome': 'login',
                'set-cookie': ['sid=one; Path=/', 'refresh=two; Path=/'],
              },
            },
            mutate: false,
          },
        ],
        expect: {
          status: 202,
          body: { ok: false },
          headers: {
            'x-outcome': 'fallback',
          },
        },
        mutate: false,
      },
      'POST /api/strict': {
        cases: [
          {
            when: { action: 'ok' },
            expect: {
              status: 200,
              headers: {
                'x-outcome': 'matched',
              },
            },
            mutate: false,
          },
        ],
      },
    },
  }, 'write-case-headers.yaml');

  const eng = createEngine(generateWorld(scenario));

  // Matched case preserves multi-value Set-Cookie and branch x-outcome header
  const matched = eng.handle({ method: 'POST', pathname: '/api/login', body: { action: 'login' } });
  assert.equal(matched.status, 200);
  assert.deepEqual(matched.body, { ok: true });
  assert.equal(matched.headers['x-outcome'], 'login');
  assert.deepEqual(matched.headers['set-cookie'], ['sid=one; Path=/', 'refresh=two; Path=/']);

  // Fallback returns root fallback x-outcome header and no Set-Cookie
  const fallback = eng.handle({ method: 'POST', pathname: '/api/login', body: { action: 'other' } });
  assert.equal(fallback.status, 202);
  assert.deepEqual(fallback.body, { ok: false });
  assert.equal(fallback.headers['x-outcome'], 'fallback');
  assert.equal(fallback.headers['set-cookie'], undefined);
  assert.equal(Object.hasOwn(fallback.headers, 'set-cookie'), false);

  // Unmatched strict route returns 422 without leaking any case x-outcome header
  const unmatched = eng.handle({ method: 'POST', pathname: '/api/strict', body: { action: 'nope' } });
  assert.equal(unmatched.status, 422);
  assert.equal(unmatched.headers['x-outcome'], undefined);
  assert.equal(Object.hasOwn(unmatched.headers, 'x-outcome'), false);
});

// ---------- 4. Builtin (serve) <-> MSW Parity + CLI Banners ----------

test('write cases parity: builtin serve and generated MSW handlers produce identical status, body, mutations, 422 diagnostics, and reset', async () => {
  const dir = tmpProject({
    'atrezzo.config.json': JSON.stringify({
      version: 1, stack: 'other', runtime: 'msw',
      scenariosDir: 'scenarios', handlersDir: 'handlers', generatedDir: '.generated',
    }),
    'scenarios/reg-cases.yaml': ENGINE_SCENARIO,
    'node_modules/msw/package.json': JSON.stringify({ name: 'msw', type: 'module', exports: './index.js' }),
    'node_modules/msw/index.js': MSW_STUB,
  });

  // `atrezzo world` succeeds and prints case summary without crashing on cases-only rules
  const wRes = cli(['world', join(dir, 'scenarios/reg-cases.yaml'), '--dir', dir]);
  assert.equal(wRes.code, 0, wRes.stderr);
  assert.match(wRes.stdout, /POST \/api\/customers/);
  assert.match(wRes.stdout, /POST \/api\/strict-register/);

  const mod = await import(pathToFileURL(join(dir, '.generated/reg-cases.handlers.mjs')).href);
  const handlers = mod.handlers;
  const mock = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'reg-cases' });
  const baseUrl = `http://127.0.0.1:${(await mock.listen(0)).port}`;

  const matches = (pattern, method, pathname) => {
    if (pattern.method !== 'ALL' && pattern.method !== method) return false;
    const p = pattern.path.replace(/^\*/, '').split('/').filter(Boolean);
    const got = pathname.split('/').filter(Boolean);
    if (p.length !== got.length) return false;
    return p.every((seg, i) => (seg.startsWith(':') ? got[i].length > 0 : seg === got[i]));
  };

  async function viaHandlers(method, pathname, { headers = {}, body } = {}) {
    for (const h of handlers) {
      if (!matches(h, method, pathname)) continue;
      const res = await h.resolver({ request: new Request(`http://localhost${pathname}`, { method, headers, body }) });
      if (res) return res;
    }
    return null;
  }

  async function assertParity(method, pathname, body, label) {
    const opts = {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    };
    const served = await request(`${baseUrl}${pathname}`, opts);
    const msw = await viaHandlers(method, pathname, opts);
    assert.ok(msw, `${label}: msw answered`);
    assert.equal(msw.status, served.status, `${label}: status`);
    const servedBody = served.text ? JSON.parse(served.text) : null;
    assert.deepEqual(msw.body, servedBody, `${label}: body`);
    return { status: served.status, body: servedBody };
  }

  try {
    // 1. Error case (409, no mutation)
    const r409 = await assertParity('POST', '/api/customers', { name: 'Dup', email: 'taken@example.com' }, '409 taken');
    assert.equal(r409.status, 409);

    // 2. First-match mutating case (201 admin)
    const rAdmin = await assertParity('POST', '/api/customers', { name: 'Ada', email: 'ada@example.com', role: 'admin', invite: 'VIP' }, '201 vip admin');
    assert.equal(rAdmin.status, 201);
    assert.equal(rAdmin.body.id, 3);
    await assertParity('GET', '/api/customers', undefined, 'GET after admin create');

    // 3. Fallback mutating case (201 member)
    const rFallback = await assertParity('POST', '/api/customers', { name: 'Bob', email: 'bob@example.com' }, '201 fallback');
    assert.equal(rFallback.status, 201);
    assert.equal(rFallback.body.id, 4);
    await assertParity('GET', '/api/customers', undefined, 'GET after fallback create');

    // 4. Unmatched case without fallback (422 diagnostic, no body echo, no mutation)
    const r422 = await assertParity('POST', '/api/strict-register', { email: 'nope@example.com', password: 'secret-value' }, '422 unmatched');
    assert.equal(r422.status, 422);
    assert.equal(JSON.stringify(r422.body).includes('secret-value'), false);

    // 5. Branch-specific parameterized write (create order + update customer)
    const rOrder = await assertParity('POST', '/api/customers/2/orders', { mode: 'create_order', reference: 'ORD-P1' }, '201 param order');
    assert.equal(rOrder.status, 201);
    const rRename = await assertParity('POST', '/api/customers/2/orders', { mode: 'rename_customer', name: 'Parity Co' }, '200 param customer');
    assert.equal(rRename.status, 200);
    await assertParity('GET', '/api/customers/2', undefined, 'GET customer 2 after rename');
    await assertParity('GET', '/api/orders', undefined, 'GET orders after create');

    // 6. Malformed JSON & non-object JSON (400)
    const rBadJson = await assertParity('POST', '/api/strict-register', '{broken', '400 bad json');
    assert.equal(rBadJson.status, 400);
    const rArr = await assertParity('POST', '/api/strict-register', '[1,2]', '400 array');
    assert.equal(rArr.status, 400);

    // 7. Reset restores both builtin serve and MSW handlers to identical initial state
    await request(`${baseUrl}/__atrezzo/reset`, { method: 'POST', body: '' });
    await viaHandlers('POST', '/__atrezzo/reset', { body: '' });
    const afterReset = await assertParity('GET', '/api/customers', undefined, 'GET customers after reset');
    assert.equal(afterReset.body.length, 2);
  } finally {
    await mock.close();
  }
});

test('write cases CLI serve banner prints case count and fallback status cleanly', async () => {
  const dir = tmpProject({
    'atrezzo.config.json': JSON.stringify({
      version: 1, runtime: 'builtin', scenariosDir: 'scenarios', handlersDir: 'handlers', generatedDir: '.generated',
      mock: { baseUrl: 'http://127.0.0.1:4010', port: 4010 }, verify: { driver: 'http' },
    }),
    'scenarios/reg-cases.yaml': ENGINE_SCENARIO,
  });
  const srv = await startServe(dir);
  try {
    const log = srv.log();
    assert.match(log, /POST \/api\/customers {2}\(4 cases · fallback → 201 · create customers\)/);
    assert.match(log, /POST \/api\/strict-register {2}\(2 cases · no fallback → 422\)/);
  } finally {
    srv.stop();
  }
});

// ---------- 5. Capabilities & Non-support / Degradation in Other Runtimes ----------

test('write cases capabilities: builtin and msw are same; supabase, prism, and wiremock accurately report degradation', () => {
  const dir = tmpProject({
    'with-cases.yaml': ENGINE_SCENARIO,
    'plain-write.yaml': `name: plain-write
seed: 1
world:
  customers: 2
endpoints:
  - path: /api/customers
    entity: customers
writes:
  "POST /api/customers":
    expect: { status: 201, echo: true }
`,
  });

  const scCases = loadScenario(join(dir, 'with-cases.yaml'));
  const scPlain = loadScenario(join(dir, 'plain-write.yaml'));

  // Detected only when cases are declared
  assert.ok(usedCapabilities(scCases).some((c) => c.id === 'write-cases'));
  assert.equal(usedCapabilities(scPlain).some((c) => c.id === 'write-cases'), false);

  // Parity in builtin & msw
  assert.equal(stateOf('write-cases', 'builtin'), 'same');
  assert.equal(stateOf('write-cases', 'msw'), 'same');
  assert.deepEqual(degradations(scCases, 'builtin'), []);
  assert.deepEqual(degradations(scCases, 'msw'), []);

  // Honest non-support / degradation in supabase, prism, wiremock
  for (const rt of ['supabase', 'prism', 'wiremock']) {
    const deg = degradations(scCases, rt).find((d) => d.id === 'write-cases');
    assert.ok(deg, `${rt} must report write-cases degradation`);
    assert.equal(deg.state, 'different');
    assert.ok(deg.note && deg.note.length > 10, `${rt} must explain why write-cases is not supported`);
  }

  // `atrezzo world --strict` passes for msw/builtin and fails (exit 3) for prism/wiremock/supabase
  for (const [rt, expectedCode] of [['msw', 0], ['builtin', 0], ['prism', 3], ['wiremock', 3], ['supabase', 3]]) {
    const proj = tmpProject({
      'atrezzo.config.json': JSON.stringify({
        version: 1, stack: 'other', runtime: rt,
        scenariosDir: 'scenarios', handlersDir: 'handlers', generatedDir: '.generated',
      }),
      'scenarios/reg-cases.yaml': ENGINE_SCENARIO,
    });
    const res = cli(['world', join(proj, 'scenarios/reg-cases.yaml'), '--dir', proj, '--strict']);
    assert.equal(res.code, expectedCode, `world --strict for ${rt}: ${res.stderr}`);
    if (expectedCode === 3) assert.match(res.stderr, /write-cases/);
  }
});
