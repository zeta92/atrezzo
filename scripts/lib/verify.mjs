// Verification loop: run the flow steps against a served mock, compare with the
// expectations, and (optionally) diagnose mismatches instead of regenerating.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AtrezzoError, EXIT } from './errors.mjs';
import { generateWorld } from './world.mjs';
import { mergeHeaders, maskHeaders, redact, formatHeaders } from './headers.mjs';
import { mergeStorage, hasStorage, storageKeys, formatStorage, createSeeder } from './storage.mjs';
import { chromePath } from './env.mjs';

// Query parameters that mean "order the rows": if one of them is ignored, the fix is `sorts:`, not a
// filter with the same name (declaring `filters: { order: ... }` would filter, never order).
const SORT_PARAM_NAMES = new Set(['order', 'sort', 'sort_by', 'order_by', 'sortby', 'orderby', 'sort.by', 'sort.order', 'sorts.by', 'sorts.order']);

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

/** The mock answered the `error:` the scenario declares for the endpoint (a legitimate answer, not a failure of the mock). */
const declaredError = (r) => header(r?.headers, 'x-atrezzo-error') === 'declared';

function fitEndpoint(segs, parts) {
  if (segs.length !== parts.length) return -1;
  let params = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].startsWith(':')) { if (!parts[i]) return -1; params++; }
    else if (segs[i] !== parts[i]) return -1;
  }
  return params;
}

function matchScenarioEndpoint(scenario, reqPath) {
  if (!scenario?.endpoints?.length) return null;
  const pathname = new URL(reqPath, 'http://x').pathname.replace(/\/+$/, '') || '/';
  const parts = pathname.split('/');
  let best = null;
  let bestParams = Infinity;
  for (const ep of scenario.endpoints) {
    const p = fitEndpoint(ep.path.split('/'), parts);
    if (p >= 0 && p < bestParams) { best = ep; bestParams = p; }
  }
  return best;
}

