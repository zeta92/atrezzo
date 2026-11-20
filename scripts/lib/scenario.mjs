// Strict parsing/validation of scenario and flow files.
// Every error names the field and the reason.
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseYaml, YamlError } from './yaml.mjs';
import { AtrezzoError } from './errors.mjs';
import { templateFor, entityFields, firstValueList, valueListFields, RENAMED_TEMPLATES } from './world.mjs';
import { parseHeaders } from './headers.mjs';
import { parseStorage } from './storage.mjs';
import { FORBIDDEN_PATH_SEGMENTS, normalizeFixtureName, resolvePassthroughs } from './passthrough.mjs';

export const DEFAULT_NOW = '2025-01-15T09:00:00.000Z';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const isScalar = (v) => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'list' : isObj(v) ? 'map' : typeof v === 'number' ? 'number' : typeof v === 'string' ? 'string' : typeof v);

class Issues {
  constructor() { this.list = []; }
  add(field, reason) { this.list.push(`field "${field}": ${reason}`); }
  unknownKeys(obj, allowed, field) {
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) this.add(field ? `${field}.${k}` : k, `unknown field (allowed: ${allowed.join(', ')})`);
    }
  }
}

function readYaml(file, what) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    throw new AtrezzoError(`Cannot read ${what} ${file}: ${e.code === 'ENOENT' ? 'file does not exist' : e.message}`);
  }
  if (/\.json$/i.test(file)) {
    try { return JSON.parse(text); } catch (e) { throw new AtrezzoError(`${file}: invalid JSON: ${e.message}`); }
  }
  try { return parseYaml(text, file); } catch (e) {
    if (e instanceof YamlError) throw new AtrezzoError(e.message);
    throw e;
  }
}

// ---------- expectations (shared by scenario and flow) ----------

function normalizeExpect(item, field, issues) {
  if (!isObj(item)) { issues.add(field, `must be a map with "selector" and "count" or "min"/"max"; got ${typeName(item)}`); return null; }
  issues.unknownKeys(item, ['selector', 'count', 'min', 'max', 'screen', 'data', 'label'], field);
  const out = {};
  if (typeof item.selector !== 'string' || item.selector.trim() === '') issues.add(`${field}.selector`, 'missing; every assertion needs a non-empty CSS selector');
  else out.selector = item.selector;
  for (const k of ['count', 'min', 'max']) {
    if (item[k] === undefined) continue;
    if (!isInt(item[k]) || item[k] < 0) issues.add(`${field}.${k}`, `must be an integer >= 0; got ${JSON.stringify(item[k])}`);
    else out[k] = item[k];
  }
  if (item.count !== undefined && (item.min !== undefined || item.max !== undefined)) issues.add(field, 'use an exact "count" or "min"/"max", not both');
  if (item.count === undefined && item.min === undefined && item.max === undefined) issues.add(field, 'missing "count" or "min"/"max"');
  if (isInt(out.min) && isInt(out.max) && out.min > out.max) issues.add(field, `min (${out.min}) is greater than max (${out.max})`);
  if (item.screen !== undefined) {
    if (typeof item.screen !== 'string') issues.add(`${field}.screen`, 'must be a string');
    else out.screen = item.screen;
  }
  if (item.label !== undefined) out.label = String(item.label);
  if (item.data !== undefined) {
    if (!isObj(item.data)) issues.add(`${field}.data`, 'must be a map { request, where, pick }');
    else {
      issues.unknownKeys(item.data, ['request', 'where', 'pick'], `${field}.data`);
      const d = {};
      if (item.data.request !== undefined) d.request = String(item.data.request);
      if (item.data.where !== undefined) {
        if (!isObj(item.data.where)) issues.add(`${field}.data.where`, 'must be a map field: value');
        else d.where = item.data.where;
      }
      if (item.data.pick !== undefined) d.pick = String(item.data.pick);
      out.data = d;
    }
  }
  return out;
}

// ---------- world ----------

const ENTITY_KEYS = ['total', 'distribution', 'distribution_field', 'amount', 'ref', 'nulls', 'values', 'days', 'fields', 'derive', 'seed_first', 'values_order', 'counts'];

/** `values_order`: how a field with a list of values draws it (random: the PRNG; cycle: row i takes values[i % n]). */
export const VALUES_ORDERS = ['random', 'cycle'];

/** Entities `name` reaches through `ref:` (transitively), given name -> refs. */
function reachable(refsOf, name) {
  const seen = new Set();
  const stack = [...(refsOf[name] ?? [])];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(refsOf[n] ?? []));
  }
  return seen;
}

/**
 * `derive: { <fk>: { from: <ref>, field: <field of that ref> } }`: the fk is copied from the row its
 * `from` fk points at, so two references of one row cannot contradict each other. `field` defaults to
 * the derived fk's own name (a reference to the same entity has the same name everywhere).
 */
function normalizeDerive(spec, raw, f, byName, issues) {
  if (!isObj(raw) || !Object.keys(raw).length) { issues.add(f, 'must be a non-empty map <foreign key>: { from: <entity in ref>, field: <its field> }'); return; }
  const fkTarget = Object.fromEntries(spec.refs.map((r) => [templateFor(r).fk, r]));
  const fks = Object.keys(fkTarget);
  const refsOf = Object.fromEntries(Object.values(byName).map((s) => [s.name, s.refs]));
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    const ff = `${f}.${key}`;
    if (!Object.hasOwn(fkTarget, key)) {
      issues.add(ff, `"${key}" is not a foreign key of "${spec.name}" (its foreign keys: ${fks.join(', ') || 'none; declare ref: first'}); derive copies a reference from another reference of the same row`);
      continue;
    }
    const target = fkTarget[key];
    let from; let field;
    if (typeof val === 'string') from = val;
    else if (isObj(val)) {
      issues.unknownKeys(val, ['from', 'field'], ff);
      from = val.from;
      field = val.field;
    } else { issues.add(ff, `must be a map { from: <entity in ref>, field: <its field> } or the name of the entity; got ${typeName(val)}`); continue; }
    if (typeof from !== 'string' || !from) { issues.add(`${ff}.from`, `required; the entity in ref: whose row "${key}" is copied from (ref: ${spec.refs.join(', ') || 'none'})`); continue; }
    if (!spec.refs.includes(from)) { issues.add(`${ff}.from`, `"${from}" is not in the ref: of "${spec.name}" (ref: ${spec.refs.join(', ') || 'none'}); derive reads the row another reference of the same row points at`); continue; }
    if (from === target) { issues.add(`${ff}.from`, `"${key}" already points at "${from}"; derive it from another entity of ref: (one that has its own "${key}")`); continue; }
    if (field === undefined) field = key;
    if (typeof field !== 'string' || !field) { issues.add(`${ff}.field`, 'must be a field name'); continue; }
    const fromSpec = byName[from];
    const fromFields = entityFields(fromSpec);
    if (!fromFields.includes(field)) { issues.add(`${ff}.field`, `field "${field}" does not exist in "${from}" (fields: ${fromFields.join(', ')})`); continue; }
    if (!fromSpec.refs.includes(target) || templateFor(target).fk !== field) {
      issues.add(`${ff}.field`, `"${from}.${field}" is not a reference to "${target}", so the copy would not be a "${target}" id; add ref: ${target} to world.${from} and copy its "${templateFor(target).fk}"`);
      continue;
    }
    if (reachable(refsOf, from).has(spec.name)) { issues.add(`${ff}.from`, `"${from}" references "${spec.name}" (directly or through other entities); its rows cannot be built first`); continue; }
    out[key] = { from, field };
  }
  // The fk a derivation reads is drawn, never derived itself: one hop, no order between derivations.
  for (const [key, d] of Object.entries(out)) {
    const via = templateFor(d.from).fk;
    if (Object.hasOwn(out, via)) { issues.add(`${f}.${key}.from`, `"${via}" (the reference to "${d.from}") is itself derived; derive from a reference that is drawn`); delete out[key]; }
  }
  if (Object.keys(out).length) spec.derive = out;
}

/** `seed_first: true | [field, …]`: every row takes the first value of those fields (see firstValueList). */
function normalizeSeedFirst(spec, raw, f, issues) {
  const fks = spec.refs.map((r) => templateFor(r).fk);
  const eligible = entityFields(spec).filter((k) => k !== 'id' && !fks.includes(k) && k !== spec.distribution?.field && firstValueList(spec, k));
  if (raw === false) return;
  if (raw === true) {
    if (!eligible.length) issues.add(f, `"${spec.name}" has no enum, boolean or values: field to seed (declare one in fields:, or remove seed_first)`);
    else spec.seedFirst = eligible;
    return;
  }
  if (!Array.isArray(raw) || !raw.length) { issues.add(f, `must be true, false or a non-empty list of fields (enum, boolean or with values:); got ${JSON.stringify(raw)}`); return; }
  const list = [];
  raw.forEach((k, i) => {
    const ff = `${f}[${i}]`;
    if (typeof k !== 'string') issues.add(ff, 'must be a field name');
    else if (!entityFields(spec).includes(k)) issues.add(ff, `field "${k}" does not exist in "${spec.name}" (fields: ${entityFields(spec).join(', ')})`);
    else if (fks.includes(k)) issues.add(ff, `"${k}" is a foreign key; its values come from ref: (use derive to tie it to another reference)`);
    else if (k === spec.distribution?.field) issues.add(ff, `"${k}" has a distribution; its exact counts decide every row`);
    else if (!firstValueList(spec, k)) issues.add(ff, `"${k}" is not an enum, a boolean or a field with values: (seedable: ${eligible.join(', ') || 'none'})`);
    else if (list.includes(k)) issues.add(ff, `"${k}" is listed twice`);
    else list.push(k);
  });
  if (list.length) spec.seedFirst = list;
}

/**
 * `values_order: cycle | random`. Only `cycle` changes the normalized spec (so a scenario that omits the
 * key, or writes the default, keeps its hash); either value needs a field with a list of values.
 */
function normalizeValuesOrder(spec, raw, f, issues) {
  if (!VALUES_ORDERS.includes(raw)) { issues.add(f, `must be ${VALUES_ORDERS.map((v) => `"${v}"`).join(' or ')}; got ${JSON.stringify(raw)}`); return; }
  if (!valueListFields(spec).length) {
    issues.add(f, `"${spec.name}" has no field with a list of values (values: or an enum in fields:); values_order decides how those lists are drawn`);
    return;
  }
  if (raw === 'cycle') spec.valuesOrder = 'cycle';
}

/** Types accepted in `fields` (a list of values = enum). */
export const FIELD_TYPES = ['string', 'integer', 'number', 'boolean', 'date', 'email', 'uuid', 'url'];

function parseScalarOrList(val, ff, issues) {
  if (Array.isArray(val)) {
    if (!val.length || val.some((v) => !isScalar(v))) {
      issues.add(ff, 'must be a scalar value or a non-empty list of scalar values');
      return undefined;
    }
    return val;
  }
  if (!isScalar(val)) {
    issues.add(ff, 'must be a scalar value or a non-empty list of scalar values');
    return undefined;
  }
  return val;
}

function parseFieldType(val, ff, issues) {
  if (Array.isArray(val)) {
    if (!val.length || val.some((v) => !isScalar(v))) {
      issues.add(ff, 'must be a non-empty list of scalar values (enum)');
      return null;
    }
    return val;
  }
  if (!FIELD_TYPES.includes(val)) {
    issues.add(ff, `unknown type ${JSON.stringify(val)} (types: ${FIELD_TYPES.join(', ')} or a list of values)`);
    return null;
  }
  return val;
}

