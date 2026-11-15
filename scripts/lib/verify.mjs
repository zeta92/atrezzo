// Verification loop: run the flow steps against a served mock, compare with the
// expectations, and (optionally) diagnose mismatches instead of regenerating.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AtrezzoError, EXIT } from './errors.mjs';
import { generateWorld } from './world.mjs';
import { mergeHeaders, maskHeaders, redact, formatHeaders } from './headers.mjs';
import { chromePath } from './env.mjs';

// ---------- helpers ----------

function extractItems(body, pick) {
  let v = body;
  if (pick) for (const k of pick.split('.')) v = v?.[k];
  else if (v && !Array.isArray(v) && Array.isArray(v.data)) v = v.data;
  if (Array.isArray(v)) return v;
  return v === undefined || v === null ? [] : [v];
}

function whereMatch(item, where) {
  if (!where) return true;
  return Object.entries(where).every(([k, w]) => {
    const values = Array.isArray(w) ? w : [w];
    return values.some((x) => String(x) === String(item?.[k] ?? null));
  });
}

function expectedText(e) {
  if (e.count !== undefined) return `=${e.count}`;
  if (e.min !== undefined && e.max !== undefined) return `${e.min}..${e.max}`;
  if (e.min !== undefined) return `>=${e.min}`;
  return `<=${e.max}`;
}

function passes(e, n) {
  if (e.count !== undefined) return n === e.count;
  if (e.min !== undefined && n < e.min) return false;
  if (e.max !== undefined && n > e.max) return false;
  return true;
}

function joinUrl(base, path) {
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString().replace(/([^:]\/)\/+/g, '$1');
}

async function getJson(fetchImpl, url, init) {
  const res = init ? await fetchImpl(url, init) : await fetchImpl(url);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, headers: res.headers, body };
}

function header(h, name) {
  return typeof h?.get === 'function' ? h.get(name) : h?.[name] ?? null;
}

function withoutPagination(path) {
  const u = new URL(path, 'http://x');
  for (const k of ['limit', 'offset', 'page', 'per_page', 'pageSize', 'skip', 'take']) u.searchParams.delete(k);
  return u.pathname + (u.search || '');
}

// ---------- diagnosis ----------

/**
 * Build hypotheses for a failed assertion. Pure function: all evidence comes in `ctx`.
 * ctx: { expected, obtained, driver, response?, items?, matched?, fullMatched?, domCount? }
 */
export function diagnose(row, ctx) {
  const hyps = [];
  const add = (type, confidence, evidence) => hyps.push({ type, confidence, evidence });
  const exp = row.expect;
  const target = exp.count ?? exp.min ?? exp.max;
  const r = ctx.response;
  if (r && r.status !== 200) add('non-200-response', 'high', `the request returned ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
  if (r) {
    const ignored = header(r.headers, 'x-atrezzo-ignored');
    if (ignored) add('undeclared-filter', 'medium', `the client sends parameters the contract does not declare as filters, so they were ignored: ${ignored}. If the client expects the server to filter, add them to endpoints[].filters.`);
  }
  if (ctx.items) {
    const total = Number(header(r?.headers, 'x-total-count'));
    if (Number.isFinite(total) && total > ctx.items.length && ctx.fullMatched !== undefined && ctx.fullMatched >= target && ctx.matched < target) {
      add('pagination-mismatch', 'high', `the response has ${ctx.items.length} of ${total} items; unpaginated, ${ctx.fullMatched} match the condition, but this page has only ${ctx.matched}. Check the client's limit/offset or the endpoint's sort.`);
    }
    const ids = ctx.items.map((i) => i?.id).filter((x) => x !== undefined);
    const dup = ids.length - new Set(ids).size;
    if (dup > 0) add('dedupe-by-id', 'high', `${dup} repeated ids in the response; if the client dedupes by id it renders ${new Set(ids).size} rows.`);
    const nullFields = {};
    for (const it of ctx.items) for (const [k, v] of Object.entries(it ?? {})) if (v === null) nullFields[k] = (nullFields[k] ?? 0) + 1;
    const nullRows = ctx.items.filter((it) => Object.values(it ?? {}).some((v) => v === null)).length;
    if (nullRows > 0) {
      const strong = ctx.domCount !== undefined && ctx.domCount === ctx.matched - nullRows;
      add('null-field', strong ? 'high' : 'low', `${nullRows} items with null fields (${Object.entries(nullFields).map(([k, n]) => `${k}: ${n}`).join(', ')}); if the client drops them or crashes rendering them, rows go missing. See references/suposiciones.md.`);
    }
    if (ctx.domCount !== undefined && ctx.domCount < ctx.matched && dup === 0 && nullRows === 0) {
      add('client-side-filter', 'medium', `the JSON has ${ctx.matched} matching items, the DOM shows ${ctx.domCount}: the client filters or hides items. The scenario is right; look at the component.`);
    }
    if (ctx.domCount !== undefined && ctx.matched === target && ctx.domCount !== target) {
      add('render', 'high', `the mock delivers exactly what was expected (${target}); the difference is in the screen, not the scenario. Do not regenerate the world.`);
    }
    if (ctx.domCount === undefined && ctx.fullMatched !== undefined && ctx.fullMatched !== target && ctx.matched === ctx.fullMatched) {
      add('world-mismatch', 'medium', `the world has ${ctx.fullMatched} matching items and ${expectedText(exp)} were expected: check world (total/distribution) or the assertion's "where" condition.`);
    }
  } else if (ctx.domCount !== undefined) {
    add('no-data', 'low', 'the assertion has no "data" to compare against the JSON; add data.request to tell a data failure from a screen failure.');
  }
  if (!hyps.length) add('no-hypothesis', 'low', `obtained ${ctx.obtained}, expected ${expectedText(exp)}; no heuristic fits. Check the screen path and the selectors.`);
  return hyps;
}

