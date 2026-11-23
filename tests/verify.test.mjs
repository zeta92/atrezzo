import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadFlow } from '../scripts/lib/scenario.mjs';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { runVerify, formatReport, diagnose, loadPlaywright, chromeExecutable } from '../scripts/lib/verify.mjs';
import { AtrezzoError } from '../scripts/lib/errors.mjs';
import { whereMatch } from '../scripts/lib/diagnose.mjs';
import { ROOT, SCENARIO, FLOW, tmpProject, cliAsync } from './helpers.mjs';

let dir; let mock; let url;
before(async () => {
  dir = tmpProject({
    'scenarios/conciliacion.yaml': SCENARIO,
    'flow.yaml': FLOW,
    'flujo-ko.yaml': FLOW.replace('count: 3\n', 'count: 4\n'),
  });
  mock = createMockServer({ scenariosDir: join(dir, 'scenarios') });
  const addr = await mock.listen(0);
  url = `http://127.0.0.1:${addr.port}`;
});
after(() => mock.close());

test('http driver: passing assertions ⇒ exit 0', async () => {
  const r = await runVerify(loadFlow(join(dir, 'flow.yaml')), { url, driver: 'http' });
  // customer-chip has no data ⇒ N/V; the rest is OK. Give it data for the green case.
  const ok = r.rows.filter((x) => x.status === 'OK');
  assert.equal(ok.length, 2);
  assert.equal(r.rows.find((x) => x.expect.selector === '[data-testid=customer-chip]').status, 'N/V');
  assert.equal(r.exitCode, 2, 'an unverified assertion is never green');
  writeFileSync(join(dir, 'flujo-verde.yaml'), FLOW.replace('        count: 3\n', '        count: 3\n        data: { request: customers }\n'));
  const g = await runVerify(loadFlow(join(dir, 'flujo-verde.yaml')), { url, driver: 'http' });
  assert.equal(g.exitCode, 0);
  assert.ok(g.rows.every((x) => x.status === 'OK'));
  assert.match(formatReport(g), /3 OK · 0 KO · 0 not verified → GREEN/);
});

test('http driver: failing assertion ⇒ exit 1 with expected vs obtained', async () => {
  const flowText = FLOW.replace('        count: 3\n', '        count: 4\n        data: { request: customers }\n');
  writeFileSync(join(dir, 'flujo-ko.yaml'), flowText);
  const r = await runVerify(loadFlow(join(dir, 'flujo-ko.yaml')), { url, driver: 'http', diagnose: true });
  assert.equal(r.exitCode, 1);
  const ko = r.rows.find((x) => x.status === 'KO');
  assert.equal(ko.obtained, 3);
  assert.equal(ko.expect.count, 4);
  assert.ok(ko.hypotheses.some((h) => h.type === 'world-mismatch'));
  assert.match(formatReport(r), /=4\s+3\s+KO/);
});

test('diagnosis: pagination mismatch', async () => {
  writeFileSync(join(dir, 'flujo-pag.yaml'), FLOW.replace('      issues: GET /api/orders?status=issue\n',
    '      issues: GET /api/orders?status=issue\n    expect:\n      - selector: "tr [data-status=issue]"\n        count: 3\n        data: { request: orders, where: { status: issue } }\n'));
  const flow = loadFlow(join(dir, 'flujo-pag.yaml'));
  const r = await runVerify(flow, { url, driver: 'http', diagnose: true });
  const row = r.rows.find((x) => x.expect.selector === 'tr [data-status=issue]');
  const inPage = mock.state.dataset.entities.orders.slice(0, 12).filter((p) => p.status === 'issue').length;
  if (inPage === 3) assert.equal(row.status, 'OK');
  else {
    assert.equal(row.status, 'KO');
    assert.ok(row.hypotheses.some((h) => h.type === 'pagination-mismatch' && h.confidence === 'high'));
  }
});

// B2 (references/field-reports/mealie, inj-max-limit): page pagination with default_limit 24 and
// max_limit 5. The client asks for ?page=1&perPage=24 and expects all 12 rows; the mock clamps to 5.
// Stripping page/perPage is not an unpaginated probe here: default_limit is clamped to 5 again.
const MAX_LIMIT_SCENARIO = `name: maxlimit
seed: 42
world:
  recipes:
    total: 12
    fields:
      groupSlug: ["home"]
      rating: [4, 5, 3, 5]
    values_order: cycle
endpoints:
  - path: /api/explore/groups/:group_slug/recipes
    entity: recipes
    filters: { ":group_slug": groupSlug }
    pagination: { param_page: page, param_limit: perPage, default_limit: 24, max_limit: 5 }
    shape: envelope
    envelope: { items: items, total: total, page: page, per_page: per_page, total_pages: total_pages }
`;
const maxLimitFlow = (expect) => `scenario: scenarios/maxlimit.yaml
steps:
  - screen: explorer
    visit: /g/home
    requests:
      recipes: GET /api/explore/groups/home/recipes?page=1&perPage=24
    expect:
${expect}`;

async function withMaxLimitMock(files, fn) {
  const d = tmpProject({ 'scenarios/maxlimit.yaml': MAX_LIMIT_SCENARIO, ...files });
  const m = createMockServer({ scenariosDir: join(d, 'scenarios') });
  const addr = await m.listen(0);
  const requested = [];
  const fetchImpl = (u, init) => { requested.push(String(u)); return fetch(u, init); };
  try { return await fn({ dir: d, url: `http://127.0.0.1:${addr.port}`, fetchImpl, requested }); } finally { await m.close(); }
}

const ALL_CARDS = '      - selector: ".recipe-card-footer"\n        count: 12\n        data: { request: recipes }\n';

test('diagnosis B2: max_limit truncating the full set is pagination-mismatch, not world-mismatch (http)', async () => {
  await withMaxLimitMock({ 'f.yaml': maxLimitFlow(ALL_CARDS) }, async ({ dir: d, url: u, fetchImpl, requested }) => {
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl });
    const row = r.rows[0];
    assert.equal(row.status, 'KO');
    assert.equal(row.obtained, 5);
    const strong = row.hypotheses.filter((h) => h.certainty !== 'possible');
    assert.deepEqual(strong.map((h) => h.type), ['pagination-mismatch'], JSON.stringify(row.hypotheses));
    const h = strong[0];
    assert.equal(h.certainty, 'likely');
    assert.match(h.evidence, /5 of 12 items/);
    assert.match(h.evidence, /12 match/);
    assert.match(h.evidence, /perPage=24.*max_limit: 5/, 'the clamp is the evidence, name it');
    assert.ok(!row.hypotheses.some((x) => x.type === 'world-mismatch'), 'the world has 12 rows, not 5');
    // Bounded probe: the step request + the stripped probe + ceil(12 / 5) = 3 pages at most.
    const probes = requested.filter((x) => x.includes('/api/explore/'));
    assert.ok(probes.length <= 1 + 1 + 3, `too many probe requests: ${probes.join(' ')}`);
  });
});

test('diagnosis B2: same case under playwright (fake page) is pagination-mismatch, not no-hypothesis', async () => {
  await withMaxLimitMock({ 'f.yaml': maxLimitFlow(ALL_CARDS) }, async ({ dir: d, url: u, fetchImpl }) => {
    const fp = fakePage({ '.recipe-card-footer': 5 });
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'playwright', diagnose: true, pageFactory: fp.factory, fetchImpl });
    const row = r.rows[0];
    assert.equal(row.status, 'KO');
    assert.equal(row.obtained, 5);
    const top = row.hypotheses.find((h) => h.certainty !== 'possible');
    assert.equal(top?.type, 'pagination-mismatch', JSON.stringify(row.hypotheses));
    assert.equal(top.certainty, 'likely');
  });
});

test('diagnosis B2: with a where, the full-set count is the rows that match it, not X-Total-Count', async () => {
  // rating cycles 4,5,3,5 over 12 rows ⇒ 6 rows with rating 5 in the world; X-Total-Count is 12.
  const six = '      - selector: ".five"\n        count: 6\n        data: { request: recipes, where: { rating: 5 } }\n';
  const seven = '      - selector: ".five"\n        count: 7\n        data: { request: recipes, where: { rating: 5 } }\n';
  await withMaxLimitMock({ 'six.yaml': maxLimitFlow(six), 'seven.yaml': maxLimitFlow(seven) }, async ({ dir: d, url: u, fetchImpl }) => {
    const r6 = await runVerify(loadFlow(join(d, 'six.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl });
    const h6 = r6.rows[0].hypotheses.find((h) => h.type === 'pagination-mismatch');
    assert.ok(h6, JSON.stringify(r6.rows[0].hypotheses));
    assert.equal(h6.certainty, 'likely');
    assert.match(h6.evidence, /across the full set, 6 match/);
    // 7 expected, only 6 in the world: completing the page would not reach 7, so it is the world
    // (verified over every page), even though this page is clamped to 5 rows with 2 matches; the
    // clamped probe's count (2) must not be passed off as the world's.
    const r7 = await runVerify(loadFlow(join(d, 'seven.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl });
    const hyps7 = r7.rows[0].hypotheses;
    assert.ok(!hyps7.some((h) => h.type === 'pagination-mismatch' && h.certainty === 'likely'), JSON.stringify(hyps7));
    const w7 = hyps7.find((h) => h.type === 'world-mismatch');
    assert.equal(w7?.certainty, 'likely', JSON.stringify(hyps7));
    assert.match(w7.evidence, /the world has 6 matching items and =7 were expected/);
    assert.match(w7.finding, /across the full set, 6 items match/);
  });
});

test('diagnosis B2: the full-set probe is capped; past the cap it claims nothing about the world', async () => {
  // max_limit 1 over 12 rows would take 12 pages; with 30 rows, 30 > the cap of 20 pages.
  const files = { 'scenarios/maxlimit.yaml': MAX_LIMIT_SCENARIO.replace('total: 12', 'total: 30').replace('max_limit: 5', 'max_limit: 1') };
  await withMaxLimitMock({ ...files, 'f.yaml': maxLimitFlow(ALL_CARDS.replace('count: 12', 'count: 30')) }, async ({ dir: d, url: u, fetchImpl, requested }) => {
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl });
    const row = r.rows[0];
    assert.equal(row.obtained, 1);
    assert.ok(!row.hypotheses.some((h) => h.type === 'world-mismatch'), JSON.stringify(row.hypotheses));
    assert.ok(row.hypotheses.every((h) => h.certainty === 'possible'), JSON.stringify(row.hypotheses));
    const probes = requested.filter((x) => x.includes('/api/explore/'));
    assert.ok(probes.length <= 2, `the cap must stop before walking pages: ${probes.length} requests`);
  });
});

// The response with one header rewritten (null deletes it); body and status untouched.
const withTotalHeader = (fetchImpl, value) => async (u, init) => {
  const res = await fetchImpl(u, init);
  const h = new Headers(res.headers);
  if (value === null) h.delete('x-total-count'); else h.set('x-total-count', value);
  return new Response(await res.text(), { status: res.status, headers: h });
};
const STRONG_FULL_SET = (h) => (h.type === 'world-mismatch' || h.type === 'pagination-mismatch') && (h.certainty === 'likely' || h.certainty === 'confirmed');

test('diagnosis B2: without a usable X-Total-Count the clamped probe proves nothing about the world', async () => {
  // A real server (or proxy) that drops X-Total-Count: the stripped probe is clamped to 5 again by
  // default_limit/max_limit and Number(null) === 0 must not pass those 5 off as the full set of 12.
  for (const value of [null, '', 'abc']) {
    await withMaxLimitMock({ 'f.yaml': maxLimitFlow(ALL_CARDS) }, async ({ dir: d, url: u, fetchImpl }) => {
      const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl: withTotalHeader(fetchImpl, value) });
      const row = r.rows[0];
      assert.equal(row.status, 'KO');
      assert.equal(row.obtained, 5);
      assert.ok(!row.hypotheses.some(STRONG_FULL_SET), `x-total-count=${JSON.stringify(value)}: ${JSON.stringify(row.hypotheses)}`);
    });
  }
});

test('diagnosis B2: a server that ignores page repeats rows; the walked set is not the full set', async () => {
  // 10 rows at max_limit 5: two pages add up to X-Total-Count exactly even if page 2 is page 1 again.
  const files = { 'scenarios/maxlimit.yaml': MAX_LIMIT_SCENARIO.replace('total: 12', 'total: 10') };
  await withMaxLimitMock({ ...files, 'f.yaml': maxLimitFlow(ALL_CARDS.replace('count: 12', 'count: 10')) }, async ({ dir: d, url: u, fetchImpl }) => {
    const pageOne = (x, init) => {
      const v = new URL(String(x));
      if (Number(v.searchParams.get('page')) > 1) v.searchParams.set('page', '1');
      return fetchImpl(v.toString(), init);
    };
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl: pageOne });
    const row = r.rows[0];
    assert.equal(row.status, 'KO');
    assert.equal(row.obtained, 5);
    assert.ok(!row.hypotheses.some(STRONG_FULL_SET), JSON.stringify(row.hypotheses));
  });
});

test('diagnosis B2: a huge max_limit does not make the probe ask for huge pages', async () => {
  // default_limit 1200 clamps the stripped probe (1200 of 1500); max_limit 50000 would let one page
  // carry everything, but the probe never asks for more than its own page-size cap (1000).
  const files = { 'scenarios/maxlimit.yaml': MAX_LIMIT_SCENARIO.replace('total: 12', 'total: 1500').replace('default_limit: 24, max_limit: 5', 'default_limit: 1200, max_limit: 50000') };
  const flow = maxLimitFlow(ALL_CARDS.replace('count: 12', 'count: 1500'));
  await withMaxLimitMock({ ...files, 'f.yaml': flow }, async ({ dir: d, url: u, fetchImpl, requested }) => {
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl });
    const row = r.rows[0];
    assert.equal(row.obtained, 24);
    const sizes = requested.map((x) => Number(new URL(x).searchParams.get('perPage') ?? 0));
    assert.ok(sizes.every((n) => n <= 1000), `probe page sizes above the cap: ${sizes.join(',')}`);
    const top = row.hypotheses.find((h) => h.certainty !== 'possible');
    assert.equal(top?.type, 'pagination-mismatch', JSON.stringify(row.hypotheses));
    assert.match(top.evidence, /24 of 1500 items/);
    assert.match(top.evidence, /across the full set, 1500 match/);
  });
  // Same endpoint, but X-Total-Count claims 25000: at 1000 per page that is 25 pages > the 20-page
  // cap, so the probe stops after the stripped request and claims nothing.
  await withMaxLimitMock({ ...files, 'f.yaml': flow }, async ({ dir: d, url: u, fetchImpl, requested }) => {
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl: withTotalHeader(fetchImpl, '25000') });
    const row = r.rows[0];
    assert.ok(!row.hypotheses.some(STRONG_FULL_SET), JSON.stringify(row.hypotheses));
    const probes = requested.filter((x) => x.includes('/api/explore/'));
    assert.ok(probes.length <= 2, `past the page cap only the step and the stripped probe: ${probes.join(' ')}`);
  });
});

