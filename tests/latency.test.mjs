// `serve --latency <ms>` and the per-endpoint `latency:`: real backend timing on contract answers only.
// Timing assertions are lower bounds only (a loaded machine is slower, never faster); what must NOT
// wait is checked through the `sleep` hook, which is deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { normalizeScenario } from '../scripts/lib/scenario.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { cli, tmpProject } from './helpers.mjs';
import { getJson, request } from './helpers/http.mjs';
import { startServe } from './helpers/serve.mjs';

const SLOW = `name: slow
seed: 3
world:
  customers: 2
  orders: { total: 4, distribution: { paid: 3, issue: 1 } }
endpoints:
  - path: /api/orders
    entity: orders
    filters: [status]
  - path: /api/customers
    entity: customers
    latency: LATENCY
`;

// setTimeout may fire up to ~1 ms before the nominal delay as measured by performance.now().
const SLACK = 5;
const timed = async (fn) => { const t0 = performance.now(); const r = await fn(); return { r, ms: performance.now() - t0 }; };

test('latency: 200 on an endpoint delays its contract response and leaves a static file untouched', async () => {
  const dir = tmpProject({ 'scenarios/slow.yaml': SLOW.replace('LATENCY', '200'), 'public/app.js': 'console.log(1)' });
  const waits = [];
  const sleep = (ms) => { waits.push(ms); return new Promise((ok) => { setTimeout(ok, ms); }); };
  const mock = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'slow', staticDir: join(dir, 'public'), sleep });
  const url = `http://127.0.0.1:${(await mock.listen(0)).port}`;
  try {
    const list = await timed(() => getJson(`${url}/api/customers`));
    assert.equal(list.r.status, 200);
    assert.equal(list.r.body.length, 2);
    assert.ok(list.ms >= 200 - SLACK, `list answered in ${list.ms.toFixed(1)} ms, expected >= 200`);
    const detail = await timed(() => getJson(`${url}/api/customers/1`));
    assert.equal(detail.r.body.id, 1);
    assert.ok(detail.ms >= 200 - SLACK, `detail answered in ${detail.ms.toFixed(1)} ms, expected >= 200`);
    assert.deepEqual(waits, [200, 200]);

    // no wait requested for: a static file, an endpoint without latency (flag 0), control routes, a gap
    const file = await request(`${url}/app.js`);
    assert.equal(file.status, 200);
    assert.equal(file.text, 'console.log(1)');
    assert.equal((await getJson(`${url}/api/orders`)).body.length, 4);
    assert.equal((await getJson(`${url}/__atrezzo/state`)).status, 200);
    assert.equal((await getJson(`${url}/api/invoices`)).status, 404);
    assert.deepEqual(waits, [200, 200], 'only the two contract answers of /api/customers waited');
  } finally {
    await mock.close();
  }
});

test('serve --latency applies to every contract endpoint and latency: overrides it for one', async () => {
  const dir = tmpProject({ 'atrezzo/scenarios/slow.yaml': SLOW.replace('LATENCY', '400') });
  const srv = await startServe(dir, ['--scenario', 'slow', '--latency', '150']);
  try {
    // the banner prints the effective latency and the override
    assert.match(srv.log(), /latency: 150 ms on contract responses \(1 endpoint overrides it in the scenario\)/);
    assert.match(srv.log(), /GET \/api\/customers {2}\(latency 400 ms\)/);
    const state = (await getJson(`${srv.url}/__atrezzo/state`)).body;
    assert.deepEqual(state.latency, { default: 150, endpoints: { '/api/customers': 400 } });

    for (const path of ['/api/orders', '/api/orders?status=issue', '/api/orders/2']) {
      const { r, ms } = await timed(() => getJson(srv.url + path));
      assert.equal(r.status, 200, path);
      assert.ok(ms >= 150 - SLACK, `${path} answered in ${ms.toFixed(1)} ms, expected >= 150 (--latency)`);
    }
    for (const path of ['/api/customers', '/api/customers/1']) {
      const { r, ms } = await timed(() => getJson(srv.url + path));
      assert.equal(r.status, 200, path);
      assert.ok(ms >= 400 - SLACK, `${path} answered in ${ms.toFixed(1)} ms, expected >= 400 (latency: wins over --latency)`);
    }
  } finally {
    srv.stop();
  }
});

test('latency is validated: integer milliseconds in the scenario and on the command line', () => {
  for (const bad of ['-5', '1.5', '"fast"', '60001']) {
    try {
      normalizeScenario(parseYaml(SLOW.replace('LATENCY', bad), 't.yaml'), 't.yaml');
      assert.fail(`latency: ${bad} should be rejected`);
    } catch (e) {
      assert.match(e.issues.join('\n'), /field "endpoints\[1\]\.latency": milliseconds, an integer between 0 and 60000/, bad);
    }
  }
  const dir = tmpProject({ 'atrezzo/scenarios/slow.yaml': SLOW.replace('LATENCY', '0') });
  const r = cli(['serve', '--port', '0', '--latency', 'soon'], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /invalid --latency: soon/);
});
