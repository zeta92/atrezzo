// Corpus de diagnóstico: casos con una causa inyectada conocida, para medir si `certainty`
// dice la verdad. Derivados de los de tests/verify.test.mjs, más variantes que NO deben acertar.
//
// Cada caso:
//   - row/ctx: lo que verify le pasaría a diagnose()
//   - cause: la causa inyectada (null = con estos datos no se puede saber; lo correcto es no
//     afirmar nada más fuerte que `possible`)
//   - truths: otros tipos que también son ciertos en ese caso (p. ej. `render` cuando el cliente
//     esconde filas: el fallo está en la pantalla, aunque la causa concreta sea otra)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../scripts/lib/diagnose.mjs';
import { diagnose as fromVerify } from '../scripts/lib/verify.mjs';

const ok = (headers = {}) => ({ status: 200, headers, body: null });
const q = (s) => new URLSearchParams(s);
const rows = (n, extra = () => ({})) => Array.from({ length: n }, (_, i) => ({ id: i + 1, ...extra(i) }));
const expect = (e) => ({ expect: { selector: 'tr', ...e } });

// Seis pedidos sin ordenar; ordenados por amount desc, los tres primeros son `issue`.
const UNSORTED = [
  { id: 1, amount: 10, status: 'ok', created_at: '2026-01-03' },
  { id: 2, amount: 50, status: 'issue', created_at: '2026-01-05' },
  { id: 3, amount: 20, status: 'ok', created_at: '2026-01-01' },
  { id: 4, amount: 90, status: 'issue', created_at: '2026-01-09' },
  { id: 5, amount: 70, status: 'issue', created_at: '2026-01-07' },
  { id: 6, amount: 5, status: 'ok', created_at: '2026-01-02' },
];
const SORTED = [...UNSORTED].sort((a, b) => b.amount - a.amount);
const issue = { data: { request: 'orders', where: { status: 'issue' } } };