function isScalarCompatibleWithType(v, type) {
  switch (type) {
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'string':
    case 'date':
    case 'email':
    case 'uuid':
    case 'url': return typeof v === 'string';
    default: return false;
  }
}

function isValueCompatibleWithDefault(v, def) {
  if (v === null) return true;
  if (typeof def === 'string') return isScalarCompatibleWithType(v, def);
  const nonNull = def.filter((x) => x !== null);
  if (!nonNull.length) return true;
  const hasInt = nonNull.some((x) => Number.isInteger(x));
  const hasFloat = nonNull.some((x) => typeof x === 'number' && !Number.isInteger(x));
  const hasStr = nonNull.some((x) => typeof x === 'string');
  const hasBool = nonNull.some((x) => typeof x === 'boolean');
  if (Number.isInteger(v)) return hasInt || hasFloat;
  if (typeof v === 'number') return hasFloat;
  if (typeof v === 'string') return hasStr;
  if (typeof v === 'boolean') return hasBool;
  return false;
}

function fkTargetEntity(spec, condField) {
  return spec.refs.find((r) => templateFor(r).fk === condField) ?? null;
}

function canFieldBeNull(field, spec, byName) {
  if (field === 'id') return false;
  if ((spec.nulls?.[field] ?? 0) > 0) return true;
  const refEntity = fkTargetEntity(spec, field);
  if (refEntity) {
    const derived = spec.derive?.[field];
    return Boolean(derived && (byName[derived.from]?.nulls?.[derived.field] ?? 0) > 0);
  }
  if (spec.distribution && field === spec.distribution.field) return false;
  if (spec.pools && Object.hasOwn(spec.pools, field)) return spec.pools[field].includes(null);
  const entry = spec.fields?.[field];
  if (isObj(entry)) return (Array.isArray(entry.default) && entry.default.includes(null)) || entry.value.includes(null);
  if (Array.isArray(entry)) return entry.includes(null);
  return false;
}

const STRING_LIKE_TYPES = new Set(['string', 'date', 'email', 'uuid', 'url']);

function typesFromEntry(entry) {
  if (typeof entry === 'string') return [entry];
  const types = new Set();
  for (const x of entry) {
    if (x === null) continue;
    if (Number.isInteger(x)) types.add('integer');
    else if (typeof x === 'number' && Number.isFinite(x)) types.add('number');
    else if (typeof x === 'string') types.add('string');
    else if (typeof x === 'boolean') types.add('boolean');
  }
  return [...types];
}

function fieldValueTypes(field, spec) {
  if (field === 'id' || fkTargetEntity(spec, field)) return ['integer'];
  if (spec.distribution && field === spec.distribution.field) return ['string'];
  const amountField = templateFor(spec.name).amountField || 'amount';
  if (spec.amount && field === 'currency') return ['string'];
  if (spec.amount && field === amountField) return ['number'];
  if (spec.pools && Object.hasOwn(spec.pools, field)) return typesFromEntry(spec.pools[field]);
  if (spec.fields && Object.hasOwn(spec.fields, field)) {
    const entry = spec.fields[field];
    if (isObj(entry)) return [...new Set([...typesFromEntry(entry.default), ...typesFromEntry(entry.value)])];
    return typesFromEntry(entry);
  }
  if (spec.name === 'products' && field === 'stock') return ['integer'];
  if ((spec.name === 'users' || spec.name === 'customers') && field === 'email') return ['email'];
  if (spec.name !== 'products' && field === 'created_at') return ['date'];
  return ['string'];
}

function isSingleTypeCompatible(srcType, dstType) {
  if (srcType === dstType) return true;
  if (srcType === 'integer' && dstType === 'number') return true;
  if (STRING_LIKE_TYPES.has(srcType) && STRING_LIKE_TYPES.has(dstType)) {
    return srcType === 'string' || dstType === 'string';
  }
  return false;
}

function areFieldsCompatible(srcField, srcSpec, dstField, dstSpec) {
  const srcTypes = fieldValueTypes(srcField, srcSpec);
  const dstTypes = fieldValueTypes(dstField, dstSpec);
  return srcTypes.length > 0 && dstTypes.length > 0
    && srcTypes.every((st) => dstTypes.some((dt) => isSingleTypeCompatible(st, dt)));
}

function isWhereValueCompatible(v, field, spec, byName) {
  if (v === null) return canFieldBeNull(field, spec, byName);
  if (field === 'id' || fkTargetEntity(spec, field)) return Number.isInteger(v);
  if (spec.distribution && field === spec.distribution.field) return typeof v === 'string';
  const amountField = templateFor(spec.name).amountField || 'amount';
  if (spec.amount && field === 'currency') return typeof v === 'string';
  if (spec.amount && field === amountField) return typeof v === 'number' && Number.isFinite(v);
  if (spec.pools && Object.hasOwn(spec.pools, field)) return isValueCompatibleWithDefault(v, spec.pools[field]);
  if (spec.fields && Object.hasOwn(spec.fields, field)) {
    const entry = spec.fields[field];
    if (isObj(entry)) return isValueCompatibleWithDefault(v, entry.default) || entry.value.some((ev) => ev !== null && isValueCompatibleWithDefault(v, [ev]));
    return isValueCompatibleWithDefault(v, entry);
  }
  if (spec.name === 'products' && field === 'stock') return Number.isInteger(v);
  return typeof v === 'string';
}

function isWhenValuePossible(v, condField, spec, byName) {
  if (v === null) return canFieldBeNull(condField, spec, byName);
  const refEntity = fkTargetEntity(spec, condField);
  if (condField === 'id') return Number.isInteger(v) && v >= 1 && v <= spec.count;
  if (refEntity) {
    const targetCount = byName[refEntity]?.count ?? 0;
    return Number.isInteger(v) && v >= 1 && v <= targetCount;
  }
  if (spec.distribution && condField === spec.distribution.field) {
    return typeof v === 'string' && Object.hasOwn(spec.distribution.counts, v);
  }
  const amountField = templateFor(spec.name).amountField || 'amount';
  if (spec.amount && condField === 'currency') return v === spec.amount.currency;
  if (spec.amount && condField === amountField) {
    return typeof v === 'number' && Number.isFinite(v) && v >= spec.amount.min && v <= spec.amount.max;
  }
  if (spec.pools && Object.hasOwn(spec.pools, condField)) return spec.pools[condField].includes(v);
  if (spec.fields && Object.hasOwn(spec.fields, condField)) {
    const entry = spec.fields[condField];
    const inType = (t) => (Array.isArray(t) ? t.includes(v) : isScalarCompatibleWithType(v, t));
    return isObj(entry) ? (inType(entry.default) || entry.value.includes(v)) : inType(entry);
  }
  return false;
}

function describeTargetField(condField, spec, byName) {
  if (condField === 'id') return spec.count >= 1 ? `integer 1..${spec.count}` : 'no rows (total is 0)';
  const refEntity = fkTargetEntity(spec, condField);
  if (refEntity) {
    const targetCount = byName[refEntity]?.count ?? 0;
    return targetCount >= 1 ? `integer 1..${targetCount} (${refEntity})` : `no rows in "${refEntity}" (total is 0)`;
  }
  if (spec.distribution && condField === spec.distribution.field) return `distribution: ${Object.keys(spec.distribution.counts).join(', ')}`;
  const amountField = templateFor(spec.name).amountField || 'amount';
  if (spec.amount && condField === 'currency') return JSON.stringify(spec.amount.currency);
  if (spec.amount && condField === amountField) return `number ${spec.amount.min}..${spec.amount.max}`;
  if (spec.pools && Object.hasOwn(spec.pools, condField)) return `values: ${JSON.stringify(spec.pools[condField])}`;
  if (spec.fields && Object.hasOwn(spec.fields, condField)) {
    const entry = spec.fields[condField];
    const def = isObj(entry) ? entry.default : entry;
    return Array.isArray(def) ? `enum ${JSON.stringify(def)}` : def;
  }
  if (spec.name === 'products' && condField === 'stock') return 'integer';
  if ((spec.name === 'users' || spec.name === 'customers') && condField === 'email') return 'email';
  if (spec.name !== 'products' && condField === 'created_at') return 'date';
  return 'string';
}

function validateConditionals(spec, f, byName, issues) {
  if (!spec.fields) return;
  const allFields = entityFields(spec);
  const condEntries = Object.entries(spec.fields).filter(([, entry]) => isObj(entry));
  if (!condEntries.length) return;
  const condMap = new Map(condEntries);

  for (const [k, entry] of condEntries) {
    const ff = `${f}.fields.${k}`;
    for (const val of entry.value) {
      if (!isValueCompatibleWithDefault(val, entry.default)) {
        const desc = Array.isArray(entry.default) ? JSON.stringify(entry.default) : entry.default;
        issues.add(`${ff}.value`, `value ${JSON.stringify(val)} is incompatible with type ${desc}`);
      }
    }
    for (const [ck, expected] of Object.entries(entry.when)) {
      const cff = `${ff}.when.${ck}`;
      if (ck === k) {
        issues.add(cff, `field "${k}" cannot reference itself in "when"`);
        continue;
      }
      if (!allFields.includes(ck)) {
        issues.add(cff, `field "${ck}" does not exist in "${spec.name}" (fields: ${allFields.join(', ')})`);
        continue;
      }
      const candidates = Array.isArray(expected) ? expected : [expected];
      for (const val of candidates) {
        if (!isWhenValuePossible(val, ck, spec, byName)) {
          issues.add(cff, `value ${JSON.stringify(val)} is impossible for field "${ck}" (${describeTargetField(ck, spec, byName)})`);
        }
      }
    }
  }

  // Detect cycles among conditional fields.
  const state = new Map(); // 0/undefined = unvisited, 1 = visiting, 2 = done
  const checkCycle = (k, trail) => {
    const st = state.get(k);
    if (st === 2) return;
    if (st === 1) {
      const cycle = [...trail.slice(trail.indexOf(k)), k];
      issues.add(`${f}.fields.${k}.when`, `cycle in conditional fields: ${cycle.join(' → ')}`);
      return;
    }
    const entry = condMap.get(k);
    if (!entry) return;
    state.set(k, 1);
    for (const dep of Object.keys(entry.when)) {
      if (dep !== k && condMap.has(dep)) checkCycle(dep, [...trail, k]);
    }
    state.set(k, 2);
  };
  for (const [k] of condEntries) checkCycle(k, []);
}

