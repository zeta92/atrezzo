// Diagnóstico de una aserción KO: función pura, sin I/O. Toda la evidencia llega en `ctx`.
//
// Cada hipótesis lleva dos ejes:
//   - `certainty`: 'confirmed' (demostrado con lo que hay en ctx), 'likely' (causa probable y
//     comprobada contra los datos), 'possible' (encaja con el síntoma, pero no se ha comprobado).
//   - `finding` (opcional): la observación que sí está demostrada, aunque la causa no lo esté.
// `confidence` (high/medium/low) es el campo antiguo: se mantiene igual para no romper el JSON.

// Parámetros de query que significan «ordena las filas»: si se ignora uno, el arreglo es `sorts:`,
// no un filtro con ese nombre (declarar `filters: { order: ... }` filtraría, nunca ordenaría).
export const SORT_PARAM_NAMES = new Set(['order', 'sort', 'sort_by', 'order_by', 'sortby', 'orderby', 'sort.by', 'sort.order', 'sorts.by', 'sorts.order']);
const DIRECTION_PARAMS = ['dir', 'direction'];
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
    for (const raw of query.getAll(n)) {
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
  // La dirección puede venir aparte: `sort_by=amount&order=desc`, `sort=amount&dir=desc`
  if (desc === null) {
    for (const k of [...SORT_PARAM_NAMES, ...DIRECTION_PARAMS]) {
      const v = query.get(k);
      if (isDir(v)) { desc = v.toLowerCase() === 'desc'; break; }
    }
  }
  return field ? { field, desc: !!desc } : null;
}

function compareValues(a, b) {
  const na = a === null || a === undefined;
  const nb = b === null || b === undefined;
  if (na || nb) return na === nb ? 0 : na ? 1 : -1; // los nulos, al final
  const x = Number(a);
  const y = Number(b);
  if (typeof a !== 'boolean' && typeof b !== 'boolean' && Number.isFinite(x) && Number.isFinite(y) && String(a).trim() !== '' && String(b).trim() !== '') return x - y;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * ¿Explica el orden ignorado el fallo? Solo si (1) los items no vienen en el orden pedido y
 * (2) reordenarlos pondría en la primera página las filas esperadas, cuando tal como vienen no.
 * «Primera página» = el `limit` de la query si recorta la respuesta; si no, tantas filas como
 * espera la aserción. Devuelve true, false o null (no se puede comprobar).
 */
function sortCounterfactual(ctx, exp, names) {
  if (!ctx.query || !ctx.items?.length) return null;
  const spec = parseSort(ctx.query, names);
  if (!spec || !ctx.items.some((it) => hasKey(it, spec.field))) return null;
  const sign = spec.desc ? -1 : 1;
  const cmp = (a, b) => {
    const va = a?.[spec.field];
    const vb = b?.[spec.field];
    const nullish = (v) => v === null || v === undefined;
    if (nullish(va) || nullish(vb)) return compareValues(va, vb); // los nulos, al final en ambas direcciones
    return sign * compareValues(va, vb);
  };
  const alreadySorted = ctx.items.every((it, i) => i === 0 || cmp(ctx.items[i - 1], it) <= 0);
  if (alreadySorted) return false;
  const limit = LIMIT_PARAMS.map((k) => Number(ctx.query.get(k))).find((n) => Number.isInteger(n) && n > 0);
  const target = exp.count ?? exp.min ?? exp.max;
  const window = limit && limit < ctx.items.length ? limit : target;
  if (!window) return null;
  const where = exp.data?.where;
  const topMatches = (list) => list.slice(0, window).filter((it) => whereMatch(it, where)).length;
  const sorted = [...ctx.items].sort(cmp);
  return !passes(exp, topMatches(ctx.items)) && passes(exp, topMatches(sorted));
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
 * ctx: { expected, obtained, driver, response?, items?, query?: URLSearchParams, matched?, fullMatched?, domCount? }
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
      const isSort = (n) => SORT_PARAM_NAMES.has(n.toLowerCase());
      const sorts = names.filter(isSort);
      const rest = names.filter((n) => !isSort(n));
      if (sorts.length) {
        const fits = sortCounterfactual(ctx, exp, sorts);
        if (fits) explainedByMock = true;
        add('ignored-sort', 'medium', fits ? 'likely' : 'possible',
          `the client orders by ${sorts.map((s) => `\`${s}\``).join(', ')} and the endpoint declares neither sorts: nor a sort: that matches, so the order was ignored. Add sorts: { by: ${sorts[0]}, fields: [<columns>] } (or sort: { by: ... }) to endpoints[]; declaring a filter named ${sorts[0]} would not fix the order.`,
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
      add('pagination-mismatch', 'high', 'likely', `the response has ${ctx.items.length} of ${total} items; unpaginated, ${ctx.fullMatched} match the condition, but this page has only ${ctx.matched}. Check the client's limit/offset or the endpoint's sort.`,
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
    if (ctx.domCount === undefined && ctx.fullMatched !== undefined && ctx.fullMatched !== target && ctx.matched === ctx.fullMatched) {
      add('world-mismatch', 'medium', explainedByMock ? 'possible' : 'likely', `the world has ${ctx.fullMatched} matching items and ${expectedText(exp)} were expected: check world (total/distribution) or the assertion's "where" condition.`,
        `unpaginated, ${ctx.fullMatched} items match; ${expectedText(exp)} were expected`);
    }
  } else if (ctx.domCount !== undefined) {
    add('no-data', 'low', 'possible', 'the assertion has no "data" to compare against the JSON; add data.request to tell a data failure from a screen failure.');
  }
  if (!hyps.length) add('no-hypothesis', 'low', 'possible', `obtained ${ctx.obtained}, expected ${expectedText(exp)}; no heuristic fits. Check the screen path and the selectors.`);
  return hyps;
}
