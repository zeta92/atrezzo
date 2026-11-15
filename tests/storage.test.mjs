import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parseStorage, mergeStorage, storageScript } from '../scripts/lib/storage.mjs';
import { loadFlow } from '../scripts/lib/scenario.mjs';
import { runVerify, formatReport, loadPlaywright, chromeExecutable } from '../scripts/lib/verify.mjs';
import { AtrezzoError } from '../scripts/lib/errors.mjs';
import { ROOT, tmpProject, cliAsync } from './helpers.mjs';

// The value a Supabase app keeps in localStorage; against a mock any well-formed session is enough.
const SESSION = '{"access_token":"fake-flow","token_type":"bearer"}';
const collect = () => { const list = []; return { list, add: (f, m) => list.push(`${f}: ${m}`) }; };

// ---------- the app: a page that prints what it finds in localStorage and sessionStorage ----------

// Like a Supabase SPA: no session in localStorage ⇒ client-side redirect to /auth.
const PAGE = `<!doctype html><meta charset="utf-8"><title>app</title><ul id="out"></ul>
<script>
  if (!localStorage.getItem('sb-127-auth-token')) location.replace('/auth');
  const out = document.getElementById('out');
  for (const [area, s] of [['local', localStorage], ['session', sessionStorage]]) {
    for (let i = 0; i < s.length; i++) {
      const li = document.createElement('li');
      li.dataset.area = area; li.dataset.key = s.key(i); li.dataset.value = s.getItem(s.key(i));
      li.textContent = area + ' ' + s.key(i) + ' = ' + s.getItem(s.key(i));
      out.append(li);
    }
  }
  // the app overwrites its session, as a token refresh would: the next document must see the seed again
  localStorage.setItem('sb-127-auth-token', 'written-by-the-app');
  out.append(Object.assign(document.createElement('i'), { hidden: true, id: 'ready' }));
</script>`;

let app; let appUrl; const seen = [];
before(async () => {
  app = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/auth' ? '<h1 id="login">sign in</h1>' : PAGE);
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  appUrl = `http://127.0.0.1:${app.address().port}`;
});
after(() => app.close());

// ---------- parsing and merging ----------

test('parseStorage: literal keys and values, numbers to text, errors name the field', () => {
  const is = collect();
  const s = parseStorage({ local: { 'sb-127-auth-token': SESSION, n: 3 }, session: { 'some-key': 'value' } }, 'storage', is);
  assert.deepEqual(is.list, []);
  assert.deepEqual(s, { local: { 'sb-127-auth-token': SESSION, n: '3' }, session: { 'some-key': 'value' } });
  assert.deepEqual(parseStorage(undefined, 'storage', is), { local: {}, session: {} });
  parseStorage({ local: ['x'], cookies: {}, session: { obj: { a: 1 } } }, 'steps[1].storage', is);
  assert.equal(is.list.length, 3, is.list.join('\n'));
  assert.ok(is.list.some((l) => /steps\[1\]\.storage\.cookies: unknown field/.test(l)));
  assert.ok(is.list.some((l) => /storage\.local: must be a map/.test(l)));
  assert.ok(is.list.some((l) => /storage\.session\.obj: must be a string.*quoted string/.test(l)));
});

test('mergeStorage: step-level overrides flow-level key by key, per area; keys are case-sensitive', () => {
  const flow = { local: { 'sb-127-auth-token': SESSION, theme: 'dark' }, session: { 'some-key': 'value' } };
  const step = { local: { theme: 'light', Theme: 'x' }, session: {} };
  assert.deepEqual(mergeStorage(flow, step), { local: { 'sb-127-auth-token': SESSION, theme: 'light', Theme: 'x' }, session: { 'some-key': 'value' } });
  assert.deepEqual(flow.local.theme, 'dark', 'the flow layer is not mutated');
});

