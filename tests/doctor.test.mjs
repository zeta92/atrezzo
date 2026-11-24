// doctor: a path parameter that binds to a field with a single value cannot select one row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { doctor } from '../scripts/lib/doctor.mjs';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { EXIT } from '../scripts/lib/errors.mjs';
import { cli, tmpProject } from './helpers.mjs';

const project = (scenario) => tmpProject({
  'atrezzo.config.json': JSON.stringify({ runtime: 'msw' }),
  'atrezzo/scenarios/s.yaml': scenario
});

test('doctor: a path parameter bound to a single-valued field warns that it cannot select a row', () => {
  const dir = project(`name: slugs
seed: 1
world:
  articles:
    total: 23
    fields: { slug: [how-to-train-your-dragon], title: string }
endpoints:
  - path: /api/articles/:slug
    entity: articles
`);
  const { checks } = doctor(dir);
  const w = checks.find((c) => /binds ":slug" to "slug" with a single value across 23 rows/.test(c.label));
  assert.ok(w, `warning present in: ${checks.map((c) => c.label).join(' | ')}`);
  assert.equal(w.level, 'warn');
  assert.match(w.detail, /values:/);
});

test('doctor: a field with distinct values is not a warning', () => {
  const dir = project(`name: slugs-distintos
seed: 1
world:
  articles:
    total: 23
    fields: { slug: uuid, title: string }
endpoints:
  - path: /api/articles/:slug
    entity: articles
`);
  const { checks } = doctor(dir);
  assert.ok(!checks.some((c) => /single value across/.test(c.label)), 'no false positive with uuid');
});

test('doctor: a parameter mapped to no field is ignored by this check', () => {
  const dir = project(`name: suelto
seed: 1
world:
  articles:
    total: 5
    fields: { slug: [solo], title: string }
endpoints:
  - path: /api/articles/any/:id
    entity: articles
    filters: { ":id": null }
`);
  const { checks } = doctor(dir);
  assert.ok(!checks.some((c) => /single value across/.test(c.label)));
});