function normalizeWorld(world, issues) {
  if (!isObj(world)) { issues.add('world', `required; must be a map entity: count (got ${typeName(world)})`); return []; }
  const names = Object.keys(world);
  if (!names.length) { issues.add('world', 'must declare at least one entity'); return []; }
  const specs = [];
  for (const name of names) {
    const f = `world.${name}`;
    if (!/^[a-z][a-z0-9_]*$/.test(name)) issues.add(f, 'entity names use lowercase letters, digits or "_"');
    if (Object.hasOwn(RENAMED_TEMPLATES, name)) {
      const en = RENAMED_TEMPLATES[name];
      issues.add(f, `"${name}" is no longer a built-in template; use "${en}" (its fields are in English: ${templateFor(en).fields.filter((x) => x !== '{fk}').join(', ')})`);
      continue;
    }
    let raw = world[name];
    if (isInt(raw)) raw = { total: raw };
    if (!isObj(raw)) { issues.add(f, `must be an integer or a map with "total"; got ${typeName(raw)}`); continue; }
    issues.unknownKeys(raw, ENTITY_KEYS, f);
    // With explicit `fields` the entity is fully described by the scenario: the
    // template's defaults (status, amount, default refs) do not leak into it.
    const t = raw.fields === undefined ? templateFor(name) : {};
    const spec = { name, count: 0, refs: [], distribution: null, amount: null, nulls: {}, pools: {}, days: 90 };
    if (!isInt(raw.total) || raw.total < 0) issues.add(`${f}.total`, `required; integer >= 0 (got ${JSON.stringify(raw.total)})`);
    else spec.count = raw.total;

    if (raw.distribution !== undefined) {
      const field = raw.distribution_field ?? t.statusField ?? 'status';
      if (!isObj(raw.distribution) || !Object.keys(raw.distribution).length) issues.add(`${f}.distribution`, 'must be a non-empty map value: count');
      else {
        let sum = 0;
        for (const [v, c] of Object.entries(raw.distribution)) {
          if (!isInt(c) || c < 0) issues.add(`${f}.distribution.${v}`, `must be an integer >= 0; got ${JSON.stringify(c)}`);
          else sum += c;
        }
        if (isInt(raw.total) && sum !== raw.total) issues.add(`${f}.distribution`, `sum (${sum}) does not match total (${raw.total})`);
        spec.distribution = { field: String(field), counts: { ...raw.distribution } };
      }
    } else if (t.statusField) {
      spec.distribution = { field: t.statusField, counts: { [t.defaultStatus]: spec.count } };
    }

    const amount = raw.amount ?? t.defaultAmount;
    if (amount !== undefined) {
      if (!isObj(amount)) issues.add(`${f}.amount`, 'must be a map { min, max, currency }');
      else {
        issues.unknownKeys(amount, ['min', 'max', 'currency'], `${f}.amount`);
        const { min, max, currency = 'EUR' } = amount;
        if (typeof min !== 'number' || typeof max !== 'number') issues.add(`${f}.amount`, '"min" and "max" are required and numeric');
        else if (min > max) issues.add(`${f}.amount`, `min (${min}) is greater than max (${max})`);
        else if (min < 0) issues.add(`${f}.amount.min`, 'cannot be negative');
        else spec.amount = { min, max, currency: String(currency) };
      }
    }

    if (raw.ref !== undefined) {
      const refs = Array.isArray(raw.ref) ? raw.ref : [raw.ref];
      refs.forEach((r, i) => {
        if (typeof r !== 'string') issues.add(`${f}.ref[${i}]`, 'must be an entity name');
        else if (!names.includes(r)) issues.add(`${f}.ref`, `entity "${r}" is not declared in world (declared: ${names.join(', ')})`);
        else if (r === name) issues.add(`${f}.ref`, 'an entity cannot reference itself');
        else spec.refs.push(r);
      });
    } else if (t.defaultRef) {
      spec.refs = t.defaultRef.filter((r) => names.includes(r));
    }

    if (raw.days !== undefined) {
      if (!isInt(raw.days) || raw.days <= 0) issues.add(`${f}.days`, 'must be an integer > 0');
      else spec.days = raw.days;
    }
    if (raw.fields !== undefined) {
      if (!isObj(raw.fields) || !Object.keys(raw.fields).length) issues.add(`${f}.fields`, 'must be a non-empty map field: type');
      else {
        const fields = {};
        for (const [k, type] of Object.entries(raw.fields)) {
          const ff = `${f}.fields.${k}`;
          if (k === 'id') issues.add(ff, 'atrezzo assigns the id (integers 1..n); remove it from fields');
          else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) issues.add(ff, 'invalid field name (letters, digits, "_")');
          else if (isObj(type)) {
            issues.unknownKeys(type, ['default', 'when', 'value'], ff);
            const def = type.default === undefined
              ? (issues.add(`${ff}.default`, 'required; a field type or non-empty list of scalar values'), null)
              : parseFieldType(type.default, `${ff}.default`, issues);
            let when = null;
            if (!isObj(type.when) || !Object.keys(type.when).length) {
              issues.add(`${ff}.when`, 'required; must be a non-empty map field: value');
            } else {
              when = {};
              for (const [ck, cv] of Object.entries(type.when)) {
                const parsed = parseScalarOrList(cv, `${ff}.when.${ck}`, issues);
                if (parsed !== undefined) when[ck] = parsed;
              }
            }
            let value = null;
            if (type.value === undefined) {
              issues.add(`${ff}.value`, 'required; a scalar value or non-empty list of scalar values');
            } else {
              const parsed = parseScalarOrList(type.value, `${ff}.value`, issues);
              if (parsed !== undefined) value = Array.isArray(parsed) ? parsed : [parsed];
            }
            if (def !== null && when !== null && value !== null) fields[k] = { default: def, when, value };
            else if (def !== null) fields[k] = def;
          } else {
            const parsed = parseFieldType(type, ff, issues);
            if (parsed !== null) fields[k] = parsed;
          }
        }
        spec.fields = fields;
      }
    }
    if (raw.values !== undefined) {
      if (!isObj(raw.values)) issues.add(`${f}.values`, 'must be a map field: [values]');
      else for (const [k, list] of Object.entries(raw.values)) {
        if (k === 'id') issues.add(`${f}.values.id`, 'atrezzo assigns the id');
        else if (!Array.isArray(list) || !list.length) issues.add(`${f}.values.${k}`, 'must be a non-empty list');
        else spec.pools[k] = list;
      }
    }
    specs.push({ spec, raw, f });
  }

  // Second pass: things that depend on other entities / final field lists.
  const counts = Object.fromEntries(specs.map(({ spec }) => [spec.name, spec.count]));
  const byName = Object.fromEntries(specs.map(({ spec }) => [spec.name, spec]));
  for (const { spec, raw, f } of specs) {
    // Only when declared: a scenario without them keeps its normalized form (and its hash).
    if (raw.derive !== undefined) normalizeDerive(spec, raw.derive, `${f}.derive`, byName, issues);
    if (raw.counts !== undefined) {
      const parsedCounts = parseCounts(raw.counts, spec, `${f}.counts`, byName, issues);
      if (parsedCounts.length) spec.counts = parsedCounts;
    }
    if (raw.seed_first !== undefined) normalizeSeedFirst(spec, raw.seed_first, `${f}.seed_first`, issues);
    if (raw.values_order !== undefined) normalizeValuesOrder(spec, raw.values_order, `${f}.values_order`, issues);
    for (const r of spec.refs) {
      if (spec.count > 0 && counts[r] === 0) issues.add(`${f}.ref`, `"${spec.name}" references "${r}" but "${r}" has 0 items; the ids would not exist`);
    }
    if (raw.nulls !== undefined) {
      const fields = entityFields(spec);
      if (!isObj(raw.nulls)) issues.add(`${f}.nulls`, 'must be a map field: count');
      else for (const [k, n] of Object.entries(raw.nulls)) {
        if (k === 'id') issues.add(`${f}.nulls.id`, 'the id can never be null');
        else if (!fields.includes(k)) issues.add(`${f}.nulls.${k}`, `field does not exist in "${spec.name}" (fields: ${fields.join(', ')})`);
        else if (!isInt(n) || n < 0 || n > spec.count) issues.add(`${f}.nulls.${k}`, `must be an integer between 0 and ${spec.count}`);
        else spec.nulls[k] = n;
      }
    }
    validateConditionals(spec, f, byName, issues);
  }
  return specs.map(({ spec }) => spec);
}

// ---------- endpoints ----------

const ENDPOINT_KEYS = ['path', 'entity', 'filters', 'pagination', 'sort', 'sorts', 'include', 'embed', 'counts', 'shape', 'envelope', 'detail', 'pick', 'latency', 'pluck', 'error', 'passthrough'];

/** Levels of `embed` below an endpoint's entity (the endpoint's own children are level 1). */
export const MAX_EMBED_DEPTH = 4;

/**
 * `embed`: a name, a list of names, or entries `{ entity, embed }` that embed their own children.
 * Each child must `ref:` the entity it is embedded in. Normalized as a list whose items are the
 * child's name (a leaf, the pre-0.10 form, so existing hashes do not move) or `{ entity, embed }`.
 * `chain` = the entities from the endpoint's down to `parent`, to report cycles and depth.
 */
function normalizeEmbed(raw, parent, chain, f, byName, issues) {
  const list = Array.isArray(raw) ? raw : [raw];
  const fields = entityFields(parent);
  const out = [];
  const seen = [];
  list.forEach((item, j) => {
    const fe = `${f}${Array.isArray(raw) ? `[${j}]` : ''}`;
    let child; let nested;
    if (typeof item === 'string') child = item;
    else if (isObj(item)) {
      issues.unknownKeys(item, ['entity', 'embed'], fe);
      if (typeof item.entity !== 'string' || !item.entity) { issues.add(`${fe}.entity`, `required; the entity whose rows point at each "${parent.name}" row`); return; }
      child = item.entity;
      nested = item.embed;
    } else { issues.add(fe, `must be an entity name or a map { entity, embed }; got ${typeName(item)}`); return; }
    const cspec = byName[child];
    const path = [...chain, child].join(' → ');
    if (!cspec) issues.add(fe, `${JSON.stringify(child)} is not declared in world (declared: ${Object.keys(byName).join(', ')})`);
    else if (chain.includes(child)) issues.add(fe, `cycle: ${path}; "${child}" would be embedded inside its own rows`);
    else if (chain.length > MAX_EMBED_DEPTH) issues.add(fe, `embed nests at most ${MAX_EMBED_DEPTH} levels below the endpoint's entity (${path})`);
    else if (!cspec.refs.includes(parent.name)) issues.add(fe, `"${child}" does not reference "${parent.name}" (its refs: ${cspec.refs.join(', ') || 'none'}); embed lists the child rows that point at each row: add ref: ${parent.name} to world.${child}`);
    else if (fields.includes(child)) issues.add(fe, `"${child}" is already a field of "${parent.name}"; the embedded list would overwrite it`);
    else if (seen.includes(child)) issues.add(fe, `"${child}" is listed twice`);
    else {
      seen.push(child);
      const inner = nested === undefined ? [] : normalizeEmbed(nested, cspec, [...chain, child], `${fe}.embed`, byName, issues);
      out.push(inner.length ? { entity: child, embed: inner } : child);
    }
  });
  return out;
}

/** `items(tags), notes`: an embed list as one line, for banners and generated comments. */
export function embedLabel(embed) {
  return (embed ?? []).map((e) => (typeof e === 'string' ? e : `${e.entity}(${embedLabel(e.embed)})`)).join(', ');
}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names of the `:name` segments of a path, validated (whole segments, unique, not a trailing `:id` unless passthrough). */
function pathParams(path, field, issues, { allowTrailingId = false } = {}) {
  const names = [];
  const segs = path.split('/');
  segs.forEach((seg, i) => {
    if (!seg.includes(':')) return;
    const name = seg.slice(1);
    if (!seg.startsWith(':') || !PARAM_NAME.test(name)) { issues.add(field, `"${seg}": a parameter is a whole segment ":name" (letters, digits, "_")`); return; }
    if (names.includes(name)) { issues.add(field, `parameter ":${name}" appears twice`); return; }
    if (!allowTrailingId && name === 'id' && i === segs.length - 1) { issues.add(field, 'a trailing "/:id" is the detail route, generated automatically (detail: true); declare the collection path'); return; }
    names.push(name);
  });
  return names;
}

/**
 * Fields a path parameter may bind to, in order: the parameter's own name, then `<name>_id`; a bare
 * `:id` binds only to the singular of the segment before it + `_id` (`/projects/:id` ⇒ project_id),
 * and only when it is the path's single parameter: with two or more, every one is named explicitly.
 */
