// Standalone HTTP mock server (plain node:http, MSW not required).
// Uses the same projection engine (contract.mjs) as the generated MSW handlers.
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { AtrezzoError } from './errors.mjs';
import { loadScenario, scenarioNameFromFile } from './scenario.mjs';
import { generateWorld } from './world.mjs';
import { createEngine } from './contract.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

/** Map of scenario name -> file, by file basename and by `name:` field. */
export function listScenarios(dir) {
  if (!existsSync(dir)) throw new AtrezzoError(`No existe el directorio de escenarios ${dir}`);
  const out = {};
  for (const f of readdirSync(dir).sort()) {
    if (!/\.(ya?ml|json)$/.test(f)) continue;
    const file = join(dir, f);
    out[scenarioNameFromFile(f)] = file;
    try { out[loadScenario(file).name] = file; } catch { /* invalid files surface when selected */ }
  }
  return out;
}

export function buildState(scenarioFile) {
  const scenario = loadScenario(scenarioFile);
  const dataset = generateWorld(scenario);
  return { scenario, dataset, engine: createEngine(dataset), file: scenarioFile };
}

function summary(state, available, generatedDir) {
  const d = state.dataset;
  const out = {
    escenario: d.scenario, seed: d.seed, now: d.now, hash: d.hash,
    counts: Object.fromEntries(Object.entries(d.entities).map(([k, v]) => [k, v.length])),
    endpoints: d.endpoints.map((e) => e.path),
    disponibles: [...new Set(Object.values(available).map((f) => scenarioNameFromFile(f)))],
  };
  if (generatedDir) {
    const gen = join(generatedDir, `${d.scenario}.json`);
    if (existsSync(gen)) {
      try {
        const h = JSON.parse(readFileSync(gen, 'utf8')).hash;
        out.generado = h === d.hash ? 'al día' : `desactualizado (hash ${h}); ejecuta atrezzo world`;
      } catch { out.generado = 'ilegible'; }
    } else out.generado = 'no generado (ejecuta atrezzo world para commitear handlers)';
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new AtrezzoError('cuerpo JSON inválido'); }
}

/**
 * @param {{ scenariosDir: string, scenario?: string, staticDir?: string|null, generatedDir?: string|null, log?: (s:string)=>void }} opts
 */
export function createMockServer({ scenariosDir, scenario, staticDir = null, generatedDir = null, log = () => {} }) {
  let available = listScenarios(scenariosDir);
  const pick = (name) => {
    available = listScenarios(scenariosDir);
    const names = Object.keys(available);
    if (!name) {
      if (!names.length) throw new AtrezzoError(`No hay escenarios en ${scenariosDir}`);
      return available[names[0]];
    }
    if (!available[name]) throw new AtrezzoError(`Escenario "${name}" no encontrado en ${scenariosDir} (hay: ${[...new Set(Object.values(available).map(scenarioNameFromFile))].join(', ') || 'ninguno'})`);
    return available[name];
  };
  let state = buildState(pick(scenario));

  const send = (res, status, body, headers = {}) => {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-total-count, x-atrezzo-escenario, x-atrezzo-ignored', 'cache-control': 'no-store', ...headers });
    res.end(res.req.method === 'HEAD' ? undefined : payload);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '', { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' });
      if (url.pathname === '/__atrezzo/state' && req.method === 'GET') {
        return send(res, 200, summary(state, available, generatedDir), { 'content-type': 'application/json; charset=utf-8' });
      }
      if (url.pathname === '/__atrezzo/reset') {
        if (req.method !== 'POST') return send(res, 405, { error: 'usa POST' }, { allow: 'POST' });
        const body = await readBody(req);
        const name = body.escenario ?? url.searchParams.get('escenario') ?? state.dataset.scenario;
        state = buildState(pick(name));
        log(`reset → ${state.dataset.scenario}`);
        return send(res, 200, summary(state, available, generatedDir), { 'content-type': 'application/json; charset=utf-8' });
      }
      const r = state.engine.handle({ method: req.method, pathname: url.pathname, query: url.searchParams });
      if (r) { log(`${req.method} ${url.pathname}${url.search} → ${r.status}`); return send(res, r.status, r.body, r.headers); }
      if (staticDir && (req.method === 'GET' || req.method === 'HEAD')) {
        const root = resolve(staticDir);
        let file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
        if (file !== root && !file.startsWith(root + sep)) return send(res, 403, { error: 'ruta fuera del directorio estático' });
        if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
        if (existsSync(file)) return send(res, 200, readFileSync(file), { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      }
      return send(res, 404, { error: `${req.method} ${url.pathname} no está en el contrato del escenario "${state.dataset.scenario}"`, endpoints: state.dataset.endpoints.map((e) => e.path) }, { 'content-type': 'application/json; charset=utf-8' });
    } catch (e) {
      const status = e instanceof AtrezzoError ? 400 : 500;
      return send(res, status, { error: e.message }, { 'content-type': 'application/json; charset=utf-8' });
    }
  });

  return {
    server,
    get state() { return state; },
    listen(port = 4010, host = '127.0.0.1') {
      return new Promise((ok, ko) => {
        server.once('error', ko);
        server.listen(port, host, () => { server.off('error', ko); ok(server.address()); });
      });
    },
    close() { return new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }); },
  };
}
