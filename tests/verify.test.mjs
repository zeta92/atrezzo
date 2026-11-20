import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadFlow } from '../scripts/lib/scenario.mjs';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { runVerify, formatReport, diagnose, loadPlaywright, chromeExecutable } from '../scripts/lib/verify.mjs';
import { AtrezzoError } from '../scripts/lib/errors.mjs';
import { ROOT, SCENARIO, FLOW, tmpProject, cliAsync } from './helpers.mjs';

let dir; let mock; let url;
before(async () => {
  dir = tmpProject({
    'scenarios/conciliacion.yaml': SCENARIO,
    'flow.yaml': FLOW,
    'flujo-ko.yaml': FLOW.replace('count: 3\n', 'count: 4\n'),
  });
  mock = createMockServer({ scenariosDir: join(dir, 'scenarios') });
  const addr = await mock.listen(0);
  url = `http://127.0.0.1:${addr.port}`;
});
after(() => mock.close());

test('http driver: passing assertions ⇒ exit 0', async () => {
  const r = await runVerify(loadFlow(join(dir, 'flow.yaml')), { url, driver: 'http' });
  // customer-chip has no data ⇒ N/V; the rest is OK. Give it data for the green case.
  const ok = r.rows.filter((x) => x.status === 'OK');
  assert.equal(ok.length, 2);
  assert.equal(r.rows.find((x) => x.expect.selector === '[data-testid=customer-chip]').status, 'N/V');
  assert.equal(r.exitCode, 2, 'an unverified assertion is never green');
  writeFileSync(join(dir, 'flujo-verde.yaml'), FLOW.replace('        count: 3\n', '        count: 3\n        data: { request: customers }\n'));
  const g = await runVerify(loadFlow(join(dir, 'flujo-verde.yaml')), { url, driver: 'http' });
  assert.equal(g.exitCode, 0);
  assert.ok(g.rows.every((x) => x.status === 'OK'));
  assert.match(formatReport(g), /3 OK · 0 KO · 0 not verified → GREEN/);
});

test('http driver: failing assertion ⇒ exit 1 with expected vs obtained', async () => {
  const flowText = FLOW.replace('        count: 3\n', '        count: 4\n        data: { request: customers }\n');
  writeFileSync(join(dir, 'flujo-ko.yaml'), flowText);
  const r = await runVerify(loadFlow(join(dir, 'flujo-ko.yaml')), { url, driver: 'http', diagnose: true });
  assert.equal(r.exitCode, 1);
  const ko = r.rows.find((x) => x.status === 'KO');
  assert.equal(ko.obtained, 3);
  assert.equal(ko.expect.count, 4);
  assert.ok(ko.hypotheses.some((h) => h.type === 'world-mismatch'));
  assert.match(formatReport(r), /=4\s+3\s+KO/);
});

test('diagnosis: pagination mismatch', async () => {
  writeFileSync(join(dir, 'flujo-pag.yaml'), FLOW.replace('      issues: GET /api/orders?status=issue\n',
    '      issues: GET /api/orders?status=issue\n    expect:\n      - selector: "tr [data-status=issue]"\n        count: 3\n        data: { request: orders, where: { status: issue } }\n'));
  const flow = loadFlow(join(dir, 'flujo-pag.yaml'));
  const r = await runVerify(flow, { url, driver: 'http', diagnose: true });
  const row = r.rows.find((x) => x.expect.selector === 'tr [data-status=issue]');
  const inPage = mock.state.dataset.entities.orders.slice(0, 12).filter((p) => p.status === 'issue').length;
  if (inPage === 3) assert.equal(row.status, 'OK');
  else {
    assert.equal(row.status, 'KO');
    assert.ok(row.hypotheses.some((h) => h.type === 'pagination-mismatch' && h.confidence === 'high'));
  }
});

test('diagnose(): dedupe by id, null field and client-side filter', () => {
  const row = { expect: { selector: 'x', count: 3 } };
  const dup = diagnose(row, { obtained: 2, response: { status: 200, headers: {} }, items: [{ id: 1 }, { id: 1 }, { id: 2 }], matched: 3, domCount: 2 });
  assert.ok(dup.some((h) => h.type === 'dedupe-by-id'));
  const nul = diagnose(row, { obtained: 2, response: { status: 200, headers: {} }, items: [{ id: 1, email: null }, { id: 2, email: 'a' }, { id: 3, email: 'b' }], matched: 3, domCount: 2 });
  assert.ok(nul.some((h) => h.type === 'null-field' && h.confidence === 'high'));
  const cli = diagnose(row, { obtained: 1, response: { status: 200, headers: {} }, items: [{ id: 1 }, { id: 2 }, { id: 3 }], matched: 3, domCount: 1 });
  assert.ok(cli.some((h) => h.type === 'client-side-filter'));
  assert.ok(cli.some((h) => h.type === 'render'));
});

function fakePage(counts) {
  const visited = [];
  return {
    visited,
    factory: async () => ({
      page: {
        goto: async (u) => { visited.push(u); },
        waitForLoadState: async () => {},
        waitForSelector: async () => {},
        locator: (sel) => ({ count: async () => counts[sel] ?? 0 }),
      },
      close: async () => {},
    }),
  };
}

