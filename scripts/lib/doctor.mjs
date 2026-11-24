// Project inspection: stack detection (for init) and health report (doctor).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { CONFIG_FILE, loadConfig, runtimeList } from './config.mjs';
import { loadScenario } from './scenario.mjs';
import { generateWorld } from './world.mjs';
import { missesFile, readMisses } from './misses.mjs';
import { chromePath } from './env.mjs';
import { degradations, STATE_LABEL } from './capabilities.mjs';
import { DEFAULT_FIXTURES_DIR, resolveEffectiveDirs } from './passthrough.mjs';

function readPkg(dir) {
  const f = join(dir, 'package.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

export function detectProject(dir) {
  const pkg = readPkg(dir);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const has = (n) => Object.hasOwn(deps, n);
  let stack = 'other';
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
export function doctor(dir, { scenariosDir = null, fixturesDir = null } = {}) {
  const resolvedDir = resolve(dir);
  const checks = [];
  const add = (level, label, detail = '') => checks.push({ level, label, detail });
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22 ? 'ok' : 'error', `Node ${process.versions.node}`, major >= 22 ? '' : 'Node >= 22 is required');

  const info = detectProject(resolvedDir);
  add('info', `stack: ${info.stack}`, info.hasPackageJson ? `package manager: ${info.packageManager}` : 'no package.json');
  if (info.dataLayer.length) add('info', `data layer: ${info.dataLayer.join(', ')}`);
  if (info.contracts.length) add('info', `contracts found: ${info.contracts.join(', ')}`);
  if (info.mocks.length) add('info', `existing mocks: ${info.mocks.join(', ')}`);

  let cfg = null;
  try {
    cfg = loadConfig(resolvedDir);
    if (cfg._missing) add('warn', `${CONFIG_FILE} not found`, 'run: atrezzo init');
    else {
      add('ok', `${CONFIG_FILE} valid`);
      add('info', `runtime: ${[].concat(cfg.runtime).join(' + ')}${cfg.workspace ? ` · workspace: ${Object.entries(cfg.workspace).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`, 'details: atrezzo runtimes');
    }
  } catch (e) {
    add('error', `${CONFIG_FILE} invalid`, e.message);
  }

  add(resolvable(resolvedDir, 'msw') ? 'ok' : 'warn', `msw ${resolvable(resolvedDir, 'msw') ? 'installed' : 'not installed'}`, 'browser/test handlers (optional: serve does not need it)');
  const pwMod = ['playwright', '@playwright/test', 'playwright-core'].find((m) => resolvable(resolvedDir, m));
  add(pwMod ? 'ok' : 'warn', pwMod ? `${pwMod} installed` : 'playwright not installed', `verify playwright driver (optional)${pwMod === 'playwright-core' ? `; Chromium: ${chromePath() || '/usr/bin/chromium'}` : ''}`);

  const hasProjectConfig = Boolean(cfg && !cfg._missing);
  const hasScenariosOverride = scenariosDir !== null && scenariosDir !== undefined;
  const hasFixturesOverride = fixturesDir !== null && fixturesDir !== undefined;

  if (hasProjectConfig || hasScenariosOverride || hasFixturesOverride) {
    let effective = null;
    try {
      effective = resolveEffectiveDirs({
        // Pass the loaded config even when it is the `_missing` default so the default
        // scenariosDir/fixturesDir still resolve (e.g. `doctor --fixtures` with no config).
        cfg,
        dir: resolvedDir,
        scenarios: hasScenariosOverride ? scenariosDir : null,
        fixtures: hasFixturesOverride ? fixturesDir : null,
      });
    } catch (e) {
      add('error', 'bundle config invalid', e.message);
    }

    if (effective) {
      const { scenariosDir: sdir, fixturesDir: fdir, scenariosSource, fixturesSource } = effective;
      if (sdir) add('info', `scenarios: ${sdir}`, `from ${scenariosSource}`);
      if (fdir) add('info', `fixtures: ${fdir}`, `from ${fixturesSource}`);

      // Validate the effective fixtures directory. An explicit --fixtures that is missing/invalid
      // blocks; a custom project-config or bundle-config one only warns. The implicit default
      // (bundle discovery fallback, or a project config pointing at <config dir>/DEFAULT_FIXTURES_DIR)
      // is not diagnosed on its own: scenarios that consume fixtures still fail on their missing files.
      const isImplicitDefault = fixturesSource === 'bundle'
        || (fixturesSource === 'atrezzo.config.json'
          && fdir === resolve(cfg?._dir ?? resolvedDir, DEFAULT_FIXTURES_DIR));
      if (fdir && !isImplicitDefault) {
        const level = hasFixturesOverride ? 'error' : 'warn';
        if (!existsSync(fdir)) add(level, 'fixtures directory is missing', `${fdir} (from ${fixturesSource})`);
        else if (!statSync(fdir).isDirectory()) add(level, 'fixtures path is not a directory', `${fdir} (from ${fixturesSource})`);
      }

      if (sdir) {
        if (!existsSync(sdir)) {
          if (hasScenariosOverride) add('error', 'scenarios directory is missing', `${sdir} (from --scenarios)`);
          else add('error', `${cfg.scenariosDir} is missing`, 'run: atrezzo init');
        } else if (!statSync(sdir).isDirectory()) {
          add('error', 'scenarios path is not a directory', sdir);
        } else {
          const files = readdirSync(sdir).filter((f) => /\.(ya?ml|json)$/.test(f)).sort();
          if (!files.length) add('warn', `no scenarios in ${hasScenariosOverride ? sdir : cfg.scenariosDir}`, 'use /atrezzo:scene');
          for (const f of files) {
            try {
              const sc = loadScenario(join(sdir, f), { fixturesDir: fdir });
              const ds = generateWorld(sc);
              for (const ep of sc.endpoints ?? []) {
                const rows = ds.entities?.[ep.entity] ?? [];
                if (rows.length < 2) continue;
                for (const p of ep.params ?? []) {
                  if (!p.field) continue;
                  const distinct = new Set(rows.map((r) => r?.[p.field] ?? null));
                  if (distinct.size === 1) {
                    add('warn', `${sc.name}: endpoint "${ep.path}" binds ":${p.name}" to "${p.field}" with a single value across ${rows.length} rows`,
                      `the parameter cannot select one row (every row answers): give "${p.field}" several distinct values (values: [...]) or drop the parameter`);
                  }
                }
              }
              if (hasProjectConfig) {
                for (const rt of runtimeList(cfg).filter((r) => r !== 'builtin')) {
                  for (const d of degradations(sc, rt)) {
                    add('warn', `${sc.name} × ${rt}: ${d.id}`, `${STATE_LABEL[d.state]}${d.note ? ` — ${d.note}` : ''}`);
                  }
                }
                const gen = join(resolvedDir, cfg.generatedDir, `${sc.name}.json`);
                let state = 'not generated';
                if (existsSync(gen)) state = JSON.parse(readFileSync(gen, 'utf8')).hash === ds.hash ? 'generated, up to date' : 'generated, STALE (atrezzo world)';
                add(state === 'generated, up to date' ? 'ok' : 'warn', `scenario ${f}`, state);
              } else {
                add('ok', `scenario ${f}`, 'valid');
              }
            } catch (e) {
              add('error', `scenario ${f} invalid`, e.message);
            }
          }
        }
      }
    }
  }
  if (cfg) {
    const misses = readMisses(missesFile(cfg));
    const open = misses.filter((m) => !m.resolved);
    if (open.length) {
      const top = open.slice(0, 3).map((m) => `${m.method} ${m.path} (${m.times}×)`).join(', ');
      add('warn', `${open.length} unresolved gap${open.length === 1 ? '' : 's'} (of ${misses.length} recorded)`, `${top}${open.length > 3 ? ', …' : ''} → atrezzo misses · skill /atrezzo:gap`);
    } else if (misses.length) add('ok', `gaps: ${misses.length} recorded, all resolved`);
  }
  return { checks, ok: !checks.some((c) => c.level === 'error'), info };
}