const STORAGE_FLOW = `storage:
  local: { "sb-127-auth-token": "{\\"access_token\\":\\"fake-flow\\",\\"token_type\\":\\"bearer\\"}", theme: dark }
  session:
    some-key: value
steps:
  - screen: copilot
    visit: /copilot
    storage:
      session: { only-copilot: "1" }
    wait_for: "#ready"
    expect:
      - selector: 'li[data-area=local][data-key=sb-127-auth-token][data-value=''${SESSION.replaceAll("'", "''")}'']'
        count: 1
      - selector: "li[data-area=local][data-key=theme][data-value=dark]"
        count: 1
      - selector: "li[data-area=session][data-key=some-key][data-value=value]"
        count: 1
      - selector: "li[data-area=session][data-key=only-copilot]"
        count: 1
  - screen: settings
    visit: /settings
    storage:
      local: { theme: light }
    wait_for: "#ready"
    expect:
      - selector: "li[data-area=local][data-key=theme][data-value=light]"
        count: 1
      - selector: "li[data-area=local][data-key=theme][data-value=dark]"
        count: 0
      - selector: 'li[data-area=local][data-key=sb-127-auth-token][data-value=''${SESSION.replaceAll("'", "''")}'']'
        count: 1
      - selector: "li[data-area=session][data-key=only-copilot]"
        count: 0
      - selector: "li[data-area=session][data-key=some-key][data-value=value]"
        count: 1
`;

test('loadFlow: storage at flow level and step level', () => {
  const f = loadFlow(join(tmpProject({ 'f.yaml': STORAGE_FLOW }), 'f.yaml'));
  assert.deepEqual(f.storage, { local: { 'sb-127-auth-token': SESSION, theme: 'dark' }, session: { 'some-key': 'value' } });
  assert.deepEqual(f.steps[0].storage, { local: {}, session: { 'only-copilot': '1' } });
  assert.deepEqual(f.steps[1].storage, { local: { theme: 'light' }, session: {} });
});

// ---------- ${…} is rejected before anything runs ----------

test('loadFlow: ${…} in a storage key or value makes the flow invalid, naming the field', () => {
  for (const [yaml, field] of [
    ['storage:\n  local: { sb-127-auth-token: "${SB_SESSION}" }\n', 'storage.local.sb-127-auth-token'],
    ['storage:\n  session:\n    "${KEY}": v\n', 'storage.session.${KEY}'],
  ]) {
    const dir = tmpProject({ 'f.yaml': `${yaml}steps:\n  - screen: a\n    visit: /\n    expect: [{ selector: x, count: 1 }]\n` });
    assert.throws(() => loadFlow(join(dir, 'f.yaml')), (e) => e instanceof AtrezzoError && e.exitCode === 3 && e.issues.some((l) => l.includes(`"${field}"`) && /\$\{…\} is not expanded: atrezzo reads no environment variables/.test(l)), field);
  }
  const step = tmpProject({ 'f.yaml': 'steps:\n  - screen: a\n    visit: /\n    storage: { local: { k: "${V}" } }\n    expect: [{ selector: x, count: 1 }]\n' });
  assert.throws(() => loadFlow(join(step, 'f.yaml')), (e) => e.issues.some((l) => /steps\[0\]\.storage\.local\.k.*not expanded/.test(l)));
});

test('CLI verify: ${…} inside storage ⇒ exit 3, no navigation, the environment is not read', async () => {
  const dir = tmpProject({ 'f.yaml': 'storage:\n  local: { sb-127-auth-token: "${SB_SESSION}" }\nsteps:\n  - screen: copilot\n    visit: /copilot\n    expect: [{ selector: li, count: 1 }]\n' });
  seen.length = 0;
  const r = await cliAsync(['verify', 'f.yaml', '--url', appUrl, '--driver', 'playwright'], dir, { SB_SESSION: 'env-value-that-must-not-be-used' });
  assert.equal(r.code, 3, r.stderr + r.stdout);
  assert.match(r.stderr, /storage\.local\.sb-127-auth-token.*\$\{…\} is not expanded: atrezzo reads no environment variables/s);
  assert.deepEqual(seen, [], 'nothing was requested from the app');
  assert.ok(!(r.stdout + r.stderr).includes('env-value-that-must-not-be-used'));
});

