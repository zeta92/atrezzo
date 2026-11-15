// Strict parsing/validation of scenario and flow files.
// Every error names the field and the reason.
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseYaml, YamlError } from './yaml.mjs';
import { AtrezzoError } from './errors.mjs';
import { templateFor, entityFields, RENAMED_TEMPLATES } from './world.mjs';
import { parseHeaders } from './headers.mjs';
import { env as readEnv } from './env.mjs';

export const DEFAULT_NOW = '2025-01-15T09:00:00.000Z';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
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

const ENTITY_KEYS = ['total', 'distribution', 'distribution_field', 'amount', 'ref', 'nulls', 'values', 'days', 'fields'];

/** Types accepted in `fields` (a list of values = enum). */
export const FIELD_TYPES = ['string', 'integer', 'number', 'boolean', 'date', 'email', 'uuid', 'url'];

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
          else if (Array.isArray(type)) {
            if (!type.length || type.some((v) => v !== null && typeof v === 'object')) issues.add(ff, 'must be a non-empty list of scalar values (enum)');
            else fields[k] = type;
          } else if (!FIELD_TYPES.includes(type)) issues.add(ff, `unknown type ${JSON.stringify(type)} (types: ${FIELD_TYPES.join(', ')} or a list of values)`);
          else fields[k] = type;
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
  for (const { spec, raw, f } of specs) {
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
  }
  return specs.map(({ spec }) => spec);
}

// ---------- endpoints ----------

const ENDPOINT_KEYS = ['path', 'entity', 'filters', 'pagination', 'sort', 'include', 'shape', 'detail', 'pick'];

