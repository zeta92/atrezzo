// Project inspection: stack detection (for init) and health report (doctor).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { CONFIG_FILE, loadConfig } from './config.mjs';
import { loadScenario } from './scenario.mjs';
import { generateWorld } from './world.mjs';

function readPkg(dir) {
  const f = join(dir, 'package.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

export function detectProject(dir) {
  const pkg = readPkg(dir);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const has = (n) => Object.hasOwn(deps, n);
  let stack = 'otro';
  if (has('next')) stack = 'next';
  else if (has('vite')) stack = 'vite';
  else if (has('express')) stack = 'express';
  const dataLayer = ['@supabase/supabase-js', 'axios', '@tanstack/react-query', 'swr', '@apollo/client', 'graphql', 'ky', '@trpc/client'].filter(has);
  const mocks = ['msw', 'json-server', 'miragejs', 'nock', '@mswjs/data', '@stoplight/prism-cli'].filter(has);
  for (const d of ['mocks', 'src/mocks', '__mocks__', 'wiremock', 'supabase']) if (existsSync(join(dir, d))) mocks.push(`dir:${d}`);
  const contracts = [];
  for (const f of ['openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.json', 'api/openapi.yaml', 'docs/openapi.yaml', 'supabase/migrations', 'src/types/database.ts', 'schema.graphql']) {
    if (existsSync(join(dir, f))) contracts.push(f);
  }
  let pm = 'npm';
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) pm = 'pnpm';
  else if (existsSync(join(dir, 'yarn.lock'))) pm = 'yarn';
  else if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) pm = 'bun';
  return { hasPackageJson: !!pkg, stack, dataLayer, mocks, contracts, packageManager: pm, deps };
}

function resolvable(dir, mod) {
  try { createRequire(join(dir, 'package.json')).resolve(mod); return true; } catch { return false; }
}

/** Returns { checks: [{ok, label, detail}], ok } — ok=false if any blocking check fails. */
export function doctor(dir) {
  const checks = [];
  const add = (level, label, detail = '') => checks.push({ level, label, detail });
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22 ? 'ok' : 'error', `Node ${process.versions.node}`, major >= 22 ? '' : 'se necesita Node >= 22');

  const info = detectProject(dir);
  add('info', `stack: ${info.stack}`, info.hasPackageJson ? `gestor: ${info.packageManager}` : 'sin package.json');
  if (info.dataLayer.length) add('info', `capa de datos: ${info.dataLayer.join(', ')}`);
  if (info.contracts.length) add('info', `contratos encontrados: ${info.contracts.join(', ')}`);
  if (info.mocks.length) add('info', `mocks existentes: ${info.mocks.join(', ')}`);

  let cfg = null;
  try {
    cfg = loadConfig(dir);
    if (cfg._missing) add('warn', `${CONFIG_FILE} no existe`, 'ejecuta: atrezzo init');
    else add('ok', `${CONFIG_FILE} válido`);
  } catch (e) {
    add('error', `${CONFIG_FILE} inválido`, e.message);
  }

  for (const [mod, why] of [['msw', 'handlers en el navegador/tests (opcional: serve no lo necesita)'], ['playwright', 'driver playwright de verify (opcional)']]) {
    add(resolvable(dir, mod) ? 'ok' : 'warn', `${mod} ${resolvable(dir, mod) ? 'instalado' : 'no instalado'}`, why);
  }

  if (cfg && !cfg._missing) {
    const sdir = join(dir, cfg.scenariosDir);
    if (!existsSync(sdir)) add('error', `falta ${cfg.scenariosDir}`, 'ejecuta: atrezzo init');
    else {
      const files = readdirSync(sdir).filter((f) => /\.ya?ml$/.test(f)).sort();
      if (!files.length) add('warn', `sin escenarios en ${cfg.scenariosDir}`, 'usa /atrezzo:escena');
      for (const f of files) {
        try {
          const sc = loadScenario(join(sdir, f));
          const ds = generateWorld(sc);
          const gen = join(dir, cfg.generatedDir, `${sc.name}.json`);
          let state = 'sin generar';
          if (existsSync(gen)) state = JSON.parse(readFileSync(gen, 'utf8')).hash === ds.hash ? 'generado al día' : 'generado DESACTUALIZADO (atrezzo world)';
          add(state === 'generado al día' ? 'ok' : 'warn', `escenario ${f}`, state);
        } catch (e) {
          add('error', `escenario ${f} inválido`, e.message);
        }
      }
    }
  }
  return { checks, ok: !checks.some((c) => c.level === 'error'), info };
}
