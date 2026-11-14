import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseHeaders, mergeHeaders, maskHeaders, isSecretHeader, redact, MASK } from '../scripts/lib/headers.mjs';
import { loadFlow } from '../scripts/lib/scenario.mjs';
import { runVerify, formatReport, loadPlaywright, chromeExecutable } from '../scripts/lib/verify.mjs';
import { AtrezzoError } from '../scripts/lib/errors.mjs';
import { FLOW, SCENARIO, ROOT, tmpProject, cliAsync } from './helpers.mjs';

const SECRET = 'sb-app-auth-token=s3cr3t-VALUE-that-must-not-leak';
const collect = () => { const list = []; return { list, add: (f, m) => list.push(`${f}: ${m}`) }; };

// ---------- parsing ----------

test('parseHeaders: valid map, numbers to strings, ${VAR} from the environment', () => {
  const is = collect();
  const h = parseHeaders({ Cookie: '${C}', 'X-Num': 3, 'Accept-Language': ' es-ES ' }, 'headers', is, { C: SECRET });
  assert.deepEqual(is.list, []);
  assert.deepEqual(h, { Cookie: SECRET, 'X-Num': '3', 'Accept-Language': 'es-ES' });
  assert.deepEqual(parseHeaders(undefined, 'headers', is), {});
});

test('parseHeaders: errors with field and reason', () => {
  const is = collect();
  parseHeaders(['Cookie: x'], 'headers', is);
  parseHeaders({ 'Bad Name': 'x', Obj: { a: 1 }, Cookie: '${NOT_SET}', Break: 'a\r\nInjected: 1' }, 'steps[0].headers', is, {});
  assert.equal(is.list.length, 5, is.list.join('\n'));
  assert.match(is.list[0], /^headers: must be a map/);
  assert.ok(is.list.some((l) => /steps\[0\]\.headers\.Bad Name: invalid header name/.test(l)));
  assert.ok(is.list.some((l) => /Obj: must be a string/.test(l)));
  assert.ok(is.list.some((l) => /\$\{NOT_SET\}.*is not set/.test(l)));
  assert.ok(is.list.some((l) => /line breaks/.test(l)));
});

// ---------- merge ----------

test('mergeHeaders: the step overrides the flow case-insensitively; the rest is kept', () => {
  const m = mergeHeaders({ Cookie: 'a=1', 'Accept-Language': 'en' }, { 'accept-language': 'es-ES', 'X-Extra': '1' });
  assert.deepEqual(m, { Cookie: 'a=1', 'accept-language': 'es-ES', 'X-Extra': '1' });
  assert.deepEqual(mergeHeaders({ A: '1' }, undefined), { A: '1' });
});

// ---------- secrets ----------

test('maskHeaders / redact: Cookie and Authorization never appear in clear text', () => {
  for (const n of ['Cookie', 'authorization', 'Proxy-Authorization', 'X-Api-Key', 'X-Session-Id', 'X-Auth-Token']) assert.ok(isSecretHeader(n), n);
  for (const n of ['Accept-Language', 'Accept', 'User-Agent']) assert.ok(!isSecretHeader(n), n);
  const h = { Cookie: SECRET, Authorization: 'Bearer abc.def.ghi', 'Accept-Language': 'es-ES' };
  assert.deepEqual(maskHeaders(h), { Cookie: MASK, Authorization: MASK, 'Accept-Language': 'es-ES' });
  const msg = redact(`failed sending ${SECRET}; auth=Bearer abc.def.ghi`, h);
  assert.ok(!msg.includes('s3cr3t') && !msg.includes('abc.def.ghi'), msg);
});

// ---------- flow ----------

test('loadFlow: flow and step headers, viewport, and optional scenario', () => {
  const dir = tmpProject({ 'f.yaml': `base_url: http://127.0.0.1:1
viewport: { width: 1440, height: 1000 }
headers:
  Cookie: "\${MY_COOKIE}"
steps:
  - screen: customers
    visit: /customers
    headers: { Accept-Language: es-ES }
    expect:
      - selector: "table tbody tr"
        count: 6
` });
  const f = loadFlow(join(dir, 'f.yaml'), { env: { MY_COOKIE: SECRET } });
  assert.equal(f.scenario, null);
  assert.deepEqual(f.viewport, { width: 1440, height: 1000 });
  assert.deepEqual(f.headers, { Cookie: SECRET });
  assert.deepEqual(f.steps[0].headers, { 'Accept-Language': 'es-ES' });
});

