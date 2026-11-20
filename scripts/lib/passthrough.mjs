// Passthrough-and-patch: load frozen HTTP fixtures and apply dot-path patches
// without altering the rest of the captured response.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { AtrezzoError, EXIT } from './errors.mjs';
import { CONFIG_FILE, loadConfig } from './config.mjs';

export const DEFAULT_FIXTURES_DIR = 'atrezzo/fixtures';
export const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const FIXTURE_NAME_RE = /^[A-Za-z0-9._-]+$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Normalize a fixture name (strip optional trailing `.json`) and reject unsafe path characters. */
export function normalizeFixtureName(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const trimmed = raw.trim();
  const name = trimmed.endsWith('.json') ? trimmed.slice(0, -5) : trimmed;
  if (!name || name === '.' || name === '..' || name.includes('..') || !FIXTURE_NAME_RE.test(name)) return null;
  return name;
}

/**
 * Determine the fixtures directory for a scenario file when no explicit directory was given.
 * Checks `atrezzo.config.json` up to two parent levels, then sibling `atrezzo/fixtures` or `fixtures`.
 */
export function resolveFixturesDir(scenarioFile, explicitDir = null) {
  if (explicitDir) return resolve(explicitDir);
  if (!scenarioFile || scenarioFile.startsWith('<')) return resolve(DEFAULT_FIXTURES_DIR);

  const absFile = resolve(scenarioFile);
  const startDir = dirname(absFile);
  for (const candidate of [startDir, dirname(startDir), dirname(dirname(startDir))]) {
    if (existsSync(join(candidate, CONFIG_FILE))) {
      const cfg = loadConfig(candidate);
      return join(candidate, cfg.fixturesDir ?? DEFAULT_FIXTURES_DIR);
    }
  }

  if (basename(startDir) === 'scenarios') {
    const base = dirname(startDir);
    if (basename(base) === 'atrezzo') return join(base, 'fixtures');
    if (existsSync(join(base, 'atrezzo', 'fixtures'))) return join(base, 'atrezzo', 'fixtures');
    if (existsSync(join(base, 'fixtures'))) return join(base, 'fixtures');
    return join(base, DEFAULT_FIXTURES_DIR);
  }

  if (existsSync(join(startDir, 'fixtures')) && !existsSync(join(startDir, 'atrezzo', 'fixtures'))) {
    return join(startDir, 'fixtures');
  }
  return join(startDir, DEFAULT_FIXTURES_DIR);
}

export function fixtureFilePath(fixturesDir, fixtureName) {
  const norm = normalizeFixtureName(fixtureName);
  if (!norm) throw new AtrezzoError(`Invalid fixture name ${JSON.stringify(fixtureName)} (use letters, digits, ".", "_" or "-")`);
  return join(resolve(fixturesDir), `${norm}.json`);
}

export function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isObj(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneJson(v);
    return out;
  }
  return value;
}

/** Read and validate `<fixturesDir>/<fixtureName>.json` (`status`, `contentType`, `hasBody`, `body`). */
export function loadFixture(fixturesDir, fixtureName, endpointPath = '<endpoint>') {
  const filePath = fixtureFilePath(fixturesDir, fixtureName);
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new AtrezzoError(
        `endpoint "${endpointPath}": passthrough fixture "${fixtureName}" does not exist (expected ${filePath})`,
        { exitCode: EXIT.INVALID },
      );
    }
    throw new AtrezzoError(`Cannot read passthrough fixture ${filePath}: ${e.message}`, { exitCode: EXIT.INVALID });
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new AtrezzoError(`passthrough fixture "${fixtureName}" (${filePath}): invalid JSON: ${e.message}`, { exitCode: EXIT.INVALID });
  }

  if (!isObj(doc)) {
    throw new AtrezzoError(`passthrough fixture "${fixtureName}" (${filePath}): root must be a JSON object { status, contentType, body }`, { exitCode: EXIT.INVALID });
  }
  if (!Number.isInteger(doc.status) || doc.status < 100 || doc.status > 599) {
    throw new AtrezzoError(`passthrough fixture "${fixtureName}" (${filePath}): "status" must be an integer HTTP status (100..599)`, { exitCode: EXIT.INVALID });
  }
  if (Object.hasOwn(doc, 'hasBody') && typeof doc.hasBody !== 'boolean') {
    throw new AtrezzoError(`passthrough fixture "${fixtureName}" (${filePath}): "hasBody" must be a boolean`, { exitCode: EXIT.INVALID });
  }
  const explicitHasBody = Object.hasOwn(doc, 'hasBody') ? doc.hasBody : undefined;
  if (explicitHasBody !== false && !Object.hasOwn(doc, 'body')) {
    throw new AtrezzoError(`passthrough fixture "${fixtureName}" (${filePath}): missing "body" field`, { exitCode: EXIT.INVALID });
  }
  if (explicitHasBody === false && Object.hasOwn(doc, 'body') && doc.body !== null) {
    throw new AtrezzoError(`passthrough fixture "${fixtureName}" (${filePath}): "hasBody: false" cannot be combined with a non-null "body"`, { exitCode: EXIT.INVALID });
  }
  const ct = doc.contentType ?? doc['content-type'] ?? null;
  if (ct !== null && typeof ct !== 'string') {
    throw new AtrezzoError(`passthrough fixture "${fixtureName}" (${filePath}): "contentType" must be a string`, { exitCode: EXIT.INVALID });
  }
  const hasBody = explicitHasBody ?? (doc.body !== null);
  const body = hasBody ? doc.body : null;

  return {
    status: doc.status,
    contentType: ct ?? (typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'),
    hasBody,
    body,
  };
}

