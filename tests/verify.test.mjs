import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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

test('diagnose(): an ignored order points at sorts:, an ignored column at filters:', () => {
  const row = { expect: { selector: 'x', count: 3 } };
  const sort = diagnose(row, {
    obtained: 0,
    response: { status: 200, headers: { 'x-atrezzo-ignored': 'order' } },
    items: [{ id: 1 }, { id: 2 }, { id: 3 }],
    matched: 3,
    domCount: 0
  });
  const ignoredSort = sort.find((h) => h.type === 'ignored-sort');
  assert.ok(ignoredSort, 'an ignored order is its own hypothesis');
  assert.equal(ignoredSort.confidence, 'medium');
  assert.match(ignoredSort.evidence, /sorts: \{ by: order/);
  assert.ok(!sort.some((h) => h.type === 'undeclared-filter'), 'it must not send the user to filters');

  const mixed = diagnose(row, {
    obtained: 0,
    response: { status: 200, headers: { 'x-atrezzo-ignored': 'order, status' } },
    items: [{ id: 1 }],
    matched: 1,
    domCount: 0
  });
  assert.ok(mixed.some((h) => h.type === 'ignored-sort'));
  assert.match(mixed.find((h) => h.type === 'undeclared-filter').evidence, /: status\./);

  const filter = diagnose(row, {
    obtained: 0,
    response: { status: 200, headers: { 'x-atrezzo-ignored': 'status' } },
    items: [{ id: 1 }],
    matched: 1,
    domCount: 0
  });
  assert.ok(filter.some((h) => h.type === 'undeclared-filter'));
  assert.ok(!filter.some((h) => h.type === 'ignored-sort'));
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
  assert.deepEqual(r.steps, [{ screen: 'orders', visit: '/orders', redirect: { from: '/orders', to: '/login?next=%2Forders', declared: true }, console: [] }]);

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

  const fpQuery = fakeRedirectPage({ redirectTo: '/orders?next=%2Flogin', countsByPath: { '/orders': { '#target': 1 } } });
  const r3 = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', pageFactory: fpQuery.factory });
  assert.equal(r3.exitCode, 0);
  assert.deepEqual(r3.steps[0].redirect, { from: '/orders', to: '/orders?next=%2Flogin', declared: true });
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

test('declared redirect (redirects_to) on same pathname: KO when staying on visit, OK with redirect metadata on query/fragment change', async () => {
  const samePathDir = tmpProject({
    'same.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    redirects_to: /orders\n    expect: [{ selector: "#login-form", count: 1 }]\n',
    'query.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    redirects_to: /orders?step=1\n    expect: [{ selector: "#login-form", count: 1 }]\n',
  });

  // visit: /orders, redirects_to: /orders, no redirect ⇒ KO (never a false OK)
  const fpStayed = fakeRedirectPage({ redirectTo: null, countsByPath: { '/orders': { '#login-form': 1 } } });
  const rStayed = await runVerify(loadFlow(join(samePathDir, 'same.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fpStayed.factory });
  assert.equal(rStayed.exitCode, 1);
  assert.equal(rStayed.rows[0].status, 'KO');
  assert.match(rStayed.rows[0].note, /expected \/orders to redirect to \/orders, but stayed on \/orders/);
  assert.equal(rStayed.rows[0].hypotheses[0].type, 'navigation');
  assert.equal(rStayed.steps[0].redirect, undefined);

  // visit: /orders, redirects_to: /orders, redirected only by query ⇒ OK with redirect metadata
  const fpQuery = fakeRedirectPage({ redirectTo: '/orders?next=%2Flogin', countsByPath: { '/orders': { '#login-form': 1 } } });
  const rQuery = await runVerify(loadFlow(join(samePathDir, 'same.yaml')), { url, driver: 'playwright', pageFactory: fpQuery.factory });
  assert.equal(rQuery.exitCode, 0, formatReport(rQuery));
  assert.equal(rQuery.rows[0].status, 'OK');
  assert.deepEqual(rQuery.steps[0].redirect, { from: '/orders', to: '/orders?next=%2Flogin', declared: true });

  // visit: /orders, redirects_to: /orders, redirected only by fragment ⇒ OK with redirect metadata
  const fpHash = fakeRedirectPage({ redirectTo: '/orders#auth', countsByPath: { '/orders': { '#login-form': 1 } } });
  const rHash = await runVerify(loadFlow(join(samePathDir, 'same.yaml')), { url, driver: 'playwright', pageFactory: fpHash.factory });
  assert.equal(rHash.exitCode, 0, formatReport(rHash));
  assert.equal(rHash.rows[0].status, 'OK');
  assert.deepEqual(rHash.steps[0].redirect, { from: '/orders', to: '/orders#auth', declared: true });

  // visit: /orders, redirects_to: /orders?step=1, redirected to /orders?step=2 ⇒ KO with redirect metadata
  const fpWrongQuery = fakeRedirectPage({ redirectTo: '/orders?step=2', countsByPath: { '/orders': { '#login-form': 1 } } });
  const rWrongQuery = await runVerify(loadFlow(join(samePathDir, 'query.yaml')), { url, driver: 'playwright', pageFactory: fpWrongQuery.factory });
  assert.equal(rWrongQuery.exitCode, 1);
  assert.equal(rWrongQuery.rows[0].status, 'KO');
  assert.match(rWrongQuery.rows[0].note, /redirected \/orders → \/orders\?step=2 \(expected \/orders\?step=1\)/);
  assert.deepEqual(rWrongQuery.steps[0].redirect, { from: '/orders', to: '/orders?step=2', declared: false });
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
    assert.deepEqual(json.steps, [{ screen: 'orders', visit: '/orders', redirect: { from: '/orders', to: '/login', declared: true }, console: [] }]);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

// ---------- browser console & pageerror capture ----------

function fakeConsolePage({ countsByPath = {}, onVisit, onWaitFor, onCount } = {}) {
  const emitter = new EventEmitter();
  let current = '';
  const emitConsole = (type, text) => emitter.emit('console', { type: () => type, text: () => text });
  const emitPageError = (err) => emitter.emit('pageerror', err);
  return {
    factory: async () => ({
      page: {
        on: (ev, fn) => emitter.on(ev, fn),
        off: (ev, fn) => emitter.off(ev, fn),
        goto: async (u) => {
          current = u;
          const path = new URL(u).pathname;
          await onVisit?.(path, { emitConsole, emitPageError });
          return { status: () => 200 };
        },
        url: () => current,
        waitForLoadState: async () => {},
        waitForSelector: async (sel) => {
          if (onWaitFor) await onWaitFor(sel);
        },
        locator: (sel) => ({
          count: async () => {
            const path = new URL(current).pathname;
            await onCount?.(path, sel, { emitConsole, emitPageError });
            return countsByPath[path]?.[sel] ?? 0;
          },
        }),
      },
      close: async () => {},
    }),
  };
}

test('playwright driver: uncaught pageerror marks step KO with page-error hypothesis and cannot be masked by matching assertions', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: orders
    visit: /orders
    expect:
      - selector: "[data-testid=toast-error]"
        count: 1
      - selector: "[data-testid=order-row]"
        count: 0
`,
  });
  const longMsg = `Invalid array length ${'X'.repeat(400)}`;
  const fp = fakeConsolePage({
    countsByPath: { '/orders': { '[data-testid=toast-error]': 1, '[data-testid=order-row]': 0 } },
    onVisit: (_path, { emitPageError }) => {
      emitPageError(new RangeError(longMsg));
    },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.rows.map((x) => x.status), ['KO', 'KO']);
  assert.match(r.rows[0].note, /uncaught page error: RangeError: Invalid array length/);
  assert.equal(r.rows[1].note, 'same cause as #1');
  assert.equal(r.rows[0].hypotheses.length, 1);
  assert.equal(r.rows[0].hypotheses[0].type, 'page-error');
  assert.equal(r.rows[0].hypotheses[0].confidence, 'high');
  assert.ok(r.rows[0].hypotheses[0].evidence.includes('RangeError: Invalid array length'));
  assert.ok(!r.rows[0].hypotheses[0].evidence.includes('X'.repeat(301)), 'message must be clipped to 300 chars');
  assert.deepEqual(r.steps[0].console, [{ level: 'pageerror', text: `RangeError: ${longMsg}` }]);
});

test('playwright driver: pageerror during wait_for timeout surfaces page-error instead of navigation', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    wait_for: "#ready"\n    expect: [{ selector: "#ready", count: 1 }]\n',
  });
  const fp = fakeConsolePage({
    onVisit: (_path, { emitPageError }) => emitPageError(new RangeError('Invalid array length')),
    onWaitFor: () => { throw new Error('Timeout'); },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.equal(r.rows[0].status, 'KO');
  assert.equal(r.rows[0].hypotheses[0].type, 'page-error');
  assert.match(r.rows[0].hypotheses[0].evidence, /RangeError: Invalid array length/);
});

test('playwright driver: late pageerror during locator traversal still marks step KO', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: orders
    visit: /orders
    expect:
      - selector: "#first"
        count: 1
      - selector: "#second"
        count: 1
`,
  });
  const fp = fakeConsolePage({
    countsByPath: { '/orders': { '#first': 1, '#second': 1 } },
    onCount: (_path, sel, { emitPageError }) => {
      if (sel === '#second') emitPageError(new Error('late crash'));
    },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.rows.map((x) => x.status), ['KO', 'KO']);
  assert.equal(r.rows[0].hypotheses[0].type, 'page-error');
  assert.match(r.rows[0].hypotheses[0].evidence, /Error: late crash/);
});

test('playwright driver: console.error emits WARNING without breaking passing step unless --strict-console', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    expect: [{ selector: "#ok", count: 2 }]\n',
  });
  const fp = fakeConsolePage({
    countsByPath: { '/orders': { '#ok': 2 } },
    onVisit: (_path, { emitConsole }) => {
      emitConsole('log', 'ignored debug log');
      emitConsole('error', 'Failed to load optional badge');
    },
  });

  const okRes = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', pageFactory: fp.factory });
  assert.equal(okRes.exitCode, 0);
  assert.equal(okRes.rows[0].status, 'OK');
  assert.equal(okRes.warnings.length, 1);
  assert.match(okRes.warnings[0], /console\.error: Failed to load optional badge/);
  assert.match(formatReport(okRes), /WARNING: .*Failed to load optional badge/);
  assert.deepEqual(okRes.steps[0].console, [{ level: 'error', text: 'Failed to load optional badge' }]);

  const strictRes = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, strictConsole: true, pageFactory: fp.factory });
  assert.equal(strictRes.exitCode, 1);
  assert.equal(strictRes.rows[0].status, 'KO');
  assert.equal(strictRes.warnings.length, 0);
  assert.match(strictRes.rows[0].note, /--strict-console.*Failed to load optional badge/);
  assert.equal(strictRes.rows[0].hypotheses[0].type, 'console-error');
  assert.deepEqual(strictRes.steps[0].console, [{ level: 'error', text: 'Failed to load optional badge' }]);
});

test('playwright driver: console listeners are isolated per step', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: first
    visit: /first
    expect: [{ selector: "#a", count: 1 }]
  - screen: second
    visit: /second
    expect: [{ selector: "#b", count: 1 }]
`,
  });
  const fp = fakeConsolePage({
    countsByPath: { '/first': { '#a': 1 }, '/second': { '#b': 1 } },
    onVisit: (path, { emitConsole }) => {
      if (path === '/first') emitConsole('error', 'only on first');
    },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', pageFactory: fp.factory });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.steps[0].console, [{ level: 'error', text: 'only on first' }]);
  assert.deepEqual(r.steps[1].console, []);
});

test('CLI verify --driver playwright (real Chromium): page throwing uncaught exception is KO with page-error hypothesis and console JSON', { skip: skipReal, timeout: 60_000 }, async () => {
  const app = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <div id="toast">Something went wrong</div>
      <div id="rows"></div>
      <script>
        new Array(-1); // throws RangeError: Invalid array length
      </script>
    </body></html>`);
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const appUrl = `http://127.0.0.1:${app.address().port}`;
  try {
    const flowDir = tmpProject({
      'f.yaml': `steps:
  - screen: blank-crash
    visit: /
    expect:
      - selector: "#toast"
        count: 1
      - selector: "#rows .row"
        count: 0
`,
    });
    const res = await cliAsync(['verify', join(flowDir, 'f.yaml'), '--url', appUrl, '--driver', 'playwright', '--diagnose', '--json'], ROOT);
    assert.equal(res.code, 1, res.stderr + res.stdout);
    const json = JSON.parse(res.stdout);
    assert.equal(json.exitCode, 1);
    assert.deepEqual(json.rows.map((r) => r.status), ['KO', 'KO']);
    assert.equal(json.rows[0].hypotheses[0].type, 'page-error');
    assert.match(json.rows[0].hypotheses[0].evidence, /RangeError: Invalid array length/);
    assert.ok(json.steps[0].console.some((c) => c.level === 'pageerror' && /RangeError: Invalid array length/.test(c.text)));
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('CLI verify --driver playwright (real Chromium): console.error only warns unless --strict-console is passed', { skip: skipReal, timeout: 60_000 }, async () => {
  const app = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <div id="app"><span class="item">one</span><span class="item">two</span></div>
      <script>
        console.error('non-fatal console error');
      </script>
    </body></html>`);
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const appUrl = `http://127.0.0.1:${app.address().port}`;
  try {
    const flowDir = tmpProject({
      'f.yaml': 'steps:\n  - screen: app\n    visit: /\n    expect:\n      - selector: "#app .item"\n        count: 2\n',
    });

    const warnRes = await cliAsync(['verify', join(flowDir, 'f.yaml'), '--url', appUrl, '--driver', 'playwright'], ROOT);
    assert.equal(warnRes.code, 0, warnRes.stderr + warnRes.stdout);
    assert.match(warnRes.stdout, /WARNING: .*non-fatal console error/);
    assert.match(warnRes.stdout, /GREEN/);

    const jsonRes = await cliAsync(['verify', join(flowDir, 'f.yaml'), '--url', appUrl, '--driver', 'playwright', '--json'], ROOT);
    assert.equal(jsonRes.code, 0, jsonRes.stderr + jsonRes.stdout);
    const json = JSON.parse(jsonRes.stdout);
    assert.deepEqual(json.steps[0].console, [{ level: 'error', text: 'non-fatal console error' }]);

    const strictRes = await cliAsync(['verify', join(flowDir, 'f.yaml'), '--url', appUrl, '--driver', 'playwright', '--strict-console', '--diagnose'], ROOT);
    assert.equal(strictRes.code, 1, strictRes.stderr + strictRes.stdout);
    assert.match(strictRes.stdout, /RED/);
    assert.match(strictRes.stdout, /console-error/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('playwright driver: selector failure combined with pageerror marks step KO and formats report cleanly', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: orders
    visit: /orders
    expect:
      - selector: "#broken"
        count: 1
      - selector: "#ok"
        count: 1
`,
  });
  const fp = fakeConsolePage({
    countsByPath: { '/orders': { '#ok': 1 } },
    onVisit: (_path, { emitPageError }) => emitPageError(new Error('boom during render')),
    onCount: (_path, sel) => {
      if (sel === '#broken') throw new Error('Target page, context or browser has been closed');
    },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.rows.map((x) => x.status), ['KO', 'KO']);
  assert.deepEqual(r.rows.map((x) => x.obtained), [0, 1]);
  assert.match(r.rows[0].note, /uncaught page error: Error: boom during render/);
  assert.equal(r.rows[1].note, 'same cause as #1');
  assert.equal(r.rows[0].hypotheses[0].type, 'page-error');
  const report = formatReport(r);
  assert.match(report, /#broken/);
  assert.match(report, /RED/);
});

test('playwright driver: step without expect surfaces synthetic (page) KO on pageerror and --strict-console', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: blank
    visit: /blank
`,
  });
  const fpPageErr = fakeConsolePage({
    onVisit: (_path, { emitPageError }) => emitPageError(new RangeError('Invalid array length')),
  });
  const r1 = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fpPageErr.factory });
  assert.equal(r1.exitCode, 1);
  assert.equal(r1.rows.length, 1);
  assert.deepEqual(r1.rows[0].expect, { selector: '(page)', count: 0 });
  assert.equal(r1.rows[0].status, 'KO');
  assert.equal(r1.rows[0].obtained, null);
  assert.equal(r1.rows[0].hypotheses[0].type, 'page-error');
  const rep1 = formatReport(r1);
  assert.match(rep1, /\(page\)\s+=0\s+-\s+KO/);
  assert.match(rep1, /RED/);

  const fpConsoleErr = fakeConsolePage({
    onVisit: (_path, { emitConsole }) => emitConsole('error', 'Unhandled API failure'),
  });
  const r2 = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, strictConsole: true, pageFactory: fpConsoleErr.factory });
  assert.equal(r2.exitCode, 1);
  assert.equal(r2.rows.length, 1);
  assert.deepEqual(r2.rows[0].expect, { selector: '(page)', count: 0 });
  assert.equal(r2.rows[0].status, 'KO');
  assert.equal(r2.rows[0].hypotheses[0].type, 'console-error');
  const rep2 = formatReport(r2);
  assert.match(rep2, /\(page\)\s+=0\s+-\s+KO/);
  assert.match(rep2, /RED/);
});