test('loadFlow: existing flows (without headers) still load the same', () => {
  const dir = tmpProject({ 'scenarios/conciliacion.yaml': SCENARIO, 'flow.yaml': FLOW });
  const f = loadFlow(join(dir, 'flow.yaml'));
  assert.deepEqual(f.headers, {});
  assert.equal(f.viewport, null);
  assert.ok(f.steps.every((s) => Object.keys(s.headers).length === 0));
  assert.equal(f.scenario.name, 'conciliacion');
});

test('loadFlow: invalid headers or viewport ⇒ AtrezzoError naming the field, without leaking the value', () => {
  const dir = tmpProject({ 'f.yaml': `headers: [Cookie]\nviewport: { width: 10 }\nsteps:\n  - screen: a\n    visit: /\n    headers: { Cookie: "\${NOPE}" }\n    expect: [{ selector: x, count: 1 }]\n` });
  assert.throws(() => loadFlow(join(dir, 'f.yaml'), { env: {} }), (e) => e instanceof AtrezzoError && /field "headers"/.test(e.message) && /viewport\.width/.test(e.message) && /viewport\.height/.test(e.message));
  const dir2 = tmpProject({ 'f.yaml': `steps:\n  - screen: a\n    visit: /\n    headers: { Cookie: "\${NOPE}" }\n    expect: [{ selector: x, count: 1 }]\n` });
  assert.throws(() => loadFlow(join(dir2, 'f.yaml'), { env: {} }), /steps\[0\]\.headers\.Cookie.*NOPE/);
});

// ---------- http driver: sends the headers ----------

