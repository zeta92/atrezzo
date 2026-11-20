// `atrezzo harvest`: open a URL in Chromium, collect 404 gaps from the mock
// (and requests made again after a failure), infer entities/fields from
// --types -> select= -> guess, reload the mock, and repeat until done.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtrezzoError, EXIT } from './errors.mjs';
import { parseYaml } from './yaml.mjs';
import { emitYaml } from './yaml-emit.mjs';
import { loadScenario, normalizeScenario } from './scenario.mjs';
import { entityFields, generateWorld, irregularPlural, singularize, templateFor } from './world.mjs';
import { createMockServer } from './serve.mjs';
import { isMutation, isSecretParam, missKey } from './misses.mjs';
import { loadPlaywright, chromeExecutable } from './verify.mjs';
import { fieldsOfType, parseTsTypes, resolveTypeForSegment } from './ts-types.mjs';
import { formatStorage, hasStorage, parseStorageJson, storageKeys, storageScript, validateStorage } from './storage.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;
const ASSET = /\.(ico|png|jpe?g|gif|svg|webp|avif|css|js|mjs|cjs|map|html?|woff2?|ttf|otf|txt|webmanifest)$/i;
const SINGLETON_NAMES = new Set(['info', 'user', 'me', 'config', 'settings']);
const LIMIT_KEYS = ['limit', 'per_page', 'perPage', 'page_size', 'pageSize', 'size'];
const OFFSET_KEYS = ['offset', 'skip'];
const VALID_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENTITY_NAME = /^[a-z][a-z0-9_]*$/; // same rule as the scenario validator
const MAX_DETAIL_ID = 1000;
// Envelope keys tried, in this order, when the page does not advance with a plain array.
export const ENVELOPE_KEYS = ['items', 'data', 'results', 'records', 'rows'];

const snake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();

function pluralize(s) {
  if (!s) return 'items';
  const irregular = irregularPlural(s);
  if (irregular) return irregular;
  if (/s$/.test(s)) return s;
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(x|ch|sh)$/.test(s)) return `${s}es`;
  return `${s}s`;
}

function toEntityName(raw) {
  let n = pluralize(snake(raw));
  if (!/^[a-z]/.test(n)) n = `e_${n}`;
  return n || 'items';
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function entityTotal(entry) {
  if (Number.isInteger(entry)) return entry;
  return isObj(entry) && Number.isInteger(entry.total) ? entry.total : 0;
}

function ensureEntityObject(world, name, defaultTotal = 5) {
  const cur = world[name];
  if (cur === undefined) { world[name] = { total: defaultTotal }; return world[name]; }
  if (Number.isInteger(cur)) { world[name] = { total: cur }; return world[name]; }
  return cur;
}

function splitSelect(raw) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of raw) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

/** Infer scalar fields from a PostgREST `select=` query string. */
export function fieldsFromSelect(selectValues) {
  const fields = {};
  const skipped = [];
  for (const raw of selectValues) {
    for (const item of splitSelect(raw)) {
      if (item === '*') continue;
      if (/\(/.test(item)) {
        // Ignore embedded relations such as `children(count)` or `alias:children(*)`.
        if (!/\(count\)$/.test(item)) skipped.push(`select embed "${item}"`);
        continue;
      }
      const col = item.includes(':') ? item.split(':').pop().trim() : item;
      if (!col || col === 'id') continue;
      if (!VALID_IDENT.test(col)) { skipped.push(`select column "${col}"`); continue; }
      if (/^(created|updated|deleted|published|due|start|end)_at$|_date$|^date$/i.test(col)) fields[col] = 'date';
      else if (/email/i.test(col)) fields[col] = 'email';
      else if (/url|avatar|link/i.test(col)) fields[col] = 'url';
      else if (/^(is|has|can|should)_|^done$|^active$|^enabled$/i.test(col)) fields[col] = 'boolean';
      else if (/_id$|^(count|total|age|qty|quantity|stock|priority|order|position)$/i.test(col)) fields[col] = 'integer';
      else fields[col] = 'string';
    }
  }
  return { fields, skipped };
}

/** Infer a scenario field type from an observed query parameter value. */
function inferQueryFieldType(name, values) {
  const clean = values.filter((v) => v !== '***' && v !== '');
  if (!clean.length) return 'string';
  if (clean.every((v) => v === 'true' || v === 'false')) return 'boolean';
  if (clean.every((v) => /^-?\d+$/.test(v))) return 'integer';
  if (clean.every((v) => /^-?\d+\.\d+$/.test(v))) return 'number';
  if (clean.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v))) return 'date';
  if (clean.length === 1 && !clean[0].includes(',')) return [clean[0]];
  return 'string';
}

/**
 * Derive the parameterized endpoint path and observed parameter values from a concrete URL path.
 * E.g. `/api/a/1/b/4/c` -> `{ path: '/api/a/:a_id/b/:b_id/c', params: [...], lastSeg: 'c', detailId: null }`.
 * Detail `/api/a/42` -> `{ path: '/api/a', params: [], lastSeg: 'a', detailId: '42' }`.
 */
export function inferPathShape(examplePath) {
  const clean = (examplePath || '/').replace(/\/+$/, '') || '/';
  const segs = clean.split('/').filter(Boolean);
  let detailId = null;
  if (segs.length >= 2 && ID_SEGMENT.test(segs.at(-1))) {
    detailId = segs.pop();
  }
  const params = [];
  const used = new Set();
  const outSegs = segs.map((seg, idx) => {
    if (!ID_SEGMENT.test(seg)) return seg;
    const prev = idx > 0 && !ID_SEGMENT.test(segs[idx - 1]) ? segs[idx - 1] : null;
    let base = prev ? `${singularize(snake(prev)) || 'item'}_id` : `param_${idx}`;
    let name = base;
    let suffix = 2;
    while (used.has(name)) { name = `${base}_${suffix++}`; }
    used.add(name);
    params.push({ name, observed: seg });
    return `:${name}`;
  });
  const path = `/${outSegs.join('/')}`;
  const lastSeg = [...segs].reverse().find((s) => !ID_SEGMENT.test(s)) ?? 'items';
  return { path, params, lastSeg, detailId };
}

/**
 * Can the world hold the row this detail id names? atrezzo numbers rows 1..total, so any integer id
 * >= 1 can be reached by widening `total` (up to MAX_DETAIL_ID, so that an id taken from a timestamp or
 * a database sequence does not make a list endpoint answer millions of rows).
 */
function detailIdNumber(raw) {
  if (!/^\d+$/.test(String(raw))) return { ok: false, reason: 'not numeric: atrezzo rows have ids 1..total' };
  const value = Number(raw);
  if (value < 1) return { ok: false, reason: 'atrezzo rows have ids from 1' };
  if (value > MAX_DETAIL_ID) return { ok: false, reason: `above ${MAX_DETAIL_ID}, the most rows harvest seeds for a detail` };
  return { ok: true, value };
}

function shapeKey(path) {
  return path.replace(/\/:[^/]+/g, '/:');
}