test('diagnosis B2: a page far larger than asked (server ignores the page size) neither crashes nor counts', async () => {
  // X-Total-Count 15 at max_limit 5 is 3 pages; page 1 answers 200000 items, which overflows a
  // spread push (RangeError) on V8.
  await withMaxLimitMock({ 'f.yaml': maxLimitFlow(ALL_CARDS) }, async ({ dir: d, url: u, fetchImpl }) => {
    const huge = JSON.stringify({ items: Array.from({ length: 200000 }, (_, i) => ({ id: i + 1 })), total: 15 });
    const ignoring = async (x, init) => {
      const v = new URL(String(x));
      if (!v.searchParams.has('page')) return new Response(JSON.stringify({ items: Array.from({ length: 5 }, (_, i) => ({ id: i + 1 })), total: 15 }), { status: 200, headers: { 'x-total-count': '15' } });
      if (v.searchParams.get('perPage') !== '24') return new Response(huge, { status: 200, headers: { 'x-total-count': '15' } });
      return fetchImpl(x, init);
    };
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl: ignoring });
    const row = r.rows[0];
    assert.equal(row.status, 'KO');
    assert.ok(!row.hypotheses.some(STRONG_FULL_SET), JSON.stringify(row.hypotheses));
  });
});

test('diagnosis B2: perPage omitted with default_limit above max_limit reports the clamp', async () => {
  const flow = maxLimitFlow(ALL_CARDS).replace('?page=1&perPage=24', '?page=1');
  await withMaxLimitMock({ 'f.yaml': flow }, async ({ dir: d, url: u, fetchImpl }) => {
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl });
    const top = r.rows[0].hypotheses.find((h) => h.certainty !== 'possible');
    assert.equal(top?.type, 'pagination-mismatch', JSON.stringify(r.rows[0].hypotheses));
    assert.match(top.evidence, /default_limit: 24.*max_limit: 5/, top.evidence);
  });
});

// ---------- B2 hardening v2: the probe is bounded, gated on a KO row and fails closed ----------

/** fetchImpl that records, per request, the URL and how many items its (envelope) body carried. */
const sizing = (fetchImpl, seen) => async (u, init) => {
  const res = await fetchImpl(u, init);
  const text = await res.text();
  let n = null;
  try { const b = JSON.parse(text); n = Array.isArray(b) ? b.length : Array.isArray(b?.items) ? b.items.length : null; } catch { /* not JSON */ }
  seen.push({ url: String(u), n });
  return new Response(text, { status: res.status, headers: res.headers });
};
const apiCalls = (requested) => requested.filter((x) => x.includes('/api/explore/'));

test('diagnosis B2v2: the first probe is an explicit bounded page, never the unpaginated collection', async () => {
  // max_limit 50000 and a default_limit of 5000 (page) or none at all (offset): dropping the
  // pagination params would ask for, and receive, all 1500 rows in one response.
  const variants = [
    { pagination: 'pagination: { param_page: page, param_limit: perPage, default_limit: 5000, max_limit: 50000 }', query: '?page=1&perPage=24' },
    { pagination: 'pagination: { param_limit: perPage, param_offset: offset, max_limit: 50000 }', query: '?perPage=24&offset=0' },
  ];
  for (const v of variants) {
    const files = { 'scenarios/maxlimit.yaml': MAX_LIMIT_SCENARIO.replace('total: 12', 'total: 1500').replace(/pagination: \{[^}]*\}/, v.pagination) };
    const flow = maxLimitFlow(ALL_CARDS.replace('count: 12', 'count: 1500')).replace('?page=1&perPage=24', v.query);
    await withMaxLimitMock({ ...files, 'f.yaml': flow }, async ({ dir: d, url: u, fetchImpl }) => {
      const seen = [];
      const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl: sizing(fetchImpl, seen) });
      const row = r.rows[0];
      assert.equal(row.obtained, 24);
      const api = seen.filter((s) => s.url.includes('/api/explore/'));
      assert.ok(api.length >= 2, `a probe ran: ${api.map((s) => s.url).join(' ')}`);
      for (const s of api) {
        assert.ok(s.n !== null && s.n <= 1000, `${v.query}: ${s.url} received ${s.n} items`);
        const asked = Number(new URL(s.url).searchParams.get('perPage'));
        assert.ok(asked > 0 && asked <= 1000, `${v.query}: ${s.url} does not bound its page size`);
      }
      const top = row.hypotheses.find((h) => h.certainty !== 'possible');
      assert.equal(top?.type, 'pagination-mismatch', JSON.stringify(row.hypotheses));
      assert.match(top.evidence, /24 of 1500 items/);
      assert.match(top.evidence, /across the full set, 1500 match/);
    });
  }
});

test('diagnosis B2v2: without a declared pagination to bound it, the probe claims nothing (custom ?p=&n=)', async () => {
  // A real server paginating by ?p=&n= without X-Total-Count. Neither "no scenario" nor an endpoint
  // without pagination can tell its 5 rows from the full set.
  const five = () => new Response(JSON.stringify({ items: Array.from({ length: 5 }, (_, i) => ({ id: i + 1 })) }), { status: 200, headers: { 'content-type': 'application/json' } });
  const expect = '    expect:\n      - selector: ".recipe-card-footer"\n        count: 12\n        data: { request: recipes, pick: items }\n';
  const noScenario = `steps:\n  - screen: explorer\n    requests:\n      recipes: GET /api/explore/groups/home/recipes?p=1&n=5\n${expect}`;
  const noPagination = `scenario: scenarios/maxlimit.yaml\n${noScenario}`;
  const d = tmpProject({ 'scenarios/maxlimit.yaml': MAX_LIMIT_SCENARIO.replace(/\n {4}pagination: [^\n]*/, ''), 'a.yaml': noScenario, 'b.yaml': noPagination });
  for (const f of ['a.yaml', 'b.yaml']) {
    const requested = [];
    const fetchImpl = async (u) => {
      requested.push(String(u));
      return String(u).endsWith('/__atrezzo/reset') ? new Response('{}', { status: 200 }) : five();
    };
    const r = await runVerify(loadFlow(join(d, f)), { url: 'http://stub.invalid', driver: 'http', diagnose: true, fetchImpl });
    const row = r.rows[0];
    assert.equal(row.status, 'KO');
    assert.equal(row.obtained, 5);
    assert.ok(!row.hypotheses.some(STRONG_FULL_SET), `${f}: ${JSON.stringify(row.hypotheses)}`);
    assert.equal(apiCalls(requested).length, 1, `${f}: no probe request: ${requested.join(' ')}`);
  }
});

test('diagnosis B2v2: a passing row triggers no full-set probe (http and playwright)', async () => {
  const five = '      - selector: ".recipe-card-footer"\n        count: 5\n        data: { request: recipes }\n';
  await withMaxLimitMock({ 'f.yaml': maxLimitFlow(five) }, async ({ dir: d, url: u, fetchImpl, requested }) => {
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl });
    assert.equal(r.rows[0].status, 'OK');
    assert.deepEqual(apiCalls(requested), [`${u}/api/explore/groups/home/recipes?page=1&perPage=24`]);
  });
  await withMaxLimitMock({ 'f.yaml': maxLimitFlow(five) }, async ({ dir: d, url: u, fetchImpl, requested }) => {
    const fp = fakePage({ '.recipe-card-footer': 5 });
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'playwright', diagnose: true, pageFactory: fp.factory, fetchImpl });
    assert.equal(r.rows[0].status, 'OK');
    assert.equal(apiCalls(requested).length, 1, apiCalls(requested).join(' '));
  });
});

test('diagnosis B2v2: playwright skips the probe when the KO is a known navigation failure', async () => {
  await withMaxLimitMock({ 'f.yaml': maxLimitFlow(ALL_CARDS) }, async ({ dir: d, url: u, fetchImpl, requested }) => {
    let at = null;
    const factory = async () => ({
      page: {
        goto: async () => { at = `${u}/login`; },
        url: () => at,
        waitForLoadState: async () => {},
        waitForSelector: async () => {},
        locator: () => ({ count: async () => 5 }),
      },
      close: async () => {},
    });
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'playwright', diagnose: true, pageFactory: factory, fetchImpl });
    const row = r.rows[0];
    assert.equal(row.status, 'KO');
    assert.equal(row.hypotheses?.[0]?.type, 'navigation', JSON.stringify(row.hypotheses));
    assert.equal(apiCalls(requested).length, 1, `only the step's request: ${apiCalls(requested).join(' ')}`);
  });
});

test('diagnosis B2v2: X-Total-Count below the first page length is contradictory; no full-set claim', async () => {
  await withMaxLimitMock({ 'f.yaml': maxLimitFlow(ALL_CARDS) }, async ({ dir: d, url: u, fetchImpl }) => {
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl: withTotalHeader(fetchImpl, '3') });
    const row = r.rows[0];
    assert.equal(row.status, 'KO');
    assert.equal(row.obtained, 5);
    assert.ok(!row.hypotheses.some(STRONG_FULL_SET), JSON.stringify(row.hypotheses));
  });
});

test('diagnosis B2v2: a verified over-count is world-mismatch, for count and for max', async () => {
  // rating 4,5,3,5 over 12 rows: 6 in the world have rating 5; the clamped first page (5 rows) has 2.
  const cases = [['count: 1', '=1'], ['max: 1', '<=1']];
  for (const [bound, text] of cases) {
    const flow = maxLimitFlow(`      - selector: ".five"\n        ${bound}\n        data: { request: recipes, where: { rating: 5 } }\n`);
    await withMaxLimitMock({ 'f.yaml': flow }, async ({ dir: d, url: u, fetchImpl }) => {
      const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl });
      const row = r.rows[0];
      assert.equal(row.status, 'KO');
      assert.equal(row.obtained, 2);
      const w = row.hypotheses.find((h) => h.type === 'world-mismatch');
      assert.equal(w?.certainty, 'likely', `${bound}: ${JSON.stringify(row.hypotheses)}`);
      assert.ok(w.evidence.includes(`the world has 6 matching items and ${text} were expected`), w.evidence);
      assert.ok(!row.hypotheses.some((h) => h.type === 'no-hypothesis'), JSON.stringify(row.hypotheses));
    });
  }
});

// The step's own request (and the mock's reset) go through untouched; every other request (the probe) is rewritten.
const probeOnly = (fetchImpl, stepUrl, rewrite) => (u, init) => (String(u) === stepUrl || String(u).includes('/__atrezzo/') ? fetchImpl(u, init) : rewrite(u, init));
const STEP_URL = (u) => `${u}/api/explore/groups/home/recipes?page=1&perPage=24`;
const FAST_PROBE = { requestMs: 200, totalMs: 600 };

test('diagnosis B2v2: a hanging probe response fails closed within the probe deadline', { timeout: 15_000 }, async () => {
  const hangingBody = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"items":[')); } }), { status: 200, headers: { 'x-total-count': '12' } });
  const neverAnswers = () => new Promise(() => {}); // ignores the AbortSignal too
  for (const hang of [hangingBody, neverAnswers]) {
    await withMaxLimitMock({ 'f.yaml': maxLimitFlow(ALL_CARDS) }, async ({ dir: d, url: u, fetchImpl }) => {
      const t0 = Date.now();
      const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, probeLimits: FAST_PROBE, fetchImpl: probeOnly(fetchImpl, STEP_URL(u), hang) });
      const row = r.rows[0];
      assert.ok(Date.now() - t0 < 5_000, `${hang.name}: took ${Date.now() - t0} ms`);
      assert.equal(row.status, 'KO');
      assert.equal(row.obtained, 5);
      assert.ok(!row.hypotheses.some(STRONG_FULL_SET), `${hang.name}: ${JSON.stringify(row.hypotheses)}`);
    });
  }
});

/** Probe responses with every item padded by `bytes` characters (same rows, same headers). */
const padded = (fetchImpl, bytes) => async (u, init) => {
  const res = await fetchImpl(u, init);
  const body = await res.json();
  const pad = 'x'.repeat(bytes);
  if (Array.isArray(body?.items)) body.items = body.items.map((it) => ({ ...it, pad }));
  return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
};

test('diagnosis B2v2: a probe page over the per-page byte cap fails closed', { timeout: 30_000 }, async () => {
  // 5 rows of 1.3 MiB: a 6.5 MiB page, above the 5 MiB cap, though it has no more rows than asked.
  await withMaxLimitMock({ 'f.yaml': maxLimitFlow(ALL_CARDS) }, async ({ dir: d, url: u, fetchImpl }) => {
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl: probeOnly(fetchImpl, STEP_URL(u), padded(fetchImpl, 1.3 * 2 ** 20)) });
    const row = r.rows[0];
    assert.equal(row.obtained, 5);
    assert.ok(!row.hypotheses.some(STRONG_FULL_SET), JSON.stringify(row.hypotheses));
  });
});

test('diagnosis B2v2: probe pages adding up past the total byte cap fail closed', { timeout: 60_000 }, async () => {
  // 30 rows at max_limit 5 = 6 pages of 5 × 0.8 MiB = 4 MiB each: every page under 5 MiB, 24 MiB > 20 MiB.
  const files = { 'scenarios/maxlimit.yaml': MAX_LIMIT_SCENARIO.replace('total: 12', 'total: 30') };
  await withMaxLimitMock({ ...files, 'f.yaml': maxLimitFlow(ALL_CARDS.replace('count: 12', 'count: 30')) }, async ({ dir: d, url: u, fetchImpl }) => {
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl: probeOnly(fetchImpl, STEP_URL(u), padded(fetchImpl, 0.8 * 2 ** 20)) });
    const row = r.rows[0];
    assert.equal(row.obtained, 5);
    assert.ok(!row.hypotheses.some(STRONG_FULL_SET), JSON.stringify(row.hypotheses));
  });
});

