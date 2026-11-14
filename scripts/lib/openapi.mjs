// `atrezzo import`: OpenAPI (3.x or Swagger 2.0, YAML or JSON) -> scenario.
// Infers entities, fields and types from the 200 response of GET routes,
// envelopes ({data: [...]}, {items: [...]}) into `pick`, enum query params into
// filters and limit/offset/page into pagination. Nothing is dropped silently:
// every route ends up as an endpoint, a `# TODO` in the YAML, or an ignored
// route with its reason in the report.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { AtrezzoError } from './errors.mjs';
import { parseYaml, YamlError } from './yaml.mjs';
import { flow, scalar } from './yaml-emit.mjs';
import { loadScenario } from './scenario.mjs';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const WRAPPERS = ['data', 'items', 'results', 'records', 'content'];
const LIMIT = ['limit', 'per_page', 'perPage', 'page_size', 'pageSize', 'size'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function loadSpec(file) {
  if (!existsSync(file)) throw new AtrezzoError(`No existe el contrato ${file}`);
  const text = readFileSync(file, 'utf8');
  let doc;
  if (/\.json$/i.test(file) || /^\s*\{/.test(text)) {
    try { doc = JSON.parse(text); } catch (e) { throw new AtrezzoError(`${file}: JSON inválido: ${e.message}`); }
  } else {
    try { doc = parseYaml(text, file); } catch (e) {
      if (e instanceof YamlError) throw new AtrezzoError(`${e.message}\n  El parser YAML de atrezzo es un subconjunto (sin anclas, alias ni colecciones {…} multilínea). Convierte el spec a JSON y vuelve a importarlo.`);
      throw e;
    }
  }
  if (!isObj(doc) || (!doc.openapi && !doc.swagger)) throw new AtrezzoError(`${file}: no parece un OpenAPI (falta "openapi" o "swagger" en la raíz)`);
  if (!isObj(doc.paths)) throw new AtrezzoError(`${file}: el spec no tiene "paths"`);
  return doc;
}

function makeDeref(spec, notes) {
  const cache = new Map();
  const deref = (node, depth = 0) => {
    if (!isObj(node) || typeof node.$ref !== 'string') return node;
    const ref = node.$ref;
    if (!ref.startsWith('#/')) { notes.add(`$ref externo no soportado: ${ref}`); return null; }
    if (depth > 20) { notes.add(`$ref circular: ${ref}`); return null; }
    if (cache.has(ref)) return cache.get(ref);
    let cur = spec;
    for (const part of ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))) cur = isObj(cur) ? cur[part] : undefined;
    if (cur === undefined) { notes.add(`$ref roto: ${ref}`); return null; }
    const out = deref(cur, depth + 1);
    cache.set(ref, out);
    return out;
  };
  return deref;
}

/** Merge allOf members into one object schema (properties + required). */
function flatten(schema, deref) {
  const s = deref(schema);
  if (!isObj(s)) return s;
  if (!Array.isArray(s.allOf)) return s;
  const out = { type: 'object', properties: {}, required: [] };
  for (const part of s.allOf.map((x) => flatten(x, deref))) {
    if (!isObj(part)) continue;
    Object.assign(out.properties, part.properties ?? {});
    out.required.push(...(part.required ?? []));
  }
  Object.assign(out.properties, s.properties ?? {});
  return out;
}

const snake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
function plural(s) {
  if (/s$/.test(s)) return s;
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(x|ch|sh)$/.test(s)) return `${s}es`;
  return `${s}s`;
}
function entityName(raw) {
  let n = plural(snake(raw));
  if (!/^[a-z]/.test(n)) n = `e_${n}`;
  return n || 'items';
}
const refName = (schema) => (isObj(schema) && typeof schema.$ref === 'string' ? schema.$ref.split('/').pop() : null);

