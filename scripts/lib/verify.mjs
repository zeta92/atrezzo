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
import { diagnose, header, declaredError, whereMatch, expectedText, passes } from './diagnose.mjs';

// El diagnóstico vive en diagnose.mjs; se reexporta para quien ya lo importa desde aquí.
export { diagnose } from './diagnose.mjs';

// ---------- helpers ----------

function extractItems(body, pick) {
  let v = body;
  if (pick) for (const k of pick.split('.')) v = v?.[k];
  else if (v && !Array.isArray(v) && Array.isArray(v.data)) v = v.data;
  if (Array.isArray(v)) return v;
  return v === undefined || v === null ? [] : [v];
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

// Hard caps on the probe that rebuilds the full set: diagnosis must never loop unbounded nor ask
// for (or hold) unbounded pages, whatever max_limit the endpoint declares. `--url` may point at any
// server, so each probe request also has a deadline and a byte cap, and the whole walk has both too.
const MAX_PROBE_PAGES = 20;
const MAX_PROBE_PAGE_SIZE = 1000;
export const PROBE_LIMITS = Object.freeze({ requestMs: 5_000, totalMs: 15_000, pageBytes: 5 * 2 ** 20, totalBytes: 20 * 2 ** 20 });

/** X-Total-Count as a non-negative integer, or null when absent, empty or malformed. */
function totalCount(headers) {
  const raw = header(headers, 'x-total-count');
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

/**
 * getJson for the diagnosis probe only: aborts at min(requestMs, what is left of the walk's
 * deadline) and stops reading past min(pageBytes, totalBytes not yet spent). Throws on either;
 * a fetchImpl that ignores the AbortSignal is raced, so a hung server cannot hold the run.
 */
async function getJsonBounded(fetchImpl, url, init, budget) {
  const ms = Math.min(budget.limits.requestMs, budget.deadline - Date.now());
  if (ms <= 0) throw new Error('diagnosis probe: out of time');
  const cap = Math.min(budget.limits.pageBytes, budget.limits.totalBytes - budget.bytes);
  if (cap <= 0) throw new Error('diagnosis probe: out of bytes');
  const ac = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new Error(`diagnosis probe: no answer within ${ms} ms`)); }, ms); });
  expired.catch(() => {});
  const tooLarge = () => new Error(`diagnosis probe: page over ${cap} bytes`);
  try {
    const res = await Promise.race([fetchImpl(url, { ...init, signal: ac.signal }), expired]);
    const declared = Number(header(res.headers, 'content-length'));
    if (Number.isFinite(declared) && declared > cap) throw tooLarge();
    let text;
    if (typeof res.body?.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let n = 0;
      try {
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), expired]);
          if (done) break;
          n += value.byteLength;
          if (n > cap) throw tooLarge();
          chunks.push(value);
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      budget.bytes += n;
      text = new TextDecoder().decode(Buffer.concat(chunks));
    } else {
      text = String(await Promise.race([res.text(), expired]));
      const n = Buffer.byteLength(text);
      if (n > cap) throw tooLarge();
      budget.bytes += n;
    }
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, headers: res.headers, body };
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

/**
 * Every row behind the step's request without the client's pagination, or null if that cannot be
 * proven. `get` is the bounded probe fetch; `response` is the step's own answer to `path`.
 *
 * - No endpoint matched: nothing says how (or whether) the server paginates (e.g. a custom
 *   `?p=&n=`), so nothing bounds a probe or proves a set: null, without a request.
 * - Endpoint without pagination: the mock answers every row at once, so the step's response is the
 *   set, if its X-Total-Count says so; no request.
 * - Paginated endpoint: never the unpaginated request (with max_limit and no default_limit it is
 *   the whole collection). Page 1 is asked explicitly at min(max_limit, MAX_PROBE_PAGE_SIZE);
 *   its X-Total-Count says how many rows there are. If the server serves fewer rows than asked
 *   (an undeclared lower cap), the walk follows that observed size. At most MAX_PROBE_PAGES pages.
 *
 * Fails closed (null) on: no usable X-Total-Count, one below what page 1 already carries, or one
 * that changes during the walk; a page that is not 200, holds more rows than asked or breaks the
 * byte/time budget; a walk that does not add up to X-Total-Count exactly; or, over several pages,
 * rows without unique non-null ids (a server that ignores the page number repeats rows and can
 * still add up).
 */
