// Standalone HTTP mock server (plain node:http, MSW not required).
// Uses the same projection engine (contract.mjs) as the generated MSW handlers.
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, posix, resolve, sep } from 'node:path';
import { AtrezzoError } from './errors.mjs';
import { loadScenario, scenarioNameFromFile } from './scenario.mjs';
import { generateWorld } from './world.mjs';
import { createEngine } from './contract.mjs';
import { createMissStore, guessShape, isMutation, missKey, safeSearch } from './misses.mjs';

export const ON_MISS = ['log', 'stub'];
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
    const prefix = posix.dirname(e.path);
    return prefix !== '/' && pathname.startsWith(`${prefix}/`);
  });
}

/** Map of scenario name -> file, by file basename and by `name:` field. */
export function listScenarios(dir) {
  if (!existsSync(dir)) throw new AtrezzoError(`Scenarios directory ${dir} does not exist`);
  const out = {};
  for (const f of readdirSync(dir).sort()) {
    if (!/\.(ya?ml|json)$/.test(f)) continue;
    const file = join(dir, f);
    out[scenarioNameFromFile(f)] = file;
    try { out[loadScenario(file).name] = file; } catch { /* invalid files surface when selected */ }
  }
  return out;
}

export function buildState(scenarioFile) {
  const scenario = loadScenario(scenarioFile);
  const dataset = generateWorld(scenario);
  return { scenario, dataset, engine: createEngine(dataset), file: scenarioFile };
}

function summary(state, available, generatedDir, misses) {
  const d = state.dataset;
  const out = {
    scenario: d.scenario, seed: d.seed, now: d.now, hash: d.hash,
    counts: Object.fromEntries(Object.entries(d.entities).map(([k, v]) => [k, v.length])),
    endpoints: d.endpoints.map((e) => e.path),
    available: [...new Set(Object.values(available).map((f) => scenarioNameFromFile(f)))],
  };
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
 *   missesFile?: string|null, onMiss?: 'log'|'stub', log?: (s:string)=>void }} opts
 *   missesFile: where gaps are recorded (null = memory only) · onMiss: 404 (log) or empty 200 (stub)
 */
export function createMockServer({ scenariosDir, scenario, staticDir = null, generatedDir = null, missesFile = null, onMiss = 'log', log = () => {} }) {
  if (!ON_MISS.includes(onMiss)) throw new AtrezzoError(`--on-miss must be ${ON_MISS.join(' or ')} (got "${onMiss}")`);
  const misses = createMissStore(missesFile);
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
  let state = buildState(pick(scenario));

  const send = (res, status, body, headers = {}) => {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-total-count, x-atrezzo-scenario, x-atrezzo-ignored, x-atrezzo-stub', 'cache-control': 'no-store', ...headers });
    res.end(res.req.method === 'HEAD' ? undefined : payload);
  };

  const JSON_CT = { 'content-type': 'application/json; charset=utf-8' };

  /** The request is not in the contract: record it and answer 404 (log) or an empty 200 (stub). */
  const miss = (req, res, url, status = 404, extraHeaders = {}) => {
    const stub = onMiss === 'stub';
    const entry = misses.record({ method: req.method, pathname: url.pathname, query: url.searchParams, headers: req.headers, status: stub ? 200 : status });
    const gap = missKey(req.method, url.pathname);
    log(`${req.method} ${url.pathname}${safeSearch(url.searchParams)} → ${stub ? '200 stub' : status} (gap ${gap}, ${entry.times}×)`);
    if (stub) {
      const body = !isMutation(entry.method) && guessShape(entry.path) === 'collection' ? [] : {};
      return send(res, 200, body, { ...JSON_CT, 'x-atrezzo-stub': 'true', 'x-atrezzo-scenario': state.dataset.scenario });
    }
    const why = status === 405 ? ' (atrezzo only projects reads)' : '';
    return send(res, status, {
      error: `${req.method} ${url.pathname} is not in the contract of scenario "${state.dataset.scenario}"${why}`,
      atrezzo: { miss: true, gap, times: entry.times, next: 'atrezzo misses', endpoints: state.dataset.endpoints.map((e) => e.path) },
    }, { ...JSON_CT, ...extraHeaders });
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '', { 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE', 'access-control-allow-headers': 'content-type, authorization' });
      if (url.pathname === '/__atrezzo/state' && req.method === 'GET') {
        return send(res, 200, summary(state, available, generatedDir, misses), JSON_CT);
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
        state = buildState(pick(state.dataset.scenario));
        log(`reload → ${state.dataset.scenario} (hash ${state.dataset.hash})`);
        return send(res, 200, summary(state, available, generatedDir, misses), JSON_CT);
      }
      if (url.pathname === '/__atrezzo/reset') {
        if (req.method !== 'POST') return send(res, 405, { error: 'use POST' }, { allow: 'POST' });
        const body = await readBody(req);
        const name = body.scenario ?? url.searchParams.get('scenario') ?? state.dataset.scenario;
        state = buildState(pick(name));
        log(`reset → ${state.dataset.scenario}`);
        return send(res, 200, summary(state, available, generatedDir, misses), JSON_CT);
      }
      if (url.pathname.startsWith('/__atrezzo/')) return send(res, 404, { error: `unknown control route ${url.pathname} (available: state, reset, reload, misses)` }, JSON_CT);
      const r = state.engine.handle({ method: req.method, pathname: url.pathname, query: url.searchParams });
      // A matched route with a non-GET method is a write: not in the contract either.
      if (r && r.status === 405) return miss(req, res, url, 405, { allow: 'GET' });
      if (r) {
        if (misses.resolve(req.method, url.pathname)) log(`gap ${missKey(req.method, url.pathname)} resolved`);
        log(`${req.method} ${url.pathname}${safeSearch(url.searchParams)} → ${r.status}`);
        return send(res, r.status, r.body, r.headers);
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
        if (wantsHtml(req, url.pathname) && !ASSET.test(url.pathname) && !underApiPrefix(state.dataset.endpoints, url.pathname) && existsSync(shell)) {
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
    misses,
    listen(port = 4010, host = '127.0.0.1') {
      return new Promise((ok, ko) => {
        server.once('error', ko);
        server.listen(port, host, () => { server.off('error', ko); ok(server.address()); });
      });
    },
    close() { return new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }); },
  };
}
