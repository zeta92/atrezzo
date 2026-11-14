// wiremock: static stubs. WireMock cannot run the projection (Handlebars has no
// sane way to filter + sort + slice an embedded array), so lists are
// PRE-COMPUTED: one mapping per query combination we can enumerate (no query,
// one filter value at a time, declared page sizes, and the exact requests of the
// flows). Response templating is used where it is reliable: the detail route
// picks its body file from the path segment. Anything else hits a 501 fallback
// that says so — never a wrong page.
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createEngine } from '../contract.mjs';
import { columnInfo, metaFrom, p, slug } from './common.mjs';

export const WIREMOCK_VERSION = '3.13.2';

function signals(ctx) {
  const out = [];
  const deps = ctx.depMatching(/wiremock/i);
  if (deps.length) out.push({ text: `${deps[0].name} en ${deps[0].where}`, weight: 3 });
  for (const pl of ctx.places) {
    for (const sub of ['.', 'wiremock']) {
      if (existsSync(join(pl.dir, sub, 'mappings')) && existsSync(join(pl.dir, sub, '__files'))) {
        out.push({ text: `mappings/ + __files/ en ${relative(ctx.root, join(pl.dir, sub)) || 'la raíz'}`, weight: 3 });
        return out.concat(scriptSignal(ctx));
      }
    }
  }
  return out.concat(scriptSignal(ctx));
}

function scriptSignal(ctx) {
  const s = [...ctx.scripts, ...ctx.compose].find((x) => /wiremock/i.test(x.text));
  return s ? [{ text: `"wiremock" en ${s.where}`, weight: 2 }] : [];
}

export const meta = metaFrom({
  id: 'wiremock',
  label: 'WireMock (mappings + __files estáticos)',
  signals,
  none: 'sin dependencias, carpetas mappings/__files ni docker-compose con wiremock',
  startHint: `docker run --rm -p 4010:8080 -v "$PWD/atrezzo/.generated/wiremock/<escenario>:/home/wiremock" wiremock/wiremock:${WIREMOCK_VERSION}`,
});

const MAX_FILTER_VALUES = 20;
const MAX_PAGES = 50;

/** Canonical key for a query combination (sorted params). */
const comboKey = (q) => Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&');

/** Enumerate the combinations to pre-compute for a list endpoint. */
export function combinations(ep, dataset, requests = []) {
  const rows = dataset.entities[ep.entity];
  const combos = new Map();
  const skipped = [];
  const add = (q, why) => { const k = comboKey(q); if (!combos.has(k)) combos.set(k, { query: q, why }); };
  add({}, 'sin query');
  for (const f of ep.filters) {
    const { distinct } = columnInfo(rows, f);
    const hasNull = rows.some((r) => r[f] === null || r[f] === undefined);
    if (distinct.length > MAX_FILTER_VALUES) { skipped.push(`filtro "${f}": ${distinct.length} valores distintos (> ${MAX_FILTER_VALUES}); solo los de los flujos`); continue; }
    for (const v of distinct) add({ [f]: v }, `filtro ${f}`);
    if (hasNull) add({ [f]: 'null' }, `filtro ${f}`);
  }
  if (ep.pagination) {
    const pg = ep.pagination;
    const sizes = [...new Set([pg.defaultLimit, pg.maxLimit].filter((x) => x !== null))];
    const total = rows.length;
    for (const size of sizes) {
      const pages = Math.max(1, Math.ceil(total / size));
      if (pages > MAX_PAGES) skipped.push(`páginas de ${size}: ${pages} (> ${MAX_PAGES}); solo las ${MAX_PAGES} primeras`);
      add({ [pg.limit]: String(size) }, `página de ${size}`);
      for (let i = 0; i < Math.min(pages, MAX_PAGES); i++) {
        add(pg.page ? { [pg.limit]: String(size), [pg.page]: String(i + 1) } : { [pg.limit]: String(size), [pg.offset]: String(i * size) }, `página de ${size}`);
      }
    }
    if (!sizes.length) skipped.push('paginación sin default_limit/max_limit: solo las páginas que pidan los flujos');
  }
  const known = new Set([...ep.filters, ...(ep.pagination ? [ep.pagination.limit, ep.pagination.page ?? ep.pagination.offset] : [])]);
  for (const r of requests) {
    const u = new URL(r, 'http://x');
    if ((u.pathname.replace(/\/+$/, '') || '/') !== ep.path) continue;
    const q = {};
    for (const [k, v] of u.searchParams) if (known.has(k)) q[k] = v;
    add(q, 'petición de un flujo');
  }
  return { combos: [...combos.values()], skipped, known: [...known].sort() };
}

