// Gaps (misses): requests the mock could not answer because the scenario contract
// does not declare them. `serve` records them in <atrezzo>/.atrezzo/misses.json
// (an object keyed by "METHOD /path"), deduplicated, so the plugin can fill them
// from the app's own context (skill /atrezzo:gap).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MASK = '***';
/** Hard cap on stored gaps: dedupe + id collapsing keep it small; this bounds the worst case. */
export const MISS_CAP = 200;

/** <dir of generatedDir>/.atrezzo/misses.json — "atrezzo/.atrezzo/misses.json" with the default config. */
export function missesFile(cfg) {
  return join(cfg._dir, dirname(cfg.generatedDir), '.atrezzo', 'misses.json');
}

const SECRET_NAME = /token|secret|password|passwd|pwd|api[-_]?key|session|auth|signature|^sig$|jwt|credential|^code$|cookie/i;
const JWT = /^eyJ[\w-]+\.[\w-]+\./;
const OPAQUE = /^[A-Za-z0-9_\-+/=.]{32,}$/;

export function isSecretParam(name, value) {
  if (SECRET_NAME.test(name)) return true;
  const v = String(value);
  if (JWT.test(v)) return true;
  // Long opaque strings mixing letters and digits: keys, hashes, signed URLs.
  return OPAQUE.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v);
}

/** URLSearchParams -> plain object with secret-looking values masked. Repeated keys -> list. */
export function maskQuery(params) {
  const out = {};
  for (const [k, v] of params) {
    const val = isSecretParam(k, v) ? MASK : v;
    if (Object.hasOwn(out, k)) out[k] = [].concat(out[k], val);
    else out[k] = val;
  }
  return out;
}

/** "?a=1&token=***" for logs ("" when there is no query). */
export function safeSearch(params) {
  const q = new URLSearchParams();
  for (const [k, v] of params) q.append(k, isSecretParam(k, v) ? MASK : v);
  const s = q.toString().replaceAll('%2A%2A%2A', MASK);
  return s ? `?${s}` : '';
}

/** Referer without query/fragment (they may carry tokens). */
function cleanReferer(ref) {
  if (!ref) return null;
  try { const u = new URL(ref); return `${u.origin}${u.pathname}`; } catch { return null; }
}

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

/** Normalised route: trailing slash removed, id-like segments collapsed to ":id". */
export function missPattern(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  return clean.split('/').map((s) => (ID_SEGMENT.test(s) ? ':id' : s)).join('/');
}

export function missKey(method, pathname) {
  const m = method === 'HEAD' ? 'GET' : method;
  return `${m} ${missPattern(pathname)}`;
}

const SINGULAR_S = new Set(['status', 'settings', 'stats', 'health', 'preferences', 'progress', 'address', 'access', 'news', 'analytics']);

/** "collection" ([]) or "detail" ({}) guessed from the route shape. */
export function guessShape(pattern) {
  const last = pattern.split('/').filter(Boolean).at(-1) ?? '';
  if (last === ':id') return 'detail';
  const word = last.toLowerCase();
  if (SINGULAR_S.has(word)) return 'detail';
  if (/(s|list|items|search)$/.test(word)) return 'collection';
  return 'detail';
}

export const isMutation = (method) => !['GET', 'HEAD'].includes(method);

/** Methods a scenario can declare under writes: (a subset of mutations). */
export const WRITE_METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE']);
export const isWriteMethod = (method) => WRITE_METHODS.includes(method);

/**
 * Store backed by a JSON file (or memory when file is null). The file is re-read when it
 * changes on disk, so `atrezzo misses --clear` from another process is honoured.
 */
export function createMissStore(file = null) {
  let data = {};
  let mtime = -1;
  const sync = () => {
    if (!file) return;
    if (!existsSync(file)) { data = {}; mtime = -1; return; }
    const m = statSync(file).mtimeMs;
    if (m === mtime) return;
    try { const doc = JSON.parse(readFileSync(file, 'utf8')); data = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}; } catch { data = {}; }
    mtime = m;
  };
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    // Local runtime state: never committed.
    const ignore = join(dirname(file), '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, file);
    mtime = statSync(file).mtimeMs;
  };
  const evict = () => {
    const keys = Object.keys(data);
    if (keys.length <= MISS_CAP) return;
    // Resolved first, then least recently seen.
    keys.sort((a, b) => (Number(data[b].resolved) - Number(data[a].resolved)) || data[a].last_seen.localeCompare(data[b].last_seen));
    for (const k of keys.slice(0, keys.length - MISS_CAP)) delete data[k];
  };

  return {
    file,
    /** Record a gap; returns the stored entry. */
    record({ method, pathname, query, headers = {}, now = new Date().toISOString(), status }) {
      sync();
      const key = missKey(method, pathname);
      const prev = data[key];
      const entry = {
        method: method === 'HEAD' ? 'GET' : method,
        path: missPattern(pathname),
        example: pathname,
        query: maskQuery(query ?? new URLSearchParams()),
        times: (prev?.times ?? 0) + 1,
        first_seen: prev?.first_seen ?? now,
        last_seen: now,
        referer: cleanReferer(headers.referer) ?? prev?.referer ?? null,
        accept: headers.accept ?? prev?.accept ?? null,
        resolved: false,
        status,
      };
      data[key] = entry;
      evict();
      save();
      return entry;
    },
    /** Called when a request is served by the contract: marks its gap resolved. */
    resolve(method, pathname, now = new Date().toISOString()) {
      sync();
      const e = data[missKey(method, pathname)];
      if (!e || e.resolved) return false;
      e.resolved = true;
      e.resolved_at = now;
      save();
      return true;
    },
    list() {
      sync();
      return Object.values(data).sort((a, b) => (Number(a.resolved) - Number(b.resolved)) || b.times - a.times || a.path.localeCompare(b.path));
    },
    summary() {
      const l = this.list();
      return { total: l.length, unresolved: l.filter((m) => !m.resolved).length };
    },
    clear() { data = {}; save(); },
  };
}

