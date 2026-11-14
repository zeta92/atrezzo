#!/usr/bin/env node
// atrezzo CLI. Messages in Spanish; code in English.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { runImport, formatImportReport } from './lib/openapi.mjs';

const HELP = `atrezzo — mocks de API a partir de estados de aplicación

Uso: atrezzo <comando> [opciones]

Comandos:
  init [--dir .] [--runtime auto|builtin|msw|supabase|prism|wiremock] [--front <ruta> --backend <ruta>] [--contract <spec>]
       [--install] [--force]
      Detecta monorepo/carpetas front-back, el runtime (imprime qué encontró, por qué y las alternativas)
      y escribe atrezzo.config.json. Si hay dos fronts o ninguno, pide --front/--backend (exit 2).
      --runtime acepta varios separados por coma (msw,supabase). --install instala msw y yaml si faltan.
  world <escenario.yaml> [--out <dir>]
      Genera el mundo y escribe siempre <generatedDir>/<escenario>.json y runtime.mjs (fuente de verdad);
      después, lo de cada runtime de la config: msw handlers · supabase seed.sql/reset.sh ·
      prism <escenario>.openapi.yaml · wiremock mappings/ + __files/ · builtin nada más.
  serve [--escenario <nombre>] [--port 4010] [--host 127.0.0.1] [--static <dir>] [--escenarios <dir>] [--runtime builtin]
      Servidor HTTP con las proyecciones (runtimes builtin/msw). Con otro runtime imprime cómo
      arrancarlo y sale con 2. Control: POST /__atrezzo/reset {"escenario":"x"}, GET /__atrezzo/state.
  runtimes [--dir .]
      Lista los adaptadores, su puntuación en este proyecto, el motivo y cómo se arrancan.
  import [<openapi.yaml|json>] [--name api] [--base /api] [--format yaml|json] [--force]
      Infiere un escenario desde un OpenAPI (sin argumento usa workspace.contract) y escribe
      <escenariosDir>/<name>.yaml con un informe: endpoints, envoltorios, TODO y rutas ignoradas.
  verify <flujo.yaml> [--url http://127.0.0.1:4010] [--driver http|playwright] [--diagnose] [--no-reset] [--json]
      Ejecuta el flujo contra el mock (o contra la app real si el flujo no tiene escenario) y compara.
      El flujo puede declarar headers (\${VAR} desde el entorno; Cookie/Authorization salen como ***).
      Driver playwright: playwright o playwright-core; Chromium del sistema o ATREZZO_CHROME=/ruta.
  doctor [--dir .]
      Qué hay instalado, qué falta y si la config y los escenarios son válidos.

Códigos de salida: 0 OK · 1 aserción fallida · 2 no verificable (falta herramienta o mock) · 3 entrada inválida`;

