// builtin: `atrezzo serve` (node:http + the projection engine). Universal fallback:
// any client that speaks HTTP, in any language, no dependencies.
import { metaFrom } from './common.mjs';

export const meta = metaFrom({
  id: 'builtin',
  label: 'atrezzo serve (built-in HTTP server)',
  signals: () => [{ text: 'universal fallback: real HTTP with no dependencies, works with any backend or language', weight: 1 }],
  none: '',
  startHint: 'atrezzo serve --scenario <scenario>',
});

export function emit({ dataset, config }) {
  return {
    files: [], // the dataset JSON and runtime.mjs (always written by `world`) are all it needs
    start: `atrezzo serve --scenario ${dataset.scenario} --port ${config.mock.port}`,
    notes: [
      `serves ${dataset.endpoints.map((e) => e.path).join(', ')} with the same engine as the handlers (runtime.mjs)`,
      'switch scenarios without restarting: POST /__atrezzo/reset {"scenario":"<name>"}',
    ],
  };
}