async function fetchFullSet(get, url, path, response, ep, pick) {
  if (!ep) return null;
  const p = ep.pagination;
  if (!p) {
    const items = extractItems(response.body, pick);
    return totalCount(response.headers) === items.length ? items : null;
  }
  const base = withoutPagination(path, ep);
  let size = Math.min(p.maxLimit ?? MAX_PROBE_PAGE_SIZE, MAX_PROBE_PAGE_SIZE);
  const pageUrl = (i, offset) => {
    const u = new URL(base, 'http://x');
    u.searchParams.set(p.limit, String(size));
    if (p.page) u.searchParams.set(p.page, String(i + 1));
    else u.searchParams.set(p.offset, String(offset));
    return joinUrl(url, u.pathname + u.search);
  };
  const all = [];
  let total = null;
  for (let i = 0; ; i++) {
    if (i >= MAX_PROBE_PAGES) return null;
    const r = await get(pageUrl(i, all.length)).catch(() => null);
    if (r?.status !== 200) return null;
    const chunk = extractItems(r.body, pick);
    if (chunk.length > size) return null;
    if (i === 0) {
      total = totalCount(r.headers);
      if (total === null || total < chunk.length) return null;
      if (total === chunk.length) return chunk;
      if (chunk.length === 0) return null;
      // Fewer rows than asked, more to come: the server's real cap. Page k at that size is offset
      // (k - 1) × size however the server turns page numbers into offsets.
      size = chunk.length;
      if (Math.ceil(total / size) > MAX_PROBE_PAGES) return null;
    } else if (totalCount(r.headers) !== total) return null;
    for (const it of chunk) all.push(it);
    if (all.length >= total || chunk.length < size) break;
  }
  if (all.length !== total) return null;
  const ids = new Set(all.map((it) => it?.id));
  return ids.size === total && !ids.has(undefined) && !ids.has(null) ? all : null;
}

/**
 * The client's page size, when the endpoint's max_limit cut it down: { param, requested, max, defaulted }.
 * defaulted: the client sent no page size and the endpoint's default_limit is the one cut.
 */
