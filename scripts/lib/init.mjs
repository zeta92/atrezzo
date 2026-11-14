// `atrezzo init`: detect layout (monorepo / folders / single), choose the runtime,
// write config and folders; optionally install dependencies. Every decision is
// returned with its reason so the CLI can print it. Never a silent choice.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONFIG_FILE, DEFAULT_CONFIG } from './config.mjs';
import { AtrezzoError, EXIT } from './errors.mjs';
import { detectProject } from './doctor.mjs';
import { candidatesTable, detectApiBase, detectWorkspace, findSpec, projectContext } from './project.mjs';
import { chooseRuntime, parseRuntimeList, rankRuntimes } from './runtimes/index.mjs';
import { handlersDir as mswHandlersDir } from './runtimes/msw.mjs';

const handlersIndex = (importBase) => `// Entry point for atrezzo's MSW handlers.
// \`atrezzo world\` writes the <scenario>.handlers.mjs modules; this file only picks one.
// Browser:    const { handlers } = await loadScenario('my-scenario'); setupWorker(...handlers).start();
// Node tests: setupServer(...(await loadScenario('my-scenario')).handlers).listen();
export async function loadScenario(name) {
  return import(\`${importBase}\${name}.handlers.mjs\`);
}
`;

const relPath = (root, abs) => relative(root, abs).split(sep).join('/') || '.';

function checkDir(root, flag, value) {
  const abs = resolve(root, value);
  if (!existsSync(abs)) throw new AtrezzoError(`--${flag} ${value}: does not exist (${abs})`);
  return relPath(root, abs);
}

/** Resolve front/backend/contract from flags or detection. Throws (exit 2) if ambiguous. */
export function resolveWorkspace(dir, { front, backend, contract } = {}) {
  const explicit = front !== undefined || backend !== undefined;
  const detected = detectWorkspace(dir);
  const notes = [...detected.notes];
  let ws = null;
  const ambiguityError = (what) => new AtrezzoError([
    `Not choosing for you: ${what}.`,
    `Layout: ${detected.notes[0]}`,
    candidatesTable(detected.candidates),
    'Name the front end and the backend: atrezzo init --front <path> --backend <path> [--contract <spec>]',
  ].join('\n'), { exitCode: EXIT.UNVERIFIABLE });
  if (explicit && front === undefined && detected.kind !== 'simple' && !detected.front) {
    throw ambiguityError(`you passed --backend but not --front, and ${detected.ambiguous ?? 'there is no single front end'}`);
  }
  if (explicit) {
    ws = {
      front: front !== undefined ? checkDir(dir, 'front', front) : (detected.front ?? '.'),
      backend: backend !== undefined ? checkDir(dir, 'backend', backend) : detected.backend,
    };
    notes.push(`explicit workspace: --front ${ws.front}${ws.backend ? ` --backend ${ws.backend}` : ''}`);
    if (front === undefined) notes.push(detected.front ? `detected front end: ${detected.front}` : 'no --front: using the root');
    if (backend === undefined) notes.push(detected.backend ? `detected backend: ${detected.backend}` : 'no --backend and no single candidate: backend left undefined');
  } else if (detected.kind !== 'simple') {
    if (detected.ambiguous) throw ambiguityError(detected.ambiguous);
    ws = { front: detected.front, backend: detected.backend };
  }
  if (contract !== undefined) {
    if (!existsSync(resolve(dir, contract))) throw new AtrezzoError(`--contract ${contract}: does not exist`);
    ws = { front: ws?.front ?? '.', backend: ws?.backend ?? null, ...ws, contract: relPath(dir, resolve(dir, contract)) };
  } else {
    const spec = (ws?.backend && findSpec(resolve(dir, ws.backend))) || findSpec(dir);
    if (spec) { ws = { ...ws, contract: relPath(dir, spec) }; notes.push(`contract found: ${ws.contract} (use it with: atrezzo import)`); }
  }
  if (ws) for (const k of Object.keys(ws)) if (ws[k] === null || ws[k] === undefined) delete ws[k];
  return { workspace: ws, detected, notes };
}

