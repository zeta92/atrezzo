import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseHeaders, parseHeaderArgs, headerLines, mergeHeaders, parseResponseHeaders, mergeResponseHeaders, maskHeaders, isSecretHeader, redact, MASK } from '../scripts/lib/headers.mjs';
import { loadFlow, normalizeScenario } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { scenarioHash } from '../scripts/lib/world.mjs';
import { usedCapabilities } from '../scripts/lib/capabilities.mjs';
import { runVerify, formatReport, loadPlaywright, chromeExecutable } from '../scripts/lib/verify.mjs';
import { AtrezzoError } from '../scripts/lib/errors.mjs';
import { FLOW, SCENARIO, ROOT, tmpProject, cliAsync } from './helpers.mjs';

const FIXTURE = 'sb-app-auth-token=fixture-cookie-value-VALUE-that-must-not-leak';
const collect = () => { const list = []; return { list, add: (f, m) => list.push(`${f}: ${m}`) }; };

// ---------- parsing ----------

test('parseHeaders: valid map, numbers to strings, values taken literally', () => {
  const is = collect();
  const h = parseHeaders({ 'X-Tenant': 'acme', 'X-Num': 3, 'Accept-Language': ' es-ES ' }, 'headers', is);
  assert.deepEqual(is.list, []);
  assert.deepEqual(h, { 'X-Tenant': 'acme', 'X-Num': '3', 'Accept-Language': 'es-ES' });
  assert.deepEqual(parseHeaders(undefined, 'headers', is), {});
});

test('parseHeaders: errors with field and reason', () => {
  const is = collect();
  parseHeaders(['Cookie: x'], 'headers', is);
  parseHeaders({ 'Bad Name': 'x', Obj: { a: 1 }, Cookie: '${SESSION}', Break: 'a\r\nInjected: 1' }, 'steps[0].headers', is);
  assert.equal(is.list.length, 5, is.list.join('\n'));
  assert.match(is.list[0], /^headers: must be a map/);
  assert.ok(is.list.some((l) => /steps\[0\]\.headers\.Bad Name: invalid header name/.test(l)));
  assert.ok(is.list.some((l) => /Obj: must be a string/.test(l)));
  assert.ok(is.list.some((l) => /steps\[0\]\.headers\.Cookie: \$\{…\} is not expanded.*--header "Cookie: <value>"/.test(l)));
  assert.ok(is.list.some((l) => /line breaks/.test(l)));
});

test('parseHeaderArgs: "Name: value" like curl -H; the value may contain colons; later wins', () => {
  assert.deepEqual(parseHeaderArgs([`Cookie: ${FIXTURE}`, 'X-Url: http://a:1/b', 'cookie: last=1']), { cookie: 'last=1', 'X-Url': 'http://a:1/b' });
  assert.deepEqual(parseHeaderArgs([]), {});
  assert.deepEqual(headerLines(`Cookie: ${FIXTURE}\r\n\n  X-Tenant: acme \n`), [`Cookie: ${FIXTURE}`, 'X-Tenant: acme']);
});

test('parseHeaderArgs: bad input is exit 3, names the header and never echoes the value', () => {
  for (const [items, re] of [[['no-colon'], /expected "Name: value"/], [['Bad Name: x'], /valid header name/], [['Cookie:   '], /--header Cookie: the value is empty/]]) {
    assert.throws(() => parseHeaderArgs(items), (e) => e instanceof AtrezzoError && e.exitCode === 3 && re.test(e.message), items[0]);
  }
  assert.throws(() => parseHeaderArgs([`Cookie: ${FIXTURE}`, 'Oops']), (e) => !e.message.includes('fixture-cookie-value'));
});

// ---------- merge ----------

test('mergeHeaders: the step overrides the flow case-insensitively; the rest is kept', () => {
  const m = mergeHeaders({ Cookie: 'a=1', 'Accept-Language': 'en' }, { 'accept-language': 'es-ES', 'X-Extra': '1' });
  assert.deepEqual(m, { Cookie: 'a=1', 'accept-language': 'es-ES', 'X-Extra': '1' });
  assert.deepEqual(mergeHeaders({ A: '1' }, undefined), { A: '1' });
});

// ---------- response headers ----------

