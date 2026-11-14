// Strict parsing/validation of scenario (escenario) and flow (flujo) files.
// Every error names the field and the reason, in Spanish.
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseYaml, YamlError } from './yaml.mjs';
import { AtrezzoError } from './errors.mjs';
import { templateFor, entityFields } from './world.mjs';

export const DEFAULT_NOW = '2025-01-15T09:00:00.000Z';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'lista' : isObj(v) ? 'mapa' : typeof v === 'number' ? 'número' : typeof v === 'string' ? 'texto' : typeof v);

class Issues {
  constructor() { this.list = []; }
  add(field, reason) { this.list.push(`campo "${field}": ${reason}`); }
  unknownKeys(obj, allowed, field) {
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) this.add(field ? `${field}.${k}` : k, `campo desconocido (permitidos: ${allowed.join(', ')})`);
    }
  }
}

function readYaml(file, what) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    throw new AtrezzoError(`No se puede leer el ${what} ${file}: ${e.code === 'ENOENT' ? 'no existe' : e.message}`);
  }
  try { return parseYaml(text, file); } catch (e) {
    if (e instanceof YamlError) throw new AtrezzoError(e.message);
    throw e;
  }
}

// ---------- expectations (shared by scenario and flow) ----------

function normalizeExpect(item, field, issues) {
  if (!isObj(item)) { issues.add(field, `debe ser un mapa con "selector" y "count" o "min"/"max"; es ${typeName(item)}`); return null; }
  issues.unknownKeys(item, ['selector', 'count', 'min', 'max', 'screen', 'data', 'label'], field);
  const out = {};
  if (typeof item.selector !== 'string' || item.selector.trim() === '') issues.add(`${field}.selector`, 'falta; cada aserción necesita un selector CSS no vacío');
  else out.selector = item.selector;
  for (const k of ['count', 'min', 'max']) {
    if (item[k] === undefined) continue;
    if (!isInt(item[k]) || item[k] < 0) issues.add(`${field}.${k}`, `debe ser un entero >= 0; es ${JSON.stringify(item[k])}`);
    else out[k] = item[k];
  }
  if (item.count !== undefined && (item.min !== undefined || item.max !== undefined)) issues.add(field, 'usa "count" exacto o "min"/"max", no ambos');
  if (item.count === undefined && item.min === undefined && item.max === undefined) issues.add(field, 'falta "count" o "min"/"max"');
  if (isInt(out.min) && isInt(out.max) && out.min > out.max) issues.add(field, `min (${out.min}) es mayor que max (${out.max})`);
  if (item.screen !== undefined) {
    if (typeof item.screen !== 'string') issues.add(`${field}.screen`, 'debe ser texto');
    else out.screen = item.screen;
  }
  if (item.label !== undefined) out.label = String(item.label);
  if (item.data !== undefined) {
    if (!isObj(item.data)) issues.add(`${field}.data`, 'debe ser un mapa { request, where, pick }');
    else {
      issues.unknownKeys(item.data, ['request', 'where', 'pick'], `${field}.data`);
      const d = {};
      if (item.data.request !== undefined) d.request = String(item.data.request);
      if (item.data.where !== undefined) {
        if (!isObj(item.data.where)) issues.add(`${field}.data.where`, 'debe ser un mapa campo: valor');
        else d.where = item.data.where;
      }
      if (item.data.pick !== undefined) d.pick = String(item.data.pick);
      out.data = d;
    }
  }
  return out;
}

// ---------- world ----------

const ENTITY_KEYS = ['total', 'distribucion', 'campo_distribucion', 'valor', 'ref', 'nulos', 'valores', 'dias'];

