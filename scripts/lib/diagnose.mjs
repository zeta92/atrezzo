// Diagnóstico de una aserción KO: función pura, sin I/O. Toda la evidencia llega en `ctx`.
//
// Cada hipótesis lleva dos ejes:
//   - `certainty`: 'confirmed' (demostrado con lo que hay en ctx), 'likely' (causa probable y
//     comprobada contra los datos), 'possible' (encaja con el síntoma, pero no se ha comprobado).
//   - `finding` (opcional): la observación que sí está demostrada, aunque la causa no lo esté.
// `confidence` (high/medium/low) es el campo antiguo: se mantiene igual para no romper el JSON.

// Parámetros de query que significan «ordena las filas»: si se ignora uno, el arreglo es `sorts:`,
// no un filtro con ese nombre (declarar `filters: { order: ... }` filtraría, nunca ordenaría).
// Compared lowercased: `orderBy` (Mealie) is `orderby` here.
export const SORT_PARAM_NAMES = new Set(['order', 'sort', 'sort_by', 'order_by', 'sortby', 'orderby', 'sort.by', 'sort.order', 'sorts.by', 'sorts.order']);
// Direction-only names, lowercased (`orderDirection` is `orderdirection`). They are sort parameters only
// when the query sends them as asc/desc: `dir=left` or `direction=inbound` is an ignored filter, not a sort.
// Even as a sort parameter, a direction cannot be the `by:` of sorts:.
const DIRECTION_PARAMS = new Set(['dir', 'direction', 'orderdirection']);
// Field keys recognised only to infer `by:` for a lone ignored direction (PostgREST `by`, `sortField`).
// Never sort parameters by themselves: an ignored `by` stays a filter.
const FIELD_HINT_PARAMS = new Set(['by', 'sortfield']);
const lc = (n) => String(n).toLowerCase();
const isSortName = (n) => SORT_PARAM_NAMES.has(lc(n)) || DIRECTION_PARAMS.has(lc(n));
// Header and query keys are matched without case: the header may spell a key differently from the query.
const queryRaw = (query, n) => (query ? [...query].filter(([k]) => lc(k) === lc(n)).map(([, v]) => v) : []);
const queryValues = (query, n) => queryRaw(query, n).map((v) => String(v).trim()).filter(Boolean);
/** The query's own spelling of a key, for advice the client's code must match. */
const querySpelling = (query, n) => (query ? [...query.keys()].find((k) => lc(k) === lc(n)) : undefined) ?? n;
/** Does the query send this key, and only as asc/desc? Then it carries the direction (`dir=desc`, `order=desc`, `sort=desc`), never a field. */
function actsAsDirection(n, query) {
  const vals = queryValues(query, n);
  return vals.length > 0 && vals.every(isDir);
}
/** Is this ignored key a sort parameter? A sort name always; a direction-only name only when sent as asc/desc. */
const isSortKey = (n, query) => SORT_PARAM_NAMES.has(lc(n)) || (DIRECTION_PARAMS.has(lc(n)) && actsAsDirection(n, query));
/**
 * A field-sort key the client sent but the mock did not ignore (e.g. honoured by sorts.by), for a lone ignored
 * direction. `hints` also accepts FIELD_HINT_PARAMS (when that direction is the only ignored sort key).
 */
const queryFieldKey = (query, ignored, hints) => (query ? [...new Set(query.keys())].find((k) => (SORT_PARAM_NAMES.has(lc(k)) || (hints && FIELD_HINT_PARAMS.has(lc(k))))
  && !ignored.some((n) => lc(n) === lc(k)) && queryValues(query, k).some((v) => !isDir(v))) : undefined);
const LIMIT_PARAMS = ['limit', 'per_page', 'pageSize', 'page_size', 'take'];
const hasKey = (it, k) => it !== null && typeof it === 'object' && k in it;

// ---------- utilidades compartidas con verify.mjs ----------

export function header(h, name) {
  return typeof h?.get === 'function' ? h.get(name) : h?.[name] ?? null;
}

/** El mock respondió el `error:` que el escenario declara para el endpoint (respuesta legítima, no un fallo del mock). */
export const declaredError = (r) => header(r?.headers, 'x-atrezzo-error') === 'declared';

export function whereMatch(item, where) {
  if (!where) return true;
  return Object.entries(where).every(([k, w]) => {
    const values = Array.isArray(w) ? w : [w];
    return values.some((x) => String(x) === String(item?.[k] ?? null));
  });
}

