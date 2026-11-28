// Standalone HTTP mock server (plain node:http, MSW not required).
// Uses the same projection engine (contract.mjs) as the generated MSW handlers.
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, posix, resolve, sep } from 'node:path';
import { AtrezzoError } from './errors.mjs';
import { loadScenario, scenarioNameFromFile, MAX_LATENCY } from './scenario.mjs';
import { generateWorld } from './world.mjs';
import { createEngine } from './contract.mjs';
import { createMissStore, guessShape, isMutation, isWriteMethod, missKey, safeSearch, WRITE_METHODS } from './misses.mjs';
import { discoverBundleFixturesDir } from './passthrough.mjs';

export const ON_MISS = ['log', 'stub'];
const DEFAULT_EXPOSE_HEADERS = [
  'x-total-count',
  'content-range',
  'x-atrezzo-scenario',
  'x-atrezzo-ignored',
  'x-atrezzo-stub',
  'x-atrezzo-error',
];
const UNEXPOSED_HEADERS = new Set(['set-cookie', 'access-control-expose-headers']);
// Implicit transport headers: Content-Type is CORS-safelisted and Allow comes with a 405; neither belongs in the expose list unless access-control-expose-headers names it.
const IMPLICIT_HEADERS = new Set(['content-type', 'allow']);
const wait = (ms) => new Promise((ok) => { setTimeout(ok, ms); });
// Requests for these are the browser/bundler asking for files, not the app asking the API.
const ASSET = /\.(ico|png|jpe?g|gif|svg|webp|avif|css|js|mjs|cjs|map|html?|woff2?|ttf|otf|txt|webmanifest)$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

/**
 * A request for a page, not for data: Accept names text/html (a browser navigation), or there is no
 * Accept at all and the path has no file extension. fetch() sends Accept: *\/* and so never matches.
 */
export function wantsHtml(req, pathname) {
  const accept = req.headers.accept;
  if (accept === undefined || accept.trim() === '') return extname(pathname) === '';
  return /(^|[\s,])text\/html(\s*[;,]|\s*$)/i.test(accept);
}

/** The path sits under a contract endpoint's parent (/api/orders ⇒ /api/…): an API call, never a page. */
export function underApiPrefix(endpoints, pathname) {
  return endpoints.some((e) => {
    // A parameterised path (/api/projects/:id/tasks) counts from its literal part (/api/projects).
    const literal = e.path.split('/:')[0];
    const prefix = literal === e.path ? posix.dirname(e.path) : literal;
    return prefix !== '/' && pathname.startsWith(`${prefix}/`);
  });
}

/** Map of scenario name -> file, by file basename and by `name:` field. */
export function listScenarios(dir) {
  if (!existsSync(dir)) throw new AtrezzoError(`Scenarios directory ${dir} does not exist`);
  if (!statSync(dir).isDirectory()) throw new AtrezzoError(`Scenarios path ${dir} is not a directory`);
  const out = {};
  for (const f of readdirSync(dir).sort()) {
    if (!/\.(ya?ml|json)$/.test(f)) continue;
    const file = join(dir, f);
    out[scenarioNameFromFile(f)] = file;
    try { out[loadScenario(file, { checkFixtures: false }).name] = file; } catch { /* invalid files surface when selected */ }
  }
  return out;
}

export function buildState(scenarioFile, fixturesDir = null) {
  const scenario = loadScenario(scenarioFile, { fixturesDir });
  const dataset = generateWorld(scenario);
  return { scenario, dataset, engine: createEngine(dataset), file: scenarioFile };
}

/** Effective wait per contract endpoint: { default, endpoints: { path: ms } } (only the overrides). */
export function latencySummary(endpoints, latency) {
  const overrides = Object.fromEntries(endpoints.filter((e) => e.latency !== undefined).map((e) => [e.path, e.latency]));
  return { default: latency, endpoints: overrides };
}

/** Endpoints that answer a declared `error:`: { path: status }. */
export function errorSummary(endpoints) {
  return Object.fromEntries(endpoints.filter((e) => e.error).map((e) => [e.path, e.error.status]));
}

