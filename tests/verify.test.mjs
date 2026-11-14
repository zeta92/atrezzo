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
    'escenarios/conciliacion.yaml': SCENARIO,
    'flujo.yaml': FLOW,
    'flujo-ko.yaml': FLOW.replace('count: 3\n', 'count: 4\n'),
  });
  mock = createMockServer({ scenariosDir: join(dir, 'escenarios') });
  const addr = await mock.listen(0);
  url = `http://127.0.0.1:${addr.port}`;
});
after(() => mock.close());

test('driver http: aserciones OK ⇒ exit 0', async () => {
  const r = await runVerify(loadFlow(join(dir, 'flujo.yaml')), { url, driver: 'http' });
  // customer-chip no tiene data ⇒ N/V; el resto OK. Quitamos esa aserción para el caso verde.
  const ok = r.rows.filter((x) => x.status === 'OK');
  assert.equal(ok.length, 2);
  assert.equal(r.rows.find((x) => x.expect.selector === '[data-testid=customer-chip]').status, 'N/V');
  assert.equal(r.exitCode, 2, 'una aserción sin verificar nunca da verde');
  writeFileSync(join(dir, 'flujo-verde.yaml'), FLOW.replace('        count: 3\n', '        count: 3\n        data: { request: clientes }\n'));
  const g = await runVerify(loadFlow(join(dir, 'flujo-verde.yaml')), { url, driver: 'http' });
  assert.equal(g.exitCode, 0);
  assert.ok(g.rows.every((x) => x.status === 'OK'));
  assert.match(formatReport(g), /3 OK · 0 KO · 0 sin verificar → VERDE/);
});

test('driver http: aserción KO ⇒ exit 1 con esperado vs obtenido', async () => {
  const flowText = FLOW.replace('        count: 3\n', '        count: 4\n        data: { request: clientes }\n');
  writeFileSync(join(dir, 'flujo-ko.yaml'), flowText);
  const r = await runVerify(loadFlow(join(dir, 'flujo-ko.yaml')), { url, driver: 'http', diagnose: true });
  assert.equal(r.exitCode, 1);
  const ko = r.rows.find((x) => x.status === 'KO');
  assert.equal(ko.obtained, 3);
  assert.equal(ko.expect.count, 4);
  assert.ok(ko.hypotheses.some((h) => h.tipo === 'mundo-distinto'));
  assert.match(formatReport(r), /=4\s+3\s+KO/);
});

test('diagnóstico: paginación desalineada', async () => {
  writeFileSync(join(dir, 'flujo-pag.yaml'), FLOW.replace('      incidencias: GET /api/orders?estado=incidencia\n',
    '      incidencias: GET /api/orders?estado=incidencia\n    expect:\n      - selector: "tr [data-estado=incidencia]"\n        count: 3\n        data: { request: pedidos, where: { estado: incidencia } }\n'));
  const flow = loadFlow(join(dir, 'flujo-pag.yaml'));
  const r = await runVerify(flow, { url, driver: 'http', diagnose: true });
  const row = r.rows.find((x) => x.expect.selector === 'tr [data-estado=incidencia]');
  const inPage = mock.state.dataset.entities.pedidos.slice(0, 12).filter((p) => p.estado === 'incidencia').length;
  if (inPage === 3) assert.equal(row.status, 'OK');
  else {
    assert.equal(row.status, 'KO');
    assert.ok(row.hypotheses.some((h) => h.tipo === 'paginacion-desalineada' && h.confianza === 'alta'));
  }
});

test('diagnose(): deduplicación por id, campo nulo y filtro en cliente', () => {
  const row = { expect: { selector: 'x', count: 3 } };
  const dup = diagnose(row, { obtained: 2, response: { status: 200, headers: {} }, items: [{ id: 1 }, { id: 1 }, { id: 2 }], matched: 3, domCount: 2 });
  assert.ok(dup.some((h) => h.tipo === 'deduplicacion-por-id'));
  const nul = diagnose(row, { obtained: 2, response: { status: 200, headers: {} }, items: [{ id: 1, email: null }, { id: 2, email: 'a' }, { id: 3, email: 'b' }], matched: 3, domCount: 2 });
  assert.ok(nul.some((h) => h.tipo === 'campo-nulo' && h.confianza === 'alta'));
  const cli = diagnose(row, { obtained: 1, response: { status: 200, headers: {} }, items: [{ id: 1 }, { id: 2 }, { id: 3 }], matched: 3, domCount: 1 });
  assert.ok(cli.some((h) => h.tipo === 'filtro-en-cliente'));
  assert.ok(cli.some((h) => h.tipo === 'render'));
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

test('driver playwright (page fake): OK cuando el DOM cuadra', async () => {
  const fp = fakePage({ '[data-testid=customer-chip]': 3, '[data-testid=order-row]': 12, '[data-testid=badge-incidencia]': 3 });
  const r = await runVerify(loadFlow(join(dir, 'flujo.yaml')), { url, driver: 'playwright', pageFactory: fp.factory });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.rows.map((x) => x.status), ['OK', 'OK', 'OK']);
  assert.deepEqual(fp.visited, [`${url}/`, `${url}/lista`]);
});

test('driver playwright (page fake): KO con diagnóstico de filtro en cliente', async () => {
  const fp = fakePage({ '[data-testid=customer-chip]': 3, '[data-testid=order-row]': 9, '[data-testid=badge-incidencia]': 3 });
  const r = await runVerify(loadFlow(join(dir, 'flujo.yaml')), { url, driver: 'playwright', diagnose: true, pageFactory: fp.factory });
  assert.equal(r.exitCode, 1);
  const ko = r.rows.find((x) => x.status === 'KO');
  assert.equal(ko.obtained, 9);
  assert.ok(ko.hypotheses.some((h) => h.tipo === 'filtro-en-cliente'));
  assert.ok(ko.hypotheses.some((h) => h.tipo === 'render'));
});

test('CLI verify --driver playwright sin playwright instalado ⇒ exit 2, nunca falso OK', async () => {
  const r = await cliAsync(['verify', 'flujo.yaml', '--driver', 'playwright', '--url', url], dir);
  assert.equal(r.code, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /playwright.*no está instalado/);
  assert.doesNotMatch(r.stdout, /VERDE/);
});

test('CLI verify sin mock escuchando ⇒ exit 2', async () => {
  const r = await cliAsync(['verify', 'flujo.yaml', '--url', 'http://127.0.0.1:9'], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /No hay ningún mock escuchando/);
});

test('CLI verify --driver http en verde ⇒ exit 0', async () => {
  const r = await cliAsync(['verify', 'flujo-verde.yaml', '--url', url], dir);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /VERDE/);
});
