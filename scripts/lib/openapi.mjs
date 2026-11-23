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
  if (!existsSync(file)) throw new AtrezzoError(`Contract ${file} does not exist`);
  const text = readFileSync(file, 'utf8');
  let doc;
  if (/\.json$/i.test(file) || /^\s*\{/.test(text)) {
    try { doc = JSON.parse(text); } catch (e) { throw new AtrezzoError(`${file}: invalid JSON: ${e.message}`); }
  } else {
    try { doc = parseYaml(text, file); } catch (e) {
      if (e instanceof YamlError) throw new AtrezzoError(`${e.message}\n  atrezzo's YAML parser handles a subset (no anchors, aliases or multi-line {…} collections). Convert the spec to JSON and import it again.`);
      throw e;
    }
  }
  if (!isObj(doc) || (!doc.openapi && !doc.swagger)) throw new AtrezzoError(`${file}: does not look like OpenAPI (no "openapi" or "swagger" at the root)`);
  if (!isObj(doc.paths)) throw new AtrezzoError(`${file}: the spec has no "paths"`);
  return doc;
}

function makeDeref(spec, notes) {
  const cache = new Map();
  const deref = (node, depth = 0) => {
    if (!isObj(node) || typeof node.$ref !== 'string') return node;
    const ref = node.$ref;
    if (!ref.startsWith('#/')) { notes.add(`external $ref not supported: ${ref}`); return null; }
    if (depth > 20) { notes.add(`circular $ref: ${ref}`); return null; }
    if (cache.has(ref)) return cache.get(ref);
    let cur = spec;
    for (const part of ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))) cur = isObj(cur) ? cur[part] : undefined;
    if (cur === undefined) { notes.add(`broken $ref: ${ref}`); return null; }
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

/**
 * OpenAPI 3.1 nullable union (`anyOf: [T, {type: 'null'}]`, how FastAPI /
 * Pydantic v2 emit optional fields) -> the raw non-null member T. Only when
 * there is exactly one non-null member and at least one explicit null one;
 * anything else (several alternatives, no null, unresolvable members) -> null.
 */
function nullableMember(p, deref) {
  if (p.type !== undefined || !Array.isArray(p.anyOf)) return null;
  const isNull = (s) => isObj(s) && (s.type === 'null' || (Array.isArray(s.type) && s.type.length === 1 && s.type[0] === 'null'));
  const resolved = p.anyOf.map((m) => deref(m));
  if (!resolved.every(isObj)) return null;
  const others = p.anyOf.filter((_, i) => !isNull(resolved[i]));
  return others.length === 1 && others.length < p.anyOf.length ? others[0] : null;
}

/** OpenAPI property -> atrezzo field type ({ type } or { skip: reason }). */
function fieldType(prop, deref, depth = 0) {
  const p = flatten(prop, deref);
  if (!isObj(p)) return { skip: 'unresolvable schema' };
  const member = nullableMember(p, deref);
  if (member) return depth > 20 ? { skip: 'circular nullable anyOf' } : fieldType(member, deref, depth + 1);
  const enumVals = p.enum;
  if (Array.isArray(enumVals) && enumVals.length && enumVals.every((v) => v === null || typeof v !== 'object')) return { type: enumVals.filter((v) => v !== null) };
  const t = Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type;
  if (t === 'integer') return { type: 'integer' };
  if (t === 'number') return { type: 'number' };
  if (t === 'boolean') return { type: 'boolean' };
  if (t === 'string') {
    if (p.format === 'binary' || p.format === 'byte') return { skip: `string ${p.format} (binary)` };
    return { type: { 'date-time': 'date', date: 'date', email: 'email', uuid: 'uuid', uri: 'url', url: 'url' }[p.format] ?? 'string' };
  }
  if (t === 'array' || p.items) return { skip: 'nested array' };
  if (t === 'object' || p.properties) return { skip: 'nested object' };
  return { skip: 'no type' };
}