test('parseResponseHeaders: valid scalars are lowercased/stringified/trimmed, set-cookie stays a list, ${SESSION} is literal', () => {
  const is = collect();
  const h = parseResponseHeaders({
    'X-Tenant': ' acme ',
    'X-Count': 42,
    'X-Enabled': true,
    'X-Template': '${SESSION}',
    'Set-Cookie': [' a=1; Path=/ ', 'b=2; HttpOnly'],
  }, 'endpoints[0].headers', is);
  assert.deepEqual(is.list, []);
  assert.deepEqual(h, {
    'x-tenant': 'acme',
    'x-count': '42',
    'x-enabled': 'true',
    'x-template': '${SESSION}',
    'set-cookie': ['a=1; Path=/', 'b=2; HttpOnly'],
  });
  assert.ok(Array.isArray(h['set-cookie']));
  assert.deepEqual(parseResponseHeaders(undefined, 'endpoints[0].headers', is), {});
  assert.deepEqual(is.list, []);
});

test('parseResponseHeaders: rejects invalid names, case-insensitive duplicates, CR/LF, bad lists, and managed transport headers', () => {
  {
    const is = collect();
    const out = parseResponseHeaders({ 'Bad Name': 'x' }, 'endpoints[0].headers', is);
    assert.deepEqual(out, {});
    assert.equal(is.list.length, 1);
    assert.match(is.list[0], /^endpoints\[0\]\.headers\.Bad Name: invalid header name$/);
  }
  {
    const is = collect();
    const out = parseResponseHeaders({ 'X-Foo': 'a', 'x-foo': 'b' }, 'endpoints[0].headers', is);
    assert.deepEqual(out, { 'x-foo': 'a' });
    assert.equal(is.list.length, 1);
    assert.match(is.list[0], /^endpoints\[0\]\.headers\.x-foo: duplicate header "x-foo" \(already declared as "X-Foo"\)$/);
  }
  {
    const is = collect();
    const out = parseResponseHeaders({
      'X-Cr': 'a\rb',
      'X-Lf': 'a\nb',
      'X-Crlf': 'a\r\nInjected: 1',
      'Set-Cookie': ['ok=1', 'bad=1\r\nInjected: 1'],
    }, 'endpoints[0].headers', is);
    assert.deepEqual(out, {});
    assert.equal(is.list.length, 4);
    assert.match(is.list[0], /^endpoints\[0\]\.headers\.X-Cr: .*line breaks/);
    assert.match(is.list[1], /^endpoints\[0\]\.headers\.X-Lf: .*line breaks/);
    assert.match(is.list[2], /^endpoints\[0\]\.headers\.X-Crlf: .*line breaks/);
    assert.match(is.list[3], /^endpoints\[0\]\.headers\.Set-Cookie\[1\]: .*line breaks/);
  }
  {
    const is = collect();
    const out = parseResponseHeaders({ 'X-Multi': ['a', 'b'] }, 'endpoints[0].headers', is);
    assert.deepEqual(out, {});
    assert.equal(is.list.length, 1);
    assert.match(is.list[0], /^endpoints\[0\]\.headers\.X-Multi: must be a scalar value; only "set-cookie" accepts a list of strings$/);
  }
  {
    const is = collect();
    const out = parseResponseHeaders({ 'Set-Cookie': [] }, 'endpoints[0].headers', is);
    assert.deepEqual(out, {});
    assert.equal(is.list.length, 1);
    assert.match(is.list[0], /^endpoints\[0\]\.headers\.Set-Cookie: must be a string or a non-empty list of strings$/);
  }
  {
    const is = collect();
    const out = parseResponseHeaders({ 'Set-Cookie': ['a=1', 123] }, 'endpoints[0].headers', is);
    assert.deepEqual(out, {});
    assert.equal(is.list.length, 1);
    assert.match(is.list[0], /^endpoints\[0\]\.headers\.Set-Cookie\[1\]: must be a string; got number$/);
  }
  for (const [rawName, canonical] of [['Content-Length', 'content-length'], ['Connection', 'connection'], ['Date', 'date']]) {
    const is = collect();
    const out = parseResponseHeaders({ [rawName]: 'value' }, 'endpoints[0].headers', is);
    assert.deepEqual(out, {});
    assert.equal(is.list.length, 1, rawName);
    assert.match(is.list[0], new RegExp(`^endpoints\\[0\\]\\.headers\\.${rawName}: forbidden response header "${canonical}"`));
  }
});

