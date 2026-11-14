// atrezzo.config.json loading and validation.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AtrezzoError } from './errors.mjs';

export const CONFIG_FILE = 'atrezzo.config.json';

export const DEFAULT_CONFIG = {
  version: 1,
  stack: 'otro',
  scenariosDir: 'atrezzo/escenarios',
  handlersDir: 'atrezzo/handlers',
  generatedDir: 'atrezzo/.generated',
  mock: { baseUrl: 'http://127.0.0.1:4010', port: 4010, static: null },
  verify: { driver: 'http' },
};

export function validateConfig(cfg) {
  const issues = [];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(cfg)) return ['la raíz debe ser un objeto JSON'];
  if (cfg.version !== 1) issues.push('campo "version": debe ser 1');
  for (const k of ['scenariosDir', 'handlersDir', 'generatedDir']) {
    if (typeof cfg[k] !== 'string' || !cfg[k]) issues.push(`campo "${k}": obligatorio, ruta relativa`);
  }
  if (!isObj(cfg.mock)) issues.push('campo "mock": obligatorio { baseUrl, port }');
  else {
    if (!Number.isInteger(cfg.mock.port) || cfg.mock.port <= 0 || cfg.mock.port > 65535) issues.push('campo "mock.port": entero entre 1 y 65535');
    try { new URL(cfg.mock.baseUrl); } catch { issues.push('campo "mock.baseUrl": URL inválida'); }
  }
  if (!isObj(cfg.verify) || !['http', 'playwright'].includes(cfg.verify.driver)) issues.push('campo "verify.driver": "http" o "playwright"');
  return issues;
}

/** Load config from `dir`. Missing file => defaults (flagged with `_missing`). */
export function loadConfig(dir = process.cwd()) {
  const file = join(resolve(dir), CONFIG_FILE);
  if (!existsSync(file)) return { ...DEFAULT_CONFIG, _dir: resolve(dir), _missing: true };
  let cfg;
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    throw new AtrezzoError(`${file}: JSON inválido: ${e.message}`);
  }
  const merged = { ...DEFAULT_CONFIG, ...cfg, mock: { ...DEFAULT_CONFIG.mock, ...cfg.mock }, verify: { ...DEFAULT_CONFIG.verify, ...cfg.verify } };
  const issues = validateConfig(merged);
  if (issues.length) throw new AtrezzoError(`${file}: configuración inválida`, { issues });
  return { ...merged, _dir: resolve(dir), _missing: false };
}
