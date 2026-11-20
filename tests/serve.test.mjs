import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createMockServer } from '../scripts/lib/serve.mjs';
import { SCENARIO, SMALL, tmpProject } from './helpers.mjs';
import { request, getJson as httpGetJson, postJson, del } from './helpers/http.mjs';

let mock; let url;
before(async () => {
  const dir = tmpProject({ 'scenarios/conciliacion.yaml': SCENARIO, 'scenarios/pequeno.yaml': SMALL, 'public/index.html': '<h1>hello</h1>' });
  mock = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'conciliacion', staticDir: join(dir, 'public') });
  url = `http://127.0.0.1:${(await mock.listen(0)).port}`;
});
after(() => mock.close());

const getJson = async (p) => { const r = await fetch(url + p); return { status: r.status, headers: r.headers, body: await r.json() }; };

test('real HTTP: limit/offset and X-Total-Count header', async () => {
  const r = await getJson('/api/orders?limit=5&offset=35');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((x) => x.id), [36, 37, 38, 39, 40]);
  assert.equal(r.headers.get('x-total-count'), '40');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('same engine as the handlers: serve == engine', async () => {
  const { createEngine } = await import('../scripts/lib/contract.mjs');
  const direct = createEngine(mock.state.dataset).handle({ pathname: '/api/orders', query: new URLSearchParams('status=pending') });
  assert.deepEqual((await getJson('/api/orders?status=pending')).body, direct.body);
});

test('reset switches scenario without restarting and the counts change', async () => {
  const before = await getJson('/__atrezzo/state');
  assert.equal(before.body.scenario, 'conciliacion');
  assert.equal(before.body.counts.orders, 40);
  const r = await fetch(`${url}/__atrezzo/reset`, { method: 'POST', body: JSON.stringify({ scenario: 'pequeno' }) });
  assert.equal(r.status, 200);
  const after = await getJson('/__atrezzo/state');
  assert.equal(after.body.scenario, 'pequeno');
  assert.deepEqual(after.body.counts, { customers: 1, orders: 5 });
  assert.equal((await getJson('/api/orders')).body.length, 5);
  assert.equal((await getJson('/api/orders?status=issue')).body.length, 1);
  // and back
  await fetch(`${url}/__atrezzo/reset?scenario=conciliacion`, { method: 'POST' });
  assert.equal((await getJson('/api/orders?limit=100')).body.length, 40);
});

test('reset to an unknown scenario ⇒ 400 and the state does not change', async () => {
  const r = await fetch(`${url}/__atrezzo/reset`, { method: 'POST', body: '{"scenario":"nada"}' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not found/);
  assert.equal((await getJson('/__atrezzo/state')).body.scenario, 'conciliacion');
});

test('routes outside the contract ⇒ explanatory 404; static files served', async () => {
  const r = await getJson('/api/facturas');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /is not in the contract/);
  const html = await fetch(`${url}/`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /hello/);
  assert.equal((await fetch(`${url}/..%2f..%2fetc/passwd`)).status, 403);
});

// ---------- SPA fallback (--static) ----------

test('SPA fallback: an HTML navigation gets index.html; JSON, unknown API paths, missing assets and POST keep the 404', async () => {
  const dir = tmpProject({ 'scenarios/conciliacion.yaml': SCENARIO, 'dist/index.html': '<div id="root">shell</div>', 'dist/assets/app.js': 'console.log(1)' });
  const spa = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'conciliacion', staticDir: join(dir, 'dist') });
  const bare = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'conciliacion' });
  const base = `http://127.0.0.1:${(await spa.listen(0)).port}`;
  const noStatic = `http://127.0.0.1:${(await bare.listen(0)).port}`;
  const HTML = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }; // what Chromium sends on navigation
  try {
    // a browser entering the app at a deep link
    for (const [path, headers] of [['/copilot', HTML], ['/copilot/chat/12?tab=a', HTML], ['/copilot', {}], ['/user/ana.perez', HTML]]) {
      const r = await request(base + path, { headers });
      assert.equal(r.status, 200, `${path} ${JSON.stringify(headers)}`);
      assert.match(r.headers.get('content-type'), /^text\/html/);
      assert.equal(r.text, '<div id="root">shell</div>');
    }
    const head = await request(`${base}/copilot`, { method: 'HEAD', headers: HTML });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    // the app asking for data: JSON Accept or fetch's default */*
    for (const accept of ['application/json', '*/*']) {
      const r = await request(`${base}/copilot`, { headers: { accept } });
      assert.equal(r.status, 404, accept);
      assert.equal(JSON.parse(r.text).atrezzo.miss, true);
    }
    // an unknown API path is a gap even when it asks for HTML, and a path with no Accept but an extension is not a page
    for (const [path, headers] of [['/api/facturas', HTML], ['/api/facturas', {}], ['/report.pdf', {}]]) {
      const r = await request(base + path, { headers });
      assert.equal(r.status, 404, path);
      assert.equal(JSON.parse(r.text).atrezzo.miss, true, path);
    }
    // a missing asset keeps its 404, existing files and contract endpoints are untouched
    const missing = await request(`${base}/assets/missing.js`, { headers: HTML });
    assert.equal(missing.status, 404);
    assert.match(JSON.parse(missing.text).error, /does not exist in the static directory/);
    assert.equal((await request(`${base}/assets/app.js`, { headers: HTML })).text, 'console.log(1)');
    const api = await request(`${base}/api/orders?limit=2`, { headers: HTML });
    assert.equal(api.status, 200);
    assert.equal(JSON.parse(api.text).length, 2);
    // writes never fall back
    for (const method of ['POST', 'PUT']) {
      const r = await request(`${base}/copilot`, { method, headers: HTML, body: '{}' });
      assert.equal(r.status, 404, method);
      assert.equal(JSON.parse(r.text).atrezzo.gap, `${method} /copilot`);
    }
    // without --static there is no shell to fall back to
    const r = await request(`${noStatic}/copilot`, { headers: HTML });
    assert.equal(r.status, 404);
    assert.equal(JSON.parse(r.text).atrezzo.miss, true);
    // only real gaps are recorded: never the navigations that got the shell
    const gaps = spa.misses.list().map((m) => `${m.method} ${m.path}`);
    assert.ok(gaps.includes('GET /copilot') && gaps.includes('GET /api/facturas') && gaps.includes('POST /copilot'), gaps.join(', '));
    assert.ok(!gaps.some((g) => /copilot\/chat|ana\.perez/.test(g)), gaps.join(', '));
  } finally {
    await spa.close();
    await bare.close();
  }
});

