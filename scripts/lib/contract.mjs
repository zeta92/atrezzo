// Projection engine: dataset + endpoint contract + request -> response.
// This file has NO imports on purpose: `atrezzo world` copies it verbatim to
// <generatedDir>/runtime.mjs so the generated MSW handlers and `atrezzo serve`
// run exactly the same code. The mock shapes data; it does not apply business rules.

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1; // nulls last
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : 1;
}

function parseNonNegInt(raw, name) {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  if (!/^\d+$/.test(raw)) return { error: `"${name}" must be an integer >= 0; got "${raw}"` };
  return { value: Number.parseInt(raw, 10) };
}

/**
 * Dynamic sort from `ep.sorts` (`{ by, order, fields }`). Supports `?by=field&order=asc|desc`,
 * `?by=-field` (or `+field`), `?by=field.asc|desc`, and comma-separated multi-field lists.
 * Unknown fields or invalid directions return `{ error }` so callers fail loudly with 400.
 */
function resolveSort(ep, params, scenario) {
  const fallback = ep.sort ?? [];
  if (!ep.sorts) return { sort: fallback };
  const rawBy = params.get(ep.sorts.by);
  const rawOrder = ep.sorts.order ? params.get(ep.sorts.order) : null;
  const hasBy = rawBy !== null && rawBy !== '';
  const hasOrder = rawOrder !== null && rawOrder !== '';
  if (!hasBy && !hasOrder) return { sort: fallback };

  let orderDir = null;
  if (hasOrder) {
    const lower = rawOrder.toLowerCase();
    if (lower !== 'asc' && lower !== 'desc') {
      return { error: `"${ep.sorts.order}" must be "asc" or "desc"; got "${rawOrder}"` };
    }
    orderDir = lower;
  }

  if (!hasBy) {
    if (!fallback.length) {
      return { error: `cannot apply "${ep.sorts.order}" without "${ep.sorts.by}" on ${ep.path} in scenario "${scenario}" (endpoint has no default sort)` };
    }
    return { sort: [{ field: fallback[0].field, dir: orderDir }, ...fallback.slice(1)] };
  }

  const out = [];
  for (const part of rawBy.split(',')) {
    const item = part.trim();
    if (!item) return { error: `invalid "${ep.sorts.by}" value "${rawBy}"` };
    let dir = null;
    let rest = item;
    if (item.startsWith('-')) { dir = 'desc'; rest = item.slice(1); }
    else if (item.startsWith('+')) { dir = 'asc'; rest = item.slice(1); }
    const dot = rest.indexOf('.');
    let field = rest;
    if (dot !== -1) {
      if (dir !== null) return { error: `invalid sort "${item}" in "${ep.sorts.by}": cannot combine "${item[0]}" prefix with "." direction` };
      field = rest.slice(0, dot);
      const rawDir = rest.slice(dot + 1);
      const lowerDir = rawDir.toLowerCase();
      if (lowerDir !== 'asc' && lowerDir !== 'desc') {
        return { error: `sort order in "${item}" must be "asc" or "desc"; got "${rawDir}"` };
      }
      dir = lowerDir;
    }
    if (!ep.sorts.fields.includes(field)) {
      return { error: `sort field "${field}" is not allowed on ${ep.path} in scenario "${scenario}" (allowed: ${ep.sorts.fields.join(', ')})` };
    }
    if (dir !== null && orderDir !== null && dir !== orderDir) {
      return { error: `conflicting sort order for "${field}": "${item}" vs "${ep.sorts.order}=${rawOrder}"` };
    }
    out.push({ field, dir: dir ?? orderDir ?? 'asc' });
  }
  return { sort: out };
}

/**
 * Scopes (`ep.scopes`): each declared parameter picks a SET of rows by a boolean field, it does not
 * filter by a value. Without the parameter the set is `default` (`exclude` hides rows whose field is
 * true, `include` keeps every row); `?p=true|false` either adds the rows with that value to the
 * default set (`add`) or keeps only them (`only`). Returns one predicate per sent scope, or `{ error }`.
 */
function resolveScopes(ep, params) {
  const preds = [];
  for (const s of ep.scopes ?? []) {
    const sent = params.getAll(s.param).filter((v) => v !== '').map((v) => v.toLowerCase());
    const bad = sent.find((v) => v !== 'true' && v !== 'false');
    if (bad !== undefined) return { error: `"${s.param}" must be "true" or "false"; got "${params.getAll(s.param).find((v) => v.toLowerCase() === bad)}"` };
    if (new Set(sent).size > 1) return { error: `conflicting values for "${s.param}": ${params.getAll(s.param).join(', ')}` };
    const inDefault = (r) => s.default === 'include' || r[s.field] !== true;
    if (!sent.length) { preds.push(inDefault); continue; }
    const want = sent[0] === 'true';
    const action = want ? s.when_true : s.when_false;
    const hasValue = (r) => (r[s.field] === true) === want;
    preds.push(action === 'only' ? hasValue : (r) => inDefault(r) || hasValue(r));
  }
  return { preds };
}

// PostgREST operator prefixes: `eq.`, `neq.`, `gt.`, `gte.`, `lt.`, `lte.`, `like.`, `ilike.`,
// `is.` (null/true/false) and `in.(a,b,c)`. A value with no prefix is an equality, and a
// comma-separated list is still an OR of equalities (`?status=issue,pending`).
const PGRST_OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in']);

function asNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.trim() === '' || !/^-?\d+(\.\d+)?$/.test(raw.trim())) return null;
  return Number(raw);
}

/** `like`/`ilike` patterns: `*` (PostgREST) and `%` (SQL) are wildcards, everything else is literal. */
function likePattern(raw, flags) {
  let body = '';
  for (const ch of String(raw)) {
    if (ch === '*' || ch === '%') body += '.*';
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${body}$`, flags);
}

function applyOperator(value, op, arg, strictStringId = false) {
  const v = value === null || value === undefined ? 'null' : String(value);
  const nv = strictStringId ? null : asNumber(value);
  const na = strictStringId ? null : asNumber(arg);
  switch (op) {
    case 'eq':
      return v === arg || (nv !== null && na !== null && nv === na);
    case 'neq':
      return !applyOperator(value, 'eq', arg, strictStringId);
    case 'gt':
      return nv !== null && na !== null ? nv > na : v > arg;
    case 'gte':
      return nv !== null && na !== null ? nv >= na : v >= arg;
    case 'lt':
      return nv !== null && na !== null ? nv < na : v < arg;
    case 'lte':
      return nv !== null && na !== null ? nv <= na : v <= arg;
    case 'like':
      return likePattern(arg, '').test(v);
    case 'ilike':
      return likePattern(arg, 'i').test(v);
    case 'is':
      return arg === 'null' ? value === null || value === undefined : v === arg;
    case 'in': {
      const body = /^\((.*)\)$/.exec(arg);
      const items = (body ? body[1] : arg).split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1'));
      return items.some((item) => (item === 'null' ? value === null || value === undefined : v === item || (nv !== null && asNumber(item) !== null && nv === asNumber(item))));
    }
    default:
      return false;
  }
}

function matchesTerm(value, term, strictStringId = false) {
  const dot = term.indexOf('.');
  if (dot > 0) {
    const op = term.slice(0, dot).toLowerCase();
    if (PGRST_OPERATORS.has(op)) return applyOperator(value, op, term.slice(dot + 1), strictStringId);
  }
  const v = value === null || value === undefined ? 'null' : String(value);
  return v === term;
}

function matchesFilter(value, raw, strictStringId = false) {
  // Top-level commas only: `in.(1,2)` keeps its list whole.
  return splitSelect(String(raw)).some((term) => matchesTerm(value, term.trim(), strictStringId));
}

/** Split a PostgREST `select` on top-level commas (commas inside `(...)` belong to an embed). */
function splitSelect(raw) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of raw) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

// `child(count)` or `alias:child(count)`; nothing else is a count.
const COUNT_ITEM = /^(?:([A-Za-z_]\w*)\s*:\s*)?([A-Za-z_]\w*)\(count\)$/;

/** Value of a request header from a Headers object or a plain (node) header map, case-insensitive. */
function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  if (key === undefined) return null;
  const v = headers[key];
  return Array.isArray(v) ? v.join(',') : String(v);
}

const wantsCount = (headers) => (headerValue(headers, 'prefer') ?? '').split(',').some((p) => /^count=(exact|planned|estimated)$/.test(p.trim()));

function setEnvelopeKey(obj, keyPath, value) {
  const parts = keyPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function formatEnvelope(ep, page, total, limit, offset, pageNum) {
  if (!ep.envelope) return { [ep.pick ?? 'data']: page, total, limit, offset };
  const body = {};
  setEnvelopeKey(body, ep.envelope.items, page);
  if (ep.envelope.total !== undefined) setEnvelopeKey(body, ep.envelope.total, total);
  if (ep.envelope.page !== undefined) setEnvelopeKey(body, ep.envelope.page, pageNum);
  if (ep.envelope.per_page !== undefined) setEnvelopeKey(body, ep.envelope.per_page, limit);
  if (ep.envelope.total_pages !== undefined) {
    // Derived, never drawn: ceil(total / page size); an unpaginated answer is one page (or none).
    setEnvelopeKey(body, ep.envelope.total_pages, limit > 0 ? Math.ceil(total / limit) : (total > 0 ? 1 : 0));
  }
  return body;
}

function cloneRows(rows) {
  return (rows ?? []).map((r) => ({ ...r }));
}

function cloneEntities(entities) {
  const out = {};
  for (const [k, rows] of Object.entries(entities ?? {})) out[k] = cloneRows(rows);
  return out;
}

function canonicalValue(v) {
  if (Array.isArray(v)) return v.map(canonicalValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalValue(v[k]);
    return out;
  }
  return v;
}

const isValidStringId = (v) => typeof v === 'string'
  && v.length >= 1
  && v.length <= 200
  && v !== '.'
  && v !== '..'
  && /^[A-Za-z0-9._~-]+$/.test(v);

export function createEngine(dataset) {
  const initialEntities = cloneEntities(dataset.entities);
  const workingEntities = cloneEntities(initialEntities);
  const liveDataset = { ...dataset, entities: workingEntities };
  const routes = dataset.endpoints.map((ep) => ({ ...ep }));
  const writeRoutes = (dataset.writes ?? []).map((w) => ({ ...w }));
  const authUser = dataset.auth?.user ?? null;
  const getCurrentUser = () => (authUser
    ? (workingEntities[authUser.entity] ?? []).find((r) => r.id === authUser.id) ?? null
    : null);

  const nextIds = new Map();
  function initNextIds() {
    nextIds.clear();
    for (const [name, rows] of Object.entries(workingEntities)) {
      let max = 0;
      for (const r of rows) if (typeof r.id === 'number' && r.id > max) max = r.id;
      nextIds.set(name, max + 1);
    }
  }
  initNextIds();

  /**
   * Counted relations asked in `select`: [{ key, byParent }] for every `child(count)` whose child
   * entity refs this endpoint's entity, counted over the same in-memory world the rows come from.
   * `honoured` = every select item is `*` or such a count (otherwise `select` is reported as ignored).
   */
  function countsFor(ep, select) {
    if (select === null) return { counts: [], honoured: true };
    const counts = [];
    let honoured = true;
    for (const item of splitSelect(select)) {
      if (item === '*') continue;
      const m = COUNT_ITEM.exec(item);
      const meta = m && Object.hasOwn(dataset.schema, m[2]) ? dataset.schema[m[2]] : undefined;
      const fk = meta ? Object.keys(meta.refs).find((k) => meta.refs[k] === ep.entity) : undefined;
      if (fk === undefined) { honoured = false; continue; }
      const byParent = new Map();
      for (const r of workingEntities[m[2]]) if (r[fk] !== null && r[fk] !== undefined) byParent.set(r[fk], (byParent.get(r[fk]) ?? 0) + 1);
      counts.push({ key: m[1] ?? m[2], byParent });
    }
    return { counts, honoured };
  }

  function withCounts(row, counts) {
    for (const { key, byParent } of counts) row[key] = [{ count: byParent.get(row.id) ?? 0 }];
    return row;
  }

  function withIncludes(row, ep) {
    if (!ep.include.length) return { ...row };
    const out = { ...row };
    const meta = dataset.schema[ep.entity];
    for (const [fk, target] of Object.entries(meta.refs)) {
      if (!ep.include.includes(target)) continue;
      const parent = workingEntities[target].find((r) => r.id === row[fk]) ?? null;
      out[dataset.schema[target].singular] = parent ? { ...parent } : null;
    }
    return out;
  }

  // Child rows per parent id, for `embed`: built on demand per (child, parent) pair and cleared on mutation/reset.
  const childIndex = new Map();
  function childrenOf(child, parent) {
    const key = `${child}>${parent}`;
    if (!childIndex.has(key)) {
      const meta = dataset.schema[child];
      const fk = Object.keys(meta.refs).find((k) => meta.refs[k] === parent);
      const byParent = new Map();
      for (const r of workingEntities[child]) {
        if (r[fk] === null || r[fk] === undefined) continue;
        if (!byParent.has(r[fk])) byParent.set(r[fk], []);
        byParent.get(r[fk]).push(r);
      }
      childIndex.set(key, byParent);
    }
    return childIndex.get(key);
  }

  /**
   * `embed: [views]`: every row carries the list of child rows that point at it (world order). An
   * entry `{ entity, embed }` does the same one level down, on each embedded row (validated acyclic).
   */
  function withEmbeds(row, entity, embeds) {
    for (const e of embeds ?? []) {
      const child = typeof e === 'string' ? e : e.entity;
      const inner = typeof e === 'string' ? null : e.embed;
      row[child] = (childrenOf(child, entity).get(row.id) ?? []).map((r) => (inner ? withEmbeds({ ...r }, child, inner) : { ...r }));
    }
    return row;
  }

  // Child counts per parent id, for declarative `ep.counts`: built on demand per (entity, fk) pair and cleared on mutation/reset.
  const rowCountIndex = new Map();
  function rowCountMap(entity, fk) {
    const key = `${entity}:${fk}`;
    if (!rowCountIndex.has(key)) {
      const byParent = new Map();
      for (const r of workingEntities[entity] ?? []) {
        const v = r[fk];
        if (v !== null && v !== undefined) byParent.set(v, (byParent.get(v) ?? 0) + 1);
      }
      rowCountIndex.set(key, byParent);
    }
    return rowCountIndex.get(key);
  }

  function invalidateIndexes() {
    childIndex.clear();
    rowCountIndex.clear();
  }

  function reset() {
    for (const [k, rows] of Object.entries(initialEntities)) {
      workingEntities[k].splice(0, workingEntities[k].length, ...cloneRows(rows));
    }
    initNextIds();
    invalidateIndexes();
  }

  function withRowCounts(row, ep) {
    if (!ep.counts?.length) return row;
    for (const { field, entity, on } of ep.counts) {
      row[field] = rowCountMap(entity, on).get(row.id) ?? 0;
    }
    return row;
  }

  /** A row as an endpoint answers it: parents (`include`), children (`embed`) and counts. */
  const shapeRow = (row, ep, counts) => withCounts(withRowCounts(withEmbeds(withIncludes(row, ep), ep.entity, ep.embed), ep), counts);

  /** `pluck: id`: the row answers that field's value as a string (what `includes(String(id))` compares); null stays null. */
  const answerRow = (row, ep, counts) => {
    if (!ep.pluck) return shapeRow(row, ep, counts);
    const v = row[ep.pluck];
    return v === null || v === undefined ? null : String(v);
  };

  /** `wrap: article`: wraps a singleton (and its detail route) response as `{ [ep.wrap]: row }`. */
  const wrapRow = (row, ep, counts) => {
    const val = answerRow(row, ep, counts);
    return ep.wrap ? { [ep.wrap]: val } : val;
  };

  /** " under project_id=1" for error messages of parameterised paths ("" otherwise). */
  function where(ep, params) {
    const bound = (ep.params ?? []).filter((p) => p.field !== null);
    return bound.length ? ` under ${bound.map((p) => `${p.field}=${params[p.name]}`).join(', ')}` : '';
  }

  function json(status, body, headers = {}) {
    return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'x-atrezzo-scenario': dataset.scenario, ...headers }, body };
  }

  // Path segments per route; a `:name` segment captures one segment of the request.
  const compiled = routes.map((ep) => ({ ep, segs: ep.path.split('/') }));
  const compiledWrites = writeRoutes.map((w) => ({ w, segs: w.path.split('/') }));

  /** Captured parameters when `parts` fits `segs` segment by segment, else null. */
  function fit(segs, parts) {
    if (segs.length !== parts.length) return null;
    const out = {};
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].startsWith(':')) {
        if (!parts[i]) return null;
        let v = parts[i];
        try { v = decodeURIComponent(v); } catch { /* keep it raw */ }
        out[segs[i].slice(1)] = v;
      } else if (segs[i] !== parts[i]) return null;
    }
    return out;
  }

  /**
   * Find the endpoint for a pathname: a list route first, then a `<path>/<id>` detail route (in each
   * phase, the most literal route, i.e. the fewest parameters, wins; ties in declaration order).
   */
  function match(pathname) {
    const clean = pathname.replace(/\/+$/, '') || '/';
    const parts = clean.split('/');
    let best = null;
    for (const { ep, segs } of compiled) {
      const params = fit(segs, parts);
      if (params && (!best || Object.keys(params).length < Object.keys(best.params).length)) best = { ep, id: null, params };
    }
    if (best) return best;
    const rawId = parts.at(-1);
    if (!rawId || parts.length < 2) return null;
    let id;
    try { id = decodeURIComponent(rawId); } catch { id = rawId; }
    for (const { ep, segs } of compiled) {
      if (!ep.detail) continue;
      const params = fit(segs, parts.slice(0, -1));
      if (params && (!best || Object.keys(params).length < Object.keys(best.params).length)) best = { ep, id, params };
    }
    return best;
  }

  function matchWrite(method, pathname) {
    const clean = pathname.replace(/\/+$/, '') || '/';
    const parts = clean.split('/');
    const upper = method.toUpperCase();
    let best = null;
    for (const { w, segs } of compiledWrites) {
      if (w.method !== upper) continue;
      const params = fit(segs, parts);
      if (params && (!best || Object.keys(params).length < Object.keys(best.params).length)) best = { w, params };
    }
    return best;
  }

  function allowedMethods(pathname) {
    const clean = pathname.replace(/\/+$/, '') || '/';
    const parts = clean.split('/');
    const methods = [];
    if (match(clean)) methods.push('GET');
    for (const { w, segs } of compiledWrites) {
      if (fit(segs, parts) && !methods.includes(w.method)) methods.push(w.method);
    }
    return methods;
  }

  /** Rows the path parameters allow: each bound parameter is an equality on its field (null = any). */
  function byParams(rows, ep, params) {
    const bound = (ep.params ?? []).filter((p) => p.field !== null);
    if (!bound.length) return rows;
    return rows.filter((r) => bound.every((p) => r[p.field] !== null && r[p.field] !== undefined && String(r[p.field]) === params[p.name]));
  }

  function matchesWhereValue(actual, expected) {
    if (typeof expected === 'string' && expected.startsWith('$user.')) {
      const curUser = getCurrentUser();
      if (!curUser) return false;
      const val = curUser[expected.slice(6)];
      return val !== null && val !== undefined && actual === val;
    }
    return actual === expected;
  }

  function matchesWhere(row, cond) {
    return Object.entries(cond).every(([k, expected]) => (
      Array.isArray(expected)
        ? expected.some((v) => matchesWhereValue(row[k], v))
        : matchesWhereValue(row[k], expected)
    ));
  }

  /** Rows whose FK points to rows in `from` matching `where` (resolved against the world, no query param). */
  function byWorldFilters(rows, ep) {
    if (!ep.worldFilters?.length) return rows;
    let out = rows;
    for (const wf of ep.worldFilters) {
      const allowedIds = new Set();
      for (const target of workingEntities[wf.from] ?? []) {
        if (matchesWhere(target, wf.where)) allowedIds.add(target.id);
      }
      out = out.filter((r) => r[wf.field] !== null && r[wf.field] !== undefined && allowedIds.has(r[wf.field]));
    }
    return out;
  }

  /** Rows matching `$user.<field>` filters resolved from the seeded auth user (no query param). */
  function byUserFilters(rows, ep) {
    if (!ep.userFilters?.length) return rows;
    const curUser = getCurrentUser();
    if (!curUser) return [];
    let out = rows;
    for (const uf of ep.userFilters) {
      const expected = curUser[uf.userField];
      if (expected === null || expected === undefined) return [];
      out = out.filter((r) => r[uf.field] === expected);
    }
    return out;
  }

  /**
   * Referential integrity, enforced on writes and not only when the world is built:
   * a child cannot point at a parent that does not exist, and a parent with children
   * cannot be deleted out from under them.
   */
  const schemaOf = (name) => dataset.schema?.[name]?.refs ?? {};
  function isStringIdField(entity, field) {
    const refs = schemaOf(entity);
    const target = field === 'id' ? entity : (Object.hasOwn(refs, field) ? refs[field] : null);
    if (!target) return false;
    const sample = (initialEntities[target] ?? []).find((r) => r.id !== null && r.id !== undefined);
    return typeof sample?.id === 'string';
  }
  // A foreign key may be null only if the generated world already has nulls in it (`nulls:`).
  const nullableFks = (name) => new Set(Object.keys(schemaOf(name))
    .filter((fk) => (initialEntities[name] ?? []).some((r) => r[fk] === null)));
  /**
   * Bring the foreign keys of a row to the type of the target's ids ("1" → 1 when ids are
   * numbers), so the strict comparisons in includes, counts and the integrity check still match.
   * On create, a missing key becomes null when the key is nullable; otherwise it is reported.
   * Mutates `row`; returns the keys that are missing and cannot be null.
   */
  function normalizeForeignKeys(name, row, { create }) {
    const missing = [];
    const nullable = create ? nullableFks(name) : null;
    for (const [fk, target] of Object.entries(schemaOf(name))) {
      const value = row[fk];
      if (value === undefined) {
        if (!create) continue; // an update that does not touch the key keeps the stored value
        if (nullable.has(fk)) row[fk] = null;
        else missing.push({ fk, target });
        continue;
      }
      if (value === null) continue;
      const sample = (initialEntities[target] ?? []).find((r) => r.id !== null && r.id !== undefined);
      const numericIds = sample ? typeof sample.id === 'number' : true;
      if (numericIds && typeof value === 'string' && /^-?\d+$/.test(value)) row[fk] = Number.parseInt(value, 10);
      else if (!numericIds && typeof value === 'number') row[fk] = String(value);
    }
    return missing;
  }
  function badForeignKeys(name, row) {
    const bad = [];
    for (const [fk, target] of Object.entries(schemaOf(name))) {
      const value = row[fk];
      if (value === undefined || value === null) continue;
      const targetRows = workingEntities[target] ?? [];
      if (!targetRows.some((r) => r.id === value)) bad.push({ fk, value, target });
    }
    return bad;
  }
  /** 422 for the first broken foreign key, or null when the row is fine. */
  function foreignKeyError(name, row, { create }) {
    const missing = normalizeForeignKeys(name, row, { create });
    if (missing.length) {
      const [m] = missing;
      return json(422, { error: `${name}.${m.fk} is required: it points at ${m.target} and cannot be null (scenario "${dataset.scenario}")` });
    }
    const bad = badForeignKeys(name, row);
    if (bad.length) {
      const [b] = bad;
      return json(422, { error: `${name}.${b.fk}=${JSON.stringify(b.value)} does not exist in ${b.target} (scenario "${dataset.scenario}")` });
    }
    return null;
  }
  function referencingChildren(name, id) {
    const out = [];
    for (const [child, meta] of Object.entries(dataset.schema ?? {})) {
      for (const [fk, target] of Object.entries(meta.refs ?? {})) {
        if (target !== name) continue;
        const rowsOfChild = workingEntities[child] ?? [];
        if (rowsOfChild.some((r) => String(r[fk]) === String(id))) out.push({ child, fk });
      }
    }
    return out;
  }
  function handleWrite(wMatch, pathname, body) {
    const { w, params } = wMatch;
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
      return json(400, { error: 'request body must be a JSON object' });
    }
    const payload = body && typeof body === 'object' ? body : {};
    const status = w.expect.status;
    const respond = (defaultBody) => {
      if (w.expect.body !== undefined) return json(status, w.expect.body === null ? null : JSON.parse(JSON.stringify(w.expect.body)));
      if (w.expect.echo) return json(status, defaultBody);
      return json(status, status === 204 || status === 205 || status === 304 ? null : {});
    };

    if (!w.mutate) return respond(canonicalValue(payload));

    const { entity, action, set, where: whereCond } = w.mutate;
    const rows = workingEntities[entity];
    const curUser = getCurrentUser();
    const resolveVal = (v) => (typeof v === 'string' && v.startsWith('$user.') ? (curUser ? (curUser[v.slice(6)] ?? null) : null) : v);
    const hasNumericIds = (name) => {
      const sample = (initialEntities[name] ?? []).find((r) => r.id !== null && r.id !== undefined)
        ?? (workingEntities[name] ?? []).find((r) => r.id !== null && r.id !== undefined);
      return sample ? typeof sample.id === 'number' : true;
    };
    const coerceParam = (field, rawVal) => {
      const refs = schemaOf(entity);
      if (field === 'id') return hasNumericIds(entity) && /^\d+$/.test(rawVal) ? Number.parseInt(rawVal, 10) : rawVal;
      if (Object.hasOwn(refs, field)) return hasNumericIds(refs[field]) && /^\d+$/.test(rawVal) ? Number.parseInt(rawVal, 10) : rawVal;
      if (rows.some((r) => typeof r[field] === 'number') && /^-?\d+$/.test(rawVal)) return Number.parseInt(rawVal, 10);
      return rawVal;
    };
    const buildRow = (rawRow) => {
      const fields = dataset.schema[entity]?.fields ?? [];
      const out = {};
      for (const f of fields) {
        if (Object.hasOwn(rawRow, f)) out[f] = canonicalValue(rawRow[f]);
      }
      return out;
    };
    const readEp = (() => {
      const m = match(pathname);
      if (m?.ep.entity === entity && !m.ep.pluck && !m.ep.passthrough) return m.ep;
      return routes.find((ep) => ep.entity === entity && !ep.pluck && !ep.passthrough) ?? null;
    })();
    const formatWriteRow = (row) => (readEp ? shapeRow(row, readEp, []) : { ...row });

    if (action === 'create') {
      const raw = {};
      for (const [k, v] of Object.entries(payload)) {
        if (k !== 'id') raw[k] = v;
      }
      for (const p of w.params ?? []) {
        if (p.field !== null) raw[p.field] = coerceParam(p.field, params[p.name]);
      }
      for (const [k, v] of Object.entries(set ?? {})) raw[k] = resolveVal(v);
      const fkError = foreignKeyError(entity, raw, { create: true });
      if (fkError) return fkError;
      const sample = (initialEntities[entity] ?? []).find((r) => r.id !== null && r.id !== undefined)
        ?? rows.find((r) => r.id !== null && r.id !== undefined);
      if (typeof sample?.id === 'string') {
        if (!Object.hasOwn(payload, 'id') || typeof payload.id !== 'string') {
          return json(422, { error: `${entity}.id is required and must be a string in scenario "${dataset.scenario}"` });
        }
        if (!isValidStringId(payload.id)) {
          return json(422, { error: `${entity}.id ${JSON.stringify(payload.id)} is invalid: must use 1..200 URL-unreserved characters (ASCII A-Z, a-z, 0-9, ".", "_", "~", "-", maximum 200 characters, not "." or "..") in scenario "${dataset.scenario}"` });
        }
        if (rows.some((r) => r.id === payload.id)) {
          return json(409, { error: `${entity}#${payload.id} already exists in scenario "${dataset.scenario}"` });
        }
        raw.id = payload.id;
      } else {
        const id = nextIds.get(entity) ?? 1;
        nextIds.set(entity, id + 1);
        raw.id = id;
      }
      const created = buildRow(raw);
      rows.push(created);
      invalidateIndexes();
      return respond(formatWriteRow(created));
    }

    const bound = (w.params ?? []).filter((p) => p.field !== null);
    let indices = [];
    if (!bound.length && !whereCond && payload.id === undefined) {
      if (match(pathname)?.ep.shape === 'object') {
        if (rows.length) indices = [0];
      } else {
        return json(400, { error: `cannot identify which "${entity}" row to ${action} (declare ":id" in the path, "where", or send "id" in the body)` });
      }
    } else {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (bound.some((p) => r[p.field] === null || r[p.field] === undefined || String(r[p.field]) !== params[p.name])) continue;
        if (whereCond && !matchesWhere(r, whereCond)) continue;
        if (!bound.length && !whereCond && payload.id !== undefined && String(r.id) !== String(payload.id)) continue;
        indices.push(i);
      }
    }
    if (!indices.length) return json(404, { error: `${entity} not found in scenario "${dataset.scenario}"` });

    const singleTarget = bound.length > 0 || payload.id !== undefined || !whereCond;
    if (action === 'update') {
      const updatedList = [];
      for (const idx of indices) {
        const raw = { ...rows[idx] };
        for (const [k, v] of Object.entries(payload)) {
          if (k !== 'id') raw[k] = v;
        }
        for (const [k, v] of Object.entries(set ?? {})) raw[k] = resolveVal(v);
        const fkError = foreignKeyError(entity, raw, { create: false });
        if (fkError) return fkError;
        const updated = buildRow(raw);
        rows[idx] = updated;
        updatedList.push(updated);
      }
      invalidateIndexes();
      return respond(singleTarget && updatedList.length === 1 ? formatWriteRow(updatedList[0]) : updatedList.map(formatWriteRow));
    }

    for (const idx of indices) {
      const children = referencingChildren(entity, rows[idx].id);
      if (children.length) {
        const c = children[0];
        const n = (workingEntities[c.child] ?? []).filter((r) => String(r[c.fk]) === String(rows[idx].id)).length;
        return json(409, { error: `cannot delete ${entity}#${rows[idx].id}: ${n} row${n === 1 ? '' : 's'} of "${c.child}" point at it (${c.fk}); delete them first` });
      }
    }
    const deletedList = indices.map((idx) => formatWriteRow(rows[idx]));
    for (let j = indices.length - 1; j >= 0; j--) rows.splice(indices[j], 1);
    invalidateIndexes();
    return respond(singleTarget && deletedList.length === 1 ? deletedList[0] : deletedList);
  }

  // PostgREST functions (`rpc:`): `/rpc/<fn>` and `/rest/v1/rpc/<fn>`, whatever prefix the client adds.
  const rpcByFn = new Map((dataset.rpc ?? []).map((r) => [r.fn, r]));
  function matchRpc(pathname) {
    const m = /^(?:\/rest\/v1)?\/rpc\/([^/]+)$/.exec(pathname.replace(/\/+$/, ''));
    if (!m) return null;
    let fn = m[1];
    try { fn = decodeURIComponent(fn); } catch { /* keep it raw */ }
    return { fn, rule: rpcByFn.get(fn) ?? null };
  }

  /** A declared function answers its body; `match` arguments must arrive with exactly that value (else 400). */
  function handleRpc({ fn, rule }, pathname, body) {
    if (!rule) {
      const declared = [...rpcByFn.keys()];
      const res = json(404, {
        code: 'PGRST202',
        message: `Could not find the function ${fn} in scenario "${dataset.scenario}"`,
        error: `POST ${pathname}: function "${fn}" is not declared under rpc: in scenario "${dataset.scenario}"${declared.length ? ` (declared: ${declared.join(', ')})` : ''}`,
        atrezzo: { miss: true, gap: `POST ${pathname}`, rpc: declared },
      });
      res.miss = true;
      return res;
    }
    if (rule.match) {
      const args = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
      const same = (a, b) => JSON.stringify(canonicalValue(a)) === JSON.stringify(canonicalValue(b));
      const wrong = Object.entries(rule.match).filter(([k, v]) => !Object.hasOwn(args, k) || !same(args[k], v));
      if (wrong.length) {
        const [k, v] = wrong[0];
        return json(400, {
          message: `rpc ${fn}: argument "${k}" must be ${JSON.stringify(v)} (got ${Object.hasOwn(args, k) ? JSON.stringify(args[k]) : 'nothing'})`,
          error: `rpc ${fn}: the arguments do not match the scenario (${wrong.map(([a]) => a).join(', ')})`,
          atrezzo: { rpc: fn, match: rule.match },
        });
      }
    }
    const status = rule.expect.status;
    if (rule.body === undefined && (status === 204 || status === 205 || status === 304)) return json(status, null);
    return { ...json(status, rule.body === undefined ? null : JSON.parse(JSON.stringify(rule.body))), hasBody: true };
  }

  /**
   * @param {{ method?: string, pathname: string, query?: URLSearchParams | Record<string,string>,
   *   headers?: Headers | Record<string, string | string[]>, body?: unknown }} req
   * @returns {{ status: number, headers: Record<string,string>, body: unknown, hasBody?: boolean, miss?: true } | null}
   *   null = not ours (body null without hasBody: true = no body: a count-only answer;
   *   miss = a `shape: object` endpoint whose entity has no rows, which `serve` records as a gap)
   */
  function handle({ method = 'GET', pathname, query, headers, body }) {
    const upper = method.toUpperCase();
    if (upper !== 'GET' && upper !== 'HEAD') {
      const rpc = matchRpc(pathname);
      if (rpc?.rule && upper === 'POST') return handleRpc(rpc, pathname, body);
      const wm = matchWrite(upper, pathname);
      if (wm) return handleWrite(wm, pathname, body);
      if (rpc && upper === 'POST') return handleRpc(rpc, pathname, body);
      const allowed = allowedMethods(pathname);
      if (rpc?.rule && !allowed.length) return json(405, { error: `${upper} ${pathname} is not in the contract (PostgREST functions answer POST)` }, { allow: 'POST' });
      if (!allowed.length) return null;
      return json(405, { error: `${upper} ${pathname} is not in the contract (allowed: ${allowed.join(', ')})` }, { allow: allowed.join(', ') });
    }
    const m = match(pathname);
    if (!m) {
      const allowed = allowedMethods(pathname);
      if (allowed.length) return json(405, { error: `${upper} ${pathname} is not in the contract (allowed: ${allowed.join(', ')})` }, { allow: allowed.join(', ') });
      if (matchRpc(pathname)?.rule) return json(405, { error: `${upper} ${pathname} is not in the contract (PostgREST functions answer POST)` }, { allow: 'POST' });
      return null;
    }
    const params = query instanceof URLSearchParams ? query : new URLSearchParams(query ?? {});
    const { ep, id } = m;
    // `error:` answers the declared status and body on the list and the detail route, world untouched.
    if (ep.error) return json(ep.error.status, ep.error.body, { 'x-atrezzo-error': 'declared' });
    // `passthrough:` answers the recorded fixture with its declared patch applied, leaving everything else untouched.
    if (ep.passthrough) {
      const pt = dataset.passthrough?.[ep.path];
      if (!pt) return json(500, { error: `missing resolved passthrough fixture "${ep.passthrough.fixture}" for ${ep.path}` });
      const ct = pt.contentType ?? 'application/json; charset=utf-8';
      const hasBody = pt.hasBody ?? (pt.body !== null);
      return {
        status: pt.status,
        headers: { 'content-type': ct, 'x-atrezzo-scenario': dataset.scenario },
        body: hasBody ? pt.body : null,
        hasBody,
      };
    }
    // A parameterised path (`/projects/:project_id/tasks`) only sees the rows its parameters name.
    const rows = byParams(workingEntities[ep.entity], ep, m.params);
    // PostgREST parameters; a declared filter of the same name keeps its meaning.
    const select = ep.filters.includes('select') ? null : params.get('select');
    const { counts, honoured } = countsFor(ep, select);
    const head = ep.filters.includes('head') ? null : params.get('head');

    if (id !== null) {
      const row = rows.find((r) => String(r.id) === id);
      if (!row) return json(404, { error: `${ep.entity} ${id} does not exist${where(ep, m.params)} in scenario "${dataset.scenario}"` });
      return json(200, wrapRow(row, ep, counts));
    }

    const ignored = [];
    const reserved = [
      ...(ep.pagination ? [ep.pagination.limit, ep.pagination.page ?? ep.pagination.offset] : []),
      ...(ep.sorts ? [ep.sorts.by, ...(ep.sorts.order ? [ep.sorts.order] : [])] : []),
      ...(ep.scopes ?? []).map((s) => s.param),
    ];
    const scopeRes = resolveScopes(ep, params);
    if (scopeRes.error) return json(400, { error: scopeRes.error });
    let result = byUserFilters(byWorldFilters(rows, ep), ep);
    if (scopeRes.preds.length) result = result.filter((r) => scopeRes.preds.every((p) => p(r)));
    for (const [key, raw] of params) {
      if (reserved.includes(key)) continue;
      if (ep.filters.includes(key)) {
        const strictStringId = isStringIdField(ep.entity, key);
        result = result.filter((r) => matchesFilter(r[key], raw, strictStringId));
      } else if (key === 'select' && honoured) continue;
      else if (key === 'head' && (raw === 'true' || raw === 'false')) continue;
      else ignored.push(key);
    }

    const sortRes = resolveSort(ep, params, dataset.scenario);
    if (sortRes.error) return json(400, { error: sortRes.error });

    // Count only: `head=true`, or a HEAD request with `Prefer: count=exact`. Empty body and
    // `Content-Range: 0-<n-1>/<n>` over every row that passes the filters (pagination does not apply).
    if (head === 'true' || (upper === 'HEAD' && wantsCount(headers))) {
      const n = result.length;
      const h = { 'x-total-count': String(n), 'content-range': n ? `0-${n - 1}/${n}` : '0-0/0' };
      if (ignored.length) h['x-atrezzo-ignored'] = ignored.join(',');
      return json(200, null, h);
    }

    const indexed = result.map((r, i) => [r, i]);
    indexed.sort(([a, ia], [b, ib]) => {
      for (const { field, dir } of sortRes.sort) {
        const c = compare(a[field], b[field]);
        if (c !== 0) return dir === 'desc' ? -c : c;
      }
      return ia - ib; // stable
    });
    result = indexed.map(([r]) => r);
    const total = result.length;

    // Singleton (`shape: object`): the first row after filters and sort, as a JSON object.
    if (ep.shape === 'object') {
      const h = ignored.length ? { 'x-atrezzo-ignored': ignored.join(',') } : {};
      if (!workingEntities[ep.entity].length) {
        // An empty singleton is a missing entity, not a client error: same body as a gap, and
        // `miss: true` so `serve` records it in misses like any other undeclared route.
        const gap = `GET ${ep.path}`;
        const res = json(404, {
          error: `${ep.entity} has no rows in scenario "${dataset.scenario}"; ${ep.path} (shape: object) answers its first row`,
          atrezzo: { miss: true, gap, endpoints: dataset.endpoints.map((e) => e.path) },
        }, h);
        res.miss = true;
        return res;
      }
      if (!result.length) {
        const q = [...params].filter(([k]) => ep.filters.includes(k)).map(([k, v]) => `${k}=${v}`).join('&');
        const resolved = [
          ...(ep.worldFilters?.length ? ['world filter'] : []),
          ...(ep.userFilters?.length ? ['user filter'] : []),
        ].join(' and ');
        const label = q || resolved || '(no filter)';
        return json(404, { error: `no ${ep.entity} matches ${label}${where(ep, m.params)} in scenario "${dataset.scenario}"` }, h);
      }
      return json(200, wrapRow(result[0], ep, counts), h);
    }

    let limit = null;
    let offset = 0;
    let pageNum = 1;
    if (ep.pagination) {
      const l = parseNonNegInt(params.get(ep.pagination.limit), ep.pagination.limit);
      const pageParam = ep.pagination.page;
      const o = parseNonNegInt(params.get(pageParam ?? ep.pagination.offset), pageParam ?? ep.pagination.offset);
      if (l.error || o.error) return json(400, { error: l.error || o.error });
      if (pageParam && o.value === 0) return json(400, { error: `"${pageParam}" starts at 1; got "0"` });
      limit = l.value ?? ep.pagination.defaultLimit;
      if (limit !== null && ep.pagination.maxLimit !== null) limit = Math.min(limit, ep.pagination.maxLimit);
      offset = pageParam ? ((o.value ?? 1) - 1) * (limit ?? 0) : (o.value ?? 0);
      pageNum = pageParam ? (o.value ?? 1) : (limit !== null && limit > 0 ? Math.floor(offset / limit) + 1 : 1);
      result = result.slice(offset, limit === null ? undefined : offset + limit);
    }
    const page = result.map((r) => answerRow(r, ep, counts));
    const out = { 'x-total-count': String(total) };
    if (ignored.length) out['x-atrezzo-ignored'] = ignored.join(',');
    // `.single()` in supabase-js / PostgREST asks for one object with this Accept header, whatever
    // the scenario declares: one row ⇒ that row, anything else ⇒ 406 PGRST116 (as PostgREST does).
    if ((headerValue(headers, 'accept') ?? '').includes('application/vnd.pgrst.object+json')) {
      if (page.length !== 1) {
        return json(406, {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
          details: `${page.length} rows`,
        }, out);
      }
      return json(200, page[0], out);
    }
    if (ep.shape === 'envelope') return json(200, formatEnvelope(ep, page, total, limit, offset, pageNum), out);
    return json(200, page, out);
  }

  return {
    match,
    handle,
    reset,
    dataset: liveDataset,
    get currentUser() {
      const u = getCurrentUser();
      return u ? { ...u } : null;
    },
  };
}
