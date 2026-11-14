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

const SECRET = 'sb-app-auth-token=s3cr3t-VALOR-que-no-debe-salir';
const collect = () => { const list = []; return { list, add: (f, m) => list.push(`${f}: ${m}`) }; };

// ---------- parseo ----------

test('parseHeaders: mapa válido, números a texto, ${VAR} desde el entorno', () => {
  const is = collect();
  const h = parseHeaders({ Cookie: '${C}', 'X-Num': 3, 'Accept-Language': ' es-ES ' }, 'headers', is, { C: SECRET });
  assert.deepEqual(is.list, []);
  assert.deepEqual(h, { Cookie: SECRET, 'X-Num': '3', 'Accept-Language': 'es-ES' });
  assert.deepEqual(parseHeaders(undefined, 'headers', is), {});
});

test('parseHeaders: errores con campo y motivo', () => {
  const is = collect();
  parseHeaders(['Cookie: x'], 'headers', is);
  parseHeaders({ 'Mal Nombre': 'x', Obj: { a: 1 }, Cookie: '${NO_EXISTE}', Salto: 'a\r\nInyectada: 1' }, 'steps[0].headers', is, {});
  assert.equal(is.list.length, 5, is.list.join('\n'));
  assert.match(is.list[0], /^headers: debe ser un mapa/);
  assert.ok(is.list.some((l) => /steps\[0\]\.headers\.Mal Nombre: nombre de cabecera inválido/.test(l)));
  assert.ok(is.list.some((l) => /Obj: debe ser texto/.test(l)));
  assert.ok(is.list.some((l) => /\$\{NO_EXISTE\}.*no está definida/.test(l)));
  assert.ok(is.list.some((l) => /saltos de línea/.test(l)));
});

// ---------- merge ----------

test('mergeHeaders: el paso pisa al flujo sin distinguir mayúsculas; el resto se conserva', () => {
  const m = mergeHeaders({ Cookie: 'a=1', 'Accept-Language': 'en' }, { 'accept-language': 'es-ES', 'X-Extra': '1' });
  assert.deepEqual(m, { Cookie: 'a=1', 'accept-language': 'es-ES', 'X-Extra': '1' });
  assert.deepEqual(mergeHeaders({ A: '1' }, undefined), { A: '1' });
});

// ---------- secretos ----------

test('maskHeaders / redact: Cookie y Authorization nunca salen en claro', () => {
  for (const n of ['Cookie', 'authorization', 'Proxy-Authorization', 'X-Api-Key', 'X-Session-Id', 'X-Auth-Token']) assert.ok(isSecretHeader(n), n);
  for (const n of ['Accept-Language', 'Accept', 'User-Agent']) assert.ok(!isSecretHeader(n), n);
  const h = { Cookie: SECRET, Authorization: 'Bearer abc.def.ghi', 'Accept-Language': 'es-ES' };
  assert.deepEqual(maskHeaders(h), { Cookie: MASK, Authorization: MASK, 'Accept-Language': 'es-ES' });
  const msg = redact(`fallo enviando ${SECRET}; auth=Bearer abc.def.ghi`, h);
  assert.ok(!msg.includes('s3cr3t') && !msg.includes('abc.def.ghi'), msg);
});

// ---------- flujo ----------

test('loadFlow: headers de flujo y de paso, viewport, y escenario opcional', () => {
  const dir = tmpProject({ 'f.yaml': `base_url: http://127.0.0.1:1
viewport: { width: 1440, height: 1000 }
headers:
  Cookie: "\${MI_COOKIE}"
steps:
  - screen: clientes
    visit: /clientes
    headers: { Accept-Language: es-ES }
    expect:
      - selector: "table tbody tr"
        count: 6
` });
  const f = loadFlow(join(dir, 'f.yaml'), { env: { MI_COOKIE: SECRET } });
  assert.equal(f.scenario, null);
  assert.deepEqual(f.viewport, { width: 1440, height: 1000 });
  assert.deepEqual(f.headers, { Cookie: SECRET });
  assert.deepEqual(f.steps[0].headers, { 'Accept-Language': 'es-ES' });
});

test('loadFlow: los flujos existentes (sin headers) siguen cargando igual', () => {
  const dir = tmpProject({ 'escenarios/conciliacion.yaml': SCENARIO, 'flujo.yaml': FLOW });
  const f = loadFlow(join(dir, 'flujo.yaml'));
  assert.deepEqual(f.headers, {});
  assert.equal(f.viewport, null);
  assert.ok(f.steps.every((s) => Object.keys(s.headers).length === 0));
  assert.equal(f.scenario.name, 'conciliacion');
});

test('loadFlow: headers o viewport inválidos ⇒ AtrezzoError con el campo, sin filtrar el valor', () => {
  const dir = tmpProject({ 'f.yaml': `headers: [Cookie]\nviewport: { width: 10 }\nsteps:\n  - screen: a\n    visit: /\n    headers: { Cookie: "\${NOPE}" }\n    expect: [{ selector: x, count: 1 }]\n` });
  assert.throws(() => loadFlow(join(dir, 'f.yaml'), { env: {} }), (e) => e instanceof AtrezzoError && /campo "headers"/.test(e.message) && /viewport\.width/.test(e.message) && /viewport\.height/.test(e.message));
  const dir2 = tmpProject({ 'f.yaml': `steps:\n  - screen: a\n    visit: /\n    headers: { Cookie: "\${NOPE}" }\n    expect: [{ selector: x, count: 1 }]\n` });
  assert.throws(() => loadFlow(join(dir2, 'f.yaml'), { env: {} }), /steps\[0\]\.headers\.Cookie.*NOPE/);
});

