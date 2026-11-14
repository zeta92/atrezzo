// Strict YAML-subset parser with no dependencies.
// Supported: block mappings and sequences (spaces only), flow collections on a
// single line ({a: 1}, [x, y]), quoted and plain scalars, null/booleans/numbers,
// block scalars (| and >), comments and an optional leading `---`.
// Not supported (fails with a clear error): anchors/aliases, tags, multi-document
// streams, multi-line flow collections. The scenario files never need them.

export class YamlError extends Error {
  constructor(message, line, file) {
    super(`${file}${line ? ` (línea ${line})` : ''}: YAML inválido: ${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

/** Index of the `:` that separates key and value, or -1. */
function findKeySep(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { if (i === 0) quote = c; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === ':' && depth === 0 && (i === text.length - 1 || text[i + 1] === ' ')) return i;
  }
  return -1;
}

function unquote(raw, ctx) {
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) ctx.fail(`cadena entre comillas sin cerrar: ${raw}`);
    try { return JSON.parse(raw); } catch { ctx.fail(`cadena entre comillas dobles mal formada: ${raw}`); }
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) ctx.fail(`cadena entre comillas sin cerrar: ${raw}`);
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return null;
}

function plainScalar(raw, ctx) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^[-+]?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('&') || s.startsWith('*') || s.startsWith('!')) {
    ctx.fail(`anclas, alias y etiquetas no están soportados: ${s}`);
  }
  if (s.startsWith('@') || s.startsWith('`')) ctx.fail(`un escalar no puede empezar por "${s[0]}"; usa comillas`);
  return s;
}

function parseFlow(text, ctx) {
  let i = 0;
  const ws = () => { while (i < text.length && text[i] === ' ') i++; };
  function value(stops) {
    ws();
    const c = text[i];
    if (c === '{') return map();
    if (c === '[') return seq();
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      while (i < text.length && text[i] !== c) { if (c === '"' && text[i] === '\\') i++; i++; }
      if (i >= text.length) ctx.fail(`cadena sin cerrar en colección en línea: ${text}`);
      i++;
      return unquote(text.slice(start, i), ctx);
    }
    const start = i;
    while (i < text.length && !stops.includes(text[i])) i++;
    return plainScalar(text.slice(start, i), ctx);
  }
  function map() {
    i++;
    const out = {};
    ws();
    if (text[i] === '}') { i++; return out; }
    for (;;) {
      ws();
      let key;
      if (text[i] === '"' || text[i] === "'") key = String(value([':']));
      else {
        const start = i;
        while (i < text.length && text[i] !== ':' && text[i] !== ',' && text[i] !== '}') i++;
        key = text.slice(start, i).trim();
      }
      ws();
      if (text[i] !== ':') ctx.fail(`se esperaba ":" tras la clave "${key}" en ${text}`);
      i++;
      if (Object.hasOwn(out, key)) ctx.fail(`clave duplicada "${key}"`);
      out[key] = value([',', '}']);
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return out; }
      ctx.fail(`colección {…} sin cerrar o mal separada: ${text}`);
    }
  }
  function seq() {
    i++;
    const out = [];
    ws();
    if (text[i] === ']') { i++; return out; }
    for (;;) {
      out.push(value([',', ']']));
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; return out; }
      ctx.fail(`colección […] sin cerrar o mal separada: ${text}`);
    }
  }
  const v = value([]);
  ws();
  if (i < text.length) ctx.fail(`contenido inesperado tras la colección: "${text.slice(i)}"`);
  return v;
}

function inlineValue(raw, ctx) {
  const s = raw.trim();
  if (s.startsWith('{') || s.startsWith('[')) return parseFlow(s, ctx);
  const q = unquote(s, ctx);
  if (q !== null) return q;
  return plainScalar(s, ctx);
}