function responseSchema(op, spec, deref) {
  const responses = op.responses ?? {};
  const res = deref(responses['200'] ?? responses[200]);
  if (!res) return { error: Object.keys(responses).length ? `no 200 response (declared: ${Object.keys(responses).join(', ')})` : 'no responses declared' };
  if (spec.swagger) {
    const produces = op.produces ?? spec.produces ?? ['application/json'];
    if (!produces.some((m) => /json/.test(m))) return { error: `binary/non-JSON response (${produces.join(', ')})`, binary: true };
    if (!res.schema) return { error: '200 without schema' };
    return { schema: res.schema };
  }
  if (!isObj(res.content) || !Object.keys(res.content).length) return { error: '200 without schema (no content)' };
  const media = Object.keys(res.content).find((m) => /json/.test(m));
  if (!media) return { error: `binary/non-JSON response (${Object.keys(res.content).join(', ')})`, binary: true };
  if (!res.content[media]?.schema) return { error: `200 ${media} without schema` };
  return { schema: res.content[media].schema };
}

/** Classify the 200 schema: list of objects, envelope, or not a collection. */
function shapeOf(schema, deref) {
  const s = flatten(schema, deref);
  if (!isObj(s)) return { todo: 'unresolvable response schema' };
  const isArray = (x) => isObj(x) && (x.type === 'array' || (Array.isArray(x.type) && x.type.includes('array')) || x.items);
  if (isArray(s)) {
    const items = flatten(s.items, deref);
    if (!isObj(items)) return { todo: 'array whose items cannot be resolved' };
    if (items.type && items.type !== 'object' && !items.properties) return { todo: `array of ${items.type} values, not objects: no entity to generate` };
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
    return { todo: `returns an object (${Object.keys(s.properties).slice(0, 5).join(', ')}), not a collection` };
  }
  if (s.additionalProperties) return { todo: 'returns a key→value map (additionalProperties), not a collection' };
  return { todo: 'schema with no type or properties' };
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
    if (raw && raw.includes('{')) { prefix = ''; baseInfo = `no base: ${spec.openapi ? 'servers[0].url' : 'basePath'} = "${raw}" has variables; pass --base`; }
    else {
      prefix = normBase(raw);
      const src = spec.openapi ? 'servers[0].url' : 'basePath';
      baseInfo = raw ? `${prefix || '/'} (${src} = "${raw}"${/^[a-z]+:\/\//i.test(raw) ? ', absolute: keeping the path' : ', relative'})` : `/ (the spec declares no ${src})`;
    }
  }
  if (apiPrefix && prefix !== apiPrefix && base === undefined) notesSet.add(`the front end calls ${apiPrefix} (config mock.apiPrefix) and the spec's base is "${prefix || '/'}": if the proxy rewrites the path, re-import with --base ${apiPrefix}`);

  const entities = new Map(); // name -> { name, refKey, fields, todo, distField, paginated }
  const endpoints = [];
  const todos = [];
  const ignored = [];
  const details = [];
  const pathKeys = Object.keys(spec.paths);
  let operations = 0;

  for (const rawPath of pathKeys) {
    const item = deref(spec.paths[rawPath]);
    if (!isObj(item)) { ignored.push({ method: '*', path: rawPath, reason: 'unresolvable path item' }); continue; }
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      operations++;
      const M = method.toUpperCase();
      if (method !== 'get') {
        ignored.push({ method: M, path: rawPath, reason: ['post', 'put', 'patch', 'delete'].includes(method) ? 'mutation not supported: atrezzo only projects reads (GET)' : `${M} is not projected` });
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
        const fields = {};
        const skipped = [];
        let idNote = null;
        const props = shape.items.properties ?? {};
        for (const [prop, sch] of Object.entries(props)) {
          if (prop === 'id') {
            const t = fieldType(sch, deref);
            if (t.type !== 'integer') idNote = `${ename}.id: the spec says ${flatten(sch, deref)?.type ?? '?'}${flatten(sch, deref)?.format ? ` (${flatten(sch, deref).format})` : ''}; atrezzo generates integer ids 1..n`;
            continue;
          }
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prop)) { skipped.push(`${prop} (not a valid field name)`); continue; }
          const t = fieldType(sch, deref);
          if (t.skip) skipped.push(`${prop} (${t.skip})`);
          else fields[prop] = t.type;
        }
        if (!('id' in props)) notesSet.add(`${ename}: the schema declares no "id"; atrezzo adds one (integers 1..n)`);
        if (idNote) notesSet.add(idNote);
        ent = {
          name: ename, key, source: rn ? `#/components/schemas/${rn}` : `path ${rawPath}`, fields, skipped,
          todo: Object.keys(props).length ? null : 'the schema declares no properties; the generic fields remain (id, name, created_at)',
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
          if (q.name in ent.fields) {
            ep.filters.push(q.name);
            if (Array.isArray(ent.fields[q.name]) && !ent.distField) ent.distField = q.name;
          } else ep.paramNotes.push(`?${q.name} (enum) has no field with the same name in the response: no filter declared`);
        } else ep.paramNotes.push(`?${q.name} without enum: no filter declared (add it to filters if it filters by equality)`);
      }
      const limitName = LIMIT.find((n) => names.includes(n));
      const limitSchema = limitName ? paramSchema(qps.find((q) => q.name === limitName), deref) : null;
      if (names.includes('page')) {
        ep.pagination = { param_page: 'page', param_limit: limitName ?? 'limit', default_limit: Number.isInteger(limitSchema?.default) ? limitSchema.default : 20 };
        if (Number.isInteger(limitSchema?.maximum)) ep.pagination.max_limit = limitSchema.maximum;
        if (!Number.isInteger(limitSchema?.default)) ep.paramNotes.push(`page-number pagination with no default size in the spec: default_limit = 20 (adjust it)`);
      } else if (limitName || names.includes('offset')) {
        ep.pagination = { param_limit: limitName ?? 'limit', param_offset: 'offset' };
        if (Number.isInteger(limitSchema?.default)) ep.pagination.default_limit = limitSchema.default;
        if (Number.isInteger(limitSchema?.maximum)) ep.pagination.max_limit = limitSchema.maximum;
        if (!names.includes('offset')) ep.paramNotes.push(`?${limitName} without offset: declaring param_offset: offset by default`);
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
    if (d.params.length === 1 && d.path.endsWith(d.params[0])) ignored.push({ method: 'GET', path: d.path, reason: `detail without a projectable list ${parent}: atrezzo generates /:id only alongside its collection` });
    else ignored.push({ method: 'GET', path: d.path, reason: 'nested path with parameters in the middle: atrezzo does not project it (declare it as its own collection if the screen uses it)' });
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
    `# Generated by atrezzo import from ${result.file} (${result.version}${result.title ? ` · "${result.title}"` : ''}).`,
    '# Starting point: adjust counts, distributions and expect with /atrezzo:scene and regenerate with atrezzo world.',
    `# Path base: ${result.baseInfo}`,
    `name: ${doc.name}`,
    `description: ${scalar(`Imported from ${result.title ?? result.file}`)}`,
    `seed: ${doc.seed}`,
    'world:',
  ];
  for (const e of doc.entities) {
    const total = e.paginated ? 30 : 10;
    L.push(`  # ${e.name}: from ${e.source}${e.skipped.length ? ` · skipped: ${e.skipped.join(', ')}` : ''}`);
    if (e.todo) L.push(`  # TODO: ${e.todo}`);
    L.push(`  ${e.name}:`, `    total: ${total}`);
    if (e.distField) {
      L.push(`    distribution: ${flow(evenSplit(total, e.fields[e.distField].map(String)))}`);
      L.push(`    distribution_field: ${scalar(e.distField)}`);
    }
    if (Object.keys(e.fields).length) {
      L.push('    fields:');
      for (const [k, t] of Object.entries(e.fields)) L.push(`      ${k}: ${Array.isArray(t) ? flow(t) : t}`);
    }
  }
  if (!doc.entities.length) L.push('  # TODO: no entity could be inferred; declare at least one');
  L.push(doc.endpoints.length ? 'endpoints:' : 'endpoints: []');
  for (const ep of doc.endpoints) {
    L.push(`  - path: ${scalar(ep.path)}`, `    entity: ${ep.entity}`);
    if (ep.filters.length) L.push(`    filters: ${flow(ep.filters)}`);
    if (ep.pagination) L.push(`    pagination: ${flow(ep.pagination)}`);
    if (ep.pick) L.push(`    pick: ${ep.pick}${ep.wrapperOthers.length ? `   # the spec also declares: ${ep.wrapperOthers.join(', ')} (atrezzo emits total, limit, offset)` : ''}`);
    if (!ep.detail) L.push('    detail: false');
  }
  for (const t of doc.todos) L.push(`  # TODO: ${t.method} ${t.path} — ${t.reason}; declare it by hand if the screen needs it`);
  L.push('expect: []', '');
  return L.join('\n');
}