export function expectedText(e) {
  if (e.count !== undefined) return `=${e.count}`;
  if (e.min !== undefined && e.max !== undefined) return `${e.min}..${e.max}`;
  if (e.min !== undefined) return `>=${e.min}`;
  return `<=${e.max}`;
}

export function passes(e, n) {
  if (e.count !== undefined) return n === e.count;
  if (e.min !== undefined && n < e.min) return false;
  if (e.max !== undefined && n > e.max) return false;
  return true;
}

// ---------- contrafactuales ----------

const isDir = (v) => /^(asc|desc)$/i.test(String(v ?? '').trim());

/** Lee de la query qué orden pidió el cliente. Devuelve { field, desc } o null si no se entiende. */
function parseSort(query, names) {
  let field = null;
  let desc = null;
  for (const n of names) {
    for (const raw of queryRaw(query, n)) {
      const v = String(raw).split(',')[0].trim();
      if (!v) continue;
      if (isDir(v)) { desc ??= v.toLowerCase() === 'desc'; continue; }
      // Formatos: `-campo`, `campo:desc`, `campo.desc` (PostgREST), `campo desc`, `campo`
      const m = /^([+-]?)([\w.]+?)(?:[:. ](asc|desc))?$/i.exec(v);
      if (!m || field) continue;
      field = m[2];
      if (m[1] === '-') desc = true;
      else if (m[3]) desc = m[3].toLowerCase() === 'desc';
    }
  }
  // La dirección puede venir aparte: `sort_by=amount&order=desc`, `sort=amount&dir=desc`,
  // `orderBy=rating&orderDirection=desc` (la clave de la query, sin distinguir mayúsculas)
  if (desc === null) {
    for (const [k, v] of query) {
      if (isSortName(k) && isDir(v)) { desc = v.trim().toLowerCase() === 'desc'; break; }
    }
  }
  return field ? { field, desc: !!desc } : null;
}

/** The mock's comparator, exactly (contract.mjs `compare`): nulls last ascending, numbers numerically, everything else as strings. */
function compareLikeMock(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : 1;
}

const rowKey = (it) => (it !== null && typeof it === 'object' && it.id !== undefined && it.id !== null ? `id:${JSON.stringify(it.id)}` : JSON.stringify(it));

/** Dónde cae la página servida dentro del conjunto completo: su offset, o null si no es un tramo contiguo de él. */
function servedOffset(full, page) {
  const first = rowKey(page[0]);
  const at = full.findIndex((it) => rowKey(it) === first);
  if (at < 0 || at + page.length > full.length) return null;
  return page.every((it, i) => rowKey(it) === rowKey(full[at + i])) ? at : null;
}

/**
 * ¿Explica el orden ignorado el fallo? Solo si (1) los items no vienen en el orden pedido y
 * (2) reordenarlos pondría en la página las filas esperadas, cuando tal como vienen no.
 * Con el conjunto completo demostrado (ctx.fullItems), se ordena el conjunto entero y se toma la
 * misma página que sirvió el servidor (mismo offset y tamaño). Sin él, solo se reordena esta
 * página: «primera página» = el `limit` de la query si recorta la respuesta; si no, tantas filas
 * como espera la aserción. Devuelve false, null (no se puede comprobar), true (comprobado sobre
 * la página), { proof: 'full', total, field, desc, matched, served } (comprobado sobre el conjunto
 * completo) o { proof: 'unsliced', total } (la página sola cuadra, pero no es un tramo del conjunto
 * completo demostrado: solo possible).
 */
function sortCounterfactual(ctx, exp, names) {
  if (!ctx.query || !ctx.items?.length) return null;
  const spec = parseSort(ctx.query, names);
  const offset = ctx.fullItems?.length ? servedOffset(ctx.fullItems, ctx.items) : null;
  if (offset !== null) return fullSetSortCounterfactual(ctx, exp, spec, offset);
  const unsliced = ctx.fullItems?.length > 0;
  if (!spec || !ctx.items.some((it) => hasKey(it, spec.field))) return null;
  const cmp = sortComparator(spec);
  const alreadySorted = ctx.items.every((it, i) => i === 0 || cmp(ctx.items[i - 1], it) <= 0);
  if (alreadySorted) return false;
  const limit = LIMIT_PARAMS.map((k) => Number(ctx.query.get(k))).find((n) => Number.isInteger(n) && n > 0);
  const target = exp.count ?? exp.min ?? exp.max;
  const window = limit && limit < ctx.items.length ? limit : target;
  if (!window) return null;
  const where = exp.data?.where;
  const topMatches = (list) => list.slice(0, window).filter((it) => whereMatch(it, where)).length;
  const sorted = [...ctx.items].sort(cmp);
  const fits = !passes(exp, topMatches(ctx.items)) && passes(exp, topMatches(sorted));
  return fits && unsliced ? { proof: 'unsliced', total: ctx.fullItems.length } : fits;
}

