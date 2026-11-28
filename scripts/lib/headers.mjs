import { AtrezzoError, EXIT } from './errors.mjs';
// HTTP headers: declared in a flow (flow level + step level) or passed at run time with
// `verify --header "Name: value"`. A flow holds only values that are safe to commit; a secret
// (session cookie, bearer token) is passed with --header, where the user's own shell supplies
// it. atrezzo reads no environment variable for a header. Secret-looking headers are always
// masked when printed.

const SECRET_NAMES = new Set(['cookie', 'authorization', 'proxy-authorization', 'set-cookie', 'x-api-key', 'x-auth-token', 'x-csrf-token']);
const SECRET_PATTERN = /token|secret|password|passwd|api[-_]?key|session|auth/i;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/; // RFC 7230 header field-name
const RESPONSE_HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/; // RFC 7230 header field-value
const INVALID_RESPONSE_HEADER_VALUE = 'invalid header value (cannot contain line breaks, control characters, or characters above U+00FF)';
const FORBIDDEN_RESPONSE_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-connection',
  'host',
  'date',
]);

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
 */
export function parseHeaders(raw, field, issues) {
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
    const text = String(value);
    if (/\$\{[^}]*\}/.test(text)) { issues.add(f, `\${…} is not expanded: atrezzo reads no environment variables. Remove this header from the flow and pass it at run time: verify --header "${name}: <value>"`); continue; }
    if (/[\r\n]/.test(text)) { issues.add(f, 'the value cannot contain line breaks'); continue; }
    out[name] = text.trim();
  }
  return out;
}

/**
 * Headers passed on the command line: each item is "Name: value", as in curl -H.
 * Errors name the header, never its value. Later items win (case-insensitive).
 * @param {string[]} items
 * @returns {Record<string, string>}
 */
export function parseHeaderArgs(items) {
  const layers = [];
  const problems = [];
  for (const item of items) {
    const i = item.indexOf(':');
    const name = i < 0 ? '' : item.slice(0, i).trim();
    const value = i < 0 ? '' : item.slice(i + 1).trim();
    if (!name || !TOKEN.test(name)) { problems.push(`--header: expected "Name: value"${name && !TOKEN.test(name) ? ' with a valid header name' : ''}`); continue; }
    if (/[\r\n]/.test(value)) { problems.push(`--header ${name}: the value cannot contain line breaks`); continue; }
    if (!value) { problems.push(`--header ${name}: the value is empty (is the shell variable you used set?)`); continue; }
    layers.push({ [name]: value });
  }
  if (problems.length) throw new AtrezzoError(problems.join('\n'), { exitCode: EXIT.INVALID });
  return mergeHeaders(...layers);
}

/** Header lines read from stdin for `--header @-`: one "Name: value" per non-empty line. */
export function headerLines(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
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

/**
 * Whether `value` is a string consisting solely of HTTP field-value bytes allowed by
 * RFC 7230 (HTAB, printable ASCII 0x20-0x7E, or obs-text 0x80-0xFF).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidResponseHeaderValue(value) {
  return typeof value === 'string' && RESPONSE_HEADER_VALUE.test(value);
}

/**
 * Validate and normalise a response `headers:` map. Header names are lowercased; scalar
 * string/number/boolean values are stringified and trimmed; non-empty string arrays are
 * accepted only for `set-cookie`. Hop-by-hop/derived headers and case-insensitive duplicates
 * are rejected. Response values are taken literally (no `${…}` rejection or expansion).
 * @param {unknown} raw
 * @param {string} field   e.g. "endpoints[0].headers"
 * @param {{ add(field: string, msg: string): void }} issues
 * @returns {Record<string, string | string[]>}
 */
export function parseResponseHeaders(raw, field, issues) {
  const out = {};
  if (raw === undefined) return out;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.add(field, 'must be a map Name: "value"');
    return out;
  }
  const seen = new Map();
  for (const [rawName, value] of Object.entries(raw)) {
    const f = `${field}.${rawName}`;
    if (!TOKEN.test(rawName)) {
      issues.add(f, 'invalid header name');
      continue;
    }
    const name = rawName.toLowerCase();
    if (seen.has(name)) {
      issues.add(f, `duplicate header "${name}" (already declared as "${seen.get(name)}")`);
      continue;
    }
    seen.set(name, rawName);
    if (FORBIDDEN_RESPONSE_HEADERS.has(name)) {
      issues.add(f, `forbidden response header "${name}" (managed by the HTTP layer)`);
      continue;
    }
    if (Array.isArray(value)) {
      if (name !== 'set-cookie') {
        issues.add(f, 'must be a scalar value; only "set-cookie" accepts a list of strings');
        continue;
      }
      if (!value.length) {
        issues.add(f, 'must be a string or a non-empty list of strings');
        continue;
      }
      const list = [];
      let ok = true;
      for (let i = 0; i < value.length; i += 1) {
        const item = value[i];
        const fi = `${f}[${i}]`;
        if (typeof item !== 'string') {
          issues.add(fi, `must be a string; got ${Array.isArray(item) ? 'a list' : item === null ? 'null' : typeof item}`);
          ok = false;
          continue;
        }
        if (!isValidResponseHeaderValue(item)) {
          issues.add(fi, INVALID_RESPONSE_HEADER_VALUE);
          ok = false;
          continue;
        }
        const trimmed = item.trim();
        if (!trimmed) {
          issues.add(fi, 'must be a non-empty string');
          ok = false;
          continue;
        }
        list.push(trimmed);
      }
      if (ok) out[name] = list;
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) {
      issues.add(f, `must be a string, number, or boolean${name === 'set-cookie' ? ' (or a non-empty list of strings)' : ''}; got ${value === null ? 'null' : typeof value}`);
      continue;
    }
    const text = String(value);
    if (!isValidResponseHeaderValue(text)) {
      issues.add(f, INVALID_RESPONSE_HEADER_VALUE);
      continue;
    }
    out[name] = text.trim();
  }
  return out;
}

/**
 * Merge response header layers case-insensitively with lowercased keys.
 * Higher layers replace ordinary values; `set-cookie` values append across layers
 * and always return an array.
 * @param {...(Record<string, string | string[]> | null | undefined)} layers
 * @returns {Record<string, string | string[]>}
 */
export function mergeResponseHeaders(...layers) {
  const byLower = new Map();
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined || v === null) continue;
      const key = k.toLowerCase();
      if (key === 'set-cookie') {
        const next = Array.isArray(v) ? v.filter((item) => item !== undefined && item !== null) : [v];
        if (!next.length) continue;
        const prev = byLower.get(key);
        byLower.set(key, prev ? [...prev, ...next] : [...next]);
      } else {
        byLower.set(key, v);
      }
    }
  }
  return Object.fromEntries(byLower);
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