export function parseYaml(src, file = '<yaml>') {
  if (typeof src !== 'string') throw new YamlError('la entrada no es texto', 0, file);
  const raw = src.replace(/^﻿/, '').split(/\r?\n/);
  const lines = [];
  raw.forEach((full, idx) => {
    const num = idx + 1;
    const m = /^([ \t]*)/.exec(full);
    if (m[1].includes('\t')) throw new YamlError('tabulador en la indentación; usa espacios', num, file);
    lines.push({ num, indent: m[1].length, raw: full, text: stripComment(full).trimEnd().slice(m[1].length) });
  });
  let pos = 0;
  const ctx = { fail(msg) { throw new YamlError(msg, lines[Math.min(pos, lines.length - 1)]?.num, file); } };
  const skip = () => { while (pos < lines.length && lines[pos].text === '') pos++; };

  skip();
  if (pos < lines.length && lines[pos].text === '---') { pos++; skip(); }
  if (pos >= lines.length) return null;

  function isSeqItem(l) { return l.text === '-' || l.text.startsWith('- '); }

  function blockScalar(style, parentIndent) {
    const out = [];
    let indent = null;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.raw.trim() === '') { out.push(''); pos++; continue; }
      if (l.indent <= parentIndent) break;
      if (indent === null) indent = l.indent;
      if (l.indent < indent) break;
      out.push(l.raw.slice(indent));
      pos++;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return style === '|' ? out.join('\n') + '\n' : out.join(' ').replace(/ ?\n ?/g, '\n') + '\n';
  }

  function block(indent) {
    skip();
    if (pos >= lines.length) return null;
    const l = lines[pos];
    if (l.indent !== indent) ctx.fail(`indentación inesperada (${l.indent} espacios, se esperaban ${indent})`);
    return isSeqItem(l) ? sequence(indent) : mapping(indent);
  }

  function childValue(parentIndent, allowSameIndentSeq) {
    pos++;
    skip();
    if (pos >= lines.length) return null;
    const l = lines[pos];
    if (l.indent > parentIndent) return block(l.indent);
    if (allowSameIndentSeq && l.indent === parentIndent && isSeqItem(l)) return sequence(parentIndent);
    return null;
  }

  function mapping(indent) {
    const out = {};
    while (pos < lines.length) {
      skip();
      if (pos >= lines.length) break;
      const l = lines[pos];
      if (l.indent < indent) break;
      if (l.indent > indent) ctx.fail('indentación inesperada dentro de un mapa');
      if (isSeqItem(l)) ctx.fail('elemento de lista "-" donde se esperaba una clave');
      const sep = findKeySep(l.text);
      if (sep < 0) ctx.fail(`se esperaba "clave: valor" y se encontró "${l.text}"`);
      let key = l.text.slice(0, sep).trim();
      const uq = unquote(key, ctx);
      if (uq !== null) key = uq;
      if (key === '') ctx.fail('clave vacía');
      if (Object.hasOwn(out, key)) ctx.fail(`clave duplicada "${key}"`);
      const rest = l.text.slice(sep + 1).trim();
      if (rest === '') out[key] = childValue(indent, true);
      else if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
        pos++;
        let v = blockScalar(rest[0], indent);
        if (rest.endsWith('-')) v = v.replace(/\n$/, '');
        out[key] = v;
      } else { out[key] = inlineValue(rest, ctx); pos++; }
    }
    return out;
  }

  function sequence(indent) {
    const out = [];
    while (pos < lines.length) {
      skip();
      if (pos >= lines.length) break;
      const l = lines[pos];
      if (l.indent < indent) break;
      if (l.indent > indent) ctx.fail('indentación inesperada dentro de una lista');
      if (!isSeqItem(l)) break;
      const content = l.text === '-' ? '' : l.text.slice(2);
      const lead = content.length - content.trimStart().length;
      const body = content.trim();
      if (body === '') { out.push(childValue(indent, false)); continue; }
      if (isSeqItem({ text: body }) || (findKeySep(body) >= 0 && !body.startsWith('{') && !body.startsWith('['))) {
        // Re-interpret the rest of the line as the first line of a nested block.
        const nested = indent + 2 + lead;
        lines[pos] = { ...l, indent: nested, text: body };
        out.push(block(nested));
        continue;
      }
      out.push(inlineValue(body, ctx));
      pos++;
    }
    return out;
  }

  const result = block(lines[pos].indent);
  skip();
  if (pos < lines.length) ctx.fail(`contenido inesperado: "${lines[pos].text}"`);
  return result;
}
