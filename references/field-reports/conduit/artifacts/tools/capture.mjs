// Rebuilds the ctx verify passed to diagnose() for each field KO row, checks diagnose() reproduces
// what verify printed, trims items to the keys that matter, and checks the trimmed ctx still does.
// Usage: node capture.mjs <atrezzo-repo> <runs-dir> <mock-url> <project-dir>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, runs, url, project] = process.argv.slice(2);
const { diagnose, header, whereMatch } = await import(pathToFileURL(join(repo, 'scripts/lib/diagnose.mjs')).href);
const { parseYaml } = await import(pathToFileURL(join(repo, 'scripts/lib/yaml.mjs')).href).catch(() => ({}));

// [run json, flow file, scenario name, cause, truths, note]
const CASES = [
  ['profile-by-author.http', 'atrezzo/flows/profile-by-author.yaml', 'conduit-session', 'undeclared-filter', [], 'campo: ?author=<username> ignorado (filtro a través del autor)'],
  ['f5-tag-filter.http', 'atrezzo/flows/inject/f5-tag-filter.yaml', 'f5-tag-filter', 'undeclared-filter', [], 'campo: ?tag= ignorado (tagList contiene), http'],
  ['f5-tag-filter.playwright', 'atrezzo/flows/inject/f5-tag-filter.yaml', 'f5-tag-filter', 'undeclared-filter', [], 'campo: ?tag= ignorado, playwright'],
  ['f5-feed-max-limit.http', 'atrezzo/flows/inject/f5-feed-max-limit.yaml', 'f5-feed-max-limit', 'pagination-mismatch', [], 'campo: max_limit 5 y el cliente pide 10, http'],
  ['f5-feed-max-limit.playwright', 'atrezzo/flows/inject/f5-feed-max-limit.yaml', 'f5-feed-max-limit', 'pagination-mismatch', [], 'campo: max_limit 5 y el cliente pide 10, playwright'],
  ['f5-feed-sort.http', 'atrezzo/flows/inject/f5-feed-sort.yaml', 'f5-feed-sort', 'pagination-mismatch', [], 'campo: sort del endpoint al revés, los favoritos caen fuera de la página, http'],
  ['f5-feed-sort.playwright', 'atrezzo/flows/inject/f5-feed-sort.yaml', 'f5-feed-sort', 'pagination-mismatch', [], 'campo: sort del endpoint al revés, playwright'],
  ['f5-feed-world.http', 'atrezzo/flows/inject/f5-feed-world.yaml', 'f5-feed-world', 'world-mismatch', [], 'campo: alice no sigue a nadie, feed vacío, http'],
  ['f5-feed-world.playwright', 'atrezzo/flows/inject/f5-feed-world.yaml', 'f5-feed-world', 'world-mismatch', [], 'campo: feed vacío, playwright (world-mismatch solo existe sin DOM)'],
  ['f5-tags-empty.http', 'atrezzo/flows/inject/f5-tags-empty.yaml', 'f5-tags-empty', 'world-mismatch', [], 'campo: mundo sin tags, http'],
  ['f5-tags-empty.playwright', 'atrezzo/flows/inject/f5-tags-empty.yaml', 'f5-tags-empty', 'world-mismatch', [], 'campo: mundo sin tags, playwright'],
  ['f5-tags-error.http', 'atrezzo/flows/inject/f5-tags-error.yaml', 'f5-tags-error', 'declared-error', [], 'campo: error 500 declarado en /api/tags'],
  ['f5-null-author.playwright', 'atrezzo/flows/inject/f5-null-author.yaml', 'f5-null-author', 'null-field', ['render'], 'campo: 3 artículos sin autor, la vista lee author.username y revienta'],
  ['f5-feed-page-style.http', 'atrezzo/flows/inject/f5-feed-page-style.yaml', 'f5-feed-page-style', null, ['undeclared-filter'], 'campo: paginación por página declarada, el cliente manda offset (ignorado), http'],
  ['f5-feed-page-style.playwright', 'atrezzo/flows/inject/f5-feed-page-style.yaml', 'f5-feed-page-style', null, ['undeclared-filter'], 'campo: offset ignorado, playwright'],
  ['f5-comments-envelope.http', 'atrezzo/flows/inject/f5-comments-envelope.yaml', 'f5-comments-envelope', null, [], 'campo: el sobre de comments usa data y el cliente lee comments, http'],
  ['f5-comments-envelope.playwright', 'atrezzo/flows/inject/f5-comments-envelope.yaml', 'f5-comments-envelope', null, [], 'campo: sobre con la clave equivocada, playwright'],
];