test('--strict-console with http driver is rejected (exit 3), never GREEN', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: orders\n    requests: { orders: "GET /api/orders" }\n    expect: [{ selector: ".row", count: 1, data: { request: orders } }]\n',
  });
  await assert.rejects(
    () => runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'http', strictConsole: true }),
    (e) => e instanceof AtrezzoError && e.exitCode === 3 && /--strict-console requires --driver playwright/.test(e.message),
  );

  const cliExplicit = await cliAsync(['verify', join(flowDir, 'f.yaml'), '--url', url, '--driver', 'http', '--strict-console'], dir);
  assert.equal(cliExplicit.code, 3, cliExplicit.stderr + cliExplicit.stdout);
  assert.match(cliExplicit.stderr, /--strict-console requires --driver playwright/);
  assert.doesNotMatch(cliExplicit.stdout, /GREEN/);

  const cliDefault = await cliAsync(['verify', join(flowDir, 'f.yaml'), '--url', url, '--strict-console'], dir);
  assert.equal(cliDefault.code, 3, cliDefault.stderr + cliDefault.stdout);
  assert.match(cliDefault.stderr, /--strict-console requires --driver playwright/);
  assert.doesNotMatch(cliDefault.stdout, /GREEN/);
});

// ---------- pre-assertion click interactions ----------