test('diagnosis B2v2: an undeclared lower page cap is followed at the observed size', async () => {
  // The scenario declares max_limit 5, but the server serves at most 3 rows per page, whatever is asked.
  await withMaxLimitMock({ 'f.yaml': maxLimitFlow(ALL_CARDS) }, async ({ dir: d, url: u, fetchImpl, requested }) => {
    const capped = (x, init) => {
      const v = new URL(String(x));
      if (v.pathname.startsWith('/api/') && !(Number(v.searchParams.get('perPage')) <= 3)) v.searchParams.set('perPage', '3');
      return fetchImpl(v.toString(), init);
    };
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl: capped });
    const row = r.rows[0];
    assert.equal(row.obtained, 3);
    const top = row.hypotheses.find((h) => h.certainty !== 'possible');
    assert.equal(top?.type, 'pagination-mismatch', JSON.stringify(row.hypotheses));
    assert.match(top.evidence, /3 of 12 items/);
    assert.match(top.evidence, /across the full set, 12 match/);
    assert.ok(apiCalls(requested).length <= 1 + 4, `step + ceil(12 / 3) pages at most: ${apiCalls(requested).join(' ')}`);
  });
});

// B3 (references/field-reports/mealie, inj-ignored-sort): the endpoint declares no sort, so the mock
// ignores orderBy and orderDirection. Page 1 of 4 carries ratings 4,5,3,5 (2 fives); the world has 6
// fives, so sorting the whole set by rating desc would put 4 fives on page 1. Only the proven full
// set shows that: page 1 alone holds 2 fives, sorted or not.
test('diagnosis B3: ignored orderBy+orderDirection proven over the full set is ignored-sort, not a filter or pagination', async () => {
  const flow = maxLimitFlow('      - selector: ".recipe-card"\n        count: 4\n        data: { request: recipes, where: { rating: 5 } }\n')
    .replace('?page=1&perPage=24', '?page=1&perPage=4&orderBy=rating&orderDirection=desc');
  await withMaxLimitMock({ 'f.yaml': flow }, async ({ dir: d, url: u, fetchImpl }) => {
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl });
    const row = r.rows[0];
    assert.equal(row.status, 'KO');
    assert.equal(row.obtained, 2);
    const hyps = JSON.stringify(row.hypotheses);
    assert.ok(!row.hypotheses.some((h) => h.type === 'undeclared-filter' && /orderDirection/.test(h.evidence)), `orderDirection is a sort direction, not a filter: ${hyps}`);
    const top = row.hypotheses.find((h) => h.certainty !== 'possible');
    assert.equal(top?.type, 'ignored-sort', hyps);
    assert.equal(top.certainty, 'likely');
    assert.match(top.evidence, /`orderBy`, `orderDirection`/);
    assert.match(top.evidence, /sorting the full set \(12 items\) by rating desc puts 4 matching items on this page/, top.evidence);
    assert.ok(!row.hypotheses.some((h) => h.type === 'pagination-mismatch' && h.certainty === 'likely'), `the page size is honoured; the order is not: ${hyps}`);
    assert.ok(!JSON.stringify(r).includes('fullItems'), 'the full set stays internal to the diagnosis');
  });
});

/** ctx for an ignored-sort diagnosis over a proven full set; `page` is the served slice of `full`. */
function sortCtx({ query, ignored, full, page, where, total, clampedLimit }) {
  const headers = { 'x-atrezzo-ignored': ignored, ...(total !== undefined ? { 'x-total-count': String(total) } : {}) };
  return {
    obtained: page.filter((it) => whereMatch(it, where)).length,
    response: { status: 200, headers },
    query: new URLSearchParams(query),
    items: page,
    fullItems: full,
    matched: page.filter((it) => whereMatch(it, where)).length,
    fullMatched: full.filter((it) => whereMatch(it, where)).length,
    ...(clampedLimit ? { clampedLimit } : {}),
  };
}
const ratings = (...rs) => rs.map((rating, i) => ({ id: i + 1, rating }));

test('diagnose() B3: the full-set sort counterfactual puts nulls first in desc, like contract compare()', () => {
  // contract.mjs sorts desc as -compare(a, b): nulls (last in asc) come first in desc. Sorted desc the
  // set is null, null, 2, 1, so page 1 (2 rows) holds both nulls; nulls-last-in-desc would give 0.
  const full = ratings(1, 2, null, null);
  const where = { rating: null };
  const row = { expect: { selector: 'x', count: 2, data: { request: 'r', where } } };
  const hyps = diagnose(row, sortCtx({ query: 'orderBy=rating&orderDirection=desc', ignored: 'orderBy, orderDirection', full, page: full.slice(0, 2), where }));
  const s = hyps.find((h) => h.type === 'ignored-sort');
  assert.equal(s?.certainty, 'likely', JSON.stringify(hyps));
  assert.match(s.evidence, /sorting the full set \(4 items\) by rating desc puts 2 matching items on this page/, s.evidence);
});

test('diagnose() B3: numeric-looking strings sort lexically in the full-set counterfactual, like contract compare()', () => {
  // Lexically '10' < '2' < '3': page 1 (1 row) sorted asc is '10'. Numeric coercion would put '2' first.
  const full = [{ id: 1, code: '2' }, { id: 2, code: '10' }, { id: 3, code: '3' }];
  const where = { code: '10' };
  const row = { expect: { selector: 'x', count: 1, data: { request: 'r', where } } };
  const hyps = diagnose(row, sortCtx({ query: 'orderBy=code&orderDirection=asc', ignored: 'orderBy, orderDirection', full, page: full.slice(0, 1), where }));
  const s = hyps.find((h) => h.type === 'ignored-sort');
  assert.equal(s?.certainty, 'likely', JSON.stringify(hyps));
  assert.match(s.evidence, /by code asc puts 1 matching items on this page/, s.evidence);
});

test('diagnose() B3: a direction key before the field key still advises by: orderBy, order: orderDirection', () => {
  // ratings 4,5,3,5,5,5; page 1 of 2 rows has one 5; sorted DESC it has two.
  const full = ratings(4, 5, 3, 5, 5, 5);
  const where = { rating: 5 };
  const row = { expect: { selector: 'x', count: 2, data: { request: 'r', where } } };
  const hyps = diagnose(row, sortCtx({ query: 'orderDirection=DESC&orderBy=rating', ignored: 'orderDirection, orderBy', full, page: full.slice(0, 2), where }));
  const s = hyps.find((h) => h.type === 'ignored-sort');
  assert.equal(s?.certainty, 'likely', JSON.stringify(hyps));
  assert.match(s.evidence, /sorts: \{ by: orderBy, order: orderDirection, fields: \[<columns>\] \}/, s.evidence);
  assert.doesNotMatch(s.evidence, /by: orderDirection/, s.evidence);
  assert.match(s.evidence, /by rating desc puts 2 matching items/, `uppercase DESC is a descending order: ${s.evidence}`);
  assert.ok(!hyps.some((h) => h.type === 'undeclared-filter'), JSON.stringify(hyps));
});

test('diagnose() B3: an ignored direction alone is not a field key and gets no by: advice', () => {
  const full = ratings(4, 5, 3, 5, 5, 5);
  const where = { rating: 5 };
  const row = { expect: { selector: 'x', count: 2, data: { request: 'r', where } } };
  const hyps = diagnose(row, sortCtx({ query: 'orderDirection=desc', ignored: 'orderDirection', full, page: full.slice(0, 2), where }));
  const s = hyps.find((h) => h.type === 'ignored-sort');
  assert.ok(s, JSON.stringify(hyps));
  assert.equal(s.certainty, 'possible', s.evidence);
  assert.doesNotMatch(s.evidence, /by: orderDirection/, s.evidence);
  assert.doesNotMatch(s.evidence, /orders by `orderDirection`/, s.evidence);
  assert.match(s.evidence, /field key cannot be inferred/, s.evidence);
  assert.ok(!hyps.some((h) => h.type === 'undeclared-filter'), JSON.stringify(hyps));
});

test('diagnose() B3: an ambiguous order=desc listed before sort=rating is the direction, so by: sort, order: order', () => {
  const full = ratings(4, 5, 3, 5, 5, 5);
  const where = { rating: 5 };
  const row = { expect: { selector: 'x', count: 2, data: { request: 'r', where } } };
  const hyps = diagnose(row, sortCtx({ query: 'order=desc&sort=rating', ignored: 'order,sort', full, page: full.slice(0, 2), where }));
  const s = hyps.find((h) => h.type === 'ignored-sort');
  assert.equal(s?.certainty, 'likely', JSON.stringify(hyps));
  assert.match(s.evidence, /sorts: \{ by: sort, order: order, fields: \[<columns>\] \}/, s.evidence);
  assert.doesNotMatch(s.evidence, /by: order\b/, s.evidence);
  assert.match(s.evidence, /orders by `sort`, `order`/, s.evidence);
  assert.match(s.evidence, /by rating desc puts 2 matching items/, s.evidence);
  assert.ok(!hyps.some((h) => h.type === 'undeclared-filter'), JSON.stringify(hyps));
});

test('diagnose() B3: sort.order / sorts.order carrying only a direction are never the by: key', () => {
  const full = ratings(4, 5, 3, 5, 5, 5);
  const where = { rating: 5 };
  const row = { expect: { selector: 'x', count: 2, data: { request: 'r', where } } };
  for (const [dir, by] of [['sort.order', 'sort.by'], ['sorts.order', 'sorts.by']]) {
    const hyps = diagnose(row, sortCtx({ query: `${dir}=desc&${by}=rating`, ignored: `${dir},${by}`, full, page: full.slice(0, 2), where }));
    const s = hyps.find((h) => h.type === 'ignored-sort');
    assert.equal(s?.certainty, 'likely', JSON.stringify(hyps));
    assert.ok(s.evidence.includes(`sorts: { by: ${by}, order: ${dir}, fields: [<columns>] }`), s.evidence);
  }
});

test('diagnose() B3: an ambiguous order carrying a field (order=rating) stays the by: key', () => {
  const full = ratings(4, 5, 3, 5, 5, 5);
  const where = { rating: 5 };
  const row = { expect: { selector: 'x', count: 2, data: { request: 'r', where } } };
  const hyps = diagnose(row, sortCtx({ query: 'order=rating&dir=desc', ignored: 'order,dir', full, page: full.slice(0, 2), where }));
  const s = hyps.find((h) => h.type === 'ignored-sort');
  assert.equal(s?.certainty, 'likely', JSON.stringify(hyps));
  assert.match(s.evidence, /sorts: \{ by: order, order: dir, fields: \[<columns>\] \}/, s.evidence);
});

test('diagnose() B3: an ambiguous order=desc alone is direction-only: possible, no by: advice', () => {
  const full = ratings(4, 5, 3, 5, 5, 5);
  const where = { rating: 5 };
  const row = { expect: { selector: 'x', count: 2, data: { request: 'r', where } } };
  const hyps = diagnose(row, sortCtx({ query: 'order=desc', ignored: 'order', full, page: full.slice(0, 2), where }));
  const s = hyps.find((h) => h.type === 'ignored-sort');
  assert.equal(s?.certainty, 'possible', JSON.stringify(hyps));
  assert.doesNotMatch(s.evidence, /by: order\b/, s.evidence);
  assert.match(s.evidence, /field key cannot be inferred/, s.evidence);
});

test('diagnose() B3: an ignored direction whose field key is in the query but not ignored infers by: from the query', () => {
  // The endpoint honours orderBy (served ascending) but ignores orderDirection: sorted desc, page 1 holds two 5s.
  const full = ratings(3, 4, 5, 5);
  const where = { rating: 5 };
  const row = { expect: { selector: 'x', count: 2, data: { request: 'r', where } } };
  const hyps = diagnose(row, sortCtx({ query: 'orderBy=rating&orderDirection=desc', ignored: 'orderDirection', full, page: full.slice(0, 2), where }));
  const s = hyps.find((h) => h.type === 'ignored-sort');
  assert.equal(s?.certainty, 'likely', JSON.stringify(hyps));
  assert.match(s.evidence, /sorts: \{ by: orderBy, order: orderDirection, fields: \[<columns>\] \}/, s.evidence);
  assert.doesNotMatch(s.evidence, /cannot be inferred/, s.evidence);
  assert.doesNotMatch(s.evidence, /by: orderDirection/, s.evidence);
  assert.match(s.evidence, /by rating desc puts 2 matching items on this page; as served it has 0/, s.evidence);
  assert.match(s.evidence, /field key `orderBy` \(in the query, not ignored\)/, s.evidence);
});

test('diagnose() B3: a max_limit clamp keeps pagination-mismatch likely next to a proven ignored sort', () => {
  const full = ratings(4, 5, 3, 5, 5, 5);
  const where = { rating: 5 };
  const row = { expect: { selector: 'x', count: 2, data: { request: 'r', where } } };
  const ctx = sortCtx({ query: 'orderBy=rating&orderDirection=desc&perPage=24', ignored: 'orderBy, orderDirection', full, page: full.slice(0, 2), where, total: 6,
    clampedLimit: { param: 'perPage', requested: 24, max: 2 } });
  const hyps = diagnose(row, ctx);
  assert.equal(hyps.find((h) => h.type === 'ignored-sort')?.certainty, 'likely', JSON.stringify(hyps));
  assert.equal(hyps.find((h) => h.type === 'pagination-mismatch')?.certainty, 'likely', JSON.stringify(hyps));
  // Without the clamp the proven order explains the short page: pagination-mismatch drops to possible.
  delete ctx.clampedLimit;
  assert.equal(diagnose(row, ctx).find((h) => h.type === 'pagination-mismatch')?.certainty, 'possible');
});