/** Declared/passthrough response header names per endpoint and write (never values): { [route]: string[] }. */
export function responseHeadersSummary(endpoints, passthrough, writes = []) {
  const out = {};
  for (const ep of endpoints) {
    const names = [...new Set([
      ...Object.keys(ep.headers ?? {}),
      ...Object.keys(passthrough?.[ep.path]?.headers ?? {}),
    ].map((k) => k.toLowerCase()))].sort();
    if (names.length) out[ep.path] = names;
  }
  for (const w of writes ?? []) {
    const names = [...new Set([
      ...Object.keys(w.expect?.headers ?? {}),
      ...(w.cases ?? []).flatMap((c) => Object.keys(c.expect?.headers ?? {})),
    ].map((k) => k.toLowerCase()))].sort();
    if (names.length) out[`${w.method} ${w.path}`] = names;
  }
  return out;
}

function summary(state, available, generatedDir, misses, latency = 0) {
  const d = state.engine.dataset;
  const out = {
    scenario: d.scenario, seed: d.seed, now: d.now, hash: d.hash,
    counts: Object.fromEntries(Object.entries(d.entities).map(([k, v]) => [k, v.length])),
    endpoints: d.endpoints.map((e) => e.path),
    available: [...new Set(Object.values(available).map((f) => scenarioNameFromFile(f)))],
    latency: latencySummary(d.endpoints, latency),
  };
  const errors = errorSummary(d.endpoints);
  if (Object.keys(errors).length) out.errors = errors; // only when declared
  const passthrough = Object.fromEntries(d.endpoints.filter((e) => e.passthrough).map((e) => [e.path, e.passthrough.fixture]));
  if (Object.keys(passthrough).length) out.passthrough = passthrough; // only when declared
  const responseHeaders = responseHeadersSummary(d.endpoints, d.passthrough, d.writes);
  if (Object.keys(responseHeaders).length) out.responseHeaders = responseHeaders; // only when declared
  if (d.writes?.length) out.writes = d.writes.map((w) => `${w.method} ${w.path}`); // only when declared
  if (d.streams?.length) out.streams = d.streams.map((s) => s.path); // only when declared
  if (d.rpc?.length) out.rpc = d.rpc.map((r) => r.fn); // only when declared
  if (d.auth) out.auth = d.auth; // only when declared
  if (misses) out.misses = misses.summary();
  if (generatedDir) {
    const gen = join(generatedDir, `${d.scenario}.json`);
    if (existsSync(gen)) {
      try {
        const h = JSON.parse(readFileSync(gen, 'utf8')).hash;
        out.generated = h === d.hash ? 'up to date' : `stale (hash ${h}); run atrezzo world`;
      } catch { out.generated = 'unreadable'; }
    } else out.generated = 'not generated (run atrezzo world to commit the handlers)';
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new AtrezzoError('invalid JSON body'); }
}

/**
 * @param {{ scenariosDir: string, scenario?: string, staticDir?: string|null, generatedDir?: string|null,
 *   missesFile?: string|null, onMiss?: 'log'|'stub', latency?: number, sleep?: (ms:number)=>Promise<void>,
 *   log?: (s:string)=>void }} opts
 *   missesFile: where gaps are recorded (null = memory only) · onMiss: 404 (log) or empty 200 (stub)
 *   latency: ms every contract answer waits (an endpoint's `latency:` wins) · sleep: how it waits
 */