function paramCandidates(name, path, count) {
  if (name === 'id') {
    if (count > 1) return [];
    // A bare `:id` in the middle names the parent, never the row's own id.
    const segs = path.split('/');
    const prev = segs[segs.indexOf(':id') - 1];
    return prev && !prev.startsWith(':') ? [templateFor(prev.toLowerCase()).fk] : [];
  }
  return name.endsWith('_id') ? [name] : [name, `${name}_id`];
}

/** The field a parameter binds to, or null. No other fallback: a name that matches nothing is an error. */
function paramField(name, path, count, fields) {
  return paramCandidates(name, path, count).find((c) => fields.includes(c)) ?? null;
}

/** array: a JSON list · envelope: { data, total, limit, offset } (or custom keys via `envelope`) · object: the first row as a JSON object. */
export const SHAPES = ['array', 'envelope', 'object'];
const ENVELOPE_KEYS = ['items', 'total', 'page', 'per_page'];
const FORBIDDEN_ENVELOPE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function parseEnvelope(raw, rawShape, hasPick, f, issues) {
  if (rawShape !== 'envelope') {
    const got = rawShape === undefined ? 'none (default "array")' : JSON.stringify(rawShape);
    issues.add(f, `requires shape: "envelope" (got ${got})`);
  }
  if (hasPick) {
    issues.add(f, 'cannot combine "pick" with "envelope" (declare "items" inside "envelope")');
  }
  if (!isObj(raw) || !Object.keys(raw).length) {
    issues.add(f, `must be a non-empty map { ${ENVELOPE_KEYS.join(', ')} }; got ${isObj(raw) ? 'empty map' : typeName(raw)}`);
    return null;
  }
  issues.unknownKeys(raw, ENVELOPE_KEYS, f);
  const parsed = {};
  for (const k of ENVELOPE_KEYS) {
    if (!Object.hasOwn(raw, k)) continue;
    const v = raw[k];
    if (typeof v !== 'string' || v.trim() === '') {
      issues.add(`${f}.${k}`, 'must be a non-empty key name');
      continue;
    }
    const parts = v.split('.');
    if (parts.some((p) => !p || /\s/.test(p) || FORBIDDEN_ENVELOPE_SEGMENTS.has(p))) {
      issues.add(`${f}.${k}`, `invalid key ${JSON.stringify(v)}: must be non-empty without whitespace or empty segments`);
      continue;
    }
    parsed[k] = v;
  }
  const hasItemsKey = Object.hasOwn(raw, 'items');
  const out = { items: parsed.items ?? 'data' };
  const used = hasItemsKey && parsed.items === undefined ? [] : [['items', out.items, parsed.items !== undefined]];
  for (const k of ['total', 'page', 'per_page']) {
    if (parsed[k] === undefined) continue;
    const val = parsed[k];
    const dup = used.find(([, uv]) => uv === val);
    if (dup) {
      issues.add(`${f}.${k}`, `duplicate key ${JSON.stringify(val)} (already used by "${dup[0]}"${dup[2] ? '' : ' default'})`);
      continue;
    }
    const conflict = used.find(([, uv]) => uv.startsWith(`${val}.`) || val.startsWith(`${uv}.`));
    if (conflict) {
      issues.add(`${f}.${k}`, `key ${JSON.stringify(val)} conflicts with nested key ${JSON.stringify(conflict[1])} ("${conflict[0]}"${conflict[2] ? '' : ' default'})`);
      continue;
    }
    out[k] = val;
    used.push([k, val, true]);
  }
  return out;
}
/** Upper bound for `latency` (scenario) and `serve --latency`: a slow backend, not a hung one. */
export const MAX_LATENCY = 60000;
/** Upper bound for stream `interval`: Node.js `setTimeout` caps delays at 2^31 - 1 ms (~24.9 days). */
export const MAX_STREAM_INTERVAL = 2147483647;

function parseSort(raw, fields, f, issues) {
  if (raw === undefined) return [{ field: 'id', dir: 'asc' }];
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length) {
    issues.add(`${f}.sort`, 'must be a field name or a non-empty list of field names');
    return [];
  }
  const out = [];
  list.forEach((s, i) => {
    if (typeof s !== 'string' || !s) { issues.add(`${f}.sort[${i}]`, 'must be a field name, prefixed with "-" for descending'); return; }
    const dir = s.startsWith('-') ? 'desc' : 'asc';
    const field = s.replace(/^[-+]/, '');
    if (!fields.includes(field)) issues.add(`${f}.sort`, `field "${field}" does not exist (fields: ${fields.join(', ')})`);
    else out.push({ field, dir });
  });
  return out;
}

function parseSorts(raw, fields, filters, pagination, f, issues) {
  if (raw === undefined) return null;
  if (!isObj(raw)) { issues.add(`${f}.sorts`, `must be a map { by, order, fields }; got ${typeName(raw)}`); return null; }
  issues.unknownKeys(raw, ['by', 'order', 'fields'], `${f}.sorts`);
  let by = 'sort_by';
  if (raw.by !== undefined) {
    if (typeof raw.by !== 'string' || !raw.by || /\s/.test(raw.by)) issues.add(`${f}.sorts.by`, 'must be a query parameter name (non-empty, no spaces)');
    else by = raw.by;
  }
  let order = null;
  if (raw.order !== undefined && raw.order !== null) {
    if (typeof raw.order !== 'string' || !raw.order || /\s/.test(raw.order)) issues.add(`${f}.sorts.order`, 'must be a query parameter name (non-empty, no spaces)');
    else if (raw.order === by) issues.add(`${f}.sorts.order`, `must differ from "by" ("${by}")`);
    else order = raw.order;
  }
  const pgNames = pagination ? [pagination.limit, pagination.page ?? pagination.offset] : [];
  for (const [k, name] of [['by', by], ['order', order]]) {
    if (!name) continue;
    if (filters.includes(name)) issues.add(`${f}.sorts.${k}`, `parameter "${name}" conflicts with a declared filter of the same name`);
    if (pgNames.includes(name)) issues.add(`${f}.sorts.${k}`, `parameter "${name}" conflicts with a pagination parameter of the same name`);
  }
  const sortFields = [];
  if (!Array.isArray(raw.fields) || !raw.fields.length) {
    issues.add(`${f}.sorts.fields`, `required; a non-empty list of sortable fields (fields: ${fields.join(', ')})`);
  } else {
    raw.fields.forEach((fld, j) => {
      const ff = `${f}.sorts.fields[${j}]`;
      if (typeof fld !== 'string' || !fld) issues.add(ff, 'must be a field name');
      else if (!fields.includes(fld)) issues.add(ff, `field "${fld}" does not exist (fields: ${fields.join(', ')})`);
      else if (sortFields.includes(fld)) issues.add(ff, `"${fld}" is listed twice`);
      else sortFields.push(fld);
    });
  }
  return { by, order, fields: sortFields };
}

const USER_TOKEN_RE = /^\$user\.([A-Za-z_][A-Za-z0-9_]*)$/;

const FORBIDDEN_COUNT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseCounts(raw, parentSpec, f, byName, issues) {
  if (!isObj(raw) || !Object.keys(raw).length) {
    issues.add(f, 'must be a non-empty map <name>: { entity: <entity>, on: <fk> }');
    return [];
  }
  const parentFields = entityFields(parentSpec);
  const out = [];
  const seenFields = new Map();
  for (const [key, val] of Object.entries(raw)) {
    const ff = `${f}.${key}`;
    if (!PARAM_NAME.test(key) || FORBIDDEN_COUNT_KEYS.has(key)) {
      issues.add(ff, 'invalid count key (letters, digits, "_")');
      continue;
    }
    if (!isObj(val)) {
      issues.add(ff, `must be a map { entity, on }; got ${typeName(val)}`);
      continue;
    }
    issues.unknownKeys(val, ['entity', 'on'], ff);
    const targetEntity = val.entity;
    let childSpec = null;
    if (typeof targetEntity !== 'string' || !targetEntity) {
      issues.add(`${ff}.entity`, `required; a declared world entity (declared: ${Object.keys(byName).join(', ') || 'none'})`);
    } else if (!Object.hasOwn(byName, targetEntity)) {
      issues.add(`${ff}.entity`, `"${targetEntity}" is not declared in world (declared: ${Object.keys(byName).join(', ') || 'none'})`);
    } else {
      childSpec = byName[targetEntity];
    }
    const on = val.on;
    let onOk = false;
    if (typeof on !== 'string' || !on) {
      issues.add(`${ff}.on`, `required; foreign key field on ${childSpec ? `"${targetEntity}"` : 'the child entity'} pointing to "${parentSpec.name}"`);
    } else if (childSpec) {
      const childFields = entityFields(childSpec);
      const childFkTarget = Object.fromEntries(childSpec.refs.map((r) => [templateFor(r).fk, r]));
      const childFks = Object.keys(childFkTarget);
      if (!childFields.includes(on)) {
        issues.add(`${ff}.on`, `field "${on}" does not exist in "${targetEntity}" (fields: ${childFields.join(', ')}; foreign keys: ${childFks.join(', ') || 'none'})`);
      } else if (!Object.hasOwn(childFkTarget, on)) {
        issues.add(`${ff}.on`, `"${on}" is not a foreign key of "${targetEntity}" (its foreign keys: ${childFks.join(', ') || `none; declare ref: ${parentSpec.name}`})`);
      } else if (childFkTarget[on] !== parentSpec.name) {
        issues.add(`${ff}.on`, `"${on}" is a foreign key to "${childFkTarget[on]}", not "${parentSpec.name}"`);
      } else {
        onOk = true;
      }
    }
    if (childSpec && onOk) {
      const field = key === targetEntity ? `${key}_count` : key;
      if (field === 'id') {
        issues.add(ff, 'count field cannot be named "id"');
        continue;
      }
      if (parentFields.includes(field)) {
        issues.add(ff, `"${field}" is already a field of "${parentSpec.name}"; the count would overwrite it`);
        continue;
      }
      if (seenFields.has(field)) {
        issues.add(ff, `duplicate output field "${field}" (already used by "${seenFields.get(field)}")`);
        continue;
      }
      seenFields.set(field, key);
      out.push({ field, entity: targetEntity, on });
    }
  }
  return out;
}

function mergeCounts(entityCounts, endpointCounts) {
  if (!entityCounts?.length && !endpointCounts?.length) return [];
  const byField = new Map();
  for (const c of entityCounts ?? []) byField.set(c.field, c);
  for (const c of endpointCounts ?? []) byField.set(c.field, c);
  return [...byField.values()];
}

function parseUserToken(val, ff, byName, auth, authDeclared, issues, targetField = null, targetSpec = null) {
  const m = USER_TOKEN_RE.exec(val);
  if (!m) {
    issues.add(ff, `invalid user token ${JSON.stringify(val)}; expected "$user.<field>"`);
    return null;
  }
  if (!authDeclared) {
    issues.add(ff, `${JSON.stringify(val)} requires a top-level "auth: { user: { entity, id } }" block in the scenario`);
    return null;
  }
  if (!auth) return null; // `auth` itself had validation errors; avoid duplicate noise
  const userSpec = byName[auth.user.entity];
  const userFields = entityFields(userSpec);
  const userField = m[1];
  if (!userFields.includes(userField)) {
    issues.add(ff, `field "${userField}" does not exist in auth user entity "${auth.user.entity}" (fields: ${userFields.join(', ')})`);
    return null;
  }
  if (targetField && targetSpec && !areFieldsCompatible(userField, userSpec, targetField, targetSpec)) {
    issues.add(ff, `${JSON.stringify(val)} (${auth.user.entity}.${userField}: ${describeTargetField(userField, userSpec, byName)}) is incompatible with field "${targetField}" in "${targetSpec.name}" (${describeTargetField(targetField, targetSpec, byName)})`);
    return null;
  }
  return userField;
}