test('diagnose() B3: a served page 2 is compared with page 2 of the sorted full set', () => {
  // ratings 6,1,5,2,4,3: served page 2 (offset 2) is 5,2; sorted desc, page 2 is 4,3 (page 1 is 6,5).
  const full = ratings(6, 1, 5, 2, 4, 3);
  const where = { rating: [4, 3] };
  const row = { expect: { selector: 'x', count: 2, data: { request: 'r', where } } };
  const hyps = diagnose(row, sortCtx({ query: 'orderBy=rating&orderDirection=desc&page=2', ignored: 'orderBy, orderDirection', full, page: full.slice(2, 4), where }));
  const s = hyps.find((h) => h.type === 'ignored-sort');
  assert.equal(s?.certainty, 'likely', JSON.stringify(hyps));
  assert.match(s.evidence, /by rating desc puts 2 matching items on this page; as served it has 0/, s.evidence);
});

test('diagnose() B3: a served page that is not a contiguous slice of the full set falls back to the page-only check', () => {
  const full = ratings(1, 2, 6, 3);
  const where = { rating: 6 };
  const row = { expect: { selector: 'x', count: 1, data: { request: 'r', where } } };
  const page = [full[0], full[2]]; // ratings 1, 6: not a slice of the full set
  const ctx = sortCtx({ query: 'orderBy=rating&orderDirection=desc', ignored: 'orderBy, orderDirection', full, page, where });
  const hyps = diagnose(row, ctx);
  const s = hyps.find((h) => h.type === 'ignored-sort');
  // Sorting the page itself puts the 6 first, but the page contradicts the proven set: only possible.
  assert.equal(s?.certainty, 'possible', JSON.stringify(hyps));
  assert.doesNotMatch(s.evidence, /sorting the full set/, s.evidence);
  assert.match(s.evidence, /not a slice of the proven full set \(4 items\)/, s.evidence);
  // Without a proven full set, the same page-only proof keeps its certainty.
  delete ctx.fullItems;
  const alone = diagnose(row, ctx).find((h) => h.type === 'ignored-sort');
  assert.equal(alone?.certainty, 'likely', alone?.evidence);
  assert.doesNotMatch(alone.evidence, /not a slice/, alone.evidence);
});

// B4 (references/field-reports/mealie, inj-wrong-envelope): the endpoint declares its envelope
// items at `data`, the flow explicitly picks `items`. The response is { data: [12 rows], ... }, so
// the pick counts 0 from a key that is not there. That is a proven key mismatch, not a world short
// of rows; the row stays KO (the user's pick is never swapped for the declared one).
const WRONG_ENVELOPE_SCENARIO = `name: wrongenv
seed: 42
world:
  recipes:
    total: 12
    fields:
      groupSlug: ["home"]
endpoints:
  - path: /api/explore/groups/:group_slug/recipes
    entity: recipes
    filters: { ":group_slug": groupSlug }
    pagination: { param_page: page, param_limit: perPage, default_limit: 24, max_limit: 100 }
    shape: envelope
    envelope: { items: data, total: total, page: page, per_page: per_page, total_pages: total_pages }
  - path: /api/plain/recipes
    entity: recipes
  - path: /api/paged/groups/:group_slug/recipes
    entity: recipes
    filters: { ":group_slug": groupSlug }
    pagination: { param_page: page, param_limit: perPage, default_limit: 24 }
`;
const wrongEnvFlow = (request, expect) => `scenario: scenarios/wrongenv.yaml
steps:
  - screen: explorer
    visit: /g/home
    requests:
      recipes: GET ${request}
    expect:
${expect}`;
const HOME = '/api/explore/groups/home/recipes?page=1&perPage=24';
const cardsPicking = (pick, count = 12) => `      - selector: ".recipe-card-footer"\n        count: ${count}\n        data: { request: recipes, pick: ${pick} }\n`;

async function withWrongEnvMock(files, fn) {
  const d = tmpProject({ 'scenarios/wrongenv.yaml': WRONG_ENVELOPE_SCENARIO, ...files });
  const m = createMockServer({ scenariosDir: join(d, 'scenarios') });
  const addr = await m.listen(0);
  const requested = [];
  const fetchImpl = (u, init) => { requested.push(String(u)); return fetch(u, init); };
  try { return await fn({ dir: d, url: `http://127.0.0.1:${addr.port}`, fetchImpl, requested }); } finally { await m.close(); }
}

const assertEnvelopeMismatch = (row) => {
  const strong = row.hypotheses.filter((h) => h.certainty !== 'possible');
  assert.deepEqual(strong.map((h) => h.type), ['envelope-key-mismatch'], JSON.stringify(row.hypotheses));
  const h = strong[0];
  assert.equal(h.certainty, 'confirmed');
  assert.equal(h.confidence, 'high');
  assert.match(h.evidence, /data\.pick "items"/, 'names the flow pick');
  assert.match(h.evidence, /envelope items at "data"/, 'names the declared envelope path');
  assert.match(h.evidence, /12 item/, 'says what the declared path holds');
  assert.match(h.finding, /"items" is absent/);
  assert.match(h.finding, /"data" holds 12 item/);
  assert.ok(!row.hypotheses.some((x) => x.type === 'world-mismatch'), 'the world has the 12 rows: no world-mismatch of any certainty');
  assert.match(row.note, /data\.pick "items" is absent from the response/);
};

test('diagnosis B4: an explicit pick absent from the declared envelope is envelope-key-mismatch, not world-mismatch (http)', async () => {
  await withWrongEnvMock({ 'f.yaml': wrongEnvFlow(HOME, cardsPicking('items')) }, async ({ dir: d, url: u, fetchImpl, requested }) => {
    // Precondition: the real serve engine answers the list under `data`, and there is no `items`.
    const body = await (await fetch(`${u}${HOME}`)).json();
    assert.equal(body.data.length, 12);
    assert.ok(!('items' in body));
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl });
    const row = r.rows[0];
    assert.equal(row.status, 'KO', 'the user pick is not replaced: the row stays KO');
    assert.equal(row.obtained, 0);
    assert.equal(r.exitCode, 1);
    assertEnvelopeMismatch(row);
    assert.equal(apiCalls(requested).length, 1, `a row explained by the envelope mismatch runs no full-set probe: ${apiCalls(requested).join(' ')}`);
  });
});

test('diagnosis B4: same case under playwright (fake page) is envelope-key-mismatch, not no-hypothesis', async () => {
  await withWrongEnvMock({ 'f.yaml': wrongEnvFlow(HOME, cardsPicking('items')) }, async ({ dir: d, url: u, fetchImpl }) => {
    // As in Mealie: the client reads `items`, finds nothing and renders no card.
    const fp = fakePage({ '.recipe-card-footer': 0 });
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'playwright', diagnose: true, pageFactory: fp.factory, fetchImpl });
    const row = r.rows[0];
    assert.equal(row.status, 'KO');
    assert.equal(row.obtained, 0);
    assertEnvelopeMismatch(row);
  });
});

test('diagnosis B4: under playwright a matching DOM does not make an absent pick OK (F8)', async () => {
  await withWrongEnvMock({ 'f.yaml': wrongEnvFlow(HOME, cardsPicking('items')) }, async ({ dir: d, url: u, fetchImpl }) => {
    const fp = fakePage({ '.recipe-card-footer': 12 });
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'playwright', diagnose: true, pageFactory: fp.factory, fetchImpl });
    const row = r.rows[0];
    assert.equal(row.obtained, 12, 'the DOM count matches');
    assert.equal(row.status, 'KO', 'the declared pick does not prove the 12 rows: the row cannot be OK');
    assertEnvelopeMismatch(row);
  });
});

test('diagnosis B4: an absent pick never proves an expectation of 0 rows', async () => {
  await withWrongEnvMock({ 'f.yaml': wrongEnvFlow(HOME, cardsPicking('items', 0)) }, async ({ dir: d, url: u, fetchImpl }) => {
    for (const driver of ['http', 'playwright']) {
      const fp = fakePage({ '.recipe-card-footer': 0 });
      const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver, diagnose: true, pageFactory: fp.factory, fetchImpl });
      const row = r.rows[0];
      assert.equal(row.status, 'KO', `${driver}: 0 counted from a missing key is not 0 rows`);
      assert.equal(r.exitCode, 1);
      assert.equal(row.hypotheses?.[0]?.type, 'envelope-key-mismatch', `${driver}: ${JSON.stringify(row.hypotheses)}`);
    }
  });
});

test('diagnosis B4 control: the declared pick is OK, and a present pick holding an empty list is no key mismatch', async () => {
  const empty = '/api/explore/groups/nobody/recipes?page=1&perPage=24';
  await withWrongEnvMock({
    'ok.yaml': wrongEnvFlow(HOME, cardsPicking('data')),
    'empty.yaml': wrongEnvFlow(empty, cardsPicking('data', 3)),
    'empty0.yaml': wrongEnvFlow(empty, cardsPicking('data', 0)),
  }, async ({ dir: d, url: u, fetchImpl }) => {
    const ok = await runVerify(loadFlow(join(d, 'ok.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl });
    assert.equal(ok.rows[0].status, 'OK');
    assert.equal(ok.exitCode, 0);
    // `data` exists and is [] (no recipe in group "nobody"): the world really has no rows.
    const body = await (await fetch(`${u}${empty}`)).json();
    assert.deepEqual(body.data, []);
    for (const driver of ['http', 'playwright']) {
      const fp = fakePage({ '.recipe-card-footer': 0 });
      const r = await runVerify(loadFlow(join(d, 'empty.yaml')), { url: u, driver, diagnose: true, pageFactory: fp.factory, fetchImpl });
      const row = r.rows[0];
      assert.equal(row.status, 'KO');
      assert.ok(!row.hypotheses.some((h) => h.type === 'envelope-key-mismatch'), `${driver}: ${JSON.stringify(row.hypotheses)}`);
      assert.doesNotMatch(row.note, /absent/);
      if (driver === 'http') {
        const w = row.hypotheses.find((h) => h.type === 'world-mismatch');
        assert.equal(w?.certainty, 'likely', JSON.stringify(row.hypotheses));
        assert.match(w.evidence, /the world has 0 matching items and =3 were expected/);
      }
      const zero = await runVerify(loadFlow(join(d, 'empty0.yaml')), { url: u, driver, pageFactory: fp.factory, fetchImpl });
      assert.equal(zero.rows[0].status, 'OK', `${driver}: an empty list under a present key proves 0 rows`);
    }
  });
});

const anyApiCalls = (requested) => requested.filter((x) => new URL(x).pathname.startsWith('/api/'));

// An unproven absence: the pick is absent but no declared envelope path holding an array proves
// where the list is. Only a possible envelope-key-mismatch, never a guessed key, never a count.
const assertPossiblePickMismatch = (row, label = '') => {
  const all = JSON.stringify(row.hypotheses);
  assert.deepEqual(row.hypotheses.map((h) => [h.type, h.certainty, h.confidence]), [['envelope-key-mismatch', 'possible', 'low']], `${label} ${all}`);
  assert.ok(!row.hypotheses.some((h) => h.type === 'world-mismatch' || h.type === 'no-hypothesis'), `${label} ${all}`);
  const [h] = row.hypotheses;
  assert.match(h.evidence, /data\.pick "items"/, `${label} names the flow pick`);
  assert.match(h.evidence, /no alternate key is inferred/, `${label} says no key is guessed`);
  for (const s of [row.note, h.evidence, h.finding]) assert.doesNotMatch(s, /"data"/, `${label} no alternative key is suggested: ${s}`);
};

test('diagnosis B4: without a declared envelope it does not guess another key: possible envelope-key-mismatch, no no-hypothesis', async () => {
  // /api/plain/recipes answers a bare array: no envelope metadata to compare the pick with.
  await withWrongEnvMock({ 'f.yaml': wrongEnvFlow('/api/plain/recipes', cardsPicking('items')) }, async ({ dir: d, url: u, fetchImpl, requested }) => {
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl });
    const row = r.rows[0];
    assert.equal(row.status, 'KO');
    assert.equal(row.obtained, 0);
    assert.match(row.note, /data\.pick "items" is absent from the response/);
    assertPossiblePickMismatch(row);
    assert.equal(anyApiCalls(requested).length, 1, `an unread key runs no full-set probe: ${anyApiCalls(requested).join(' ')}`);
  });
});

test('diagnosis B4: a paginated bare array with X-Total-Count 0 and an absent pick is not world-mismatch (no probe)', async () => {
  // Reviewer's case: no envelope declared, the pick is absent, the page is [] and X-Total-Count is 0.
  // Counting an unread key over the "full set" would give 0 and claim the world is short.
  const path = '/api/paged/groups/nobody/recipes?page=1&perPage=24';
  await withWrongEnvMock({ 'f.yaml': wrongEnvFlow(path, cardsPicking('items')) }, async ({ dir: d, url: u, fetchImpl, requested }) => {
    const res = await fetch(`${u}${path}`);
    assert.deepEqual(await res.json(), [], 'precondition: an empty bare array');
    assert.equal(res.headers.get('x-total-count'), '0', 'precondition: X-Total-Count 0');
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'http', diagnose: true, fetchImpl });
    const row = r.rows[0];
    assert.equal(row.status, 'KO');
    assert.equal(r.exitCode, 1);
    assertPossiblePickMismatch(row);
    assert.equal(anyApiCalls(requested).length, 1, `one API request, no full-set probe: ${anyApiCalls(requested).join(' ')}`);
  });
});