/** OpenAPI property -> atrezzo field type ({ type } or { skip: reason }). */
function fieldType(prop, deref) {
  const p = flatten(prop, deref);
  if (!isObj(p)) return { skip: 'esquema irresoluble' };
  const enumVals = p.enum;
  if (Array.isArray(enumVals) && enumVals.length && enumVals.every((v) => v === null || typeof v !== 'object')) return { type: enumVals.filter((v) => v !== null) };
  const t = Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type;
  if (t === 'integer') return { type: 'entero' };
  if (t === 'number') return { type: 'numero' };
  if (t === 'boolean') return { type: 'booleano' };
  if (t === 'string') {
    if (p.format === 'binary' || p.format === 'byte') return { skip: `string ${p.format} (binario)` };
    return { type: { 'date-time': 'fecha', date: 'fecha', email: 'email', uuid: 'uuid', uri: 'url', url: 'url' }[p.format] ?? 'texto' };
  }
  if (t === 'array' || p.items) return { skip: 'array anidado' };
  if (t === 'object' || p.properties) return { skip: 'objeto anidado' };
  return { skip: 'sin tipo' };
}

function responseSchema(op, spec, deref) {
  const responses = op.responses ?? {};
  const res = deref(responses['200'] ?? responses[200]);
  if (!res) return { error: Object.keys(responses).length ? `sin respuesta 200 (hay: ${Object.keys(responses).join(', ')})` : 'sin respuestas declaradas' };
  if (spec.swagger) {
    const produces = op.produces ?? spec.produces ?? ['application/json'];
    if (!produces.some((m) => /json/.test(m))) return { error: `respuesta binaria/no JSON (${produces.join(', ')})`, binary: true };
    if (!res.schema) return { error: '200 sin esquema' };
    return { schema: res.schema };
  }
  if (!isObj(res.content) || !Object.keys(res.content).length) return { error: '200 sin esquema (sin content)' };
  const media = Object.keys(res.content).find((m) => /json/.test(m));
  if (!media) return { error: `respuesta binaria/no JSON (${Object.keys(res.content).join(', ')})`, binary: true };
  if (!res.content[media]?.schema) return { error: `200 ${media} sin esquema` };
  return { schema: res.content[media].schema };
}

/** Classify the 200 schema: list of objects, envelope, or not a collection. */
function shapeOf(schema, deref) {
  const s = flatten(schema, deref);
  if (!isObj(s)) return { todo: 'esquema de respuesta irresoluble' };
  const isArray = (x) => isObj(x) && (x.type === 'array' || (Array.isArray(x.type) && x.type.includes('array')) || x.items);
  if (isArray(s)) {
    const items = flatten(s.items, deref);
    if (!isObj(items)) return { todo: 'array cuyos elementos no se pueden resolver' };
    if (items.type && items.type !== 'object' && !items.properties) return { todo: `array de valores ${items.type}, no de objetos: no hay entidad que generar` };
    return { kind: 'array', itemsRaw: s.items, items };
  }
  if (isObj(s.properties)) {
    for (const key of WRAPPERS) {
      const inner = flatten(s.properties[key], deref);
      if (isArray(inner)) {
        const items = flatten(inner.items, deref);
        if (isObj(items) && (items.type === 'object' || items.properties || !items.type)) {
          return { kind: 'envelope', pick: key, itemsRaw: inner.items, items, others: Object.keys(s.properties).filter((k) => k !== key) };
        }
      }
    }
    return { todo: `devuelve un objeto (${Object.keys(s.properties).slice(0, 5).join(', ')}), no una colección` };
  }
  if (s.additionalProperties) return { todo: 'devuelve un mapa clave→valor (additionalProperties), no una colección' };
  return { todo: 'esquema sin tipo ni propiedades' };
}

function normBase(raw) {
  if (!raw) return '';
  let path = raw;
  if (/^[a-z]+:\/\//i.test(raw)) path = new URL(raw).pathname;
  path = `/${path.replace(/^\/+|\/+$/g, '')}`;
  return path === '/' ? '' : path;
}
const joinPath = (base, path) => (`${base}/${path.replace(/^\/+/, '')}`).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

function queryParams(pathItem, op, deref) {
  const all = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])].map((x) => deref(x)).filter(isObj);
  const byName = new Map();
  for (const prm of all) if (prm.in === 'query') byName.set(prm.name, prm);
  return [...byName.values()];
}
const paramSchema = (prm, deref) => deref(prm.schema) ?? prm; // 2.0 puts type/enum on the parameter