test('parseResponseHeaders: rejects NUL/control characters and Unicode code points above HTTP obs-text without echoing values', () => {
  for (const [value, forbidden] of [
    ['x\u0000y', ['x\u0000y', '\u0000', JSON.stringify('x\u0000y')]],
    ['euro €', ['euro €', 'euro', '€']],
  ]) {
    const is = collect();
    const out = parseResponseHeaders({ bad: value }, 'endpoints[0].headers', is);
    assert.deepEqual(out, {});
    assert.equal(is.list.length, 1);
    assert.match(is.list[0], /^endpoints\[0\]\.headers\.bad: .+/);
    for (const token of forbidden) {
      assert.ok(!is.list[0].includes(token), `issue must not echo header value: ${is.list[0]}`);
    }
  }
});

test('mergeResponseHeaders: higher scalar wins case-insensitively; set-cookie appends across layers as an array', () => {
  const merged = mergeResponseHeaders(
    { 'Cache-Control': 'no-cache', 'X-Base': '1', 'Set-Cookie': 'a=1; Path=/' },
    { 'cache-control': 'max-age=60', 'X-Top': '2', 'set-cookie': ['b=2; Path=/', 'c=3; HttpOnly'] },
  );
  assert.deepEqual(merged, {
    'cache-control': 'max-age=60',
    'x-base': '1',
    'x-top': '2',
    'set-cookie': ['a=1; Path=/', 'b=2; Path=/', 'c=3; HttpOnly'],
  });
  assert.ok(Array.isArray(merged['set-cookie']));

  const fromTwoArrays = mergeResponseHeaders(
    { 'Set-Cookie': ['a=1'] },
    undefined,
    { 'SET-COOKIE': ['b=2'] },
  );
  assert.deepEqual(fromTwoArrays, { 'set-cookie': ['a=1', 'b=2'] });
  assert.ok(Array.isArray(fromTwoArrays['set-cookie']));

  const singleScalarCookie = mergeResponseHeaders({ 'Set-Cookie': 'only=1' });
  assert.deepEqual(singleScalarCookie, { 'set-cookie': ['only=1'] });
  assert.ok(Array.isArray(singleScalarCookie['set-cookie']));
});

// ---------- secrets ----------

test('maskHeaders / redact: Cookie and Authorization never appear in clear text', () => {
  for (const n of ['Cookie', 'authorization', 'Proxy-Authorization', 'X-Api-Key', 'X-Session-Id', 'X-Auth-Token']) assert.ok(isSecretHeader(n), n);
  for (const n of ['Accept-Language', 'Accept', 'User-Agent']) assert.ok(!isSecretHeader(n), n);
  const h = { Cookie: FIXTURE, Authorization: 'Bearer abc.def.ghi', 'Accept-Language': 'es-ES' };
  assert.deepEqual(maskHeaders(h), { Cookie: MASK, Authorization: MASK, 'Accept-Language': 'es-ES' });
  const msg = redact(`failed sending ${FIXTURE}; auth=Bearer abc.def.ghi`, h);
  assert.ok(!msg.includes('fixture-cookie-value') && !msg.includes('abc.def.ghi'), msg);
});

// ---------- flow ----------

test('loadFlow: flow and step headers, viewport, and optional scenario', () => {
  const dir = tmpProject({ 'f.yaml': `base_url: http://127.0.0.1:1
viewport: { width: 1440, height: 1000 }
headers:
  X-Tenant: acme
steps:
  - screen: customers
    visit: /customers
    headers: { Accept-Language: es-ES }
    expect:
      - selector: "table tbody tr"
        count: 6
` });
  const f = loadFlow(join(dir, 'f.yaml'));
  assert.equal(f.scenario, null);
  assert.deepEqual(f.viewport, { width: 1440, height: 1000 });
  assert.deepEqual(f.headers, { 'X-Tenant': 'acme' });
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
  assert.throws(() => loadFlow(join(dir, 'f.yaml')), (e) => e instanceof AtrezzoError && /field "headers"/.test(e.message) && /viewport\.width/.test(e.message) && /viewport\.height/.test(e.message));
  const dir2 = tmpProject({ 'f.yaml': `steps:\n  - screen: a\n    visit: /\n    headers: { Cookie: "\${NOPE}" }\n    expect: [{ selector: x, count: 1 }]\n` });
  assert.throws(() => loadFlow(join(dir2, 'f.yaml')), /steps\[0\]\.headers\.Cookie.*not expanded.*--header/s);
});

