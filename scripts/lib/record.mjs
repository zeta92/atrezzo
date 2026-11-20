// `atrezzo record`: capture a real HTTP response (without credentials/headers)
// into `<fixturesDir>/<name>.json` for passthrough-and-patch endpoints.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { AtrezzoError, EXIT } from './errors.mjs';
import { parseYaml, YamlError } from './yaml.mjs';
import { emitYaml } from './yaml-emit.mjs';
import { normalizeScenario } from './scenario.mjs';
import { normalizeFixtureName, resolveFixturesDir, fixtureFilePath } from './passthrough.mjs';
import { formatHeaders, redact } from './headers.mjs';
import { safeSearch } from './misses.mjs';
import { slug } from './runtimes/common.mjs';

const JSON_CT = /\bjson\b|\+json/i;

function readScenarioDoc(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new AtrezzoError(`Cannot read scenario ${file}: ${e.code === 'ENOENT' ? 'file does not exist' : e.message}`);
  }
  if (/\.json$/i.test(file)) {
    try { return { doc: JSON.parse(text), isJson: true }; } catch (e) { throw new AtrezzoError(`${file}: invalid JSON: ${e.message}`); }
  }
  try { return { doc: parseYaml(text, file), isJson: false }; } catch (e) {
    if (e instanceof YamlError) throw new AtrezzoError(e.message);
    throw e;
  }
}

/** Mask credentials in a URL for logs/errors (userinfo and secret-looking query params). */
export function safeUrl(rawUrl) {
  const u = new URL(rawUrl);
  const auth = u.username || u.password ? '***@' : '';
  const search = safeSearch(u.searchParams);
  return `${u.protocol}//${auth}${u.host}${u.pathname}${search}`;
}

export function defaultFixtureName(endpointPath) {
  return slug(endpointPath);
}

/**
 * Capture a real response from `url` and save `{ status, contentType, hasBody, body }`
 * (zero request/response secret headers) to `atrezzo/fixtures/<name>.json`.
 */
