// An oracle for the engine: a naive version of what a list endpoint has to do
// (filter, sort, count, slice), written so that it can be wrong in a different
// way from the engine.
//
// It imports nothing from the engine on purpose: if it shared the code, a green
// test would only say that the engine agrees with itself.

/** Filter equality as the engine does it for text and numbers; `null` matches nulls. */
const eq = (a, b) => (a === null || a === undefined ? b === 'null' : String(a) === String(b));

/** Order of two non-null values: numbers by value, everything else by UTF-16 code units (`<`), like the engine. */
function order(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a); const sb = String(b);
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;
}

/** `where` of a world filter: every key matches (a list = any of its values); `$user.<field>` reads the auth user. */
function matchesWhere(row, where, user) {
  return Object.entries(where ?? {}).every(([k, expected]) => {
    const one = (v) => {
      if (typeof v === 'string' && v.startsWith('$user.')) {
        const u = user?.[v.slice(6)];
        return u !== null && u !== undefined && row[k] === u;
      }
      return row[k] === v;
    };
    return Array.isArray(expected) ? expected.some(one) : one(expected);
  });
}

/**
 * @param {object[]} rows  rows of the endpoint's entity (already generated)
 * @param {object} ep      normalized endpoint
 * @param {URLSearchParams} query
 * @param {{ entities?: Record<string, object[]>, user?: object|null }} [ctx]
 *   the whole world and the auth user row, needed only by world filters and `$user` filters
 * @returns {{ items: Array<object|string|null>, total: number, page: number, limit: number|null, totalPages: number }}
 *   `items` are rows, or plucked values with `pluck`; `page` is the page number the envelope reports
 */
export function oracleList(rows, ep, query, { entities = {}, user = null } = {}) {
  let out = rows.slice();

  // 1. World filters (`{ field, from, where }`): the row's foreign key must point at a row of
  //    `from` that matches `where`. `$user` filters (`{ field, userField }`): equal to the auth user's field.
  for (const wf of ep.worldFilters ?? []) {
    const allowed = new Set((entities[wf.from] ?? []).filter((t) => matchesWhere(t, wf.where, user)).map((t) => t.id));
    out = out.filter((row) => row[wf.field] !== null && row[wf.field] !== undefined && allowed.has(row[wf.field]));
  }
  for (const uf of ep.userFilters ?? []) {
    const expected = user?.[uf.userField];
    out = expected === null || expected === undefined ? [] : out.filter((row) => row[uf.field] === expected);
  }

  // 2. Scopes: without the parameter, `default: exclude` hides the rows whose field is true and
  //    `include` keeps them all; `?p=true|false` keeps only the rows with that value (`only`) or
  //    adds them to the default set (`add`).
  for (const s of ep.scopes ?? []) {
    const inDefault = (row) => s.default === 'include' || row[s.field] !== true;
    const sent = query.get(s.param);
    if (sent === null || sent === '') { out = out.filter(inDefault); continue; }
    const want = sent.toLowerCase() === 'true';
    const action = want ? s.when_true : s.when_false;
    out = out.filter((row) => ((row[s.field] === true) === want) || (action === 'add' && inDefault(row)));
  }

  // 3. Query filters: equality, `a,b` as a list and `null` as the null value.
  for (const field of ep.filters ?? []) {
    if (!query.has(field)) continue;
    const values = query.get(field).split(',').map((v) => v.trim());
    out = out.filter((row) => values.some((v) => eq(row[field], v)));
  }

  const total = out.length;

  // 4. Order: static `sort` or `sorts` from a parameter; stable, like Array#sort.
  let sorts = ep.sort ?? [];
  if (ep.sorts) {
    const by = query.get(ep.sorts.by);
    const wantedDir = ep.sorts.order ? query.get(ep.sorts.order) : null;
    if (by && ep.sorts.fields.includes(by)) {
      sorts = [{ field: by, dir: wantedDir === 'desc' ? 'desc' : 'asc' }];
    } else if (!by && wantedDir) {
      // `order` without `by` sets the direction of the default order's first key; the rest stay.
      const [head, ...rest] = ep.sort ?? [];
      sorts = head ? [{ ...head, dir: wantedDir === 'desc' ? 'desc' : 'asc' }, ...rest] : [];
    }
  }
  if (sorts.length) {
    out = out.slice().sort((a, b) => {
      for (const s of sorts) {
        const av = a[s.field]; const bv = b[s.field];
        const an = av === null || av === undefined; const bn = bv === null || bv === undefined;
        if (an && bn) continue;
        // Nulls last ascending and first descending, as in the engine (and in Postgres by default).
        if (an) return s.dir === 'desc' ? -1 : 1;
        if (bn) return s.dir === 'desc' ? 1 : -1;
        const cmp = order(av, bv);
        if (cmp !== 0) return s.dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }

  // 5. Pagination: by offset, or by page number (`limit` still sets the page size).
  let limit = null;
  let offset = 0;
  let page = 1;
  if (ep.pagination) {
    const pg = ep.pagination;
    const asked = query.get(pg.limit);
    limit = asked !== null && asked !== '' ? Number(asked) : pg.defaultLimit;
    if (limit === null || limit === undefined || Number.isNaN(limit)) limit = null;
    if (limit !== null && pg.maxLimit !== null && pg.maxLimit !== undefined) limit = Math.min(limit, pg.maxLimit);
    if (pg.page) {
      const p = query.get(pg.page);
      page = p !== null && p !== '' ? Number(p) : 1;
      offset = (page - 1) * (limit ?? 0);
    } else {
      const o = query.get(pg.offset);
      offset = o !== null && o !== '' ? Number(o) : 0;
      // The page an offset falls in, as the envelope reports it.
      page = limit ? Math.floor(offset / limit) + 1 : 1;
    }
  }

  const sliced = limit === null ? out.slice(offset) : out.slice(offset, offset + limit);
  // `pluck`: each row answers that field as a string; a null stays null.
  const items = ep.pluck ? sliced.map((r) => (r[ep.pluck] === null || r[ep.pluck] === undefined ? null : String(r[ep.pluck]))) : sliced;
  // Pages to walk through all the rows: an unpaginated (or limit 0) answer is one page, or none when empty.
  const totalPages = limit ? Math.ceil(total / limit) : (total > 0 ? 1 : 0);
  return { items, total, page, limit, totalPages };
}