/** Read misses.json without a store (CLI / doctor). Missing file => []. */
export function readMisses(file) {
  return createMissStore(file).list();
}

// ---------- hints for `atrezzo misses` ----------

const specRegex = (p) => new RegExp(`(^|/)${p.replace(/\/+$/, '').split('/').filter(Boolean).map((s) => (/^\{.+\}$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`);

/**
 * Does the OpenAPI spec declare this gap? Matches by suffix so a spec path "/users"
 * covers "/api/users" (the prefix lives in servers[0].url or in the front's proxy).
 * @returns {{ path: string, method: boolean } | null}
 */
export function findInSpec(spec, method, path) {
  const concrete = path.replace(/:id/g, '1');
  let best = null;
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    if (!specRegex(p).test(concrete)) continue;
    const hasMethod = !!item?.[method.toLowerCase()];
    if (!best || (hasMethod && !best.method)) best = { path: p, method: hasMethod };
  }
  return best;
}

/** "fn" for a PostgREST function call (/rpc/fn, /rest/v1/rpc/fn), else null. */
export function rpcFunction(path) {
  const m = /^(?:\/rest\/v1)?\/rpc\/([^/]+)$/.exec(path);
  return m ? m[1] : null;
}

/** Endpoint paths of scenarios on disk that would serve this gap (with list + detail, plus writes). */
export function coveringScenarios(scenarios, path, method = 'GET') {
  // A `:name` segment of an endpoint path covers any segment of the gap (`:id` included).
  const fits = (pattern, parts) => {
    const segs = pattern.split('/');
    return segs.length === parts.length && segs.every((s, i) => s.startsWith(':') || s === parts[i]);
  };
  const parts = path.split('/');
  const out = [];
  for (const sc of scenarios) {
    if (isMutation(method)) {
      const fn = method === 'POST' ? rpcFunction(path) : null;
      if (fn && (sc.rpc ?? []).some((r) => r.fn === fn)) { out.push(sc.name); continue; }
      if ((sc.writes ?? []).some((w) => w.method === method && fits(w.path, parts))) out.push(sc.name);
      continue;
    }
    if ((sc.streams ?? []).some((s) => fits(s.path, parts))) { out.push(sc.name); continue; }
    for (const ep of sc.endpoints) {
      const detail = ep.detail !== false && parts.length > 1 && fits(ep.path, parts.slice(0, -1));
      if (fits(ep.path, parts) || detail) { out.push(sc.name); break; }
    }
  }
  return out;
}

/** One suggestion per unresolved gap. */
export function hintFor(miss, { spec = null, contract = null, scenarios = [] } = {}) {
  const covering = coveringScenarios(scenarios, miss.path, miss.method);
  if (covering.length) return `already declared by scenario ${covering.join(', ')} → atrezzo world + POST /__atrezzo/reload (or restart serve)`;
  const fn = miss.method === 'POST' ? rpcFunction(miss.path) : null;
  if (fn) return `PostgREST function: declare it under rpc: { ${fn}: { expect: { status: 200 }, body: … } } in the scenario`;
  if (isWriteMethod(miss.method)) return 'mutation: declare it under writes: in the scenario, or use serve --on-miss stub (or leave it unresolved)';
  if (isMutation(miss.method)) return `${miss.method} cannot be declared under writes: (only ${WRITE_METHODS.join('/')}); use serve --on-miss stub (or leave it unresolved)`;
  if (spec) {
    const hit = findInSpec(spec, miss.method, miss.path);
    if (hit?.method) return `the contract has it (${miss.method} ${hit.path}) → atrezzo import ${contract}`;
    if (hit) return `the contract has ${hit.path} but not ${miss.method} → add the endpoint to the scenario (skill /atrezzo:gap)`;
    return 'not in the contract → add the endpoint to the scenario (skill /atrezzo:gap)';
  }
  return 'add the endpoint to the scenario (skill /atrezzo:gap)';
}

const ago = (iso, now) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return iso.slice(0, 10);
};

export function formatMisses(list, hints = new Map(), now = Date.now()) {
  if (!list.length) return 'No gaps recorded: the mock has answered everything the app asked for.';
  const w = Math.max(...list.map((m) => `${m.method} ${m.path}`.length));
  const lines = list.map((m) => {
    const route = `${m.method} ${m.path}`.padEnd(w);
    const times = `${m.times} ${m.times === 1 ? 'time' : 'times'}`.padEnd(9);
    const state = (m.resolved ? 'resolved' : 'unresolved').padEnd(10);
    const hint = !m.resolved && hints.get(m) ? `   → ${hints.get(m)}` : '';
    return `${route}   ${times}  ${state}  ${ago(m.last_seen, now).padEnd(11)}${hint}`;
  });
  const open = list.filter((m) => !m.resolved).length;
  return `${lines.join('\n')}\n${list.length} ${list.length === 1 ? 'gap' : 'gaps'} · ${open} unresolved`;
}