// A query key is only a filter when it looks like one. Flags (`is_archived=true`, `expand=permissions`,
// `sort_by=due`) name a behaviour of the client, not a subset of rows: declaring them as equality filters
// returns zero rows and hides the very screen we are trying to render.
const FLAG_KEYS = new Set(['expand', 'include', 'exclude', 'with', 'fields', 'filter', 'sort', 'order',
  'search', 'q', 'meta', 'count', 'permissions', 'format']);
const FLAG_PREFIX = /^(sort|order|filter|with|is_|has_)/i;
const FLAG_SUFFIX = /_by$/i;

/**
 * A flag: a known behaviour key, a key that starts with sort/order/filter/with/is_/has_ or ends in `_by`,
 * or any key sent with a boolean value. A key ending in `_id` names a foreign key, so it stays a filter
 * whatever its prefix (`order_id=3` is a subset of rows, `order_by=id` is not).
 */
export function isQueryFlag(key, values = []) {
  if (values.some((v) => /^(true|false)$/i.test(String(v)))) return true;
  if (FLAG_KEYS.has(key) || FLAG_SUFFIX.test(key)) return true;
  return FLAG_PREFIX.test(key) && !/_id$/i.test(key);
}

/** Collect query values across all observed requests (and miss.query fallback). */
function collectQueryMap(observedForGap, missQuery) {
  const map = new Map();
  const add = (k, v) => {
    if (!map.has(k)) map.set(k, []);
    const list = map.get(k);
    if (!list.includes(v)) list.push(v);
  };
  for (const obs of observedForGap) {
    for (const [k, v] of obs.searchParams) add(k, v);
  }
  if (map.size === 0 && missQuery) {
    for (const [k, v] of Object.entries(missQuery)) {
      for (const item of [].concat(v)) add(k, String(item));
    }
  }
  return map;
}

/**
 * Merge one unresolved GET gap into `doc` (mutates `doc` in place).
 * Returns `{ changed: boolean, record?: object, notes: string[] }`.
 */
