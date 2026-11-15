// Project inspection for v0.2: workspace layout (monorepo / sibling folders /
// two repos), front-end API base, contract files, and the context the runtime
// adapters score against. Pure reads; never writes. Every decision carries its
// reason so `init` can print *why*.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { parseYaml } from './yaml.mjs';

export function readPkg(dir) {
  const f = join(dir, 'package.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const rel = (root, abs) => relative(root, abs).split(sep).join('/') || '.';

export const UI_DEPS = ['react', 'react-dom', 'vue', 'svelte', '@sveltejs/kit', 'next', 'nuxt', 'vite', '@angular/core', 'solid-js', 'preact', 'astro', '@remix-run/react'];
export const SERVER_DEPS = ['express', 'fastify', '@nestjs/core', 'hono', 'koa', '@hapi/hapi', '@prisma/client', 'prisma', '@supabase/supabase-js', 'drizzle-orm', 'typeorm', 'sequelize'];
const FRONT_FILES = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'next.config.js', 'next.config.mjs', 'next.config.ts', 'angular.json', 'svelte.config.js', 'nuxt.config.ts', 'index.html'];
const NON_JS_BACKEND = ['requirements.txt', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Cargo.toml', 'Gemfile', 'composer.json'];
export const SPEC_FILES = ['openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.yml', 'swagger.json',
  'api/openapi.yaml', 'api/openapi.json', 'docs/openapi.yaml', 'docs/openapi.json', 'spec/openapi.yaml', 'spec/openapi.json'];
const FRONT_NAMES = ['client', 'web', 'frontend', 'front', 'app', 'ui'];
const BACK_NAMES = ['server', 'api', 'backend', 'back'];

export function findSpec(dir) {
  return SPEC_FILES.map((f) => join(dir, f)).find((f) => existsSync(f)) ?? null;
}

/** Score a folder as front-end and/or backend. */
export function classifyPackage(abs) {
  const pkg = readPkg(abs);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const front = [];
  const backend = [];
  for (const d of UI_DEPS) if (Object.hasOwn(deps, d)) front.push(`dep ${d}`);
  for (const f of FRONT_FILES) if (existsSync(join(abs, f))) { front.push(f); break; }
  for (const d of SERVER_DEPS) if (Object.hasOwn(deps, d)) backend.push(`dep ${d}`);
  const spec = findSpec(abs);
  if (spec) backend.push(relative(abs, spec), relative(abs, spec)); // strong signal: counts double
  if (isDir(join(abs, 'supabase'))) backend.push('supabase/', 'supabase/');
  for (const f of NON_JS_BACKEND) if (existsSync(join(abs, f))) { backend.push(`${f} (non-JS backend)`); break; }
  const name = basename(abs).toLowerCase();
  if (FRONT_NAMES.includes(name)) front.push(`name "${name}"`);
  if (BACK_NAMES.includes(name)) backend.push(`name "${name}"`);
  const fs = front.length;
  const bs = backend.length;
  const role = fs === 0 && bs === 0 ? 'none' : fs > bs ? 'front' : bs > fs ? 'backend' : 'tie';
  return { front: fs, backend: bs, role, reasons: [...new Set([...front, ...backend])] };
}

/** Expand workspace globs: "apps/*", "packages/**", "services/api", "!x". */
function expandGlobs(root, patterns) {
  const out = new Set();
  const neg = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1).replace(/\/$/, ''));
  for (const raw of patterns) {
    if (raw.startsWith('!')) continue;
    const p = raw.replace(/^\.\//, '').replace(/\/$/, '');
    if (p.endsWith('/**') || p.endsWith('/*')) {
      const base = join(root, p.replace(/\/\*\*?$/, ''));
      if (!isDir(base)) continue;
      const deep = p.endsWith('/**');
      const walk = (d, depth) => {
        for (const e of readdirSync(d).sort()) {
          if (e === 'node_modules' || e.startsWith('.')) continue;
          const abs = join(d, e);
          if (!isDir(abs)) continue;
          if (!deep || existsSync(join(abs, 'package.json'))) out.add(abs);
          if (deep && depth < 3) walk(abs, depth + 1);
        }
      };
      walk(base, 1);
    } else if (!p.includes('*') && isDir(join(root, p))) out.add(join(root, p));
  }
  const excluded = (r) => neg.some((n) => (n.endsWith('*') ? r.startsWith(`${n.replace(/\/\*+$/, '')}/`) : r === n));
  return [...out].filter((abs) => !excluded(rel(root, abs)));
}

/** Which monorepo manifest (if any) and the package patterns it declares. */
export function monorepoManifest(root) {
  const found = [];
  let patterns = null;
  const pnpm = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    found.push('pnpm-workspace.yaml');
    try { patterns = parseYaml(readFileSync(pnpm, 'utf8'), pnpm)?.packages ?? null; } catch { /* reported as no patterns */ }
  }
  const pkg = readPkg(root);
  if (pkg?.workspaces) {
    found.push('package.json#workspaces');
    patterns ??= Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages ?? null;
  }
  const lerna = join(root, 'lerna.json');
  if (existsSync(lerna)) {
    found.push('lerna.json');
    try { patterns ??= JSON.parse(readFileSync(lerna, 'utf8')).packages ?? ['packages/*']; } catch { patterns ??= ['packages/*']; }
  }
  for (const f of ['turbo.json', 'nx.json']) if (existsSync(join(root, f))) found.push(f);
  if (!found.length) return null;
  return { files: found, patterns: Array.isArray(patterns) && patterns.length ? patterns.map(String) : ['apps/*', 'packages/*', 'libs/*', 'services/*'], defaulted: !Array.isArray(patterns) };
}