/** Human report of what was inferred and what was not. */
export function formatImportReport(result, written) {
  const { doc } = result;
  const L = [`Imported ${result.file} (${result.version}${result.title ? ` · "${result.title}"` : ''} · ${result.paths} paths, ${result.operations} operations)`];
  L.push(`Base: ${result.baseInfo}`);
  L.push(`Inferred endpoints (${doc.endpoints.length}):`);
  for (const ep of doc.endpoints) {
    const e = doc.entities.find((x) => x.name === ep.entity);
    const fields = Object.entries(e.fields).map(([k, t]) => `${k}:${Array.isArray(t) ? `[${t.join('|')}]` : t}`).join(', ') || 'generic (TODO)';
    L.push(`  GET ${ep.path} → ${ep.entity} · ${ep.pick ? `envelope {${ep.pick}: [...]} → pick: ${ep.pick}` : 'array'}`);
    L.push(`      fields: ${fields}`);
    if (e.skipped.length) L.push(`      skipped: ${e.skipped.join(', ')}`);
    L.push(`      filters: ${ep.filters.join(', ') || '—'} · pagination: ${ep.pagination ? Object.entries(ep.pagination).map(([k, v]) => `${k}=${v}`).join(' ') : '—'} · detail: ${ep.detail ? `${ep.path}/:id (from ${ep.detail})` : 'no'}`);
    for (const n of ep.paramNotes) L.push(`      note: ${n}`);
    if (ep.wrapperOthers.length) L.push(`      note: the envelope also carries ${ep.wrapperOthers.join(', ')}; atrezzo emits {${ep.pick}, total, limit, offset}`);
  }
  if (result.todos.length) {
    L.push(`Marked # TODO in the YAML (${result.todos.length}):`);
    for (const t of result.todos) L.push(`  ${t.method} ${t.path}: ${t.reason}`);
  }
  if (result.ignored.length) {
    L.push(`Ignored (${result.ignored.length}):`);
    for (const i of result.ignored) L.push(`  ${i.method} ${i.path}: ${i.reason}`);
  }
  if (result.notes.length) {
    L.push('Notes:');
    for (const n of result.notes) L.push(`  ${n}`);
  }
  if (written) L.push(`Written: ${written.path} (${written.valid ? 'valid scenario' : 'scenario still INVALID: complete the TODOs'})`);
  if (written && !written.valid) for (const i of written.issues) L.push(`  - ${i}`);
  return L.join('\n');
}