const BOOLEAN = new Set(['install', 'force', 'diagnose', 'no-reset', 'json', 'help']);

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
    if (v === undefined || (inline === undefined && v.startsWith('--'))) throw new AtrezzoError(`La opción --${k} necesita un valor`);
    flags[k] = v;
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
  out(`Proyecto: ${dir}`);
  out('Estructura:');
  for (const n of r.wsNotes) out(`  ${n}`);
  if (r.detected.candidates.length) {
    for (const c of r.detected.candidates) out(`    ${c.path.padEnd(18)} front ${c.front} · backend ${c.backend} · ${c.role}${c.reasons.length ? ` (${c.reasons.join(', ')})` : ''}`);
  }
  if (r.workspace) out(`  workspace: ${Object.entries(r.workspace).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  out(`  stack detectado: ${r.info.stack}${r.info.dataLayer.length ? ` · capa de datos: ${r.info.dataLayer.join(', ')}` : ''}`);
  if (r.info.mocks.length) out(`  mocks existentes: ${r.info.mocks.join(', ')}`);
  if (r.info.contracts.length) out(`  contratos: ${r.info.contracts.join(', ')}`);
  out(`  baseUrl del mock: ${r.config.mock.baseUrl}${r.apiBase ? ` (${r.apiBase.source})` : ' (por defecto: el front no declara proxy ni *_API_URL)'}`);
  out(`Runtime: ${r.runtime.ids.join(' + ')} — ${r.runtime.why}`);
  out('  puntuaciones (0 = sin señales · 1 = posible · 2-3 = detectado):');
  printRanking(r.runtime.ranking, r.runtime.ids);
  const alts = r.runtime.ranking.filter((x) => !r.runtime.ids.includes(x.id) && x.score >= 2);
  if (alts.length) out(`  alternativas con señales: ${alts.map((a) => a.id).join(', ')} → atrezzo init --force --runtime ${[...r.runtime.ids, alts[0].id].join(',')} para emitir ambos`);
  else out('  cambia con: atrezzo init --force --runtime <id>[,<id>]');
  for (const w of r.written) out(`  escrito: ${w}`);
  for (const s of r.skipped) out(`  sin cambios: ${s}`);
  if (r.installed.length) out(`  instalado: ${r.installed.join(', ')}`);
  else if (!flags.install) out('  dependencias: no se ha instalado nada (usa --install para msw y yaml; serve no las necesita)');
  if (r.workspace?.contract) out(`Siguiente paso: atrezzo import ${r.workspace.contract} (escenario desde el contrato) y atrezzo world.`);
  else out('Siguiente paso: crea un escenario en atrezzo/escenarios/ (skill /atrezzo:escena) y ejecuta atrezzo world.');
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
  if (!pos[0]) throw new AtrezzoError('Uso: atrezzo world <escenario.yaml>');
  const cfg = loadConfig(flags.dir ?? '.');
  const scenario = loadScenario(resolve(pos[0]));
  const dataset = generateWorld(scenario);
  const problems = checkIntegrity(dataset);
  if (problems.length) throw new AtrezzoError('Integridad referencial rota (bug de atrezzo, repórtalo)', { exitCode: EXIT.FAIL, issues: problems });
  const outDir = resolve(flags.out ?? join(cfg._dir, cfg.generatedDir));
  const files = writeGenerated(dataset, outDir, { handlers: false });
  const ids = runtimeList(cfg);
  const emitCfg = { ...cfg, generatedDir: relative(cfg._dir, outDir) || '.' };
  const requests = ids.includes('wiremock') ? flowRequests(cfg._dir, join(cfg._dir, cfg.scenariosDir), resolve(pos[0])).requests : [];
  const emitted = emitRuntimes(ids, { dataset, scenario, config: emitCfg, dir: cfg._dir, requests });
  for (const e of emitted) writeEmitted(cfg._dir, e.files);
  out(`Mundo "${scenario.name}" · semilla ${scenario.seed} · now ${scenario.now} · hash ${dataset.hash}`);
  out('Entidades:');
  for (const spec of scenario.world) {
    const extra = [];
    if (spec.distribution) extra.push(Object.entries(spec.distribution.counts).map(([k, v]) => `${k}=${v}`).join(' '));
    if (spec.refs.length) extra.push(`→ ${spec.refs.join(', ')}`);
    if (Object.keys(spec.nulls).length) extra.push(`nulos: ${Object.entries(spec.nulls).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    out(`  ${spec.name.padEnd(12)} ${String(spec.count).padStart(5)}  ${extra.join(' · ')}`);
  }
  out('Endpoints cubiertos:');
  for (const ep of scenario.endpoints) {
    const bits = [ep.entity];
    if (ep.filters.length) bits.push(`filtros: ${ep.filters.join(',')}`);
    if (ep.pagination) bits.push(`paginación: ${ep.pagination.limit}/${ep.pagination.page ?? ep.pagination.offset}${ep.pagination.page ? ' (por página)' : ''}`);
    bits.push(`orden: ${ep.sort.map((s) => (s.dir === 'desc' ? '-' : '') + s.field).join(',')}`);
    if (ep.pick) bits.push(`envoltorio: ${ep.pick}`);
    out(`  GET ${ep.path}${ep.detail ? ` (+ ${ep.path}/:id)` : ''}  ${bits.join(' · ')}`);
  }
  out('Escrito:');
  for (const f of Object.values(files)) out(`  ${relative(process.cwd(), f) || f}`);
  for (const e of emitted) {
    const shown = e.files.length > 8 ? e.files.filter((f) => !f.path.includes('/__files/')).slice(0, 8) : e.files;
    for (const f of shown) out(`  ${relative(process.cwd(), resolve(cfg._dir, f.path))}`);
    if (shown.length < e.files.length) out(`  … y ${e.files.length - shown.length} ficheros más (${e.id})`);
  }
  for (const e of emitted) {
    out(`Runtime ${e.id}:`);
    out(`  arranque: ${e.start}`);
    for (const n of e.notes) out(`  nota: ${n}`);
  }
  if (cfg._missing) out('(sin atrezzo.config.json: runtime msw por compatibilidad con 0.1; ejecuta atrezzo init para elegirlo)');
  return EXIT.OK;
}