export async function recordEndpoint({
  url,
  scenarioFile,
  endpointPath,
  fixtureName = null,
  headers = {},
  write = false,
  fixturesDir = null,
  cwd = process.cwd(),
  fetchImpl = fetch,
}) {
  if (!url) throw new AtrezzoError('Usage: atrezzo record <url> --scenario <file> --endpoint <path>');
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new AtrezzoError(`Invalid URL "${url}"`);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new AtrezzoError(`Unsupported URL protocol "${parsedUrl.protocol}" (use http:// or https://)`);
  }

  if (!scenarioFile) throw new AtrezzoError('--scenario <file> is required');
  if (!endpointPath || typeof endpointPath !== 'string' || !endpointPath.startsWith('/')) {
    throw new AtrezzoError('--endpoint <path> is required and must start with "/"');
  }
  if (/[?#\s]/.test(endpointPath)) {
    throw new AtrezzoError(`Invalid --endpoint "${endpointPath}": must not contain whitespace, query or fragment`);
  }
  const cleanEndpoint = endpointPath.replace(/\/+$/, '') || '/';

  const absScenario = resolve(cwd, scenarioFile);
  const { doc, isJson } = readScenarioDoc(absScenario);
  const scenario = normalizeScenario(doc, absScenario);

  const rawEndpoints = Array.isArray(doc.endpoints) ? doc.endpoints : [];
  const matchedRaw = rawEndpoints.find((ep) => {
    if (typeof ep?.path !== 'string') return false;
    return (ep.path.replace(/\/+$/, '') || '/') === cleanEndpoint;
  });

  if (!matchedRaw && !write) {
    const known = scenario.endpoints.map((e) => e.path).join(', ') || 'none';
    throw new AtrezzoError(
      `endpoint "${cleanEndpoint}" is not declared in ${scenarioFile} (declared: ${known}); add it or pass --write`,
    );
  }

  let resolvedName;
  if (fixtureName !== null && fixtureName !== undefined) {
    resolvedName = normalizeFixtureName(fixtureName);
    if (!resolvedName) throw new AtrezzoError(`Invalid --fixture name ${JSON.stringify(fixtureName)}`);
  } else if (matchedRaw?.passthrough?.fixture) {
    resolvedName = normalizeFixtureName(matchedRaw.passthrough.fixture);
    if (!resolvedName) throw new AtrezzoError(`Invalid passthrough.fixture ${JSON.stringify(matchedRaw.passthrough.fixture)} in ${scenarioFile}`);
  } else {
    resolvedName = defaultFixtureName(cleanEndpoint);
  }

  const targetFixturesDir = resolveFixturesDir(absScenario, fixturesDir);
  const outFile = fixtureFilePath(targetFixturesDir, resolvedName);

  const reqInit = Object.keys(headers).length ? { method: 'GET', headers } : { method: 'GET' };
  let res;
  try {
    res = await fetchImpl(parsedUrl.toString(), reqInit);
  } catch (e) {
    throw new AtrezzoError(
      redact(`Failed to record ${safeUrl(parsedUrl.toString())}: ${e.cause?.code ?? e.message}`, headers),
      { exitCode: EXIT.UNVERIFIABLE },
    );
  }

  const status = res.status;
  const rawCt = res.headers?.get?.('content-type') ?? null;
  const rawText = await res.text();
  const hasBody = rawText !== '';

  let body;
  if (!hasBody) {
    body = null;
  } else if (rawCt && JSON_CT.test(rawCt)) {
    try {
      body = JSON.parse(rawText);
    } catch (e) {
      throw new AtrezzoError(
        `Response from ${safeUrl(parsedUrl.toString())} declared content-type "${rawCt}" but returned invalid JSON: ${e.message}`,
        { exitCode: EXIT.INVALID },
      );
    }
  } else if (!rawCt) {
    try { body = JSON.parse(rawText); } catch { body = rawText; }
  } else {
    body = rawText;
  }

  const contentType = rawCt ?? (typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  // Persist ONLY status, contentType, hasBody, and body: no request/response headers, cookies, or tokens.
  const fixturePayload = { status, contentType, hasBody, body };

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(fixturePayload, null, 2)}\n`);

  let updatedScenario = null;
  if (write) {
    if (matchedRaw) {
      matchedRaw.passthrough = {
        ...(matchedRaw.passthrough && typeof matchedRaw.passthrough === 'object' ? matchedRaw.passthrough : {}),
        fixture: resolvedName,
      };
    } else {
      if (!Array.isArray(doc.endpoints)) doc.endpoints = [];
      doc.endpoints.push({ path: cleanEndpoint, passthrough: { fixture: resolvedName } });
    }
    normalizeScenario(doc, absScenario);
    const outText = isJson ? `${JSON.stringify(doc, null, 2)}\n` : emitYaml(doc);
    writeFileSync(absScenario, outText);
    updatedScenario = relative(cwd, absScenario) || absScenario;
  }

  return {
    url: safeUrl(parsedUrl.toString()),
    endpoint: cleanEndpoint,
    fixture: resolvedName,
    file: outFile,
    relativeFile: relative(cwd, outFile) || outFile,
    status,
    contentType,
    bytes: Buffer.byteLength(rawText, 'utf8'),
    headers,
    scenario: scenario.name,
    updatedScenario,
    hasPassthrough: Boolean(matchedRaw?.passthrough || write),
  };
}

export function formatRecordReport(res) {
  const lines = [
    `atrezzo record · ${res.url} → ${res.relativeFile}`,
  ];
  if (res.headers && Object.keys(res.headers).length) {
    lines.push(`  request headers (not saved): ${formatHeaders(res.headers)}`);
  }
  lines.push(`  captured: HTTP ${res.status} · ${res.contentType} · ${res.bytes} bytes`);
  if (res.updatedScenario) {
    lines.push(`  updated: ${res.updatedScenario} (${res.endpoint} → passthrough.fixture "${res.fixture}")`);
  } else if (!res.hasPassthrough) {
    lines.push(`  next: add to ${res.endpoint} in the scenario (or re-run with --write):`);
    lines.push(`    passthrough: { fixture: ${res.fixture} }`);
  }
  return lines.join('\n');
}