/** Orders as the mock would: the direction flips the whole comparison, so desc puts nulls first. */
function sortComparator(spec) {
  const sign = spec.desc ? -1 : 1;
  return (a, b) => sign * compareLikeMock(a?.[spec.field], b?.[spec.field]);
}

function fullSetSortCounterfactual(ctx, exp, spec, offset) {
  const full = ctx.fullItems;
  if (!spec || !full.some((it) => hasKey(it, spec.field))) return null;
  const cmp = sortComparator(spec);
  if (full.every((it, i) => i === 0 || cmp(full[i - 1], it) <= 0)) return false;
  const where = exp.data?.where;
  const count = (list) => list.filter((it) => whereMatch(it, where)).length;
  // Tie order caveat: Array#sort is stable, so equal keys keep their served order. For the unsorted B3
  // endpoint that is the world's generation order, as the mock's own sort would see it; an endpoint with a
  // different default sort could break ties differently, and move tied rows across the page boundary.
  const page = [...full].sort(cmp).slice(offset, offset + ctx.items.length);
  const matched = count(page);
  // served comes from the items, not ctx.matched: a direct caller may omit it.
  const served = count(ctx.items);
  return !passes(exp, served) && passes(exp, matched) ? { proof: 'full', total: full.length, field: spec.field, desc: spec.desc, matched, served } : false;
}

/**
 * ¿Explica el filtro ignorado el fallo? Filtra los items devueltos por el valor que mandó el
 * cliente: si el recuento cambia y coincide con lo esperado, sí. true, false o null (sin query).
 */
function filterCounterfactual(ctx, exp, names) {
  if (!ctx.query || !ctx.items) return null;
  const params = names.filter((p) => ctx.query.has(p) && ctx.items.some((it) => hasKey(it, p)));
  if (!params.length) return null;
  const wanted = Object.fromEntries(params.map((p) => [p, ctx.query.getAll(p).flatMap((v) => String(v).split(',')).map((s) => s.trim())]));
  const n = ctx.items.filter((it) => whereMatch(it, wanted) && whereMatch(it, exp.data?.where)).length;
  return n !== ctx.matched && passes(exp, n);
}

// ---------- diagnóstico ----------

/**
 * Hipótesis para una aserción fallida.
 * ctx: { expected, obtained, driver, response?, items?, query?: URLSearchParams, matched?, fullMatched?, fullItems?,
 *        domCount?, clampedLimit?: { param, requested, max, defaulted? } (the endpoint's max_limit cut the client's
 *        page size, or its default_limit when defaulted) }
 * fullMatched and fullItems are only set when the full set was proven (verify.mjs's probe walked every page,
 * adding up to X-Total-Count): fullItems is that set in served order, fullMatched how many of it match the
 * assertion's where. fullItems is internal: it feeds the full-set sort counterfactual and never reaches the report.
 * pagination-mismatch is likely, or possible when an ignored sort is proven over fullItems to explain the page
 * and no clampedLimit is present.
 * Cada hipótesis: { type, confidence, certainty, evidence, finding? }.
 */