function normalizeWorld(world, issues) {
  if (!isObj(world)) { issues.add('world', `obligatorio; debe ser un mapa entidad: cantidad (es ${typeName(world)})`); return []; }
  const names = Object.keys(world);
  if (!names.length) { issues.add('world', 'debe declarar al menos una entidad'); return []; }
  const specs = [];
  for (const name of names) {
    const f = `world.${name}`;
    if (!/^[a-z][a-z0-9_]*$/.test(name)) issues.add(f, 'el nombre de entidad debe ser minúsculas, dígitos o "_"');
    let raw = world[name];
    if (isInt(raw)) raw = { total: raw };
    if (!isObj(raw)) { issues.add(f, `debe ser un entero o un mapa con "total"; es ${typeName(raw)}`); continue; }
    issues.unknownKeys(raw, ENTITY_KEYS, f);
    const t = templateFor(name);
    const spec = { name, count: 0, refs: [], distribution: null, amount: null, nulls: {}, pools: {}, days: 90 };
    if (!isInt(raw.total) || raw.total < 0) issues.add(`${f}.total`, `obligatorio; entero >= 0 (es ${JSON.stringify(raw.total)})`);
    else spec.count = raw.total;

    if (raw.distribucion !== undefined) {
      const field = raw.campo_distribucion ?? t.statusField ?? 'estado';
      if (!isObj(raw.distribucion) || !Object.keys(raw.distribucion).length) issues.add(`${f}.distribucion`, 'debe ser un mapa valor: cantidad no vacío');
      else {
        let sum = 0;
        for (const [v, c] of Object.entries(raw.distribucion)) {
          if (!isInt(c) || c < 0) issues.add(`${f}.distribucion.${v}`, `debe ser un entero >= 0; es ${JSON.stringify(c)}`);
          else sum += c;
        }
        if (isInt(raw.total) && sum !== raw.total) issues.add(`${f}.distribucion`, `la suma (${sum}) no coincide con total (${raw.total})`);
        spec.distribution = { field: String(field), counts: { ...raw.distribucion } };
      }
    } else if (t.statusField) {
      spec.distribution = { field: t.statusField, counts: { [t.defaultStatus]: spec.count } };
    }

    const valor = raw.valor ?? t.defaultAmount;
    if (valor !== undefined) {
      if (!isObj(valor)) issues.add(`${f}.valor`, 'debe ser un mapa { min, max, moneda }');
      else {
        issues.unknownKeys(valor, ['min', 'max', 'moneda'], `${f}.valor`);
        const { min, max, moneda = 'EUR' } = valor;
        if (typeof min !== 'number' || typeof max !== 'number') issues.add(`${f}.valor`, '"min" y "max" son obligatorios y numéricos');
        else if (min > max) issues.add(`${f}.valor`, `min (${min}) es mayor que max (${max})`);
        else if (min < 0) issues.add(`${f}.valor.min`, 'no puede ser negativo');
        else spec.amount = { min, max, moneda: String(moneda) };
      }
    }

    if (raw.ref !== undefined) {
      const refs = Array.isArray(raw.ref) ? raw.ref : [raw.ref];
      refs.forEach((r, i) => {
        if (typeof r !== 'string') issues.add(`${f}.ref[${i}]`, 'debe ser el nombre de una entidad');
        else if (!names.includes(r)) issues.add(`${f}.ref`, `la entidad "${r}" no está declarada en world (hay: ${names.join(', ')})`);
        else if (r === name) issues.add(`${f}.ref`, 'una entidad no puede referenciarse a sí misma');
        else spec.refs.push(r);
      });
    } else if (t.defaultRef) {
      spec.refs = t.defaultRef.filter((r) => names.includes(r));
    }

    if (raw.dias !== undefined) {
      if (!isInt(raw.dias) || raw.dias <= 0) issues.add(`${f}.dias`, 'debe ser un entero > 0');
      else spec.days = raw.dias;
    }
    if (raw.valores !== undefined) {
      if (!isObj(raw.valores)) issues.add(`${f}.valores`, 'debe ser un mapa campo: [valores]');
      else for (const [k, list] of Object.entries(raw.valores)) {
        if (k === 'id') issues.add(`${f}.valores.id`, 'el id lo asigna atrezzo');
        else if (!Array.isArray(list) || !list.length) issues.add(`${f}.valores.${k}`, 'debe ser una lista no vacía');
        else spec.pools[k] = list;
      }
    }
    specs.push({ spec, raw, f });
  }

  // Second pass: things that depend on other entities / final field lists.
  const counts = Object.fromEntries(specs.map(({ spec }) => [spec.name, spec.count]));
  for (const { spec, raw, f } of specs) {
    for (const r of spec.refs) {
      if (spec.count > 0 && counts[r] === 0) issues.add(`${f}.ref`, `"${spec.name}" referencia a "${r}" pero "${r}" tiene 0 elementos; los ids no existirían`);
    }
    if (raw.nulos !== undefined) {
      const fields = entityFields(spec);
      if (!isObj(raw.nulos)) issues.add(`${f}.nulos`, 'debe ser un mapa campo: cantidad');
      else for (const [k, n] of Object.entries(raw.nulos)) {
        if (k === 'id') issues.add(`${f}.nulos.id`, 'el id nunca puede ser nulo');
        else if (!fields.includes(k)) issues.add(`${f}.nulos.${k}`, `el campo no existe en "${spec.name}" (campos: ${fields.join(', ')})`);
        else if (!isInt(n) || n < 0 || n > spec.count) issues.add(`${f}.nulos.${k}`, `debe ser un entero entre 0 y ${spec.count}`);
        else spec.nulls[k] = n;
      }
    }
  }
  return specs.map(({ spec }) => spec);
}