function withoutPagination(path, ep) {
  const u = new URL(path, 'http://x');
  const keys = new Set(['limit', 'offset', 'page', 'per_page', 'pageSize', 'skip', 'take']);
  if (ep?.pagination) {
    keys.add(ep.pagination.limit);
    if (ep.pagination.page) keys.add(ep.pagination.page);
    if (ep.pagination.offset) keys.add(ep.pagination.offset);
  }
  for (const k of keys) u.searchParams.delete(k);
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
  if (r && declaredError(r)) add('declared-error', 'high', `the scenario declares error: { status: ${r.status} } on this endpoint, so it answers ${r.status} by design (${JSON.stringify(r.body).slice(0, 120)}) and no rows; a step that expects data cannot pass. Expect the error state on the screen, or drop error: from the endpoint.`);
  else if (r && r.status !== 200) add('non-200-response', 'high', `the request returned ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
  if (r) {
    const ignored = header(r.headers, 'x-atrezzo-ignored');
    if (ignored) {
      const names = String(ignored).split(',').map((s) => s.trim()).filter(Boolean);
      const isSort = (n) => SORT_PARAM_NAMES.has(n.toLowerCase());
      const sorts = names.filter(isSort);
      const rest = names.filter((n) => !isSort(n));
      if (sorts.length) {
        add('ignored-sort', 'medium', `the client orders by ${sorts.map((s) => `\`${s}\``).join(', ')} and the endpoint declares neither sorts: nor a sort: that matches, so the order was ignored. Add sorts: { by: ${sorts[0]}, fields: [<columns>] } (or sort: { by: ... }) to endpoints[]; declaring a filter named ${sorts[0]} would not fix the order.`);
      }
      if (rest.length) add('undeclared-filter', 'medium', `the client sends parameters the contract does not declare as filters, so they were ignored: ${rest.join(', ')}. If the client expects the server to filter, add them to endpoints[].filters.`);
    }
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
const samePath = (a, b) => a.origin === b.origin && normPath(a.pathname) === normPath(b.pathname);
const sameUrl = (a, b) => samePath(a, b) && a.search === b.search && a.hash === b.hash;

function matchesRedirectTarget(got, expected) {
  if (!samePath(got, expected)) return false;
  if (expected.search && got.search !== expected.search) return false;
  if (expected.hash && got.hash !== expected.hash) return false;
  return true;
}

const CONSOLE_CLIP = 300;
const clip = (s, n = CONSOLE_CLIP) => (s.length > n ? s.slice(0, n) : s);

export const DEFAULT_CLICK_TIMEOUT = 5_000;
const formatTimeout = (ms) => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);

async function performClick(page, selector, timeout) {
  const deadline = Date.now() + timeout;
  const loc = typeof page.locator === 'function' ? page.locator(selector) : null;
  const target = loc && typeof loc.first === 'function' ? loc.first() : loc;
  if (target && typeof target.waitFor === 'function') {
    await target.waitFor({ state: 'attached', timeout });
  } else if (typeof page.waitForSelector === 'function') {
    await page.waitForSelector(selector, { state: 'attached', timeout });
  }
  const remaining = Math.max(1, deadline - Date.now());
  if (target && typeof target.click === 'function') {
    await target.click({ timeout: remaining });
  } else if (typeof page.click === 'function') {
    await page.click(selector, { timeout: remaining });
  } else {
    throw new Error('playwright page has neither locator().click() nor click()');
  }
}

async function runStepClicks(page, step, timeout) {
  for (const selector of step.click ?? []) {
    try {
      await performClick(page, selector, timeout);
    } catch (err) {
      const msg = (err?.message ?? String(err)).split('\n')[0];
      const isTimeout = err?.name === 'TimeoutError' || /timeout/i.test(msg);
      return {
        selector,
        timeout,
        isTimeout,
        message: msg,
        note: isTimeout
          ? `click "${selector}" did not appear within ${formatTimeout(timeout)}`
          : `click "${selector}" failed: ${clip(msg)}`,
      };
    }
  }
  return null;
}

function formatPageError(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    if (err.name && err.message && !String(err.message).startsWith(err.name)) return `${err.name}: ${err.message}`;
    if (err.message) return String(err.message);
  }
  return String(err);
}

function attachConsoleListeners(page, headers) {
  const entries = [];
  const onPageError = (err) => {
    entries.push({ level: 'pageerror', text: redact(formatPageError(err), headers) });
  };
  const onConsole = (msg) => {
    const type = typeof msg?.type === 'function' ? msg.type() : msg?.type;
    if (type !== 'error') return;
    const text = typeof msg?.text === 'function' ? msg.text() : String(msg?.text ?? '');
    entries.push({ level: 'error', text: redact(text, headers) });
  };
  page.on?.('pageerror', onPageError);
  page.on?.('console', onConsole);
  const detach = () => {
    if (typeof page.off === 'function') {
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
    } else if (typeof page.removeListener === 'function') {
      page.removeListener('pageerror', onPageError);
      page.removeListener('console', onConsole);
    }
  };
  return { entries, detach };
}

/**
 * Open a step's page. Returns { fail, redirect, waitForTimeout } where `fail` is null
 * if the page matches what was expected (or a declared redirect), or a sentence
 * explaining why the step can't be trusted (unexpected/wrong redirect, HTTP error, wait_for timeout).
 */
async function openStep(pw, url, step, headers, storageScript) {
  const ok = (redirect = null) => ({ fail: null, redirect, waitForTimeout: false });
  const ko = (fail, redirect = null, waitForTimeout = false) => ({ fail, redirect, waitForTimeout });
  const target = joinUrl(url, step.visit);
  if (pw.context?.setExtraHTTPHeaders) await pw.context.setExtraHTTPHeaders(headers);
  else await pw.page.setExtraHTTPHeaders?.(headers);
  if (storageScript) {
    // On the context, so every document (reloads, new pages, popups) runs it before the app's own scripts.
    if (pw.context?.addInitScript) await pw.context.addInitScript(storageScript);
    else if (pw.page.addInitScript) await pw.page.addInitScript(storageScript);
    else throw new AtrezzoError('the playwright page has no addInitScript: cannot seed the flow storage', { exitCode: EXIT.UNVERIFIABLE });
  }
  let resp;
  try { resp = await pw.page.goto(target); } catch (e) {
    return ko(redact(`could not open ${step.visit}: ${e.message.split('\n')[0]}`, headers));
  }
  await pw.page.waitForLoadState?.('networkidle', { timeout: 15_000 })?.catch?.(() => {});
  const finalUrl = typeof pw.page.url === 'function' ? pw.page.url() : null;
  let redirect = null;
  if (finalUrl) {
    const want = new URL(target); const got = new URL(finalUrl);
    const where = got.origin === want.origin ? got.pathname + got.search + got.hash : finalUrl;
    if (step.redirectsTo) {
      const expected = new URL(joinUrl(url, step.redirectsTo));
      const matched = matchesRedirectTarget(got, expected);
      if (sameUrl(got, want)) {
        return ko(`expected ${step.visit} to redirect to ${step.redirectsTo}, but stayed on ${where}`);
      }
      redirect = { from: step.visit, to: where, declared: matched };
      if (!matched) return ko(`the app redirected ${step.visit} → ${where} (expected ${step.redirectsTo})`, redirect);
    } else if (step.allowRedirect ? !sameUrl(got, want) : !samePath(got, want)) {
      redirect = { from: step.visit, to: where, declared: Boolean(step.allowRedirect) };
      if (!step.allowRedirect) {
        return ko(`the app redirected ${step.visit} → ${where}` + (LOGIN_RE.test(got.pathname) ? ' (login screen: no session or session expired; check the flow headers/Cookie)' : ''), redirect);
      }
    }
  } else if (step.redirectsTo) {
    return ko(`could not verify redirect to ${step.redirectsTo}: page URL is unavailable`);
  }
  const status = typeof resp?.status === 'function' ? resp.status() : null;
  if (status !== null && status >= 400) return ko(`${redirect?.to ?? step.visit} answered HTTP ${status}`, redirect);
  if (step.waitFor) {
    try { await pw.page.waitForSelector(step.waitFor, { state: 'attached', timeout: 10_000 }); } catch {
      return ko(`wait_for "${step.waitFor}" did not appear within 10 s`, redirect, true);
    }
  }
  return ok(redirect);
}

// ---------- main ----------

/**
 * @param {object} flow   result of loadFlow()
 * @param {{ url: string, driver?: 'http'|'playwright', diagnose?: boolean, reset?: boolean, strictConsole?: boolean, headers?: Record<string, string>,
 *           fetchImpl?: typeof fetch, pageFactory?: (opts: {viewport: object|null}) => Promise<{page:any, context?:any, close:()=>Promise<void>}>, cwd?: string }} opts
 */
export async function runVerify(flow, opts) {
  const { url, driver = 'http', diagnose: wantDiag = false, strictConsole = false, clickTimeout: optClickTimeout, fetchImpl = fetch, cwd = process.cwd() } = opts;
  if (strictConsole && driver !== 'playwright') {
    throw new AtrezzoError('--strict-console requires --driver playwright (the http driver has no browser console)', { exitCode: EXIT.INVALID });
  }
  if (optClickTimeout !== undefined && (!Number.isInteger(optClickTimeout) || optClickTimeout <= 0)) {
    throw new AtrezzoError('--click-timeout must be a positive integer (milliseconds)', { exitCode: EXIT.INVALID });
  }
  const reset = (opts.reset ?? true) && !!flow.scenario; // without a scenario there is no mock to reset
  const flowHeaders = flow.headers ?? {};
  const runHeaders = opts.headers ?? {}; // verify --header: on every request, over flow and step headers
  const warnings = [];
  const flowStorage = flow.storage ?? {};
  const anyStorage = [flowStorage, ...flow.steps.map((st) => st.storage)].some(hasStorage);
  if (anyStorage && driver !== 'playwright') warnings.push('storage: is ignored with the http driver (there is no browser to seed); use --driver playwright');
  const anyClick = flow.steps.some((st) => st.click?.length);
  if (anyClick && driver !== 'playwright') warnings.push('click: is ignored with the http driver (there is no browser to click in); use --driver playwright');
  const seeder = createSeeder();

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
  const stepResults = [];
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
      let nav = { fail: null, redirect: null, waitForTimeout: false };
      let clickFail = null;
      let listeners = null;
      if (pw) {
        if (!step.visit) {
          stepResults.push({ screen: step.screen, console: [] });
          for (const e of step.expect) rows.push({ screen: step.screen, expect: e, status: 'N/V', obtained: null, note: 'the step has no "visit": playwright does not know which page to open' });
          continue;
        }
        listeners = attachConsoleListeners(pw.page, headers);
      } else {
        stepResults.push({ screen: step.screen, ...(step.visit ? { visit: step.visit } : {}) });
      }
      const stepRowStart = rows.length;
      const stepCtxs = [];
      let selectorFail = null;
      let selectorFailRow = null;
      try {
        if (pw) {
          const storage = mergeStorage(flowStorage, step.storage);
          nav = await openStep(pw, url, step, headers, seeder.next(new URL(joinUrl(url, step.visit)).origin, storage));
          if (!nav.fail && step.click?.length) {
            const clickTimeout = step.clickTimeout ?? optClickTimeout ?? flow.clickTimeout ?? DEFAULT_CLICK_TIMEOUT;
            clickFail = await runStepClicks(pw.page, step, clickTimeout);
          }
        }
        for (const e of step.expect) {
          const row = { screen: step.screen, expect: e, status: 'N/V', obtained: null, note: '' };
          const ctx = { driver };
          if (e.data && responses[e.data.request]) {
            const r = responses[e.data.request];
            const matchedEp = matchScenarioEndpoint(flow.scenario, r.path);
            const pick = e.data.pick ?? (matchedEp?.shape === 'envelope' ? (matchedEp.envelope?.items ?? matchedEp.pick) : undefined);
            ctx.response = r;
            ctx.items = r.status === 200 ? extractItems(r.body, pick) : [];
            ctx.matched = ctx.items.filter((it) => whereMatch(it, e.data.where)).length;
            if (wantDiag && r.status === 200) {
              const full = await get(joinUrl(url, withoutPagination(r.path, matchedEp))).catch(() => null);
              if (full?.status === 200) ctx.fullMatched = extractItems(full.body, pick).filter((it) => whereMatch(it, e.data.where)).length;
            }
          }
          if (pw) {
            try { ctx.domCount = await pw.page.locator(e.selector).count(); } catch (err) {
              selectorFail ??= `invalid selector or closed page: ${err.message.split('\n')[0]}`;
              ctx.domCount = 0;
            }
            row.obtained = ctx.domCount;
          } else if (ctx.items) {
            row.obtained = ctx.matched;
          } else {
            row.note = 'no "data": the http driver cannot count a selector; add data.request or use --driver playwright';
            rows.push(row);
            stepCtxs.push(null);
            continue;
          }
          ctx.obtained = row.obtained;
          // A declared error is what the scenario asked for: counted as 0 rows, and said so on a KO.
          if (ctx.response && declaredError(ctx.response) && !pw && !passes(e, row.obtained)) row.note = `${e.data.request} answered the error the scenario declares (${ctx.response.status}): 0 rows`;
          row.status = !nav.fail && !clickFail && !selectorFail && passes(e, row.obtained) ? 'OK' : 'KO';
          if (selectorFail && !nav.fail && !clickFail) {
            if (selectorFailRow === null) { selectorFailRow = rows.length + 1; row.note = selectorFail; } else row.note = `same cause as #${selectorFailRow}`;
            if (wantDiag && selectorFailRow === rows.length + 1) {
              row.hypotheses = [{ type: 'navigation', confidence: 'high', evidence: `what was counted is not the "${step.screen}" screen; the scenario and selectors are not the cause. Fix navigation/session before looking at anything else.` }];
            }
          }
          rows.push(row);
          stepCtxs.push(ctx);
        }
      } finally {
        listeners?.detach();
      }
      if (pw) {
        const consoleList = listeners.entries;
        const pageErrors = consoleList.filter((c) => c.level === 'pageerror').map((c) => c.text);
        const consoleErrors = consoleList.filter((c) => c.level === 'error').map((c) => c.text);
        if (!strictConsole && consoleErrors.length) {
          const counts = new Map();
          for (const msg of consoleErrors) counts.set(msg, (counts.get(msg) ?? 0) + 1);
          for (const [msg, n] of counts) {
            warnings.push(`step "${step.screen}" console.error${n > 1 ? ` (×${n})` : ''}: ${clip(msg)}`);
          }
        }
        stepResults.push({ screen: step.screen, visit: step.visit, ...(nav.redirect ? { redirect: nav.redirect } : {}), console: consoleList });

        // If wait_for or click timed out because an uncaught pageerror crashed the screen, surface page-error instead.
        const effectiveNavFail = nav.fail && !(nav.waitForTimeout && pageErrors.length) ? nav.fail : null;
        const effectiveClickFail = clickFail && !(clickFail.isTimeout && pageErrors.length) ? clickFail : null;
        const hasStepBlocker = Boolean(pageErrors.length || effectiveNavFail || effectiveClickFail || (strictConsole && consoleErrors.length));
        if (hasStepBlocker) {
          if (rows.length === stepRowStart) {
            rows.push({ screen: step.screen, expect: { selector: '(page)', count: 0 }, status: 'KO', obtained: null, note: '' });
          }
          const stepRows = rows.slice(stepRowStart);
          const firstRow = stepRows[0];
          const firstRowNum = stepRowStart + 1;
          for (const r of stepRows) { r.status = 'KO'; delete r.hypotheses; }
          for (let i = 1; i < stepRows.length; i++) stepRows[i].note = `same cause as #${firstRowNum}`;

          const navEvidence = step.redirectsTo
            ? `expected redirect to "${step.redirectsTo}" for step "${step.screen}", but landed elsewhere; the scenario and selectors are not the cause. Fix navigation/guard before looking at anything else.`
            : `what was counted is not the "${step.screen}" screen; the scenario and selectors are not the cause. Fix navigation/session before looking at anything else.`;
          const clickEvidence = effectiveClickFail
            ? `click target "${effectiveClickFail.selector}" on "${step.screen}" did not appear or could not be clicked within ${formatTimeout(effectiveClickFail.timeout)} (${clip(effectiveClickFail.message)}). Check the selector or wait_for before asserting.`
            : '';

          if (pageErrors.length) {
            const errNote = `uncaught page error${pageErrors.length > 1 ? ` (${pageErrors.length})` : ''}: ${clip(pageErrors[0])}`;
            firstRow.note = effectiveNavFail ? `${effectiveNavFail}; ${errNote}` : effectiveClickFail ? `${effectiveClickFail.note}; ${errNote}` : errNote;
            if (wantDiag) {
              const hyps = [];
              if (effectiveNavFail) hyps.push({ type: 'navigation', confidence: 'high', evidence: navEvidence });
              if (effectiveClickFail) hyps.push({ type: 'click-target-missing', confidence: 'high', evidence: clickEvidence });
              for (const msg of new Set(pageErrors)) {
                hyps.push({ type: 'page-error', confidence: 'high', evidence: `uncaught page error on "${step.screen}": ${clip(msg)}` });
              }
              firstRow.hypotheses = hyps;
            }
          } else if (effectiveNavFail) {
            firstRow.note = effectiveNavFail;
            if (wantDiag) firstRow.hypotheses = [{ type: 'navigation', confidence: 'high', evidence: navEvidence }];
          } else if (effectiveClickFail) {
            firstRow.note = effectiveClickFail.note;
            if (wantDiag) firstRow.hypotheses = [{ type: 'click-target-missing', confidence: 'high', evidence: clickEvidence }];
          } else {
            firstRow.note = `console.error (--strict-console)${consoleErrors.length > 1 ? ` (${consoleErrors.length})` : ''}: ${clip(consoleErrors[0])}`;
            if (wantDiag) {
              firstRow.hypotheses = [...new Set(consoleErrors)].map((msg) => ({
                type: 'console-error',
                confidence: 'high',
                evidence: `console.error on "${step.screen}" with --strict-console: ${clip(msg)}`,
              }));
            }
          }
        } else if (wantDiag) {
          for (let i = 0; i < stepCtxs.length; i++) {
            const row = rows[stepRowStart + i];
            if (row.status === 'KO' && !row.hypotheses && !row.note.startsWith('same cause as #') && stepCtxs[i]) {
              row.hypotheses = diagnose(row, stepCtxs[i]);
            }
          }
        }
      } else if (wantDiag) {
        for (let i = 0; i < stepCtxs.length; i++) {
          const row = rows[stepRowStart + i];
          if (row.status === 'KO' && stepCtxs[i]) row.hypotheses = diagnose(row, stepCtxs[i]);
        }
      }
    }
  } finally {
    if (pw) await pw.close();
  }

  const ko = rows.filter((r) => r.status === 'KO').length;
  const nv = rows.filter((r) => r.status === 'N/V').length;
  const exitCode = ko ? EXIT.FAIL : nv || !rows.length ? EXIT.UNVERIFIABLE : EXIT.OK;
  const shownHeaders = maskHeaders(mergeHeaders(flowHeaders, runHeaders, ...flow.steps.map((st) => st.headers)));
  const out = { rows, steps: stepResults, exitCode, warnings, scenario: flow.scenario?.name ?? null, seed: flow.scenario?.seed ?? null, url, driver, viewport: flow.viewport ?? null, headers: shownHeaders };
  // keys only: a storage value may be a session
  if (anyStorage && driver === 'playwright') out.storage = storageKeys(mergeStorage(flowStorage, ...flow.steps.map((st) => st.storage)));
  return out;
}

export function formatReport(result) {
  const where = result.scenario ? `Scenario: ${result.scenario} (seed ${result.seed})` : 'No scenario (real app, no mock)';
  const head = [`${where} · driver: ${result.driver} · ${result.url}${result.viewport ? ` · viewport ${result.viewport.width}x${result.viewport.height}` : ''}`];
  if (result.headers && Object.keys(result.headers).length) head.push(`Headers: ${formatHeaders(result.headers)}`);
  if (result.storage) head.push(`Storage (keys): ${formatStorage(result.storage)}`);
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