const CASES = [
  // --- declared-error / non-200 ---
  { name: 'error declarado 500', row: expect({ count: 3 }), cause: 'declared-error',
    ctx: { obtained: 0, response: { status: 500, headers: { 'x-atrezzo-error': 'declared' }, body: { error: 'boom' } }, items: [], matched: 0 } },
  { name: 'error declarado 404 con DOM', row: expect({ count: 3 }), cause: 'declared-error',
    ctx: { obtained: 0, response: { status: 404, headers: { 'x-atrezzo-error': 'declared' }, body: {} }, items: [], matched: 0, domCount: 0 } },
  { name: 'respuesta 500 no declarada', row: expect({ count: 3 }), cause: 'non-200-response',
    ctx: { obtained: 0, response: { status: 500, headers: {}, body: 'Internal' }, items: [], matched: 0 } },
  { name: 'respuesta 401 con DOM', row: expect({ count: 2 }), cause: 'non-200-response',
    ctx: { obtained: 0, response: { status: 401, headers: {}, body: { error: 'auth' } }, items: [], matched: 0, domCount: 0 } },

  // --- render ---
  { name: 'render: el DOM pinta filas de más', row: expect({ count: 3 }), cause: 'render',
    ctx: { obtained: 5, response: ok(), items: rows(3), matched: 3, domCount: 5 } },
  { name: 'render: la pantalla no pinta nada', row: expect({ count: 3 }), cause: 'render', truths: ['client-side-filter'],
    ctx: { obtained: 0, response: ok(), items: rows(3), matched: 3, domCount: 0 } },

  // --- pagination-mismatch ---
  { name: 'paginación: 2 de 3 en la primera página (http)', row: expect({ count: 3, ...issue }), cause: 'pagination-mismatch',
    ctx: { obtained: 2, response: ok({ 'x-total-count': '40' }), items: rows(12, (i) => ({ status: i < 2 ? 'issue' : 'ok' })), matched: 2, fullMatched: 3 } },
  { name: 'paginación: 2 de 3 (playwright)', row: expect({ count: 3, ...issue }), cause: 'pagination-mismatch',
    ctx: { obtained: 2, response: ok({ 'x-total-count': '40' }), items: rows(12, (i) => ({ status: i < 2 ? 'issue' : 'ok' })), matched: 2, fullMatched: 3, domCount: 2 } },
  { name: 'no es paginación: el mundo solo tiene 2', row: expect({ count: 3, ...issue }), cause: 'world-mismatch',
    ctx: { obtained: 2, response: ok({ 'x-total-count': '40' }), items: rows(12, (i) => ({ status: i < 2 ? 'issue' : 'ok' })), matched: 2, fullMatched: 2 } },

  // --- world-mismatch ---
  { name: 'mundo: se esperaban 4 y hay 3', row: expect({ count: 4 }), cause: 'world-mismatch',
    ctx: { obtained: 3, response: ok(), items: rows(3), matched: 3, fullMatched: 3 } },
  { name: 'mundo: min 5 y hay 2', row: expect({ min: 5, ...issue }), cause: 'world-mismatch',
    ctx: { obtained: 2, response: ok(), items: rows(6, (i) => ({ status: i < 2 ? 'issue' : 'ok' })), matched: 2, fullMatched: 2 } },

  // --- dedupe-by-id ---
  { name: 'dedupe: ids 1,1,2 y el DOM pinta 2', row: expect({ count: 3 }), cause: 'dedupe-by-id', truths: ['render'],
    ctx: { obtained: 2, response: ok(), items: [{ id: 1 }, { id: 1 }, { id: 2 }], matched: 3, domCount: 2 } },
  { name: 'dedupe: 5 items, 3 ids, el DOM pinta 3', row: expect({ count: 5 }), cause: 'dedupe-by-id', truths: ['render'],
    ctx: { obtained: 3, response: ok(), items: [{ id: 1 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 3 }], matched: 5, domCount: 3 } },
  { name: 'no dedupe: hay repetidos pero el DOM pinta 1', row: expect({ count: 3 }), cause: 'render',
    ctx: { obtained: 1, response: ok(), items: [{ id: 1 }, { id: 1 }, { id: 2 }], matched: 3, domCount: 1 } },
  { name: 'no dedupe: repetidos, pero la aserción está mal (http)', row: expect({ count: 2 }), cause: 'world-mismatch',
    ctx: { obtained: 3, response: ok(), items: [{ id: 1 }, { id: 1 }, { id: 2 }], matched: 3, fullMatched: 3 } },
  // Fallo honesto: el recuento cuadra con dedupe por casualidad; en realidad el cliente oculta una fila.
  { name: 'trampa: cuadra con dedupe pero el cliente oculta una fila', row: expect({ count: 4 }), cause: 'client-side-filter', truths: ['render'],
    ctx: { obtained: 3, response: ok(), items: [{ id: 1 }, { id: 1 }, { id: 2 }, { id: 3 }], matched: 4, domCount: 3 } },

  // --- null-field ---
  { name: 'nulo: falta justo la fila con email null', row: expect({ count: 3 }), cause: 'null-field', truths: ['render'],
    ctx: { obtained: 2, response: ok(), items: [{ id: 1, email: null }, { id: 2, email: 'a' }, { id: 3, email: 'b' }], matched: 3, domCount: 2 } },
  { name: 'nulo: faltan las dos filas con nulos', row: expect({ count: 4 }), cause: 'null-field', truths: ['render'],
    ctx: { obtained: 2, response: ok(), items: [{ id: 1, email: null }, { id: 2, email: 'a' }, { id: 3, phone: null }, { id: 4, email: 'b' }], matched: 4, domCount: 2 } },
  { name: 'no nulo: hay un null pero no pinta nada', row: expect({ count: 3 }), cause: 'render',
    ctx: { obtained: 0, response: ok(), items: [{ id: 1, email: null }, { id: 2, email: 'a' }, { id: 3, email: 'b' }], matched: 3, domCount: 0 } },
  { name: 'no nulo: hay un null y la aserción está mal (http)', row: expect({ count: 4 }), cause: 'world-mismatch',
    ctx: { obtained: 3, response: ok(), items: [{ id: 1, email: null }, { id: 2, email: 'a' }, { id: 3, email: 'b' }], matched: 3, fullMatched: 3 } },

  // --- client-side-filter ---
  { name: 'filtro en cliente: 5 en JSON, 3 en DOM', row: expect({ count: 5 }), cause: 'client-side-filter', truths: ['render'],
    ctx: { obtained: 3, response: ok(), items: rows(5), matched: 5, domCount: 3 } },
  { name: 'filtro en cliente con where', row: expect({ count: 3, ...issue }), cause: 'client-side-filter', truths: ['render'],
    ctx: { obtained: 2, response: ok(), items: rows(6, (i) => ({ status: i % 2 ? 'issue' : 'ok' })), matched: 3, domCount: 2 } },
  { name: 'filtro en cliente: JSON 3, DOM 2, esperado 4', row: expect({ count: 4 }), cause: 'client-side-filter',
    ctx: { obtained: 2, response: ok(), items: rows(3), matched: 3, domCount: 2 } },

  // --- ignored-sort ---
  { name: 'orden ignorado: order=amount.desc, el contrafactual cuadra', row: expect({ count: 3, ...issue }), cause: 'ignored-sort',
    ctx: { obtained: 1, response: ok({ 'x-atrezzo-ignored': 'order' }), items: UNSORTED, query: q('order=amount.desc&limit=6'), matched: 3, domCount: 1 } },
  { name: 'orden ignorado: sort_by + order=desc por fecha', row: expect({ count: 3, ...issue }), cause: 'ignored-sort',
    ctx: { obtained: 1, response: ok({ 'x-atrezzo-ignored': 'sort_by, order' }), items: UNSORTED, query: q('sort_by=created_at&order=desc'), matched: 3, domCount: 1 } },
  { name: 'orden ignorado: -amount con limit que recorta', row: expect({ count: 2, ...issue }), cause: 'ignored-sort',
    ctx: { obtained: 0, response: ok({ 'x-atrezzo-ignored': 'sort' }), items: UNSORTED, query: q('sort=-amount&limit=2'), matched: 3, domCount: 0 } },
  { name: 'orden ignorado pero los items ya vienen ordenados', row: expect({ count: 3, ...issue }), cause: null,
    ctx: { obtained: 1, response: ok({ 'x-atrezzo-ignored': 'order' }), items: SORTED, query: q('order=-amount'), matched: 3, domCount: 1 } },
  { name: 'orden ignorado: reordenar no arregla nada', row: expect({ count: 3, ...issue }), cause: null,
    ctx: { obtained: 1, response: ok({ 'x-atrezzo-ignored': 'order' }), items: UNSORTED, query: q('order=amount'), matched: 3, domCount: 1 } },
  { name: 'orden ignorado sin query (no se puede comprobar)', row: expect({ count: 3 }), cause: null,
    ctx: { obtained: 0, response: ok({ 'x-atrezzo-ignored': 'order' }), items: rows(3), matched: 3, domCount: 0 } },

  // --- undeclared-filter ---
  { name: 'filtro no declarado: status=issue deja 2 (http)', row: expect({ count: 2 }), cause: 'undeclared-filter',
    ctx: { obtained: 5, response: ok({ 'x-atrezzo-ignored': 'status' }), items: rows(5, (i) => ({ status: i < 2 ? 'issue' : 'ok' })), query: q('status=issue'), matched: 5, fullMatched: 5 } },
  { name: 'filtro no declarado: customer_id=7 (playwright)', row: expect({ count: 3 }), cause: 'undeclared-filter',
    ctx: { obtained: 6, response: ok({ 'x-atrezzo-ignored': 'customer_id' }), items: rows(6, (i) => ({ customer_id: i < 3 ? 7 : 8 })), query: q('customer_id=7'), matched: 6, domCount: 6 } },
  { name: 'filtro no declarado con lista a,b', row: expect({ count: 4 }), cause: 'undeclared-filter',
    ctx: { obtained: 6, response: ok({ 'x-atrezzo-ignored': 'status' }), items: rows(6, (i) => ({ status: ['new', 'paid', 'void'][i % 3] })), query: q('status=new,paid'), matched: 6, fullMatched: 6 } },
  { name: 'filtro ignorado sobre un campo que no existe', row: expect({ count: 2 }), cause: 'world-mismatch',
    ctx: { obtained: 5, response: ok({ 'x-atrezzo-ignored': 'tenant' }), items: rows(5), query: q('tenant=acme'), matched: 5, fullMatched: 5 } },
  { name: 'filtro ignorado: filtrar no da lo esperado', row: expect({ count: 3 }), cause: null,
    ctx: { obtained: 5, response: ok({ 'x-atrezzo-ignored': 'status' }), items: rows(5, (i) => ({ status: i < 1 ? 'issue' : 'ok' })), query: q('status=issue'), matched: 5, domCount: 5 } },
  { name: 'filtro ignorado sin query (no se puede comprobar)', row: expect({ count: 3 }), cause: null,
    ctx: { obtained: 0, response: ok({ 'x-atrezzo-ignored': 'status' }), items: [{ id: 1 }], matched: 1, domCount: 0 } },

  // --- no-data / no-hypothesis ---
  { name: 'sin data: solo hay DOM', row: expect({ count: 3 }), cause: null, ctx: { obtained: 2, domCount: 2 } },
  { name: 'sin nada que comparar', row: expect({ count: 3 }), cause: null, ctx: { obtained: 0 } },
  { name: 'respuesta 200 sin items ni DOM', row: expect({ count: 3 }), cause: null, ctx: { obtained: 0, response: ok() } },

  // --- F5 field cases: Conduit (references/field-reports/conduit/summary.md) ---
  // Each one comes from a real `verify --diagnose` run against the Conduit front end with one cause injected
  // into the scenario; ctx is what verify passed to diagnose() (items trimmed to the keys that matter, same
  // hypotheses before and after trimming). `cause: null` = no hypothesis type names the injected cause
  // (an ignored pagination parameter, a wrong envelope key); nothing stronger than `possible` is right there.
  // The null-author case: verify reports page-error for it (the browser crash wins); this is diagnose() on its data.
  { name: 'field: ?author=<username> ignored (a filter through the author), http', row: { expect: {selector: '.article-preview', count: 5, data: {request: 'r', where: {author_id: 3}}} }, cause: 'undeclared-filter',
    ctx: { obtained: 2, response: {status: 200, headers: {'x-total-count':'23', 'x-atrezzo-ignored':'author'}, body: null}, items: [{id: 21, author_id: 2, author: {username: 'bob'}}, {id: 15, author_id: 3, author: {username: 'carol'}}, {id: 20, author_id: 3, author: {username: 'carol'}}, {id: 9, author_id: 4, author: {username: 'dave'}}, {id: 23, author_id: 2, author: {username: 'bob'}}], query: q('author=carol&limit=5&offset=0'), matched: 2, fullMatched: 7 } },
  { name: 'field: ?tag= ignored (tagList contains), http', row: { expect: {selector: '.article-preview', count: 5, data: {request: 'r'}} }, cause: 'undeclared-filter',
    ctx: { obtained: 10, response: {status: 200, headers: {'x-total-count':'23', 'x-atrezzo-ignored':'tag'}, body: null}, items: [{id: 21}, {id: 15}, {id: 20}, {id: 9}, {id: 23}, {id: 17}, {id: 19}, {id: 3}, {id: 10}, {id: 1}], query: q('tag=welcome&limit=10&offset=0'), matched: 10, fullMatched: 23 } },
  { name: 'field: ?tag= ignored, playwright', row: { expect: {selector: '.article-preview', count: 5, data: {request: 'r'}} }, cause: 'undeclared-filter',
    ctx: { obtained: 10, response: {status: 200, headers: {'x-total-count':'23', 'x-atrezzo-ignored':'tag'}, body: null}, items: [{id: 21}, {id: 15}, {id: 20}, {id: 9}, {id: 23}, {id: 17}, {id: 19}, {id: 3}, {id: 10}, {id: 1}], query: q('tag=welcome&limit=10&offset=0'), matched: 10, fullMatched: 23, domCount: 10 } },
  { name: 'field: max_limit 5 while the client asks for 10, http', row: { expect: {selector: '.article-preview', count: 10, data: {request: 'r'}} }, cause: 'pagination-mismatch',
    ctx: { obtained: 5, response: {status: 200, headers: {'x-total-count':'16'}, body: null}, items: [{id: 21}, {id: 15}, {id: 20}, {id: 23}, {id: 17}], query: q('limit=10&offset=0'), matched: 5, fullMatched: 16 } },
  { name: 'field: max_limit 5 while the client asks for 10, playwright', row: { expect: {selector: '.article-preview', count: 10, data: {request: 'r'}} }, cause: 'pagination-mismatch',
    ctx: { obtained: 5, response: {status: 200, headers: {'x-total-count':'16'}, body: null}, items: [{id: 21}, {id: 15}, {id: 20}, {id: 23}, {id: 17}], query: q('limit=10&offset=0'), matched: 5, fullMatched: 16, domCount: 5 } },
  { name: 'field: endpoint sort reversed, the favourites fall off the page, http', row: { expect: {selector: '.article-preview button.btn-primary', count: 4, data: {request: 'r', where: {favorited: true}}} }, cause: 'pagination-mismatch',
    ctx: { obtained: 2, response: {status: 200, headers: {'x-total-count':'16'}, body: null}, items: [{id: 16, favorited: false}, {id: 8, favorited: false}, {id: 2, favorited: false}, {id: 12, favorited: false}, {id: 7, favorited: true}, {id: 13, favorited: false}, {id: 5, favorited: false}, {id: 22, favorited: true}, {id: 1, favorited: false}, {id: 10, favorited: false}], query: q('limit=10&offset=0'), matched: 2, fullMatched: 5 } },
  { name: 'field: endpoint sort reversed, playwright', row: { expect: {selector: '.article-preview button.btn-primary', count: 4, data: {request: 'r', where: {favorited: true}}} }, cause: 'pagination-mismatch',
    ctx: { obtained: 2, response: {status: 200, headers: {'x-total-count':'16'}, body: null}, items: [{id: 16, favorited: false}, {id: 8, favorited: false}, {id: 2, favorited: false}, {id: 12, favorited: false}, {id: 7, favorited: true}, {id: 13, favorited: false}, {id: 5, favorited: false}, {id: 22, favorited: true}, {id: 1, favorited: false}, {id: 10, favorited: false}], query: q('limit=10&offset=0'), matched: 2, fullMatched: 5, domCount: 2 } },
  { name: 'field: alice follows nobody, empty feed, http', row: { expect: {selector: '.article-preview .preview-link', count: 10, data: {request: 'r'}} }, cause: 'world-mismatch',
    ctx: { obtained: 0, response: {status: 200, headers: {'x-total-count':'0'}, body: null}, items: [], query: q('limit=10&offset=0'), matched: 0, fullMatched: 0 } },
  { name: 'field: empty feed, playwright (world-mismatch only exists without a DOM)', row: { expect: {selector: '.article-preview .preview-link', count: 10, data: {request: 'r'}} }, cause: 'world-mismatch',
    ctx: { obtained: 0, response: {status: 200, headers: {'x-total-count':'0'}, body: null}, items: [], query: q('limit=10&offset=0'), matched: 0, fullMatched: 0, domCount: 0 } },
  { name: 'field: world without tags, http', row: { expect: {selector: '.sidebar .tag-pill', count: 6, data: {request: 'r'}} }, cause: 'world-mismatch',
    ctx: { obtained: 0, response: {status: 200, headers: {'x-total-count':'0'}, body: null}, items: [], matched: 0, fullMatched: 0 } },
  { name: 'field: world without tags, playwright', row: { expect: {selector: '.sidebar .tag-pill', count: 6, data: {request: 'r'}} }, cause: 'world-mismatch',
    ctx: { obtained: 0, response: {status: 200, headers: {'x-total-count':'0'}, body: null}, items: [], matched: 0, fullMatched: 0, domCount: 0 } },
  { name: 'field: declared 500 on /api/tags, http', row: { expect: {selector: '.sidebar .tag-pill', count: 6, data: {request: 'r'}} }, cause: 'declared-error',
    ctx: { obtained: 0, response: {status: 500, headers: {'x-atrezzo-error':'declared'}, body: {error: '500'}}, items: [], matched: 0 } },
  { name: 'field: 3 articles without author, the preview reads author.username and crashes', row: { expect: {selector: '.article-preview .preview-link', count: 10, data: {request: 'r'}} }, cause: 'null-field', truths: ['render'],
    ctx: { obtained: 0, response: {status: 200, headers: {'x-total-count':'23'}, body: null}, items: [{id: 21}, {id: 15}, {id: 20}, {id: 9}, {id: 23, author_id: null, author: null}, {id: 17}, {id: 19, author_id: null, author: null}, {id: 3}, {id: 10}, {id: 1}], query: q('limit=10&offset=0'), matched: 10, fullMatched: 23, domCount: 0 } },
  { name: 'field: page-style pagination declared, the client sends offset (ignored), http', row: { expect: {selector: '.article-preview', count: 6, data: {request: 'r'}} }, cause: null, truths: ['undeclared-filter'],
    ctx: { obtained: 10, response: {status: 200, headers: {'x-total-count':'16', 'x-atrezzo-ignored':'offset'}, body: null}, items: [{id: 21}, {id: 15}, {id: 20}, {id: 23}, {id: 17}, {id: 19}, {id: 10}, {id: 1}, {id: 22}, {id: 5}], query: q('limit=10&offset=10'), matched: 10, fullMatched: 10 } },
  { name: 'field: offset ignored, playwright (the front end never sends offset either: upstream #197)', row: { expect: {selector: '.article-preview', count: 6, data: {request: 'r'}} }, cause: null, truths: ['undeclared-filter'],
    ctx: { obtained: 10, response: {status: 200, headers: {'x-total-count':'16', 'x-atrezzo-ignored':'offset'}, body: null}, items: [{id: 21}, {id: 15}, {id: 20}, {id: 23}, {id: 17}, {id: 19}, {id: 10}, {id: 1}, {id: 22}, {id: 5}], query: q('limit=10&offset=10'), matched: 10, fullMatched: 10, domCount: 10 } },
  { name: 'field: comments envelope uses data, the client reads comments, http', row: { expect: {selector: '.card .card-text', count: 5, data: {request: 'r'}} }, cause: null,
    ctx: { obtained: 0, response: {status: 200, headers: {'x-total-count':'5'}, body: null}, items: [], matched: 0, fullMatched: 0 } },
  { name: 'field: wrong envelope key, playwright', row: { expect: {selector: '.card .card-text', count: 5, data: {request: 'r'}} }, cause: null,
    ctx: { obtained: 0, response: {status: 200, headers: {'x-total-count':'5'}, body: null}, items: [], matched: 0, fullMatched: 0, domCount: 0 } },
  { name: 'field: upstream #197, the feed pager never sends offset (real front-end bug), playwright', row: { expect: {selector: '.article-preview', count: 6, data: {request: 'r'}} }, cause: 'render',
    ctx: { obtained: 10, response: {status: 200, headers: {'x-total-count': '16'}, body: null}, items: [{id:13}, {id:7}, {id:12}, {id:2}, {id:8}, {id:16}], query: q('limit=10&offset=10'), matched: 6, fullMatched: 16, domCount: 10 } },

  // --- F5 field cases: Mealie (references/field-reports/mealie/summary.md, B2 / inj-max-limit) ---
  // Page pagination with default_limit 24 and max_limit 5: verify now walks the pages to rebuild the
  // full set (12) instead of trusting the clamped probe (5), and reports the clamp.
  { name: 'field mealie: max_limit 5 on perPage=24, page pagination, http', row: { expect: {selector: '.recipe-card-footer', count: 12, data: {request: 'r'}} }, cause: 'pagination-mismatch',
    ctx: { obtained: 5, response: {status: 200, headers: {'x-total-count': '12'}, body: null}, items: rows(5), query: q('page=1&perPage=24'), matched: 5, fullMatched: 12, clampedLimit: { param: 'perPage', requested: 24, max: 5 } } },
  { name: 'field mealie: max_limit 5 on perPage=24, playwright', row: { expect: {selector: '.recipe-card-footer', count: 12, data: {request: 'r'}} }, cause: 'pagination-mismatch',
    ctx: { obtained: 5, response: {status: 200, headers: {'x-total-count': '12'}, body: null}, items: rows(5), query: q('page=1&perPage=24'), matched: 5, fullMatched: 12, clampedLimit: { param: 'perPage', requested: 24, max: 5 }, domCount: 5 } },
  // The page is clamped (2 of its 5 rows match) but the verified full set has only 6: no page reaches 7.
  { name: 'field mealie: clamped page, verified world short of the expectation, http', row: { expect: {selector: '.five', count: 7, data: {request: 'r', where: {rating: 5}}} }, cause: 'world-mismatch',
    ctx: { obtained: 2, response: {status: 200, headers: {'x-total-count': '12'}, body: null}, items: rows(5, (i) => ({ rating: [4, 5, 3, 5][i % 4] })), query: q('page=1&perPage=24'), matched: 2, fullMatched: 6, clampedLimit: { param: 'perPage', requested: 24, max: 5 } } },
  // Guard: the world has more than enough (16 ≥ 10); the client's offset is the problem, not the world.
  { name: 'page slice of a larger verified world is not world-mismatch, http', row: { expect: {selector: 'tr', count: 10, data: {request: 'r'}} }, cause: 'pagination-mismatch',
    ctx: { obtained: 6, response: {status: 200, headers: {'x-total-count': '16'}, body: null}, items: rows(6), query: q('limit=10&offset=10'), matched: 6, fullMatched: 16 } },
  // Verified over-count: the clamped page already has 2 matches and the full set 6; 1 was expected.
  { name: 'clamped page, verified world over the expected count, http', row: { expect: {selector: '.five', count: 1, data: {request: 'r', where: {rating: 5}}} }, cause: 'world-mismatch',
    ctx: { obtained: 2, response: {status: 200, headers: {'x-total-count': '12'}, body: null}, items: rows(5, (i) => ({ rating: [4, 5, 3, 5][i % 4] })), query: q('page=1&perPage=24'), matched: 2, fullMatched: 6, clampedLimit: { param: 'perPage', requested: 24, max: 5 } } },
  { name: 'clamped page, verified world over the max, http', row: { expect: {selector: '.five', max: 1, data: {request: 'r', where: {rating: 5}}} }, cause: 'world-mismatch',
    ctx: { obtained: 2, response: {status: 200, headers: {'x-total-count': '12'}, body: null}, items: rows(5, (i) => ({ rating: [4, 5, 3, 5][i % 4] })), query: q('page=1&perPage=24'), matched: 2, fullMatched: 6 } },
];

