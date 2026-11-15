// Minimal TypeScript type/interface parser for `atrezzo harvest --types`.
// Pure ESM, no dependencies: extracts `interface X`, `type X = { ... }`,
// `type X = 'a' | 'b'`, and `enum X` with exact 1-based source line numbers.

const ISO_DATE_LITERAL = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE_TYPE_NAMES = new Set(['date', 'isodate', 'isodatestring', 'datestring', 'datetime', 'isostring', 'timestamp']);

/** Replace // and /* ... *\/ comments with spaces while keeping newlines intact (preserves line numbers). */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\' && quote !== '`' && i + 1 < src.length) { out += next; i += 2; continue; }
      if (ch === '\\' && quote === '`' && i + 1 < src.length) { out += next; i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i++; continue; }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < src.length) { out += '  '; i += 2; }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Find matching closing brace `}` starting at `openIdx` (where `src[openIdx] === '{'`). */
function findMatchingBrace(src, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Read type alias RHS starting at `startIdx` up to `;` or top-level newline/EOF. */
function readAliasExpr(src, startIdx) {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;
  let quote = null;
  let i = startIdx;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; i++; continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '{') brace++;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '<') angle++;
    else if (ch === '>' && src[i - 1] !== '=') angle = Math.max(0, angle - 1);
    if (paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      if (ch === ';') return { expr: src.slice(startIdx, i).trim(), endIdx: i + 1 };
      if (ch === '\n') {
        const rest = src.slice(i + 1).trimStart();
        const cur = src.slice(startIdx, i).trimEnd();
        if (!cur.endsWith('|') && !cur.endsWith('&') && !rest.startsWith('|') && !rest.startsWith('&')) {
          return { expr: cur.trim(), endIdx: i + 1 };
        }
      }
    }
    i++;
  }
  return { expr: src.slice(startIdx).trim(), endIdx: src.length };
}

function lineNumberAt(src, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (src[i] === '\n') line++;
  return line;
}

/** Split `s` by `sep` only at depth 0 outside strings and delimiters. */
function splitTopLevel(s, sep) {
  const parts = [];
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '{') brace++;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '<') angle++;
    else if (ch === '>' && s[i - 1] !== '=') angle = Math.max(0, angle - 1);
    else if (ch === sep && paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/** Split an interface/object body into member declarations. */
function splitMembers(body) {
  const members = [];
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '{') brace++;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '<') angle++;
    else if (ch === '>' && body[i - 1] !== '=') angle = Math.max(0, angle - 1);
    else if (paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      if (ch === ';' || ch === ',') {
        const piece = body.slice(start, i).trim();
        if (piece) members.push(piece);
        start = i + 1;
      } else if (ch === '\n') {
        const cur = body.slice(start, i).trim();
        const rest = body.slice(i + 1).trimStart();
        if (cur && cur.includes(':') && !/[|&=?:]$/.test(cur) && !/^[|&]/.test(rest)) {
          members.push(cur);
          start = i + 1;
        }
      }
    }
  }
  const tail = body.slice(start).trim();
  if (tail) members.push(tail);
  return members;
}

function unquoteLiteral(raw) {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  return null;
}

function unwrapParens(s) {
  let t = s.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0;
    let quote = null;
    let matchedAll = true;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0 && i < t.length - 1) { matchedAll = false; break; }
      }
    }
    if (!matchedAll) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** Parse `{ prop: type, ... }` body into raw property map `{ name, rawType }[]`. */
function parseMembers(body) {
  const props = [];
  const skipped = [];
  for (const m of splitMembers(body)) {
    if (m.startsWith('[')) { skipped.push(`index signature (${m.slice(0, 32)})`); continue; }
    const match = /^(?:readonly\s+)?([A-Za-z_$][\w$]*|"[^"]+"|'[^']+')\s*\??\s*:\s*([\s\S]+)$/.exec(m);
    if (!match) {
      if (/\([^)]*\)\s*:/.test(m)) skipped.push(`method (${m.split('(')[0].trim()})`);
      continue;
    }
    const rawName = match[1];
    const name = rawName.startsWith('"') || rawName.startsWith("'") ? unquoteLiteral(rawName) ?? rawName : rawName;
    props.push({ name, rawType: match[2].trim() });
  }
  return { props, skipped };
}