// ---------- http driver: ignored, said once ----------

test('http driver: storage is ignored and the report says so once', async () => {
  const dir = tmpProject({ 'f.yaml': 'storage:\n  local: { k: v }\nsteps:\n  - screen: a\n    storage: { session: { s: "1" } }\n    expect: [{ selector: li, count: 1 }]\n  - screen: b\n    storage: { local: { k: w } }\n    expect: [{ selector: li, count: 1 }]\n' });
  const r = await runVerify(loadFlow(join(dir, 'f.yaml')), { url: appUrl, driver: 'http' });
  const report = formatReport(r);
  assert.equal(report.match(/^WARNING: storage: is ignored with the http driver/gm)?.length, 1, report);
  assert.equal(r.storage, undefined);
  assert.ok(!/Storage \(keys\)/.test(report));
  // a flow without storage gets no warning
  const plain = await runVerify(loadFlow(join(tmpProject({ 'f.yaml': 'steps:\n  - screen: a\n    expect: [{ selector: li, count: 1 }]\n' }), 'f.yaml')), { url: appUrl, driver: 'http' });
  assert.deepEqual(plain.warnings, []);
});

// ---------- playwright driver with a fake browser: the init scripts run on every document ----------

/**
 * A fake browser context: addInitScript keeps the scripts; each goto is a new document that runs
 * them in order against storage that persists per origin, like Chromium. The page then "prints"
 * its storage: locator('local:key=value') or locator('local:key') counts what it holds.
 */
function fakeBrowser() {
  const scripts = [];
  const stores = {};
  let printed = [];
  let current = '';
  const store = () => { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), entries: () => [...m] }; };
  return {
    scripts,
    factory: async () => ({
      context: { setExtraHTTPHeaders: async () => {}, addInitScript: async (s) => { scripts.push(s); } },
      page: {
        goto: async (u) => {
          current = u;
          const { origin } = new URL(u);
          stores[origin] ??= { local: store(), session: store() };
          const { local, session } = stores[origin];
          for (const s of scripts) runInNewContext(s, { location: { origin }, localStorage: local, sessionStorage: session });
          printed = [...local.entries().map(([k, v]) => `local:${k}=${v}`), ...session.entries().map(([k, v]) => `session:${k}=${v}`)];
          return { status: () => 200 };
        },
        url: () => current,
        waitForLoadState: async () => {},
        waitForSelector: async () => {},
        locator: (sel) => ({ count: async () => printed.filter((p) => p === sel || p.startsWith(`${sel}=`)).length }),
      },
      close: async () => {},
    }),
  };
}

test('playwright driver (fake browser): step-level storage overrides flow-level; a key only one step declares is gone in the next', async () => {
  const dir = tmpProject({ 'f.yaml': `storage:
  local: { sb-127-auth-token: "flow-session", theme: dark }
steps:
  - screen: copilot
    visit: /copilot
    storage: { session: { only-copilot: "1" } }
    expect:
      - { selector: "local:sb-127-auth-token=flow-session", count: 1 }
      - { selector: "local:theme=dark", count: 1 }
      - { selector: "session:only-copilot=1", count: 1 }
  - screen: settings
    visit: /settings
    storage: { local: { theme: light, sb-127-auth-token: "step-session" } }
    expect:
      - { selector: "local:theme=light", count: 1 }
      - { selector: "local:theme=dark", count: 0 }
      - { selector: "local:sb-127-auth-token=step-session", count: 1 }
      - { selector: "session:only-copilot", count: 0 }
  - screen: settings-again
    visit: /settings
    storage: { local: { theme: light, sb-127-auth-token: "step-session" } }
    expect:
      - { selector: "local:theme=light", count: 1 }
` });
  const fb = fakeBrowser();
  const r = await runVerify(loadFlow(join(dir, 'f.yaml')), { url: appUrl, driver: 'playwright', pageFactory: fb.factory });
  assert.equal(r.exitCode, 0, formatReport(r));
  assert.equal(fb.scripts.length, 2, 'a step whose storage did not change registers no new script');
  assert.deepEqual(r.storage, { local: ['sb-127-auth-token', 'theme'], session: ['only-copilot'] });
  const report = formatReport(r);
  assert.match(report, /Storage \(keys\): local: sb-127-auth-token, theme · session: only-copilot/);
  // (this fake's selectors spell the values, so look at everything but the table rows)
  const head = report.split('\n\n')[0];
  const { rows, ...meta } = r;
  assert.ok(!/flow-session|step-session/.test(head + JSON.stringify(meta)), 'storage values are never printed');
});