// ---------- playwright ----------

const PW_MODULES = ['playwright', '@playwright/test', 'playwright-core'];
export const DEFAULT_CHROME = '/usr/bin/chromium';

/** Resolve playwright lazily from the project. Returns { mod, name } or null. */
export async function loadPlaywright(cwd) {
  const req = createRequire(join(cwd, 'package.json'));
  for (const name of PW_MODULES) {
    try { return { mod: await import(pathToFileURL(req.resolve(name)).href), name }; } catch { /* next */ }
  }
  return null;
}

/** executablePath to use: ATREZZO_CHROME wins; playwright-core (no bundled browsers) falls back to the system Chromium. */
export function chromeExecutable(moduleName, override = chromePath()) {
  if (override) return override;
  if (moduleName === 'playwright-core' && existsSync(DEFAULT_CHROME)) return DEFAULT_CHROME;
  return undefined;
}

async function defaultPageFactory(cwd, { viewport } = {}) {
  const pw = await loadPlaywright(cwd);
  if (!pw) {
    throw new AtrezzoError('The playwright driver needs the "playwright" (or "playwright-core") package, which is not installed in this project.\n  Add playwright-core to the project\'s devDependencies with your package manager (it uses the system Chromium; ATREZZO_CHROME=/path for another binary),\n  or playwright together with its Chromium browser.\n  Or use --driver http. Nothing was verified.', { exitCode: EXIT.UNVERIFIABLE });
  }
  const chromium = pw.mod.chromium ?? pw.mod.default?.chromium;
  const executablePath = chromeExecutable(pw.name);
  let browser;
  try { browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] }); } catch (e) {
    const hint = executablePath ? `does ${executablePath} exist and is it executable? (override with ATREZZO_CHROME=/path)` : 'Set ATREZZO_CHROME=/path/to/chromium';
    throw new AtrezzoError(`${pw.name} is installed but cannot launch Chromium: ${e.message.split('\n')[0]}\n  ${hint}`, { exitCode: EXIT.UNVERIFIABLE });
  }
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  return { page, context, close: () => browser.close() };
}

const normPath = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const LOGIN_RE = /(^|\/)(login|signin|sign-in|iniciar-sesion|auth)(\/|$)/i;

/**
 * Open a step's page. Returns null if the page is the one asked for, or a sentence
 * explaining why the step can't be trusted (redirect, HTTP error, wait_for timeout).
 */