export function createMockServer({ scenariosDir, scenario, staticDir = null, generatedDir = null, fixturesDir = null, missesFile = null, onMiss = 'log', latency = 0, sleep = wait, log = () => {}, onRequest = () => {} }) {
  if (!ON_MISS.includes(onMiss)) throw new AtrezzoError(`--on-miss must be ${ON_MISS.join(' or ')} (got "${onMiss}")`);
  if (!Number.isInteger(latency) || latency < 0 || latency > MAX_LATENCY) throw new AtrezzoError(`--latency must be an integer between 0 and ${MAX_LATENCY} ms (got "${latency}")`);
  const misses = createMissStore(missesFile);
  const resolvedFixturesDir = fixturesDir ? resolve(fixturesDir) : discoverBundleFixturesDir(scenariosDir).dir;
  let available = listScenarios(scenariosDir);
  const pick = (name) => {
    available = listScenarios(scenariosDir);
    const names = Object.keys(available);
    if (!name) {
      if (!names.length) throw new AtrezzoError(`No scenarios in ${scenariosDir}`);
      return available[names[0]];
    }
    if (!available[name]) throw new AtrezzoError(`Scenario "${name}" not found in ${scenariosDir} (available: ${[...new Set(Object.values(available).map(scenarioNameFromFile))].join(', ') || 'none'})`);
    return available[name];
  };
  let state = buildState(pick(scenario), resolvedFixturesDir);

  const send = (res, status, body, headers = {}, hasBody = body !== null) => {
    const outHeaders = {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    };
    const exposed = new Set(DEFAULT_EXPOSE_HEADERS);
    const addExposed = (name, explicit = true) => {
      const lower = name.trim().toLowerCase();
      if (lower && !UNEXPOSED_HEADERS.has(lower) && (explicit || !IMPLICIT_HEADERS.has(lower))) exposed.add(lower);
    };
    for (const [k, v] of Object.entries(headers ?? {})) {
      if (v === undefined || v === null) continue;
      const lower = k.toLowerCase();
      if (lower === 'access-control-expose-headers') {
        for (const part of (Array.isArray(v) ? v : [v])) {
          if (part === undefined || part === null) continue;
          for (const item of String(part).split(',')) addExposed(item);
        }
        continue;
      }
      outHeaders[lower] = v;
      addExposed(lower, false);
    }
    outHeaders['access-control-expose-headers'] = [...exposed].join(', ');
    // hasBody false (or body null without hasBody) = no body (e.g. a count-only answer); text/binary goes verbatim, JSON values go through JSON.stringify.
    const isJsonCt = /\bjson\b|\+json/i.test(String(outHeaders['content-type'] ?? ''));
    const payload = !hasBody
      ? ''
      : Buffer.isBuffer(body)
        ? body
        : typeof body === 'string' && !isJsonCt
          ? body
          : JSON.stringify(body);
    res.writeHead(status, outHeaders);
    res.end(!hasBody || res.req.method === 'HEAD' ? undefined : payload);
  };

  const JSON_CT = { 'content-type': 'application/json; charset=utf-8' };
  const activeStreams = new Set();
  const closeAllStreams = () => {
    for (const close of [...activeStreams]) close();
  };
  const matchStream = (pathname) => {
    const clean = pathname.replace(/\/+$/, '') || '/';
    return (state.dataset.streams ?? []).find((s) => s.path === clean) ?? null;
  };
  const serveStream = (req, res, stream) => {
    if (misses.resolve('GET', stream.path)) log(`gap ${missKey('GET', stream.path)} resolved`);
    log(`${req.method} ${stream.path} → 200 text/event-stream (${stream.events.length} events, ${stream.interval} ms${stream.loop ? ', loop' : ''})`);
    if (req.method === 'HEAD') {
      return send(res, 200, null, { 'content-type': 'text/event-stream', 'x-atrezzo-scenario': state.dataset.scenario });
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'x-total-count, content-range, x-atrezzo-scenario, x-atrezzo-ignored, x-atrezzo-stub, x-atrezzo-error',
      'x-atrezzo-scenario': state.dataset.scenario,
    });
    res.flushHeaders?.();

    let idx = 0;
    let timer = null;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      activeStreams.delete(closeStream);
      req.off('close', cleanup);
      res.off('close', cleanup);
      res.off('error', cleanup);
    };

    const closeStream = () => {
      if (closed) return;
      cleanup();
      if (!res.writableEnded && !res.destroyed) res.end();
    };

    activeStreams.add(closeStream);
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    const scheduleNext = () => {
      if (closed) return;
      timer = setTimeout(() => {
        timer = null;
        if (closed || res.writableEnded || res.destroyed) { cleanup(); return; }
        const ev = stream.events[idx];
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
        idx++;
        if (idx >= stream.events.length) {
          if (!stream.loop) {
            closeStream();
            return;
          }
          idx = 0;
        }
        scheduleNext();
      }, stream.interval);
    };

    scheduleNext();
  };

  /**
   * The request is not in the contract: record it and answer 404 (log) or an empty 200 (stub).
   * `error`/`shape` override the message and the stub body (an empty `shape: object` singleton).
   */
  const miss = (req, res, url, status = 404, extraHeaders = {}, { error = null, shape = null, fields = {} } = {}) => {
    const stub = onMiss === 'stub';
    const entry = misses.record({ method: req.method, pathname: url.pathname, query: url.searchParams, headers: req.headers, status: stub ? 200 : status });
    const gap = missKey(req.method, url.pathname);
    log(`${req.method} ${url.pathname}${safeSearch(url.searchParams)} → ${stub ? '200 stub' : status} (gap ${gap}, ${entry.times}×)`);
    if (stub) {
      const body = !isMutation(entry.method) && (shape ?? guessShape(entry.path)) === 'collection' ? [] : {};
      return send(res, 200, body, { ...JSON_CT, 'x-atrezzo-stub': 'true', 'x-atrezzo-scenario': state.dataset.scenario });
    }
    const why = status !== 405 ? ''
      : isWriteMethod(req.method) ? ' (method not declared in scenario; add it under writes:)'
        : ` (method not declared in scenario; ${req.method} cannot be declared under writes:, only ${WRITE_METHODS.join('/')})`;
    return send(res, status, {
      ...fields,
      error: error ?? `${req.method} ${url.pathname} is not in the contract of scenario "${state.dataset.scenario}"${why}`,
      atrezzo: {
        miss: true, gap, times: entry.times, next: 'atrezzo misses', endpoints: state.dataset.endpoints.map((e) => e.path),
        ...(state.dataset.writes?.length ? { writes: state.dataset.writes.map((w) => `${w.method} ${w.path}`) } : {}),
        ...(state.dataset.rpc?.length ? { rpc: state.dataset.rpc.map((r) => r.fn) } : {}),
      },
    }, { ...JSON_CT, ...extraHeaders });
  };

  /** Milliseconds a contract answer waits: the endpoint's `latency:` wins over `serve --latency`. */
  const latencyFor = (pathname) => state.engine.match(pathname)?.ep.latency ?? latency;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      // Every request the app makes, as the mock sees it (harvest uses it to tell whether a view advanced).
      if (req.method !== 'OPTIONS' && !url.pathname.startsWith('/__atrezzo/')) onRequest({ method: req.method, pathname: url.pathname });
      if (req.method === 'OPTIONS') return send(res, 204, '', { 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE', 'access-control-allow-headers': 'content-type, authorization, prefer' });
      if (url.pathname === '/__atrezzo/state' && req.method === 'GET') {
        return send(res, 200, summary(state, available, generatedDir, misses, latency), JSON_CT);
      }
      if (url.pathname === '/__atrezzo/misses') {
        if (req.method === 'GET') {
          const list = misses.list();
          return send(res, 200, { misses: list, unresolved: list.filter((m) => !m.resolved).length }, JSON_CT);
        }
        if (req.method === 'DELETE') { misses.clear(); log('misses cleared'); return send(res, 200, { misses: [], unresolved: 0 }, JSON_CT); }
        return send(res, 405, { error: 'use GET or DELETE' }, { ...JSON_CT, allow: 'GET, DELETE' });
      }
      if (url.pathname === '/__atrezzo/reload') {
        if (req.method !== 'POST') return send(res, 405, { error: 'use POST' }, { ...JSON_CT, allow: 'POST' });
        const nextState = buildState(pick(state.dataset.scenario), resolvedFixturesDir);
        closeAllStreams();
        state = nextState;
        log(`reload → ${state.dataset.scenario} (hash ${state.dataset.hash})`);
        return send(res, 200, summary(state, available, generatedDir, misses, latency), JSON_CT);
      }
      if (url.pathname === '/__atrezzo/reset') {
        if (req.method !== 'POST') return send(res, 405, { error: 'use POST' }, { allow: 'POST' });
        const body = await readBody(req);
        const name = body.scenario ?? url.searchParams.get('scenario') ?? state.dataset.scenario;
        const nextState = buildState(pick(name), resolvedFixturesDir);
        closeAllStreams();
        state = nextState;
        log(`reset → ${state.dataset.scenario}`);
        return send(res, 200, summary(state, available, generatedDir, misses, latency), JSON_CT);
      }
      if (url.pathname.startsWith('/__atrezzo/')) return send(res, 404, { error: `unknown control route ${url.pathname} (available: state, reset, reload, misses)` }, JSON_CT);
      if (req.method === 'GET' || req.method === 'HEAD') {
        const stream = matchStream(url.pathname);
        if (stream) return serveStream(req, res, stream);
      }
      const body = isMutation(req.method) ? await readBody(req) : undefined;
      const r = state.engine.handle({ method: req.method, pathname: url.pathname, query: url.searchParams, headers: req.headers, body });
      // A matched route with an undeclared method is a gap too (405).
      if (r && r.status === 405) return miss(req, res, url, 405, { allow: r.headers?.allow ?? 'GET' });
      if (!r && matchStream(url.pathname) && req.method !== 'GET' && req.method !== 'HEAD') {
        return miss(req, res, url, 405, { allow: 'GET' });
      }
      // Only contract answers wait: static files, control routes and gaps answer immediately.
      if (r) {
        const ms = latencyFor(url.pathname);
        if (ms > 0) await sleep(ms);
      }
      if (r?.miss) {
        // An undeclared PostgREST function keeps PostgREST's code and message next to the gap.
        const fields = r.body.code ? { code: r.body.code, message: r.body.message } : {};
        return miss(req, res, url, 404, {}, { error: r.body.error, shape: 'detail', fields });
      }
      if (r) {
        if (misses.resolve(req.method, url.pathname)) log(`gap ${missKey(req.method, url.pathname)} resolved`);
        log(`${req.method} ${url.pathname}${safeSearch(url.searchParams)} → ${r.status}`);
        return send(res, r.status, r.body, r.headers, r.hasBody ?? r.body !== null);
      }
      if (staticDir && (req.method === 'GET' || req.method === 'HEAD')) {
        const root = resolve(staticDir);
        let file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
        if (file !== root && !file.startsWith(root + sep)) return send(res, 403, { error: 'path outside the static directory' });
        if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
        if (existsSync(file)) return send(res, 200, readFileSync(file), { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        // SPA fallback: a browser navigating to a client-side route (/copilot) gets the app shell.
        // API calls (JSON Accept), unknown API paths and missing assets still fall through to the 404s below.
        const shell = join(root, 'index.html');
        if (wantsHtml(req, url.pathname) && !ASSET.test(url.pathname) && !underApiPrefix([...state.dataset.endpoints, ...(state.dataset.streams ?? [])], url.pathname) && existsSync(shell)) {
          log(`${req.method} ${url.pathname} → 200 index.html (SPA fallback)`);
          return send(res, 200, readFileSync(shell), { 'content-type': MIME['.html'] });
        }
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && ASSET.test(url.pathname)) {
        return send(res, 404, { error: `${url.pathname} does not exist${staticDir ? ' in the static directory' : ''}` }, JSON_CT);
      }
      return miss(req, res, url);
    } catch (e) {
      const status = e instanceof AtrezzoError ? 400 : 500;
      return send(res, status, { error: e.message }, { 'content-type': 'application/json; charset=utf-8' });
    }
  });

  return {
    server,
    get state() { return state; },
    latency,
    misses,
    listen(port = 4010, host = '127.0.0.1') {
      return new Promise((ok, ko) => {
        server.once('error', ko);
        server.listen(port, host, () => { server.off('error', ko); ok(server.address()); });
      });
    },
    close() {
      closeAllStreams();
      return new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); });
    },
  };
}