function extractItems(body, pick) {
  let v = body;
  if (pick) for (const k of pick.split('.')) v = v?.[k];
  else if (v && !Array.isArray(v) && Array.isArray(v.data)) v = v.data;
  if (Array.isArray(v)) return v;
  return v === undefined || v === null ? [] : [v];
}
const unpaginated = (p) => { const u = new URL(p, 'http://x'); for (const k of ['limit', 'offset', 'page', 'per_page', 'pageSize', 'skip', 'take']) u.searchParams.delete(k); return u.pathname + (u.search || ''); };
const get = async (p) => { const r = await fetch(url + p); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, headers: Object.fromEntries(r.headers), body: b }; };
const sig = (hs) => hs.map((h) => `${h.certainty}:${h.type}`).join(',');
const KEEP_HEADERS = ['x-total-count', 'x-atrezzo-ignored', 'x-atrezzo-error'];

const out = [];
for (const [run, flowFile, scenario, cause, truths, note] of CASES) {
  const res = JSON.parse(readFileSync(join(runs, `${run}.json`), 'utf8'));
  const row = res.rows.find((r) => r.status === 'KO' && r.expect.data);
  const flowText = readFileSync(join(project, flowFile), 'utf8');
  const reqName = row.expect.data.request;
  const reqLine = flowText.split('\n').find((l) => l.trim().startsWith(`${reqName}: GET `));
  const path = reqLine.trim().slice(`${reqName}: GET `.length);
  await fetch(`${url}/__atrezzo/reset`, { method: 'POST', body: JSON.stringify({ scenario }) });
  const r = await get(path);
  const pick = row.expect.data.pick;
  const ctx = { response: { status: r.status, headers: r.headers, body: null }, query: new URLSearchParams(new URL(path, 'http://x').search) };
  ctx.items = r.status === 200 ? extractItems(r.body, pick) : [];
  ctx.matched = ctx.items.filter((it) => whereMatch(it, row.expect.data.where)).length;
  if (r.status === 200) { const f = await get(unpaginated(path)); if (f.status === 200) ctx.fullMatched = extractItems(f.body, pick).filter((it) => whereMatch(it, row.expect.data.where)).length; }
  if (res.driver === 'playwright') ctx.domCount = row.obtained;
  ctx.obtained = row.obtained;
  const want = sig(row.hypotheses ?? []);
  const got = sig(diagnose({ expect: row.expect }, ctx));
  // Trim: id + where keys + keys holding null + ignored query keys; headers only the ones diagnose reads.
  const ignored = String(header(r.headers, 'x-atrezzo-ignored') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const keys = new Set(['id', ...Object.keys(row.expect.data.where ?? {}), ...ignored]);
  const trimmed = ctx.items.map((it) => Object.fromEntries(Object.entries(it).filter(([k, v]) => keys.has(k) || v === null)));
  const tctx = { ...ctx, items: trimmed, response: { status: r.status, headers: Object.fromEntries(KEEP_HEADERS.filter((h) => r.headers[h] !== undefined).map((h) => [h, r.headers[h]])), body: r.status === 200 ? null : r.body } };
  delete tctx.query; delete tctx.obtained;
  const got2 = sig(diagnose({ expect: row.expect }, { ...tctx, query: ctx.query, obtained: ctx.obtained }));
  const okFidelity = want === got && got === got2;
  console.error(`${okFidelity ? 'ok  ' : 'DIFF'} ${run}: verify=[${want}] diagnose=[${got}] trimmed=[${got2}]`);
  const { selector, count, min, max, label, data } = row.expect;
  out.push({ name: note, cause, truths, expect: { selector, ...(count !== undefined ? { count } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), data: { ...(data.where ? { where: data.where } : {}) } }, ctx: tctx, query: ctx.query.toString() });
}
console.log(JSON.stringify(out));