test('loadFlow: validates click and click_timeout', () => {
  const okDir = tmpProject({
    'single.yaml': 'steps:\n  - screen: a\n    visit: /a\n    click: "text=Open details"\n    expect: [{ selector: ".panel", count: 1 }]\n',
    'multi.yaml': 'click_timeout: 3000\nsteps:\n  - screen: a\n    visit: /a\n    click: ["#tab-2", "text=Expand"]\n    click_timeout: 1500\n    expect: [{ selector: ".panel", count: 1 }]\n',
  });
  const f1 = loadFlow(join(okDir, 'single.yaml'));
  assert.deepEqual(f1.steps[0].click, ['text=Open details']);
  assert.equal(f1.steps[0].clickTimeout, null);
  assert.equal(f1.clickTimeout, null);

  const f2 = loadFlow(join(okDir, 'multi.yaml'));
  assert.equal(f2.clickTimeout, 3000);
  assert.deepEqual(f2.steps[0].click, ['#tab-2', 'text=Expand']);
  assert.equal(f2.steps[0].clickTimeout, 1500);

  for (const [yaml, pattern] of [
    ['steps:\n  - screen: a\n    visit: /a\n    click: ""\n    expect: [{ selector: x, count: 1 }]\n', /steps\[0\]\.click": must be a non-empty selector/],
    ['steps:\n  - screen: a\n    visit: /a\n    click: []\n    expect: [{ selector: x, count: 1 }]\n', /steps\[0\]\.click": must be a non-empty selector/],
    ['steps:\n  - screen: a\n    visit: /a\n    click: ["#ok", ""]\n    expect: [{ selector: x, count: 1 }]\n', /steps\[0\]\.click\[1\]": must be a non-empty selector/],
    ['steps:\n  - screen: a\n    visit: /a\n    click: 123\n    expect: [{ selector: x, count: 1 }]\n', /steps\[0\]\.click": must be a selector string or a list of selectors/],
    ['steps:\n  - screen: a\n    visit: /a\n    click: "#ok"\n    click_timeout: 0\n    expect: [{ selector: x, count: 1 }]\n', /steps\[0\]\.click_timeout": must be a positive integer/],
    ['click_timeout: -5\nsteps:\n  - screen: a\n    visit: /a\n    expect: [{ selector: x, count: 1 }]\n', /field "click_timeout": must be a positive integer/],
  ]) {
    const badDir = tmpProject({ 'f.yaml': yaml });
    assert.throws(() => loadFlow(join(badDir, 'f.yaml')), (e) => e instanceof AtrezzoError && e.exitCode === 3 && e.issues.some((l) => pattern.test(l)));
  }
});

function fakeClickPage({ initialCounts = {}, onClick, missingSelectors = [] } = {}) {
  const events = [];
  const counts = { ...initialCounts };
  const missing = new Set(missingSelectors);
  let current = '';
  return {
    events,
    factory: async () => ({
      page: {
        goto: async (u) => { current = u; return { status: () => 200 }; },
        url: () => current,
        waitForLoadState: async () => {},
        waitForSelector: async () => {},
        locator: (sel) => {
          const target = {
            waitFor: async (opts) => {
              events.push({ type: 'waitFor', sel, timeout: opts?.timeout });
              if (missing.has(sel)) {
                const err = new Error(`locator.waitFor: Timeout ${opts?.timeout ?? 5000}ms exceeded.`);
                err.name = 'TimeoutError';
                throw err;
              }
            },
            click: async (opts) => {
              events.push({ type: 'click', sel, timeout: opts?.timeout });
              await onClick?.(sel, counts);
            },
            count: async () => {
              events.push({ type: 'count', sel });
              return counts[sel] ?? 0;
            },
          };
          return { ...target, first: () => target };
        },
      },
      close: async () => {},
    }),
  };
}

test('playwright driver (fake page): click list executes in order before assertions, respects timeout, and keeps a single step', async () => {
  const flowDir = tmpProject({
    'f.yaml': `click_timeout: 2500
steps:
  - screen: details
    visit: /details
    click:
      - "text=Section A"
      - "[data-testid=open-sub]"
    expect:
      - selector: "[data-testid=sub-body]"
        count: 1
`,
  });
  const fp = fakeClickPage({
    initialCounts: { '[data-testid=sub-body]': 0 },
    onClick: (sel, counts) => {
      if (sel === '[data-testid=open-sub]') counts['[data-testid=sub-body]'] = 1;
    },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', pageFactory: fp.factory });
  assert.equal(r.exitCode, 0, formatReport(r));
  assert.equal(r.steps.length, 1);
  assert.deepEqual(r.rows.map((x) => x.status), ['OK']);
  assert.deepEqual(
    fp.events.map((e) => `${e.type}:${e.sel}`),
    ['waitFor:text=Section A', 'click:text=Section A', 'waitFor:[data-testid=open-sub]', 'click:[data-testid=open-sub]', 'count:[data-testid=sub-body]'],
  );
  assert.equal(fp.events[0].timeout, 2500);

  // Step-level click_timeout overrides flow-level and opts.clickTimeout; default is 5000 ms
  const stepTimeoutDir = tmpProject({
    'step.yaml': 'click_timeout: 2500\nsteps:\n  - screen: a\n    visit: /a\n    click: "#btn"\n    click_timeout: 1200\n    expect: [{ selector: "#out", count: 1 }]\n',
    'def.yaml': 'steps:\n  - screen: a\n    visit: /a\n    click: "#btn"\n    expect: [{ selector: "#out", count: 1 }]\n',
  });
  const fpStep = fakeClickPage({ initialCounts: { '#out': 1 } });
  await runVerify(loadFlow(join(stepTimeoutDir, 'step.yaml')), { url, driver: 'playwright', clickTimeout: 4000, pageFactory: fpStep.factory });
  assert.equal(fpStep.events[0].timeout, 1200);

  const fpDef = fakeClickPage({ initialCounts: { '#out': 1 } });
  await runVerify(loadFlow(join(stepTimeoutDir, 'def.yaml')), { url, driver: 'playwright', pageFactory: fpDef.factory });
  assert.equal(fpDef.events[0].timeout, 5000);
});

test('playwright driver (fake page): missing click target marks step KO with click-target-missing hypothesis', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: details
    visit: /details
    click:
      - "#exists"
      - "#missing"
    click_timeout: 1500
    expect:
      - selector: "#always"
        count: 1
      - selector: "#body"
        count: 1
`,
  });
  const fp = fakeClickPage({
    initialCounts: { '#always': 1, '#body': 0 },
    missingSelectors: ['#missing'],
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.equal(r.steps.length, 1);
  assert.deepEqual(r.rows.map((x) => x.status), ['KO', 'KO']);
  assert.match(r.rows[0].note, /click "#missing" did not appear within 1500 ms/);
  assert.equal(r.rows[1].note, 'same cause as #1');
  assert.equal(r.rows[0].hypotheses[0].type, 'click-target-missing');
  assert.equal(r.rows[0].hypotheses[0].confidence, 'high');
  assert.match(r.rows[0].hypotheses[0].evidence, /#missing/);
});

test('playwright driver: pageerror during click timeout surfaces page-error instead of click-target-missing', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: a\n    visit: /a\n    click: "#btn"\n    click_timeout: 200\n    expect: [{ selector: "#out", count: 1 }]\n',
  });
  const emitter = new EventEmitter();
  let current = '';
  const factory = async () => ({
    page: {
      on: (ev, fn) => emitter.on(ev, fn),
      off: (ev, fn) => emitter.off(ev, fn),
      goto: async (u) => {
        current = u;
        emitter.emit('pageerror', new Error('crash before render'));
        return { status: () => 200 };
      },
      url: () => current,
      waitForLoadState: async () => {},
      locator: () => {
        const target = {
          waitFor: async () => { const e = new Error('Timeout 200ms exceeded'); e.name = 'TimeoutError'; throw e; },
          click: async () => {},
          count: async () => 0,
        };
        return { ...target, first: () => target };
      },
    },
    close: async () => {},
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: factory });
  assert.equal(r.exitCode, 1);
  assert.equal(r.rows[0].hypotheses[0].type, 'page-error');
});

test('http driver: click emits warning and ignores clicks', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: dashboard
    visit: /
    click: "#toggle"
    requests:
      customers: GET /api/customers
    expect:
      - selector: "[data-testid=customer-chip]"
        count: 3
        data: { request: customers }
`,
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'http' });
  assert.equal(r.exitCode, 0);
  assert.ok(r.warnings.some((w) => /click: is ignored with the http driver/.test(w)));
});

test('CLI verify --driver playwright (real Chromium): click opens collapsible and asserts inner text in one step', { skip: skipReal, timeout: 60_000 }, async () => {
  const app = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <button type="button" id="toggle">Ver detalles</button>
      <div id="collapsible-body"></div>
      <script>
        document.getElementById('toggle').addEventListener('click', () => {
          document.getElementById('collapsible-body').innerHTML =
            '<button type="button" id="more">Mostrar texto</button><div id="inner"></div>';
          document.getElementById('more').addEventListener('click', () => {
            document.getElementById('inner').innerHTML =
              '<p data-testid="collapsible-text">Contenido desplegado del colapsable</p>';
          });
        });
      </script>
    </body></html>`);
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const appUrl = `http://127.0.0.1:${app.address().port}`;
  try {
    const flowDir = tmpProject({
      'single.yaml': `steps:
  - screen: details
    visit: /
    click: "text=Ver detalles"
    expect:
      - selector: "#more"
        count: 1
`,
      'multi.yaml': `steps:
  - screen: details
    visit: /
    click:
      - "text=Ver detalles"
      - "#more"
    expect:
      - selector: "text=Contenido desplegado del colapsable"
        count: 1
      - selector: "[data-testid=collapsible-text]"
        count: 1
`,
    });

    const singleRes = await cliAsync(['verify', join(flowDir, 'single.yaml'), '--url', appUrl, '--driver', 'playwright', '--json'], ROOT);
    assert.equal(singleRes.code, 0, singleRes.stderr + singleRes.stdout);
    const singleJson = JSON.parse(singleRes.stdout);
    assert.equal(singleJson.exitCode, 0);
    assert.equal(singleJson.steps.length, 1);
    assert.deepEqual(singleJson.rows.map((r) => r.status), ['OK']);

    const multiRes = await cliAsync(['verify', join(flowDir, 'multi.yaml'), '--url', appUrl, '--driver', 'playwright', '--json'], ROOT);
    assert.equal(multiRes.code, 0, multiRes.stderr + multiRes.stdout);
    const multiJson = JSON.parse(multiRes.stdout);
    assert.equal(multiJson.exitCode, 0);
    assert.equal(multiJson.steps.length, 1);
    assert.deepEqual(multiJson.rows.map((r) => r.status), ['OK', 'OK']);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('CLI verify --driver playwright (real Chromium): missing click target gives KO with click-target-missing hypothesis', { skip: skipReal, timeout: 60_000 }, async () => {
  const app = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><div id="always-present">ok</div></body></html>');
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const appUrl = `http://127.0.0.1:${app.address().port}`;
  try {
    const flowDir = tmpProject({
      'missing.yaml': `steps:
  - screen: details
    visit: /
    click: "#does-not-exist"
    click_timeout: 200
    expect:
      - selector: "#always-present"
        count: 1
      - selector: "#collapsed-text"
        count: 1
`,
    });
    const res = await cliAsync(['verify', join(flowDir, 'missing.yaml'), '--url', appUrl, '--driver', 'playwright', '--diagnose', '--json'], ROOT);
    assert.equal(res.code, 1, res.stderr + res.stdout);
    const json = JSON.parse(res.stdout);
    assert.equal(json.exitCode, 1);
    assert.equal(json.steps.length, 1);
    assert.deepEqual(json.rows.map((r) => r.status), ['KO', 'KO']);
    assert.match(json.rows[0].note, /click "#does-not-exist" did not appear within 200 ms/);
    assert.equal(json.rows[1].note, 'same cause as #1');
    assert.equal(json.rows[0].hypotheses[0].type, 'click-target-missing');

    const badCli = await cliAsync(['verify', join(flowDir, 'missing.yaml'), '--url', appUrl, '--driver', 'playwright', '--click-timeout', '0'], ROOT);
    assert.equal(badCli.code, 3);
    assert.match(badCli.stderr, /--click-timeout must be a positive integer/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

// ---------- clock ----------

const CLOCK_FLOW = `scenario: s.yaml
clock: { time: 2025-06-01T10:00:00Z }
steps:
  - screen: home
    visit: /home
    expect:
      - selector: ".item"
        count: 1
  - screen: detalle
    visit: /detalle
    clock: { time: scenario }
    expect:
      - selector: ".item"
        count: 1
`;

test('loadFlow: clock at flow and step level, with "scenario" resolving to scenario.now', () => {
  const dir = tmpProject({
    's.yaml': `name: reloj\nseed: 1\nnow: 2025-03-01T09:00:00Z\nworld:\n  items: 1\nendpoints:\n  - path: /api/items\n    entity: items\n`,
    'f.yaml': CLOCK_FLOW
  });
  const flow = loadFlow(join(dir, 'f.yaml'));
  assert.equal(flow.clock.time, '2025-06-01T10:00:00.000Z');
  assert.equal(flow.steps[0].clock, null);
  assert.equal(flow.steps[1].clock.time, '2025-03-01T09:00:00.000Z', 'scenario = el now del escenario');
});

test('loadFlow: an invalid clock is a flow error', () => {
  const dir = tmpProject({
    'f.yaml': 'steps:\n  - screen: home\n    visit: /home\n    clock: { time: ayer }\n'
  });
  assert.throws(() => loadFlow(join(dir, 'f.yaml')), /clock\.time": must be an ISO date\/time or "scenario"/);
  const dir2 = tmpProject({ 'f.yaml': 'steps:\n  - screen: home\n    visit: /home\n    clock: { time: "2025-01-01T00:00:00Z", zona: UTC }\n' });
  assert.throws(() => loadFlow(join(dir2, 'f.yaml')), /clock\.zona": unknown field/);
});

test('verify: installs the browser clock before navigating, once per page', async () => {
  const dir = tmpProject({
    'f.yaml': 'clock: { time: 2025-06-01T10:00:00Z }\nsteps:\n  - screen: home\n    visit: /home\n    expect:\n      - selector: ".item"\n        count: 1\n'
  });
  const installed = [];
  const page = {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForSelector: async () => {},
    locator: () => ({ count: async () => 1 }),
    clock: { install: async ({ time }) => { installed.push(new Date(time).toISOString()); }, setFixedTime: async () => {} }
  };
  await runVerify(loadFlow(join(dir, 'f.yaml')), {
    url: 'http://mock', driver: 'playwright', cwd: dir, reset: false,
    pageFactory: async () => ({ page, close: async () => {} })
  });
  assert.deepEqual(installed, ['2025-06-01T10:00:00.000Z'], 'install() antes de la primera navegación');
});
