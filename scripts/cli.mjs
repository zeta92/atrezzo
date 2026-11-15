#!/usr/bin/env node
// atrezzo CLI.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { AtrezzoError, EXIT } from './lib/errors.mjs';
import { loadConfig, runtimeList } from './lib/config.mjs';
import { loadScenario, loadFlow } from './lib/scenario.mjs';
import { generateWorld, checkIntegrity } from './lib/world.mjs';
import { writeGenerated } from './lib/codegen.mjs';
import { createMockServer } from './lib/serve.mjs';
import { runVerify, formatReport } from './lib/verify.mjs';
import { doctor } from './lib/doctor.mjs';
import { runInit } from './lib/init.mjs';
import { emitRuntimes, parseRuntimeList, rankRuntimes, SERVABLE, getAdapter } from './lib/runtimes/index.mjs';
import { detectWorkspace, projectContext } from './lib/project.mjs';
import { flowRequests } from './lib/flows.mjs';
import { runImport, formatImportReport, loadSpec } from './lib/openapi.mjs';
import { createMissStore, missesFile, hintFor, formatMisses } from './lib/misses.mjs';
import { parseHeaderArgs, headerLines } from './lib/headers.mjs';

const HELP = `atrezzo — API mocks from application states

Usage: atrezzo <command> [options]

Commands:
  init [--dir .] [--runtime auto|builtin|msw|supabase|prism|wiremock] [--front <path> --backend <path>] [--contract <spec>]
       [--install] [--force]
      Detects monorepo/front-back folders and the runtime (prints what it found, why, and the alternatives),
      then writes atrezzo.config.json. With two front ends or none, asks for --front/--backend (exit 2).
      --runtime takes several, comma-separated (msw,supabase). --install adds msw and yaml if missing.
  world <scenario.yaml> [--out <dir>]
      Generates the world and always writes <generatedDir>/<scenario>.json and runtime.mjs (source of truth);
      then whatever each configured runtime needs: msw handlers · supabase seed.sql/reset.sh ·
      prism <scenario>.openapi.yaml · wiremock mappings/ + __files/ · builtin nothing else.
  serve [--scenario <name>] [--port 4010] [--host 127.0.0.1] [--static <dir>] [--scenarios <dir>] [--runtime builtin]
        [--on-miss log|stub]
      HTTP server with the projections (builtin/msw runtimes). With another runtime it prints how to
      start it and exits with 2. Control: POST /__atrezzo/reset {"scenario":"x"}, POST /__atrezzo/reload,
      GET /__atrezzo/state, GET|DELETE /__atrezzo/misses. Anything outside the contract is recorded
      as a gap; --on-miss stub answers an empty 200 ([] or {}) with x-atrezzo-stub instead of 404.
  misses [--json] [--clear] [--dir .]
      Gaps seen by serve (routes the app requested that no scenario declares), with counts, state and
      what to do: import if the contract has the route, or the /atrezzo:gap skill.
  runtimes [--dir .]
      Lists the adapters, their score in this project, the reason and how to start each one.
  import [<openapi.yaml|json>] [--name api] [--base /api] [--format yaml|json] [--force]
      Infers a scenario from an OpenAPI spec (no argument: uses workspace.contract) and writes
      <scenariosDir>/<name>.yaml with a report: endpoints, envelopes, TODOs and ignored routes.
  verify <flow.yaml> [--url http://127.0.0.1:4010] [--driver http|playwright] [--header "Name: value"]… [--diagnose]
         [--no-reset] [--json]
      Runs the flow against the mock (or against the real app if the flow has no scenario) and compares.
      --header adds a header to every request (repeatable; it wins over the flow's headers). Use it for a
      session: the flow keeps only values safe to commit, and atrezzo reads no environment variable.
        --header "Cookie: $SESSION"   your shell fills in the value (visible in ps while verify runs)
        --header @-                   reads "Name: value" lines from stdin (nothing in ps or history):
                                      printf 'Cookie: %s\\n' "$SESSION" | atrezzo verify flow.yaml --header @-
      Cookie, Authorization and other secret-looking headers print as *** in the table, --json and errors.
      Playwright driver: playwright or playwright-core; system Chromium or ATREZZO_CHROME=/path.
  doctor [--dir .]
      What is installed, what is missing, and whether the config and scenarios are valid.

Exit codes: 0 OK · 1 assertion failed · 2 not verifiable (missing tool or mock) · 3 invalid input`;