function parseEnumMembers(body) {
  const vals = [];
  for (const part of splitTopLevel(body, ',')) {
    const t = part.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq >= 0) {
      const rhs = t.slice(eq + 1).trim();
      const u = unquoteLiteral(rhs);
      if (u !== null) vals.push(u);
      else if (/^-?\d+(\.\d+)?$/.test(rhs)) vals.push(Number(rhs));
    } else {
      vals.push(t);
    }
  }
  return vals;
}

/** Extract inner element type if `expr` is `T[]`, `readonly T[]`, `Array<T>`, or `ReadonlyArray<T>`. */
export function unwrapArrayType(expr) {
  let s = expr.trim().replace(/^readonly\s+/, '');
  if (s.endsWith('[]')) return unwrapParens(s.slice(0, -2));
  const m = /^(?:Readonly)?Array\s*<([\s\S]+)>$/.exec(s);
  if (m) return unwrapParens(m[1]);
  return null;
}

function sampleArrayFor(mapped) {
  if (mapped.type === 'string') return ['item 1', 'item 2'];
  if (mapped.type === 'integer') return [1, 2];
  if (mapped.type === 'number') return [1, 2];
  if (mapped.type === 'boolean') return [true, false];
  if (mapped.type === 'date') return ['2025-01-15T09:00:00.000Z'];
  if (Array.isArray(mapped.type)) return mapped.type.slice(0, 2);
  return null;
}

/**
 * Map a TypeScript type expression to an atrezzo field spec:
 * - `{ type: 'string' | 'integer' | 'boolean' | 'date' | string[] }`
 * - `{ arrayValues: unknown[] }` (for primitive arrays -> scenario `values:`)
 * - `{ skip: string }` (uninferrable)
 */