/**
 * @param {object} spec parsed OpenAPI
 * @param {{ name?: string, base?: string, file?: string, apiPrefix?: string|null }} opts
 */
export function inferScenario(spec, { name = 'api', base, file = '<spec>', apiPrefix = null } = {}) {
  const notesSet = new Set();
  const deref = makeDeref(spec, notesSet);
  const version = spec.openapi ? `OpenAPI ${spec.openapi}` : `Swagger ${spec.swagger}`;
  let baseInfo;
  let prefix;
  if (base !== undefined) { prefix = normBase(base); baseInfo = `${prefix || '/'} (--base)`; }
  else {
    const raw = spec.openapi ? spec.servers?.[0]?.url : spec.basePath;
    if (raw && raw.includes('{')) { prefix = ''; baseInfo = `sin base: ${spec.openapi ? 'servers[0].url' : 'basePath'} = "${raw}" tiene variables; pasa --base`; }
    else {
      prefix = normBase(raw);
      const src = spec.openapi ? 'servers[0].url' : 'basePath';
      baseInfo = raw ? `${prefix || '/'} (${src} = "${raw}"${/^[a-z]+:\/\//i.test(raw) ? ', absoluta: me quedo con la ruta' : ', relativa'})` : `/ (el spec no declara ${src})`;
    }
  }
  if (apiPrefix && prefix !== apiPrefix && base === undefined) notesSet.add(`el front consume ${apiPrefix} (config mock.apiPrefix) y el spec da base "${prefix || '/'}": si el proxy reescribe la ruta, reimporta con --base ${apiPrefix}`);

  const entities = new Map(); // name -> { name, refKey, campos, todo, distField, paginated }
  const endpoints = [];
  const todos = [];
  const ignored = [];
  const details = [];
  const pathKeys = Object.keys(spec.paths);
  let operations = 0;

  for (const rawPath of pathKeys) {
    const item = deref(spec.paths[rawPath]);
    if (!isObj(item)) { ignored.push({ method: '*', path: rawPath, reason: 'path item irresoluble' }); continue; }
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      operations++;
      const M = method.toUpperCase();
      if (method !== 'get') {
        ignored.push({ method: M, path: rawPath, reason: ['post', 'put', 'patch', 'delete'].includes(method) ? 'mutación no soportada: atrezzo solo proyecta lecturas (GET)' : `${M} no se proyecta` });
        continue;
      }
      const params = rawPath.match(/\{[^}]+\}/g) ?? [];
      const rs = responseSchema(op, spec, deref);
      if (rs.error) { ignored.push({ method: M, path: rawPath, reason: rs.error }); continue; }
      if (params.length) { details.push({ path: rawPath, params }); continue; }
      const shape = shapeOf(rs.schema, deref);
      const fullPath = joinPath(prefix, rawPath);
      if (shape.todo) { todos.push({ method: M, path: fullPath, reason: shape.todo }); continue; }

      // Entity: from the items $ref name if any, else from the last path segment.
      const rn = refName(shape.itemsRaw);
      const lastSeg = rawPath.split('/').filter(Boolean).pop() ?? 'items';
      let ename = entityName(rn ?? lastSeg);
      const key = rn ? `ref:${rn}` : `path:${rawPath}`;
      while (entities.has(ename) && entities.get(ename).key !== key) ename = `${ename}_2`;
      let ent = entities.get(ename);
      if (!ent) {
        const campos = {};
        const skipped = [];
        let idNote = null;
        const props = shape.items.properties ?? {};
        for (const [prop, sch] of Object.entries(props)) {
          if (prop === 'id') {
            const t = fieldType(sch, deref);
            if (t.type !== 'entero') idNote = `${ename}.id: el spec dice ${flatten(sch, deref)?.type ?? '?'}${flatten(sch, deref)?.format ? ` (${flatten(sch, deref).format})` : ''}; atrezzo genera ids enteros 1..n`;
            continue;
          }
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prop)) { skipped.push(`${prop} (nombre no válido como campo)`); continue; }
          const t = fieldType(sch, deref);
          if (t.skip) skipped.push(`${prop} (${t.skip})`);
          else campos[prop] = t.type;
        }
        if (!('id' in props)) notesSet.add(`${ename}: el esquema no declara "id"; atrezzo lo añade (enteros 1..n)`);
        if (idNote) notesSet.add(idNote);
        ent = {
          name: ename, key, source: rn ? `#/components/schemas/${rn}` : `ruta ${rawPath}`, campos, skipped,
          todo: Object.keys(props).length ? null : 'el esquema no declara propiedades; quedan los campos genéricos (id, nombre, creado_en)',
          distField: null, paginated: false,
        };
        entities.set(ename, ent);
      }

      const ep = { method: M, specPath: rawPath, path: fullPath, entity: ename, filters: [], pagination: null, pick: shape.kind === 'envelope' ? shape.pick : null, wrapperOthers: shape.others ?? [], paramNotes: [], detail: false };
      const qps = queryParams(item, op, deref);
      const names = qps.map((q) => q.name);
      for (const q of qps) {
        const sch = paramSchema(q, deref);
        const en = sch?.enum ?? sch?.items?.enum;
        if (q.name === 'offset' || q.name === 'page' || LIMIT.includes(q.name)) continue;
        if (Array.isArray(en) && en.length) {
          if (q.name in ent.campos) {
            ep.filters.push(q.name);
            if (Array.isArray(ent.campos[q.name]) && !ent.distField) ent.distField = q.name;
          } else ep.paramNotes.push(`?${q.name} (enum) no tiene campo homónimo en la respuesta: no se declara filtro`);
        } else ep.paramNotes.push(`?${q.name} sin enum: no se declara filtro (añádelo a filters si filtra por igualdad)`);
      }
      const limitName = LIMIT.find((n) => names.includes(n));
      const limitSchema = limitName ? paramSchema(qps.find((q) => q.name === limitName), deref) : null;
      if (names.includes('page')) {
        ep.pagination = { param_page: 'page', param_limit: limitName ?? 'limit', default_limit: Number.isInteger(limitSchema?.default) ? limitSchema.default : 20 };
        if (Number.isInteger(limitSchema?.maximum)) ep.pagination.max_limit = limitSchema.maximum;
        if (!Number.isInteger(limitSchema?.default)) ep.paramNotes.push(`paginación por página sin tamaño por defecto en el spec: default_limit = 20 (ajústalo)`);
      } else if (limitName || names.includes('offset')) {
        ep.pagination = { param_limit: limitName ?? 'limit', param_offset: 'offset' };
        if (Number.isInteger(limitSchema?.default)) ep.pagination.default_limit = limitSchema.default;
        if (Number.isInteger(limitSchema?.maximum)) ep.pagination.max_limit = limitSchema.maximum;
        if (!names.includes('offset')) ep.paramNotes.push(`?${limitName} sin offset: se declara param_offset: offset por defecto`);
      }
      if (ep.pagination) ent.paginated = true;
      endpoints.push(ep);
    }
  }

  // Detail routes: /x/{id} is covered by the list /x (detail: true); anything else is reported.
  for (const d of details) {
    const parent = d.path.replace(/\/\{[^}]+\}$/, '');
    const list = endpoints.find((e) => e.specPath === parent);
    if (list && d.params.length === 1 && d.path.endsWith(d.params[0])) { list.detail = d.path; continue; }
    if (d.params.length === 1 && d.path.endsWith(d.params[0])) ignored.push({ method: 'GET', path: d.path, reason: `detalle sin lista ${parent} proyectable: atrezzo genera /:id solo junto a su colección` });
    else ignored.push({ method: 'GET', path: d.path, reason: 'ruta anidada con parámetros en medio: atrezzo no la proyecta (decláralo como colección propia si la pantalla la usa)' });
  }

  const doc = { name, seed: 1, entities: [...entities.values()], endpoints, todos };
  return {
    doc, version, title: spec.info?.title ?? null, baseInfo, prefix, ignored, todos,
    notes: [...notesSet], operations, paths: pathKeys.length, file,
  };
}