const STRONG = new Set(['confirmed', 'likely']);

function evaluate() {
  const stats = { confirmed: { hit: 0, n: 0 }, likely: { hit: 0, n: 0 }, top1: { hit: 0, n: 0 } };
  const misses = [];
  for (const c of CASES) {
    const hyps = diagnose(c.row, c.ctx);
    const truths = new Set([c.cause, ...(c.truths ?? [])].filter(Boolean));
    for (const h of hyps) {
      if (!STRONG.has(h.certainty)) continue;
      const s = stats[h.certainty];
      s.n++;
      if (truths.has(h.type)) s.hit++;
      else misses.push(`${h.certainty} ${h.type} en «${c.name}» (causa: ${c.cause ?? 'ninguna'})`);
    }
    const top = hyps.find((h) => STRONG.has(h.certainty));
    stats.top1.n++;
    if ((top?.type ?? null) === c.cause) stats.top1.hit++;
    else misses.push(`top-1 ${top?.type ?? '(nada)'} en «${c.name}» (causa: ${c.cause ?? 'ninguna'})`);
  }
  return { stats, misses };
}

const rate = ({ hit, n }) => (n ? hit / n : 1);

test('corpus: al menos 25 casos y todos los tipos cubiertos', () => {
  assert.ok(CASES.length >= 25, `${CASES.length} casos`);
  const seen = new Set(CASES.flatMap((c) => diagnose(c.row, c.ctx).map((h) => h.type)));
  for (const t of ['declared-error', 'non-200-response', 'render', 'pagination-mismatch', 'dedupe-by-id', 'null-field', 'ignored-sort', 'undeclared-filter', 'client-side-filter', 'world-mismatch', 'no-data', 'no-hypothesis']) {
    assert.ok(seen.has(t), `ningún caso produce ${t}`);
  }
});