export function mergeGapIntoScenario(doc, miss, { observedForGap = [], parsedTypes = null, typesLabel = null } = {}) {
  const notes = [];
  const { path, params, lastSeg, detailId } = inferPathShape(miss.example || miss.path);
  const key = shapeKey(path);
  const existingEp = doc.endpoints.find((ep) => shapeKey(ep.path.replace(/\/+$/, '') || '/') === key);

  if (existingEp) {
    if (!existingEp.entity) return { changed: false, notes };
    // The rows are widened to the requested id FIRST, and only then is the detail judged: an entity that
    // has no rows yet (or fewer than the id) is not a reason to drop the route. Only an id atrezzo cannot
    // number (not an integer, below 1, or beyond MAX_DETAIL_ID) is left out, and the report says why.
    const entEntry = doc.world[existingEp.entity];
    const curTotal = entityTotal(entEntry);
    const how = [];
    if (detailId !== null && existingEp.detail === false) {
      delete existingEp.detail;
      how.push('detail enabled');
    }
    let want = existingEp.shape === 'object' ? 1 : 0;
    if (detailId !== null) {
      const id = detailIdNumber(detailId);
      if (id.ok) want = Math.max(want, id.value);
      else notes.push(`GET ${miss.example ?? miss.path}: detail id ${detailId} not mocked (${id.reason})`);
    }
    let ent = isObj(entEntry) ? entEntry : null;
    if (want > curTotal) {
      ent = ensureEntityObject(doc.world, existingEp.entity, want);
      ent.total = want;
      how.push(`total ${curTotal} → ${want}`);
    }
    if (!how.length) return { changed: false, notes };
    return {
      changed: true,
      record: {
        method: 'GET', path: existingEp.path, entity: existingEp.entity, shape: existingEp.shape ?? 'array',
        source: `existing (${how.join(', ')})`, fields: ['id', ...Object.keys(ent?.fields ?? {})],
        uninferrable: [],
      },
      notes,
    };
  }

  // Choose entity name: reuse exact snake(lastSeg) if already in world, else pluralize.
  const rawSnake = snake(lastSeg) || 'items';
  const candidatePlural = toEntityName(lastSeg);
  const entityName = Object.hasOwn(doc.world, rawSnake) ? rawSnake : candidatePlural;
  const entityExisted = Object.hasOwn(doc.world, entityName);
  const entityLocked = entityExisted && doc.endpoints.some((ep) => ep.entity === entityName);

  // Field inference in priority order: (a) --types -> (b) select= -> (c) guess.
  const qMap = collectQueryMap(observedForGap, miss.query);
  let source = 'guess';
  let inferredFields = {};
  let inferredValues = {};
  let epUninferrable = [];
  let shape = SINGLETON_NAMES.has(lastSeg.toLowerCase()) ? 'object' : 'array';
  let pick = null;

  const tsMatch = parsedTypes ? resolveTypeForSegment(parsedTypes, lastSeg) : null;
  if (tsMatch) {
    source = `types:${typesLabel ?? tsMatch.file}:${tsMatch.line}`;
    inferredFields = { ...tsMatch.fields };
    inferredValues = { ...tsMatch.values };
    epUninferrable.push(...tsMatch.skipped);
    if (tsMatch.shape === 'object') shape = 'object';
    else if (tsMatch.shape === 'envelope') { shape = 'envelope'; pick = tsMatch.pick; }
  } else if (qMap.has('select')) {
    const sel = fieldsFromSelect(qMap.get('select'));
    epUninferrable.push(...sel.skipped);
    if (Object.keys(sel.fields).length > 0) {
      source = 'select=';
      inferredFields = sel.fields;
    }
  }

  // Query parameters -> pagination and equality filters.
  let pagination = null;
  const limitKey = LIMIT_KEYS.find((k) => qMap.has(k));
  const offsetKey = OFFSET_KEYS.find((k) => qMap.has(k));
  if (qMap.has('page')) {
    const limRaw = limitKey ? qMap.get(limitKey)[0] : null;
    const defLim = limRaw && /^\d+$/.test(limRaw) && Number(limRaw) > 0 ? Number(limRaw) : 20;
    pagination = { param_page: 'page', param_limit: limitKey ?? 'limit', default_limit: defLim };
  } else if (limitKey || offsetKey) {
    pagination = { param_limit: limitKey ?? 'limit', param_offset: offsetKey ?? 'offset' };
  }

  // Query keys -> equality filters, except flags (see isQueryFlag), which only go to the report.
  const queryFilters = [];
  for (const [k, vals] of qMap.entries()) {
    if (k === 'select' || k === 'head' || k === 'page' || LIMIT_KEYS.includes(k) || OFFSET_KEYS.includes(k)) continue;
    if (!VALID_IDENT.test(k)) { epUninferrable.push(`query parameter "${k}" (not a valid field name)`); continue; }
    if (isQueryFlag(k, vals)) {
      epUninferrable.push(`query parameter "${k}" left out of the filters (a flag, not a subset of rows)`);
      continue;
    }
    queryFilters.push(k);
  }

  // Prepare/merge world entity (keeping all existing keys when entity already exists).
  const minTotal = shape === 'object' ? 1 : pagination ? 20 : 5;
  let detailNum = 0;
  if (detailId !== null) {
    const id = detailIdNumber(detailId);
    if (id.ok) detailNum = id.value;
    else notes.push(`GET ${miss.example ?? miss.path}: detail id ${detailId} not mocked (${id.reason})`);
  }
  const entObj = ensureEntityObject(doc.world, entityName, Math.max(minTotal, detailNum));
  if (detailNum > entObj.total) entObj.total = detailNum;

  let seededFirst = false;
  if (!entityLocked) {
    if (Object.keys(inferredFields).length > 0) {
      entObj.fields = { ...inferredFields, ...(isObj(entObj.fields) ? entObj.fields : {}) };
    }
    if (Object.keys(inferredValues).length > 0) {
      entObj.values = { ...inferredValues, ...(isObj(entObj.values) ? entObj.values : {}) };
    }
    // An entity shaped by --types renders in its first declared state: a flag drawn at random can hide the screen.
    if (tsMatch && entObj.seed_first === undefined && hasSeedableField(entObj.fields)) {
      entObj.seed_first = true;
      seededFirst = true;
    }
  } else if (isObj(entObj.fields) && Object.keys(inferredFields).length > 0) {
    entObj.fields = { ...inferredFields, ...entObj.fields };
  }

  // Bind every path parameter (:<parent>_id, ...) BY NAME to a field of the entity: the parent's FK when
  // the parameter names a world entity (ref:), else the field of that name (created when the entity is
  // still ours to shape). The binding is always written out in the map form of `filters`, because the
  // list form binds nothing once a path has two or more parameters. `null` (accept any value, no
  // filtering) is the last resort, only for an entity another endpoint already projects, and it is reported.
  const paramBindings = {};
  const chain = []; // parameters bound to a parent entity, in path order
  for (const { name: pname, observed } of params) {
    const base = pname.replace(/_id$/, '');
    const parentCandidates = [pluralize(base), base];
    const parent = parentCandidates.find((p) => p !== entityName && Object.hasOwn(doc.world, p));
    const parentCount = parent ? entityTotal(doc.world[parent]) : 0;
    const obsNum = /^\d+$/.test(observed) ? Number(observed) : null;

    if (parent && obsNum !== null && obsNum >= 1 && obsNum <= parentCount) {
      const existingRefs = entObj.ref === undefined ? [] : Array.isArray(entObj.ref) ? entObj.ref : [entObj.ref];
      if (!existingRefs.includes(parent)) existingRefs.push(parent);
      entObj.ref = existingRefs.length === 1 ? existingRefs[0] : existingRefs;
      if (entObj.total < parentCount) entObj.total = Math.max(entObj.total, parentCount * 2);
      paramBindings[`:${pname}`] = templateFor(parent).fk;
      chain.push({ parent, fk: templateFor(parent).fk, observed: obsNum });
      continue;
    }
    const candidateFields = pname.endsWith('_id') ? [pname] : [pname, `${pname}_id`];
    const known = new Set(rawEntityFields(entityName, entObj));
    const existingField = candidateFields.find((f) => known.has(f));
    if (existingField) {
      // A declared field (e.g. from --types): seed the observed value so the observed URL has rows.
      if (isObj(entObj.fields) && existingField in entObj.fields) {
        entObj.values = isObj(entObj.values) ? entObj.values : {};
        if (!(existingField in entObj.values)) entObj.values[existingField] = [obsNum ?? observed];
      }
      paramBindings[`:${pname}`] = existingField;
    } else if (!entityLocked) {
      // A segment the world does not model yet: the entity gets a field of the parameter's name, every row
      // carrying the observed value, so the observed URL answers rows and any other value answers [].
      if (!isObj(entObj.fields)) entObj.fields = { name: 'string' };
      entObj.fields[pname] = obsNum !== null ? 'integer' : 'string';
      entObj.values = isObj(entObj.values) ? entObj.values : {};
      entObj.values[pname] = [obsNum ?? observed];
      paramBindings[`:${pname}`] = pname;
    } else {
      paramBindings[`:${pname}`] = null;
      epUninferrable.push(`path parameter ":${pname}" accepts any value (world.${entityName} has no field "${pname}" and another endpoint already projects it)`);
    }
  }

  const derived = chain.length >= 2 ? deriveFromNesting(doc, entityName, entObj, chain, epUninferrable) : [];

  // Ensure every query filter key exists on the entity's fields.
  if (queryFilters.length) {
    const curTemplate = entObj.fields ? null : templateFor(entityName);
    const curRefs = entObj.ref === undefined ? [] : Array.isArray(entObj.ref) ? entObj.ref : [entObj.ref];
    const normSpec = {
      name: entityName,
      count: entObj.total,
      refs: curRefs,
      fields: isObj(entObj.fields) ? entObj.fields : undefined,
      pools: isObj(entObj.values) ? entObj.values : {},
      distribution: isObj(entObj.distribution) ? { field: entObj.distribution_field ?? curTemplate?.statusField ?? 'status', counts: entObj.distribution } : null,
      amount: isObj(entObj.amount) ? entObj.amount : curTemplate?.defaultAmount ?? null,
    };
    const knownFields = new Set(entityFields(normSpec));
    for (const qk of queryFilters) {
      if (knownFields.has(qk)) continue;
      if (!isObj(entObj.fields)) entObj.fields = { name: 'string' };
      entObj.fields[qk] = inferQueryFieldType(qk, qMap.get(qk) ?? []);
    }
  }

  // If `doc.world[entityName]` only has `{ total: n }`, keep short form only if it started short;
  // for newly added entities `{ total: n }` or `{ total: n, fields: ... }` are both clean.
  const ep = { path, entity: entityName };

  // Relations from the type graph: `T[]` fields embed child rows, `T` fields include the parent row.
  const relations = tsMatch?.relations?.length
    ? applyTypeRelations(doc, { entityName, entObj, entityLocked, ep, tsMatch, parsedTypes, typesLabel, uninferrable: epUninferrable })
    : [];
  if (params.length > 0) {
    // Path with parameters: always the map form, every parameter bound by name, then `field: field`.
    const fMap = { ...paramBindings };
    for (const qk of queryFilters) fMap[qk] = qk;
    ep.filters = fMap;
  } else if (queryFilters.length > 0) {
    ep.filters = queryFilters;
  }
  if (pagination) ep.pagination = pagination;
  // A paginated endpoint almost always answers an envelope ({items, page, total}); a bare array makes
  // list screens render empty while every request is 200. Default to the envelope and say so; a client
  // that really reads a bare list can switch the endpoint back to `shape: array`.
  if (pagination && !pick && shape === 'array') {
    ep.shape = 'envelope';
    ep.pick = 'items';
    notes.push(`GET ${miss.example ?? miss.path}: paginated, answered as {items: […]}; change it to shape: array if the client reads a bare list`);
  } else if (pick) ep.pick = pick;
  else if (shape !== 'array') ep.shape = shape;
  orderEndpointKeys(ep);
  doc.endpoints.push(ep);
  if (derived.length) checkObservedNesting(doc, chain, miss.example ?? miss.path, notes);

  // Collect final field list for report table.
  const finalRefs = entObj.ref === undefined ? [] : Array.isArray(entObj.ref) ? entObj.ref : [entObj.ref];
  const finalFields = entityFields({
    name: entityName,
    count: entObj.total,
    refs: finalRefs,
    fields: isObj(entObj.fields) ? entObj.fields : undefined,
    pools: isObj(entObj.values) ? entObj.values : {},
    distribution: isObj(entObj.distribution) ? { field: entObj.distribution_field ?? 'status', counts: entObj.distribution } : null,
    amount: isObj(entObj.amount) ? entObj.amount : null,
  });

  return {
    changed: true,
    record: {
      method: 'GET',
      path,
      entity: entityName,
      shape,
      source,
      fields: finalFields,
      relations,
      ...(derived.length ? { derived } : {}),
      ...(seededFirst ? { seedFirst: true } : {}),
      uninferrable: epUninferrable,
    },
    endpoint: ep,
    notes,
  };
}

