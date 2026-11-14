import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadFlow } from '../scripts/lib/scenario.mjs';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { runVerify, formatReport, diagnose } from '../scripts/lib/verify.mjs';
import { SCENARIO, FLOW, tmpProject, cliAsync } from './helpers.mjs';

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