function parseSort(raw, fields, f, issues) {
  if (raw === undefined) return [{ field: 'id', dir: 'asc' }];
  const list = Array.isArray(raw) ? raw : [raw];
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

function normalizeEndpoints(endpoints, world, issues) {
  if (!Array.isArray(endpoints) || !endpoints.length) { issues.add('endpoints', 'required; a list with at least one endpoint'); return []; }
  const byName = Object.fromEntries(world.map((s) => [s.name, s]));
  const seen = new Set();
  const out = [];
  endpoints.forEach((ep, i) => {
    const f = `endpoints[${i}]`;
    if (!isObj(ep)) { issues.add(f, `must be a map; got ${typeName(ep)}`); return; }
    issues.unknownKeys(ep, ENDPOINT_KEYS, f);
    if (typeof ep.path !== 'string' || !ep.path.startsWith('/')) { issues.add(`${f}.path`, 'required; must start with "/"'); return; }
    if (/[?#:]/.test(ep.path)) issues.add(`${f}.path`, 'no query, fragment or ":x" parameters (the /:id detail route is generated automatically)');
    const path = ep.path.replace(/\/+$/, '') || '/';
    if (seen.has(path)) issues.add(`${f}.path`, `duplicate: "${path}"`);
    seen.add(path);
    if (ep.entity === undefined) { issues.add(`${f}.entity`, `missing; name the world entity that "${path}" projects`); return; }
    const spec = byName[ep.entity];
    if (!spec) { issues.add(`${f}.entity`, `"${ep.entity}" is not declared in world (declared: ${Object.keys(byName).join(', ') || 'none'})`); return; }
    const fields = entityFields(spec);
    const filters = [];
    if (ep.filters !== undefined) {
      if (!Array.isArray(ep.filters)) issues.add(`${f}.filters`, 'must be a list of fields');
      else ep.filters.forEach((fl, j) => {
        if (!fields.includes(fl)) issues.add(`${f}.filters[${j}]`, `field "${fl}" does not exist in "${spec.name}" (fields: ${fields.join(', ')})`);
        else filters.push(fl);
      });
    }
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
    if (ep.include !== undefined) {
      const list = Array.isArray(ep.include) ? ep.include : [ep.include];
      list.forEach((inc) => {
        if (!spec.refs.includes(inc)) issues.add(`${f}.include`, `"${inc}" is not a reference of "${spec.name}" (refs: ${spec.refs.join(', ') || 'none'})`);
        else include.push(inc);
      });
    }
    let shape = ep.shape ?? 'array';
    if (!['array', 'envelope'].includes(shape)) issues.add(`${f}.shape`, 'must be "array" or "envelope"');
    let pick = null;
    if (ep.pick !== undefined) {
      if (typeof ep.pick !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ep.pick)) issues.add(`${f}.pick`, 'envelope key that holds the list (e.g. data, items); a single key');
      else if (ep.shape === 'array') issues.add(`${f}.pick`, 'incompatible with shape: array (pick implies an envelope)');
      else { pick = ep.pick; shape = 'envelope'; }
    }
    if (ep.detail !== undefined && typeof ep.detail !== 'boolean') issues.add(`${f}.detail`, 'must be true or false');
    const norm = {
      path, entity: spec.name, filters, pagination,
      sort: parseSort(ep.sort, fields, f, issues), include, shape, detail: ep.detail ?? true,
    };
    if (pick) norm.pick = pick; // only when declared: keeps 0.1 scenario hashes stable
    out.push(norm);
  });
  return out;
}

// ---------- scenario ----------

const SCENARIO_KEYS = ['name', 'description', 'seed', 'now', 'world', 'endpoints', 'entry', 'path', 'expect'];

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
  const world = normalizeWorld(doc.world, issues);
  const endpoints = normalizeEndpoints(doc.endpoints, world, issues);

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
  return { name: doc.name, description: doc.description ?? null, seed: doc.seed, now, world, endpoints, entry, path, expect };
}

export function loadScenario(file) {
  return normalizeScenario(readYaml(file, 'scenario'), file);
}

// ---------- flow ----------

/**
 * @param {string} file
 * @param {{ env?: Record<string, string|undefined> }} [opts]  env: source for ${VAR} in headers
 */
export function loadFlow(file, { env = readEnv() } = {}) {
  const doc = readYaml(file, 'flow');
  const issues = new Issues();
  if (!isObj(doc)) throw new AtrezzoError(`${file}: a flow must be a YAML map`);
  issues.unknownKeys(doc, ['scenario', 'base_url', 'headers', 'viewport', 'steps']);
  if (doc.scenario !== undefined && typeof doc.scenario !== 'string') issues.add('scenario', 'path to the scenario YAML (relative to the flow); omit it only to verify a real app without a mock');
  if (doc.base_url !== undefined && typeof doc.base_url !== 'string') issues.add('base_url', 'must be a URL');
  if (!Array.isArray(doc.steps) || !doc.steps.length) issues.add('steps', 'required; a list with at least one step');
  const headers = parseHeaders(doc.headers, 'headers', issues, env);
  let viewport = null;
  if (doc.viewport !== undefined) {
    if (!isObj(doc.viewport)) issues.add('viewport', 'must be a map { width, height }');
    else {
      issues.unknownKeys(doc.viewport, ['width', 'height'], 'viewport');
      for (const k of ['width', 'height']) if (!isInt(doc.viewport[k]) || doc.viewport[k] < 100 || doc.viewport[k] > 10000) issues.add(`viewport.${k}`, `integer between 100 and 10000; got ${JSON.stringify(doc.viewport[k])}`);
      viewport = { width: doc.viewport.width, height: doc.viewport.height };
    }
  }
  if (issues.list.length) throw new AtrezzoError(`${file}: invalid flow`, { issues: issues.list });

  const scenarioFile = doc.scenario === undefined ? null : resolve(dirname(file), doc.scenario);
  const scenario = scenarioFile ? loadScenario(scenarioFile) : null;
  const path = scenario?.path ?? [];
  const steps = [];
  doc.steps.forEach((st, i) => {
    const f = `steps[${i}]`;
    if (!isObj(st)) { issues.add(f, 'must be a map'); return; }
    issues.unknownKeys(st, ['screen', 'visit', 'wait_for', 'headers', 'requests', 'expect'], f);
    if (typeof st.screen !== 'string') issues.add(`${f}.screen`, 'required; the screen name');
    else if (path.length && !path.includes(st.screen)) issues.add(`${f}.screen`, `"${st.screen}" is not in the scenario path (${path.join(' → ')})`);
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
    const stepHeaders = parseHeaders(st.headers, `${f}.headers`, issues, env);
    steps.push({ screen: st.screen, visit: st.visit ?? null, waitFor: st.wait_for ?? null, headers: stepHeaders, requests, expect });
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
  return { file, scenarioFile, scenario, baseUrl: doc.base_url ?? null, headers, viewport, steps };
}

export function scenarioNameFromFile(file) {
  return basename(file).replace(/\.(ya?ml|json)$/, '');
}