test('diagnosis B4: a 200 body that is not a JSON object cannot resolve the pick (not "absent"), stays KO, no probe', async () => {
  for (const [label, text, type] of [['html', '<!doctype html><html><body>app shell</body></html>', 'text/html'], ['null', 'null', 'application/json'], ['string', '"ok"', 'application/json']]) {
    await withWrongEnvMock({ 'f.yaml': wrongEnvFlow(HOME, cardsPicking('items')) }, async ({ dir: d, url: u, requested }) => {
      const fetchImpl = (x, init) => {
        requested.push(String(x));
        return new URL(String(x)).pathname.startsWith('/api/') ? Promise.resolve(new Response(text, { status: 200, headers: { 'content-type': type, 'x-total-count': '12' } })) : fetch(x, init);
      };
      for (const driver of ['http', 'playwright']) {
        requested.length = 0;
        const fp = fakePage({ '.recipe-card-footer': 12 });
        const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver, diagnose: true, pageFactory: fp.factory, fetchImpl });
        const row = r.rows[0];
        assert.equal(row.status, 'KO', `${label}/${driver}`);
        assert.match(row.note, /cannot resolve data\.pick "items": the response body is not a JSON object/, `${label}/${driver}: ${row.note}`);
        assert.doesNotMatch(row.note, /absent/, `${label}/${driver}: not falsely "absent"`);
        assertPossiblePickMismatch(row, `${label}/${driver}`);
        assert.match(row.hypotheses[0].evidence, /not a JSON object/, `${label}/${driver}`);
        assert.doesNotMatch(row.hypotheses[0].evidence, /is absent/, `${label}/${driver}`);
        assert.equal(anyApiCalls(requested).length, 1, `${label}/${driver}: no full-set probe: ${anyApiCalls(requested).join(' ')}`);
      }
    });
  }
});

test('diagnosis B4: under playwright a pageerror keeps page-error as the only hypothesis; the note cross-references the absent pick', async () => {
  await withWrongEnvMock({ 'f.yaml': wrongEnvFlow(HOME, cardsPicking('items')) }, async ({ dir: d, url: u, fetchImpl }) => {
    const fp = fakeConsolePage({
      countsByPath: { '/g/home': { '.recipe-card-footer': 0 } },
      onVisit: (_path, { emitPageError }) => emitPageError(new TypeError("Cannot read properties of undefined (reading 'map')")),
    });
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'playwright', diagnose: true, pageFactory: fp.factory, fetchImpl });
    const row = r.rows[0];
    assert.equal(row.status, 'KO');
    assert.deepEqual(row.hypotheses.map((h) => h.type), ['page-error'], JSON.stringify(row.hypotheses));
    assert.match(row.note, /^uncaught page error: TypeError: Cannot read properties of undefined/);
    assert.match(row.note, /; also: data\.pick "items" is absent from the recipes response$/, row.note);
  });
});

test('diagnosis B4: under playwright a navigation blocker keeps navigation as the only hypothesis; the note cross-references the absent pick', async () => {
  await withWrongEnvMock({ 'f.yaml': wrongEnvFlow(HOME, cardsPicking('items')) }, async ({ dir: d, url: u, fetchImpl }) => {
    const fp = fakeRedirectPage({
      redirectTo: '/login',
      countsByPath: { '/login': { '.recipe-card-footer': 0 } },
    });
    const r = await runVerify(loadFlow(join(d, 'f.yaml')), { url: u, driver: 'playwright', diagnose: true, pageFactory: fp.factory, fetchImpl });
    const row = r.rows[0];
    assert.equal(row.status, 'KO');
    assert.deepEqual(row.hypotheses.map((h) => h.type), ['navigation'], JSON.stringify(row.hypotheses));
    assert.match(row.note, /the app redirected \/g\/home → \/login/);
    assert.match(row.note, /; also: data\.pick "items" is absent from the recipes response$/, row.note);
  });
});

test('diagnose(): dedupe by id, null field and client-side filter', () => {
  const row = { expect: { selector: 'x', count: 3 } };
  const dup = diagnose(row, { obtained: 2, response: { status: 200, headers: {} }, items: [{ id: 1 }, { id: 1 }, { id: 2 }], matched: 3, domCount: 2 });
  assert.ok(dup.some((h) => h.type === 'dedupe-by-id'));
  const nul = diagnose(row, { obtained: 2, response: { status: 200, headers: {} }, items: [{ id: 1, email: null }, { id: 2, email: 'a' }, { id: 3, email: 'b' }], matched: 3, domCount: 2 });
  assert.ok(nul.some((h) => h.type === 'null-field' && h.confidence === 'high'));
  const cli = diagnose(row, { obtained: 1, response: { status: 200, headers: {} }, items: [{ id: 1 }, { id: 2 }, { id: 3 }], matched: 3, domCount: 1 });
  assert.ok(cli.some((h) => h.type === 'client-side-filter'));
  assert.ok(cli.some((h) => h.type === 'render'));
});

test('diagnose(): an ignored order points at sorts:, an ignored column at filters:', () => {
  const row = { expect: { selector: 'x', count: 3 } };
  const sort = diagnose(row, {
    obtained: 0,
    response: { status: 200, headers: { 'x-atrezzo-ignored': 'order' } },
    items: [{ id: 1 }, { id: 2 }, { id: 3 }],
    matched: 3,
    domCount: 0
  });
  const ignoredSort = sort.find((h) => h.type === 'ignored-sort');
  assert.ok(ignoredSort, 'an ignored order is its own hypothesis');
  assert.equal(ignoredSort.confidence, 'medium');
  assert.match(ignoredSort.evidence, /sorts: \{ by: order/);
  assert.ok(!sort.some((h) => h.type === 'undeclared-filter'), 'it must not send the user to filters');

  const mixed = diagnose(row, {
    obtained: 0,
    response: { status: 200, headers: { 'x-atrezzo-ignored': 'order, status' } },
    items: [{ id: 1 }],
    matched: 1,
    domCount: 0
  });
  assert.ok(mixed.some((h) => h.type === 'ignored-sort'));
  assert.match(mixed.find((h) => h.type === 'undeclared-filter').evidence, /: status\./);

  const filter = diagnose(row, {
    obtained: 0,
    response: { status: 200, headers: { 'x-atrezzo-ignored': 'status' } },
    items: [{ id: 1 }],
    matched: 1,
    domCount: 0
  });
  assert.ok(filter.some((h) => h.type === 'undeclared-filter'));
  assert.ok(!filter.some((h) => h.type === 'ignored-sort'));
});

function fakePage(counts) {
  const visited = [];
  return {
    visited,
    factory: async () => ({
      page: {
        goto: async (u) => { visited.push(u); },
        waitForLoadState: async () => {},
        waitForSelector: async () => {},
        locator: (sel) => ({ count: async () => counts[sel] ?? 0 }),
      },
      close: async () => {},
    }),
  };
}

test('playwright driver (fake page): OK when the DOM matches', async () => {
  const fp = fakePage({ '[data-testid=customer-chip]': 3, '[data-testid=order-row]': 12, '[data-testid=badge-issue]': 3 });
  const r = await runVerify(loadFlow(join(dir, 'flow.yaml')), { url, driver: 'playwright', pageFactory: fp.factory });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.rows.map((x) => x.status), ['OK', 'OK', 'OK']);
  assert.deepEqual(fp.visited, [`${url}/`, `${url}/lista`]);
});