function clampedLimit(path, ep, served) {
  const p = ep?.pagination;
  if (!p?.maxLimit || served !== p.maxLimit) return undefined;
  const raw = new URL(path, 'http://x').searchParams.get(p.limit);
  if (raw === null) {
    return p.defaultLimit > p.maxLimit ? { param: p.limit, requested: p.defaultLimit, max: p.maxLimit, defaulted: true } : undefined;
  }
  const requested = Number(raw);
  return Number.isInteger(requested) && requested > p.maxLimit ? { param: p.limit, requested, max: p.maxLimit, defaulted: false } : undefined;
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
 *           fetchImpl?: typeof fetch, pageFactory?: (opts: {viewport: object|null}) => Promise<{page:any, context?:any, close:()=>Promise<void>}>, cwd?: string,
 *           probeLimits?: Partial<typeof PROBE_LIMITS> }} opts   probeLimits: budget of the --diagnose full-set probe (not the step's requests)
 */
export async function runVerify(flow, opts) {
  const { url, driver = 'http', diagnose: wantDiag = false, strictConsole = false, clickTimeout: optClickTimeout, fetchImpl = fetch, cwd = process.cwd() } = opts;
  const probeLimits = { ...PROBE_LIMITS, ...opts.probeLimits };
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
  let clockInstalled = false;
  try {
    for (const step of flow.steps) {
      const stepClock = step.clock ?? flow.clock;
      const headers = mergeHeaders(flowHeaders, runHeaders, step.headers);
      const fetchOpts = Object.keys(headers).length ? { headers } : undefined;
      const get = (u) => getJson(fetchImpl, u, fetchOpts);
      const responses = {};
      // The full-set probe of a row with `data`, run only once that row is a KO worth diagnosing
      // (never for a passing row, nor for one already explained by navigation/click/selector).
      // One walk per request (and pick) per step, whatever the number of rows that need it.
      const probes = new WeakMap();
      const fullSets = new Map();
      const fullSet = (path, response, ep, pick) => {
        const key = `${path}\0${pick ?? ''}`;
        if (!fullSets.has(key)) {
          const budget = { limits: probeLimits, deadline: Date.now() + probeLimits.totalMs, bytes: 0 };
          fullSets.set(key, fetchFullSet((u) => getJsonBounded(fetchImpl, u, fetchOpts, budget), url, path, response, ep, pick).catch(() => null));
        }
        return fullSets.get(key);
      };
      const diagnoseRow = async (row, ctx) => {
        const probe = probes.get(ctx);
        if (probe) {
          const n = await probe();
          if (n !== null) ctx.fullMatched = n;
        }
        row.hypotheses = diagnose(row, ctx);
      };
      // Under playwright the JSON is fetched too when an assertion declares `data`: a DOM count alone does not prove it.
      // Fetched after the page's navigation and clicks, so it is the world the screen shows.
      const needHttp = driver === 'http' || wantDiag || step.expect.some((e) => e.data);
      const fetchResponses = async () => {
        if (!needHttp) return;
        for (const [name, path] of Object.entries(step.requests)) {
          try { responses[name] = { path, ...(await get(joinUrl(url, path))) }; } catch (e) {
            throw new AtrezzoError(redact(`Network error requesting ${path}: ${e.message}`, headers), { exitCode: EXIT.UNVERIFIABLE });
          }
        }
      };
      if (!pw) await fetchResponses();
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
          if (stepClock?.time && pw.page?.clock) {
            try {
              if (!clockInstalled) { await pw.page.clock.install({ time: new Date(stepClock.time) }); clockInstalled = true; }
              else if (typeof pw.page.clock.setFixedTime === 'function') await pw.page.clock.setFixedTime(new Date(stepClock.time));
            } catch (e) {
              throw new AtrezzoError(`could not install the browser clock at ${stepClock.time}: ${String(e.message).split('\n')[0]}`, { exitCode: EXIT.UNVERIFIABLE });
            }
          }
          nav = await openStep(pw, url, step, headers, seeder.next(new URL(joinUrl(url, step.visit)).origin, storage));
          if (!nav.fail && step.click?.length) {
            const clickTimeout = step.clickTimeout ?? optClickTimeout ?? flow.clickTimeout ?? DEFAULT_CLICK_TIMEOUT;
            clickFail = await runStepClicks(pw.page, step, clickTimeout);
          }
          await fetchResponses();
        }
        for (const e of step.expect) {
          const row = { screen: step.screen, expect: e, status: 'N/V', obtained: null, note: '' };
          const ctx = { driver };
          let dataFail = false;
          if (e.data && responses[e.data.request]) {
            const r = responses[e.data.request];
            const matchedEp = matchScenarioEndpoint(flow.scenario, r.path);
            const pick = e.data.pick ?? (matchedEp?.shape === 'envelope' ? (matchedEp.envelope?.items ?? matchedEp.pick) : undefined);
            ctx.response = r;
            ctx.query = new URL(r.path, 'http://x').searchParams;
            ctx.items = r.status === 200 ? extractItems(r.body, pick) : [];
            ctx.matched = ctx.items.filter((it) => whereMatch(it, e.data.where)).length;
            if (wantDiag && r.status === 200) {
              probes.set(ctx, async () => {
                const full = await fullSet(r.path, r, matchedEp, pick);
                return full ? full.filter((it) => whereMatch(it, e.data.where)).length : null;
              });
              const clamp = clampedLimit(r.path, matchedEp, ctx.items.length);
              if (clamp) ctx.clampedLimit = clamp;
            }
          }
          if (pw) {
            try { ctx.domCount = await pw.page.locator(e.selector).count(); } catch (err) {
              selectorFail ??= `invalid selector or closed page: ${err.message.split('\n')[0]}`;
              ctx.domCount = 0;
            }
            row.obtained = ctx.domCount;
            if (ctx.items && !passes(e, ctx.matched)) {
              const ignored = header(ctx.response.headers, 'x-atrezzo-ignored');
              dataFail = true;
              row.note = `${e.data.request}: the JSON has ${ctx.matched} matching item(s), expected ${expectedText(e)}; the DOM count alone does not prove the assertion` + (ignored ? ` (the mock ignored ${ignored}: x-atrezzo-ignored)` : '');
            }
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
          row.status = !nav.fail && !clickFail && !selectorFail && !dataFail && passes(e, row.obtained) ? 'OK' : 'KO';
          if (selectorFail && !nav.fail && !clickFail) {
            if (selectorFailRow === null) { selectorFailRow = rows.length + 1; row.note = selectorFail; } else row.note = `same cause as #${selectorFailRow}`;
            if (wantDiag && selectorFailRow === rows.length + 1) {
              row.hypotheses = [{ type: 'navigation', confidence: 'high', certainty: 'confirmed', evidence: `what was counted is not the "${step.screen}" screen; the scenario and selectors are not the cause. Fix navigation/session before looking at anything else.` }];
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
        stepResults.push({ screen: step.screen, visit: step.visit, ...(nav.redirect ? { redirect: nav.redirect } : {}), ...(stepClock?.time ? { clock: stepClock.time } : {}), console: consoleList });

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

          // openStep only waits for wait_for after its route (path) and main-document status checks found nothing:
          // a timeout there shows the selector never appeared, not that navigation failed (Vue-caught errors, a failed boot fetch…).
          // Only reached without a pageerror (otherwise effectiveNavFail is null and page-error is surfaced).
          const navHyp = nav.waitForTimeout
            ? {
              type: 'navigation', confidence: 'low', certainty: 'possible',
              evidence: `wait_for "${step.waitFor}" timed out on "${step.screen}" after openStep's navigation checks did not detect a route mismatch or a main-document HTTP error; navigation is unproven, and the scenario and selectors are not ruled out. Check the console, \`atrezzo misses\` and the wait_for selector.`,
              finding: `wait_for "${step.waitFor}" timed out after 10 s; no uncaught pageerror was captured`,
            }
            : null;
          const consoleHyps = strictConsole
            ? [...new Set(consoleErrors)].map((msg) => ({
              type: 'console-error',
              confidence: 'high',
              certainty: 'confirmed',
              evidence: `console.error on "${step.screen}" with --strict-console: ${clip(msg)}`,
            }))
            : [];
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
              if (effectiveNavFail) hyps.push({ type: 'navigation', confidence: 'high', certainty: 'confirmed', evidence: navEvidence });
              if (effectiveClickFail) hyps.push({ type: 'click-target-missing', confidence: 'high', certainty: 'confirmed', evidence: clickEvidence });
              for (const msg of new Set(pageErrors)) {
                hyps.push({ type: 'page-error', confidence: 'high', certainty: 'confirmed', evidence: `uncaught page error on "${step.screen}": ${clip(msg)}` });
              }
              firstRow.hypotheses = hyps;
            }
          } else if (effectiveNavFail) {
            firstRow.note = effectiveNavFail;
            if (wantDiag) firstRow.hypotheses = navHyp ? [navHyp, ...consoleHyps] : [{ type: 'navigation', confidence: 'high', certainty: 'confirmed', evidence: navEvidence }];
          } else if (effectiveClickFail) {
            firstRow.note = effectiveClickFail.note;
            if (wantDiag) firstRow.hypotheses = [{ type: 'click-target-missing', confidence: 'high', certainty: 'confirmed', evidence: clickEvidence }];
          } else {
            firstRow.note = `console.error (--strict-console)${consoleErrors.length > 1 ? ` (${consoleErrors.length})` : ''}: ${clip(consoleErrors[0])}`;
            if (wantDiag) firstRow.hypotheses = consoleHyps;
          }
        } else if (wantDiag) {
          for (let i = 0; i < stepCtxs.length; i++) {
            const row = rows[stepRowStart + i];
            if (row.status === 'KO' && !row.hypotheses && !row.note.startsWith('same cause as #') && stepCtxs[i]) {
              await diagnoseRow(row, stepCtxs[i]);
            }
          }
        }
      } else if (wantDiag) {
        for (let i = 0; i < stepCtxs.length; i++) {
          const row = rows[stepRowStart + i];
          if (row.status === 'KO' && stepCtxs[i]) await diagnoseRow(row, stepCtxs[i]);
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
    for (const h of r.hypotheses ?? []) out.push(`  #${i + 1} hypothesis [${h.certainty ?? h.confidence}] ${h.type}: ${h.evidence}`);
  });
  const ok = result.rows.filter((r) => r.status === 'OK').length;
  const ko = result.rows.filter((r) => r.status === 'KO').length;
  const nv = result.rows.length - ok - ko;
  out.push('', `${ok} OK · ${ko} KO · ${nv} not verified → ${result.exitCode === 0 ? 'GREEN' : result.exitCode === 1 ? 'RED' : 'NOT VERIFIED'}`);
  return out.join('\n');
}