const RESPONSE_HEADERS = ['content-type', 'x-total-count', 'x-atrezzo-escenario'];
const pickHeaders = (h) => Object.fromEntries(RESPONSE_HEADERS.filter((k) => h[k] !== undefined).map((k) => [k, h[k]]));
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * @param {{ dataset, config, requests?: string[] }} args  requests: "/path?query" from flows
 */
export function emit({ dataset, config, requests = [] }) {
  const root = p(config.generatedDir, 'wiremock', dataset.scenario);
  const engine = createEngine(dataset);
  const files = [];
  const notes = [];
  let stubs = 0;
  for (const ep of dataset.endpoints) {
    const base = slug(ep.path);
    const mappings = [];
    const { combos, skipped, known } = combinations(ep, dataset, requests);
    const used = new Set();
    for (const { query, why } of combos) {
      const r = engine.handle({ pathname: ep.path, query });
      let fname = slug((comboKey(query) || 'default').replace(/&/g, '__'));
      for (let i = 2; used.has(fname); i++) fname = `${fname}-${i}`;
      used.add(fname);
      const bodyFile = p(dataset.scenario, base, `${fname}.json`);
      files.push({ path: p(root, '__files', bodyFile), content: json(r.body) });
      const queryParameters = {};
      for (const k of known) queryParameters[k] = k in query ? { equalTo: query[k] } : { absent: true };
      mappings.push({
        name: `${ep.path}?${comboKey(query)} (${why})`,
        priority: 1,
        request: { method: 'GET', urlPath: ep.path, ...(known.length ? { queryParameters } : {}) },
        response: { status: r.status, headers: pickHeaders(r.headers), bodyFileName: bodyFile },
      });
    }
    mappings.push({
      name: `${ep.path} · combinación no pregenerada`,
      priority: 9,
      request: { method: 'GET', urlPath: ep.path },
      response: {
        status: 501,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        jsonBody: { error: `atrezzo no pregeneró esta combinación de query para ${ep.path}. WireMock no ejecuta la proyección: usa atrezzo serve, o añade la petición a un flujo y vuelve a ejecutar atrezzo world.`, generadas: combos.map((c) => comboKey(c.query) || '(sin query)') },
      },
    });
    if (ep.detail) {
      const rows = dataset.entities[ep.entity];
      const seg = ep.path.split('/').filter(Boolean).length;
      for (const row of rows) {
        files.push({ path: p(root, '__files', dataset.scenario, base, 'id', `${row.id}.json`), content: json(engine.handle({ pathname: `${ep.path}/${row.id}` }).body) });
      }
      if (rows.length) {
        mappings.push({
          name: `${ep.path}/{id} (cuerpo elegido por plantilla)`,
          priority: 1,
          request: { method: 'GET', urlPathPattern: `^${ep.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(${rows.map((r) => r.id).join('|')})$` },
          response: {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8', 'x-atrezzo-escenario': dataset.scenario },
            bodyFileName: `${p(dataset.scenario, base, 'id')}/{{request.pathSegments.[${seg}]}}.json`,
            transformers: ['response-template'],
          },
        });
      }
      mappings.push({
        name: `${ep.path}/{id} inexistente`,
        priority: 5,
        request: { method: 'GET', urlPathPattern: `^${ep.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+$` },
        response: { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' }, jsonBody: { error: `${ep.entity} no existe en el escenario "${dataset.scenario}"` } },
      });
    }
    stubs += mappings.length;
    files.push({ path: p(root, 'mappings', `${base}.json`), content: json({ mappings }) });
    notes.push(`${ep.path}: ${combos.length} combinaciones pregeneradas${skipped.length ? ` (${skipped.join('; ')})` : ''}`);
  }
  notes.push(
    'listas: WireMock NO ejecuta la proyección; filtros cruzados, listas "a,b", órdenes o páginas no enumeradas devuelven 501 (fallback explícito), nunca una página incorrecta',
    'response templating solo en el detalle /{id}: bodyFileName con {{request.pathSegments}} (transformers: response-template declarado en la mapping)',
    'parámetros no declarados en el escenario se ignoran al casar (igual que el motor); X-Atrezzo-Ignored no se emite',
    `cada escenario es una raíz WireMock propia (${root}): no mezcles dos escenarios en la misma carpeta mappings/`,
  );
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    start: `docker run --rm -p ${config.mock.port}:8080 -v "$PWD/${root}:/home/wiremock" wiremock/wiremock:${WIREMOCK_VERSION}   ·   java -jar wiremock-standalone-${WIREMOCK_VERSION}.jar --root-dir ${root} --port ${config.mock.port}`,
    notes,
    stubs,
  };
}