test('doctor --scenarios and --fixtures: validates effective paths, explicit precedence, project config vs sibling distinction, and missing paths', () => {
  const orderScenario = `name: order
seed: 1
endpoints:
  - path: /api/order
    passthrough:
      fixture: order
      patch:
        status: confirmed
`;
  const validFixture = JSON.stringify({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: { id: 'ord-1', status: 'pending' },
  }, null, 2);
  // Missing `status` key: fails patch validation if loaded by mistake!
  const decoyFixture = JSON.stringify({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: { id: 'decoy-only' },
  }, null, 2);

  const root = tmpProject({
    // Project uses custom-fixtures; sibling atrezzo/fixtures holds a decoy that would fail patch validation
    'project/atrezzo.config.json': JSON.stringify({
      ...DEFAULT_CONFIG,
      runtime: 'builtin',
      fixturesDir: 'custom-fixtures',
    }, null, 2),
    'project/atrezzo/scenarios/order.yaml': orderScenario,
    'project/custom-fixtures/order.json': validFixture,
    'project/atrezzo/fixtures/order.json': decoyFixture,

    // External bundle with sibling fixtures/ (and project/custom-fixtures is unrelated)
    'bundle/scenarios/order.yaml': orderScenario,
    'bundle/fixtures/order.json': validFixture,

    // External bundle whose sibling fixture is a decoy, overridden via --fixtures
    'override-bundle/scenarios/order.yaml': orderScenario,
    'override-bundle/fixtures/order.json': decoyFixture,
    'explicit-fixtures/order.json': validFixture,

    // External bundle with missing fixture (must fail against bundle/fixtures, not project/custom-fixtures)
    'broken-bundle/scenarios/order.yaml': orderScenario,

    // External bundle with bundle-local config fixturesDir (must beat bundle sibling fixtures/)
    'configured-bundle/atrezzo.config.json': JSON.stringify({
      ...DEFAULT_CONFIG,
      runtime: 'builtin',
      scenariosDir: 'scenarios',
      fixturesDir: 'bundle-custom',
    }, null, 2),
    'configured-bundle/scenarios/order.yaml': orderScenario,
    'configured-bundle/bundle-custom/order.json': validFixture,
    'configured-bundle/fixtures/order.json': decoyFixture,

    // Project whose configured fixturesDir is missing the fixture while sibling atrezzo/fixtures has a valid one
    'project-missing-cfg-fix/atrezzo.config.json': JSON.stringify({
      ...DEFAULT_CONFIG,
      runtime: 'builtin',
      fixturesDir: 'custom-fixtures',
    }, null, 2),
    'project-missing-cfg-fix/atrezzo/scenarios/order.yaml': orderScenario,
    'project-missing-cfg-fix/atrezzo/fixtures/order.json': validFixture,

    // Directory without atrezzo.config.json
    'bare/package.json': '{}',
  });

  // 1) Project without overrides preserves project config fixturesDir (NOT sibling project/atrezzo/fixtures)
  const projDoc = cli(['doctor', '--dir', 'project'], root);
  assert.equal(projDoc.code, EXIT.OK, projDoc.stdout + projDoc.stderr);
  assert.match(projDoc.stdout, /scenarios: .*project\/atrezzo\/scenarios/);
  assert.match(projDoc.stdout, /fixtures: .*project\/custom-fixtures/);

  // 1b) Project config fixturesDir missing fixture fails against custom-fixtures (never falls back to sibling atrezzo/fixtures)
  const projMissingCfgFix = cli(['doctor', '--dir', 'project-missing-cfg-fix'], root);
  assert.equal(projMissingCfgFix.code, EXIT.INVALID);
  assert.match(projMissingCfgFix.stdout, /project-missing-cfg-fix\/custom-fixtures\/order\.json/);

  // 2) doctor --dir project --scenarios bundle/scenarios validates bundle-local fixtures
  const bundleDoc = cli(['doctor', '--dir', 'project', '--scenarios', 'bundle/scenarios'], root);
  assert.equal(bundleDoc.code, EXIT.OK, bundleDoc.stdout + bundleDoc.stderr);
  assert.match(bundleDoc.stdout, /scenarios: .*bundle\/scenarios/);
  assert.match(bundleDoc.stdout, /fixtures: .*bundle\/fixtures/);

  // 2b) doctor --dir project --scenarios configured-bundle/scenarios honours bundle-local config fixturesDir
  const cfgBundleDoc = cli(['doctor', '--dir', 'project', '--scenarios', 'configured-bundle/scenarios'], root);
  assert.equal(cfgBundleDoc.code, EXIT.OK, cfgBundleDoc.stdout + cfgBundleDoc.stderr);
  assert.match(cfgBundleDoc.stdout, /fixtures: .*configured-bundle\/bundle-custom/);

  // 3) doctor --dir project --scenarios override-bundle/scenarios --fixtures explicit-fixtures: explicit --fixtures wins
  const overrideDoc = cli(['doctor', '--dir', 'project', '--scenarios', 'override-bundle/scenarios', '--fixtures', 'explicit-fixtures'], root);
  assert.equal(overrideDoc.code, EXIT.OK, overrideDoc.stdout + overrideDoc.stderr);
  assert.match(overrideDoc.stdout, /fixtures: .*explicit-fixtures/);

  // 4) doctor --dir project --scenarios broken-bundle/scenarios fails naming broken-bundle/atrezzo/fixtures/order.json
  const brokenDoc = cli(['doctor', '--dir', 'project', '--scenarios', 'broken-bundle/scenarios'], root);
  assert.equal(brokenDoc.code, EXIT.INVALID);
  assert.match(brokenDoc.stdout, /ERROR scenario order\.yaml invalid/);
  assert.match(brokenDoc.stdout, /broken-bundle\/atrezzo\/fixtures\/order\.json/);
  assert.doesNotMatch(brokenDoc.stdout, /custom-fixtures/);

  // 5) Missing --scenarios path is reported clearly (exit 3)
  const missingScenarios = cli(['doctor', '--dir', 'project', '--scenarios', 'no-such-scenarios'], root);
  assert.equal(missingScenarios.code, EXIT.INVALID);
  assert.match(missingScenarios.stdout, /ERROR.*scenarios directory is missing.*no-such-scenarios/);

  // 6) Missing --fixtures path is reported clearly (exit 3)
  const missingFixtures = cli(['doctor', '--dir', 'project', '--fixtures', 'no-such-fixtures'], root);
  assert.equal(missingFixtures.code, EXIT.INVALID);
  assert.match(missingFixtures.stdout, /ERROR.*fixtures directory is missing.*no-such-fixtures/);

  // 7) Works with --scenarios even when --dir has no atrezzo.config.json
  const bareDoc = cli(['doctor', '--dir', 'bare', '--scenarios', 'bundle/scenarios'], root);
  assert.equal(bareDoc.code, EXIT.OK, bareDoc.stdout + bareDoc.stderr);
  assert.match(bareDoc.stdout, /scenarios: .*bundle\/scenarios/);
  assert.match(bareDoc.stdout, /fixtures: .*bundle\/fixtures/);
  assert.match(bareDoc.stdout, /scenario order\.yaml/);

  // 8) Programmatic doctor() API supports { scenariosDir, fixturesDir }
  const apiRes = doctor(join(root, 'project'), {
    scenariosDir: join(root, 'override-bundle/scenarios'),
    fixturesDir: join(root, 'explicit-fixtures'),
  });
  assert.equal(apiRes.ok, true);
  assert.ok(apiRes.checks.some((c) => /explicit-fixtures/.test(c.label)));
});