export function mapTsType(rawExpr, aliases = new Map(), visited = new Set()) {
  const expr = unwrapParens(rawExpr);
  if (!expr) return { skip: 'empty type' };

  const unionParts = splitTopLevel(expr, '|')
    .map((p) => p.trim())
    .filter((p) => p && p !== 'null' && p !== 'undefined' && p !== 'void');
  if (!unionParts.length) return { skip: 'null/undefined only' };

  // All string literals -> enum list (or date if a single ISO date literal).
  const literals = unionParts.map((p) => unquoteLiteral(p));
  if (literals.every((l) => l !== null)) {
    if (literals.length === 1 && ISO_DATE_LITERAL.test(literals[0])) return { type: 'date' };
    if (literals.every((l) => ISO_DATE_LITERAL.test(l)) && literals.length === 1) return { type: 'date' };
    return { type: [...new Set(literals)] };
  }

  if (unionParts.length > 1) return { skip: expr };

  const part = unwrapParens(unionParts[0]);
  if (DATE_TYPE_NAMES.has(part.toLowerCase())) return { type: 'date' };
  if (/^`\$\{number\}-\$\{number\}-\$\{number\}/.test(part)) return { type: 'date' };
  if (part === 'string') return { type: 'string' };
  if (part === 'number' || part === 'bigint') return { type: 'integer' };
  if (part === 'boolean') return { type: 'boolean' };

  const arrInner = unwrapArrayType(part);
  if (arrInner !== null) {
    const inner = mapTsType(arrInner, aliases, visited);
    const sample = inner.type ? sampleArrayFor(inner) : null;
    if (sample) return { arrayValues: sample };
    return { skip: `array of ${arrInner}` };
  }

  if (aliases.has(part) && !visited.has(part)) {
    const nextVisited = new Set(visited);
    nextVisited.add(part);
    const a = aliases.get(part);
    if (a.kind === 'enum') return a.values.length ? { type: a.values } : { skip: `empty enum ${part}` };
    if (a.kind === 'alias') return mapTsType(a.expr, aliases, nextVisited);
  }

  return { skip: part };
}

/**
 * Parse all `interface`, `type`, and `enum` declarations from TypeScript source.
 * @returns {{ objects: Map<string, object>, aliases: Map<string, object>, file: string }}
 */
export function parseTsTypes(source, file = '<types>') {
  const clean = stripComments(source);
  const objects = new Map();
  const aliases = new Map();

  let i = 0;
  let braceDepth = 0;
  let quote = null;
  const DECL_RE = /^(?:export\s+)?(?:declare\s+)?(interface|type|(?:const\s+)?enum)\s+([A-Za-z_$][\w$]*)/;

  while (i < clean.length) {
    const ch = clean[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; i++; continue; }
    if (ch === '{') { braceDepth++; i++; continue; }
    if (ch === '}') { braceDepth = Math.max(0, braceDepth - 1); i++; continue; }

    if (braceDepth === 0 && (i === 0 || !/[\w$]/.test(clean[i - 1]))) {
      const m = DECL_RE.exec(clean.slice(i));
      if (m) {
        const declStart = i;
        const line = lineNumberAt(clean, declStart);
        const kindWord = m[1].replace(/^const\s+/, '');
        const name = m[2];
        let cursor = i + m[0].length;
        // Skip optional type params `<...>`
        while (cursor < clean.length && /\s/.test(clean[cursor])) cursor++;
        if (clean[cursor] === '<') {
          let angle = 0;
          while (cursor < clean.length) {
            if (clean[cursor] === '<') angle++;
            else if (clean[cursor] === '>') { angle--; if (angle === 0) { cursor++; break; } }
            cursor++;
          }
        }
        if (kindWord === 'interface') {
          const braceIdx = clean.indexOf('{', cursor);
          if (braceIdx !== -1) {
            const header = clean.slice(cursor, braceIdx);
            const extMatch = /\bextends\s+([\s\S]+)$/.exec(header);
            const extendsList = extMatch ? extMatch[1].split(',').map((s) => s.trim().replace(/<.*>$/, '')).filter(Boolean) : [];
            const endIdx = findMatchingBrace(clean, braceIdx);
            if (endIdx !== -1) {
              const { props, skipped } = parseMembers(clean.slice(braceIdx + 1, endIdx));
              objects.set(name, { kind: 'interface', name, line, extends: extendsList, props, skipped });
              i = endIdx + 1;
              continue;
            }
          }
        } else if (kindWord === 'enum') {
          const braceIdx = clean.indexOf('{', cursor);
          if (braceIdx !== -1) {
            const endIdx = findMatchingBrace(clean, braceIdx);
            if (endIdx !== -1) {
              aliases.set(name, { kind: 'enum', name, line, values: parseEnumMembers(clean.slice(braceIdx + 1, endIdx)) });
              i = endIdx + 1;
              continue;
            }
          }
        } else if (kindWord === 'type') {
          while (cursor < clean.length && /\s/.test(clean[cursor])) cursor++;
          if (clean[cursor] === '=') {
            cursor++;
            while (cursor < clean.length && /\s/.test(clean[cursor])) cursor++;
            if (clean[cursor] === '{') {
              const endIdx = findMatchingBrace(clean, cursor);
              if (endIdx !== -1) {
                const { props, skipped } = parseMembers(clean.slice(cursor + 1, endIdx));
                objects.set(name, { kind: 'type', name, line, extends: [], props, skipped });
                i = endIdx + 1;
                continue;
              }
            } else {
              const { expr, endIdx } = readAliasExpr(clean, cursor);
              aliases.set(name, { kind: 'alias', name, line, expr });
              i = endIdx;
              continue;
            }
          }
        }
      }
    }
    i++;
  }

  return { objects, aliases, file };
}

/** Collect all properties of an object type, resolving `extends` within the same file. */
export function resolveObjectProps(obj, objects, visited = new Set()) {
  if (!obj || visited.has(obj.name)) return { props: [], skipped: [] };
  const nextVisited = new Set(visited);
  nextVisited.add(obj.name);
  const byName = new Map();
  const skipped = [];
  for (const parentName of obj.extends ?? []) {
    const parent = objects.get(parentName);
    if (!parent) { skipped.push(`extends ${parentName} (not found in ${obj.name})`); continue; }
    const p = resolveObjectProps(parent, objects, nextVisited);
    for (const prop of p.props) byName.set(prop.name, prop);
    skipped.push(...p.skipped);
  }
  for (const prop of obj.props) byName.set(prop.name, prop);
  skipped.push(...obj.skipped);
  return { props: [...byName.values()], skipped };
}

const normIdent = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function singularizeWord(s) {
  if (/ies$/.test(s) && s.length > 4) return `${s.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/.test(s)) return s.slice(0, -2);
  return s.replace(/s$/, '');
}

const WRAPPER_KEYS = ['items', 'data', 'results', 'records', 'content'];

/**
 * Match an endpoint path's last segment against parsed TS types.
 * Returns `{ fields, values, skipped, line, file, shape, pick, typeName }` or null.
 */
export function resolveTypeForSegment(parsed, segment) {
  if (!parsed || !segment) return null;
  const cleanSeg = segment.toLowerCase();
  const sing = singularizeWord(cleanSeg);
  const nSeg = normIdent(cleanSeg);
  const nSing = normIdent(sing);

  // Check response wrapper types first (e.g. TasksResponse, ProjectsPayload, InfoResponse).
  const wrapperNames = new Set([
    `${nSing}response`, `${nSeg}response`,
    `${nSing}result`, `${nSeg}result`,
    `${nSing}payload`, `${nSeg}payload`,
    `get${nSing}response`, `get${nSeg}response`,
    `list${nSeg}response`,
  ]);

  const allObjects = [...parsed.objects.values()];
  const wrapperObj = allObjects.find((o) => wrapperNames.has(normIdent(o.name)));
  if (wrapperObj) {
    const resolved = resolveObjectProps(wrapperObj, parsed.objects);
    for (const wk of WRAPPER_KEYS) {
      const prop = resolved.props.find((p) => p.name === wk);
      if (!prop) continue;
      const inner = unwrapArrayType(prop.rawType);
      if (inner && parsed.objects.has(inner)) {
        const itemObj = parsed.objects.get(inner);
        return extractFields(itemObj, parsed, { shape: 'envelope', pick: wk });
      }
    }
    // No items/data key -> consumer expects a singleton object.
    return extractFields(wrapperObj, parsed, { shape: 'object', pick: null });
  }

  // Check array alias like `type TasksResponse = Task[]`
  for (const a of parsed.aliases.values()) {
    if (a.kind === 'alias' && wrapperNames.has(normIdent(a.name))) {
      const inner = unwrapArrayType(a.expr);
      if (inner && parsed.objects.has(inner)) {
        return extractFields(parsed.objects.get(inner), parsed, { shape: 'array', pick: null });
      }
    }
  }

  // Direct entity interface/type match: singular first, then exact/plural.
  const entityObj = allObjects.find((o) => normIdent(o.name) === nSing)
    ?? allObjects.find((o) => normIdent(o.name) === nSeg);
  if (entityObj) {
    return extractFields(entityObj, parsed, { shape: null, pick: null });
  }
  return null;
}

function extractFields(obj, parsed, { shape, pick }) {
  const { props, skipped: structSkipped } = resolveObjectProps(obj, parsed.objects);
  const fields = {};
  const values = {};
  const skipped = [...structSkipped];
  for (const p of props) {
    if (p.name === 'id') continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name)) { skipped.push(`${p.name} (invalid field name)`); continue; }
    const mapped = mapTsType(p.rawType, parsed.aliases);
    if (mapped.skip) skipped.push(`${p.name} (${mapped.skip})`);
    else if (mapped.arrayValues) values[p.name] = [mapped.arrayValues];
    else fields[p.name] = mapped.type;
  }
  return { fields, values, skipped, line: obj.line, file: parsed.file, shape, pick, typeName: obj.name };
}
