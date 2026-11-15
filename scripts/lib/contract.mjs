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
  if (!/^\d+$/.test(raw)) return { error: `"${name}" must be an integer >= 0; got "${raw}"` };
  return { value: Number.parseInt(raw, 10) };
}

function matchesFilter(value, raw) {
  const wanted = raw.split(',');
  const v = value === null || value === undefined ? 'null' : String(value);
  return wanted.includes(v);
}

/** Split a PostgREST `select` on top-level commas (commas inside `(...)` belong to an embed). */
function splitSelect(raw) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of raw) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

// `child(count)` or `alias:child(count)`; nothing else is a count.
const COUNT_ITEM = /^(?:([A-Za-z_]\w*)\s*:\s*)?([A-Za-z_]\w*)\(count\)$/;

/** Value of a request header from a Headers object or a plain (node) header map, case-insensitive. */
function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  if (key === undefined) return null;
  const v = headers[key];
  return Array.isArray(v) ? v.join(',') : String(v);
}

const wantsCount = (headers) => (headerValue(headers, 'prefer') ?? '').split(',').some((p) => /^count=(exact|planned|estimated)$/.test(p.trim()));

export function createEngine(dataset) {
  const routes = dataset.endpoints.map((ep) => ({ ...ep }));

  /**
   * Counted relations asked in `select`: [{ key, byParent }] for every `child(count)` whose child
   * entity refs this endpoint's entity, counted over the same in-memory world the rows come from.
   * `honoured` = every select item is `*` or such a count (otherwise `select` is reported as ignored).
   */
  function countsFor(ep, select) {
    if (select === null) return { counts: [], honoured: true };
    const counts = [];
    let honoured = true;
    for (const item of splitSelect(select)) {
      if (item === '*') continue;
      const m = COUNT_ITEM.exec(item);
      const meta = m && Object.hasOwn(dataset.schema, m[2]) ? dataset.schema[m[2]] : undefined;
      const fk = meta ? Object.keys(meta.refs).find((k) => meta.refs[k] === ep.entity) : undefined;
      if (fk === undefined) { honoured = false; continue; }
      const byParent = new Map();
      for (const r of dataset.entities[m[2]]) if (r[fk] !== null && r[fk] !== undefined) byParent.set(r[fk], (byParent.get(r[fk]) ?? 0) + 1);
      counts.push({ key: m[1] ?? m[2], byParent });
    }
    return { counts, honoured };
  }

  function withCounts(row, counts) {
    for (const { key, byParent } of counts) row[key] = [{ count: byParent.get(row.id) ?? 0 }];
    return row;
  }

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

  // Child rows per parent id, for `embed`: built once per (child, parent) pair on first use.
  const childIndex = new Map();
  function childrenOf(child, parent) {
    const key = `${child}>${parent}`;
    if (!childIndex.has(key)) {
      const meta = dataset.schema[child];
      const fk = Object.keys(meta.refs).find((k) => meta.refs[k] === parent);
      const byParent = new Map();
      for (const r of dataset.entities[child]) {
        if (r[fk] === null || r[fk] === undefined) continue;
        if (!byParent.has(r[fk])) byParent.set(r[fk], []);
        byParent.get(r[fk]).push(r);
      }
      childIndex.set(key, byParent);
    }
    return childIndex.get(key);
  }

  /** `embed: [views]`: every row carries the list of child rows that point at it (world order). */
  function withEmbeds(row, ep) {
    for (const child of ep.embed ?? []) row[child] = (childrenOf(child, ep.entity).get(row.id) ?? []).map((r) => ({ ...r }));
    return row;
  }

  /** A row as an endpoint answers it: parents (`include`), children (`embed`) and counts. */
  const shapeRow = (row, ep, counts) => withCounts(withEmbeds(withIncludes(row, ep), ep), counts);

  /** " under project_id=1" for error messages of parameterised paths ("" otherwise). */
  function where(ep, params) {
    const bound = (ep.params ?? []).filter((p) => p.field !== null);
    return bound.length ? ` under ${bound.map((p) => `${p.field}=${params[p.name]}`).join(', ')}` : '';
  }

  function json(status, body, headers = {}) {
    return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'x-atrezzo-scenario': dataset.scenario, ...headers }, body };
  }

  // Path segments per route; a `:name` segment captures one segment of the request.
  const compiled = routes.map((ep) => ({ ep, segs: ep.path.split('/') }));

  /** Captured parameters when `parts` fits `segs` segment by segment, else null. */
  function fit(segs, parts) {
    if (segs.length !== parts.length) return null;
    const out = {};
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].startsWith(':')) {
        if (!parts[i]) return null;
        let v = parts[i];
        try { v = decodeURIComponent(v); } catch { /* keep it raw */ }
        out[segs[i].slice(1)] = v;
      } else if (segs[i] !== parts[i]) return null;
    }
    return out;
  }

  /**
   * Find the endpoint for a pathname: a list route first (the most literal one, i.e. the fewest
   * parameters, wins; ties in declaration order), then a `<path>/<id>` detail route.
   */
  function match(pathname) {
    const clean = pathname.replace(/\/+$/, '') || '/';
    const parts = clean.split('/');
    let best = null;
    for (const { ep, segs } of compiled) {
      const params = fit(segs, parts);
      if (params && (!best || Object.keys(params).length < Object.keys(best.params).length)) best = { ep, id: null, params };
    }
    if (best) return best;
    const id = parts.at(-1);
    if (!id || parts.length < 2) return null;
    for (const { ep, segs } of compiled) {
      if (!ep.detail) continue;
      const params = fit(segs, parts.slice(0, -1));
      if (params) return { ep, id, params };
    }
    return null;
  }

  /** Rows the path parameters allow: each bound parameter is an equality on its field (null = any). */
  function byParams(rows, ep, params) {
    const bound = (ep.params ?? []).filter((p) => p.field !== null);
    if (!bound.length) return rows;
    return rows.filter((r) => bound.every((p) => r[p.field] !== null && r[p.field] !== undefined && String(r[p.field]) === params[p.name]));
  }

  /**
   * @param {{ method?: string, pathname: string, query?: URLSearchParams | Record<string,string>,
   *   headers?: Headers | Record<string, string | string[]> }} req
   * @returns {{ status: number, headers: Record<string,string>, body: unknown, miss?: true } | null}
   *   null = not ours (body null = no body: a count-only answer; miss = a `shape: object` endpoint
   *   whose entity has no rows, which `serve` records as a gap)
   */
  function handle({ method = 'GET', pathname, query, headers }) {
    const m = match(pathname);
    if (!m) return null;
    if (method !== 'GET' && method !== 'HEAD') {
      return json(405, { error: `atrezzo only projects reads (GET); ${method} ${pathname} is not in the contract` }, { allow: 'GET' });
    }
    const params = query instanceof URLSearchParams ? query : new URLSearchParams(query ?? {});
    const { ep, id } = m;
    // A parameterised path (`/projects/:project_id/tasks`) only sees the rows its parameters name.
    const rows = byParams(dataset.entities[ep.entity], ep, m.params);
    // PostgREST parameters; a declared filter of the same name keeps its meaning.
    const select = ep.filters.includes('select') ? null : params.get('select');
    const { counts, honoured } = countsFor(ep, select);
    const head = ep.filters.includes('head') ? null : params.get('head');

    if (id !== null) {
      const row = rows.find((r) => String(r.id) === id);
      if (!row) return json(404, { error: `${ep.entity} ${id} does not exist${where(ep, m.params)} in scenario "${dataset.scenario}"` });
      return json(200, shapeRow(row, ep, counts));
    }

    const ignored = [];
    const reserved = ep.pagination ? [ep.pagination.limit, ep.pagination.page ?? ep.pagination.offset] : [];
    let result = rows;
    for (const [key, raw] of params) {
      if (reserved.includes(key)) continue;
      if (ep.filters.includes(key)) result = result.filter((r) => matchesFilter(r[key], raw));
      else if (key === 'select' && honoured) continue;
      else if (key === 'head' && (raw === 'true' || raw === 'false')) continue;
      else ignored.push(key);
    }

    // Count only: `head=true`, or a HEAD request with `Prefer: count=exact`. Empty body and
    // `Content-Range: 0-<n-1>/<n>` over every row that passes the filters (pagination does not apply).
    if (head === 'true' || (method === 'HEAD' && wantsCount(headers))) {
      const n = result.length;
      const h = { 'x-total-count': String(n), 'content-range': n ? `0-${n - 1}/${n}` : '0-0/0' };
      if (ignored.length) h['x-atrezzo-ignored'] = ignored.join(',');
      return json(200, null, h);
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

    // Singleton (`shape: object`): the first row after filters and sort, as a JSON object.
    if (ep.shape === 'object') {
      const h = ignored.length ? { 'x-atrezzo-ignored': ignored.join(',') } : {};
      if (!dataset.entities[ep.entity].length) {
        // An empty singleton is a missing entity, not a client error: same body as a gap, and
        // `miss: true` so `serve` records it in misses like any other undeclared route.
        const gap = `GET ${ep.path}`;
        const res = json(404, {
          error: `${ep.entity} has no rows in scenario "${dataset.scenario}"; ${ep.path} (shape: object) answers its first row`,
          atrezzo: { miss: true, gap, endpoints: dataset.endpoints.map((e) => e.path) },
        }, h);
        res.miss = true;
        return res;
      }
      if (!result.length) {
        const q = [...params].filter(([k]) => ep.filters.includes(k)).map(([k, v]) => `${k}=${v}`).join('&');
        return json(404, { error: `no ${ep.entity} matches ${q || '(no filter)'}${where(ep, m.params)} in scenario "${dataset.scenario}"` }, h);
      }
      return json(200, shapeRow(result[0], ep, counts), h);
    }

    let limit = null;
    let offset = 0;
    if (ep.pagination) {
      const l = parseNonNegInt(params.get(ep.pagination.limit), ep.pagination.limit);
      const pageParam = ep.pagination.page;
      const o = parseNonNegInt(params.get(pageParam ?? ep.pagination.offset), pageParam ?? ep.pagination.offset);
      if (l.error || o.error) return json(400, { error: l.error || o.error });
      if (pageParam && o.value === 0) return json(400, { error: `"${pageParam}" starts at 1; got "0"` });
      limit = l.value ?? ep.pagination.defaultLimit;
      if (limit !== null && ep.pagination.maxLimit !== null) limit = Math.min(limit, ep.pagination.maxLimit);
      offset = pageParam ? ((o.value ?? 1) - 1) * (limit ?? 0) : (o.value ?? 0);
      result = result.slice(offset, limit === null ? undefined : offset + limit);
    }
    const page = result.map((r) => shapeRow(r, ep, counts));
    const out = { 'x-total-count': String(total) };
    if (ignored.length) out['x-atrezzo-ignored'] = ignored.join(',');
    if (ep.shape === 'envelope') return json(200, { [ep.pick ?? 'data']: page, total, limit, offset }, out);
    return json(200, page, out);
  }

  return { match, handle, dataset };
}