/**
 * @returns {{ written: string[], skipped: string[], info: object, installed: string[],
 *   workspace: object|null, wsNotes: string[], detected: object, runtime: { ids: string[], why: string, ranking: object[] }, apiBase: object|null, config: object }}
 */
export function runInit(dir, { force = false, install = false, log = () => {}, runtime = 'auto', front, backend, contract } = {}) {
  if (!existsSync(dir)) throw new AtrezzoError(`Directory ${dir} does not exist`);
  const requested = parseRuntimeList(runtime);
  const { workspace, detected, notes: wsNotes } = resolveWorkspace(dir, { front, backend, contract });
  const frontAbs = workspace?.front ? resolve(dir, workspace.front) : dir;
  const info = detectProject(frontAbs);
  const ctx = projectContext(dir, workspace ?? {});

  let rt;
  if (requested[0] === 'auto') {
    const c = chooseRuntime(ctx);
    rt = { ids: [c.id], why: c.why, ranking: c.ranking, tied: c.tied, auto: true };
  } else {
    rt = { ids: requested, why: `chosen with --runtime ${requested.join(',')}`, ranking: rankRuntimes(ctx), tied: [], auto: false };
  }

  const apiBase = detectApiBase(frontAbs, dir);
  const cfg = {
    ...DEFAULT_CONFIG,
    stack: info.stack,
    runtime: rt.ids.length === 1 ? rt.ids[0] : rt.ids,
    ...(workspace ? { workspace } : {}),
    mock: { ...DEFAULT_CONFIG.mock },
  };
  if (apiBase?.baseUrl) {
    const u = new URL(apiBase.baseUrl);
    cfg.mock.baseUrl = apiBase.baseUrl;
    cfg.mock.port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  }
  if (apiBase?.prefix) cfg.mock.apiPrefix = apiBase.prefix;
  const mswInFront = rt.ids.includes('msw') && workspace?.front && workspace.front !== '.';
  if (mswInFront) cfg.handlersDir = mswHandlersDir(cfg);

  const written = [];
  const skipped = [];
  const cfgFile = join(dir, CONFIG_FILE);
  if (existsSync(cfgFile) && !force) skipped.push(`${CONFIG_FILE} (already exists; use --force to overwrite)`);
  else { writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`); written.push(CONFIG_FILE); }

  for (const d of [cfg.scenariosDir, cfg.handlersDir]) {
    if (existsSync(join(dir, d))) skipped.push(`${d}/ (already exists)`);
    else { mkdirSync(join(dir, d), { recursive: true }); written.push(`${d}/`); }
  }
  const idx = join(dir, cfg.handlersDir, 'index.mjs');
  if (!existsSync(idx)) {
    writeFileSync(idx, handlersIndex(mswInFront ? './' : '../.generated/'));
    written.push(`${cfg.handlersDir}/index.mjs`);
  }

  const installed = [];
  if (install) {
    if (!info.hasPackageJson) throw new AtrezzoError('--install needs a package.json in the project (or in the front end)');
    const missing = ['msw'].filter((m) => !Object.hasOwn(info.deps, m));
    if (missing.length) {
      const args = { npm: ['install', '-D'], pnpm: ['add', '-D'], yarn: ['add', '-D'], bun: ['add', '-d'] }[info.packageManager];
      log(`Installing ${missing.join(', ')} with ${info.packageManager} ${args.join(' ')} in ${relPath(dir, frontAbs)} …`);
      const r = spawnSync(info.packageManager, [...args, ...missing], { cwd: frontAbs, stdio: 'inherit' });
      if (r.status !== 0) throw new AtrezzoError(`Installation failed (${info.packageManager} exited with ${r.status ?? r.error?.message})`, { exitCode: 2 });
      installed.push(...missing);
    }
  }
  return { written, skipped, info, installed, workspace, wsNotes, detected, runtime: rt, apiBase, config: cfg };
}
