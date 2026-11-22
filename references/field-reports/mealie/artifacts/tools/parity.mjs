import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// Ensure msw resolves from /tmp/f5-msw/node_modules
const { setupServer } = await import('/tmp/f5-msw/node_modules/msw/lib/node/index.mjs');
const mod = await import('/tmp/mealie-msw-run/atrezzo/.generated/kitchen.handlers.mjs');
const { handlers, reset } = mod;

// Start dedicated serve on port 4011 so we do not touch 4010
const srv = spawn(process.execPath, [
  '/root/work/atrezzo/scripts/cli.mjs', 'serve',
  '--scenario', 'kitchen', '--port', '4011',
], { cwd: '/root/work/field-mealie', stdio: ['ignore', 'pipe', 'pipe'] });

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('serve timeout')), 8000);
  srv.stdout.on('data', (d) => {
    if (String(d).includes('http://127.0.0.1:4011')) { clearTimeout(t); resolve(); }
  });
  srv.on('exit', (c) => { clearTimeout(t); reject(new Error('serve exited ' + c)); });
});

const REQUESTS = [
  { name: 'GET /api/app/about', method: 'GET', path: '/api/app/about' },
  { name: 'GET /api/app/about/theme', method: 'GET', path: '/api/app/about/theme' },
  { name: 'GET /api/users/self ($user.id)', method: 'GET', path: '/api/users/self' },
  { name: 'GET /api/groups/self ($user.group_id + embed)', method: 'GET', path: '/api/groups/self' },
  { name: 'GET /api/explore/groups/home/recipes?page=1&perPage=5&orderBy=name&orderDirection=asc', method: 'GET', path: '/api/explore/groups/home/recipes?page=1&perPage=5&orderBy=name&orderDirection=asc' },
  { name: 'GET /api/explore/groups/home/recipes?page=2&perPage=5', method: 'GET', path: '/api/explore/groups/home/recipes?page=2&perPage=5' },
  { name: 'GET /api/explore/groups/home/recipes?cookbook=weeknight', method: 'GET', path: '/api/explore/groups/home/recipes?cookbook=weeknight' },
  { name: 'GET /api/explore/groups/home/recipes/pasta-carbonara (passthrough+patch)', method: 'GET', path: '/api/explore/groups/home/recipes/pasta-carbonara' },
  { name: 'GET /api/explore/groups/home/recipes/tomato-soup (world object+embed)', method: 'GET', path: '/api/explore/groups/home/recipes/tomato-soup' },
  { name: 'GET /api/explore/groups/home/cookbooks/weeknight', method: 'GET', path: '/api/explore/groups/home/cookbooks/weeknight' },
  { name: 'GET /api/explore/groups/home/organizers/tags?page=1&perPage=-1 (ignored)', method: 'GET', path: '/api/explore/groups/home/organizers/tags?page=1&perPage=-1' },
  { name: 'GET /api/recipes?page=1&perPage=-1 (400 error)', method: 'GET', path: '/api/recipes?page=1&perPage=-1' },
  { name: 'GET /api/recipes?page=1&perPage=4 (counts+embed)', method: 'GET', path: '/api/recipes?page=1&perPage=4' },
  { name: 'GET /api/admin/groups (embed+counts)', method: 'GET', path: '/api/admin/groups' },
  { name: 'GET /api/admin/users?group_id=1 (include)', method: 'GET', path: '/api/admin/users?group_id=1' },
  { name: 'GET /api/foods?label_id=1 (include)', method: 'GET', path: '/api/foods?label_id=1' },
  { name: 'HEAD /api/recipes (HEAD count)', method: 'HEAD', path: '/api/recipes', headers: { Prefer: 'count=exact' } },
  { name: 'DELETE /api/foods/1 (undeclared write -> 405)', method: 'DELETE', path: '/api/foods/1' },
  { name: 'POST /api/organizers/tags (create)', method: 'POST', path: '/api/organizers/tags', body: { name: 'Spicy', slug: 'spicy', groupSlug: 'home', recipeCount: 1, group_id: 1, recipe_id: 1 } },
  { name: 'GET /api/organizers/tags (after create)', method: 'GET', path: '/api/organizers/tags' },
  { name: 'PUT /api/organizers/tags/7 (update)', method: 'PUT', path: '/api/organizers/tags/7', body: { name: 'Extra Spicy' } },
  { name: 'DELETE /api/organizers/tags/7 (delete)', method: 'DELETE', path: '/api/organizers/tags/7' },
  { name: 'DELETE /api/admin/groups/1 (FK conflict -> 409)', method: 'DELETE', path: '/api/admin/groups/1' },
  { name: 'POST /api/foods (bad FK -> 422)', method: 'POST', path: '/api/foods', body: { name: 'Saffron', group_id: 1, label_id: 999, groupSlug: 'home', recipeCount: 0, description: 'spice' } },
  { name: 'POST /api/comments ($user.id set)', method: 'POST', path: '/api/comments', body: { recipe_id: 1, text: 'Great!', createdAt: '2026-11-22T12:00:00Z', updatedAt: '2026-11-22T12:00:00Z' } },
  { name: 'PATCH /api/recipes/pasta-carbonara (slug update)', method: 'PATCH', path: '/api/recipes/pasta-carbonara', body: { rating: 2 } },
  { name: 'GET /api/recipes/pasta-carbonara (after patch + comment)', method: 'GET', path: '/api/recipes/pasta-carbonara' },
];

async function runBatch(base) {
  const out = [];
  for (const r of REQUESTS) {
    const res = await fetch(base + r.path, {
      method: r.method,
      headers: { ...(r.body ? { 'content-type': 'application/json' } : {}), ...(r.headers || {}) },
      body: r.body ? JSON.stringify(r.body) : undefined,
    });
    const text = await res.text();
    out.push({
      name: r.name,
      status: res.status,
      totalCount: res.headers.get('x-total-count'),
      contentRange: res.headers.get('content-range'),
      ignored: res.headers.get('x-atrezzo-ignored'),
      allow: res.headers.get('allow'),
      body: text,
    });
  }
  return out;
}

const serveRes = await runBatch('http://127.0.0.1:4011');
srv.kill();

// Now run against real msw/node
const mswServer = setupServer(...handlers);
mswServer.listen({ onUnhandledRequest: 'error' });
reset();
const mswRes = await runBatch('http://127.0.0.1:4011');
mswServer.close();

let diffs = 0;
for (let i = 0; i < REQUESTS.length; i++) {
  const a = serveRes[i], b = mswRes[i];
  const d = [];
  for (const k of ['status', 'totalCount', 'contentRange', 'ignored', 'allow', 'body']) {
    if (a[k] !== b[k]) d.push(`${k}: serve=${JSON.stringify(a[k])} vs msw=${JSON.stringify(b[k])}`);
  }
  if (d.length) {
    diffs++;
    console.log(`DIFF [${i+1}] ${a.name}:\n  ${d.join('\n  ')}`);
  } else {
    console.log(`OK   [${i+1}] ${a.name} (${a.status})`);
  }
}
console.log(`\nTotal: ${REQUESTS.length} requests, ${diffs} differences`);