// Key order of an emitted endpoint: path, entity, filters, pagination, shape, pick, include, embed (the rest after).
const EP_ORDER = ['path', 'entity', 'filters', 'pagination', 'shape', 'pick', 'include', 'embed'];
function orderEndpointKeys(ep) {
  const entries = Object.entries(ep);
  for (const k of Object.keys(ep)) delete ep[k];
  for (const k of EP_ORDER) { const e = entries.find(([key]) => key === k); if (e) ep[k] = e[1]; }
  for (const [k, v] of entries) if (!EP_ORDER.includes(k)) ep[k] = v;
  return ep;
}

/** Answer `ep` as a plain array (`form: 'array'`) or as an envelope `{ <form>: [...], total, ... }`. */
export function setResponseForm(ep, form) {
  delete ep.shape;
  delete ep.pick;
  if (form !== 'array') { ep.shape = 'envelope'; ep.pick = form; }
  return orderEndpointKeys(ep);
}

const refsOf = (entry) => {
  if (!isObj(entry) || entry.ref === undefined) return [];
  return Array.isArray(entry.ref) ? [...entry.ref] : [entry.ref];
};

/** Does a `fields` map have an enum (list) or a boolean, the fields `seed_first: true` seeds? */
const hasSeedableField = (fields) => isObj(fields) && Object.values(fields).some((t) => Array.isArray(t) || t === 'boolean');

/** Does world entity `from` reach `to` through `ref:` (directly or through other entities)? */
function refReaches(world, from, to) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop();
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...refsOf(world[n]));
  }
  return false;
}

/**
 * The nesting of a path is its declaration of coherence: in `/a/:a_id/b/:b_id/c` every `c` row belongs
 * to the `a` of its `b`. Each outer parent's fk is derived through the innermost parent (`derive:
 * { a_id: { from: b, field: a_id } }`), which gets `ref: a` when it lacks it and no cycle forbids it.
 * Only the shape of the path decides; a derive already declared is kept. Returns what was emitted.
 */
function deriveFromNesting(doc, entityName, entObj, chain, uninferrable) {
  const out = [];
  const via = chain.at(-1);
  for (const outer of chain.slice(0, -1)) {
    const declared = isObj(entObj.derive) ? entObj.derive : {};
    if (Object.hasOwn(declared, outer.fk)) continue;
    const skip = (reason) => uninferrable.push(`${outer.fk} not derived from ${via.parent} (the path nests them): ${reason}`);
    if (refReaches(doc.world, via.parent, entityName)) { skip(`"${via.parent}" references "${entityName}"; its rows cannot be built first`); continue; }
    const viaEntry = ensureEntityObject(doc.world, via.parent);
    let addedRef = false;
    if (!refsOf(viaEntry).includes(outer.parent)) {
      if (refReaches(doc.world, outer.parent, via.parent)) { skip(`"${outer.parent}" references "${via.parent}"; a ref back would be a cycle`); continue; }
      const refs = [...refsOf(viaEntry), outer.parent];
      viaEntry.ref = refs.length === 1 ? refs[0] : refs;
      addedRef = true;
    }
    entObj.derive = { ...declared, [outer.fk]: { from: via.parent, field: outer.fk } };
    out.push({ field: outer.fk, from: via.parent, parent: outer.parent, ...(addedRef ? { addedRef: true } : {}) });
  }
  return out;
}

/**
 * Derivation makes the world coherent, so the observed URL only has rows if its inner id belongs to its
 * outer id in this world. When it does not, say so and name the URL that does (for `visit:`).
 */
function checkObservedNesting(doc, chain, example, notes) {
  const via = chain.at(-1);
  if (via.observed === null || chain.some((c) => c.observed === null)) return;
  let world;
  try { world = generateWorld(normalizeScenario(JSON.parse(JSON.stringify(doc)), '<harvest>')); } catch { return; }
  const row = world.entities[via.parent]?.[via.observed - 1];
  if (!row) return;
  const wrong = chain.slice(0, -1).filter((c) => row[c.fk] !== c.observed);
  if (!wrong.length) return;
  let coherent = example;
  for (const c of wrong) coherent = coherent.replace(new RegExp(`(/[^/]+/)${c.observed}(?=/)`, 'g'), (m, seg) => (pathSegFor(seg, c.parent) ? `${seg}${row[c.fk]}` : m));
  const what = wrong.map((c) => `${c.fk} ${row[c.fk]}`).join(', ');
  notes.push(`GET ${example}: in this world (seed ${doc.seed}) ${via.parent} ${via.observed} has ${what}, so this URL answers []; ${coherent} has rows`);
}

