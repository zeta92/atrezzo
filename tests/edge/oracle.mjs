// Oráculo del motor: una implementación ingenua de lo que un endpoint de lista
// tiene que hacer (filtrar, ordenar, contar, recortar), escrita para poder
// equivocarse de forma distinta que el motor.
//
// No importa nada del motor a propósito: si compartiera el código, un test
// verde solo diría que el motor está de acuerdo consigo mismo.

/** Compara como lo haría el motor con campos de texto y números. */
const eq = (a, b) => (a === null || a === undefined ? b === 'null' : String(a) === String(b));

/**
 * @param {object[]} rows  filas del mundo (ya generadas)
 * @param {object} ep      endpoint normalizado
 * @param {URLSearchParams} query
 * @returns {{ items: object[], total: number, page: number|null, limit: number|null }}
 */
export function oracleList(rows, ep, query) {
  let out = rows.slice();

  // 1. Filtros: igualdad, con `a,b` como lista y `null` como valor nulo.
  for (const field of ep.filters ?? []) {
    if (!query.has(field)) continue;
    const raw = query.get(field);
    const values = raw.split(',').map((v) => v.trim());
    out = out.filter((row) => values.some((v) => eq(row[field], v)));
  }

  // 2. Filtros de mundo (`$user`): el motor los aplica siempre, aquí llegan ya resueltos.
  for (const wf of ep.worldFilters ?? []) {
    out = out.filter((row) => eq(row[wf.field], wf.value));
  }
  for (const uf of ep.userFilters ?? []) {
    out = out.filter((row) => eq(row[uf.field], uf.value));
  }

  const total = out.length;

  // 3. Orden: `sort` estático o `sorts` por parámetro; estable, como Array#sort.
  let sorts = ep.sort ?? [];
  if (ep.sorts) {
    const by = query.get(ep.sorts.by);
    const wantedDir = ep.sorts.order ? query.get(ep.sorts.order) : null;
    if (by && ep.sorts.fields.includes(by)) {
      sorts = [{ field: by, dir: wantedDir === 'desc' ? 'desc' : 'asc' }];
    } else if (!by && wantedDir) {
      // `order` sin `by` da la vuelta al orden por defecto del endpoint.
      sorts = (ep.sort ?? []).map((s) => ({ ...s, dir: wantedDir === 'desc' ? 'desc' : 'asc' }));
    }
  }
  if (sorts.length) {
    out = out.slice().sort((a, b) => {
      for (const s of sorts) {
        const av = a[s.field]; const bv = b[s.field];
        const an = av === null || av === undefined; const bn = bv === null || bv === undefined;
        if (an && bn) continue;
        if (an) return 1;          // los nulos van al final, como en el motor
        if (bn) return -1;
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'en');
        if (cmp !== 0) return s.dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }

  // 4. Paginación.
  let limit = null;
  let offset = 0;
  let page = null;
  if (ep.pagination) {
    const pg = ep.pagination;
    if (pg.page) {
      const p = Math.max(1, Number(query.get(pg.page) ?? 1) || 1);
      page = p;
      limit = Math.min(pg.maxLimit ?? Infinity, pg.defaultLimit ?? total);
      offset = (p - 1) * limit;
    } else {
      limit = query.has(pg.limit) ? Number(query.get(pg.limit)) : pg.defaultLimit;
      if (limit === null || limit === undefined || Number.isNaN(limit)) limit = null;
      if (limit !== null && pg.maxLimit) limit = Math.min(limit, pg.maxLimit);
      offset = query.has(pg.offset) ? Number(query.get(pg.offset)) || 0 : 0;
    }
  }

  const items = limit === null ? out.slice(offset) : out.slice(offset, offset + limit);
  return { items, total, page, limit };
}