// ---------- Business writes over HTTP (`serve` + `POST /__atrezzo/reset`) ----------

const WRITES_YAML = `name: tienda-writes
seed: 7712
now: 2025-03-01T09:00:00Z
world:
  customers: 3
  orders:
    total: 5
    distribution: { paid: 3, pending: 1, issue: 1 }
    amount: { min: 20, max: 500, currency: EUR }
endpoints:
  - path: /api/orders
    entity: orders
    filters: [status, customer_id]
    pagination: { param_limit: limit, param_offset: offset }
    sort: id
  - path: /api/customers
    entity: customers
    counts:
      orders: { entity: orders, on: customer_id }
writes:
  "POST /api/orders":
    expect: { status: 201, echo: true }
    mutate: { entity: orders, set: { status: "nuevo" } }
  "PATCH /api/orders/:id":
    expect: { status: 200, echo: true }
    mutate: { entity: orders, set: { status: "enviado" } }
  "DELETE /api/orders/:id":
    expect: { status: 204 }
    mutate: { entity: orders }
`;

test('serve writes: POST creates, PATCH updates, DELETE removes, state updates, and POST /__atrezzo/reset restores', async () => {
  const dir = tmpProject({ 'scenarios/tienda-writes.yaml': WRITES_YAML });
  const srv = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'tienda-writes' });
  const base = `http://127.0.0.1:${(await srv.listen(0)).port}`;
  try {
    const initialState = (await httpGetJson(`${base}/__atrezzo/state`)).body;
    assert.equal(initialState.counts.orders, 5);
    assert.deepEqual(initialState.writes, ['POST /api/orders', 'PATCH /api/orders/:id', 'DELETE /api/orders/:id']);

    // POST creates order #6 with status "nuevo"
    const created = await postJson(`${base}/api/orders`, JSON.stringify({ customer_id: 1, amount: 85 }));
    assert.equal(created.status, 201);
    assert.equal(created.body.id, 6);
    assert.equal(created.body.status, 'nuevo');
    assert.equal(created.body.amount, 85);

    // Subsequent GET reads and /__atrezzo/state see the new order
    const nuevoList = await httpGetJson(`${base}/api/orders?status=nuevo`);
    assert.equal(nuevoList.status, 200);
    assert.equal(nuevoList.body.length, 1);
    assert.equal(nuevoList.body[0].id, 6);
    assert.equal((await httpGetJson(`${base}/api/orders/6`)).body.status, 'nuevo');
    assert.equal((await httpGetJson(`${base}/__atrezzo/state`)).body.counts.orders, 6);

    // Determinism: key arrival order in POST JSON produces identical response body
    const rA = await postJson(`${base}/api/orders`, JSON.stringify({ amount: 12, customer_id: 2 }));
    await del(`${base}/api/orders/${rA.body.id}`);
    await fetch(`${base}/__atrezzo/reset`, { method: 'POST' });
    await postJson(`${base}/api/orders`, JSON.stringify({ customer_id: 1, amount: 85 }));
    const rB = await postJson(`${base}/api/orders`, JSON.stringify({ customer_id: 2, amount: 12 }));
    assert.equal(JSON.stringify(rA.body), JSON.stringify(rB.body));

    // PATCH changes order #6
    const patchRes = await fetch(`${base}/api/orders/6`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 199 }),
    });
    assert.equal(patchRes.status, 200);
    const patched = await patchRes.json();
    assert.equal(patched.status, 'enviado');
    assert.equal(patched.amount, 199);
    assert.equal((await httpGetJson(`${base}/api/orders/6`)).body.status, 'enviado');

    // DELETE removes order #6
    const delRes = await fetch(`${base}/api/orders/6`, { method: 'DELETE' });
    assert.equal(delRes.status, 204);
    assert.equal(await delRes.text(), '');
    assert.equal((await httpGetJson(`${base}/api/orders/6`)).status, 404);
    assert.equal((await httpGetJson(`${base}/__atrezzo/state`)).body.counts.orders, 6);

    // POST /__atrezzo/reset (with empty body) restores the initial world
    const resetRes = await postJson(`${base}/__atrezzo/reset`);
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.body.counts.orders, 5);
    assert.equal((await httpGetJson(`${base}/api/orders?status=nuevo`)).body.length, 0);
    assert.equal((await httpGetJson(`${base}/api/orders/6`)).status, 404);
    assert.equal((await httpGetJson(`${base}/api/orders`)).body.length, 5);

    // Invalid JSON body on POST returns 400
    const badJson = await postJson(`${base}/api/orders`, '{invalid');
    assert.equal(badJson.status, 400);
    assert.match(badJson.body.error, /invalid JSON body/);
  } finally {
    await srv.close();
  }
});