const BOOLEAN = new Set(['install', 'force', 'diagnose', 'no-reset', 'json', 'help', 'clear']);
const REPEATABLE = new Set(['header']);

export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN.has(k)) { flags[k] = true; continue; }
    const v = inline ?? argv[++i];
    if (v === undefined || (inline === undefined && v.startsWith('--'))) throw new AtrezzoError(`Option --${k} needs a value`);
    if (REPEATABLE.has(k)) (flags[k] ??= []).push(v);
    else flags[k] = v;
  }
  return { cmd: pos.shift(), pos, flags };
}

const out = (s = '') => process.stdout.write(`${s}\n`);
// `atrezzo … | head` closes the pipe early: that is not an error.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0); throw e; });

function printRanking(ranking, chosen = []) {
  for (const r of ranking) {
    const mark = chosen.includes(r.id) ? '→' : ' ';
    out(`  ${mark} ${r.id.padEnd(9)} ${r.score}/3  ${r.reason || '—'}`);
  }
}

function cmdInit({ flags }) {
  const dir = resolve(flags.dir ?? '.');
  const r = runInit(dir, {
    force: !!flags.force, install: !!flags.install, log: out,
    runtime: flags.runtime ?? 'auto', front: flags.front, backend: flags.backend, contract: flags.contract,
  });
  out(`Project: ${dir}`);
  out('Layout:');
  for (const n of r.wsNotes) out(`  ${n}`);
  if (r.detected.candidates.length) {
    for (const c of r.detected.candidates) out(`    ${c.path.padEnd(18)} front ${c.front} · backend ${c.backend} · ${c.role}${c.reasons.length ? ` (${c.reasons.join(', ')})` : ''}`);
  }
  if (r.workspace) out(`  workspace: ${Object.entries(r.workspace).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  out(`  detected stack: ${r.info.stack}${r.info.dataLayer.length ? ` · data layer: ${r.info.dataLayer.join(', ')}` : ''}`);
  if (r.info.mocks.length) out(`  existing mocks: ${r.info.mocks.join(', ')}`);
  if (r.info.contracts.length) out(`  contracts: ${r.info.contracts.join(', ')}`);
  out(`  mock baseUrl: ${r.config.mock.baseUrl}${r.apiBase ? ` (${r.apiBase.source})` : ' (default: the front end declares no proxy or *_API_URL)'}`);
  out(`Runtime: ${r.runtime.ids.join(' + ')} — ${r.runtime.why}`);
  out('  scores (0 = no signals · 1 = possible · 2-3 = detected):');
  printRanking(r.runtime.ranking, r.runtime.ids);
  const alts = r.runtime.ranking.filter((x) => !r.runtime.ids.includes(x.id) && x.score >= 2);
  if (alts.length) out(`  alternatives with signals: ${alts.map((a) => a.id).join(', ')} → atrezzo init --force --runtime ${[...r.runtime.ids, alts[0].id].join(',')} to emit both`);
  else out('  change it with: atrezzo init --force --runtime <id>[,<id>]');
  for (const w of r.written) out(`  written: ${w}`);
  for (const s of r.skipped) out(`  unchanged: ${s}`);
  if (r.installed.length) out(`  installed: ${r.installed.join(', ')}`);
  else if (!flags.install) out('  dependencies: nothing installed (use --install for msw; serve does not need it)');
  if (r.workspace?.contract) out(`Next step: atrezzo import ${r.workspace.contract} (scenario from the contract), then atrezzo world.`);
  else out('Next step: create a scenario in atrezzo/scenarios/ (skill /atrezzo:scene) and run atrezzo world.');
  return EXIT.OK;
}

function writeEmitted(root, files) {
  for (const f of files) {
    const abs = resolve(root, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    if (f.mode) chmodSync(abs, f.mode);
  }
}

function cmdWorld({ pos, flags }) {
  if (!pos[0]) throw new AtrezzoError('Usage: atrezzo world <scenario.yaml>');
  const cfg = loadConfig(flags.dir ?? '.');
  const scenario = loadScenario(resolve(pos[0]));
  const dataset = generateWorld(scenario);
  const problems = checkIntegrity(dataset);
  if (problems.length) throw new AtrezzoError('Referential integrity broken (atrezzo bug, please report it)', { exitCode: EXIT.FAIL, issues: problems });
  const outDir = resolve(flags.out ?? join(cfg._dir, cfg.generatedDir));
  const files = writeGenerated(dataset, outDir, { handlers: false });
  const ids = runtimeList(cfg);
  const emitCfg = { ...cfg, generatedDir: relative(cfg._dir, outDir) || '.' };
  const requests = ids.includes('wiremock') ? flowRequests(cfg._dir, join(cfg._dir, cfg.scenariosDir), resolve(pos[0])).requests : [];
  const emitted = emitRuntimes(ids, { dataset, scenario, config: emitCfg, dir: cfg._dir, requests });
  for (const e of emitted) writeEmitted(cfg._dir, e.files);
  out(`World "${scenario.name}" · seed ${scenario.seed} · now ${scenario.now} · hash ${dataset.hash}`);
  out('Entities:');
  for (const spec of scenario.world) {
    const extra = [];
    if (spec.distribution) extra.push(Object.entries(spec.distribution.counts).map(([k, v]) => `${k}=${v}`).join(' '));
    if (spec.refs.length) extra.push(`→ ${spec.refs.join(', ')}`);
    if (Object.keys(spec.nulls).length) extra.push(`nulls: ${Object.entries(spec.nulls).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    out(`  ${spec.name.padEnd(12)} ${String(spec.count).padStart(5)}  ${extra.join(' · ')}`);
  }
  out('Endpoints covered:');
  for (const ep of scenario.endpoints) {
    const bits = [ep.entity];
    if (ep.filters.length) bits.push(`filters: ${ep.filters.join(',')}`);
    if (ep.pagination) bits.push(`pagination: ${ep.pagination.limit}/${ep.pagination.page ?? ep.pagination.offset}${ep.pagination.page ? ' (by page)' : ''}`);
    bits.push(`sort: ${ep.sort.map((s) => (s.dir === 'desc' ? '-' : '') + s.field).join(',')}`);
    if (ep.pick) bits.push(`envelope: ${ep.pick}`);
    out(`  GET ${ep.path}${ep.detail ? ` (+ ${ep.path}/:id)` : ''}  ${bits.join(' · ')}`);
  }
  out('Written:');
  for (const f of Object.values(files)) out(`  ${relative(process.cwd(), f) || f}`);
  for (const e of emitted) {
    const shown = e.files.length > 8 ? e.files.filter((f) => !f.path.includes('/__files/')).slice(0, 8) : e.files;
    for (const f of shown) out(`  ${relative(process.cwd(), resolve(cfg._dir, f.path))}`);
    if (shown.length < e.files.length) out(`  … and ${e.files.length - shown.length} more files (${e.id})`);
  }
  for (const e of emitted) {
    out(`Runtime ${e.id}:`);
    out(`  start: ${e.start}`);
    for (const n of e.notes) out(`  note: ${n}`);
  }
  if (cfg._missing) out('(no atrezzo.config.json: msw runtime for 0.1 compatibility; run atrezzo init to choose one)');
  return EXIT.OK;
}

async function cmdServe({ flags }) {
  const cfg = loadConfig(flags.dir ?? '.');
  const ids = flags.runtime ? parseRuntimeList(flags.runtime) : runtimeList(cfg);
  if (!ids.some((id) => SERVABLE.includes(id))) {
    const name = flags.scenario ?? '<scenario>';
    out(`atrezzo serve serves the builtin and msw runtimes; the config uses ${ids.join(' + ')}.`);
    for (const id of ids) out(`  ${id}: ${getAdapter(id).meta.startHint.replaceAll('<scenario>', name).replaceAll('<project>', cfg._dir)}`);
    out('  (run atrezzo world <scenario.yaml> first to generate its files)');
    out('  to serve anyway with the built-in server: atrezzo serve --runtime builtin');
    return EXIT.UNVERIFIABLE;
  }
  const scenariosDir = resolve(flags.scenarios ?? join(cfg._dir, cfg.scenariosDir));
  const staticDir = flags.static ?? (cfg.mock.static ? join(cfg._dir, cfg.mock.static) : null);
  const port = Number(flags.port ?? cfg.mock.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AtrezzoError(`invalid --port: ${flags.port}`);
  const mock = createMockServer({
    scenariosDir, scenario: flags.scenario, staticDir: staticDir && resolve(staticDir),
    generatedDir: join(cfg._dir, cfg.generatedDir), log: (s) => out(`  ${s}`),
    missesFile: missesFile(cfg), onMiss: flags['on-miss'] ?? 'log',
  });
  let addr;
  try { addr = await mock.listen(port, flags.host ?? '127.0.0.1'); } catch (e) {
    throw new AtrezzoError(`Cannot listen on port ${port}: ${e.code ?? e.message}`, { exitCode: EXIT.UNVERIFIABLE });
  }
  const d = mock.state.dataset;
  out(`atrezzo serve · scenario "${d.scenario}" (seed ${d.seed}) · http://${addr.address}:${addr.port}`);
  for (const ep of d.endpoints) out(`  GET ${ep.path}`);
  out('  POST /__atrezzo/reset  ·  POST /__atrezzo/reload  ·  GET /__atrezzo/state  ·  GET|DELETE /__atrezzo/misses');
  if (staticDir) out(`  static: ${resolve(staticDir)}`);
  out(`  gaps: ${relative(process.cwd(), missesFile(cfg)) || missesFile(cfg)} (--on-miss ${flags['on-miss'] ?? 'log'})`);
  const stop = () => mock.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return new Promise(() => {}); // run until killed
}

async function cmdVerify({ pos, flags }) {
  if (!pos[0]) throw new AtrezzoError('Usage: atrezzo verify <flow.yaml> [--driver http|playwright]');
  const cfg = loadConfig(flags.dir ?? '.');
  const flow = loadFlow(resolve(pos[0]));
  const driver = flags.driver ?? cfg.verify.driver;
  if (!['http', 'playwright'].includes(driver)) throw new AtrezzoError(`--driver must be http or playwright (got "${driver}")`);
  const url = flags.url ?? flow.baseUrl ?? cfg.mock.baseUrl;
  // --header @- takes the header lines from stdin, so the value never sits in argv (ps) or history.
  const items = (flags.header ?? []).flatMap((h) => (h === '@-' ? headerLines(readFileSync(0, 'utf8')) : [h]));
  if (flags.header?.includes('@-') && !items.length) throw new AtrezzoError('--header @-: stdin had no "Name: value" line');
  const headers = parseHeaderArgs(items);
  const result = await runVerify(flow, { url, driver, headers, diagnose: !!flags.diagnose, reset: !flags['no-reset'], cwd: cfg._dir });
  out(flags.json ? JSON.stringify(result, null, 2) : formatReport(result));
  return result.exitCode;
}

function cmdRuntimes({ flags }) {
  const dir = resolve(flags.dir ?? '.');
  let cfg = null;
  try { cfg = loadConfig(dir); } catch { /* invalid config: still list */ }
  let ws = cfg && !cfg._missing ? cfg.workspace ?? {} : null;
  let wsNote = ws ? 'workspace from atrezzo.config.json' : '';
  if (!ws) {
    const d = detectWorkspace(dir);
    ws = d.ambiguous ? {} : { front: d.front ?? undefined, backend: d.backend ?? undefined };
    wsNote = d.ambiguous ? `ambiguous workspace (${d.ambiguous}): only the root is inspected` : d.notes[0];
  }
  const ctx = projectContext(dir, ws);
  const configured = cfg && !cfg._missing ? runtimeList(cfg) : [];
  out(`atrezzo runtimes · ${dir}`);
  out(`  ${wsNote}${configured.length ? ` · configured: ${configured.join(' + ')}` : ' · no config (atrezzo init)'}`);
  for (const r of rankRuntimes(ctx)) {
    const state = r.score >= 2 ? 'detected' : r.score === 1 ? 'possible' : 'no signals';
    out(`  ${configured.includes(r.id) ? '→' : ' '} ${r.id.padEnd(9)} ${r.score}/3 ${state.padEnd(11)} ${r.label}`);
    out(`      why: ${r.reason || '—'}`);
    out(`      start: ${r.startHint}`);
  }
  return EXIT.OK;
}

function cmdImport({ pos, flags }) {
  const cfg = loadConfig(flags.dir ?? '.');
  const spec = pos[0] ? resolve(pos[0]) : cfg.workspace?.contract ? join(cfg._dir, cfg.workspace.contract) : null;
  if (!spec) throw new AtrezzoError('Usage: atrezzo import <openapi.yaml|json> [--name api] [--base /api] (or set workspace.contract with atrezzo init --contract)');
  const r = runImport(spec, {
    name: flags.name ?? 'api', base: flags.base, format: flags.format ?? 'yaml', force: !!flags.force,
    outDir: join(cfg._dir, cfg.scenariosDir), apiPrefix: cfg.mock.apiPrefix ?? null,
  });
  out(formatImportReport(r.result, r.written));
  if (r.written.valid) out(`Next step: atrezzo world ${r.written.path}`);
  return r.written.valid ? EXIT.OK : EXIT.INVALID;
}

function cmdMisses({ flags }) {
  const cfg = loadConfig(flags.dir ?? '.');
  const store = createMissStore(missesFile(cfg));
  if (flags.clear) {
    const n = store.list().length;
    store.clear();
    out(flags.json ? JSON.stringify({ misses: [], unresolved: 0, cleared: n }) : `${n} ${n === 1 ? 'gap' : 'gaps'} cleared (${relative(process.cwd(), store.file) || store.file}).`);
    return EXIT.OK;
  }
  const list = store.list();
  if (flags.json) {
    out(JSON.stringify({ misses: list, unresolved: list.filter((m) => !m.resolved).length }, null, 2));
    return EXIT.OK;
  }
  let spec = null;
  const contract = cfg.workspace?.contract ?? null;
  const notes = [];
  if (contract) {
    try { spec = loadSpec(join(cfg._dir, contract)); } catch (e) { notes.push(`contract ${contract} unreadable: ${e.message.split('\n')[0]}`); }
  }
  const scenarios = [];
  const sdir = join(cfg._dir, cfg.scenariosDir);
  if (existsSync(sdir)) {
    for (const f of readdirSync(sdir).filter((x) => /\.(ya?ml|json)$/.test(x)).sort()) {
      try { scenarios.push(loadScenario(join(sdir, f))); } catch { /* doctor reports invalid scenarios */ }
    }
  }
  const hints = new Map(list.filter((m) => !m.resolved).map((m) => [m, hintFor(m, { spec, contract, scenarios })]));
  out(`atrezzo misses · ${relative(process.cwd(), store.file) || store.file}${contract ? ` · contract: ${contract}` : ' · no workspace.contract'}`);
  out(formatMisses(list, hints));
  for (const n of notes) out(`  warning: ${n}`);
  if (hints.size) out('Details per gap (query, referer, accept): atrezzo misses --json · clear: atrezzo misses --clear');
  return EXIT.OK;
}

function cmdDoctor({ flags }) {
  const dir = resolve(flags.dir ?? '.');
  const r = doctor(dir);
  const icon = { ok: 'OK   ', warn: 'WARN ', error: 'ERROR', info: '·    ' };
  out(`atrezzo doctor · ${dir}`);
  for (const c of r.checks) out(`  ${icon[c.level]} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  out(r.ok ? 'Everything essential is in order.' : 'There are blocking errors; fix them above.');
  return r.ok ? EXIT.OK : EXIT.INVALID;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (!args.cmd || args.flags.help || args.cmd === 'help') { out(HELP); return EXIT.OK; }
  const cmds = { init: cmdInit, world: cmdWorld, serve: cmdServe, verify: cmdVerify, doctor: cmdDoctor, runtimes: cmdRuntimes, import: cmdImport, misses: cmdMisses };
  const fn = cmds[args.cmd];
  if (!fn) throw new AtrezzoError(`Unknown command "${args.cmd}". Commands: ${Object.keys(cmds).join(', ')}`);
  return fn(args);
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => {
    if (e instanceof AtrezzoError) { process.stderr.write(`atrezzo: ${e.message}\n`); process.exitCode = e.exitCode; }
    else { process.stderr.write(`atrezzo: unexpected error: ${e.stack}\n`); process.exitCode = 70; }
  },
);