test('playwright driver (fake page): KO with client-side filter diagnosis', async () => {
  const fp = fakePage({ '[data-testid=customer-chip]': 3, '[data-testid=order-row]': 9, '[data-testid=badge-issue]': 3 });
  const r = await runVerify(loadFlow(join(dir, 'flow.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  const ko = r.rows.find((x) => x.status === 'KO');
  assert.equal(ko.obtained, 9);
  assert.ok(ko.hypotheses.some((h) => h.type === 'client-side-filter'));
  assert.ok(ko.hypotheses.some((h) => h.type === 'render'));
});

test('playwright driver (fake page): a matching DOM count is not OK when the declared data does not prove it (F8)', async () => {
  // Conduit F8: `?author=` ignored by the mock, the page showed 5 articles by other authors and the row was OK.
  const reqPath = '/api/orders?state=issue&limit=3';
  const res = await fetch(`${url}${reqPath}`);
  const items = await res.json();
  assert.match(res.headers.get('x-atrezzo-ignored') ?? '', /state/, 'precondition: the mock ignores ?state=');
  const matched = items.filter((o) => o.status === 'issue').length;
  assert.notEqual(matched, 3, 'precondition: the JSON does not hold 3 issue orders');
  writeFileSync(join(dir, 'flujo-f8.yaml'), FLOW.replace('      issues: GET /api/orders?status=issue\n',
    `      issues: GET /api/orders?status=issue\n      byState: GET ${reqPath}\n    expect:\n      - selector: "[data-testid=issue-row]"\n        count: 3\n        data: { request: byState, where: { status: issue } }\n`));
  const fp = fakePage({ '[data-testid=customer-chip]': 3, '[data-testid=order-row]': 12, '[data-testid=badge-issue]': 3, '[data-testid=issue-row]': 3 });
  const r = await runVerify(loadFlow(join(dir, 'flujo-f8.yaml')), { url, driver: 'playwright', pageFactory: fp.factory });
  const row = r.rows.find((x) => x.expect.selector === '[data-testid=issue-row]');
  assert.equal(row.obtained, 3, 'the DOM count matches');
  assert.equal(row.status, 'KO', 'the JSON has no 3 issue orders: the row cannot be OK');
  assert.match(row.note, new RegExp(`byState.*${matched}`));
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.rows.filter((x) => x !== row).map((x) => x.status), ['OK', 'OK', 'OK'], 'valid rows stay OK');
});

test('playwright driver (fake page): the data check reads the mock after the step clicks (F8)', async () => {
  writeFileSync(join(dir, 'scenarios/borrado.yaml'), `name: borrado
seed: 1
world:
  orders: { total: 3, distribution: { paid: 3 } }
endpoints:
  - path: /api/orders
    entity: orders
writes:
  "DELETE /api/orders/:id":
    expect: { status: 204 }
`);
  writeFileSync(join(dir, 'flujo-borrado.yaml'), `scenario: scenarios/borrado.yaml
steps:
  - screen: lista
    visit: /lista
    click: ["#delete-first"]
    requests:
      orders: GET /api/orders
    expect:
      - selector: "[data-testid=order-row]"
        count: 2
        data: { request: orders }
`);
  const flow = loadFlow(join(dir, 'flujo-borrado.yaml'));
  const visited = [];
  const page = {
    goto: async (u) => { visited.push(u); },
    waitForLoadState: async () => {},
    waitForSelector: async () => {},
    locator: (sel) => ({
      count: async () => (sel === '[data-testid=order-row]' ? 2 : 0),
      click: async () => {
        // The app deletes the first order: the mock's world changes as the click lands.
        const [first] = await (await fetch(`${url}/api/orders`)).json();
        const del = await fetch(`${url}/api/orders/${first.id}`, { method: 'DELETE' });
        assert.equal(del.status, 204);
      },
    }),
  };
  const r = await runVerify(flow, { url, driver: 'playwright', pageFactory: async () => ({ page, close: async () => {} }) });
  assert.equal(r.rows[0].status, 'OK', r.rows[0].note);
  assert.equal(r.exitCode, 0);
});

test('CLI verify --driver playwright without playwright installed ⇒ exit 2, never a false OK', async () => {
  const r = await cliAsync(['verify', 'flow.yaml', '--driver', 'playwright', '--url', url], dir);
  assert.equal(r.code, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /playwright.*not installed/);
  assert.doesNotMatch(r.stdout, /GREEN/);
});

test('CLI verify with no mock listening ⇒ exit 2', async () => {
  const r = await cliAsync(['verify', 'flow.yaml', '--url', 'http://127.0.0.1:9'], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /No mock listening/);
});

test('CLI verify --driver http green ⇒ exit 0', async () => {
  const r = await cliAsync(['verify', 'flujo-verde.yaml', '--url', url], dir);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /GREEN/);
});

// ---------- redirects_to / allow_redirect ----------

function fakeRedirectPage({ redirectTo = null, countsByPath = {} } = {}) {
  let current = '';
  return {
    factory: async () => ({
      page: {
        goto: async (u) => {
          current = redirectTo ? new URL(redirectTo, u).toString() : u;
          return { status: () => 200 };
        },
        url: () => current,
        waitForLoadState: async () => {},
        waitForSelector: async () => {},
        locator: (sel) => {
          const path = new URL(current).pathname;
          return { count: async () => countsByPath[path]?.[sel] ?? 0 };
        },
      },
      close: async () => {},
    }),
  };
}

test('loadFlow: validates redirects_to and allow_redirect', () => {
  const okDir = tmpProject({
    'a.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    redirects_to: /login\n    expect: [{ selector: "#login", count: 1 }]\n',
    'b.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    allow_redirect: true\n    expect: [{ selector: "#login", count: 1 }]\n',
  });
  assert.equal(loadFlow(join(okDir, 'a.yaml')).steps[0].redirectsTo, '/login');
  assert.equal(loadFlow(join(okDir, 'b.yaml')).steps[0].allowRedirect, true);

  for (const [yaml, pattern] of [
    ['steps:\n  - screen: a\n    visit: /orders\n    redirects_to: login\n    expect: [{ selector: x, count: 1 }]\n', /redirects_to.*starting with "\/"/],
    ['steps:\n  - screen: a\n    visit: /orders\n    allow_redirect: "yes"\n    expect: [{ selector: x, count: 1 }]\n', /allow_redirect.*true or false/],
    ['steps:\n  - screen: a\n    visit: /orders\n    redirects_to: /login\n    allow_redirect: true\n    expect: [{ selector: x, count: 1 }]\n', /use "redirects_to" or "allow_redirect", not both/],
  ]) {
    const badDir = tmpProject({ 'f.yaml': yaml });
    assert.throws(() => loadFlow(join(badDir, 'f.yaml')), (e) => e instanceof AtrezzoError && e.exitCode === 3 && e.issues.some((l) => pattern.test(l)));
  }
});

test('declared redirect (redirects_to): OK when final URL matches and assertions pass on destination', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: orders
    visit: /orders
    redirects_to: /login
    expect:
      - selector: "#login-form"
        count: 1
      - selector: "[data-testid=order-row]"
        count: 0
`,
  });
  const fp = fakeRedirectPage({
    redirectTo: '/login?next=%2Forders',
    countsByPath: { '/login': { '#login-form': 1, '[data-testid=order-row]': 0 } },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', pageFactory: fp.factory });
  assert.equal(r.exitCode, 0, formatReport(r));
  assert.deepEqual(r.rows.map((x) => x.status), ['OK', 'OK']);
  assert.deepEqual(r.steps, [{ screen: 'orders', visit: '/orders', redirect: { from: '/orders', to: '/login?next=%2Forders', declared: true }, console: [] }]);

  // Explicit query string in redirects_to must match
  const qDir = tmpProject({
    'q.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    redirects_to: /login?reason=expired\n    expect: [{ selector: "#login-form", count: 1 }]\n',
  });
  const fpMatch = fakeRedirectPage({ redirectTo: '/login?reason=expired', countsByPath: { '/login': { '#login-form': 1 } } });
  const okQ = await runVerify(loadFlow(join(qDir, 'q.yaml')), { url, driver: 'playwright', pageFactory: fpMatch.factory });
  assert.equal(okQ.exitCode, 0);
  const fpMismatch = fakeRedirectPage({ redirectTo: '/login?reason=other', countsByPath: { '/login': { '#login-form': 1 } } });
  const koQ = await runVerify(loadFlow(join(qDir, 'q.yaml')), { url, driver: 'playwright', pageFactory: fpMismatch.factory });
  assert.equal(koQ.exitCode, 1);
  assert.equal(koQ.steps[0].redirect.declared, false);
});

test('declared redirect (allow_redirect: true): OK when redirected or when staying on visit', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    allow_redirect: true\n    expect: [{ selector: "#target", count: 1 }]\n',
  });
  const fpRedir = fakeRedirectPage({ redirectTo: '/login', countsByPath: { '/login': { '#target': 1 } } });
  const r1 = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', pageFactory: fpRedir.factory });
  assert.equal(r1.exitCode, 0);
  assert.deepEqual(r1.steps[0].redirect, { from: '/orders', to: '/login', declared: true });

  const fpSame = fakeRedirectPage({ redirectTo: null, countsByPath: { '/orders': { '#target': 1 } } });
  const r2 = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', pageFactory: fpSame.factory });
  assert.equal(r2.exitCode, 0);
  assert.equal(r2.steps[0].redirect, undefined);

  const fpQuery = fakeRedirectPage({ redirectTo: '/orders?next=%2Flogin', countsByPath: { '/orders': { '#target': 1 } } });
  const r3 = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', pageFactory: fpQuery.factory });
  assert.equal(r3.exitCode, 0);
  assert.deepEqual(r3.steps[0].redirect, { from: '/orders', to: '/orders?next=%2Flogin', declared: true });
});

test('undeclared redirect: stays KO with current warning', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    expect: [{ selector: "#login-form", count: 1 }]\n',
  });
  const fp = fakeRedirectPage({
    redirectTo: '/login?next=%2Forders',
    countsByPath: { '/login': { '#login-form': 1 } },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.equal(r.rows[0].status, 'KO');
  assert.match(r.rows[0].note, /the app redirected \/orders → \/login\?next=%2Forders.*login screen/);
  assert.equal(r.rows[0].hypotheses[0].type, 'navigation');
  assert.deepEqual(r.steps[0].redirect, { from: '/orders', to: '/login?next=%2Forders', declared: false });
});

test('declared redirect to wrong destination or without redirecting: KO', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    redirects_to: /login\n    expect: [{ selector: "#login-form", count: 1 }]\n',
  });
  const fpWrong = fakeRedirectPage({ redirectTo: '/dashboard', countsByPath: { '/dashboard': { '#login-form': 1 } } });
  const rWrong = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fpWrong.factory });
  assert.equal(rWrong.exitCode, 1);
  assert.equal(rWrong.rows[0].status, 'KO');
  assert.match(rWrong.rows[0].note, /redirected \/orders → \/dashboard \(expected \/login\)/);
  assert.equal(rWrong.rows[0].hypotheses[0].type, 'navigation');
  assert.deepEqual(rWrong.steps[0].redirect, { from: '/orders', to: '/dashboard', declared: false });

  const fpNone = fakeRedirectPage({ redirectTo: null, countsByPath: { '/orders': { '#login-form': 1 } } });
  const rNone = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fpNone.factory });
  assert.equal(rNone.exitCode, 1);
  assert.equal(rNone.rows[0].status, 'KO');
  assert.match(rNone.rows[0].note, /expected \/orders to redirect to \/login, but stayed on \/orders/);
  assert.equal(rNone.rows[0].hypotheses[0].type, 'navigation');
  assert.equal(rNone.steps[0].redirect, undefined);
});

test('declared redirect (redirects_to) on same pathname: KO when staying on visit, OK with redirect metadata on query/fragment change', async () => {
  const samePathDir = tmpProject({
    'same.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    redirects_to: /orders\n    expect: [{ selector: "#login-form", count: 1 }]\n',
    'query.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    redirects_to: /orders?step=1\n    expect: [{ selector: "#login-form", count: 1 }]\n',
  });

  // visit: /orders, redirects_to: /orders, no redirect ⇒ KO (never a false OK)
  const fpStayed = fakeRedirectPage({ redirectTo: null, countsByPath: { '/orders': { '#login-form': 1 } } });
  const rStayed = await runVerify(loadFlow(join(samePathDir, 'same.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fpStayed.factory });
  assert.equal(rStayed.exitCode, 1);
  assert.equal(rStayed.rows[0].status, 'KO');
  assert.match(rStayed.rows[0].note, /expected \/orders to redirect to \/orders, but stayed on \/orders/);
  assert.equal(rStayed.rows[0].hypotheses[0].type, 'navigation');
  assert.equal(rStayed.steps[0].redirect, undefined);

  // visit: /orders, redirects_to: /orders, redirected only by query ⇒ OK with redirect metadata
  const fpQuery = fakeRedirectPage({ redirectTo: '/orders?next=%2Flogin', countsByPath: { '/orders': { '#login-form': 1 } } });
  const rQuery = await runVerify(loadFlow(join(samePathDir, 'same.yaml')), { url, driver: 'playwright', pageFactory: fpQuery.factory });
  assert.equal(rQuery.exitCode, 0, formatReport(rQuery));
  assert.equal(rQuery.rows[0].status, 'OK');
  assert.deepEqual(rQuery.steps[0].redirect, { from: '/orders', to: '/orders?next=%2Flogin', declared: true });

  // visit: /orders, redirects_to: /orders, redirected only by fragment ⇒ OK with redirect metadata
  const fpHash = fakeRedirectPage({ redirectTo: '/orders#auth', countsByPath: { '/orders': { '#login-form': 1 } } });
  const rHash = await runVerify(loadFlow(join(samePathDir, 'same.yaml')), { url, driver: 'playwright', pageFactory: fpHash.factory });
  assert.equal(rHash.exitCode, 0, formatReport(rHash));
  assert.equal(rHash.rows[0].status, 'OK');
  assert.deepEqual(rHash.steps[0].redirect, { from: '/orders', to: '/orders#auth', declared: true });

  // visit: /orders, redirects_to: /orders?step=1, redirected to /orders?step=2 ⇒ KO with redirect metadata
  const fpWrongQuery = fakeRedirectPage({ redirectTo: '/orders?step=2', countsByPath: { '/orders': { '#login-form': 1 } } });
  const rWrongQuery = await runVerify(loadFlow(join(samePathDir, 'query.yaml')), { url, driver: 'playwright', pageFactory: fpWrongQuery.factory });
  assert.equal(rWrongQuery.exitCode, 1);
  assert.equal(rWrongQuery.rows[0].status, 'KO');
  assert.match(rWrongQuery.rows[0].note, /redirected \/orders → \/orders\?step=2 \(expected \/orders\?step=1\)/);
  assert.deepEqual(rWrongQuery.steps[0].redirect, { from: '/orders', to: '/orders?step=2', declared: false });
});

const realPw = await loadPlaywright(ROOT);
const realChrome = realPw && (chromeExecutable(realPw.name) ?? (realPw.name !== 'playwright-core' ? 'bundled' : null));
const skipReal = !realPw ? 'playwright(-core) not installed in the repo' : !realChrome || (realChrome !== 'bundled' && !existsSync(realChrome)) ? 'no Chromium (set ATREZZO_CHROME)' : false;

test('CLI verify --driver playwright --json: declared redirect outputs redirect metadata and exit 0', { skip: skipReal, timeout: 60_000 }, async () => {
  const app = createServer((req, res) => {
    if (req.url === '/orders') {
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/login' ? '<form id="login-form"><button>Sign in</button></form>' : '<div id="orders"></div>');
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const appUrl = `http://127.0.0.1:${app.address().port}`;
  try {
    const flowDir = tmpProject({
      'f.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    redirects_to: /login\n    wait_for: "#login-form"\n    expect:\n      - selector: "#login-form"\n        count: 1\n',
    });
    const res = await cliAsync(['verify', join(flowDir, 'f.yaml'), '--url', appUrl, '--driver', 'playwright', '--json'], ROOT);
    assert.equal(res.code, 0, res.stderr + res.stdout);
    const json = JSON.parse(res.stdout);
    assert.equal(json.exitCode, 0);
    assert.equal(json.rows[0].status, 'OK');
    assert.deepEqual(json.steps, [{ screen: 'orders', visit: '/orders', redirect: { from: '/orders', to: '/login', declared: true }, console: [] }]);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

// ---------- browser console & pageerror capture ----------

function fakeConsolePage({ countsByPath = {}, onVisit, onWaitFor, onCount, status = 200, redirectTo = null } = {}) {
  const emitter = new EventEmitter();
  let current = '';
  const emitConsole = (type, text) => emitter.emit('console', { type: () => type, text: () => text });
  const emitPageError = (err) => emitter.emit('pageerror', err);
  return {
    factory: async () => ({
      page: {
        on: (ev, fn) => emitter.on(ev, fn),
        off: (ev, fn) => emitter.off(ev, fn),
        goto: async (u) => {
          current = redirectTo ? new URL(redirectTo, u).toString() : u;
          const path = new URL(current).pathname;
          await onVisit?.(path, { emitConsole, emitPageError });
          return { status: () => status };
        },
        url: () => current,
        waitForLoadState: async () => {},
        waitForSelector: async (sel) => {
          if (onWaitFor) await onWaitFor(sel);
        },
        locator: (sel) => ({
          count: async () => {
            const path = new URL(current).pathname;
            await onCount?.(path, sel, { emitConsole, emitPageError });
            return countsByPath[path]?.[sel] ?? 0;
          },
        }),
      },
      close: async () => {},
    }),
  };
}

test('playwright driver: uncaught pageerror marks step KO with page-error hypothesis and cannot be masked by matching assertions', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: orders
    visit: /orders
    expect:
      - selector: "[data-testid=toast-error]"
        count: 1
      - selector: "[data-testid=order-row]"
        count: 0
`,
  });
  const longMsg = `Invalid array length ${'X'.repeat(400)}`;
  const fp = fakeConsolePage({
    countsByPath: { '/orders': { '[data-testid=toast-error]': 1, '[data-testid=order-row]': 0 } },
    onVisit: (_path, { emitPageError }) => {
      emitPageError(new RangeError(longMsg));
    },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.rows.map((x) => x.status), ['KO', 'KO']);
  assert.match(r.rows[0].note, /uncaught page error: RangeError: Invalid array length/);
  assert.equal(r.rows[1].note, 'same cause as #1');
  assert.equal(r.rows[0].hypotheses.length, 1);
  assert.equal(r.rows[0].hypotheses[0].type, 'page-error');
  assert.equal(r.rows[0].hypotheses[0].confidence, 'high');
  assert.ok(r.rows[0].hypotheses[0].evidence.includes('RangeError: Invalid array length'));
  assert.ok(!r.rows[0].hypotheses[0].evidence.includes('X'.repeat(301)), 'message must be clipped to 300 chars');
  assert.deepEqual(r.steps[0].console, [{ level: 'pageerror', text: `RangeError: ${longMsg}` }]);
});

test('playwright driver: pageerror during wait_for timeout surfaces page-error instead of navigation', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    wait_for: "#ready"\n    expect: [{ selector: "#ready", count: 1 }]\n',
  });
  const fp = fakeConsolePage({
    onVisit: (_path, { emitPageError }) => emitPageError(new RangeError('Invalid array length')),
    onWaitFor: () => { throw new Error('Timeout'); },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.equal(r.rows[0].status, 'KO');
  assert.equal(r.rows[0].hypotheses[0].type, 'page-error');
  assert.match(r.rows[0].hypotheses[0].evidence, /RangeError: Invalid array length/);
});

// B1 (Mealie field report, M10): a wait_for timeout after openStep's route/status checks passed does not prove a navigation failure.
test('playwright driver: wait_for timeout on the visited URL (HTTP 200, no pageerror) stays KO but is never confirmed navigation', async () => {
  const flowDir = tmpProject({
    'stay.yaml': 'steps:\n  - screen: recipe\n    visit: /recipe\n    wait_for: "#ready"\n    expect: [{ selector: "#ready", count: 1 }, { selector: ".ingredient", count: 3 }]\n',
    'declared.yaml': 'steps:\n  - screen: recipe\n    visit: /recipe\n    redirects_to: /login\n    wait_for: "#ready"\n    expect: [{ selector: "#ready", count: 1 }]\n',
  });
  const timeout = () => { throw new Error('Timeout 10000ms exceeded'); };
  const cases = [
    // Vue's errorHandler catches the TypeError and only logs it: console.error, not pageerror
    ['Vue-caught TypeError in console.error', 'stay.yaml', fakeConsolePage({
      onVisit: (_p, { emitConsole }) => emitConsole('error', "TypeError: Cannot read properties of undefined (reading 'map')"),
      onWaitFor: timeout,
    })],
    // the app never renders #ready and logs nothing: no console.error, no pageerror
    ['silent render failure (no console diagnostics)', 'stay.yaml', fakeConsolePage({ onWaitFor: timeout })],
    // landed exactly where the flow declared: the redirect is not the cause either
    ['declared redirect matched', 'declared.yaml', fakeConsolePage({ redirectTo: '/login', onWaitFor: timeout })],
  ];
  for (const [label, file, fp] of cases) {
    const r = await runVerify(loadFlow(join(flowDir, file)), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
    assert.equal(r.exitCode, 1, label);
    assert.ok(r.rows.every((x) => x.status === 'KO'), `${label}: every row of the step is KO`);
    assert.match(r.rows[0].note, /wait_for "#ready" did not appear within 10 s/, label);
    const hyps = r.rows[0].hypotheses ?? [];
    assert.ok(!hyps.some((h) => h.certainty === 'confirmed'), `${label}: no confirmed hypothesis, got ${JSON.stringify(hyps)}`);
    assert.ok(!hyps.some((h) => /scenario and selectors are not the cause/.test(h.evidence)), `${label}: must not exonerate the scenario/selectors`);
    assert.deepEqual(hyps.map((h) => [h.type, h.certainty]), [['navigation', 'possible']], label);
    const [nav] = hyps;
    // finding: only what was observed — the selector timed out and no uncaught pageerror was captured
    assert.match(nav.finding ?? '', /wait_for "#ready" timed out after 10 s/, `${label}: finding`);
    assert.match(nav.finding, /no uncaught pageerror/, `${label}: finding`);
    // evidence: openStep compares paths and the document status; it must not claim HTTP 200 or "no redirect"
    assert.match(nav.evidence, /navigation checks did not detect/, `${label}: evidence`);
    assert.match(nav.evidence, /navigation is unproven/, `${label}: evidence`);
    assert.doesNotMatch(nav.evidence, /\bloaded\b|HTTP 200|without an HTTP error|no redirect|undeclared redirect/, `${label}: evidence claims more than was observed`);
  }
});

test('playwright driver: wait_for timeout + console.error with --strict-console keeps navigation/possible and adds console-error/confirmed', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: recipe\n    visit: /recipe\n    wait_for: "#ready"\n    expect: [{ selector: "#ready", count: 1 }, { selector: ".ingredient", count: 3 }]\n',
  });
  const fp = fakeConsolePage({
    onVisit: (_p, { emitConsole }) => emitConsole('error', "TypeError: Cannot read properties of undefined (reading 'map')"),
    onWaitFor: () => { throw new Error('Timeout 10000ms exceeded'); },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, strictConsole: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.ok(r.rows.every((x) => x.status === 'KO'));
  assert.match(r.rows[0].note, /wait_for "#ready" did not appear within 10 s/);
  const hyps = r.rows[0].hypotheses ?? [];
  assert.deepEqual(hyps.map((h) => [h.type, h.certainty]), [['navigation', 'possible'], ['console-error', 'confirmed']]);
  assert.match(hyps[1].evidence, /console\.error on "recipe" with --strict-console: TypeError: Cannot read properties of undefined \(reading 'map'\)/);
});

test('playwright driver: wait_for set but an undeclared redirect or HTTP >= 400 document still confirms navigation', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: recipe\n    visit: /recipe\n    wait_for: "#ready"\n    expect: [{ selector: "#ready", count: 1 }]\n',
  });
  const timeout = () => { throw new Error('Timeout 10000ms exceeded'); };
  const vueError = (_p, { emitConsole }) => emitConsole('error', 'TypeError: x is undefined');
  const cases = [
    ['undeclared redirect', fakeConsolePage({ redirectTo: '/login', onVisit: vueError, onWaitFor: timeout }), /the app redirected \/recipe → \/login/],
    ['document HTTP 404', fakeConsolePage({ status: 404, onVisit: vueError, onWaitFor: timeout }), /\/recipe answered HTTP 404/],
  ];
  for (const [label, fp, note] of cases) {
    const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
    assert.equal(r.exitCode, 1, label);
    assert.equal(r.rows[0].status, 'KO', label);
    assert.match(r.rows[0].note, note, label);
    assert.deepEqual(r.rows[0].hypotheses.map((h) => [h.type, h.certainty]), [['navigation', 'confirmed']], label);
  }
});

test('playwright driver: late pageerror during locator traversal still marks step KO', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: orders
    visit: /orders
    expect:
      - selector: "#first"
        count: 1
      - selector: "#second"
        count: 1
`,
  });
  const fp = fakeConsolePage({
    countsByPath: { '/orders': { '#first': 1, '#second': 1 } },
    onCount: (_path, sel, { emitPageError }) => {
      if (sel === '#second') emitPageError(new Error('late crash'));
    },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.rows.map((x) => x.status), ['KO', 'KO']);
  assert.equal(r.rows[0].hypotheses[0].type, 'page-error');
  assert.match(r.rows[0].hypotheses[0].evidence, /Error: late crash/);
});

test('playwright driver: console.error emits WARNING without breaking passing step unless --strict-console', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: orders\n    visit: /orders\n    expect: [{ selector: "#ok", count: 2 }]\n',
  });
  const fp = fakeConsolePage({
    countsByPath: { '/orders': { '#ok': 2 } },
    onVisit: (_path, { emitConsole }) => {
      emitConsole('log', 'ignored debug log');
      emitConsole('error', 'Failed to load optional badge');
    },
  });

  const okRes = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', pageFactory: fp.factory });
  assert.equal(okRes.exitCode, 0);
  assert.equal(okRes.rows[0].status, 'OK');
  assert.equal(okRes.warnings.length, 1);
  assert.match(okRes.warnings[0], /console\.error: Failed to load optional badge/);
  assert.match(formatReport(okRes), /WARNING: .*Failed to load optional badge/);
  assert.deepEqual(okRes.steps[0].console, [{ level: 'error', text: 'Failed to load optional badge' }]);

  const strictRes = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, strictConsole: true, pageFactory: fp.factory });
  assert.equal(strictRes.exitCode, 1);
  assert.equal(strictRes.rows[0].status, 'KO');
  assert.equal(strictRes.warnings.length, 0);
  assert.match(strictRes.rows[0].note, /--strict-console.*Failed to load optional badge/);
  assert.equal(strictRes.rows[0].hypotheses[0].type, 'console-error');
  assert.deepEqual(strictRes.steps[0].console, [{ level: 'error', text: 'Failed to load optional badge' }]);
});

