// Runtime registry: score every adapter against the project, choose, emit.
import * as builtin from './builtin.mjs';
import * as msw from './msw.mjs';
import * as supabase from './supabase.mjs';
import * as prism from './prism.mjs';
import * as wiremock from './wiremock.mjs';
import { AtrezzoError } from '../errors.mjs';

/** Tie-break priority (first wins on equal score). builtin beats prism on a bare
 * spec (score 1 each): an OpenAPI file is a contract, not proof the team runs Prism. */
export const PRIORITY = ['msw', 'supabase', 'wiremock', 'builtin', 'prism'];
export const RUNTIME_IDS = ['builtin', 'msw', 'supabase', 'prism', 'wiremock'];
const ADAPTERS = { builtin, msw, supabase, prism, wiremock };

export function getAdapter(id) {
  const a = ADAPTERS[id];
  if (!a) throw new AtrezzoError(`runtime desconocido "${id}" (hay: ${RUNTIME_IDS.join(', ')})`);
  return a;
}

/** Parse "--runtime msw,supabase" / config value into a validated list. */
export function parseRuntimeList(value) {
  const list = (Array.isArray(value) ? value : String(value).split(',')).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) throw new AtrezzoError('runtime vacío');
  for (const id of list) if (!ADAPTERS[id] && id !== 'auto') throw new AtrezzoError(`--runtime: "${id}" no existe (opciones: auto, ${RUNTIME_IDS.join(', ')})`);
  if (list.includes('auto') && list.length > 1) throw new AtrezzoError('--runtime auto no se combina con otros');
  return [...new Set(list)];
}

/** Every adapter with score, reason and start hint, best first. */
export function rankRuntimes(ctx) {
  return PRIORITY.map((id) => {
    const { meta } = ADAPTERS[id];
    return { id, label: meta.label, score: meta.detect(ctx), reason: meta.describe(ctx), needsOpenapi: meta.needsOpenapi, startHint: meta.startHint };
  }).sort((a, b) => b.score - a.score || PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id));
}

/** Choose with `auto`: highest score, ties by PRIORITY. Returns the ranking and why. */
export function chooseRuntime(ctx) {
  const ranking = rankRuntimes(ctx);
  const best = ranking[0];
  const tied = ranking.filter((r) => r.score === best.score && r.id !== best.id);
  let why = `puntuación ${best.score}/3: ${best.reason}`;
  if (tied.length) why += ` · empate con ${tied.map((t) => t.id).join(', ')}; desempate por prioridad fija (${PRIORITY.join(' > ')})`;
  return { id: best.id, why, ranking, tied: tied.map((t) => t.id) };
}

/**
 * Emit artifacts for one or more runtimes.
 * @returns {{ id: string, files: {path, content, mode?}[], start: string, notes: string[] }[]}
 */
export function emitRuntimes(ids, args) {
  return ids.map((id) => ({ id, ...getAdapter(id).emit(args) }));
}

export const SERVABLE = ['builtin', 'msw'];