async function openStep(pw, url, step, headers) {
  const target = joinUrl(url, step.visit);
  if (pw.context?.setExtraHTTPHeaders) await pw.context.setExtraHTTPHeaders(headers);
  else await pw.page.setExtraHTTPHeaders?.(headers);
  let resp;
  try { resp = await pw.page.goto(target); } catch (e) {
    return redact(`could not open ${step.visit}: ${e.message.split('\n')[0]}`, headers);
  }
  await pw.page.waitForLoadState?.('networkidle', { timeout: 15_000 })?.catch?.(() => {});
  const finalUrl = typeof pw.page.url === 'function' ? pw.page.url() : null;
  if (finalUrl) {
    const want = new URL(target); const got = new URL(finalUrl);
    if (got.origin !== want.origin || normPath(got.pathname) !== normPath(want.pathname)) {
      const where = got.origin === want.origin ? got.pathname + got.search : finalUrl;
      return `the app redirected ${step.visit} → ${where}` + (LOGIN_RE.test(got.pathname) ? ' (login screen: no session or session expired; check the flow headers/Cookie)' : '');
    }
  }
  const status = typeof resp?.status === 'function' ? resp.status() : null;
  if (status !== null && status >= 400) return `${step.visit} answered HTTP ${status}`;
  if (step.waitFor) {
    try { await pw.page.waitForSelector(step.waitFor, { state: 'attached', timeout: 10_000 }); } catch {
      return `wait_for "${step.waitFor}" did not appear within 10 s`;
    }
  }
  return null;
}

// ---------- main ----------

/**
 * @param {object} flow   result of loadFlow()
 * @param {{ url: string, driver?: 'http'|'playwright', diagnose?: boolean, reset?: boolean, headers?: Record<string, string>,
 *           fetchImpl?: typeof fetch, pageFactory?: (opts: {viewport: object|null}) => Promise<{page:any, context?:any, close:()=>Promise<void>}>, cwd?: string }} opts
 */
export async function runVerify(flow, opts) {
  const { url, driver = 'http', diagnose: wantDiag = false, fetchImpl = fetch, cwd = process.cwd() } = opts;
  const reset = (opts.reset ?? true) && !!flow.scenario; // without a scenario there is no mock to reset
  const flowHeaders = flow.headers ?? {};
  const runHeaders = opts.headers ?? {}; // verify --header: on every request, over flow and step headers
  const warnings = [];

  try {
    if (reset) {
      const local = generateWorld(flow.scenario);
      const res = await fetchImpl(joinUrl(url, '/__atrezzo/reset'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario: flow.scenario.name }) });
      const body = await res.json().catch(() => ({}));
      if (res.status !== 200) throw new AtrezzoError(`The mock at ${url} could not load scenario "${flow.scenario.name}": ${body.error ?? res.status}`, { exitCode: EXIT.UNVERIFIABLE });
      if (body.hash && body.hash !== local.hash) warnings.push(`the mock serves "${body.scenario}" with hash ${body.hash} but the local scenario has ${local.hash}: different files?`);
    }
  } catch (e) {
    if (e instanceof AtrezzoError) throw e;
    throw new AtrezzoError(`No mock listening at ${url} (${e.cause?.code ?? e.message}). Start it with: atrezzo serve --scenario ${flow.scenario.name}`, { exitCode: EXIT.UNVERIFIABLE });
  }

  let pw = null;
  if (driver === 'playwright') pw = await (opts.pageFactory ? opts.pageFactory({ viewport: flow.viewport ?? null }) : defaultPageFactory(cwd, { viewport: flow.viewport ?? null }));

  const rows = [];
  try {
    for (const step of flow.steps) {
      const headers = mergeHeaders(flowHeaders, runHeaders, step.headers);
      const fetchOpts = Object.keys(headers).length ? { headers } : undefined;
      const get = (u) => getJson(fetchImpl, u, fetchOpts);
      const responses = {};
      const needHttp = driver === 'http' || wantDiag;
      if (needHttp) {
        for (const [name, path] of Object.entries(step.requests)) {
          try { responses[name] = { path, ...(await get(joinUrl(url, path))) }; } catch (e) {
            throw new AtrezzoError(redact(`Network error requesting ${path}: ${e.message}`, headers), { exitCode: EXIT.UNVERIFIABLE });
          }
        }
      }
      let stepFail = null;
      let stepFailRow = null;
      if (pw) {
        if (!step.visit) {
          for (const e of step.expect) rows.push({ screen: step.screen, expect: e, status: 'N/V', obtained: null, note: 'the step has no "visit": playwright does not know which page to open' });
          continue;
        }
        stepFail = await openStep(pw, url, step, headers);
      }
      for (const e of step.expect) {
        const row = { screen: step.screen, expect: e, status: 'N/V', obtained: null, note: '' };
        const ctx = { driver };
        if (e.data && responses[e.data.request]) {
          const r = responses[e.data.request];
          ctx.response = r;
          ctx.items = r.status === 200 ? extractItems(r.body, e.data.pick) : [];
          ctx.matched = ctx.items.filter((it) => whereMatch(it, e.data.where)).length;
          if (wantDiag && r.status === 200) {
            const full = await get(joinUrl(url, withoutPagination(r.path))).catch(() => null);
            if (full?.status === 200) ctx.fullMatched = extractItems(full.body, e.data.pick).filter((it) => whereMatch(it, e.data.where)).length;
          }
        }
        if (pw) {
          try { ctx.domCount = await pw.page.locator(e.selector).count(); } catch (err) {
            stepFail ??= `invalid selector or closed page: ${err.message.split('\n')[0]}`;
            ctx.domCount = 0;
          }
          row.obtained = ctx.domCount;
        } else if (ctx.items) {
          row.obtained = ctx.matched;
        } else {
          row.note = 'no "data": the http driver cannot count a selector; add data.request or use --driver playwright';
          rows.push(row);
          continue;
        }
        ctx.obtained = row.obtained;
        // A step whose page is not the one requested is never green, even if the count happens to match.
        row.status = !stepFail && passes(e, row.obtained) ? 'OK' : 'KO';
        if (stepFail) {
          // say it once per step; the other rows of the step point at it
          if (stepFailRow === null) { stepFailRow = rows.length + 1; row.note = stepFail; } else row.note = `same cause as #${stepFailRow}`;
          if (wantDiag && stepFailRow === rows.length + 1) row.hypotheses = [{ type: 'navigation', confidence: 'high', evidence: `what was counted is not the "${step.screen}" screen; the scenario and selectors are not the cause. Fix navigation/session before looking at anything else.` }];
        } else if (row.status === 'KO' && wantDiag) row.hypotheses = diagnose(row, ctx);
        rows.push(row);
      }
    }
  } finally {
    if (pw) await pw.close();
  }

  const ko = rows.filter((r) => r.status === 'KO').length;
  const nv = rows.filter((r) => r.status === 'N/V').length;
  const exitCode = ko ? EXIT.FAIL : nv || !rows.length ? EXIT.UNVERIFIABLE : EXIT.OK;
  const shownHeaders = maskHeaders(mergeHeaders(flowHeaders, runHeaders, ...flow.steps.map((st) => st.headers)));
  return { rows, exitCode, warnings, scenario: flow.scenario?.name ?? null, seed: flow.scenario?.seed ?? null, url, driver, viewport: flow.viewport ?? null, headers: shownHeaders };
}

