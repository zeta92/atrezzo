// msw: generated request handlers (.mjs) that run the projection engine in the
// browser (setupWorker) or in Node tests (setupServer).
import { posix } from 'node:path';
import { handlersSource } from '../codegen.mjs';
import { metaFrom, p } from './common.mjs';

function signals(ctx) {
  const out = [];
  const where = ctx.dep('msw');
  if (where) out.push({ text: `msw in ${where}`, weight: 3 });
  const worker = [...ctx.files('public/mockServiceWorker.js')];
  if (worker.length) out.push({ text: `${worker[0]} (msw init done)`, weight: 2 });
  return out;
}

export const meta = metaFrom({
  id: 'msw',
  label: 'MSW (handlers in the browser and Node tests)',
  signals,
  none: 'msw is not a dependency',
  startHint: "setupWorker(...handlers).start()  ·  setupServer(...handlers).listen()",
});

/** Folder where the handlers go: inside the front when the workspace declares one. */
export function handlersDir(config) {
  const front = config.workspace?.front;
  return front && front !== '.' ? p(front, 'src/mocks/atrezzo') : p(config.generatedDir);
}

export function emit({ dataset, config }) {
  const dir = handlersDir(config);
  let base = posix.relative(dir, p(config.generatedDir)) || '.';
  if (!base.startsWith('.')) base = `./${base}`;
  const file = p(dir, `${dataset.scenario}.handlers.mjs`);
  const notes = [];
  if (dir !== p(config.generatedDir)) notes.push(`handlers in the front end (${dir}); they import ${base}/${dataset.scenario}.json and runtime.mjs with relative paths`);
  notes.push('imports JSON with `with { type: "json" }`: Node 22+, Vite 5+, Next 14+');
  return {
    files: [{ path: file, content: handlersSource(dataset, { importBase: base }) }],
    start: `import { handlers } from '${file}'  →  setupWorker(...handlers).start({ onUnhandledRequest: 'bypass' })`,
    notes,
  };
}