const plainScenario = `name: plain
seed: 1
world:
  items:
    total: 3
    fields: { title: string }
endpoints:
  - path: /api/items
    entity: items
`;

test('doctor --fixtures without atrezzo.config.json still resolves the default scenarios dir and validates its scenarios', () => {
  const root = tmpProject({
    'atrezzo/scenarios/plain.yaml': plainScenario,
    'custom-fixtures/.keep': '',
  });

  const res = cli(['doctor', '--dir', '.', '--fixtures', 'custom-fixtures'], root);
  assert.equal(res.code, EXIT.OK, res.stdout + res.stderr);
  assert.match(res.stdout, /scenarios: .*atrezzo\/scenarios/);
  assert.match(res.stdout, /fixtures: .*custom-fixtures/);
  assert.match(res.stdout, /scenario plain\.yaml/);
  assert.doesNotMatch(res.stdout, /scenario plain\.yaml invalid/);
  assert.doesNotMatch(res.stdout, /no scenarios in/);
});

test('doctor: a configured fixturesDir that does not exist is reported even when no scenario consumes fixtures', () => {
  const root = tmpProject({
    'atrezzo.config.json': JSON.stringify({
      ...DEFAULT_CONFIG,
      runtime: 'builtin',
      fixturesDir: 'missing-fixtures',
    }, null, 2),
    'atrezzo/scenarios/plain.yaml': plainScenario,
  });

  const res = cli(['doctor', '--dir', '.'], root);
  // At least a WARN; exit code is intentionally not asserted (it may stay 0).
  assert.match(res.stdout, /(WARN|ERROR).*fixtures directory is missing.*missing-fixtures/);
  assert.match(res.stdout, /scenario plain\.yaml/);
  assert.doesNotMatch(res.stdout, /scenario plain\.yaml invalid/);
});

test('doctor: the default fixturesDir missing is not warned about when no scenario uses passthrough', () => {
  const root = tmpProject({
    'atrezzo.config.json': JSON.stringify({
      ...DEFAULT_CONFIG,
      runtime: 'builtin',
      fixturesDir: 'atrezzo/fixtures',
    }, null, 2),
    'atrezzo/scenarios/plain.yaml': plainScenario,
  });

  const res = cli(['doctor', '--dir', '.'], root);
  // The fixtures path diagnostic may be omitted entirely; it just must not be a WARN/ERROR.
  assert.doesNotMatch(res.stdout, /(WARN|ERROR).*fixtures directory is missing/);
  assert.match(res.stdout, /scenario plain\.yaml/);
  assert.doesNotMatch(res.stdout, /scenario plain\.yaml invalid/);
});