export function formatReport(result) {
  const where = result.scenario ? `Scenario: ${result.scenario} (seed ${result.seed})` : 'No scenario (real app, no mock)';
  const head = [`${where} · driver: ${result.driver} · ${result.url}${result.viewport ? ` · viewport ${result.viewport.width}x${result.viewport.height}` : ''}`];
  if (result.headers && Object.keys(result.headers).length) head.push(`Headers: ${formatHeaders(result.headers)}`);
  for (const w of result.warnings) head.push(`WARNING: ${w}`);
  const cols = ['#', 'screen', 'selector', 'expected', 'obtained', 'result'];
  const data = result.rows.map((r, i) => [String(i + 1), r.screen, r.expect.label ? `${r.expect.selector} (${r.expect.label})` : r.expect.selector, expectedText(r.expect), r.obtained === null ? '-' : String(r.obtained), r.status]);
  const widths = cols.map((c, i) => Math.max(c.length, ...data.map((d) => d[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const out = [...head, '', fmt(cols), fmt(widths.map((w) => '-'.repeat(w))), ...data.map(fmt)];
  result.rows.forEach((r, i) => {
    if (r.note) out.push(`  #${i + 1}: ${r.note}`);
    for (const h of r.hypotheses ?? []) out.push(`  #${i + 1} hypothesis [${h.confidence}] ${h.type}: ${h.evidence}`);
  });
  const ok = result.rows.filter((r) => r.status === 'OK').length;
  const ko = result.rows.filter((r) => r.status === 'KO').length;
  const nv = result.rows.length - ok - ko;
  out.push('', `${ok} OK · ${ko} KO · ${nv} not verified → ${result.exitCode === 0 ? 'GREEN' : result.exitCode === 1 ? 'RED' : 'NOT VERIFIED'}`);
  return out.join('\n');
}