function parseWorldFilter(field, raw, spec, fkTarget, byName, auth, authDeclared, ff, issues) {
  issues.unknownKeys(raw, ['from', 'where'], ff);
  const from = raw.from;
  let fromSpec = null;
  if (typeof from !== 'string' || !from) {
    issues.add(`${ff}.from`, `required; a declared world entity (declared: ${Object.keys(byName).join(', ') || 'none'})`);
  } else if (!Object.hasOwn(byName, from)) {
    issues.add(`${ff}.from`, `"${from}" is not declared in world (declared: ${Object.keys(byName).join(', ') || 'none'})`);
  } else {
    fromSpec = byName[from];
  }

  const fks = Object.keys(fkTarget);
  let fkOk = false;
  if (!Object.hasOwn(fkTarget, field)) {
    issues.add(ff, `"${field}" is not a foreign key of "${spec.name}" (its foreign keys: ${fks.join(', ') || 'none; declare ref: first'})`);
  } else if (fromSpec && fkTarget[field] !== from) {
    issues.add(`${ff}.from`, `"${field}" is a foreign key to "${fkTarget[field]}", not "${from}"`);
  } else if (fromSpec) {
    fkOk = true;
  }

  let where = null;
  if (!isObj(raw.where) || !Object.keys(raw.where).length) {
    issues.add(`${ff}.where`, 'required; must be a non-empty map field: value');
  } else {
    const fromFields = fromSpec ? entityFields(fromSpec) : null;
    const parsed = {};
    let whereOk = true;
    for (const [wk, wv] of Object.entries(raw.where)) {
      const wff = `${ff}.where.${wk}`;
      if (fromFields && !fromFields.includes(wk)) {
        issues.add(wff, `field "${wk}" does not exist in "${from}" (fields: ${fromFields.join(', ')})`);
        whereOk = false;
      }
      const val = parseScalarOrList(wv, wff, issues);
      if (val === undefined) {
        whereOk = false;
      } else {
        if (fromSpec && fromFields.includes(wk)) {
          const candidates = Array.isArray(val) ? val : [val];
          let typeOk = true;
          for (const v of candidates) {
            if (typeof v === 'string' && v.startsWith('$')) {
              if (!parseUserToken(v, wff, byName, auth, authDeclared, issues, wk, fromSpec)) {
                typeOk = false;
                whereOk = false;
              }
            } else if (!isWhereValueCompatible(v, wk, fromSpec, byName)) {
              issues.add(wff, `value ${JSON.stringify(v)} is incompatible with field "${wk}" in "${from}" (${describeTargetField(wk, fromSpec, byName)})`);
              typeOk = false;
              whereOk = false;
            }
          }
          if (typeOk) parsed[wk] = val;
        } else {
          parsed[wk] = val;
        }
      }
    }
    if (whereOk) where = parsed;
  }

  return fkOk && where ? { field, from, where } : null;
}

function parsePassthrough(raw, ep, f, issues) {
  const pf = `${f}.passthrough`;
  if (!isObj(raw)) {
    issues.add(pf, `must be a map { fixture, patch }; got ${typeName(raw)}`);
    return null;
  }
  issues.unknownKeys(raw, ['fixture', 'patch'], pf);
  let fixture = null;
  if (typeof raw.fixture !== 'string' || !raw.fixture.trim()) {
    issues.add(`${pf}.fixture`, 'required; fixture name (e.g. "market" for atrezzo/fixtures/market.json)');
  } else {
    fixture = normalizeFixtureName(raw.fixture);
    if (!fixture) {
      issues.add(`${pf}.fixture`, `invalid fixture name ${JSON.stringify(raw.fixture)} (use letters, digits, ".", "_" or "-", without paths or "..")`);
    }
  }
  let patch = null;
  if (raw.patch !== undefined) {
    if (!isObj(raw.patch)) {
      issues.add(`${pf}.patch`, `must be a map { "field.path": value }; got ${typeName(raw.patch)}`);
    } else {
      patch = {};
      for (const [k, v] of Object.entries(raw.patch)) {
        const parts = k.split('.');
        if (!k || parts.some((p) => !p || FORBIDDEN_PATH_SEGMENTS.has(p))) {
          issues.add(`${pf}.patch.${k}`, `invalid patch path ${JSON.stringify(k)}: must be a non-empty dot-separated path`);
          continue;
        }
        if (v === undefined) {
          issues.add(`${pf}.patch.${k}`, 'patch value must be JSON-serializable');
          continue;
        }
        patch[k] = v;
      }
    }
  }
  if (ep.error !== undefined) {
    issues.add(pf, 'cannot combine "passthrough" with "error"');
  }
  if (ep.detail === true) {
    issues.add(`${f}.detail`, 'cannot combine "detail: true" with "passthrough"');
  }
  if (ep.entity === undefined) {
    for (const k of ['filters', 'pagination', 'sort', 'sorts', 'include', 'embed', 'counts', 'pluck', 'envelope', 'pick']) {
      if (ep[k] !== undefined) issues.add(`${f}.${k}`, `incompatible with "passthrough" without "entity"`);
    }
    if (ep.shape !== undefined && ep.shape !== 'array') {
      issues.add(`${f}.shape`, 'incompatible with "passthrough" without "entity"');
    }
  }
  if (!fixture) return null;
  const out = { fixture };
  if (patch && Object.keys(patch).length) out.patch = patch;
  return out;
}