test('corpus: forma de las hipótesis', () => {
  for (const c of CASES) {
    for (const h of diagnose(c.row, c.ctx)) {
      assert.ok(['confirmed', 'likely', 'possible'].includes(h.certainty), `${c.name}: certainty ${h.certainty}`);
      assert.ok(['high', 'medium', 'low'].includes(h.confidence), `${c.name}: confidence ${h.confidence}`);
      if (h.type === 'null-field') assert.notEqual(h.certainty, 'confirmed', `${c.name}: null-field nunca es confirmed`);
      if (h.type === 'no-data' || h.type === 'no-hypothesis') assert.equal(h.certainty, 'possible', c.name);
      if (h.finding !== undefined) assert.equal(typeof h.finding, 'string');
    }
  }
});

test('corpus: precisión de confirmed = 1, de likely ≥ 0.8, y acierto top-1', () => {
  const { stats, misses } = evaluate();
  const line = (k, s) => `${k.padEnd(18)} ${String(s.hit).padStart(3)} / ${String(s.n).padEnd(3)}  ${rate(s).toFixed(2)}`;
  console.log([
    `diagnóstico sobre ${CASES.length} casos`,
    `${'métrica'.padEnd(18)} ${'ok'.padStart(3)} / n    valor`,
    line('precisión confirmed', stats.confirmed),
    line('precisión likely', stats.likely),
    line('acierto top-1', stats.top1),
    ...(misses.length ? ['fallos:', ...misses.map((m) => `  - ${m}`)] : []),
  ].join('\n'));
  assert.equal(rate(stats.confirmed), 1, `un confirmed falso es un bug:\n${misses.filter((m) => m.startsWith('confirmed')).join('\n')}`);
  assert.ok(rate(stats.likely) >= 0.8, `precisión de likely ${rate(stats.likely).toFixed(2)} < 0.8`);
  // Suelo para no retroceder sin darse cuenta; el corpus incluye fallos honestos a propósito.
  assert.ok(rate(stats.top1) >= 0.8, `acierto top-1 ${rate(stats.top1).toFixed(2)} < 0.8`);
});