test('playwright driver: console listeners are isolated per step', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: first
    visit: /first
    expect: [{ selector: "#a", count: 1 }]
  - screen: second
    visit: /second
    expect: [{ selector: "#b", count: 1 }]
`,
  });
  const fp = fakeConsolePage({
    countsByPath: { '/first': { '#a': 1 }, '/second': { '#b': 1 } },
    onVisit: (path, { emitConsole }) => {
      if (path === '/first') emitConsole('error', 'only on first');
    },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', pageFactory: fp.factory });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.steps[0].console, [{ level: 'error', text: 'only on first' }]);
  assert.deepEqual(r.steps[1].console, []);
});

test('CLI verify --driver playwright (real Chromium): page throwing uncaught exception is KO with page-error hypothesis and console JSON', { skip: skipReal, timeout: 60_000 }, async () => {
  const app = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <div id="toast">Something went wrong</div>
      <div id="rows"></div>
      <script>
        new Array(-1); // throws RangeError: Invalid array length
      </script>
    </body></html>`);
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const appUrl = `http://127.0.0.1:${app.address().port}`;
  try {
    const flowDir = tmpProject({
      'f.yaml': `steps:
  - screen: blank-crash
    visit: /
    expect:
      - selector: "#toast"
        count: 1
      - selector: "#rows .row"
        count: 0
`,
    });
    const res = await cliAsync(['verify', join(flowDir, 'f.yaml'), '--url', appUrl, '--driver', 'playwright', '--diagnose', '--json'], ROOT);
    assert.equal(res.code, 1, res.stderr + res.stdout);
    const json = JSON.parse(res.stdout);
    assert.equal(json.exitCode, 1);
    assert.deepEqual(json.rows.map((r) => r.status), ['KO', 'KO']);
    assert.equal(json.rows[0].hypotheses[0].type, 'page-error');
    assert.match(json.rows[0].hypotheses[0].evidence, /RangeError: Invalid array length/);
    assert.ok(json.steps[0].console.some((c) => c.level === 'pageerror' && /RangeError: Invalid array length/.test(c.text)));
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('CLI verify --driver playwright (real Chromium): console.error only warns unless --strict-console is passed', { skip: skipReal, timeout: 60_000 }, async () => {
  const app = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <div id="app"><span class="item">one</span><span class="item">two</span></div>
      <script>
        console.error('non-fatal console error');
      </script>
    </body></html>`);
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const appUrl = `http://127.0.0.1:${app.address().port}`;
  try {
    const flowDir = tmpProject({
      'f.yaml': 'steps:\n  - screen: app\n    visit: /\n    expect:\n      - selector: "#app .item"\n        count: 2\n',
    });

    const warnRes = await cliAsync(['verify', join(flowDir, 'f.yaml'), '--url', appUrl, '--driver', 'playwright'], ROOT);
    assert.equal(warnRes.code, 0, warnRes.stderr + warnRes.stdout);
    assert.match(warnRes.stdout, /WARNING: .*non-fatal console error/);
    assert.match(warnRes.stdout, /GREEN/);

    const jsonRes = await cliAsync(['verify', join(flowDir, 'f.yaml'), '--url', appUrl, '--driver', 'playwright', '--json'], ROOT);
    assert.equal(jsonRes.code, 0, jsonRes.stderr + jsonRes.stdout);
    const json = JSON.parse(jsonRes.stdout);
    assert.deepEqual(json.steps[0].console, [{ level: 'error', text: 'non-fatal console error' }]);

    const strictRes = await cliAsync(['verify', join(flowDir, 'f.yaml'), '--url', appUrl, '--driver', 'playwright', '--strict-console', '--diagnose'], ROOT);
    assert.equal(strictRes.code, 1, strictRes.stderr + strictRes.stdout);
    assert.match(strictRes.stdout, /RED/);
    assert.match(strictRes.stdout, /console-error/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('playwright driver: selector failure combined with pageerror marks step KO and formats report cleanly', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: orders
    visit: /orders
    expect:
      - selector: "#broken"
        count: 1
      - selector: "#ok"
        count: 1
`,
  });
  const fp = fakeConsolePage({
    countsByPath: { '/orders': { '#ok': 1 } },
    onVisit: (_path, { emitPageError }) => emitPageError(new Error('boom during render')),
    onCount: (_path, sel) => {
      if (sel === '#broken') throw new Error('Target page, context or browser has been closed');
    },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.rows.map((x) => x.status), ['KO', 'KO']);
  assert.deepEqual(r.rows.map((x) => x.obtained), [0, 1]);
  assert.match(r.rows[0].note, /uncaught page error: Error: boom during render/);
  assert.equal(r.rows[1].note, 'same cause as #1');
  assert.equal(r.rows[0].hypotheses[0].type, 'page-error');
  const report = formatReport(r);
  assert.match(report, /#broken/);
  assert.match(report, /RED/);
});

test('playwright driver: step without expect surfaces synthetic (page) KO on pageerror and --strict-console', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: blank
    visit: /blank
`,
  });
  const fpPageErr = fakeConsolePage({
    onVisit: (_path, { emitPageError }) => emitPageError(new RangeError('Invalid array length')),
  });
  const r1 = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fpPageErr.factory });
  assert.equal(r1.exitCode, 1);
  assert.equal(r1.rows.length, 1);
  assert.deepEqual(r1.rows[0].expect, { selector: '(page)', count: 0 });
  assert.equal(r1.rows[0].status, 'KO');
  assert.equal(r1.rows[0].obtained, null);
  assert.equal(r1.rows[0].hypotheses[0].type, 'page-error');
  const rep1 = formatReport(r1);
  assert.match(rep1, /\(page\)\s+=0\s+-\s+KO/);
  assert.match(rep1, /RED/);

  const fpConsoleErr = fakeConsolePage({
    onVisit: (_path, { emitConsole }) => emitConsole('error', 'Unhandled API failure'),
  });
  const r2 = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, strictConsole: true, pageFactory: fpConsoleErr.factory });
  assert.equal(r2.exitCode, 1);
  assert.equal(r2.rows.length, 1);
  assert.deepEqual(r2.rows[0].expect, { selector: '(page)', count: 0 });
  assert.equal(r2.rows[0].status, 'KO');
  assert.equal(r2.rows[0].hypotheses[0].type, 'console-error');
  const rep2 = formatReport(r2);
  assert.match(rep2, /\(page\)\s+=0\s+-\s+KO/);
  assert.match(rep2, /RED/);
});

test('--strict-console with http driver is rejected (exit 3), never GREEN', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: orders\n    requests: { orders: "GET /api/orders" }\n    expect: [{ selector: ".row", count: 1, data: { request: orders } }]\n',
  });
  await assert.rejects(
    () => runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'http', strictConsole: true }),
    (e) => e instanceof AtrezzoError && e.exitCode === 3 && /--strict-console requires --driver playwright/.test(e.message),
  );

  const cliExplicit = await cliAsync(['verify', join(flowDir, 'f.yaml'), '--url', url, '--driver', 'http', '--strict-console'], dir);
  assert.equal(cliExplicit.code, 3, cliExplicit.stderr + cliExplicit.stdout);
  assert.match(cliExplicit.stderr, /--strict-console requires --driver playwright/);
  assert.doesNotMatch(cliExplicit.stdout, /GREEN/);

  const cliDefault = await cliAsync(['verify', join(flowDir, 'f.yaml'), '--url', url, '--strict-console'], dir);
  assert.equal(cliDefault.code, 3, cliDefault.stderr + cliDefault.stdout);
  assert.match(cliDefault.stderr, /--strict-console requires --driver playwright/);
  assert.doesNotMatch(cliDefault.stdout, /GREEN/);
});

// ---------- pre-assertion click interactions ----------

