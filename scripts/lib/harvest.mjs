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
import { entityFields, templateFor } from './world.mjs';
import { createMockServer } from './serve.mjs';
import { isMutation, isSecretParam, missKey } from './misses.mjs';
import { loadPlaywright, chromeExecutable } from './verify.mjs';
import { parseTsTypes, resolveTypeForSegment } from './ts-types.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;
const ASSET = /\.(ico|png|jpe?g|gif|svg|webp|avif|css|js|mjs|cjs|map|html?|woff2?|ttf|otf|txt|webmanifest)$/i;
const SINGLETON_NAMES = new Set(['info', 'user', 'me', 'config', 'settings']);
const LIMIT_KEYS = ['limit', 'per_page', 'perPage', 'page_size', 'pageSize', 'size'];
const OFFSET_KEYS = ['offset', 'skip'];
const VALID_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const snake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();

function pluralize(s) {
  if (!s) return 'items';
  if (/s$/.test(s)) return s;
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(x|ch|sh)$/.test(s)) return `${s}es`;
  return `${s}s`;
}

function singularize(s) {
  if (/ies$/.test(s) && s.length > 4) return `${s.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/.test(s)) return s.slice(0, -2);
  return s.replace(/s$/, '');
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
        // Ignore embedded relations such as `tasks(count)` or `alias:tasks(*)`.
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
 * E.g. `/api/v2/projects/1/views/4/tasks` -> `{ path: '/api/v2/projects/:project_id/views/:view_id/tasks', params: [...], lastSeg: 'tasks', detailId: null }`.
 * Detail `/api/users/42` -> `{ path: '/api/users', params: [], lastSeg: 'users', detailId: '42' }`.
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

function shapeKey(path) {
  return path.replace(/\/:[^/]+/g, '/:');
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
    let changed = false;
    const entEntry = doc.world[existingEp.entity];
    if (existingEp.shape === 'object' && entityTotal(entEntry) === 0) {
      const ent = ensureEntityObject(doc.world, existingEp.entity, 1);
      ent.total = 1;
      changed = true;
      return {
        changed,
        record: {
          method: 'GET', path: existingEp.path, entity: existingEp.entity, shape: 'object',
          source: 'existing (total 0 → 1)', fields: ['id', ...Object.keys(ent.fields ?? {})],
          uninferrable: [],
        },
        notes,
      };
    }
    if (detailId !== null && existingEp.detail === false) {
      delete existingEp.detail;
      changed = true;
      return {
        changed,
        record: {
          method: 'GET', path: existingEp.path, entity: existingEp.entity, shape: existingEp.shape ?? 'array',
          source: 'existing (detail enabled)', fields: ['id'], uninferrable: [],
        },
        notes,
      };
    }
    if (detailId !== null && /^\d+$/.test(detailId)) {
      const wantId = Number(detailId);
      const curTotal = entityTotal(entEntry);
      if (wantId > curTotal && wantId <= 50) {
        const ent = ensureEntityObject(doc.world, existingEp.entity, wantId);
        ent.total = wantId;
        changed = true;
        return {
          changed,
          record: {
            method: 'GET', path: existingEp.path, entity: existingEp.entity, shape: existingEp.shape ?? 'array',
            source: `existing (total ${curTotal} → ${wantId})`, fields: ['id'], uninferrable: [],
          },
          notes,
        };
      }
      notes.push(`GET ${miss.example ?? miss.path}: detail id ${detailId} not in "${existingEp.entity}"`);
    }
    return { changed, notes };
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

  const queryFilters = [];
  for (const [k, vals] of qMap.entries()) {
    if (k === 'select' || k === 'head' || k === 'page' || LIMIT_KEYS.includes(k) || OFFSET_KEYS.includes(k)) continue;
    if (!VALID_IDENT.test(k)) { epUninferrable.push(`query parameter "${k}" (not a valid field name)`); continue; }
    queryFilters.push(k);
  }

  // Prepare/merge world entity (keeping all existing keys when entity already exists).
  const minTotal = shape === 'object' ? 1 : pagination ? 20 : 5;
  const detailNum = detailId && /^\d+$/.test(detailId) && Number(detailId) <= 50 ? Number(detailId) : 0;
  const entObj = ensureEntityObject(doc.world, entityName, Math.max(minTotal, detailNum));
  if (detailNum > entObj.total) entObj.total = detailNum;

  if (!entityLocked) {
    if (Object.keys(inferredFields).length > 0) {
      entObj.fields = { ...inferredFields, ...(isObj(entObj.fields) ? entObj.fields : {}) };
    }
    if (Object.keys(inferredValues).length > 0) {
      entObj.values = { ...inferredValues, ...(isObj(entObj.values) ? entObj.values : {}) };
    }
  } else if (isObj(entObj.fields) && Object.keys(inferredFields).length > 0) {
    entObj.fields = { ...inferredFields, ...entObj.fields };
  }

  // Bind path parameters (:project_id, :view_id, ...) to refs, fields, or null filter.
  const paramBindings = {};
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
      // Wait: if `pname` is e.g. `project` while parent fk is `project_id`, scenario.mjs handles `:project` -> `project_id` automatically!
    } else {
      const candidateFields = pname.endsWith('_id') ? [pname] : [pname, `${pname}_id`];
      const existingField = isObj(entObj.fields) ? candidateFields.find((f) => f in entObj.fields) : null;
      if (existingField) {
        entObj.values = isObj(entObj.values) ? entObj.values : {};
        if (!(existingField in entObj.values)) {
          entObj.values[existingField] = [obsNum ?? observed];
        }
      } else {
        paramBindings[`:${pname}`] = null;
      }
    }
  }

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
  if (Object.keys(paramBindings).length > 0) {
    const fMap = { ...paramBindings };
    for (const qk of queryFilters) fMap[qk] = qk;
    ep.filters = fMap;
  } else if (queryFilters.length > 0) {
    ep.filters = queryFilters;
  }
  if (pagination) ep.pagination = pagination;
  if (pick) ep.pick = pick;
  else if (shape !== 'array') ep.shape = shape;
  doc.endpoints.push(ep);

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
      uninferrable: epUninferrable,
    },
    notes,
  };
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
  });

  let pw = null;
  const discovered = [];
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
      try {
        const waiter = createPageWaiter(pw.page);
        await pw.page.goto(targetUrl);
        await waiter.wait();
        if (until) {
          await pw.page.locator(until).first().waitFor({ state: 'attached', timeout: 300 }).catch(() => {});
          if ((await pw.page.locator(until).count()) > 0) {
            stoppedReason = 'until';
            break;
          }
        }
      } finally {
        // Snapshot and disarm listener between rounds.
      }
      const { observed } = roundObs;
      roundObs = null;

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
        const key = missKey(gap.method, gap.path);
        const observedForGap = observed.filter((o) => missKey(o.method, o.pathname) === key);
        const merged = mergeGapIntoScenario(workingDoc, gap, { observedForGap, parsedTypes, typesLabel });
        for (const n of merged.notes) if (!globalNotes.includes(n)) globalNotes.push(n);
        if (merged.changed) {
          addedThisRound = true;
          if (merged.record) discovered.push({ ...merged.record, round });
        }
      }

      if (!addedThisRound) {
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

  return {
    scenarioName: workingDoc.name,
    targetUrl,
    roundsRun,
    maxRounds: rounds,
    stoppedReason,
    discovered,
    mutations: [...mutations.values()],
    uninferrable: [...new Set(globalNotes)],
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

  const uninferrable = [];
  for (const d of res.discovered) {
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