/** Even split of `total` over `values`, remainder to the first ones. */
function evenSplit(total, values) {
  const out = {};
  values.forEach((v, i) => { out[v] = Math.floor(total / values.length) + (i < total % values.length ? 1 : 0); });
  return out;
}

/** Scenario YAML with comments (TODOs, provenance). Deterministic. */
export function scenarioYaml(result) {
  const { doc } = result;
  const L = [
    `# Generado por atrezzo import desde ${result.file} (${result.version}${result.title ? ` · "${result.title}"` : ''}).`,
    '# Punto de partida: ajusta conteos, distribuciones y expect con /atrezzo:escena y regenera con atrezzo world.',
    `# Base de las rutas: ${result.baseInfo}`,
    `name: ${doc.name}`,
    `description: ${scalar(`Importado de ${result.title ?? result.file}`)}`,
    `seed: ${doc.seed}`,
    'world:',
  ];
  for (const e of doc.entities) {
    const total = e.paginated ? 30 : 10;
    L.push(`  # ${e.name}: desde ${e.source}${e.skipped.length ? ` · omitidos: ${e.skipped.join(', ')}` : ''}`);
    if (e.todo) L.push(`  # TODO: ${e.todo}`);
    L.push(`  ${e.name}:`, `    total: ${total}`);
    if (e.distField) {
      L.push(`    distribucion: ${flow(evenSplit(total, e.campos[e.distField].map(String)))}`);
      L.push(`    campo_distribucion: ${scalar(e.distField)}`);
    }
    if (Object.keys(e.campos).length) {
      L.push('    campos:');
      for (const [k, t] of Object.entries(e.campos)) L.push(`      ${k}: ${Array.isArray(t) ? flow(t) : t}`);
    }
  }
  if (!doc.entities.length) L.push('  # TODO: no se ha podido inferir ninguna entidad; declara al menos una');
  L.push(doc.endpoints.length ? 'endpoints:' : 'endpoints: []');
  for (const ep of doc.endpoints) {
    L.push(`  - path: ${scalar(ep.path)}`, `    entity: ${ep.entity}`);
    if (ep.filters.length) L.push(`    filters: ${flow(ep.filters)}`);
    if (ep.pagination) L.push(`    pagination: ${flow(ep.pagination)}`);
    if (ep.pick) L.push(`    pick: ${ep.pick}${ep.wrapperOthers.length ? `   # el spec también declara: ${ep.wrapperOthers.join(', ')} (atrezzo emite total, limit, offset)` : ''}`);
    if (!ep.detail) L.push('    detail: false');
  }
  for (const t of doc.todos) L.push(`  # TODO: ${t.method} ${t.path} — ${t.reason}; decláralo a mano si la pantalla lo necesita`);
  L.push('expect: []', '');
  return L.join('\n');
}

/** Human report (Spanish) of what was inferred and what was not. */
export function formatImportReport(result, written) {
  const { doc } = result;
  const L = [`Importado ${result.file} (${result.version}${result.title ? ` · "${result.title}"` : ''} · ${result.paths} rutas, ${result.operations} operaciones)`];
  L.push(`Base: ${result.baseInfo}`);
  L.push(`Endpoints inferidos (${doc.endpoints.length}):`);
  for (const ep of doc.endpoints) {
    const e = doc.entities.find((x) => x.name === ep.entity);
    const campos = Object.entries(e.campos).map(([k, t]) => `${k}:${Array.isArray(t) ? `[${t.join('|')}]` : t}`).join(', ') || 'genéricos (TODO)';
    L.push(`  GET ${ep.path} → ${ep.entity} · ${ep.pick ? `envoltorio {${ep.pick}: [...]} → pick: ${ep.pick}` : 'array'}`);
    L.push(`      campos: ${campos}`);
    if (e.skipped.length) L.push(`      omitidos: ${e.skipped.join(', ')}`);
    L.push(`      filtros: ${ep.filters.join(', ') || '—'} · paginación: ${ep.pagination ? Object.entries(ep.pagination).map(([k, v]) => `${k}=${v}`).join(' ') : '—'} · detalle: ${ep.detail ? `${ep.path}/:id (de ${ep.detail})` : 'no'}`);
    for (const n of ep.paramNotes) L.push(`      nota: ${n}`);
    if (ep.wrapperOthers.length) L.push(`      nota: el envoltorio también trae ${ep.wrapperOthers.join(', ')}; atrezzo emite {${ep.pick}, total, limit, offset}`);
  }
  if (result.todos.length) {
    L.push(`Marcadas # TODO en el YAML (${result.todos.length}):`);
    for (const t of result.todos) L.push(`  ${t.method} ${t.path}: ${t.reason}`);
  }
  if (result.ignored.length) {
    L.push(`Ignoradas (${result.ignored.length}):`);
    for (const i of result.ignored) L.push(`  ${i.method} ${i.path}: ${i.reason}`);
  }
  if (result.notes.length) {
    L.push('Notas:');
    for (const n of result.notes) L.push(`  ${n}`);
  }
  if (written) L.push(`Escrito: ${written.path} (${written.valid ? 'escenario válido' : 'escenario INVÁLIDO todavía: completa los TODO'})`);
  if (written && !written.valid) for (const i of written.issues) L.push(`  - ${i}`);
  return L.join('\n');
}

/**
 * Infer and write <outDir>/<name>.yaml|json. Validates the result with the
 * scenario loader so the report says whether `atrezzo world` will accept it.
 */
export function runImport(specFile, { name = 'api', base, format = 'yaml', outDir, force = false, apiPrefix = null, cwd = process.cwd() } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new AtrezzoError(`--name "${name}": minúsculas, dígitos y guiones`);
  if (!['yaml', 'json'].includes(format)) throw new AtrezzoError(`--format debe ser yaml o json (es "${format}")`);
  const spec = loadSpec(specFile);
  const relSpec = relative(cwd, specFile);
  const result = inferScenario(spec, { name, base, file: relSpec && !relSpec.startsWith('..') ? relSpec : specFile, apiPrefix });
  const out = join(outDir, `${name}.${format === 'json' ? 'json' : 'yaml'}`);
  if (existsSync(out) && !force) throw new AtrezzoError(`${relative(cwd, out)} ya existe; usa --force para sobrescribir o --name para otro nombre`);
  let content;
  if (format === 'json') {
    const d = result.doc;
    const world = {};
    for (const e of d.entities) {
      const total = e.paginated ? 30 : 10;
      world[e.name] = { total, ...(e.distField ? { distribucion: evenSplit(total, e.campos[e.distField].map(String)), campo_distribucion: e.distField } : {}), ...(Object.keys(e.campos).length ? { campos: e.campos } : {}) };
    }
    const endpoints = d.endpoints.map((ep) => ({ path: ep.path, entity: ep.entity, ...(ep.filters.length ? { filters: ep.filters } : {}), ...(ep.pagination ? { pagination: ep.pagination } : {}), ...(ep.pick ? { pick: ep.pick } : {}), ...(ep.detail ? {} : { detail: false }) }));
    content = `${JSON.stringify({ name: d.name, description: `Importado de ${result.title ?? result.file}`, seed: d.seed, world, endpoints, expect: [] }, null, 2)}\n`;
  } else content = scenarioYaml(result);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content);
  let valid = true;
  let issues = [];
  try { loadScenario(out); } catch (e) { valid = false; issues = e.issues?.length ? e.issues : [e.message]; }
  return { result, written: { path: relative(cwd, out) || out, valid, issues }, content };
}
