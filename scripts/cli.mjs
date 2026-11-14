#!/usr/bin/env node
// atrezzo CLI. Messages in Spanish; code in English.
import { resolve, join, relative } from 'node:path';
import { AtrezzoError, EXIT } from './lib/errors.mjs';
import { loadConfig } from './lib/config.mjs';
import { loadScenario, loadFlow } from './lib/scenario.mjs';
import { generateWorld, checkIntegrity } from './lib/world.mjs';
import { writeGenerated } from './lib/codegen.mjs';
import { createMockServer } from './lib/serve.mjs';
import { runVerify, formatReport } from './lib/verify.mjs';
import { doctor } from './lib/doctor.mjs';
import { runInit } from './lib/init.mjs';

const HELP = `atrezzo — mocks de API a partir de estados de aplicación

Uso: atrezzo <comando> [opciones]

Comandos:
  init [--dir .] [--install] [--force]
      Detecta el stack, escribe atrezzo.config.json y crea atrezzo/escenarios y atrezzo/handlers.
      --install instala msw y yaml si faltan (lo anuncia antes). Nunca pisa la config sin --force.
  world <escenario.yaml> [--out <dir>]
      Genera el mundo con la semilla y escribe <generatedDir>/<escenario>.json,
      <escenario>.handlers.mjs (MSW) y runtime.mjs (motor de proyección).
  serve [--escenario <nombre>] [--port 4010] [--host 127.0.0.1] [--static <dir>] [--escenarios <dir>]
      Servidor HTTP con las proyecciones. Control: POST /__atrezzo/reset {"escenario":"x"},
      GET /__atrezzo/state.
  verify <flujo.yaml> [--url http://127.0.0.1:4010] [--driver http|playwright] [--diagnose] [--no-reset] [--json]
      Ejecuta el flujo contra el mock y compara con las aserciones.
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

function cmdInit({ flags }) {
  const dir = resolve(flags.dir ?? '.');
  const r = runInit(dir, { force: !!flags.force, install: !!flags.install, log: out });
  out(`Proyecto: ${dir}`);
  out(`  stack detectado: ${r.info.stack}${r.info.dataLayer.length ? ` · capa de datos: ${r.info.dataLayer.join(', ')}` : ''}`);
  if (r.info.mocks.length) out(`  mocks existentes: ${r.info.mocks.join(', ')}`);
  if (r.info.contracts.length) out(`  contratos: ${r.info.contracts.join(', ')}`);
  for (const w of r.written) out(`  escrito: ${w}`);
  for (const s of r.skipped) out(`  sin cambios: ${s}`);
  if (r.installed.length) out(`  instalado: ${r.installed.join(', ')}`);
  else if (!flags.install) out('  dependencias: no se ha instalado nada (usa --install para msw y yaml; serve no las necesita)');
  out('Siguiente paso: crea un escenario en atrezzo/escenarios/ (skill /atrezzo:escena) y ejecuta atrezzo world.');
  return EXIT.OK;
}

function cmdWorld({ pos, flags }) {
  if (!pos[0]) throw new AtrezzoError('Uso: atrezzo world <escenario.yaml>');
  const cfg = loadConfig(flags.dir ?? '.');
  const scenario = loadScenario(resolve(pos[0]));
  const dataset = generateWorld(scenario);
  const problems = checkIntegrity(dataset);
  if (problems.length) throw new AtrezzoError('Integridad referencial rota (bug de atrezzo, repórtalo)', { exitCode: EXIT.FAIL, issues: problems });
  const outDir = resolve(flags.out ?? join(cfg._dir, cfg.generatedDir));
  const files = writeGenerated(dataset, outDir);
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
    if (ep.pagination) bits.push(`paginación: ${ep.pagination.limit}/${ep.pagination.offset}`);
    bits.push(`orden: ${ep.sort.map((s) => (s.dir === 'desc' ? '-' : '') + s.field).join(',')}`);
    out(`  GET ${ep.path}${ep.detail ? ` (+ ${ep.path}/:id)` : ''}  ${bits.join(' · ')}`);
  }
  out('Escrito:');
  for (const f of Object.values(files)) out(`  ${relative(process.cwd(), f) || f}`);
  return EXIT.OK;
}

async function cmdServe({ flags }) {
  const cfg = loadConfig(flags.dir ?? '.');
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
  const cmds = { init: cmdInit, world: cmdWorld, serve: cmdServe, verify: cmdVerify, doctor: cmdDoctor };
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