/**
 * Apply `{ "a.b.c": value }` patches onto a cloned fixture body.
 * Every segment in every patch path must already exist in `body` (no silent additions).
 */
export function applyPatch(body, patch, { endpointPath = '<endpoint>', fixtureName = '<fixture>' } = {}) {
  const cloned = cloneJson(body);
  const entries = Object.entries(patch ?? {});
  if (!entries.length) return cloned;

  for (const [pathStr, value] of entries) {
    const parts = pathStr.split('.');
    if (parts.some((p) => !p || FORBIDDEN_PATH_SEGMENTS.has(p))) {
      throw new AtrezzoError(
        `endpoint "${endpointPath}": invalid passthrough.patch path "${pathStr}" for fixture "${fixtureName}"`,
        { exitCode: EXIT.INVALID },
      );
    }

    let cur = cloned;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const at = i === 0 ? '<root>' : parts.slice(0, i).join('.');
      if (Array.isArray(cur)) {
        if (!/^\d+$/.test(seg)) {
          throw new AtrezzoError(
            `endpoint "${endpointPath}": passthrough.patch["${pathStr}"] (fixture "${fixtureName}"): path "${seg}" does not exist in array at "${at}" (expected integer index 0..${cur.length - 1})`,
            { exitCode: EXIT.INVALID },
          );
        }
        const idx = Number(seg);
        if (idx >= cur.length) {
          throw new AtrezzoError(
            `endpoint "${endpointPath}": passthrough.patch["${pathStr}"] (fixture "${fixtureName}"): index ${idx} does not exist at "${at}" (array length: ${cur.length})`,
            { exitCode: EXIT.INVALID },
          );
        }
        cur = cur[idx];
      } else if (isObj(cur)) {
        if (!Object.hasOwn(cur, seg)) {
          throw new AtrezzoError(
            `endpoint "${endpointPath}": passthrough.patch["${pathStr}"] (fixture "${fixtureName}"): path "${parts.slice(0, i + 1).join('.')}" does not exist (missing key "${seg}" at "${at}")`,
            { exitCode: EXIT.INVALID },
          );
        }
        cur = cur[seg];
      } else {
        throw new AtrezzoError(
          `endpoint "${endpointPath}": passthrough.patch["${pathStr}"] (fixture "${fixtureName}"): cannot traverse "${seg}" on ${typeName(cur)} at "${at}"`,
          { exitCode: EXIT.INVALID },
        );
      }
    }

    const last = parts[parts.length - 1];
    const parentAt = parts.length === 1 ? '<root>' : parts.slice(0, -1).join('.');
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(last)) {
        throw new AtrezzoError(
          `endpoint "${endpointPath}": passthrough.patch["${pathStr}"] (fixture "${fixtureName}"): path "${last}" does not exist in array at "${parentAt}" (expected integer index 0..${cur.length - 1})`,
          { exitCode: EXIT.INVALID },
        );
      }
      const idx = Number(last);
      if (idx >= cur.length) {
        throw new AtrezzoError(
          `endpoint "${endpointPath}": passthrough.patch["${pathStr}"] (fixture "${fixtureName}"): index ${idx} does not exist at "${parentAt}" (array length: ${cur.length})`,
          { exitCode: EXIT.INVALID },
        );
      }
      cur[idx] = cloneJson(value);
    } else if (isObj(cur)) {
      if (!Object.hasOwn(cur, last)) {
        throw new AtrezzoError(
          `endpoint "${endpointPath}": passthrough.patch["${pathStr}"] (fixture "${fixtureName}"): path "${pathStr}" does not exist (missing key "${last}" at "${parentAt}")`,
          { exitCode: EXIT.INVALID },
        );
      }
      cur[last] = cloneJson(value);
    } else {
      throw new AtrezzoError(
        `endpoint "${endpointPath}": passthrough.patch["${pathStr}"] (fixture "${fixtureName}"): cannot patch "${last}" on ${typeName(cur)} at "${parentAt}"`,
        { exitCode: EXIT.INVALID },
      );
    }
  }

  return cloned;
}

/**
 * Resolve all `ep.passthrough` declarations in a normalized scenario against disk fixtures
 * and return a map `{ [ep.path]: { status, contentType, hasBody, body } }`.
 */
export function resolvePassthroughs(scenario, { scenarioFile = null, fixturesDir = null } = {}) {
  const passthroughEndpoints = (scenario.endpoints ?? []).filter((ep) => ep.passthrough);
  if (!passthroughEndpoints.length) return {};

  const dir = resolveFixturesDir(scenarioFile, fixturesDir);
  const resolved = {};
  for (const ep of passthroughEndpoints) {
    const fixture = loadFixture(dir, ep.passthrough.fixture, ep.path);
    const body = applyPatch(fixture.body, ep.passthrough.patch, {
      endpointPath: ep.path,
      fixtureName: ep.passthrough.fixture,
    });
    resolved[ep.path] = {
      status: fixture.status,
      contentType: fixture.contentType,
      hasBody: fixture.hasBody,
      body,
    };
  }
  return resolved;
}
