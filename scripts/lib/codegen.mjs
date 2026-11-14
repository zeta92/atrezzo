// Writes the generated artifacts: dataset JSON, runtime (verbatim engine copy)
// and readable MSW handlers. Output is deterministic so it can be committed and diffed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'contract.mjs');

export function datasetJson(dataset) {
  return `${JSON.stringify(dataset, null, 2)}\n`;
}

export function handlersSource(dataset) {
  const name = dataset.scenario;
  const lines = [
    '// Generado por atrezzo. No editar a mano: cambia el escenario y ejecuta `atrezzo world`.',
    `// Escenario: ${name} · semilla ${dataset.seed} · now ${dataset.now} · hash ${dataset.hash}`,
    "import { http, HttpResponse } from 'msw';",
    `import dataset from './${name}.json' with { type: 'json' };`,
    "import { createEngine } from './runtime.mjs';",
    '',
    'const engine = createEngine(dataset);',
    '',
    '/** Proyecta la petición con el mismo motor que `atrezzo serve`. */',
    'function project({ request }) {',
    '  const url = new URL(request.url);',
    '  const res = engine.handle({ method: request.method, pathname: url.pathname, query: url.searchParams });',
    '  if (!res) return undefined; // no es nuestra: MSW sigue con el siguiente handler',
    '  return HttpResponse.json(res.body, { status: res.status, headers: res.headers });',
    '}',
    '',
    'export const handlers = [',
  ];
  for (const ep of dataset.endpoints) {
    const notes = [`${ep.entity}`];
    if (ep.filters.length) notes.push(`filtros: ${ep.filters.join(', ')}`);
    if (ep.pagination) notes.push(`paginación: ${ep.pagination.limit}/${ep.pagination.offset}`);
    if (ep.include.length) notes.push(`incluye: ${ep.include.join(', ')}`);
    lines.push(`  // ${ep.path} → ${notes.join(' · ')}`);
    lines.push(`  http.get('*${ep.path}', project),`);
    if (ep.detail) lines.push(`  http.get('*${ep.path}/:id', project),`);
  }
  lines.push('];', '', 'export { dataset };', '');
  return lines.join('\n');
}

/** Write <dir>/<name>.json, <dir>/<name>.handlers.mjs and <dir>/runtime.mjs. */
export function writeGenerated(dataset, dir) {
  mkdirSync(dir, { recursive: true });
  const files = {
    json: join(dir, `${dataset.scenario}.json`),
    handlers: join(dir, `${dataset.scenario}.handlers.mjs`),
    runtime: join(dir, 'runtime.mjs'),
  };
  writeFileSync(files.json, datasetJson(dataset));
  writeFileSync(files.handlers, handlersSource(dataset));
  writeFileSync(files.runtime, readFileSync(ENGINE_FILE, 'utf8'));
  return files;
}