export function diagnose(row, ctx) {
  const hyps = [];
  const add = (type, confidence, certainty, evidence, finding) => hyps.push({ type, confidence, certainty, evidence, ...(finding ? { finding } : {}) });
  const exp = row.expect;
  const target = exp.count ?? exp.min ?? exp.max;
  const r = ctx.response;
  // Si el mock ignoró parámetros, el JSON no es el que el cliente pidió: «el JSON cuadra» deja de
  // estar demostrado. Y si un contrafactual ya explica el fallo, el mundo queda descartado como causa.
  let mockIgnored = false;
  let explainedByMock = false;
  // The ignored order, proven over the full set, explains a short page: then the page size is not the
  // cause, unless max_limit cut it too (ctx.clampedLimit).
  let sortProven = false;
  if (r && declaredError(r)) {
    add('declared-error', 'high', 'confirmed', `the scenario declares error: { status: ${r.status} } on this endpoint, so it answers ${r.status} by design (${JSON.stringify(r.body).slice(0, 120)}) and no rows; a step that expects data cannot pass. Expect the error state on the screen, or drop error: from the endpoint.`,
      `the endpoint answered the declared error ${r.status}`);
  } else if (r && r.status !== 200) {
    add('non-200-response', 'high', 'confirmed', `the request returned ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`, `the request returned ${r.status}`);
  }
  if (r) {
    const ignored = header(r.headers, 'x-atrezzo-ignored');
    if (ignored) {
      mockIgnored = true;
      const names = String(ignored).split(',').map((s) => s.trim()).filter(Boolean);
      const isSort = (n) => isSortKey(n, ctx.query);
      const sorts = names.filter(isSort);
      const rest = names.filter((n) => !isSort(n));
      if (sorts.length) {
        // The field key (`by:`) and the direction key (`order:`) are separate, whatever order they arrive in.
        // Any sort key the query sends only as asc/desc (`order=desc`, `sort=desc`, `dir=desc`) is the direction.
        const isDirKey = (n) => actsAsDirection(n, ctx.query);
        const dirKey = sorts.find(isDirKey);
        const ignoredBy = sorts.find((n) => !isDirKey(n));
        // A lone ignored direction: the field key may be in the query, not ignored (e.g. sorts: { by } without order:).
        const queryBy = !ignoredBy && dirKey ? queryFieldKey(ctx.query, names, sorts.length === 1) : undefined;
        const byKey = ignoredBy ?? queryBy;
        // Advice in the query's own spelling: the header may list a key lowercased.
        const spell = (n) => querySpelling(ctx.query, n);
        const listed = [...sorts.filter((n) => !isDirKey(n)), ...sorts.filter(isDirKey)].map((s) => `\`${s}\``).join(', ');
        const fits = byKey ? sortCounterfactual(ctx, exp, queryBy ? [queryBy, ...sorts] : sorts) : null;
        // A page-only fit on a page that is not a slice of the proven full set stays possible.
        const unsliced = fits?.proof === 'unsliced';
        if (fits && !unsliced) explainedByMock = true;
        if (fits?.proof === 'full') sortProven = true;
        const proof = sortProven ? ` Counterfactual: sorting the full set (${fits.total} items) by ${fits.field} ${fits.desc ? 'desc' : 'asc'} puts ${fits.matched} matching items on this page; as served it has ${fits.served}.`
          : unsliced ? ` Sorting this page alone would fit the expectation, but the served page is not a slice of the proven full set (${fits.total} items), so the full-set counterfactual could not check it.` : '';
        const notFilter = `declaring a filter named ${sorts.join(' or ')} would not fix the order.`;
        const advice = `sorts: { by: ${spell(byKey)}${dirKey ? `, order: ${spell(dirKey)}` : ''}, fields: [<columns>] }`;
        add('ignored-sort', 'medium', fits && !unsliced ? 'likely' : 'possible', queryBy
          ? `the client sends the sort direction ${listed} next to the field key \`${queryBy}\` (in the query, not ignored) and the endpoint declares no sort direction that matches, so the direction was ignored. Declare ${advice} on the endpoint in endpoints[] (add order: ${spell(dirKey)} to an existing sorts:); ${notFilter}${proof}`
          : byKey
            ? `the client orders by ${listed} and the endpoint declares neither sorts: nor a sort: that matches, so the order was ignored. Add ${advice} (or sort: { by: ... }) to endpoints[]; ${notFilter}${proof}`
            : `the client sends the sort direction ${listed} and the endpoint declares neither sorts: nor a sort: that matches, so the order was ignored. The field key cannot be inferred from the ignored parameters or the query: add sorts: { by: <the client's field parameter>, order: ${spell(dirKey)}, fields: [<columns>] } to endpoints[]; ${notFilter}`,
          `the mock ignored ${sorts.join(', ')} (x-atrezzo-ignored header)`);
      }
      if (rest.length) {
        const fits = filterCounterfactual(ctx, exp, rest);
        if (fits) explainedByMock = true;
        add('undeclared-filter', 'medium', fits ? 'likely' : 'possible',
          `the client sends parameters the contract does not declare as filters, so they were ignored: ${rest.join(', ')}. If the client expects the server to filter, add them to endpoints[].filters.`,
          `the mock ignored ${rest.join(', ')} (x-atrezzo-ignored header)`);
      }
    }
  }
  if (ctx.items) {
    const total = Number(header(r?.headers, 'x-total-count'));
    if (Number.isFinite(total) && total > ctx.items.length && ctx.fullMatched !== undefined && ctx.fullMatched >= target && ctx.matched < target) {
      const c = ctx.clampedLimit;
      const fix = !c ? `Check the client's limit/offset or the endpoint's sort.`
        : c.defaulted
          ? `The client sends no ${c.param} and the endpoint's pagination has default_limit: ${c.requested} with max_limit: ${c.max}, so the page is cut to ${c.max}: raise max_limit, lower default_limit or page through.`
          : `The client asks for ${c.param}=${c.requested} and the endpoint's pagination has max_limit: ${c.max}, so the page is cut to ${c.max}: raise max_limit or page through.`;
      // A proven ignored order explains the short page, unless max_limit also cut it: both can hold at once.
      add('pagination-mismatch', 'high', sortProven && !c ? 'possible' : 'likely', `the response has ${ctx.items.length} of ${total} items; across the full set, ${ctx.fullMatched} match the condition, but this page has only ${ctx.matched}. ${fix}`,
        `the page carries ${ctx.items.length} of ${total} items`);
    }
    const ids = ctx.items.map((i) => i?.id).filter((x) => x !== undefined);
    const unique = new Set(ids).size;
    const dup = ids.length - unique;
    if (dup > 0) {
      // Solo es probable si el DOM pinta justo una fila por id distinto.
      add('dedupe-by-id', 'high', ctx.domCount === unique ? 'likely' : 'possible', `${dup} repeated ids in the response; if the client dedupes by id it renders ${unique} rows.`,
        `${dup} repeated ids in the response`);
    }
    const nullFields = {};
    for (const it of ctx.items) for (const [k, v] of Object.entries(it ?? {})) if (v === null) nullFields[k] = (nullFields[k] ?? 0) + 1;
    const nullRows = ctx.items.filter((it) => Object.values(it ?? {}).some((v) => v === null)).length;
    if (nullRows > 0) {
      // Nunca confirmed: que falten justo las filas con nulos cuadra, pero no demuestra por qué.
      const strong = ctx.domCount !== undefined && ctx.domCount === ctx.matched - nullRows;
      add('null-field', strong ? 'high' : 'low', strong ? 'likely' : 'possible', `${nullRows} items with null fields (${Object.entries(nullFields).map(([k, n]) => `${k}: ${n}`).join(', ')}); if the client drops them or crashes rendering them, rows go missing. See references/assumptions.md.`,
        `${nullRows} items with null fields`);
    }
    if (ctx.domCount !== undefined && ctx.domCount < ctx.matched && dup === 0 && nullRows === 0) {
      add('client-side-filter', 'medium', mockIgnored ? 'possible' : 'likely', `the JSON has ${ctx.matched} matching items, the DOM shows ${ctx.domCount}: the client filters or hides items. The scenario is right; look at the component.`,
        `the JSON has ${ctx.matched} matching items and the DOM shows ${ctx.domCount}`);
    }
    if (ctx.domCount !== undefined && ctx.matched === target && ctx.domCount !== target) {
      add('render', 'high', mockIgnored ? 'possible' : 'confirmed', `the mock delivers exactly what was expected (${target}); the difference is in the screen, not the scenario. Do not regenerate the world.`,
        `the JSON carries the expected ${target} and the DOM shows ${ctx.domCount}: the failure is in the screen`);
    }
    // The verified full set decides: if it holds fewer matches than needed, no page can reach the
    // expectation, whatever this page carries (it may be clamped). Over the count/max, it is the
    // world only when this page is over it too (the page's own excess comes from the world); a page
    // below the expectation of a set with enough matches points at the client's paging, not the
    // world (pagination-mismatch above), so then the page must be the set.
    const need = exp.count ?? exp.min;
    const upper = exp.count ?? exp.max;
    const worldShort = ctx.fullMatched !== undefined && need !== undefined && ctx.fullMatched < need;
    const worldOver = ctx.fullMatched !== undefined && upper !== undefined && ctx.fullMatched > upper && ctx.matched > upper;
    if (ctx.domCount === undefined && ctx.fullMatched !== undefined && ctx.fullMatched !== target && (ctx.matched === ctx.fullMatched || worldShort || worldOver)) {
      add('world-mismatch', 'medium', explainedByMock ? 'possible' : 'likely', `the world has ${ctx.fullMatched} matching items and ${expectedText(exp)} were expected: check world (total/distribution) or the assertion's "where" condition.`,
        `across the full set, ${ctx.fullMatched} items match; ${expectedText(exp)} were expected`);
    }
  } else if (ctx.domCount !== undefined) {
    add('no-data', 'low', 'possible', 'the assertion has no "data" to compare against the JSON; add data.request to tell a data failure from a screen failure.');
  }
  if (!hyps.length) add('no-hypothesis', 'low', 'possible', `obtained ${ctx.obtained}, expected ${expectedText(exp)}; no heuristic fits. Check the screen path and the selectors.`);
  return hyps;
}