/**
 * Infer and write <outDir>/<name>.yaml|json. Validates the result with the
 * scenario loader so the report says whether `atrezzo world` will accept it.
 */
export function runImport(specFile, { name = 'api', base, format = 'yaml', outDir, force = false, apiPrefix = null, cwd = process.cwd() } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new AtrezzoError(`--name "${name}": lowercase letters, digits and hyphens`);
  if (!['yaml', 'json'].includes(format)) throw new AtrezzoError(`--format must be yaml or json (got "${format}")`);
  const spec = loadSpec(specFile);
  const relSpec = relative(cwd, specFile);
  const result = inferScenario(spec, { name, base, file: relSpec && !relSpec.startsWith('..') ? relSpec : specFile, apiPrefix });
  const out = join(outDir, `${name}.${format === 'json' ? 'json' : 'yaml'}`);
  if (existsSync(out) && !force) throw new AtrezzoError(`${relative(cwd, out)} already exists; use --force to overwrite or --name for another name`);
  let content;
  if (format === 'json') {
    const d = result.doc;
    const world = {};
    for (const e of d.entities) {
      const total = e.paginated ? 30 : 10;
      world[e.name] = { total, ...(e.distField ? { distribution: evenSplit(total, e.fields[e.distField].map(String)), distribution_field: e.distField } : {}), ...(Object.keys(e.fields).length ? { fields: e.fields } : {}) };
    }
    const endpoints = d.endpoints.map((ep) => ({ path: ep.path, entity: ep.entity, ...(ep.filters.length ? { filters: ep.filters } : {}), ...(ep.pagination ? { pagination: ep.pagination } : {}), ...(ep.pick ? { pick: ep.pick } : {}), ...(ep.detail ? {} : { detail: false }) }));
    content = `${JSON.stringify({ name: d.name, description: `Imported from ${result.title ?? result.file}`, seed: d.seed, world, endpoints, expect: [] }, null, 2)}\n`;
  } else content = scenarioYaml(result);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content);
  let valid = true;
  let issues = [];
  try { loadScenario(out); } catch (e) { valid = false; issues = e.issues?.length ? e.issues : [e.message]; }
  return { result, written: { path: relative(cwd, out) || out, valid, issues }, content };
}