async function cmdServe({ flags }) {
  const cfg = loadConfig(flags.dir ?? '.');
  const ids = flags.runtime ? parseRuntimeList(flags.runtime) : runtimeList(cfg);
  if (!ids.some((id) => SERVABLE.includes(id))) {
    const name = flags.escenario ?? '<escenario>';
    out(`atrezzo serve sirve los runtimes builtin y msw; la config usa ${ids.join(' + ')}.`);
    for (const id of ids) out(`  ${id}: ${getAdapter(id).meta.startHint.replaceAll('<escenario>', name)}`);
    out('  (ejecuta antes atrezzo world <escenario.yaml> para generar sus ficheros)');
    out('  para servir igualmente con el servidor propio: atrezzo serve --runtime builtin');
    return EXIT.UNVERIFIABLE;
  }
  const scenariosDir = resolve(flags.escenarios ?? join(cfg._dir, cfg.scenariosDir));
  const staticDir = flags.static ?? (cfg.mock.static ? join(cfg._dir, cfg.mock.static) : null);
  const port = Number(flags.port ?? cfg.mock.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AtrezzoError(`--port inválido: ${flags.port}`);
  const mock = createMockServer({
    scenariosDir, scenario: flags.escenario, staticDir: staticDir && resolve(staticDir),
    generatedDir: join(cfg._dir, cfg.generatedDir), log: (s) => out(`  ${s}`),
  });
  let addr;
  try { addr = await mock.listen(port, flags.host ?? '127.0.0.1'); } catch (e) {
    throw new AtrezzoError(`No se puede escuchar en el puerto ${port}: ${e.code ?? e.message}`, { exitCode: EXIT.UNVERIFIABLE });
  }
  const d = mock.state.dataset;
  out(`atrezzo serve · escenario "${d.scenario}" (semilla ${d.seed}) · http://${addr.address}:${addr.port}`);
  for (const ep of d.endpoints) out(`  GET ${ep.path}`);
  out('  POST /__atrezzo/reset  ·  GET /__atrezzo/state');
  if (staticDir) out(`  estáticos: ${resolve(staticDir)}`);
  const stop = () => mock.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return new Promise(() => {}); // run until killed
}

async function cmdVerify({ pos, flags }) {
  if (!pos[0]) throw new AtrezzoError('Uso: atrezzo verify <flujo.yaml> [--driver http|playwright]');
  const cfg = loadConfig(flags.dir ?? '.');
  const flow = loadFlow(resolve(pos[0]));
  const driver = flags.driver ?? cfg.verify.driver;
  if (!['http', 'playwright'].includes(driver)) throw new AtrezzoError(`--driver debe ser http o playwright (es "${driver}")`);
  const url = flags.url ?? flow.baseUrl ?? cfg.mock.baseUrl;
  const result = await runVerify(flow, { url, driver, diagnose: !!flags.diagnose, reset: !flags['no-reset'], cwd: cfg._dir });
  out(flags.json ? JSON.stringify(result, null, 2) : formatReport(result));
  return result.exitCode;
}

function cmdRuntimes({ flags }) {
  const dir = resolve(flags.dir ?? '.');
  let cfg = null;
  try { cfg = loadConfig(dir); } catch { /* invalid config: still list */ }
  let ws = cfg && !cfg._missing ? cfg.workspace ?? {} : null;
  let wsNote = ws ? 'workspace de atrezzo.config.json' : '';
  if (!ws) {
    const d = detectWorkspace(dir);
    ws = d.ambiguous ? {} : { front: d.front ?? undefined, backend: d.backend ?? undefined };
    wsNote = d.ambiguous ? `workspace ambiguo (${d.ambiguous}): solo se mira la raíz` : d.notes[0];
  }
  const ctx = projectContext(dir, ws);
  const configured = cfg && !cfg._missing ? runtimeList(cfg) : [];
  out(`atrezzo runtimes · ${dir}`);
  out(`  ${wsNote}${configured.length ? ` · configurado: ${configured.join(' + ')}` : ' · sin config (atrezzo init)'}`);
  for (const r of rankRuntimes(ctx)) {
    const state = r.score >= 2 ? 'detectado' : r.score === 1 ? 'posible' : 'sin señales';
    out(`  ${configured.includes(r.id) ? '→' : ' '} ${r.id.padEnd(9)} ${r.score}/3 ${state.padEnd(11)} ${r.label}`);
    out(`      por qué: ${r.reason || '—'}`);
    out(`      arranque: ${r.startHint}`);
  }
  return EXIT.OK;
}

function cmdImport({ pos, flags }) {
  const cfg = loadConfig(flags.dir ?? '.');
  const spec = pos[0] ? resolve(pos[0]) : cfg.workspace?.contract ? join(cfg._dir, cfg.workspace.contract) : null;
  if (!spec) throw new AtrezzoError('Uso: atrezzo import <openapi.yaml|json> [--name api] [--base /api] (o define workspace.contract con atrezzo init --contract)');
  const r = runImport(spec, {
    name: flags.name ?? 'api', base: flags.base, format: flags.format ?? 'yaml', force: !!flags.force,
    outDir: join(cfg._dir, cfg.scenariosDir), apiPrefix: cfg.mock.apiPrefix ?? null,
  });
  out(formatImportReport(r.result, r.written));
  if (r.written.valid) out(`Siguiente paso: atrezzo world ${r.written.path}`);
  return r.written.valid ? EXIT.OK : EXIT.INVALID;
}

function cmdDoctor({ flags }) {
  const dir = resolve(flags.dir ?? '.');
  const r = doctor(dir);
  const icon = { ok: 'OK  ', warn: 'AVISO', error: 'ERROR', info: '·   ' };
  out(`atrezzo doctor · ${dir}`);
  for (const c of r.checks) out(`  ${icon[c.level]} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  out(r.ok ? 'Todo lo imprescindible está en orden.' : 'Hay errores que impiden trabajar; corrígelos arriba.');
  return r.ok ? EXIT.OK : EXIT.INVALID;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (!args.cmd || args.flags.help || args.cmd === 'help') { out(HELP); return EXIT.OK; }
  const cmds = { init: cmdInit, world: cmdWorld, serve: cmdServe, verify: cmdVerify, doctor: cmdDoctor, runtimes: cmdRuntimes, import: cmdImport };
  const fn = cmds[args.cmd];
  if (!fn) throw new AtrezzoError(`Comando desconocido "${args.cmd}". Comandos: ${Object.keys(cmds).join(', ')}`);
  return fn(args);
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => {
    if (e instanceof AtrezzoError) { process.stderr.write(`atrezzo: ${e.message}\n`); process.exitCode = e.exitCode; }
    else { process.stderr.write(`atrezzo: error inesperado: ${e.stack}\n`); process.exitCode = 70; }
  },
);