test('storageScript: other origins are left alone', () => {
  const local = new Map();
  const ls = { setItem: (k, v) => local.set(k, v), removeItem: (k) => local.delete(k) };
  const src = storageScript('http://127.0.0.1:4010', { local: { k: 'v' }, session: {} });
  runInNewContext(src, { location: { origin: 'https://third-party.example' }, localStorage: ls, sessionStorage: ls });
  assert.equal(local.size, 0);
  runInNewContext(src, { location: { origin: 'http://127.0.0.1:4010' }, localStorage: ls, sessionStorage: ls });
  assert.deepEqual([...local], [['k', 'v']]);
});

// ---------- REAL playwright driver (Chromium), when available ----------

const realPw = await loadPlaywright(ROOT);
const realChrome = realPw && (chromeExecutable(realPw.name) ?? (realPw.name !== 'playwright-core' ? 'bundled' : null));
const skipReal = !realPw ? 'playwright(-core) not installed in the repo' : !realChrome || (realChrome !== 'bundled' && !existsSync(realChrome)) ? 'no Chromium (set ATREZZO_CHROME)' : false;

test('real playwright driver: the page sees the seeded localStorage and sessionStorage; step-level wins over flow-level', { skip: skipReal, timeout: 60_000 }, async () => {
  const dir = tmpProject({ 'f.yaml': STORAGE_FLOW });
  const r = await runVerify(loadFlow(join(dir, 'f.yaml')), { url: appUrl, driver: 'playwright', cwd: ROOT });
  assert.equal(r.exitCode, 0, formatReport(r));
  assert.deepEqual(r.rows.map((row) => row.obtained), [1, 1, 1, 1, 1, 0, 1, 0, 1]);
});

test('real playwright driver: without storage the app redirects to /auth and the step is KO', { skip: skipReal, timeout: 60_000 }, async () => {
  const dir = tmpProject({ 'f.yaml': 'steps:\n  - screen: copilot\n    visit: /copilot\n    expect: [{ selector: li, count: 0 }]\n' });
  const r = await runVerify(loadFlow(join(dir, 'f.yaml')), { url: appUrl, driver: 'playwright', cwd: ROOT });
  assert.equal(r.exitCode, 1, formatReport(r));
  assert.match(r.rows[0].note, /redirected \/copilot → \/auth/);
});

test('real Chromium: the seed is applied again after a full reload', { skip: skipReal, timeout: 60_000 }, async () => {
  const chromium = realPw.mod.chromium ?? realPw.mod.default?.chromium;
  const browser = await chromium.launch({ executablePath: chromeExecutable(realPw.name), args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext();
    await context.addInitScript(storageScript(appUrl, { local: { 'sb-127-auth-token': SESSION }, session: { 'some-key': 'value' } }));
    const page = await context.newPage();
    const printed = () => page.locator('li').allTextContents();
    await page.goto(`${appUrl}/copilot`);
    assert.deepEqual(await printed(), [`local sb-127-auth-token = ${SESSION}`, 'session some-key = value']);
    assert.equal(await page.evaluate(() => localStorage.getItem('sb-127-auth-token')), 'written-by-the-app');
    await page.reload();
    assert.deepEqual(await printed(), [`local sb-127-auth-token = ${SESSION}`, 'session some-key = value']);
  } finally {
    await browser.close();
  }
});
