// Passthrough-and-patch: load frozen HTTP fixtures and apply dot-path patches
// without altering the rest of the captured response.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
 * Bounded auto-discovery of fixtures for a scenarios directory (e.g. an external bundle).
 * Never recursively searches or walks arbitrary ancestors outside the bundle root.
 *
 * Bundle config `fixturesDir` always wins (and may not escape the bundle root). Otherwise an
 * existing `atrezzo/fixtures` (DEFAULT_FIXTURES_DIR) is preferred over a sibling `fixtures`, and
 * `atrezzo/fixtures` is the fallback path when neither exists.
 *
 * Supported bundle layouts:
 * - `<bundle>/atrezzo/scenarios` → bundle root `<bundle>` (bundle config, `atrezzo/fixtures`, `fixtures`)
 * - `<bundle>/scenarios`         → bundle root `<bundle>` (bundle config, `atrezzo/fixtures`, `fixtures`)
 * - `<bundle>/<other-name>`      → bundle root `<bundle>` (config in the scenarios dir, or in `<bundle>`
 *                                  when its `scenariosDir` points here; then `<bundle>/atrezzo/fixtures`,
 *                                  `<dir>/atrezzo/fixtures`, `<bundle>/fixtures`, `<dir>/fixtures`)
 */
const isInside = (root, p) => {
  const rel = relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Physical containment: the deepest existing component of `candidate` below the bundle root
 * (checked with lstat, so a dangling symlink counts as existing) must have a real path inside the
 * real bundle root. Dangling/unresolvable symlinks fail closed. Throws AtrezzoError otherwise.
 */
function assertPhysicallyInside(bundleRoot, candidate, label) {
  const root = resolve(bundleRoot);
  for (let p = resolve(candidate); p !== root && isInside(root, p); p = dirname(p)) {
    try {
      lstatSync(p);
    } catch {
      continue; // missing: check its parent
    }
    let real = null;
    let realRoot = root;
    try {
      real = realpathSync(p);
      realRoot = realpathSync(root);
    } catch {
      real = null;
    }
    if (real === null || !isInside(realRoot, real)) {
      throw new AtrezzoError(
        `${label} ${candidate} rejected — it escapes the bundle root ${root} ` +
        `(${real === null ? `${p} is a dangling symlink or cannot be resolved` : `${p} resolves to ${real}`})`,
        { exitCode: EXIT.INVALID },
      );
    }
    return;
  }
}

export function discoverBundleFixturesDir(scenariosDir, { excludeConfigDir = null } = {}) {
  const sdir = resolve(scenariosDir);
  const name = basename(sdir);
  const parent = dirname(sdir);
  const excluded = excludeConfigDir ? resolve(excludeConfigDir) : null;

  const configFixturesAt = (root, requireMatch = false) => {
    if (!existsSync(join(root, CONFIG_FILE))) return null;
    const mustMatch = requireMatch || (excluded !== null && root === excluded);
    let cfg;
    try {
      cfg = loadConfig(root);
    } catch (e) {
      if (mustMatch && excluded !== null && root === excluded) return null;
      throw e;
    }
    if (mustMatch && resolve(root, cfg.scenariosDir) !== sdir) return null;
    const raw = cfg.fixturesDir ?? DEFAULT_FIXTURES_DIR;
    const dir = resolve(root, raw);
    if (root !== excluded) {
      const rel = relative(root, dir);
      if (isAbsolute(raw) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new AtrezzoError(
          `Bundle config ${join(root, CONFIG_FILE)}: fixturesDir ${JSON.stringify(raw)} rejected — ` +
          `it escapes the bundle root ${root} (must be a relative path inside the bundle)`,
          { exitCode: EXIT.INVALID },
        );
      }
      assertPhysicallyInside(root, dir, `Bundle config ${join(root, CONFIG_FILE)}: fixturesDir`);
    }
    return { dir, source: 'bundle config' };
  };

  // First existing candidate wins; otherwise fall back to the preferred DEFAULT_FIXTURES_DIR path.
  // Every candidate (and the fallback) must also stay physically inside the bundle root.
  const firstExisting = (candidates, fallback, bundleRoot) => {
    for (const candidate of candidates) {
      assertPhysicallyInside(bundleRoot, candidate, 'Bundle fixtures candidate');
      if (existsSync(candidate)) return { dir: candidate, source: 'bundle' };
    }
    assertPhysicallyInside(bundleRoot, fallback, 'Bundle fixtures candidate');
    return { dir: fallback, source: 'bundle' };
  };

  if (name === 'scenarios' && basename(parent) === 'atrezzo') {
    const bundleRoot = dirname(parent);
    const fromCfg = configFixturesAt(bundleRoot);
    if (fromCfg) return fromCfg;
    const preferred = join(bundleRoot, DEFAULT_FIXTURES_DIR);
    return firstExisting([preferred, join(bundleRoot, 'fixtures')], preferred, bundleRoot);
  }

  if (name === 'scenarios') {
    const bundleRoot = parent;
    const fromCfg = configFixturesAt(bundleRoot);
    if (fromCfg) return fromCfg;
    const preferred = join(bundleRoot, DEFAULT_FIXTURES_DIR);
    return firstExisting([preferred, join(bundleRoot, 'fixtures')], preferred, bundleRoot);
  }

  const fromOwnCfg = configFixturesAt(sdir);
  if (fromOwnCfg) return fromOwnCfg;
  if (parent !== sdir) {
    const fromParentCfg = configFixturesAt(parent, true);
    if (fromParentCfg) return fromParentCfg;
  }
  const bundleRoot = parent;
  const preferred = join(bundleRoot, DEFAULT_FIXTURES_DIR);
  return firstExisting(
    [...new Set([
      preferred,
      join(sdir, DEFAULT_FIXTURES_DIR),
      join(bundleRoot, 'fixtures'),
      join(sdir, 'fixtures'),
    ])],
    preferred,
    bundleRoot,
  );
}

/**
 * Resolve effective scenarios and fixtures directories from project config and optional CLI overrides.
 * Precedence for fixturesDir:
 * 1. Explicit `fixtures` override (resolved relative to CWD)
 * 2. When `scenarios` is omitted, or resolves to the project's configured `scenariosDir` or the project
 *    directory itself: project config `fixturesDir`
 * 3. When `scenarios` points to an external bundle: bounded bundle-local discovery
 */
export function resolveEffectiveDirs({ cfg = null, dir = process.cwd(), scenarios = null, fixtures = null } = {}) {
  const projectDir = resolve(cfg?._dir ?? dir);
  const hasProjectConfig = Boolean(cfg && !cfg._missing);
  const projectScenariosDir = cfg ? resolve(projectDir, cfg.scenariosDir) : null;
  const projectFixturesDir = cfg ? resolve(projectDir, cfg.fixturesDir) : null;

  const hasScenariosOverride = scenarios !== null && scenarios !== undefined;
  const hasFixturesOverride = fixtures !== null && fixtures !== undefined;

  const scenariosDir = hasScenariosOverride ? resolve(scenarios) : projectScenariosDir;
  const scenariosSource = hasScenariosOverride
    ? '--scenarios'
    : (hasProjectConfig ? 'atrezzo.config.json' : 'default');

  if (hasFixturesOverride) {
    return {
      scenariosDir,
      fixturesDir: resolve(fixtures),
      scenariosSource,
      fixturesSource: '--fixtures',
    };
  }

  if (hasScenariosOverride) {
    if (hasProjectConfig && (scenariosDir === projectScenariosDir || scenariosDir === projectDir)) {
      return {
        scenariosDir,
        fixturesDir: projectFixturesDir,
        scenariosSource,
        fixturesSource: 'atrezzo.config.json',
      };
    }
    const discovered = discoverBundleFixturesDir(scenariosDir, { excludeConfigDir: projectDir });
    return {
      scenariosDir,
      fixturesDir: discovered.dir,
      scenariosSource,
      fixturesSource: discovered.source,
    };
  }

  return {
    scenariosDir,
    fixturesDir: projectFixturesDir,
    scenariosSource,
    fixturesSource: hasProjectConfig ? 'atrezzo.config.json' : 'default',
  };
}

/**
 * Determine the fixtures directory for a scenario file when no explicit directory was given.
 * Precedence:
 * 1. `explicitDir` (resolved relative to CWD)
 * 2. Pseudo/missing scenario paths → default fixtures dir relative to CWD
 * 3. Legacy bounded ancestor lookup: the first `atrezzo.config.json` found in the scenario's
 *    directory or its first two parents (at most three directories), using that config's
 *    `fixturesDir` resolved relative to the config directory
 * 4. Scenario directory named `scenarios` → bounded bundle discovery (`discoverBundleFixturesDir`)
 * 5. Otherwise the first existing of `<dir>/atrezzo/fixtures`, `<dir>/fixtures`, `<parent>/atrezzo/fixtures`,
 *    `<parent>/fixtures`; default `<dir>/atrezzo/fixtures` (no arbitrary ancestor walks)
 */
export function resolveFixturesDir(scenarioFile, explicitDir = null) {
  if (explicitDir) return resolve(explicitDir);
  if (!scenarioFile || scenarioFile.startsWith('<')) return resolve(DEFAULT_FIXTURES_DIR);

  const startDir = dirname(resolve(scenarioFile));
  const candidates = [startDir, dirname(startDir), dirname(dirname(startDir))];
  for (const candidate of new Set(candidates)) {
    if (existsSync(join(candidate, CONFIG_FILE))) {
      const cfg = loadConfig(candidate);
      return resolve(candidate, cfg.fixturesDir ?? DEFAULT_FIXTURES_DIR);
    }
  }

  if (basename(startDir) === 'scenarios') return discoverBundleFixturesDir(startDir).dir;

  const parentDir = dirname(startDir);
  const localCandidates = [
    join(startDir, DEFAULT_FIXTURES_DIR),
    join(startDir, 'fixtures'),
    join(parentDir, DEFAULT_FIXTURES_DIR),
    join(parentDir, 'fixtures'),
  ];
  for (const candidate of localCandidates) {
    if (existsSync(candidate)) return candidate;
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