function normalizeEndpoints(endpoints, world, auth, authDeclared, issues) {
  if (!Array.isArray(endpoints) || !endpoints.length) { issues.add('endpoints', 'required; a list with at least one endpoint'); return []; }
  const byName = Object.fromEntries(world.map((s) => [s.name, s]));
  const seen = new Set();
  const out = [];
  endpoints.forEach((ep, i) => {
    const f = `endpoints[${i}]`;
    if (!isObj(ep)) { issues.add(f, `must be a map; got ${typeName(ep)}`); return; }
    issues.unknownKeys(ep, ENDPOINT_KEYS, f);
    if (typeof ep.path !== 'string' || !ep.path.startsWith('/')) { issues.add(`${f}.path`, 'required; must start with "/"'); return; }
    if (/[?#]/.test(ep.path)) issues.add(`${f}.path`, 'no query or fragment');
    const path = ep.path.replace(/\/+$/, '') || '/';
    const names = pathParams(path, `${f}.path`, issues, { allowTrailingId: ep.passthrough !== undefined });
    // `/a/:x` and `/a/:y` answer the same requests: compare with the parameter names erased.
    const shapeKey = path.replace(/\/:[^/]+/g, '/:');
    if (seen.has(shapeKey)) issues.add(`${f}.path`, `duplicate: "${path}"`);
    seen.add(shapeKey);

    const passthrough = ep.passthrough !== undefined ? parsePassthrough(ep.passthrough, ep, f, issues) : null;
    let spec = null;
    if (ep.entity === undefined) {
      if (ep.passthrough === undefined) { issues.add(`${f}.entity`, `missing; name the world entity that "${path}" projects`); return; }
    } else {
      spec = byName[ep.entity];
      if (!spec) { issues.add(`${f}.entity`, `"${ep.entity}" is not declared in world (declared: ${Object.keys(byName).join(', ') || 'none'})`); return; }
    }
    const fields = spec ? entityFields(spec) : [];
    const fkTarget = spec ? Object.fromEntries(spec.refs.map((r) => [templateFor(r).fk, r])) : {};
    const filters = [];
    const worldFilters = [];
    const userFilters = [];
    const bound = {}; // ":param" -> field | null, from the map form of `filters`
    if (ep.filters !== undefined && spec) {
      if (Array.isArray(ep.filters)) {
        ep.filters.forEach((fl, j) => {
          if (!fields.includes(fl)) issues.add(`${f}.filters[${j}]`, `field "${fl}" does not exist in "${spec.name}" (fields: ${fields.join(', ')})`);
          else filters.push(fl);
        });
      } else if (isObj(ep.filters)) {
        for (const [k, v] of Object.entries(ep.filters)) {
          const ff = `${f}.filters.${k}`;
          if (k.startsWith(':')) {
            if (!names.includes(k.slice(1))) issues.add(ff, `"${k}" is not a parameter of "${path}" (parameters: ${names.map((n) => `:${n}`).join(', ') || 'none'})`);
            else if (v !== null && !fields.includes(v)) issues.add(ff, `field ${JSON.stringify(v)} does not exist in "${spec.name}" (fields: ${fields.join(', ')}); null accepts any value without filtering`);
            else bound[k.slice(1)] = v;
          } else if (isObj(v)) {
            const wf = parseWorldFilter(k, v, spec, fkTarget, byName, auth, authDeclared, ff, issues);
            if (wf) worldFilters.push(wf);
          } else if (typeof v === 'string' && v.startsWith('$')) {
            const fieldOk = fields.includes(k);
            if (!fieldOk) issues.add(ff, `field "${k}" does not exist in "${spec.name}" (fields: ${fields.join(', ')})`);
            const userField = parseUserToken(v, ff, byName, auth, authDeclared, issues, fieldOk ? k : null, fieldOk ? spec : null);
            if (fieldOk && userField) userFilters.push({ field: k, userField });
          } else if (v !== k) issues.add(ff, `a query filter filters the field of its own name: write "${k}: ${k}" (or use the list form, or { from, where }, or "$user.<field>")`);
          else if (!fields.includes(k)) issues.add(ff, `field "${k}" does not exist in "${spec.name}" (fields: ${fields.join(', ')})`);
          else filters.push(k);
        }
      } else issues.add(`${f}.filters`, 'must be a list of fields, or a map { field: field, field: "$user.<field>", field: { from, where }, ":param": field }');
    }
    const params = [];
    for (const name of names) {
      if (!spec) { params.push({ name, field: null }); continue; }
      if (Object.hasOwn(bound, name)) { params.push({ name, field: bound[name] }); continue; }
      const field = paramField(name, path, names.length, fields);
      if (field) params.push({ name, field });
      else {
        const tried = paramCandidates(name, path, names.length);
        const looked = tried.length ? `looked for ${tried.map((t) => `"${t}"`).join(', ')}`
          : names.length > 1 ? 'a path with several parameters does not guess what a bare ":id" names' : 'a bare ":id" names the segment before it';
        issues.add(`${f}.path`, `parameter ":${name}" binds to no field of "${spec.name}" (${looked}; fields: ${fields.join(', ')}); rename it after a field or map it: filters: { ":${name}": <field> } (null = accept any value)`);
      }
    }
    const embed = ep.embed === undefined || !spec ? [] : normalizeEmbed(ep.embed, spec, [spec.name], `${f}.embed`, byName, issues);
    const epCounts = ep.counts === undefined || !spec ? [] : parseCounts(ep.counts, spec, `${f}.counts`, byName, issues);
    const epRowCounts = spec ? mergeCounts(spec.counts, epCounts) : [];
    let pagination = null;
    if (ep.pagination !== undefined && ep.pagination !== null) {
      if (!isObj(ep.pagination)) issues.add(`${f}.pagination`, 'must be a map { param_limit, param_offset, default_limit, max_limit }');
      else {
        issues.unknownKeys(ep.pagination, ['param_limit', 'param_offset', 'param_page', 'default_limit', 'max_limit'], `${f}.pagination`);
        pagination = {
          limit: String(ep.pagination.param_limit ?? 'limit'),
          offset: String(ep.pagination.param_offset ?? 'offset'),
          defaultLimit: null,
          maxLimit: null,
        };
        for (const [k, dest] of [['default_limit', 'defaultLimit'], ['max_limit', 'maxLimit']]) {
          const v = ep.pagination[k];
          if (v === undefined) continue;
          if (!isInt(v) || v <= 0) issues.add(`${f}.pagination.${k}`, 'must be an integer > 0');
          else pagination[dest] = v;
        }
        if (ep.pagination.param_page !== undefined) {
          // Page-number pagination: offset = (page - 1) * limit. Needs a page size.
          if (ep.pagination.param_offset !== undefined) issues.add(`${f}.pagination`, 'use "param_offset" or "param_page", not both');
          if (ep.pagination.default_limit === undefined) issues.add(`${f}.pagination.default_limit`, 'required with "param_page" (default page size)');
          pagination.page = String(ep.pagination.param_page);
        }
      }
    }
    const include = [];
    if (ep.include !== undefined && spec) {
      const list = Array.isArray(ep.include) ? ep.include : [ep.include];
      list.forEach((inc) => {
        if (!spec.refs.includes(inc)) issues.add(`${f}.include`, `"${inc}" is not a reference of "${spec.name}" (refs: ${spec.refs.join(', ') || 'none'})`);
        else include.push(inc);
      });
    }
    const embedNames = new Set(embed.map((e) => (typeof e === 'string' ? e : e.entity)));
    const includeNames = new Set(include.map((inc) => templateFor(inc).singular));
    for (const c of epRowCounts) {
      const cf = epCounts.some((ec) => ec.field === c.field) ? `${f}.counts` : f;
      if (embedNames.has(c.field)) issues.add(cf, `count field "${c.field}" conflicts with embedded "${c.field}"`);
      else if (includeNames.has(c.field)) issues.add(cf, `count field "${c.field}" conflicts with included "${c.field}"`);
    }
    let shape = ep.shape ?? 'array';
    if (!SHAPES.includes(shape)) issues.add(`${f}.shape`, `must be ${SHAPES.map((s) => `"${s}"`).join(', ')}; got ${JSON.stringify(shape)}`);
    let pick = null;
    if (ep.pick !== undefined) {
      if (typeof ep.pick !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ep.pick)) issues.add(`${f}.pick`, 'envelope key that holds the list (e.g. data, items); a single key');
      else if (ep.shape === 'array' || ep.shape === 'object') issues.add(`${f}.pick`, `incompatible with shape: ${ep.shape} (pick implies an envelope)`);
      else { pick = ep.pick; shape = 'envelope'; }
    }
    let envelope = null;
    if (ep.envelope !== undefined) {
      envelope = parseEnvelope(ep.envelope, ep.shape, ep.pick !== undefined, `${f}.envelope`, issues);
    }
    // A singleton answers one row: there is no list to page through.
    if (shape === 'object' && pagination) issues.add(`${f}.pagination`, 'incompatible with shape: object (the response is a single row, not a list)');
    if (ep.detail !== undefined && typeof ep.detail !== 'boolean') issues.add(`${f}.detail`, 'must be true or false');
    let latency = null;
    if (ep.latency !== undefined) {
      if (!isInt(ep.latency) || ep.latency < 0 || ep.latency > MAX_LATENCY) issues.add(`${f}.latency`, `milliseconds, an integer between 0 and ${MAX_LATENCY}; got ${JSON.stringify(ep.latency)}`);
      else latency = ep.latency;
    }
    // `pluck: id`: each row answers that field's value as a string (["1","2"]), not the row.
    let pluck = null;
    if (ep.pluck !== undefined && spec) {
      if (typeof ep.pluck !== 'string' || !ep.pluck) issues.add(`${f}.pluck`, `must be a field name of "${spec.name}" (fields: ${fields.join(', ')})`);
      else if (!fields.includes(ep.pluck)) issues.add(`${f}.pluck`, `field "${ep.pluck}" does not exist in "${spec.name}" (fields: ${fields.join(', ')}); pluck answers that field of each row, as a string`);
      else pluck = ep.pluck;
      if (include.length || embed.length || ep.counts !== undefined || epRowCounts.length) {
        const what = include.length ? 'include' : embed.length ? 'embed' : 'counts';
        issues.add(`${f}.pluck`, `incompatible with ${what}: a plucked response is a list of values, not rows`);
      }
    }
    // `error: { status, body }`: the endpoint always answers that, whatever the world holds.
    let error = null;
    if (ep.error !== undefined) {
      if (!isObj(ep.error)) issues.add(`${f}.error`, `must be a map { status: 400-599, body: <JSON, optional> }; got ${typeName(ep.error)}`);
      else {
        issues.unknownKeys(ep.error, ['status', 'body'], `${f}.error`);
        const { status } = ep.error;
        if (!isInt(status) || status < 400 || status > 599) issues.add(`${f}.error.status`, `required; an HTTP error status, an integer between 400 and 599; got ${JSON.stringify(status)}`);
        else error = { status, body: ep.error.body === undefined ? { error: String(status) } : ep.error.body };
      }
    }
    const sorts = spec ? parseSorts(ep.sorts, fields, filters, pagination, f, issues) : null;
    const norm = {
      path, entity: spec ? spec.name : null, filters, pagination,
      sort: spec ? parseSort(ep.sort, fields, f, issues) : [], include, shape, detail: ep.detail ?? !passthrough,
    };
    if (sorts) norm.sorts = sorts; // only when declared: keeps scenario hashes stable
    if (worldFilters.length) norm.worldFilters = worldFilters; // same: absent unless declared
    if (userFilters.length) norm.userFilters = userFilters; // same: absent unless declared
    if (pick) norm.pick = pick; // only when declared: keeps 0.1 scenario hashes stable
    if (envelope) norm.envelope = envelope; // same: absent unless declared
    if (latency !== null) norm.latency = latency; // same: absent unless declared
    if (params.length) norm.params = params; // same
    if (embed.length) norm.embed = embed; // same
    if (epRowCounts.length) norm.counts = epRowCounts; // same: absent unless declared
    if (pluck) norm.pluck = pluck; // same
    if (error) norm.error = error; // same
    if (passthrough) norm.passthrough = passthrough; // same: absent unless declared
    out.push(norm);
  });
  return out;
}

// ---------- auth ----------

function normalizeAuth(raw, world, issues) {
  if (raw === undefined) return null;
  if (!isObj(raw)) {
    issues.add('auth', `must be a map { user: { entity, id } }; got ${typeName(raw)}`);
    return null;
  }
  issues.unknownKeys(raw, ['user'], 'auth');
  if (raw.user === undefined) {
    issues.add('auth.user', 'required; must be a map { entity, id }');
    return null;
  }
  if (!isObj(raw.user)) {
    issues.add('auth.user', `must be a map { entity, id }; got ${typeName(raw.user)}`);
    return null;
  }
  issues.unknownKeys(raw.user, ['entity', 'id'], 'auth.user');
  const byName = Object.fromEntries(world.map((s) => [s.name, s]));
  const { entity, id } = raw.user;
  let entityOk = false;
  if (typeof entity !== 'string' || !entity) {
    issues.add('auth.user.entity', `required; a declared world entity (declared: ${Object.keys(byName).join(', ') || 'none'})`);
  } else if (!Object.hasOwn(byName, entity)) {
    issues.add('auth.user.entity', `"${entity}" is not declared in world (declared: ${Object.keys(byName).join(', ') || 'none'})`);
  } else {
    entityOk = true;
  }
  let idOk = false;
  if (!isInt(id) || id < 1) {
    issues.add('auth.user.id', `required; integer >= 1 (got ${JSON.stringify(id)})`);
  } else if (entityOk) {
    const spec = byName[entity];
    if (spec.count === 0) {
      issues.add('auth.user.id', `entity "${entity}" has 0 rows in world; id ${id} does not exist`);
    } else if (id > spec.count) {
      issues.add('auth.user.id', `id ${id} does not exist in "${entity}" (valid ids: 1..${spec.count})`);
    } else {
      idOk = true;
    }
  }
  return entityOk && idOk ? { user: { entity, id } } : null;
}

// ---------- writes ----------

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const WRITE_ACTIONS = ['create', 'update', 'delete'];
const NO_BODY_STATUSES = new Set([204, 205, 304]);

function writePathParams(path, field, issues) {
  const names = [];
  for (const seg of path.split('/')) {
    if (!seg.includes(':')) continue;
    const name = seg.slice(1);
    if (!seg.startsWith(':') || !PARAM_NAME.test(name)) {
      issues.add(field, `"${seg}": a parameter is a whole segment ":name" (letters, digits, "_")`);
      return null;
    }
    if (names.includes(name)) {
      issues.add(field, `parameter ":${name}" appears twice`);
      return null;
    }
    names.push(name);
  }
  return names;
}

function writeParamField(name, path, spec) {
  const fields = entityFields(spec);
  const segs = path.split('/');
  if (name === 'id') {
    const idx = segs.indexOf(':id');
    if (idx === segs.length - 1) return 'id';
    const prev = segs[idx - 1];
    if (prev && !prev.startsWith(':') && prev.toLowerCase() !== spec.name) {
      const fk = templateFor(prev.toLowerCase()).fk;
      if (fields.includes(fk)) return fk;
    }
    return 'id';
  }
  if (fields.includes(name)) return name;
  const singularFk = `${templateFor(spec.name).singular}_id`;
  if (name === singularFk || name === `${spec.name}_id`) return 'id';
  if (fields.includes(`${name}_id`)) return `${name}_id`;
  return null;
}

/**
 * The contract endpoint a mutate-less write targets, or null: `POST <list>`, `PUT|PATCH|DELETE <list>/:param`
 * (the detail route) and `PUT|PATCH` on a `shape: object` endpoint. Paths compare segment by segment, a
 * parameter matching any parameter. Endpoints without an entity, with `pluck`, `error` or `passthrough` never count.
 */
function writeTargetEndpoint(method, path, endpoints) {
  const segs = path.split('/');
  const same = (a, b) => a.length === b.length && a.every((s, i) => s === b[i] || (s.startsWith(':') && b[i].startsWith(':')));
  for (const ep of endpoints) {
    if (!ep.entity || ep.pluck || ep.error || ep.passthrough) continue;
    const epSegs = ep.path.split('/');
    if (same(epSegs, segs)) {
      if (method === 'POST' && ep.shape !== 'object') return ep;
      if ((method === 'PUT' || method === 'PATCH') && ep.shape === 'object') return ep;
    } else if (ep.detail && method !== 'POST' && segs.at(-1).startsWith(':') && same(epSegs, segs.slice(0, -1))) {
      return ep;
    }
  }
  return null;
}

function normalizeWrites(rawWrites, world, auth, authDeclared, issues, endpoints = []) {
  if (rawWrites === undefined) return [];
  if (!isObj(rawWrites) || !Object.keys(rawWrites).length) {
    issues.add('writes', 'must be a non-empty map "<METHOD> /path": { expect, mutate }');
    return [];
  }
  const byName = Object.fromEntries(world.map((s) => [s.name, s]));
  const seen = new Set();
  const out = [];
  for (const [rawKey, rawRule] of Object.entries(rawWrites)) {
    const f = `writes[${rawKey}]`;
    const keyMatch = /^(\S+)\s+(\S.*)$/.exec(rawKey.trim());
    if (!keyMatch) {
      issues.add(f, 'must include an explicit HTTP method (POST, PUT, PATCH, DELETE) and path, e.g. "POST /api/orders"');
      continue;
    }
    const method = keyMatch[1];
    const rawPath = keyMatch[2].trim();
    if (!WRITE_METHODS.includes(method)) {
      issues.add(f, `method "${method}" is not supported in writes; use ${WRITE_METHODS.join(', ')}`);
      continue;
    }
    if (!rawPath.startsWith('/')) {
      issues.add(f, `path ${JSON.stringify(rawPath)} must start with "/"`);
      continue;
    }
    if (/[?#\s]/.test(rawPath)) {
      issues.add(f, `path ${JSON.stringify(rawPath)} must not contain whitespace, query or fragment`);
      continue;
    }
    const path = rawPath.replace(/\/+$/, '') || '/';
    const paramNames = writePathParams(path, f, issues);
    const shapeKey = `${method} ${path.replace(/\/:[^/]+/g, '/:')}`;
    if (seen.has(shapeKey)) {
      issues.add(f, `duplicate write route "${method} ${path}"`);
      continue;
    }
    seen.add(shapeKey);

    if (!isObj(rawRule)) {
      issues.add(f, `must be a map { expect, mutate }; got ${typeName(rawRule)}`);
      continue;
    }
    issues.unknownKeys(rawRule, ['expect', 'mutate'], f);
    if (rawRule.expect === undefined && rawRule.mutate === undefined) {
      issues.add(f, 'must declare "expect" and/or "mutate"');
      continue;
    }

    let expect;
    if (rawRule.expect === undefined) {
      expect = {
        status: method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200,
        ...(method !== 'DELETE' ? { echo: true } : {}),
      };
    } else if (!isObj(rawRule.expect)) {
      issues.add(`${f}.expect`, `must be a map { status, echo, body }; got ${typeName(rawRule.expect)}`);
      expect = { status: 200 };
    } else {
      issues.unknownKeys(rawRule.expect, ['status', 'echo', 'body'], `${f}.expect`);
      let echo = false;
      if (rawRule.expect.echo !== undefined) {
        if (typeof rawRule.expect.echo !== 'boolean') issues.add(`${f}.expect.echo`, 'must be true or false');
        else echo = rawRule.expect.echo;
      }
      const hasBody = rawRule.expect.body !== undefined;
      if (echo && hasBody) issues.add(`${f}.expect`, 'use "echo: true" or "body", not both');
      let status;
      if (rawRule.expect.status !== undefined) {
        if (!isInt(rawRule.expect.status) || rawRule.expect.status < 200 || rawRule.expect.status > 599) {
          issues.add(`${f}.expect.status`, `must be an integer HTTP status between 200 and 599; got ${JSON.stringify(rawRule.expect.status)}`);
          status = 200;
        } else {
          status = rawRule.expect.status;
        }
      } else {
        status = method === 'POST' ? 201 : (method === 'DELETE' && !echo && !hasBody) ? 204 : 200;
      }
      if (NO_BODY_STATUSES.has(status) && (echo || (hasBody && rawRule.expect.body !== null))) {
        issues.add(`${f}.expect`, `status ${status} cannot have a response body`);
      }
      expect = { status };
      if (echo) expect.echo = true;
      if (hasBody) expect.body = rawRule.expect.body;
    }

    // No `mutate` on a contract endpoint's route ⇒ it mutates that endpoint's entity (default action by method),
    // as long as every path parameter binds to one of its fields. `mutate: false` keeps it stateless.
    let rawMutate = rawRule.mutate === false ? undefined : rawRule.mutate;
    let inferredFrom = null;
    if (rawRule.mutate === undefined && paramNames) {
      const ep = writeTargetEndpoint(method, path, endpoints);
      const spec = ep && Object.hasOwn(byName, ep.entity) ? byName[ep.entity] : null;
      if (spec && paramNames.every((p) => writeParamField(p, path, spec))) {
        rawMutate = { entity: spec.name };
        inferredFrom = ep.path;
      }
    }

    let mutate = null;
    const params = [];
    if (rawMutate !== undefined) {
      const mf = `${f}.mutate`;
      if (!isObj(rawMutate)) {
        issues.add(mf, `must be a map { entity, action, set, where } or false (stateless); got ${typeName(rawMutate)}`);
      } else {
        issues.unknownKeys(rawMutate, ['entity', 'action', 'set', 'where'], mf);
        const entityName = rawMutate.entity;
        let spec = null;
        if (typeof entityName !== 'string' || !entityName) {
          issues.add(`${mf}.entity`, `required; a declared world entity (declared: ${Object.keys(byName).join(', ') || 'none'})`);
        } else if (!Object.hasOwn(byName, entityName)) {
          issues.add(`${mf}.entity`, `"${entityName}" is not declared in world (declared: ${Object.keys(byName).join(', ') || 'none'})`);
        } else {
          spec = byName[entityName];
        }

        let action = method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'update';
        if (rawMutate.action !== undefined) {
          if (!WRITE_ACTIONS.includes(rawMutate.action)) {
            issues.add(`${mf}.action`, `must be ${WRITE_ACTIONS.map((a) => `"${a}"`).join(', ')}; got ${JSON.stringify(rawMutate.action)}`);
          } else {
            action = rawMutate.action;
          }
        }

        const fields = spec ? entityFields(spec) : [];
        if (spec && paramNames) {
          for (const pname of paramNames) {
            const boundField = writeParamField(pname, path, spec);
            if (!boundField) {
              issues.add(f, `parameter ":${pname}" does not match any field of "${spec.name}" (fields: ${fields.join(', ')})`);
            } else {
              params.push({ name: pname, field: boundField });
            }
          }
        }

        let set;
        if (rawMutate.set !== undefined) {
          const sf = `${mf}.set`;
          if (action === 'delete') {
            issues.add(sf, '"set" cannot be used with delete');
          } else if (!isObj(rawMutate.set) || !Object.keys(rawMutate.set).length) {
            issues.add(sf, 'must be a non-empty map field: value');
          } else {
            set = {};
            for (const [sk, sv] of Object.entries(rawMutate.set)) {
              const sff = `${sf}.${sk}`;
              if (spec && !fields.includes(sk)) {
                issues.add(sff, `field "${sk}" does not exist in "${spec.name}" (fields: ${fields.join(', ')})`);
              } else if (sk === 'id') {
                issues.add(sff, '"id" is managed by atrezzo and cannot be set in mutate.set');
              } else if (typeof sv === 'string' && sv.startsWith('$')) {
                const userField = parseUserToken(sv, sff, byName, auth, authDeclared, issues, spec ? sk : null, spec);
                if (userField) set[sk] = sv;
              } else if (!isScalar(sv)) {
                issues.add(sff, 'must be a scalar value or "$user.<field>"');
              } else {
                set[sk] = sv;
              }
            }
          }
        }

        let where;
        if (rawMutate.where !== undefined) {
          const wf = `${mf}.where`;
          if (action === 'create') {
            issues.add(wf, '"where" cannot be used with create');
          } else if (!isObj(rawMutate.where) || !Object.keys(rawMutate.where).length) {
            issues.add(wf, 'must be a non-empty map field: value');
          } else {
            where = {};
            for (const [wk, wv] of Object.entries(rawMutate.where)) {
              const wff = `${wf}.${wk}`;
              if (spec && !fields.includes(wk)) {
                issues.add(wff, `field "${wk}" does not exist in "${spec.name}" (fields: ${fields.join(', ')})`);
                continue;
              }
              const parsed = parseScalarOrList(wv, wff, issues);
              if (parsed === undefined) continue;
              const candidates = Array.isArray(parsed) ? parsed : [parsed];
              let ok = true;
              for (const v of candidates) {
                if (typeof v === 'string' && v.startsWith('$')) {
                  if (!parseUserToken(v, wff, byName, auth, authDeclared, issues, spec ? wk : null, spec)) ok = false;
                }
              }
              if (ok) where[wk] = parsed;
            }
          }
        }

        if (spec) {
          mutate = { entity: spec.name, action };
          if (set) mutate.set = set;
          if (where) mutate.where = where;
        }
      }
    } else if (paramNames) {
      for (const pname of paramNames) params.push({ name: pname, field: null });
    }

    const norm = { method, path, expect };
    if (params.length) norm.params = params;
    if (mutate) norm.mutate = mutate;
    if (mutate && inferredFrom) norm.inferred = inferredFrom; // the GET endpoint the entity came from
    out.push(norm);
  }
  return out;
}

// ---------- streams ----------

/** True when `parts` fits `patternSegs` segment by segment (`:param` matches any non-empty segment). */
function pathFits(patternSegs, parts) {
  return patternSegs.length === parts.length && patternSegs.every((s, i) => (s.startsWith(':') ? Boolean(parts[i]) : s === parts[i]));
}

/** Check whether a stream path collides with any endpoint's GET route (list or `/:id` detail). */
function findEndpointCollision(streamPath, endpoints) {
  const parts = streamPath.split('/');
  for (const ep of endpoints) {
    const epSegs = ep.path.split('/');
    if (pathFits(epSegs, parts)) {
      return `conflicts with endpoint "${ep.path}" (GET "${streamPath}" cannot serve both a projection and an SSE stream)`;
    }
    if (ep.detail && parts.at(-1) && parts.length >= 2 && pathFits(epSegs, parts.slice(0, -1))) {
      return `conflicts with detail route "${ep.path}/:id" (set detail: false on "${ep.path}" or choose a different stream path)`;
    }
  }
  return null;
}

function normalizeStreams(rawStreams, endpoints, issues) {
  if (rawStreams === undefined) return [];
  if (!isObj(rawStreams) || !Object.keys(rawStreams).length) {
    issues.add('streams', 'must be a non-empty map "/path": { interval, events, loop }');
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const [rawPath, rawCfg] of Object.entries(rawStreams)) {
    const f = `streams[${rawPath}]`;
    if (!rawPath.startsWith('/')) {
      issues.add(f, `path ${JSON.stringify(rawPath)} must start with "/"`);
      continue;
    }
    if (/[?#\s]/.test(rawPath)) {
      issues.add(f, `path ${JSON.stringify(rawPath)} must not contain whitespace, query or fragment`);
      continue;
    }
    const path = rawPath.replace(/\/+$/, '') || '/';
    if (seen.has(path)) {
      issues.add(f, `duplicate stream path "${path}"`);
      continue;
    }
    seen.add(path);

    const collision = findEndpointCollision(path, endpoints);
    if (collision) issues.add(f, collision);

    if (!isObj(rawCfg)) {
      issues.add(f, `must be a map { interval, events, loop }; got ${typeName(rawCfg)}`);
      continue;
    }
    issues.unknownKeys(rawCfg, ['interval', 'events', 'loop'], f);

    let intervalOk = false;
    if (rawCfg.interval === undefined) {
      issues.add(`${f}.interval`, 'required; integer > 0 (milliseconds)');
    } else if (!isInt(rawCfg.interval) || rawCfg.interval <= 0 || rawCfg.interval > MAX_STREAM_INTERVAL) {
      issues.add(`${f}.interval`, `must be an integer > 0 and <= ${MAX_STREAM_INTERVAL} (milliseconds); got ${JSON.stringify(rawCfg.interval)}`);
    } else {
      intervalOk = true;
    }

    let eventsOk = false;
    if (!Array.isArray(rawCfg.events) || !rawCfg.events.length) {
      issues.add(`${f}.events`, 'required; must be a non-empty list with at least one event');
    } else if (rawCfg.events.some((ev) => ev === undefined)) {
      issues.add(`${f}.events`, 'every event must be a JSON-serializable value');
    } else {
      eventsOk = true;
    }

    let loop = false;
    if (rawCfg.loop !== undefined) {
      if (typeof rawCfg.loop !== 'boolean') issues.add(`${f}.loop`, 'must be true or false');
      else loop = rawCfg.loop;
    }

    if (!collision && intervalOk && eventsOk) {
      out.push({ path, interval: rawCfg.interval, events: rawCfg.events, loop });
    }
  }
  return out;
}

// ---------- scenario ----------

const SCENARIO_KEYS = ['name', 'description', 'seed', 'now', 'auth', 'world', 'endpoints', 'writes', 'streams', 'entry', 'path', 'expect'];

export function normalizeScenario(doc, file = '<scenario>') {
  const issues = new Issues();
  if (!isObj(doc)) throw new AtrezzoError(`${file}: a scenario must be a YAML map (got ${typeName(doc)})`);
  issues.unknownKeys(doc, SCENARIO_KEYS);
  if (typeof doc.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(doc.name)) issues.add('name', 'required; lowercase letters, digits and hyphens (kebab-case)');
  if (!isInt(doc.seed) || doc.seed < 0) issues.add('seed', `required; integer >= 0 (got ${JSON.stringify(doc.seed)})`);
  let now = DEFAULT_NOW;
  if (doc.now !== undefined) {
    const ms = typeof doc.now === 'string' ? Date.parse(doc.now) : Number.NaN;
    if (Number.isNaN(ms)) issues.add('now', 'must be an ISO 8601 date, e.g. 2025-01-15T09:00:00Z');
    else now = new Date(ms).toISOString();
  }
  const allPassthrough = Array.isArray(doc.endpoints) && doc.endpoints.length > 0 && doc.endpoints.every((ep) => isObj(ep) && ep.passthrough !== undefined);
  const world = doc.world === undefined && allPassthrough ? [] : normalizeWorld(doc.world, issues);
  const auth = normalizeAuth(doc.auth, world, issues);
  const endpoints = normalizeEndpoints(doc.endpoints, world, auth, doc.auth !== undefined, issues);
  const writes = normalizeWrites(doc.writes, world, auth, doc.auth !== undefined, issues, endpoints);
  const streams = normalizeStreams(doc.streams, endpoints, issues);

  let path = [];
  if (doc.path !== undefined) {
    if (!Array.isArray(doc.path) || doc.path.some((p) => typeof p !== 'string')) issues.add('path', 'must be a list of screen names');
    else path = doc.path;
  }
  let entry = null;
  if (doc.entry !== undefined) {
    if (typeof doc.entry !== 'string') issues.add('entry', 'must be a screen name');
    else {
      entry = doc.entry;
      if (path.length && path[0] !== entry) issues.add('entry', `must be the first screen of "path" ("${path[0]}")`);
    }
  }
  const expect = [];
  if (doc.expect !== undefined) {
    if (!Array.isArray(doc.expect)) issues.add('expect', 'must be a list of assertions');
    else doc.expect.forEach((it, i) => {
      const e = normalizeExpect(it, `expect[${i}]`, issues);
      if (!e) return;
      if (e.screen && path.length && !path.includes(e.screen)) issues.add(`expect[${i}].screen`, `"${e.screen}" is not in path (${path.join(' → ')})`);
      expect.push(e);
    });
  }
  if (issues.list.length) throw new AtrezzoError(`${file}: invalid scenario`, { issues: issues.list });
  const out = { name: doc.name, description: doc.description ?? null, seed: doc.seed, now, world, endpoints, entry, path, expect };
  if (auth) out.auth = auth; // only when declared: keeps scenario hashes stable
  if (writes.length) out.writes = writes; // same: absent unless declared
  if (streams.length) out.streams = streams; // same: absent unless declared
  return out;
}

export function loadScenario(file, { fixturesDir = null, checkFixtures = true } = {}) {
  const scenario = normalizeScenario(readYaml(file, 'scenario'), file);
  if (checkFixtures) {
    const resolved = resolvePassthroughs(scenario, { scenarioFile: file, fixturesDir });
    if (Object.keys(resolved).length) {
      Object.defineProperty(scenario, '_passthrough', { value: resolved, enumerable: false, configurable: true });
    }
  }
  return scenario;
}

// ---------- flow ----------

/** @param {string} file */
export function loadFlow(file) {
  const doc = readYaml(file, 'flow');
  const issues = new Issues();
  if (!isObj(doc)) throw new AtrezzoError(`${file}: a flow must be a YAML map`);
  issues.unknownKeys(doc, ['scenario', 'base_url', 'headers', 'storage', 'viewport', 'click_timeout', 'steps']);
  if (doc.scenario !== undefined && typeof doc.scenario !== 'string') issues.add('scenario', 'path to the scenario YAML (relative to the flow); omit it only to verify a real app without a mock');
  if (doc.base_url !== undefined && typeof doc.base_url !== 'string') issues.add('base_url', 'must be a URL');
  if (!Array.isArray(doc.steps) || !doc.steps.length) issues.add('steps', 'required; a list with at least one step');
  const headers = parseHeaders(doc.headers, 'headers', issues);
  const storage = parseStorage(doc.storage, 'storage', issues);
  let viewport = null;
  if (doc.viewport !== undefined) {
    if (!isObj(doc.viewport)) issues.add('viewport', 'must be a map { width, height }');
    else {
      issues.unknownKeys(doc.viewport, ['width', 'height'], 'viewport');
      for (const k of ['width', 'height']) if (!isInt(doc.viewport[k]) || doc.viewport[k] < 100 || doc.viewport[k] > 10000) issues.add(`viewport.${k}`, `integer between 100 and 10000; got ${JSON.stringify(doc.viewport[k])}`);
      viewport = { width: doc.viewport.width, height: doc.viewport.height };
    }
  }
  let clickTimeout = null;
  if (doc.click_timeout !== undefined) {
    if (!isInt(doc.click_timeout) || doc.click_timeout <= 0) issues.add('click_timeout', `must be a positive integer (milliseconds); got ${JSON.stringify(doc.click_timeout)}`);
    else clickTimeout = doc.click_timeout;
  }
  if (issues.list.length) throw new AtrezzoError(`${file}: invalid flow`, { issues: issues.list });

  const scenarioFile = doc.scenario === undefined ? null : resolve(dirname(file), doc.scenario);
  const scenario = scenarioFile ? loadScenario(scenarioFile) : null;
  const path = scenario?.path ?? [];
  const steps = [];
  doc.steps.forEach((st, i) => {
    const f = `steps[${i}]`;
    if (!isObj(st)) { issues.add(f, 'must be a map'); return; }
    issues.unknownKeys(st, ['screen', 'visit', 'wait_for', 'click', 'click_timeout', 'headers', 'storage', 'requests', 'expect', 'redirects_to', 'allow_redirect'], f);
    if (typeof st.screen !== 'string') issues.add(`${f}.screen`, 'required; the screen name');
    else if (path.length && !path.includes(st.screen)) issues.add(`${f}.screen`, `"${st.screen}" is not in the scenario path (${path.join(' → ')})`);
    let redirectsTo = null;
    if (st.redirects_to !== undefined) {
      if (typeof st.redirects_to !== 'string' || !/^(\/|https?:\/\/)/.test(st.redirects_to.trim())) {
        issues.add(`${f}.redirects_to`, 'must be a path starting with "/" or an http(s) URL (e.g. "/login")');
      } else {
        redirectsTo = st.redirects_to.trim();
      }
    }
    let allowRedirect = false;
    if (st.allow_redirect !== undefined) {
      if (typeof st.allow_redirect !== 'boolean') issues.add(`${f}.allow_redirect`, 'must be true or false');
      else allowRedirect = st.allow_redirect;
    }
    if (st.redirects_to !== undefined && st.allow_redirect !== undefined) {
      issues.add(f, 'use "redirects_to" or "allow_redirect", not both');
    }
    const click = [];
    if (st.click !== undefined) {
      if (typeof st.click === 'string') {
        if (st.click.trim() === '') issues.add(`${f}.click`, 'must be a non-empty selector or list of selectors');
        else click.push(st.click);
      } else if (Array.isArray(st.click)) {
        if (!st.click.length) issues.add(`${f}.click`, 'must be a non-empty selector or non-empty list of selectors');
        else st.click.forEach((sel, j) => {
          if (typeof sel !== 'string' || sel.trim() === '') issues.add(`${f}.click[${j}]`, 'must be a non-empty selector');
          else click.push(sel);
        });
      } else {
        issues.add(`${f}.click`, `must be a selector string or a list of selectors; got ${typeName(st.click)}`);
      }
    }
    let stepClickTimeout = null;
    if (st.click_timeout !== undefined) {
      if (!isInt(st.click_timeout) || st.click_timeout <= 0) issues.add(`${f}.click_timeout`, `must be a positive integer (milliseconds); got ${JSON.stringify(st.click_timeout)}`);
      else stepClickTimeout = st.click_timeout;
    }
    const requests = {};
    if (st.requests !== undefined) {
      if (!isObj(st.requests)) issues.add(`${f}.requests`, 'must be a map name: "GET /path"');
      else for (const [k, v] of Object.entries(st.requests)) {
        const m = typeof v === 'string' ? /^GET\s+(\/\S*)$/.exec(v.trim()) : null;
        if (!m) issues.add(`${f}.requests.${k}`, `format "GET /path?query" (GET only; the mock does not implement writes); got ${JSON.stringify(v)}`);
        else requests[k] = m[1];
      }
    }
    const expect = [];
    (Array.isArray(st.expect) ? st.expect : st.expect === undefined ? [] : (issues.add(`${f}.expect`, 'must be a list'), [])).forEach((it, j) => {
      const e = normalizeExpect(it, `${f}.expect[${j}]`, issues);
      if (e) expect.push(e);
    });
    const stepHeaders = parseHeaders(st.headers, `${f}.headers`, issues);
    const stepStorage = parseStorage(st.storage, `${f}.storage`, issues);
    steps.push({ screen: st.screen, visit: st.visit ?? null, waitFor: st.wait_for ?? null, click, clickTimeout: stepClickTimeout, redirectsTo, allowRedirect, headers: stepHeaders, storage: stepStorage, requests, expect });
  });

  // Scenario-level expectations go to their screen (default: last of path, else last step).
  const lastScreen = path.at(-1) ?? steps.at(-1)?.screen;
  (scenario?.expect ?? []).forEach((e, i) => {
    const screen = e.screen ?? lastScreen;
    const step = steps.find((s) => s.screen === screen);
    if (!step) issues.add(`scenario.expect[${i}]`, `screen "${screen}" has no step in the flow`);
    else step.expect.push({ ...e, fromScenario: true });
  });
  steps.forEach((st, i) => st.expect.forEach((e, j) => {
    const names = Object.keys(st.requests);
    if (!e.data) return;
    if (!e.data.request) {
      if (names.length === 1) e.data.request = names[0];
      else issues.add(`steps[${i}].expect[${j}].data.request`, `name the step request to use (${names.join(', ') || 'the step defines no requests'})`);
    } else if (!names.includes(e.data.request)) issues.add(`steps[${i}].expect[${j}].data.request`, `"${e.data.request}" is not in the step requests (${names.join(', ') || 'none'})`);
  }));
  if (issues.list.length) throw new AtrezzoError(`${file}: invalid flow`, { issues: issues.list });
  return { file, scenarioFile, scenario, baseUrl: doc.base_url ?? null, headers, storage, viewport, clickTimeout, steps };
}

export function scenarioNameFromFile(file) {
  return basename(file).replace(/\.(ya?ml|json)$/, '');
}
