// serve vs real msw/node on the request sequence the Conduit front sends (feed → favorite → article → follow → feed).
// Usage: node parity.mjs <scratch-project-dir> <atrezzo-repo>
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const [dir, repo] = process.argv.slice(2);
const { createMockServer } = await import(pathToFileURL(join(repo, 'scripts/lib/serve.mjs')).href);
const { handlers } = await import(pathToFileURL(join(dir, '.generated/conduit-session.handlers.mjs')).href);
const req = createRequire(join(dir, 'package.json'));
const { setupServer } = await import(pathToFileURL(req.resolve('msw/node')).href);

const mock = createMockServer({ scenariosDir: join(dir, 'scenarios'), scenario: 'conduit-session' });
const port = (await mock.listen(0)).port;
const served = `http://127.0.0.1:${port}`;

// serve first over a raw socket-free path: use node:http so msw (which patches fetch/http) cannot answer it.
const http = await import('node:http');
const viaServe = (method, path, body) => new Promise((resolve, reject) => {
  const r = http.request(`${served}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
    let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
  });
  r.on('error', reject); if (body) r.write(body); r.end();
});

const SLUG = '21b6be78-8754-4566-820d-a428f1ece189';
const seq = [
  ['GET', '/api/tags'], ['GET', '/api/user'], ['GET', '/api/articles/feed?limit=10&offset=0'],
  ['GET', '/api/articles?limit=10&offset=0'], ['GET', '/api/articles?limit=10&offset=20'],
  ['GET', '/api/articles?author=carol&limit=5&offset=0'], ['GET', '/api/articles?tag=welcome&limit=10&offset=0'],
  ['GET', '/api/articles?favorited=alice&limit=5&offset=0'],
  ['GET', `/api/articles/${SLUG}`], ['GET', `/api/articles/${SLUG}/comments`], ['GET', '/api/profiles/dave'],
  ['GET', '/api/profiles/nobody'], ['GET', '/api/articles/nope'],
  ['POST', `/api/articles/${SLUG}/favorite`, '{}'], ['GET', `/api/articles/${SLUG}`],
  ['POST', '/api/profiles/dave/follow', '{}'], ['GET', '/api/articles/feed?limit=10&offset=0'],
  ['DELETE', `/api/articles/${SLUG}/favorite`], ['GET', `/api/articles/${SLUG}`],
  ['POST', `/api/articles/${SLUG}/comments`, '{"comment":{"body":"hi"}}'],
  ['PUT', '/api/user', '{"user":{"bio":"x"}}'], ['POST', '/api/users/login', '{"user":{"email":"a","password":"b"}}'],
];

// 1) serve: the whole sequence (writes mutate its own in-memory world)
const a = [];
for (const [m, p, b] of seq) a.push(await viaServe(m, p, b));
mock.close();

// 2) msw: same sequence through fetch, intercepted by the generated handlers
const server = setupServer(...handlers);
server.listen({ onUnhandledRequest: 'bypass' });
const b = [];
for (const [m, p, body] of seq) {
  try {
    const res = await fetch(`http://localhost:4010${p}`, { method: m, headers: body ? { 'content-type': 'application/json' } : {}, body });
    b.push({ status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() });
  } catch (e) { b.push({ status: 'network-error', headers: {}, text: String(e.cause?.code ?? e.message) }); }
}
server.close();

const H = ['x-total-count', 'x-atrezzo-ignored', 'x-atrezzo-error', 'allow'];
const norm = (t) => { try { const j = JSON.parse(t); if (j && j.atrezzo) delete j.atrezzo; return JSON.stringify(j); } catch { return t; } };
let diffs = 0;
seq.forEach(([m, p], i) => {
  const s = a[i]; const w = b[i];
  const problems = [];
  if (s.status !== w.status) problems.push(`status ${s.status} vs ${w.status}`);
  for (const h of H) if ((s.headers[h] ?? null) !== (w.headers[h] ?? null)) problems.push(`${h}: ${s.headers[h] ?? '-'} vs ${w.headers[h] ?? '-'}`);
  if (s.status === w.status && norm(s.text) !== norm(w.text)) problems.push(`body differs: serve ${s.text.slice(0, 120)} | msw ${w.text.slice(0, 120)}`);
  if (problems.length) diffs++;
  console.log(`${problems.length ? 'DIFF' : 'same'}  ${m} ${p}  serve=${s.status} msw=${w.status}${problems.length ? '  ' + problems.join(' · ') : ''}`);
});
console.log(`\n${seq.length} requests · ${diffs} with differences`);
