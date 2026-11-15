import { env as readEnv } from './env.mjs';
// HTTP headers declared in a flow (flow level + step level).
// Values may reference environment variables as ${NAME} so secrets (session cookies,
// bearer tokens) never need to be committed in the YAML. Secret-looking headers are
// always masked when printed.

const SECRET_NAMES = new Set(['cookie', 'authorization', 'proxy-authorization', 'set-cookie', 'x-api-key', 'x-auth-token', 'x-csrf-token']);
const SECRET_PATTERN = /token|secret|password|passwd|api[-_]?key|session|auth/i;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/; // RFC 7230 header field-name

export const MASK = '***';

export function isSecretHeader(name) {
  const n = String(name).toLowerCase();
  return SECRET_NAMES.has(n) || SECRET_PATTERN.test(n);
}

/**
 * Validate and normalise a `headers:` map. Adds problems to `issues` (an object with
 * `add(field, msg)`) and returns a plain { Name: 'value' } object (possibly empty).
 * @param {unknown} raw
 * @param {string} field   e.g. "headers" or "steps[0].headers"
 * @param {{ add(field: string, msg: string): void }} issues
 * @param {Record<string, string|undefined>} [env]
 */
export function parseHeaders(raw, field, issues, env = readEnv()) {
  const out = {};
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.add(field, 'must be a map Name: "value"');
    return out;
  }
  for (const [name, value] of Object.entries(raw)) {
    const f = `${field}.${name}`;
    if (!TOKEN.test(name)) { issues.add(f, 'invalid header name'); continue; }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      issues.add(f, `must be a string; got ${Array.isArray(value) ? 'a list' : value === null ? 'null' : typeof value}`);
      continue;
    }
    let missing = null;
    const expanded = String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v) => {
      if (env[v] === undefined) { missing ??= v; return ''; }
      return env[v];
    });
    if (missing) { issues.add(f, `uses \${${missing}} but that environment variable is not set`); continue; }
    if (/[\r\n]/.test(expanded)) { issues.add(f, 'the value cannot contain line breaks'); continue; }
    out[name] = expanded.trim();
  }
  return out;
}

/**
 * Effective headers for a step: flow headers overridden by step headers. Names are
 * compared case-insensitively (HTTP semantics); the step's spelling wins.
 */
export function mergeHeaders(...layers) {
  const byLower = new Map();
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer ?? {})) byLower.set(k.toLowerCase(), [k, v]);
  }
  return Object.fromEntries(byLower.values());
}

/** Copy safe to print: secret-looking values become "***". */
export function maskHeaders(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k, isSecretHeader(k) ? MASK : v]));
}

/** Replace any secret header value that appears inside `text` (error messages, logs). */
export function redact(text, headers) {
  let s = String(text);
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (!isSecretHeader(k) || !v) continue;
    s = s.split(v).join(MASK);
    // a Cookie may be echoed as individual name=value pairs
    if (k.toLowerCase() === 'cookie') for (const part of v.split(';').map((p) => p.trim()).filter((p) => p.length > 8)) s = s.split(part).join(MASK);
  }
  return s;
}

export function formatHeaders(headers) {
  return Object.entries(maskHeaders(headers)).map(([k, v]) => `${k}: ${v}`).join(' · ');
}