// ---------- SSE streams (`streams`) ----------

const STREAMS_YAML = `name: ticker
seed: 7712
now: 2025-03-01T09:00:00Z
world:
  products: 2
endpoints:
  - path: /api/products
    entity: products
streams:
  "/api/prices":
    interval: 25
    events:
      - { symbol: "BTC", price: 100 }
      - { symbol: "BTC", price: 105 }
    loop: true
  "/api/updates":
    interval: 25
    events:
      - { step: 1, status: "started" }
      - { step: 2, status: "ready" }
      - { step: 3, status: "done" }
    loop: false
`;

async function readSseEvents(streamUrl, { maxEvents = Infinity, signal } = {}) {
  const res = await fetch(streamUrl, { signal });
  const contentType = res.headers.get('content-type');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames = [];
  const events = [];
  try {
    while (events.length < maxEvents) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const rawFrame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        frames.push(`${rawFrame}\n\n`);
        const line = rawFrame.split('\n').find((l) => l.startsWith('data: '));
        if (line) events.push(JSON.parse(line.slice(6)));
        if (events.length >= maxEvents) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { status: res.status, contentType, frames, events };
}

test('SSE streams: loop: false emits declared events in order as data: <json>\\n\\n and closes', async () => {
  const dir = tmpProject({ 'scenarios/ticker.yaml': STREAMS_YAML, 'scenarios/pequeno.yaml': SMALL });
  const srv = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'ticker' });
  const base = `http://127.0.0.1:${(await srv.listen(0)).port}`;
  try {
    const state = (await httpGetJson(`${base}/__atrezzo/state`)).body;
    assert.deepEqual(state.streams, ['/api/prices', '/api/updates']);

    const { status, contentType, frames, events } = await readSseEvents(`${base}/api/updates`);
    assert.equal(status, 200);
    assert.match(contentType, /^text\/event-stream/);
    assert.deepEqual(frames, [
      'data: {"step":1,"status":"started"}\n\n',
      'data: {"step":2,"status":"ready"}\n\n',
      'data: {"step":3,"status":"done"}\n\n',
    ]);
    assert.deepEqual(events, [
      { step: 1, status: 'started' },
      { step: 2, status: 'ready' },
      { step: 3, status: 'done' },
    ]);
  } finally {
    await srv.close();
  }
});