let app; let appUrl; const seen = [];
before(async () => {
  // Minimal "real" app: without a valid cookie, /api/* returns 401 and pages redirect to /login.
  app = createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie, lang: req.headers['accept-language'] });
    const ok = req.headers.cookie === SECRET;
    if (req.url.startsWith('/api/items')) {
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(ok ? [{ id: 1 }, { id: 2 }, { id: 3 }] : { error: 'not authenticated' }));
    }
    if (req.url === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<form><input name=email><input type=checkbox></form>'); }
    if (!ok) { res.writeHead(302, { location: '/login' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<main><h1>Items</h1><p>3 items</p><table><tbody>${'<tr><td>x</td></tr>'.repeat(3)}</tbody></table><div id=lang>${req.headers['accept-language'] ?? ''}</div></main>`);
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  appUrl = `http://127.0.0.1:${app.address().port}`;
});
after(() => app.close());

const flowFile = (extra = '') => tmpProject({ 'f.yaml': `headers:
  Cookie: "\${T_COOKIE}"
${extra}steps:
  - screen: items
    visit: /items
    headers: { Accept-Language: es-ES }
    wait_for: "table tbody tr"
    requests:
      items: GET /api/items
    expect:
      - selector: "table tbody tr"
        count: 3
        data: { request: items }
` });

test('http driver: the effective headers travel in fetch and the report hides the secret', async () => {
  const dir = flowFile();
  seen.length = 0;
  const r = await runVerify(loadFlow(join(dir, 'f.yaml'), { env: { T_COOKIE: SECRET } }), { url: appUrl, driver: 'http' });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(seen.map((s) => [s.url, s.cookie, s.lang]), [['/api/items', SECRET, 'es-ES']]);
  const report = formatReport(r);
  assert.match(report, /Headers: Cookie: \*\*\* · Accept-Language: es-ES/);
  assert.ok(!report.includes('s3cr3t') && !JSON.stringify(r).includes('s3cr3t'));
});

test('http driver: without a valid cookie ⇒ RED (401), not green', async () => {
  const dir = flowFile();
  const r = await runVerify(loadFlow(join(dir, 'f.yaml'), { env: { T_COOKIE: 'other=1' } }), { url: appUrl, driver: 'http', diagnose: true });
  assert.equal(r.exitCode, 1);
  assert.ok(r.rows[0].hypotheses.some((h) => h.type === 'non-200-response'));
});

test('CLI verify --json: the secret appears in neither stdout nor stderr', async () => {
  const dir = flowFile();
  const env = { T_COOKIE: SECRET };
  for (const extra of [[], ['--json']]) {
    const r = await cliAsync(['verify', 'f.yaml', '--url', appUrl, ...extra], dir, env);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.ok(!(r.stdout + r.stderr).includes('s3cr3t'), r.stdout);
    assert.match(r.stdout, /\*\*\*/);
  }
});

// ---------- driver playwright (page fake): headers, viewport, redirect ----------

function fakePw({ finalPath = null, counts = {} } = {}) {
  const calls = { headers: [], viewport: undefined };
  let current = '';
  return {
    calls,
    factory: async ({ viewport }) => {
      calls.viewport = viewport;
      return {
        context: { setExtraHTTPHeaders: async (h) => { calls.headers.push(h); } },
        page: {
          goto: async (u) => { current = finalPath ? new URL(finalPath, u).toString() : u; return { status: () => 200 }; },
          url: () => current,
          waitForLoadState: async () => {},
          waitForSelector: async () => {},
          locator: (sel) => ({ count: async () => counts[sel] ?? 0 }),
        },
        close: async () => {},
      };
    },
  };
}

test('playwright driver: context.setExtraHTTPHeaders with the step headers and the flow viewport', async () => {
  const dir = flowFile('viewport: { width: 1440, height: 1000 }\n');
  const fp = fakePw({ counts: { 'table tbody tr': 3 } });
  const r = await runVerify(loadFlow(join(dir, 'f.yaml'), { env: { T_COOKIE: SECRET } }), { url: appUrl, driver: 'playwright', pageFactory: fp.factory });
  assert.equal(r.exitCode, 0, formatReport(r));
  assert.deepEqual(fp.calls.viewport, { width: 1440, height: 1000 });
  assert.deepEqual(fp.calls.headers, [{ Cookie: SECRET, 'Accept-Language': 'es-ES' }]);
});

test('playwright driver: redirect to /login ⇒ KO even if the count happens to match', async () => {
  const dir = tmpProject({ 'f.yaml': 'steps:\n  - screen: empty\n    visit: /items\n    expect:\n      - selector: ".error"\n        count: 0\n' });
  const fp = fakePw({ finalPath: '/login?next=%2Fitems' });
  const r = await runVerify(loadFlow(join(dir, 'f.yaml')), { url: appUrl, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.equal(r.rows[0].obtained, 0);
  assert.equal(r.rows[0].status, 'KO');
  assert.match(r.rows[0].note, /redirected \/items → \/login\?next=%2Fitems.*login/);
  assert.equal(r.rows[0].hypotheses[0].type, 'navigation');
});

test('chromeExecutable: ATREZZO_CHROME wins; playwright-core uses the system Chromium', () => {
  assert.equal(chromeExecutable('playwright', { ATREZZO_CHROME: '/x/chrome' }), '/x/chrome');
  assert.equal(chromeExecutable('playwright', {}), undefined);
  if (existsSync('/usr/bin/chromium')) assert.equal(chromeExecutable('playwright-core', {}), '/usr/bin/chromium');
});

// ---------- REAL playwright driver (actual Chromium), when available ----------

const realPw = await loadPlaywright(ROOT);
const realChrome = realPw && (chromeExecutable(realPw.name) ?? (realPw.name !== 'playwright-core' ? 'bundled' : null));
const skipReal = !realPw ? 'playwright(-core) not installed in the repo' : !realChrome || (realChrome !== 'bundled' && !existsSync(realChrome)) ? 'no Chromium (set ATREZZO_CHROME)' : false;

test('real playwright driver: counts in the DOM with the flow cookie', { skip: skipReal, timeout: 60_000 }, async () => {
  const dir = flowFile('viewport: { width: 1440, height: 1000 }\n');
  const r = await runVerify(loadFlow(join(dir, 'f.yaml'), { env: { T_COOKIE: SECRET } }), { url: appUrl, driver: 'playwright', cwd: ROOT });
  assert.equal(r.exitCode, 0, formatReport(r));
  assert.equal(r.rows[0].obtained, 3);
});

test('real playwright driver: invalid cookie ⇒ detects the redirect to /login and ends RED', { skip: skipReal, timeout: 60_000 }, async () => {
  const dir = flowFile();
  const r = await runVerify(loadFlow(join(dir, 'f.yaml'), { env: { T_COOKIE: 'bad=1' } }), { url: appUrl, driver: 'playwright', cwd: ROOT });
  assert.equal(r.exitCode, 1, formatReport(r));
  assert.match(r.rows[0].note, /redirected \/items → \/login/);
});