// ---------- driver http: envía las cabeceras ----------

let app; let appUrl; const seen = [];
before(async () => {
  // App "real" mínima: sin cookie válida, /api/* da 401 y las páginas redirigen a /login.
  app = createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie, lang: req.headers['accept-language'] });
    const ok = req.headers.cookie === SECRET;
    if (req.url.startsWith('/api/items')) {
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(ok ? [{ id: 1 }, { id: 2 }, { id: 3 }] : { error: 'no autenticado' }));
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

test('driver http: las cabeceras efectivas viajan en fetch y el informe no muestra el secreto', async () => {
  const dir = flowFile();
  seen.length = 0;
  const r = await runVerify(loadFlow(join(dir, 'f.yaml'), { env: { T_COOKIE: SECRET } }), { url: appUrl, driver: 'http' });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(seen.map((s) => [s.url, s.cookie, s.lang]), [['/api/items', SECRET, 'es-ES']]);
  const report = formatReport(r);
  assert.match(report, /Cabeceras: Cookie: \*\*\* · Accept-Language: es-ES/);
  assert.ok(!report.includes('s3cr3t') && !JSON.stringify(r).includes('s3cr3t'));
});

test('driver http: sin cookie válida ⇒ ROJO (401), no verde', async () => {
  const dir = flowFile();
  const r = await runVerify(loadFlow(join(dir, 'f.yaml'), { env: { T_COOKIE: 'otra=1' } }), { url: appUrl, driver: 'http', diagnose: true });
  assert.equal(r.exitCode, 1);
  assert.ok(r.rows[0].hypotheses.some((h) => h.tipo === 'respuesta-no-200'));
});

test('CLI verify --json: el secreto no aparece en stdout ni stderr', async () => {
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

test('driver playwright: context.setExtraHTTPHeaders con las cabeceras del paso y viewport del flujo', async () => {
  const dir = flowFile('viewport: { width: 1440, height: 1000 }\n');
  const fp = fakePw({ counts: { 'table tbody tr': 3 } });
  const r = await runVerify(loadFlow(join(dir, 'f.yaml'), { env: { T_COOKIE: SECRET } }), { url: appUrl, driver: 'playwright', pageFactory: fp.factory });
  assert.equal(r.exitCode, 0, formatReport(r));
  assert.deepEqual(fp.calls.viewport, { width: 1440, height: 1000 });
  assert.deepEqual(fp.calls.headers, [{ Cookie: SECRET, 'Accept-Language': 'es-ES' }]);
});

test('driver playwright: redirect a /login ⇒ KO aunque el conteo cuadre por casualidad', async () => {
  const dir = tmpProject({ 'f.yaml': 'steps:\n  - screen: vacia\n    visit: /items\n    expect:\n      - selector: ".error"\n        count: 0\n' });
  const fp = fakePw({ finalPath: '/login?next=%2Fitems' });
  const r = await runVerify(loadFlow(join(dir, 'f.yaml')), { url: appUrl, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.equal(r.rows[0].obtained, 0);
  assert.equal(r.rows[0].status, 'KO');
  assert.match(r.rows[0].note, /redirigió \/items → \/login\?next=%2Fitems.*login/);
  assert.equal(r.rows[0].hypotheses[0].tipo, 'navegacion');
});

test('chromeExecutable: ATREZZO_CHROME manda; playwright-core usa el Chromium del sistema', () => {
  assert.equal(chromeExecutable('playwright', { ATREZZO_CHROME: '/x/chrome' }), '/x/chrome');
  assert.equal(chromeExecutable('playwright', {}), undefined);
  if (existsSync('/usr/bin/chromium')) assert.equal(chromeExecutable('playwright-core', {}), '/usr/bin/chromium');
});

// ---------- driver playwright REAL (Chromium de verdad), si está disponible ----------

const realPw = await loadPlaywright(ROOT);
const realChrome = realPw && (chromeExecutable(realPw.name) ?? (realPw.name !== 'playwright-core' ? 'bundled' : null));
const skipReal = !realPw ? 'playwright(-core) no instalado en el repo' : !realChrome || (realChrome !== 'bundled' && !existsSync(realChrome)) ? 'sin Chromium (define ATREZZO_CHROME)' : false;

test('driver playwright real: cuenta en el DOM con la cookie del flujo', { skip: skipReal, timeout: 60_000 }, async () => {
  const dir = flowFile('viewport: { width: 1440, height: 1000 }\n');
  const r = await runVerify(loadFlow(join(dir, 'f.yaml'), { env: { T_COOKIE: SECRET } }), { url: appUrl, driver: 'playwright', cwd: ROOT });
  assert.equal(r.exitCode, 0, formatReport(r));
  assert.equal(r.rows[0].obtained, 3);
});

test('driver playwright real: cookie inválida ⇒ detecta el redirect a /login y sale ROJO', { skip: skipReal, timeout: 60_000 }, async () => {
  const dir = flowFile();
  const r = await runVerify(loadFlow(join(dir, 'f.yaml'), { env: { T_COOKIE: 'mala=1' } }), { url: appUrl, driver: 'playwright', cwd: ROOT });
  assert.equal(r.exitCode, 1, formatReport(r));
  assert.match(r.rows[0].note, /redirigió \/items → \/login/);
});
