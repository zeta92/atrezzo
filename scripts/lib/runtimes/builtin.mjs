// builtin: `atrezzo serve` (node:http + the projection engine). Universal fallback:
// any client that speaks HTTP, in any language, no dependencies.
import { metaFrom } from './common.mjs';

export const meta = metaFrom({
  id: 'builtin',
  label: 'atrezzo serve (servidor HTTP propio)',
  signals: () => [{ text: 'fallback universal: HTTP real sin dependencias, vale para cualquier backend o lenguaje', weight: 1 }],
  none: '',
  startHint: 'atrezzo serve --escenario <escenario>',
});

export function emit({ dataset, config }) {
  return {
    files: [], // the dataset JSON and runtime.mjs (always written by `world`) are all it needs
    start: `atrezzo serve --escenario ${dataset.scenario} --port ${config.mock.port}`,
    notes: [
      `sirve ${dataset.endpoints.map((e) => e.path).join(', ')} con el mismo motor que los handlers (runtime.mjs)`,
      'cambio de escenario sin reiniciar: POST /__atrezzo/reset {"escenario":"<nombre>"}',
    ],
  };
}