test('loadFlow: validates click and click_timeout', () => {
  const okDir = tmpProject({
    'single.yaml': 'steps:\n  - screen: a\n    visit: /a\n    click: "text=Open details"\n    expect: [{ selector: ".panel", count: 1 }]\n',
    'multi.yaml': 'click_timeout: 3000\nsteps:\n  - screen: a\n    visit: /a\n    click: ["#tab-2", "text=Expand"]\n    click_timeout: 1500\n    expect: [{ selector: ".panel", count: 1 }]\n',
  });
  const f1 = loadFlow(join(okDir, 'single.yaml'));
  assert.deepEqual(f1.steps[0].click, ['text=Open details']);
  assert.equal(f1.steps[0].clickTimeout, null);
  assert.equal(f1.clickTimeout, null);

  const f2 = loadFlow(join(okDir, 'multi.yaml'));
  assert.equal(f2.clickTimeout, 3000);
  assert.deepEqual(f2.steps[0].click, ['#tab-2', 'text=Expand']);
  assert.equal(f2.steps[0].clickTimeout, 1500);

  for (const [yaml, pattern] of [
    ['steps:\n  - screen: a\n    visit: /a\n    click: ""\n    expect: [{ selector: x, count: 1 }]\n', /steps\[0\]\.click": must be a non-empty selector/],
    ['steps:\n  - screen: a\n    visit: /a\n    click: []\n    expect: [{ selector: x, count: 1 }]\n', /steps\[0\]\.click": must be a non-empty selector/],
    ['steps:\n  - screen: a\n    visit: /a\n    click: ["#ok", ""]\n    expect: [{ selector: x, count: 1 }]\n', /steps\[0\]\.click\[1\]": must be a non-empty selector/],
    ['steps:\n  - screen: a\n    visit: /a\n    click: 123\n    expect: [{ selector: x, count: 1 }]\n', /steps\[0\]\.click": must be a selector string or a list of selectors/],
    ['steps:\n  - screen: a\n    visit: /a\n    click: "#ok"\n    click_timeout: 0\n    expect: [{ selector: x, count: 1 }]\n', /steps\[0\]\.click_timeout": must be a positive integer/],
    ['click_timeout: -5\nsteps:\n  - screen: a\n    visit: /a\n    expect: [{ selector: x, count: 1 }]\n', /field "click_timeout": must be a positive integer/],
  ]) {
    const badDir = tmpProject({ 'f.yaml': yaml });
    assert.throws(() => loadFlow(join(badDir, 'f.yaml')), (e) => e instanceof AtrezzoError && e.exitCode === 3 && e.issues.some((l) => pattern.test(l)));
  }
});

function fakeClickPage({ initialCounts = {}, onClick, missingSelectors = [] } = {}) {
  const events = [];
  const counts = { ...initialCounts };
  const missing = new Set(missingSelectors);
  let current = '';
  return {
    events,
    factory: async () => ({
      page: {
        goto: async (u) => { current = u; return { status: () => 200 }; },
        url: () => current,
        waitForLoadState: async () => {},
        waitForSelector: async () => {},
        locator: (sel) => {
          const target = {
            waitFor: async (opts) => {
              events.push({ type: 'waitFor', sel, timeout: opts?.timeout });
              if (missing.has(sel)) {
                const err = new Error(`locator.waitFor: Timeout ${opts?.timeout ?? 5000}ms exceeded.`);
                err.name = 'TimeoutError';
                throw err;
              }
            },
            click: async (opts) => {
              events.push({ type: 'click', sel, timeout: opts?.timeout });
              await onClick?.(sel, counts);
            },
            count: async () => {
              events.push({ type: 'count', sel });
              return counts[sel] ?? 0;
            },
          };
          return { ...target, first: () => target };
        },
      },
      close: async () => {},
    }),
  };
}

test('playwright driver (fake page): click list executes in order before assertions, respects timeout, and keeps a single step', async () => {
  const flowDir = tmpProject({
    'f.yaml': `click_timeout: 2500
steps:
  - screen: details
    visit: /details
    click:
      - "text=Section A"
      - "[data-testid=open-sub]"
    expect:
      - selector: "[data-testid=sub-body]"
        count: 1
`,
  });
  const fp = fakeClickPage({
    initialCounts: { '[data-testid=sub-body]': 0 },
    onClick: (sel, counts) => {
      if (sel === '[data-testid=open-sub]') counts['[data-testid=sub-body]'] = 1;
    },
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', pageFactory: fp.factory });
  assert.equal(r.exitCode, 0, formatReport(r));
  assert.equal(r.steps.length, 1);
  assert.deepEqual(r.rows.map((x) => x.status), ['OK']);
  assert.deepEqual(
    fp.events.map((e) => `${e.type}:${e.sel}`),
    ['waitFor:text=Section A', 'click:text=Section A', 'waitFor:[data-testid=open-sub]', 'click:[data-testid=open-sub]', 'count:[data-testid=sub-body]'],
  );
  assert.equal(fp.events[0].timeout, 2500);

  // Step-level click_timeout overrides flow-level and opts.clickTimeout; default is 5000 ms
  const stepTimeoutDir = tmpProject({
    'step.yaml': 'click_timeout: 2500\nsteps:\n  - screen: a\n    visit: /a\n    click: "#btn"\n    click_timeout: 1200\n    expect: [{ selector: "#out", count: 1 }]\n',
    'def.yaml': 'steps:\n  - screen: a\n    visit: /a\n    click: "#btn"\n    expect: [{ selector: "#out", count: 1 }]\n',
  });
  const fpStep = fakeClickPage({ initialCounts: { '#out': 1 } });
  await runVerify(loadFlow(join(stepTimeoutDir, 'step.yaml')), { url, driver: 'playwright', clickTimeout: 4000, pageFactory: fpStep.factory });
  assert.equal(fpStep.events[0].timeout, 1200);

  const fpDef = fakeClickPage({ initialCounts: { '#out': 1 } });
  await runVerify(loadFlow(join(stepTimeoutDir, 'def.yaml')), { url, driver: 'playwright', pageFactory: fpDef.factory });
  assert.equal(fpDef.events[0].timeout, 5000);
});

test('playwright driver (fake page): missing click target marks step KO with click-target-missing hypothesis', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: details
    visit: /details
    click:
      - "#exists"
      - "#missing"
    click_timeout: 1500
    expect:
      - selector: "#always"
        count: 1
      - selector: "#body"
        count: 1
`,
  });
  const fp = fakeClickPage({
    initialCounts: { '#always': 1, '#body': 0 },
    missingSelectors: ['#missing'],
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  assert.equal(r.steps.length, 1);
  assert.deepEqual(r.rows.map((x) => x.status), ['KO', 'KO']);
  assert.match(r.rows[0].note, /click "#missing" did not appear within 1500 ms/);
  assert.equal(r.rows[1].note, 'same cause as #1');
  assert.equal(r.rows[0].hypotheses[0].type, 'click-target-missing');
  assert.equal(r.rows[0].hypotheses[0].confidence, 'high');
  assert.match(r.rows[0].hypotheses[0].evidence, /#missing/);
});

test('playwright driver: pageerror during click timeout surfaces page-error instead of click-target-missing', async () => {
  const flowDir = tmpProject({
    'f.yaml': 'steps:\n  - screen: a\n    visit: /a\n    click: "#btn"\n    click_timeout: 200\n    expect: [{ selector: "#out", count: 1 }]\n',
  });
  const emitter = new EventEmitter();
  let current = '';
  const factory = async () => ({
    page: {
      on: (ev, fn) => emitter.on(ev, fn),
      off: (ev, fn) => emitter.off(ev, fn),
      goto: async (u) => {
        current = u;
        emitter.emit('pageerror', new Error('crash before render'));
        return { status: () => 200 };
      },
      url: () => current,
      waitForLoadState: async () => {},
      locator: () => {
        const target = {
          waitFor: async () => { const e = new Error('Timeout 200ms exceeded'); e.name = 'TimeoutError'; throw e; },
          click: async () => {},
          count: async () => 0,
        };
        return { ...target, first: () => target };
      },
    },
    close: async () => {},
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: factory });
  assert.equal(r.exitCode, 1);
  assert.equal(r.rows[0].hypotheses[0].type, 'page-error');
});

test('http driver: click emits warning and ignores clicks', async () => {
  const flowDir = tmpProject({
    'f.yaml': `steps:
  - screen: dashboard
    visit: /
    click: "#toggle"
    requests:
      customers: GET /api/customers
    expect:
      - selector: "[data-testid=customer-chip]"
        count: 3
        data: { request: customers }
`,
  });
  const r = await runVerify(loadFlow(join(flowDir, 'f.yaml')), { url, driver: 'http' });
  assert.equal(r.exitCode, 0);
  assert.ok(r.warnings.some((w) => /click: is ignored with the http driver/.test(w)));
});

test('CLI verify --driver playwright (real Chromium): click opens collapsible and asserts inner text in one step', { skip: skipReal, timeout: 60_000 }, async () => {
  const app = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <button type="button" id="toggle">Ver detalles</button>
      <div id="collapsible-body"></div>
      <script>
        document.getElementById('toggle').addEventListener('click', () => {
          document.getElementById('collapsible-body').innerHTML =
            '<button type="button" id="more">Mostrar texto</button><div id="inner"></div>';
          document.getElementById('more').addEventListener('click', () => {
            document.getElementById('inner').innerHTML =
              '<p data-testid="collapsible-text">Contenido desplegado del colapsable</p>';
          });
        });
      </script>
    </body></html>`);
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const appUrl = `http://127.0.0.1:${app.address().port}`;
  try {
    const flowDir = tmpProject({
      'single.yaml': `steps:
  - screen: details
    visit: /
    click: "text=Ver detalles"
    expect:
      - selector: "#more"
        count: 1
`,
      'multi.yaml': `steps:
  - screen: details
    visit: /
    click:
      - "text=Ver detalles"
      - "#more"
    expect:
      - selector: "text=Contenido desplegado del colapsable"
        count: 1
      - selector: "[data-testid=collapsible-text]"
        count: 1
`,
    });

    const singleRes = await cliAsync(['verify', join(flowDir, 'single.yaml'), '--url', appUrl, '--driver', 'playwright', '--json'], ROOT);
    assert.equal(singleRes.code, 0, singleRes.stderr + singleRes.stdout);
    const singleJson = JSON.parse(singleRes.stdout);
    assert.equal(singleJson.exitCode, 0);
    assert.equal(singleJson.steps.length, 1);
    assert.deepEqual(singleJson.rows.map((r) => r.status), ['OK']);

    const multiRes = await cliAsync(['verify', join(flowDir, 'multi.yaml'), '--url', appUrl, '--driver', 'playwright', '--json'], ROOT);
    assert.equal(multiRes.code, 0, multiRes.stderr + multiRes.stdout);
    const multiJson = JSON.parse(multiRes.stdout);
    assert.equal(multiJson.exitCode, 0);
    assert.equal(multiJson.steps.length, 1);
    assert.deepEqual(multiJson.rows.map((r) => r.status), ['OK', 'OK']);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('CLI verify --driver playwright (real Chromium): missing click target gives KO with click-target-missing hypothesis', { skip: skipReal, timeout: 60_000 }, async () => {
  const app = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><div id="always-present">ok</div></body></html>');
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const appUrl = `http://127.0.0.1:${app.address().port}`;
  try {
    const flowDir = tmpProject({
      'missing.yaml': `steps:
  - screen: details
    visit: /
    click: "#does-not-exist"
    click_timeout: 200
    expect:
      - selector: "#always-present"
        count: 1
      - selector: "#collapsed-text"
        count: 1
`,
    });
    const res = await cliAsync(['verify', join(flowDir, 'missing.yaml'), '--url', appUrl, '--driver', 'playwright', '--diagnose', '--json'], ROOT);
    assert.equal(res.code, 1, res.stderr + res.stdout);
    const json = JSON.parse(res.stdout);
    assert.equal(json.exitCode, 1);
    assert.equal(json.steps.length, 1);
    assert.deepEqual(json.rows.map((r) => r.status), ['KO', 'KO']);
    assert.match(json.rows[0].note, /click "#does-not-exist" did not appear within 200 ms/);
    assert.equal(json.rows[1].note, 'same cause as #1');
    assert.equal(json.rows[0].hypotheses[0].type, 'click-target-missing');

    const badCli = await cliAsync(['verify', join(flowDir, 'missing.yaml'), '--url', appUrl, '--driver', 'playwright', '--click-timeout', '0'], ROOT);
    assert.equal(badCli.code, 3);
    assert.match(badCli.stderr, /--click-timeout must be a positive integer/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

// ---------- clock ----------

const CLOCK_FLOW = `scenario: s.yaml
clock: { time: 2025-06-01T10:00:00Z }
steps:
  - screen: home
    visit: /home
    expect:
      - selector: ".item"
        count: 1
  - screen: detalle
    visit: /detalle
    clock: { time: scenario }
    expect:
      - selector: ".item"
        count: 1
`;

test('loadFlow: clock at flow and step level, with "scenario" resolving to scenario.now', () => {
  const dir = tmpProject({
    's.yaml': `name: reloj\nseed: 1\nnow: 2025-03-01T09:00:00Z\nworld:\n  items: 1\nendpoints:\n  - path: /api/items\n    entity: items\n`,
    'f.yaml': CLOCK_FLOW
  });
  const flow = loadFlow(join(dir, 'f.yaml'));
  assert.equal(flow.clock.time, '2025-06-01T10:00:00.000Z');
  assert.equal(flow.steps[0].clock, null);
  assert.equal(flow.steps[1].clock.time, '2025-03-01T09:00:00.000Z', 'scenario = el now del escenario');
});

test('loadFlow: an invalid clock is a flow error', () => {
  const dir = tmpProject({
    'f.yaml': 'steps:\n  - screen: home\n    visit: /home\n    clock: { time: ayer }\n'
  });
  assert.throws(() => loadFlow(join(dir, 'f.yaml')), /clock\.time": must be an ISO date\/time or "scenario"/);
  const dir2 = tmpProject({ 'f.yaml': 'steps:\n  - screen: home\n    visit: /home\n    clock: { time: "2025-01-01T00:00:00Z", zona: UTC }\n' });
  assert.throws(() => loadFlow(join(dir2, 'f.yaml')), /clock\.zona": unknown field/);
});

test('verify: installs the browser clock before navigating, once per page', async () => {
  const dir = tmpProject({
    'f.yaml': 'clock: { time: 2025-06-01T10:00:00Z }\nsteps:\n  - screen: home\n    visit: /home\n    expect:\n      - selector: ".item"\n        count: 1\n'
  });
  const installed = [];
  const page = {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForSelector: async () => {},
    locator: () => ({ count: async () => 1 }),
    clock: { install: async ({ time }) => { installed.push(new Date(time).toISOString()); }, setFixedTime: async () => {} }
  };
  await runVerify(loadFlow(join(dir, 'f.yaml')), {
    url: 'http://mock', driver: 'playwright', cwd: dir, reset: false,
    pageFactory: async () => ({ page, close: async () => {} })
  });
  assert.deepEqual(installed, ['2025-06-01T10:00:00.000Z'], 'install() antes de la primera navegación');
});
