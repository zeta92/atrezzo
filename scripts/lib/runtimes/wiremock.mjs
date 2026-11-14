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
  if (deps.length) out.push({ text: `${deps[0].name} in ${deps[0].where}`, weight: 3 });
  for (const pl of ctx.places) {
    for (const sub of ['.', 'wiremock']) {
      if (existsSync(join(pl.dir, sub, 'mappings')) && existsSync(join(pl.dir, sub, '__files'))) {
        out.push({ text: `mappings/ + __files/ in ${relative(ctx.root, join(pl.dir, sub)) || 'the root'}`, weight: 3 });
        return out.concat(scriptSignal(ctx));
      }
    }
  }
  return out.concat(scriptSignal(ctx));
}

function scriptSignal(ctx) {
  const s = [...ctx.scripts, ...ctx.compose].find((x) => /wiremock/i.test(x.text));
  return s ? [{ text: `"wiremock" in ${s.where}`, weight: 2 }] : [];
}

export const meta = metaFrom({
  id: 'wiremock',
  label: 'WireMock (static mappings + __files)',
  signals,
  none: 'no dependency, mappings/__files folders or docker-compose with wiremock',
  startHint: `docker run --rm -p 4010:8080 -v "$PWD/atrezzo/.generated/wiremock/<scenario>:/home/wiremock" wiremock/wiremock:${WIREMOCK_VERSION}`,
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
  add({}, 'no query');
  for (const f of ep.filters) {
    const { distinct } = columnInfo(rows, f);
    const hasNull = rows.some((r) => r[f] === null || r[f] === undefined);
    if (distinct.length > MAX_FILTER_VALUES) { skipped.push(`filter "${f}": ${distinct.length} distinct values (> ${MAX_FILTER_VALUES}); only the ones in flows`); continue; }
    for (const v of distinct) add({ [f]: v }, `filter ${f}`);
    if (hasNull) add({ [f]: 'null' }, `filter ${f}`);
  }
  if (ep.pagination) {
    const pg = ep.pagination;
    const sizes = [...new Set([pg.defaultLimit, pg.maxLimit].filter((x) => x !== null))];
    const total = rows.length;
    for (const size of sizes) {
      const pages = Math.max(1, Math.ceil(total / size));
      if (pages > MAX_PAGES) skipped.push(`pages of ${size}: ${pages} (> ${MAX_PAGES}); only the first ${MAX_PAGES}`);
      add({ [pg.limit]: String(size) }, `page of ${size}`);
      for (let i = 0; i < Math.min(pages, MAX_PAGES); i++) {
        add(pg.page ? { [pg.limit]: String(size), [pg.page]: String(i + 1) } : { [pg.limit]: String(size), [pg.offset]: String(i * size) }, `page of ${size}`);
      }
    }
    if (!sizes.length) skipped.push('pagination without default_limit/max_limit: only the pages flows request');
  }
  const known = new Set([...ep.filters, ...(ep.pagination ? [ep.pagination.limit, ep.pagination.page ?? ep.pagination.offset] : [])]);
  for (const r of requests) {
    const u = new URL(r, 'http://x');
    if ((u.pathname.replace(/\/+$/, '') || '/') !== ep.path) continue;
    const q = {};
    for (const [k, v] of u.searchParams) if (known.has(k)) q[k] = v;
    add(q, 'flow request');
  }
  return { combos: [...combos.values()], skipped, known: [...known].sort() };
}

const RESPONSE_HEADERS = ['content-type', 'x-total-count', 'x-atrezzo-scenario'];
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
      name: `${ep.path} · combination not pre-generated`,
      priority: 9,
      request: { method: 'GET', urlPath: ep.path },
      response: {
        status: 501,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        jsonBody: { error: `atrezzo did not pre-generate this query combination for ${ep.path}. WireMock does not run the projection: use atrezzo serve, or add the request to a flow and run atrezzo world again.`, generated: combos.map((c) => comboKey(c.query) || '(no query)') },
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
          name: `${ep.path}/{id} (body picked by template)`,
          priority: 1,
          request: { method: 'GET', urlPathPattern: `^${ep.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(${rows.map((r) => r.id).join('|')})$` },
          response: {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8', 'x-atrezzo-scenario': dataset.scenario },
            bodyFileName: `${p(dataset.scenario, base, 'id')}/{{request.pathSegments.[${seg}]}}.json`,
            transformers: ['response-template'],
          },
        });
      }
      mappings.push({
        name: `${ep.path}/{id} not found`,
        priority: 5,
        request: { method: 'GET', urlPathPattern: `^${ep.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+$` },
        response: { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' }, jsonBody: { error: `${ep.entity} does not exist in scenario "${dataset.scenario}"` } },
      });
    }
    stubs += mappings.length;
    files.push({ path: p(root, 'mappings', `${base}.json`), content: json({ mappings }) });
    notes.push(`${ep.path}: ${combos.length} pre-generated combinations${skipped.length ? ` (${skipped.join('; ')})` : ''}`);
  }
  notes.push(
    'lists: WireMock does NOT run the projection; combined filters, "a,b" lists, sort orders or pages not enumerated return 501 (explicit fallback), never a wrong page',
    'response templating only on the /{id} detail: bodyFileName with {{request.pathSegments}} (transformers: response-template declared in the mapping)',
    'parameters not declared in the scenario are ignored when matching (same as the engine); X-Atrezzo-Ignored is not emitted',
    `each scenario is its own WireMock root (${root}): do not mix two scenarios in the same mappings/ folder`,
  );
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    start: `docker run --rm -p ${config.mock.port}:8080 -v "$PWD/${root}:/home/wiremock" wiremock/wiremock:${WIREMOCK_VERSION}   ·   java -jar wiremock-standalone-${WIREMOCK_VERSION}.jar --root-dir ${root} --port ${config.mock.port}`,
    notes,
    stubs,
  };
}