// ---------- endpoints ----------

const ENDPOINT_KEYS = ['path', 'entity', 'filters', 'pagination', 'sort', 'include', 'shape', 'detail'];

function parseSort(raw, fields, f, issues) {
  if (raw === undefined) return [{ field: 'id', dir: 'asc' }];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  list.forEach((s, i) => {
    if (typeof s !== 'string' || !s) { issues.add(`${f}.sort[${i}]`, 'debe ser un campo, con "-" delante para descendente'); return; }
    const dir = s.startsWith('-') ? 'desc' : 'asc';
    const field = s.replace(/^[-+]/, '');
    if (!fields.includes(field)) issues.add(`${f}.sort`, `el campo "${field}" no existe (campos: ${fields.join(', ')})`);
    else out.push({ field, dir });
  });
  return out;
}

function normalizeEndpoints(endpoints, world, issues) {
  if (!Array.isArray(endpoints) || !endpoints.length) { issues.add('endpoints', 'obligatorio; lista con al menos un endpoint'); return []; }
  const byName = Object.fromEntries(world.map((s) => [s.name, s]));
  const seen = new Set();
  const out = [];
  endpoints.forEach((ep, i) => {
    const f = `endpoints[${i}]`;
    if (!isObj(ep)) { issues.add(f, `debe ser un mapa; es ${typeName(ep)}`); return; }
    issues.unknownKeys(ep, ENDPOINT_KEYS, f);
    if (typeof ep.path !== 'string' || !ep.path.startsWith('/')) { issues.add(`${f}.path`, 'obligatorio; debe empezar por "/"'); return; }
    if (/[?#:]/.test(ep.path)) issues.add(`${f}.path`, 'sin query, fragmentos ni parámetros ":x" (el detalle /:id se genera solo)');
    const path = ep.path.replace(/\/+$/, '') || '/';
    if (seen.has(path)) issues.add(`${f}.path`, `duplicado: "${path}"`);
    seen.add(path);
    if (ep.entity === undefined) { issues.add(`${f}.entity`, `falta; indica qué entidad del mundo proyecta "${path}"`); return; }
    const spec = byName[ep.entity];
    if (!spec) { issues.add(`${f}.entity`, `"${ep.entity}" no está declarada en world (hay: ${Object.keys(byName).join(', ') || 'ninguna'})`); return; }
    const fields = entityFields(spec);
    const filters = [];
    if (ep.filters !== undefined) {
      if (!Array.isArray(ep.filters)) issues.add(`${f}.filters`, 'debe ser una lista de campos');
      else ep.filters.forEach((fl, j) => {
        if (!fields.includes(fl)) issues.add(`${f}.filters[${j}]`, `el campo "${fl}" no existe en "${spec.name}" (campos: ${fields.join(', ')})`);
        else filters.push(fl);
      });
    }
    let pagination = null;
    if (ep.pagination !== undefined && ep.pagination !== null) {
      if (!isObj(ep.pagination)) issues.add(`${f}.pagination`, 'debe ser un mapa { param_limit, param_offset, default_limit, max_limit }');
      else {
        issues.unknownKeys(ep.pagination, ['param_limit', 'param_offset', 'default_limit', 'max_limit'], `${f}.pagination`);
        pagination = {
          limit: String(ep.pagination.param_limit ?? 'limit'),
          offset: String(ep.pagination.param_offset ?? 'offset'),
          defaultLimit: null,
          maxLimit: null,
        };
        for (const [k, dest] of [['default_limit', 'defaultLimit'], ['max_limit', 'maxLimit']]) {
          const v = ep.pagination[k];
          if (v === undefined) continue;
          if (!isInt(v) || v <= 0) issues.add(`${f}.pagination.${k}`, 'debe ser un entero > 0');
          else pagination[dest] = v;
        }
      }
    }
    const include = [];
    if (ep.include !== undefined) {
      const list = Array.isArray(ep.include) ? ep.include : [ep.include];
      list.forEach((inc) => {
        if (!spec.refs.includes(inc)) issues.add(`${f}.include`, `"${inc}" no es una referencia de "${spec.name}" (refs: ${spec.refs.join(', ') || 'ninguna'})`);
        else include.push(inc);
      });
    }
    const shape = ep.shape ?? 'array';
    if (!['array', 'envelope'].includes(shape)) issues.add(`${f}.shape`, 'debe ser "array" o "envelope"');
    if (ep.detail !== undefined && typeof ep.detail !== 'boolean') issues.add(`${f}.detail`, 'debe ser true o false');
    out.push({
      path, entity: spec.name, filters, pagination,
      sort: parseSort(ep.sort, fields, f, issues), include, shape, detail: ep.detail ?? true,
    });
  });
  return out;
}

// ---------- scenario ----------

const SCENARIO_KEYS = ['name', 'description', 'seed', 'now', 'world', 'endpoints', 'entry', 'path', 'expect'];

export function normalizeScenario(doc, file = '<escenario>') {
  const issues = new Issues();
  if (!isObj(doc)) throw new AtrezzoError(`${file}: el escenario debe ser un mapa YAML (es ${typeName(doc)})`);
  issues.unknownKeys(doc, SCENARIO_KEYS);
  if (typeof doc.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(doc.name)) issues.add('name', 'obligatorio; minúsculas, dígitos y guiones (kebab-case)');
  if (!isInt(doc.seed) || doc.seed < 0) issues.add('seed', `obligatorio; entero >= 0 (es ${JSON.stringify(doc.seed)})`);
  let now = DEFAULT_NOW;
  if (doc.now !== undefined) {
    const ms = typeof doc.now === 'string' ? Date.parse(doc.now) : Number.NaN;
    if (Number.isNaN(ms)) issues.add('now', 'debe ser una fecha ISO 8601, p. ej. 2025-01-15T09:00:00Z');
    else now = new Date(ms).toISOString();
  }
  const world = normalizeWorld(doc.world, issues);
  const endpoints = normalizeEndpoints(doc.endpoints, world, issues);

  let path = [];
  if (doc.path !== undefined) {
    if (!Array.isArray(doc.path) || doc.path.some((p) => typeof p !== 'string')) issues.add('path', 'debe ser una lista de nombres de pantalla');
    else path = doc.path;
  }
  let entry = null;
  if (doc.entry !== undefined) {
    if (typeof doc.entry !== 'string') issues.add('entry', 'debe ser el nombre de una pantalla');
    else {
      entry = doc.entry;
      if (path.length && path[0] !== entry) issues.add('entry', `debe ser la primera pantalla de "path" ("${path[0]}")`);
    }
  }
  const expect = [];
  if (doc.expect !== undefined) {
    if (!Array.isArray(doc.expect)) issues.add('expect', 'debe ser una lista de aserciones');
    else doc.expect.forEach((it, i) => {
      const e = normalizeExpect(it, `expect[${i}]`, issues);
      if (!e) return;
      if (e.screen && path.length && !path.includes(e.screen)) issues.add(`expect[${i}].screen`, `"${e.screen}" no está en path (${path.join(' → ')})`);
      expect.push(e);
    });
  }
  if (issues.list.length) throw new AtrezzoError(`${file}: escenario inválido`, { issues: issues.list });
  return { name: doc.name, description: doc.description ?? null, seed: doc.seed, now, world, endpoints, entry, path, expect };
}

export function loadScenario(file) {
  return normalizeScenario(readYaml(file, 'escenario'), file);
}

// ---------- flow ----------

export function loadFlow(file) {
  const doc = readYaml(file, 'flujo');
  const issues = new Issues();
  if (!isObj(doc)) throw new AtrezzoError(`${file}: el flujo debe ser un mapa YAML`);
  issues.unknownKeys(doc, ['escenario', 'base_url', 'steps']);
  if (typeof doc.escenario !== 'string') issues.add('escenario', 'obligatorio; ruta al YAML del escenario (relativa al flujo)');
  if (doc.base_url !== undefined && typeof doc.base_url !== 'string') issues.add('base_url', 'debe ser una URL');
  if (!Array.isArray(doc.steps) || !doc.steps.length) issues.add('steps', 'obligatorio; lista con al menos un paso');
  if (issues.list.length) throw new AtrezzoError(`${file}: flujo inválido`, { issues: issues.list });

  const scenarioFile = resolve(dirname(file), doc.escenario);
  const scenario = loadScenario(scenarioFile);
  const steps = [];
  doc.steps.forEach((st, i) => {
    const f = `steps[${i}]`;
    if (!isObj(st)) { issues.add(f, 'debe ser un mapa'); return; }
    issues.unknownKeys(st, ['screen', 'visit', 'wait_for', 'requests', 'expect'], f);
    if (typeof st.screen !== 'string') issues.add(`${f}.screen`, 'obligatorio; nombre de la pantalla');
    else if (scenario.path.length && !scenario.path.includes(st.screen)) issues.add(`${f}.screen`, `"${st.screen}" no está en el path del escenario (${scenario.path.join(' → ')})`);
    const requests = {};
    if (st.requests !== undefined) {
      if (!isObj(st.requests)) issues.add(`${f}.requests`, 'debe ser un mapa nombre: "GET /ruta"');
      else for (const [k, v] of Object.entries(st.requests)) {
        const m = typeof v === 'string' ? /^GET\s+(\/\S*)$/.exec(v.trim()) : null;
        if (!m) issues.add(`${f}.requests.${k}`, `formato "GET /ruta?query" (solo GET; el mock no implementa escrituras); es ${JSON.stringify(v)}`);
        else requests[k] = m[1];
      }
    }
    const expect = [];
    (Array.isArray(st.expect) ? st.expect : st.expect === undefined ? [] : (issues.add(`${f}.expect`, 'debe ser una lista'), [])).forEach((it, j) => {
      const e = normalizeExpect(it, `${f}.expect[${j}]`, issues);
      if (e) expect.push(e);
    });
    steps.push({ screen: st.screen, visit: st.visit ?? null, waitFor: st.wait_for ?? null, requests, expect });
  });

  // Scenario-level expectations go to their screen (default: last of path, else last step).
  const lastScreen = scenario.path.at(-1) ?? steps.at(-1)?.screen;
  scenario.expect.forEach((e, i) => {
    const screen = e.screen ?? lastScreen;
    const step = steps.find((s) => s.screen === screen);
    if (!step) issues.add(`escenario.expect[${i}]`, `la pantalla "${screen}" no tiene paso en el flujo`);
    else step.expect.push({ ...e, fromScenario: true });
  });
  steps.forEach((st, i) => st.expect.forEach((e, j) => {
    const names = Object.keys(st.requests);
    if (!e.data) return;
    if (!e.data.request) {
      if (names.length === 1) e.data.request = names[0];
      else issues.add(`steps[${i}].expect[${j}].data.request`, `indica qué petición del paso usar (${names.join(', ') || 'el paso no define requests'})`);
    } else if (!names.includes(e.data.request)) issues.add(`steps[${i}].expect[${j}].data.request`, `"${e.data.request}" no está en requests del paso (${names.join(', ') || 'ninguna'})`);
  }));
  if (issues.list.length) throw new AtrezzoError(`${file}: flujo inválido`, { issues: issues.list });
  return { file, scenarioFile, scenario, baseUrl: doc.base_url ?? null, steps };
}

export function scenarioNameFromFile(file) {
  return basename(file).replace(/\.ya?ml$/, '');
}
