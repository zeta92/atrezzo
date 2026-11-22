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

test('verify.mjs reexporta diagnose', () => {
  assert.equal(fromVerify, diagnose);
});
