// `atrezzo init`: write config and folders; optionally install dependencies.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONFIG_FILE, DEFAULT_CONFIG } from './config.mjs';
import { AtrezzoError } from './errors.mjs';
import { detectProject } from './doctor.mjs';

const HANDLERS_INDEX = `// Punto de entrada de los handlers de atrezzo para MSW.
// Los módulos de .generated/ los escribe \`atrezzo world\`; aquí solo se eligen.
// Uso (navegador):  const { handlers } = await loadScenario('mi-escenario'); setupWorker(...handlers).start();
// Uso (tests node): setupServer(...(await loadScenario('mi-escenario')).handlers).listen();
export async function loadScenario(name) {
  return import(\`../.generated/\${name}.handlers.mjs\`);
}
`;

/**
 * @returns {{ written: string[], skipped: string[], info: object, installed: string[] }}
 */
export function runInit(dir, { force = false, install = false, log = () => {} } = {}) {
  if (!existsSync(dir)) throw new AtrezzoError(`El directorio ${dir} no existe`);
  const info = detectProject(dir);
  const written = [];
  const skipped = [];
  const cfgFile = join(dir, CONFIG_FILE);
  const cfg = { ...DEFAULT_CONFIG, stack: info.stack };
  if (existsSync(cfgFile) && !force) skipped.push(`${CONFIG_FILE} (ya existe; usa --force para sobrescribir)`);
  else { writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`); written.push(CONFIG_FILE); }

  for (const d of [cfg.scenariosDir, cfg.handlersDir]) {
    if (existsSync(join(dir, d))) skipped.push(`${d}/ (ya existe)`);
    else { mkdirSync(join(dir, d), { recursive: true }); written.push(`${d}/`); }
  }
  const idx = join(dir, cfg.handlersDir, 'index.mjs');
  if (!existsSync(idx)) { writeFileSync(idx, HANDLERS_INDEX); written.push(`${cfg.handlersDir}/index.mjs`); }

  const installed = [];
  if (install) {
    if (!info.hasPackageJson) throw new AtrezzoError('--install necesita un package.json en el proyecto');
    const missing = ['msw', 'yaml'].filter((m) => !Object.hasOwn(info.deps, m));
    if (missing.length) {
      const args = { npm: ['install', '-D'], pnpm: ['add', '-D'], yarn: ['add', '-D'], bun: ['add', '-d'] }[info.packageManager];
      log(`Instalando ${missing.join(', ')} con ${info.packageManager} ${args.join(' ')} …`);
      const r = spawnSync(info.packageManager, [...args, ...missing], { cwd: dir, stdio: 'inherit' });
      if (r.status !== 0) throw new AtrezzoError(`La instalación falló (${info.packageManager} salió con ${r.status ?? r.error?.message})`, { exitCode: 2 });
      installed.push(...missing);
    }
  }
  return { written, skipped, info, installed };
}
