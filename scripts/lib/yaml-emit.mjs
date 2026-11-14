// Minimal YAML emitter (no dependencies). Output is block-style, deterministic
// (keys in insertion order) and stays inside the subset that lib/yaml.mjs parses,
// while also being standard YAML 1.2 (Prism, PyYAML, js-yaml read it).
// Strings are emitted plain only when unambiguous; otherwise as JSON strings,
// which are valid YAML double-quoted scalars.

const RESERVED = /^(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE|yes|no|on|off|y|n|Yes|No|On|Off)$/;
const NUMBERISH = /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$|^0[xob]|^[-+]?\.(?:inf|nan)$/i;

function plainOk(s) {
  if (s === '' || s !== s.trim()) return false;
  if (RESERVED.test(s) || NUMBERISH.test(s)) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return false;
  if (/: |:$| #|[\n\r\t]/.test(s)) return false;
  // Dates would be read as timestamps by YAML 1.1 parsers: quote them.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return false;
  return /^[\p{L}\p{N}_ ./()+=~^$-]+$/u.test(s) || /^\/[\w./{}:-]*$/.test(s);
}

export function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`emitYaml: número no finito ${v}`);
    return String(v);
  }
  const s = String(v);
  return plainOk(s) ? s : JSON.stringify(s);
}

function key(k) {
  return plainOk(k) && !k.includes(' ') ? k : JSON.stringify(k);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v) => (Array.isArray(v) ? v.length === 0 : isObj(v) && Object.keys(v).length === 0);

function lines(value, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if ((isObj(item) || Array.isArray(item)) && !isEmpty(item)) {
        const inner = lines(item, indent + 2);
        out.push(`${pad}- ${inner[0].slice(indent + 2)}`, ...inner.slice(1));
      } else out.push(`${pad}- ${inline(item)}`);
    }
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if ((isObj(v) || Array.isArray(v)) && !isEmpty(v)) {
      out.push(`${pad}${key(k)}:`);
      out.push(...lines(v, Array.isArray(v) ? indent + 2 : indent + 2));
    } else out.push(`${pad}${key(k)}: ${inline(v)}`);
  }
  return out;
}

function inline(v) {
  if (Array.isArray(v)) return v.length ? `[${v.map(inline).join(', ')}]` : '[]';
  if (isObj(v)) return Object.keys(v).length ? `{ ${Object.entries(v).map(([k, x]) => `${key(k)}: ${inline(x)}`).join(', ')} }` : '{}';
  return scalar(v);
}

/** Flow (single-line) form, for short lists/maps inside hand-written YAML. */
export const flow = inline;

/** Serialize a JSON-compatible value as block YAML (ends with a newline). */
export function emitYaml(value) {
  if (!isObj(value) && !Array.isArray(value)) return `${scalar(value)}\n`;
  if (isEmpty(value)) return `${inline(value)}\n`;
  return `${lines(value, 0).join('\n')}\n`;
}