// ---------- http driver: sends the headers ----------

let app; let appUrl; const seen = [];
before(async () => {
  // Minimal "real" app: without a valid cookie, /api/* returns 401 and pages redirect to /login.
  app = createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie, lang: req.headers['accept-language'], tenant: req.headers['x-tenant'] });
    const ok = req.headers.cookie === FIXTURE;
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

// The flow commits only what is safe (X-Tenant, Accept-Language); the session comes from --header.
const flowFile = (extra = '') => tmpProject({ 'f.yaml': `headers:
  X-Tenant: acme
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

test('http driver: --header joins the flow and step headers in fetch; the report hides the secret', async () => {
  const dir = flowFile();
  seen.length = 0;
  const r = await runVerify(loadFlow(join(dir, 'f.yaml')), { url: appUrl, driver: 'http', headers: { Cookie: FIXTURE } });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(seen.map((s) => [s.url, s.cookie, s.lang, s.tenant]), [['/api/items', FIXTURE, 'es-ES', 'acme']]);
  const report = formatReport(r);
  assert.match(report, /Headers: X-Tenant: acme · Cookie: \*\*\* · Accept-Language: es-ES/);
  assert.ok(!report.includes('fixture-cookie-value') && !JSON.stringify(r).includes('fixture-cookie-value'));
});

test('http driver: without a valid cookie ⇒ RED (401), not green', async () => {
  const dir = flowFile();
  const r = await runVerify(loadFlow(join(dir, 'f.yaml')), { url: appUrl, driver: 'http', diagnose: true, headers: { Cookie: 'other=1' } });
  assert.equal(r.exitCode, 1);
  assert.ok(r.rows[0].hypotheses.some((h) => h.type === 'non-200-response'));
});

test('CLI verify --header: combined with the flow headers; the secret appears in neither stdout nor stderr', async () => {
  const dir = flowFile();
  for (const extra of [[], ['--json']]) {
    seen.length = 0;
    const r = await cliAsync(['verify', 'f.yaml', '--url', appUrl, '--header', `Cookie: ${FIXTURE}`, '--header', 'X-Trace: 42', ...extra], dir);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.deepEqual(seen.map((s) => [s.cookie, s.tenant, s.lang]), [[FIXTURE, 'acme', 'es-ES']]);
    assert.ok(!(r.stdout + r.stderr).includes('fixture-cookie-value'), r.stdout);
    if (extra.length) assert.deepEqual(JSON.parse(r.stdout).headers, { 'X-Tenant': 'acme', Cookie: MASK, 'X-Trace': '42', 'Accept-Language': 'es-ES' });
    else assert.match(r.stdout, /Headers: X-Tenant: acme · Cookie: \*\*\* · X-Trace: 42 · Accept-Language: es-ES/);
  }
});

test('CLI verify --header does not override a header the step sets itself', async () => {
  const dir = flowFile();
  seen.length = 0;
  const r = await cliAsync(['verify', 'f.yaml', '--url', appUrl, '--header', `Cookie: ${FIXTURE}`, '--header', 'Accept-Language: fr-FR'], dir);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(seen[0].lang, 'es-ES');
  assert.match(r.stdout, /Accept-Language: es-ES/);
});

test('CLI verify --header @-: the header comes from stdin, never from argv or the environment', async () => {
  const dir = flowFile();
  seen.length = 0;
  const r = await cliAsync(['verify', 'f.yaml', '--url', appUrl, '--header', '@-'], dir, { SESSION: 'ignored=1' }, `Cookie: ${FIXTURE}\n`);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(seen[0].cookie, FIXTURE);
  assert.match(r.stdout, /Cookie: \*\*\*/);
  assert.ok(!(r.stdout + r.stderr).includes('fixture-cookie-value'));
  const empty = await cliAsync(['verify', 'f.yaml', '--url', appUrl, '--header', '@-'], dir, {}, '');
  assert.equal(empty.code, 3);
  assert.match(empty.stderr, /stdin had no "Name: value" line/);
});

test('CLI verify: a flow that still says ${VAR} is invalid (exit 3) and the environment is not read', async () => {
  const dir = tmpProject({ 'f.yaml': 'headers:\n  Cookie: "${SESSION}"\nsteps:\n  - screen: a\n    requests: { items: GET /api/items }\n    expect: [{ selector: x, count: 3, data: { request: items } }]\n' });
  seen.length = 0;
  const r = await cliAsync(['verify', 'f.yaml', '--url', appUrl], dir, { SESSION: FIXTURE });
  assert.equal(r.code, 3, r.stderr + r.stdout);
  assert.match(r.stderr, /headers\.Cookie.*not expanded.*--header "Cookie: <value>"/s);
  assert.equal(seen.length, 0);
  assert.ok(!(r.stdout + r.stderr).includes('fixture-cookie-value'));
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
  const r = await runVerify(loadFlow(join(dir, 'f.yaml')), { url: appUrl, driver: 'playwright', pageFactory: fp.factory, headers: { Cookie: FIXTURE } });
  assert.equal(r.exitCode, 0, formatReport(r));
  assert.deepEqual(fp.calls.viewport, { width: 1440, height: 1000 });
  assert.deepEqual(fp.calls.headers, [{ 'X-Tenant': 'acme', 'Accept-Language': 'es-ES', Cookie: FIXTURE }]);
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
  assert.equal(chromeExecutable('playwright', '/x/chrome'), '/x/chrome');
  assert.equal(chromeExecutable('playwright', undefined), undefined);
  if (existsSync('/usr/bin/chromium')) assert.equal(chromeExecutable('playwright-core', undefined), '/usr/bin/chromium');
});

// ---------- REAL playwright driver (actual Chromium), when available ----------

const realPw = await loadPlaywright(ROOT);
const realChrome = realPw && (chromeExecutable(realPw.name) ?? (realPw.name !== 'playwright-core' ? 'bundled' : null));
const skipReal = !realPw ? 'playwright(-core) not installed in the repo' : !realChrome || (realChrome !== 'bundled' && !existsSync(realChrome)) ? 'no Chromium (set ATREZZO_CHROME)' : false;

test('real playwright driver: counts in the DOM with the flow cookie', { skip: skipReal, timeout: 60_000 }, async () => {
  const dir = flowFile('viewport: { width: 1440, height: 1000 }\n');
  const r = await runVerify(loadFlow(join(dir, 'f.yaml')), { url: appUrl, driver: 'playwright', cwd: ROOT, headers: { Cookie: FIXTURE } });
  assert.equal(r.exitCode, 0, formatReport(r));
  assert.equal(r.rows[0].obtained, 3);
});

test('real playwright driver: invalid cookie ⇒ detects the redirect to /login and ends RED', { skip: skipReal, timeout: 60_000 }, async () => {
  const dir = flowFile();
  const r = await runVerify(loadFlow(join(dir, 'f.yaml')), { url: appUrl, driver: 'playwright', cwd: ROOT, headers: { Cookie: 'bad=1' } });
  assert.equal(r.exitCode, 1, formatReport(r));
  assert.match(r.rows[0].note, /redirected \/items → \/login/);
});

test('endpoint `headers: {}` normalizes like omitting headers: same hash, no response-headers capability', () => {
  const yaml = (extra) => `name: empty-headers-hash\nseed: 5\nworld:\n  items: 2\nendpoints:\n  - path: /api/items\n    entity: items\n${extra}`;
  const parse = (extra) => normalizeScenario(parseYaml(yaml(extra), 't.yaml'), 't.yaml');
  const omitted = parse('');
  const empty = parse('    headers: {}\n');
  assert.equal('headers' in empty.endpoints[0], false);
  assert.equal(scenarioHash(empty), scenarioHash(omitted));
  assert.equal(usedCapabilities(empty).some((c) => c.id === 'response-headers'), false);
});
