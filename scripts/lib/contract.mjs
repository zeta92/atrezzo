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
  if (!/^\d+$/.test(raw)) return { error: `"${name}" debe ser un entero >= 0; recibido "${raw}"` };
  return { value: Number.parseInt(raw, 10) };
}

function matchesFilter(value, raw) {
  const wanted = raw.split(',');
  const v = value === null || value === undefined ? 'null' : String(value);
  return wanted.includes(v);
}

export function createEngine(dataset) {
  const routes = dataset.endpoints.map((ep) => ({ ...ep }));

  function withIncludes(row, ep) {
    if (!ep.include.length) return { ...row };
    const out = { ...row };
    const meta = dataset.schema[ep.entity];
    for (const [fk, target] of Object.entries(meta.refs)) {
      if (!ep.include.includes(target)) continue;
      const parent = dataset.entities[target].find((r) => r.id === row[fk]) ?? null;
      out[dataset.schema[target].singular] = parent ? { ...parent } : null;
    }
    return out;
  }

  function json(status, body, headers = {}) {
    return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'x-atrezzo-escenario': dataset.scenario, ...headers }, body };
  }

  /** Find the endpoint for a pathname: list route or `<path>/<id>` detail. */
  function match(pathname) {
    const clean = pathname.replace(/\/+$/, '') || '/';
    for (const ep of routes) {
      if (clean === ep.path) return { ep, id: null };
      if (ep.detail && clean.startsWith(`${ep.path}/`)) {
        const rest = clean.slice(ep.path.length + 1);
        if (rest && !rest.includes('/')) return { ep, id: rest };
      }
    }
    return null;
  }

  /**
   * @param {{ method?: string, pathname: string, query?: URLSearchParams | Record<string,string> }} req
   * @returns {{ status: number, headers: Record<string,string>, body: unknown } | null} null = not ours
   */
  function handle({ method = 'GET', pathname, query }) {
    const m = match(pathname);
    if (!m) return null;
    if (method !== 'GET' && method !== 'HEAD') {
      return json(405, { error: `atrezzo solo proyecta lecturas (GET); ${method} ${pathname} no está en el contrato` }, { allow: 'GET' });
    }
    const params = query instanceof URLSearchParams ? query : new URLSearchParams(query ?? {});
    const { ep, id } = m;
    const rows = dataset.entities[ep.entity];

    if (id !== null) {
      const row = rows.find((r) => String(r.id) === id);
      if (!row) return json(404, { error: `${ep.entity} ${id} no existe en el escenario "${dataset.scenario}"` });
      return json(200, withIncludes(row, ep));
    }

    const ignored = [];
    const reserved = ep.pagination ? [ep.pagination.limit, ep.pagination.offset] : [];
    let result = rows;
    for (const [key, raw] of params) {
      if (reserved.includes(key)) continue;
      if (ep.filters.includes(key)) result = result.filter((r) => matchesFilter(r[key], raw));
      else ignored.push(key);
    }

    const indexed = result.map((r, i) => [r, i]);
    indexed.sort(([a, ia], [b, ib]) => {
      for (const { field, dir } of ep.sort) {
        const c = compare(a[field], b[field]);
        if (c !== 0) return dir === 'desc' ? -c : c;
      }
      return ia - ib; // stable
    });
    result = indexed.map(([r]) => r);
    const total = result.length;

    let limit = null;
    let offset = 0;
    if (ep.pagination) {
      const l = parseNonNegInt(params.get(ep.pagination.limit), ep.pagination.limit);
      const o = parseNonNegInt(params.get(ep.pagination.offset), ep.pagination.offset);
      if (l.error || o.error) return json(400, { error: l.error || o.error });
      limit = l.value ?? ep.pagination.defaultLimit;
      if (limit !== null && ep.pagination.maxLimit !== null) limit = Math.min(limit, ep.pagination.maxLimit);
      offset = o.value ?? 0;
      result = result.slice(offset, limit === null ? undefined : offset + limit);
    }
    const page = result.map((r) => withIncludes(r, ep));
    const headers = { 'x-total-count': String(total) };
    if (ignored.length) headers['x-atrezzo-ignored'] = ignored.join(',');
    if (ep.shape === 'envelope') return json(200, { data: page, total, limit, offset }, headers);
    return json(200, page, headers);
  }

  return { match, handle, dataset };
}