test('ignored-sort: finding confirmado aunque la causa sea solo possible', () => {
  const h = diagnose(expect({ count: 3 }), { obtained: 0, response: ok({ 'x-atrezzo-ignored': 'order' }), items: rows(3), matched: 3, domCount: 0 })
    .find((x) => x.type === 'ignored-sort');
  assert.equal(h.certainty, 'possible');
  assert.equal(h.confidence, 'medium', 'confidence no cambia');
  assert.match(h.finding, /ignored order/);
});

test('pagination-mismatch: likely, con el recorte de la página como finding', () => {
  const c = CASES.find((x) => x.cause === 'pagination-mismatch');
  const h = diagnose(c.row, c.ctx).find((x) => x.type === 'pagination-mismatch');
  assert.equal(h.certainty, 'likely');
  assert.equal(h.confidence, 'high');
  assert.equal(h.finding, 'the page carries 12 of 40 items');
});

test('world-mismatch: a verified over-count (count or max) is the world, not no-hypothesis', () => {
  const ctx = { obtained: 2, response: ok({ 'x-total-count': '12' }), items: rows(5, (i) => ({ rating: [4, 5, 3, 5][i % 4] })), query: q('page=1&perPage=24'), matched: 2, fullMatched: 6 };
  for (const [bound, text] of [[{ count: 1 }, '=1'], [{ max: 1 }, '<=1'], [{ min: 0, max: 1 }, '0..1']]) {
    const hyps = diagnose(expect({ ...bound, data: { request: 'r', where: { rating: 5 } } }), ctx);
    const w = hyps.find((h) => h.type === 'world-mismatch');
    assert.equal(w?.certainty, 'likely', `${text}: ${JSON.stringify(hyps)}`);
    assert.match(w.evidence, new RegExp(`the world has 6 matching items and ${text} were expected`));
    assert.ok(!hyps.some((h) => h.type === 'no-hypothesis'), text);
  }
});

test('pagination-mismatch: a low page of a full set with enough matches stays pagination, not world', () => {
  // The full set has 6 ≥ 3 matches and this page 1: the client's paging, not the world. Also with
  // the full set over the expectation (6 > 3) the page is below it, so the world is not the claim.
  const hyps = diagnose(expect({ count: 3, data: { request: 'r', where: { rating: 5 } } }),
    { obtained: 1, response: ok({ 'x-total-count': '12' }), items: rows(5, (i) => ({ rating: i === 1 ? 5 : 4 })), query: q('page=1&perPage=24'), matched: 1, fullMatched: 6 });
  assert.equal(hyps.find((h) => h.certainty === 'likely')?.type, 'pagination-mismatch', JSON.stringify(hyps));
  assert.ok(!hyps.some((h) => h.type === 'world-mismatch'), JSON.stringify(hyps));
});

test('verify.mjs reexporta diagnose', () => {
  assert.equal(fromVerify, diagnose);
});