test('playwright driver (fake page): OK when the DOM matches', async () => {
  const fp = fakePage({ '[data-testid=customer-chip]': 3, '[data-testid=order-row]': 12, '[data-testid=badge-issue]': 3 });
  const r = await runVerify(loadFlow(join(dir, 'flow.yaml')), { url, driver: 'playwright', pageFactory: fp.factory });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.rows.map((x) => x.status), ['OK', 'OK', 'OK']);
  assert.deepEqual(fp.visited, [`${url}/`, `${url}/lista`]);
});

test('playwright driver (fake page): KO with client-side filter diagnosis', async () => {
  const fp = fakePage({ '[data-testid=customer-chip]': 3, '[data-testid=order-row]': 9, '[data-testid=badge-issue]': 3 });
  const r = await runVerify(loadFlow(join(dir, 'flow.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  const ko = r.rows.find((x) => x.status === 'KO');
  assert.equal(ko.obtained, 9);
  assert.ok(ko.hypotheses.some((h) => h.type === 'client-side-filter'));
  assert.ok(ko.hypotheses.some((h) => h.type === 'render'));
});

test('CLI verify --driver playwright without playwright installed ⇒ exit 2, never a false OK', async () => {
  const r = await cliAsync(['verify', 'flow.yaml', '--driver', 'playwright', '--url', url], dir);
  assert.equal(r.code, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /playwright.*not installed/);
  assert.doesNotMatch(r.stdout, /GREEN/);
});

test('CLI verify with no mock listening ⇒ exit 2', async () => {
  const r = await cliAsync(['verify', 'flow.yaml', '--url', 'http://127.0.0.1:9'], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /No mock listening/);
});

test('CLI verify --driver http green ⇒ exit 0', async () => {
  const r = await cliAsync(['verify', 'flujo-verde.yaml', '--url', url], dir);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /GREEN/);
});

// ---------- redirects_to / allow_redirect ----------

function fakeRedirectPage({ redirectTo = null, countsByPath = {} } = {}) {
  let current = '';
  return {
    factory: async () => ({
      page: {
        goto: async (u) => {
          current = redirectTo ? new URL(redirectTo, u).toString() : u;
          return { status: () => 200 };
        },
        url: () => current,
        waitForLoadState: async () => {},
        waitForSelector: async () => {},
        locator: (sel) => {
          const path = new URL(current).pathname;
          return { count: async () => countsByPath[path]?.[sel] ?? 0 };
        },
      },
      close: async () => {},
    }),
  };
}

test('loadFlow: validates redirects_to and allow_redirect', () => {
  const okDir = tmpProject({
    'a.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    redirects_to: /login\n    expect: [{ selector: "#login", count: 1 }]\n',
    'b.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    allow_redirect: true\n    expect: [{ selector: "#login", count: 1 }]\n',
  });
  assert.equal(loadFlow(join(okDir, 'a.yaml')).steps[0].redirectsTo, '/login');
  assert.equal(loadFlow(join(okDir, 'b.yaml')).steps[0].allowRedirect, true);

  for (const [yaml, pattern] of [
    ['steps:\n  - screen: a\n    visit: /orders\n    redirects_to: login\n    expect: [{ selector: x, count: 1 }]\n', /redirects_to.*starting with "\/"/],
    ['steps:\n  - screen: a\n    visit: /orders\n    allow_redirect: "yes"\n    expect: [{ selector: x, count: 1 }]\n', /allow_redirect.*true or false/],
    ['steps:\n  - screen: a\n    visit: /orders\n    redirects_to: /login\n    allow_redirect: true\n    expect: [{ selector: x, count: 1 }]\n', /use "redirects_to" or "allow_redirect", not both/],
  ]) {
    const badDir = tmpProject({ 'f.yaml': yaml });
    assert.throws(() => loadFlow(join(badDir, 'f.yaml')), (e) => e instanceof AtrezzoError && e.exitCode === 3 && e.issues.some((l) => pattern.test(l)));
  }
});

test('declared redirect (redirects_to): OK when final URL matches and assertions pass on destination', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: orders
    visit: /orders
    redirects_to: /login
    expect:
      - selector: "#login-form"
        count: 1
      - selector: "[data-testid=order-row]"
        count: 0
`,
  });
  const fp = fakeRedirectPage({
    redirectTo: '/login?next=%2Forders',
    countsByPath: { '/login': { '#login-form': 1, '[data-testid=order-row]': 0 } },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', pageFactory: fp.factory });
  assert.equal(r.exitCode, 0, formatReport(r));
  assert.deepEqual(r.rows.map((x) => x.status), ['OK', 'OK']);
  assert.deepEqual(r.steps, [{ screen: 'orders', visit: '/orders', redirect: { from: '/orders', to: '/login?next=%2Forders', declared: true } }]);

  // Explicit query string in redirects_to must match
  const qDir = tmpProject({
    'q.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    redirects_to: /login?reason=expired\n    expect: [{ selector: "#login-form", count: 1 }]\n',
  });
  const fpMatch = fakeRedirectPage({ redirectTo: '/login?reason=expired', countsByPath: { '/login': { '#login-form': 1 } } });
  const okQ = await runVerify(loadFlow(join(qDir, 'q.yaml')), { url, driver: 'playwright', pageFactory: fpMatch.factory });
  assert.equal(okQ.exitCode, 0);
  const fpMismatch = fakeRedirectPage({ redirectTo: '/login?reason=other', countsByPath: { '/login': { '#login-form': 1 } } });
  const koQ = await runVerify(loadFlow(join(qDir, 'q.yaml')), { url, driver: 'playwright', pageFactory: fpMismatch.factory });
  assert.equal(koQ.exitCode, 1);
  assert.equal(koQ.steps[0].redirect.declared, false);
});

test('declared redirect (allow_redirect: true): OK when redirected or when staying on visit', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    allow_redirect: true\n    expect: [{ selector: "#target", count: 1 }]\n',
  });
  const fpRedir = fakeRedirectPage({ redirectTo: '/login', countsByPath: { '/login': { '#target': 1 } } });
  const r1 = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', pageFactory: fpRedir.factory });
  assert.equal(r1.exitCode, 0);
  assert.deepEqual(r1.steps[0].redirect, { from: '/orders', to: '/login', declared: true });

  const fpSame = fakeRedirectPage({ redirectTo: null, countsByPath: { '/orders': { '#target': 1 } } });
  const r2 = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', pageFactory: fpSame.factory });
  assert.equal(r2.exitCode, 0);
  assert.equal(r2.steps[0].redirect, undefined);
});

test('undeclared redirect: stays KO with current warning', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    expect: [{ selector: "#login-form", count: 1 }]\n',
  });
  const fp = fakeRedirectPage({
    redirectTo: '/login?next=%2Forders',
    countsByPath: { '/login': { '#login-form': 1 } },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.equal(r.rows[0].status, 'KO');
  assert.match(r.rows[0].note, /the app redirected \/orders → \/login\?next=%2Forders.*login screen/);
  assert.equal(r.rows[0].hypotheses[0].type, 'navigation');
  assert.deepEqual(r.steps[0].redirect, { from: '/orders', to: '/login?next=%2Forders', declared: false });
});

test('declared redirect to wrong destination or without redirecting: KO', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    redirects_to: /login\n    expect: [{ selector: "#login-form", count: 1 }]\n',
  });
  const fpWrong = fakeRedirectPage({ redirectTo: '/dashboard', countsByPath: { '/dashboard': { '#login-form': 1 } } });
  const rWrong = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fpWrong.factory });
  assert.equal(rWrong.exitCode, 1);
  assert.equal(rWrong.rows[0].status, 'KO');
  assert.match(rWrong.rows[0].note, /redirected \/orders → \/dashboard \(expected \/login\)/);
  assert.equal(rWrong.rows[0].hypotheses[0].type, 'navigation');
  assert.deepEqual(rWrong.steps[0].redirect, { from: '/orders', to: '/dashboard', declared: false });

  const fpNone = fakeRedirectPage({ redirectTo: null, countsByPath: { '/orders': { '#login-form': 1 } } });
  const rNone = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fpNone.factory });
  assert.equal(rNone.exitCode, 1);
  assert.equal(rNone.rows[0].status, 'KO');
  assert.match(rNone.rows[0].note, /expected \/orders to redirect to \/login, but stayed on \/orders/);
  assert.equal(rNone.rows[0].hypotheses[0].type, 'navigation');
  assert.equal(rNone.steps[0].redirect, undefined);
});

const realPw = await loadPlaywright(ROOT);
const realChrome = realPw && (chromeExecutable(realPw.name) ?? (realPw.name !== 'playwright-core' ? 'bundled' : null));
const skipReal = !realPw ? 'playwright(-core) not installed in the repo' : !realChrome || (realChrome !== 'bundled' && !existsSync(realChrome)) ? 'no Chromium (set ATREZZO_CHROME)' : false;

test('CLI verify --driver playwright --json: declared redirect outputs redirect metadata and exit 0', { skip: skipReal, timeout: 60_000 }, async () => {
  const app = createServer((req, res) => {
    if (req.url === '/orders') {
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/login' ? '<form id="login-form"><button>Sign in</button></form>' : '<div id="orders"></div>');
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const appUrl = `http://127.0.0.1:${app.address().port}`;
  try {
    const flowDir = tmpProject({
      'f.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    redirects_to: /login\n    wait_for: "#login-form"\n    expect:\n      - selector: "#login-form"\n        count: 1\n',
    });
    const res = await cliAsync(['verify', join(flowDir, 'f.yaml'), '--url', appUrl, '--driver', 'playwright', '--json'], ROOT);
    assert.equal(res.code, 0, res.stderr + res.stdout);
    const json = JSON.parse(res.stdout);
    assert.equal(json.exitCode, 0);
    assert.equal(json.rows[0].status, 'OK');
    assert.deepEqual(json.steps, [{ screen: 'orders', visit: '/orders', redirect: { from: '/orders', to: '/login', declared: true } }]);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