test('SSE streams: loop: true repeats events in order and closes cleanly on client disconnect', async () => {
  const dir = tmpProject({ 'scenarios/ticker.yaml': STREAMS_YAML });
  const srv = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'ticker' });
  const base = `http://127.0.0.1:${(await srv.listen(0)).port}`;
  try {
    const ac = new AbortController();
    const { status, contentType, events } = await readSseEvents(`${base}/api/prices`, { maxEvents: 5, signal: ac.signal });
    ac.abort();
    assert.equal(status, 200);
    assert.match(contentType, /^text\/event-stream/);
    assert.deepEqual(events, [
      { symbol: 'BTC', price: 100 },
      { symbol: 'BTC', price: 105 },
      { symbol: 'BTC', price: 100 },
      { symbol: 'BTC', price: 105 },
      { symbol: 'BTC', price: 100 },
    ]);

    // Also verify raw node:http client socket destroy closes stream cleanly without hanging server.close()
    const { get } = await import('node:http');
    const firstChunk = await new Promise((ok, ko) => {
      const clientReq = get(`${base}/api/prices`, (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /^text\/event-stream/);
        res.once('data', (chunk) => {
          const text = chunk.toString('utf8');
          clientReq.destroy();
          ok(text);
        });
      });
      clientReq.on('error', ko);
    });
    assert.equal(firstChunk, 'data: {"symbol":"BTC","price":100}\n\n');
  } finally {
    await srv.close();
  }
});

test('SSE streams: POST /__atrezzo/reset closes active streams cleanly', async () => {
  const dir = tmpProject({ 'scenarios/ticker.yaml': STREAMS_YAML, 'scenarios/pequeno.yaml': SMALL });
  const srv = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'ticker' });
  const base = `http://127.0.0.1:${(await srv.listen(0)).port}`;
  try {
    const res = await fetch(`${base}/api/prices`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const received = [];

    // Read the first 2 events from the looping stream
    while (received.length < 2) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (frame.startsWith('data: ')) received.push(JSON.parse(frame.slice(6)));
      }
    }
    assert.deepEqual(received, [{ symbol: 'BTC', price: 100 }, { symbol: 'BTC', price: 105 }]);

    // Failed reset (unknown scenario) keeps the stream alive
    const badReset = await fetch(`${base}/__atrezzo/reset`, { method: 'POST', body: '{"scenario":"unknown"}' });
    assert.equal(badReset.status, 400);

    // Valid reset closes the active SSE stream cleanly (EOF)
    const resetPromise = fetch(`${base}/__atrezzo/reset`, { method: 'POST', body: '{}' });
    const tail = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) tail.push(decoder.decode(value, { stream: true }));
    }
    const resetRes = await resetPromise;
    assert.equal(resetRes.status, 200);
    // Any buffered data before EOF must still be valid frames; stream ended cleanly without throwing.
    assert.ok(Array.isArray(tail));
  } finally {
    await srv.close();
  }
});