/**
 * Detect front/backend layout under `root`.
 * @returns {{ kind: 'monorepo'|'folders'|'simple', manifest: object|null, candidates: object[],
 *   front: string|null, backend: string|null, ambiguous: string|null, notes: string[] }}
 *   front/backend are paths relative to root ('.' for a single project).
 */
export function detectWorkspace(root) {
  const notes = [];
  const manifest = monorepoManifest(root);
  let dirs = [];
  let kind = 'simple';
  if (manifest) {
    kind = 'monorepo';
    dirs = expandGlobs(root, manifest.patterns);
    notes.push(`monorepo: ${manifest.files.join(', ')} · packages from ${manifest.defaulted ? 'default patterns (apps/*, packages/*, libs/*, services/*)' : manifest.patterns.join(', ')}`);
  } else {
    const named = [...FRONT_NAMES, ...BACK_NAMES].map((n) => join(root, n)).filter(isDir);
    const hasFront = named.some((d) => FRONT_NAMES.includes(basename(d)));
    const hasBack = named.some((d) => BACK_NAMES.includes(basename(d)));
    if (hasFront && hasBack) {
      kind = 'folders';
      dirs = named;
      notes.push(`no monorepo manifest; sibling folders: ${named.map((d) => `${basename(d)}/`).join(' + ')}`);
    }
  }
  if (kind === 'simple') {
    return { kind, manifest: null, candidates: [], front: null, backend: null, ambiguous: null, notes: ['single project (no monorepo or front/back folders): everything lives at the root'] };
  }
  const candidates = dirs.map((abs) => ({ path: rel(root, abs), ...classifyPackage(abs) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const fronts = candidates.filter((c) => c.role === 'front');
  const backs = candidates.filter((c) => c.role === 'backend');
  let ambiguous = null;
  if (fronts.length !== 1) ambiguous = fronts.length ? `${fronts.length} front-end candidates (${fronts.map((c) => c.path).join(', ')})` : 'no front-end candidate';
  else if (backs.length > 1) ambiguous = `${backs.length} backend candidates (${backs.map((c) => c.path).join(', ')})`;
  for (const c of candidates.filter((x) => x.role === 'tie')) notes.push(`${c.path}: same score as front end and backend (${c.front}); not classified`);
  return {
    kind, manifest, candidates, ambiguous, notes,
    front: fronts.length === 1 ? fronts[0].path : null,
    backend: backs.length === 1 ? backs[0].path : null,
  };
}

/** Table of candidates for the terminal. */
export function candidatesTable(candidates) {
  const w = Math.max(8, ...candidates.map((c) => c.path.length));
  const rows = [`  ${'package'.padEnd(w)}  front  backend  role      reasons`];
  for (const c of candidates) rows.push(`  ${c.path.padEnd(w)}  ${String(c.front).padStart(5)}  ${String(c.backend).padStart(7)}  ${c.role.padEnd(8)}  ${c.reasons.join(', ') || '—'}`);
  return rows.join('\n');
}

const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.example'];
// Only the keys that say where the API lives reach memory; secrets in the same file are skipped unread.
const ENV_KEY = /(API|BASE|URL|HOST|PORT|ORIGIN)/i;
const API_ENV = ['NEXT_PUBLIC_API_URL', 'VITE_API_URL', 'VITE_API_BASE_URL', 'REACT_APP_API_URL', 'PUBLIC_API_URL', 'NUXT_PUBLIC_API_BASE'];

export function envKeys(dir) {
  const out = {};
  for (const f of ENV_FILES) {
    const text = readText(join(dir, f));
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && ENV_KEY.test(m[1]) && !(m[1] in out)) out[m[1]] = { file: f, value: m[2].trim().replace(/^['"]|['"]$/g, '') };
    }
  }
  return out;
}

/**
 * Where the front expects the API: Vite proxy target or *_API_URL env.
 * @returns {{ baseUrl: string|null, prefix: string|null, source: string } | null}
 */
export function detectApiBase(frontAbs, root) {
  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
    const text = readText(join(frontAbs, f));
    if (!text) continue;
    const m = /proxy\s*:\s*\{\s*['"]?(\/[\w./-]*)['"]?\s*:\s*(?:\{[^}]*?target\s*:\s*)?['"`](https?:\/\/[^'"`]+)['"`]/s.exec(text);
    if (m) return { baseUrl: new URL(m[2]).origin, prefix: m[1].replace(/\/$/, '') || null, source: `Vite proxy "${m[1]}" → ${m[2]} in ${rel(root, join(frontAbs, f))}` };
  }
  const env = envKeys(frontAbs);
  for (const k of API_ENV) {
    if (!env[k]?.value) continue;
    const v = env[k].value;
    if (/^https?:\/\//.test(v)) {
      const u = new URL(v);
      return { baseUrl: u.origin, prefix: u.pathname.replace(/\/$/, '') || null, source: `${k}=${v} in ${rel(root, join(frontAbs, env[k].file))}` };
    }
    if (v.startsWith('/')) return { baseUrl: null, prefix: v.replace(/\/$/, '') || null, source: `${k}=${v} in ${rel(root, join(frontAbs, env[k].file))} (relative: same origin as the front end)` };
  }
  return null;
}

/**
 * Context the runtime adapters score against. `workspace` = { front, backend, contract }
 * relative to root (any may be null).
 */
export function projectContext(root, workspace = {}) {
  const abs = (p) => (p ? resolve(root, p) : null);
  const places = [{ role: 'root', dir: root }];
  if (workspace.front && abs(workspace.front) !== root) places.push({ role: 'front', dir: abs(workspace.front) });
  if (workspace.backend && abs(workspace.backend) !== root && abs(workspace.backend) !== abs(workspace.front)) places.push({ role: 'backend', dir: abs(workspace.backend) });
  const label = (p) => (p.dir === root ? '' : `${rel(root, p.dir)}/`);
  const deps = {};
  const scripts = [];
  for (const p of places) {
    const pkg = readPkg(p.dir);
    for (const d of Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies })) (deps[d] ??= []).push(`${label(p)}package.json`);
    for (const [k, v] of Object.entries(pkg?.scripts ?? {})) scripts.push({ where: `${label(p)}package.json#scripts.${k}`, text: String(v) });
  }
  const files = (relPath) => places.filter((p) => existsSync(join(p.dir, relPath))).map((p) => `${label(p)}${relPath}`);
  const env = {};
  for (const p of places) for (const [k, v] of Object.entries(envKeys(p.dir))) env[k] ??= { ...v, file: `${label(p)}${v.file}` };
  const compose = [];
  for (const p of places) for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const t = readText(join(p.dir, f));
    if (t) compose.push({ where: `${label(p)}${f}`, text: t });
  }
  const specs = [];
  if (workspace.contract && existsSync(abs(workspace.contract))) specs.push(workspace.contract);
  for (const p of places) { const s = findSpec(p.dir); if (s && !specs.includes(rel(root, s))) specs.push(rel(root, s)); }
  return {
    root, workspace, places,
    dep: (name) => deps[name]?.[0] ?? null,
    depMatching: (re) => Object.keys(deps).filter((d) => re.test(d)).sort().map((d) => ({ name: d, where: deps[d][0] })),
    files, env, scripts, compose, specs,
  };
}