/** Is `/<seg>/` the path segment that names entity `parent` (`/widgets/` for widgets)? */
const pathSegFor = (seg, parent) => {
  const name = snake(seg.replace(/\//g, ''));
  return name === parent || toEntityName(name) === parent;
};

/** World entities that stand for TypeScript type `typeName`: by name or by singular (`Gadget` → gadgets, gadget). */
function entitiesForType(world, typeName, exclude) {
  const want = snake(typeName);
  return Object.keys(world).filter((n) => n !== exclude && (n === want || templateFor(n).singular === want));
}

/** Field list of a raw world entry, as the scenario validator will compute it. */
function rawEntityFields(name, entry) {
  const e = isObj(entry) ? entry : { total: entityTotal(entry) };
  return entityFields({
    name,
    count: entityTotal(e),
    refs: refsOf(e),
    fields: isObj(e.fields) ? e.fields : undefined,
    pools: isObj(e.values) ? e.values : {},
    distribution: isObj(e.distribution) ? { field: e.distribution_field ?? 'status', counts: e.distribution } : null,
    amount: isObj(e.amount) ? e.amount : null,
  });
}

/**
 * Turn the relations of the matched type into scenario projections (mutates `doc`, `entObj`, `ep`).
 * Every decision comes from the type graph and the scenario's own `ref:`s:
 * - `field: T[]` → child entity named `field` (the JSON key; reused as is when the world already has it
 *   with `ref:` to this one, created otherwise with T's fields, the parent FK and `ref:`) and
 *   `embed: [field]` on this endpoint;
 * - `field: T` → `include: [parent]` when a world entity for `T` exists and this entity refs it.
 * Anything that cannot be matched is returned with `emitted: false` and the reason; nothing is invented.
 */
function applyTypeRelations(doc, { entityName, entObj, entityLocked, ep, tsMatch, parsedTypes, typesLabel, uninferrable }) {
  const file = typesLabel ?? tsMatch.file;
  const out = [];
  for (const rel of tsMatch.relations) {
    const record = {
      owner: tsMatch.typeName,
      field: rel.field,
      type: rel.rawType,
      typeName: rel.typeName,
      kind: rel.many ? 'children' : 'parent',
      source: `types:${file}:${rel.line}`,
      text: `${tsMatch.typeName}.${rel.field}${rel.optional ? '?' : ''}: ${rel.rawType}`,
      emitted: false,
    };
    out.push(record);
    const skip = (reason) => { record.reason = reason; };
    if (!rel.declared) { skip(`"${rel.typeName}" is not declared in ${file}`); continue; }
    if (rel.typeName === tsMatch.typeName) { skip(`"${rel.typeName}" refers to itself; an entity cannot ref itself`); continue; }
    const candidates = entitiesForType(doc.world, rel.typeName, entityName);

    if (rel.many) {
      // The JSON key is the PROPERTY (`items`), so the embedded entity is named after it, as written;
      // the referenced type (`StoreItem`) only supplies the fields of each child row.
      const child = rel.field;
      const reuse = Object.hasOwn(doc.world, child);
      if (!ENTITY_NAME.test(child)) { skip(`"${child}" cannot be an entity name (lowercase letters, digits or "_") and embed answers the entity name`); continue; }
      if (child === entityName) { skip(`"${child}" is the parent entity itself; an entity cannot ref itself`); continue; }
      if (reuse && !refsOf(doc.world[child]).includes(entityName)) { skip(`world.${child} exists but has no ref: ${entityName}`); continue; }
      if (entityTotal(entObj) === 0) { skip(`"${entityName}" has 0 rows; a child cannot ref it`); continue; }
      if (rawEntityFields(entityName, entObj).includes(child)) { skip(`"${child}" is already a field of "${entityName}"`); continue; }
      if (refsOf(entObj).includes(child)) { skip(`"${entityName}" refs "${child}"; embedding it back would be a cycle`); continue; }
      if (!reuse) {
        const childType = fieldsOfType(parsedTypes, rel.typeName);
        const entry = { total: Math.max(2, entityTotal(entObj) * 2), ref: entityName };
        // FK to the parent: `<singular of the PARENT>_id`, never derived from the child's name or type.
        const fk = templateFor(entityName).fk;
        entry.fields = fk in childType.fields ? { ...childType.fields } : { [fk]: 'integer', ...childType.fields };
        if (Object.keys(childType.values).length) entry.values = { ...childType.values };
        if (hasSeedableField(entry.fields)) { entry.seed_first = true; record.seedFirst = true; }
        doc.world[child] = entry;
        for (const sk of childType.skipped) uninferrable.push(`world.${child}: ${sk}`);
        record.created = true;
      }
      ep.embed = [...(ep.embed ?? []), child];
      Object.assign(record, { emitted: true, entity: child, projection: 'embed' });
    } else {
      const parent = candidates.find((n) => refsOf(entObj).includes(n)) ?? candidates[0];
      if (!parent) { skip(`no world entity for "${rel.typeName}"`); continue; }
      const key = templateFor(parent).singular;
      if (key !== rel.field) { skip(`include would answer "${key}", the type reads "${rel.field}"`); continue; }
      if (entityTotal(doc.world[parent]) === 0) { skip(`"${parent}" has 0 rows`); continue; }
      if (!refsOf(entObj).includes(parent)) {
        if (entityLocked) { skip(`world.${entityName} has no ref: ${parent} (and another endpoint already projects it)`); continue; }
        if (refsOf(doc.world[parent]).includes(entityName)) { skip(`"${parent}" refs "${entityName}"; a ref back would be a cycle`); continue; }
        const refs = [...refsOf(entObj), parent];
        entObj.ref = refs.length === 1 ? refs[0] : refs;
        record.addedRef = true;
      }
      ep.include = [...(ep.include ?? []), parent];
      Object.assign(record, { emitted: true, entity: parent, projection: 'include' });
    }
  }
  return out;
}

async function defaultPageFactory(cwd) {
  const pw = (await loadPlaywright(cwd)) ?? (await loadPlaywright(PLUGIN_ROOT));
  if (!pw) {
    throw new AtrezzoError(
      'atrezzo harvest needs "playwright" or "playwright-core" installed (and Chromium).\n' +
      '  Install playwright-core (uses system Chromium; ATREZZO_CHROME=/path for another binary) or playwright.',
      { exitCode: EXIT.UNVERIFIABLE },
    );
  }
  const chromium = pw.mod.chromium ?? pw.mod.default?.chromium;
  const executablePath = chromeExecutable(pw.name);
  let browser;
  try {
    browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  } catch (e) {
    const hint = executablePath
      ? `does ${executablePath} exist and is it executable? (override with ATREZZO_CHROME=/path)`
      : 'Set ATREZZO_CHROME=/path/to/chromium';
    throw new AtrezzoError(`${pw.name} is installed but cannot launch Chromium: ${e.message.split('\n')[0]}\n  ${hint}`, { exitCode: EXIT.UNVERIFIABLE });
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  return { page, context, close: () => browser.close() };
}

function createPageWaiter(page, maxMs = 10_000, quietMs = 350) {
  const hasOn = typeof page.on === 'function';
  const hasOff = typeof page.off === 'function' || typeof page.removeListener === 'function';
  if (!hasOn || !hasOff) {
    return {
      wait: () => page.waitForLoadState?.('networkidle', { timeout: maxMs })?.catch?.(() => {}) ?? Promise.resolve(),
    };
  }
  let inflight = 0;
  let armed = false;
  let quietTimer = null;
  let maxTimer = null;
  let done = false;
  let resolveWait = null;
  const off = page.off?.bind(page) ?? page.removeListener?.bind(page);
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(quietTimer);
    clearTimeout(maxTimer);
    off?.('request', onReq);
    off?.('response', onDone);
    off?.('requestfailed', onDone);
    resolveWait?.();
  };
  const bump = () => {
    clearTimeout(quietTimer);
    if (armed && inflight === 0) quietTimer = setTimeout(finish, quietMs);
  };
  const onReq = (req) => {
    try {
      const u = new URL(req.url());
      if (u.pathname.startsWith('/__atrezzo/') || ASSET.test(u.pathname)) return;
    } catch { return; }
    inflight++;
    clearTimeout(quietTimer);
  };
  const onDone = (arg) => {
    const req = typeof arg.request === 'function' ? arg.request() : arg;
    try {
      const u = new URL(req.url());
      if (u.pathname.startsWith('/__atrezzo/') || ASSET.test(u.pathname)) return;
    } catch { return; }
    inflight = Math.max(0, inflight - 1);
    bump();
  };
  page.on('request', onReq);
  page.on('response', onDone);
  page.on('requestfailed', onDone);
  return {
    wait() {
      if (done) return Promise.resolve();
      return new Promise((ok) => {
        resolveWait = ok;
        armed = true;
        maxTimer = setTimeout(finish, maxMs);
        bump();
        page.waitForLoadState?.('networkidle', { timeout: maxMs })?.then(finish, () => {});
      });
    },
  };
}

/** Does concrete `pathname` fit endpoint `pattern` (`:name` = one segment)? */
function pathMatches(pattern, pathname) {
  const body = pattern.replace(/\/+$/, '').split('/')
    .map((s) => (s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${body}/?$`).test(pathname);
}

/**
 * The selectors present in the page (`tag#id.class[data-testid]`, one per distinct element), so a round
 * can tell whether something new appeared. `null` when the page cannot be read (no `evaluate`, or it
 * failed): then a round without new requests proves nothing, since the view may simply be complete.
 */
async function domSignature(page) {
  if (typeof page?.evaluate !== 'function') return null;
  try {
    const sig = await page.evaluate(() => {
      const out = new Set();
      for (const el of document.querySelectorAll('body *')) {
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
        let s = el.tagName.toLowerCase();
        if (el.id) s += `#${el.id}`;
        for (const c of el.classList) s += `.${c}`;
        const t = el.getAttribute('data-testid');
        if (t) s += `[data-testid="${t}"]`;
        out.add(s);
      }
      return [...out];
    });
    return Array.isArray(sig) ? sig.map(String) : null;
  } catch {
    return null;
  }
}

// Response forms tried, in order, for a new list endpoint: the plain array first, then the envelopes.
const RESPONSE_FORMS = ['array', ...ENVELOPE_KEYS];

function settleTrial(t, result) {
  t.status = result;
  if (result === 'kept') return; // the array worked, or nothing asked for it: nothing to report
  const attempts = RESPONSE_FORMS.slice(0, t.idx + 1);
  if (result === 'advanced') {
    const form = RESPONSE_FORMS[t.idx];
    Object.assign(t.record, { shape: 'envelope', pick: form, responseShape: { result, attempts, form } });
  } else {
    setResponseForm(t.ep, 'array');
    t.record.responseShape = { result, attempts, form: 'array' };
  }
}

/**
 * After a round, decide the endpoints on trial. Returns true when the scenario changed and the page must
 * be loaded again with the next form.
 * - not requested this round: nothing to judge (a form on trial goes back to the array);
 * - the view advanced: every requested trial keeps its current form (an envelope that did it is reported);
 * - it did not: the first requested trial moves to its next form; one that ran out of forms goes back to
 *   the array (reported) and the next trial starts. One change per round, so a win names its form.
 */
function judgeShapeTrials(trials, { advanced, requests }) {
  const judged = [];
  for (const t of trials.filter((x) => x.status === 'pending')) {
    if (requests.some((o) => o.method === 'GET' && pathMatches(t.ep.path, o.pathname))) judged.push(t);
    else settleTrial(t, t.idx > 0 ? 'unsettled' : 'kept');
  }
  if (advanced) {
    for (const t of judged) settleTrial(t, t.idx > 0 ? 'advanced' : 'kept');
    return false;
  }
  for (const t of judged) {
    if (t.idx + 1 < RESPONSE_FORMS.length) {
      t.idx++;
      setResponseForm(t.ep, RESPONSE_FORMS[t.idx]);
      return true;
    }
    settleTrial(t, 'none');
  }
  return false;
}

function readRawScenario(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    throw new AtrezzoError(`Cannot read scenario ${file}: ${e.code === 'ENOENT' ? 'file does not exist' : e.message}`);
  }
  const isJson = /\.json$/i.test(file);
  if (isJson) {
    try { return { doc: JSON.parse(text), isJson }; } catch (e) { throw new AtrezzoError(`${file}: invalid JSON: ${e.message}`); }
  }
  return { doc: parseYaml(text, file), isJson };
}

/**
 * Run the harvest loop against `<url>` starting from `scenarioFile`.
 */
export async function runHarvest({
  url,
  scenarioFile,
  until = null,
  rounds = 5,
  typesFile = null,
  write = false,
  port = 0,
  host = '127.0.0.1',
  staticDir = null,
  storageFile = null,
  storage = null,
  cwd = process.cwd(),
  pageFactory = null,
}) {
  if (!url || !/^(https?:\/\/|\/)/.test(url)) {
    throw new AtrezzoError(`Invalid URL "${url}": pass a path starting with "/" or an http(s):// URL`);
  }
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new AtrezzoError(`--rounds must be an integer >= 1 (got "${rounds}")`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new AtrezzoError(`--port must be an integer between 0 and 65535 (got "${port}")`);
  }
  const absScenario = resolve(cwd, scenarioFile);
  // Validate the starting scenario strictly first.
  const initialNormalized = loadScenario(absScenario);
  const { doc: rawDoc, isJson } = readRawScenario(absScenario);
  const workingDoc = JSON.parse(JSON.stringify(rawDoc));
  if (!isObj(workingDoc.world)) workingDoc.world = {};
  if (!Array.isArray(workingDoc.endpoints)) workingDoc.endpoints = [];

  let parsedTypes = null;
  let typesLabel = null;
  if (typesFile) {
    const absTypes = resolve(cwd, typesFile);
    if (!existsSync(absTypes)) throw new AtrezzoError(`--types file does not exist: ${typesFile}`);
    const rel = relative(cwd, absTypes);
    typesLabel = rel && !rel.startsWith('..') ? rel : basename(absTypes);
    parsedTypes = parseTsTypes(readFileSync(absTypes, 'utf8'), typesLabel);
  }

  let parsedStorage = null;
  if (storageFile !== null && storageFile !== undefined) {
    if (!storageFile) throw new AtrezzoError('--storage: file path cannot be empty');
    const absStorage = resolve(cwd, storageFile);
    let text;
    try { text = readFileSync(absStorage, 'utf8'); } catch (e) {
      throw new AtrezzoError(`Cannot read storage ${storageFile}: ${e.code === 'ENOENT' ? 'file does not exist' : e.message}`);
    }
    parsedStorage = parseStorageJson(text, storageFile);
  } else if (storage !== null && storage !== undefined) {
    parsedStorage = validateStorage(storage, 'storage');
  }
  const seedStorage = parsedStorage && hasStorage(parsedStorage);

  let roundRequests = null; // what the mock itself served this round (independent of browser events)
  const tmpDir = mkdtempSync(join(tmpdir(), 'atrezzo-harvest-'));
  const tmpScenarioName = `${initialNormalized.name}.yaml`;
  const tmpScenarioPath = join(tmpDir, tmpScenarioName);
  const missesPath = join(tmpDir, 'misses.json');
  writeFileSync(tmpScenarioPath, emitYaml(workingDoc));

  const mock = createMockServer({
    scenariosDir: tmpDir,
    scenario: initialNormalized.name,
    staticDir: staticDir ? resolve(cwd, staticDir) : null,
    generatedDir: null,
    missesFile: missesPath,
    onRequest: (r) => { if (roundRequests && !ASSET.test(r.pathname)) roundRequests.push(r); },
  });

  let pw = null;
  const discovered = [];
  const shapeTrials = [];
  const seenRequests = new Set();
  const seenSelectors = new Set();
  const mutations = new Map();
  const globalNotes = [];
  let stoppedReason = 'max-rounds';
  let roundsRun = 0;
  let targetUrl = url;

  try {
    const addr = await mock.listen(port, host);
    const mockBaseUrl = `http://${addr.address}:${addr.port}`;
    targetUrl = url.startsWith('/') ? new URL(url, mockBaseUrl).toString() : url;
    pw = await (pageFactory ? pageFactory() : defaultPageFactory(cwd));
    if (seedStorage) {
      const script = storageScript(new URL(targetUrl).origin, parsedStorage);
      if (pw.context?.addInitScript) await pw.context.addInitScript(script);
      else if (pw.page?.addInitScript) await pw.page.addInitScript(script);
      else throw new AtrezzoError('the playwright context has no addInitScript: cannot seed storage', { exitCode: EXIT.UNVERIFIABLE });
    }

    let roundObs = null;
    pw.page.on?.('response', (res) => {
      if (!roundObs) return;
      try {
        const req = res.request();
        const u = new URL(res.url());
        if (u.pathname.startsWith('/__atrezzo/') || ASSET.test(u.pathname)) return;
        const method = req.method();
        const status = res.status();
        const key = missKey(method, u.pathname);
        const afterFailure = roundObs.sawFailure;
        const repeatedAfterFailure = roundObs.sawFailure && roundObs.failedKeys.has(key);
        if (status >= 400) {
          roundObs.sawFailure = true;
          roundObs.failedKeys.add(key);
        }
        roundObs.observed.push({ method, url: res.url(), pathname: u.pathname, searchParams: u.searchParams, status, afterFailure, repeatedAfterFailure });
      } catch { /* ignore non-http URLs (data:, blob:) */ }
    });
    pw.page.on?.('requestfailed', (req) => {
      if (!roundObs) return;
      try {
        const u = new URL(req.url());
        const method = req.method();
        const key = missKey(method, u.pathname);
        const afterFailure = roundObs.sawFailure;
        roundObs.sawFailure = true;
        roundObs.failedKeys.add(key);
        roundObs.observed.push({ method, url: req.url(), pathname: u.pathname, searchParams: u.searchParams, status: 0, afterFailure, repeatedAfterFailure: afterFailure, failed: true });
      } catch { /* ignore */ }
    });

    for (let round = 1; round <= rounds; round++) {
      roundsRun = round;
      roundObs = { observed: [], sawFailure: false, failedKeys: new Set() };
      roundRequests = [];
      let untilHit = false;
      const waiter = createPageWaiter(pw.page);
      await pw.page.goto(targetUrl);
      await waiter.wait();
      if (until) {
        await pw.page.locator(until).first().waitFor({ state: 'attached', timeout: 300 }).catch(() => {});
        untilHit = (await pw.page.locator(until).count()) > 0;
      }
      const { observed } = roundObs;
      roundObs = null;
      const requests = [...roundRequests, ...observed.map(({ method, pathname }) => ({ method, pathname }))];
      roundRequests = null;

      // Did the view advance this round? A request (method + path) or a selector never seen before.
      // Requests to an endpoint whose response form is on trial do not count: they are the question.
      const selectors = await domSignature(pw.page);
      const onTrial = shapeTrials.filter((t) => t.status === 'pending');
      const newRequest = requests.some((o) => !seenRequests.has(missKey(o.method, o.pathname)) &&
        !onTrial.some((t) => pathMatches(t.ep.path, o.pathname)));
      // An unreadable page counts as advanced: without its selectors, "stuck" and "done" look the same,
      // and the plain array is kept rather than replaced on a guess.
      const newSelector = selectors === null || selectors.some((s) => !seenSelectors.has(s));
      for (const o of requests) seenRequests.add(missKey(o.method, o.pathname));
      for (const s of selectors ?? []) seenSelectors.add(s);
      const shapeChanged = judgeShapeTrials(shapeTrials, { advanced: untilHit || newRequest || newSelector, requests });
      if (untilHit) {
        stoppedReason = 'until';
        break;
      }

      // Collect authoritative unresolved gaps from the mock's miss log, plus requests
      // observed again after a failure.
      const unresolved = mock.misses.list().filter((m) => !m.resolved);
      for (const m of unresolved) {
        if (isMutation(m.method)) {
          const mk = `${m.method} ${m.path}`;
          mutations.set(mk, { method: m.method, path: m.path, times: m.times });
        }
      }

      const readGaps = unresolved
        .filter((m) => !isMutation(m.method))
        .sort((a, b) => a.path.localeCompare(b.path));

      // Report any failed non-mock requests (e.g. network errors or external 404s) and retries after failure.
      const mockOrigin = new URL(mockBaseUrl).origin;
      for (const obs of observed) {
        if (obs.repeatedAfterFailure) {
          const mk = missKey(obs.method, obs.pathname);
          if (!unresolved.some((m) => missKey(m.method, m.path) === mk) && !isMutation(obs.method)) {
            globalNotes.push(`${obs.method} ${obs.pathname}: retried after a failed request (status ${obs.status})`);
          }
        }
        if ((obs.failed || obs.status >= 400) && new URL(obs.url).origin !== mockOrigin) {
          globalNotes.push(`${obs.method} ${obs.url}: external failure (status ${obs.status || 'network error'})`);
        }
      }

      let addedThisRound = false;
      for (const gap of readGaps) {
        if (/\.(?:png|jpe?g|gif|svg|ico|css|js|woff2?|map)$/i.test(gap.path) ||
            /(^|\/)(?:ws|avatar|socket|events)(?:\/|$)/i.test(gap.path)) {
          const n = `skipped ${gap.method} ${gap.path}: not a JSON API (asset, websocket or binary)`;
          if (!globalNotes.includes(n)) globalNotes.push(n);
          continue;
        }
        const key = missKey(gap.method, gap.path);
        const observedForGap = observed.filter((o) => missKey(o.method, o.pathname) === key);
        const merged = mergeGapIntoScenario(workingDoc, gap, { observedForGap, parsedTypes, typesLabel });
        for (const n of merged.notes) if (!globalNotes.includes(n)) globalNotes.push(n);
        if (merged.changed) {
          addedThisRound = true;
          if (merged.record) {
            const record = { ...merged.record, round };
            discovered.push(record);
            // A new list endpoint answered as a plain array goes on trial: if the view does not advance
            // with it, the next rounds try the common envelopes before giving up.
            if (merged.endpoint && record.shape === 'array' && !merged.endpoint.pick) {
              shapeTrials.push({ ep: merged.endpoint, record, idx: 0, status: 'pending' });
            }
          }
        }
      }

      if (!addedThisRound && !shapeChanged) {
        stoppedReason = 'no-new-gaps';
        break;
      }

      // Validate normalized scenario, write to temp copy, and reload the mock.
      normalizeScenario(workingDoc, tmpScenarioPath);
      writeFileSync(tmpScenarioPath, emitYaml(workingDoc));

      const reloadRes = await fetch(`${mockBaseUrl}/__atrezzo/reload`, { method: 'POST' });
      const reloadBody = await reloadRes.text().catch(() => '');
      if (reloadRes.status !== 200) {
        let errMsg = reloadRes.status;
        try { errMsg = JSON.parse(reloadBody).error ?? reloadRes.status; } catch { /* ignore */ }
        throw new AtrezzoError(`Mock reload failed after round ${round}: ${errMsg}`);
      }
    }
  } finally {
    if (pw) await pw.close().catch(() => {});
    await mock.close().catch(() => {});
  }

  // A form still on trial when the rounds run out was never seen to work: back to the plain array.
  for (const t of shapeTrials) {
    if (t.status === 'pending' && t.idx > 0) settleTrial(t, 'unsettled');
  }

  const outputText = isJson ? `${JSON.stringify(workingDoc, null, 2)}\n` : emitYaml(workingDoc);
  let written = null;
  let tempFile = null;
  if (write) {
    mkdirSync(dirname(absScenario), { recursive: true });
    writeFileSync(absScenario, outputText);
    written = scenarioFile;
    rmSync(tmpDir, { recursive: true, force: true });
  } else {
    writeFileSync(tmpScenarioPath, outputText);
    rmSync(missesPath, { force: true });
    tempFile = tmpScenarioPath;
  }

  const storageSummary = seedStorage ? storageKeys(parsedStorage) : undefined;
  return {
    scenarioName: workingDoc.name,
    targetUrl,
    roundsRun,
    maxRounds: rounds,
    stoppedReason,
    discovered,
    mutations: [...mutations.values()],
    uninferrable: [...new Set(globalNotes)],
    ...(storageSummary ? { storage: storageSummary } : {}),
    scenario: workingDoc,
    yaml: outputText,
    written,
    tempFile,
  };
}

/** Human-readable report for `atrezzo harvest`. */
export function formatHarvestReport(res) {
  const lines = [
    `atrezzo harvest · ${res.targetUrl} · scenario "${res.scenarioName}" (${res.roundsRun} ${res.roundsRun === 1 ? 'round' : 'rounds'} · stopped: ${res.stoppedReason})`,
  ];
  if (res.storage) lines.push(`Storage (keys): ${formatStorage(res.storage)}`);

  if (res.discovered.length) {
    const cols = ['endpoint', 'entity', 'shape', 'source', 'fields'];
    const rows = res.discovered.map((d) => [
      `${d.method} ${d.path}`,
      d.entity,
      d.shape,
      d.source,
      d.fields.join(', '),
    ]);
    const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
    const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
    lines.push('', fmt(cols), fmt(widths.map((w) => '-'.repeat(w))), ...rows.map(fmt));
  } else {
    lines.push('', 'No new endpoints inferred.');
  }

  const emitted = res.discovered.flatMap((d) => (d.relations ?? []).filter((r) => r.emitted).map((r) => [d, r]));
  if (emitted.length) {
    lines.push('', 'Relations (from --types):');
    for (const [d, r] of emitted) {
      // Both names on one line: the property (the JSON key, = entity) and the type that gave its fields.
      const how = r.created ? `, new entity ${r.entity}, ref: ${d.entity}` : r.addedRef ? `, ref: ${r.entity} added to ${d.entity}` : '';
      lines.push(`  - ${d.method} ${d.path}: ${r.owner}.${r.field} → ${r.projection} [${r.entity}] (type ${r.typeName}${how}, ${r.source})`);
    }
  }

  const derivedLines = res.discovered.flatMap((d) => (d.derived ?? []).map((x) =>
    `  - ${d.method} ${d.path}: ${d.entity}.${x.field} derive: { from: ${x.from}, field: ${x.field} } (every ${templateFor(d.entity).singular} belongs to the ${templateFor(x.parent).singular} of its ${templateFor(x.from).singular}${x.addedRef ? `; ref: ${x.parent} added to ${x.from}` : ''})`));
  if (derivedLines.length) lines.push('', 'Coherence (from the path nesting):', ...derivedLines);

  const seeded = [...new Set(res.discovered.flatMap((d) => [
    ...(d.seedFirst ? [d.entity] : []),
    ...(d.relations ?? []).filter((r) => r.seedFirst).map((r) => r.entity),
  ]))];
  if (seeded.length) lines.push('', `Seeded by first value (seed_first: true; enums and booleans from --types): ${seeded.join(', ')}`);

  const forms = (rs) => rs.attempts.join(' → ');
  const won = res.discovered.filter((d) => d.responseShape?.result === 'advanced');
  if (won.length) {
    lines.push('', 'Response shape (the page did not advance with a plain array):');
    for (const d of won) {
      const rs = d.responseShape;
      lines.push(`  - ${d.method} ${d.path}: shape: envelope, pick: ${rs.form} (attempt ${rs.attempts.length} of ${RESPONSE_FORMS.length}: ${forms(rs)}; the first form that made the page advance)`);
    }
  }

  const uninferrable = [];
  for (const d of res.discovered) {
    const rs = d.responseShape;
    if (rs?.result === 'none') uninferrable.push(`${d.method} ${d.path}: the page did not advance with any response form (${forms(rs)}); left as array`);
    else if (rs?.result === 'unsettled') uninferrable.push(`${d.method} ${d.path}: response form not settled (tried ${forms(rs)}, none seen to make the page advance); left as array`);
    for (const r of d.relations ?? []) {
      if (!r.emitted) uninferrable.push(`${d.method} ${d.path}: ${r.text} → relation not mocked (missing entity + ref): ${r.reason} (${r.source})`);
    }
    for (const u of d.uninferrable ?? []) uninferrable.push(`${d.method} ${d.path}: ${u}`);
  }
  for (const n of res.uninferrable ?? []) uninferrable.push(n);
  for (const m of res.mutations ?? []) {
    uninferrable.push(`${m.method} ${m.path}: write not mocked (${m.times}×; atrezzo only projects reads)`);
  }

  if (uninferrable.length) {
    lines.push('', 'Could not infer / not mocked:');
    for (const u of uninferrable) lines.push(`  - ${u}`);
  }

  if (res.written) {
    lines.push('', `Updated: ${res.written}`, `Next step: atrezzo world ${res.written}`);
  } else {
    lines.push('', `Temporary copy: ${res.tempFile} (pass --write to update the scenario)`, '', res.yaml.trimEnd());
  }

  return lines.join('\n');
}
