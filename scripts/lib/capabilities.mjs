// Una sola tabla de lo que cada runtime reproduce y con cuánta fidelidad.
//
// Todo lo que avisa al usuario (world, doctor, adapters) sale de aquí: si la
// tabla y el código se separan, el aviso miente, que es peor que no avisar.
// `builtin` es el oráculo y siempre está en `same`; las demás columnas dicen
// dónde se separan y por qué. Los estados son:
//
//   same      · se comporta igual que el motor
//   partial   · cubre una parte y declina el resto de forma explícita
//   declined  · no lo soporta, pero lo declara (501, aviso, o no se emite)
//   different · se comporta de otra manera: el escenario no se reproduce
//
// `different` es el estado peligroso: es el que hacía falta nombrar.

import { RUNTIMES } from './config.mjs';

export const STATES = ['same', 'partial', 'declined', 'different'];

export const STATE_LABEL = {
  same: 'igual',
  partial: 'parcial',
  declined: 'no soportado (declarado)',
  different: 'distinto'
};

const anyEndpoint = (s, fn) => s.endpoints.some(fn);

/**
 * Cada capacidad: cómo se detecta que el escenario la usa y qué hace cada
 * runtime con ella. `notes` solo existe para las columnas que no son `same`.
 */
export const CAPABILITIES = [
  {
    id: 'filters',
    label: 'filtros (igualdad, `a,b`, `null`)',
    present: (s) => anyEndpoint(s, (ep) => ep.filters?.length),
    states: { msw: 'same', supabase: 'different', prism: 'declined', wiremock: 'partial' },
    notes: {
      supabase: 'PostgREST compara con su propio tipo: `null` y las listas no son iguales',
      prism: 'no evalúa filtros: devuelve el ejemplo del spec',
      wiremock: 'igualdad de un valor; varias combinaciones acaban en 501'
    }
  },
  {
    id: 'pgrst-operators',
    label: 'operadores PostgREST (`eq.`, `in.()`, `ilike.`)',
    // Se decide en la query del cliente (`?id=eq.3`), no en el escenario: no hay
    // nada que detectar al generar, así que no puede salir en los avisos.
    present: () => false,
    states: { msw: 'same', supabase: 'same', prism: 'declined', wiremock: 'partial' },
    notes: {
      prism: 'no evalúa operadores',
      wiremock: 'un operador por mapping; el resto acaba en 501'
    }
  },
  {
    id: 'pagination',
    label: 'paginación (`limit`/`offset`/`page`)',
    present: (s) => anyEndpoint(s, (ep) => ep.pagination),
    states: { msw: 'same', supabase: 'different', prism: 'declined', wiremock: 'partial' },
    notes: {
      supabase: 'PostgREST pagina con `Range`; el `limit` de la query no es el mismo corte',
      prism: 'ignora los parámetros de paginación',
      wiremock: 'solo las páginas enumeradas en el flujo; el resto acaba en 501'
    }
  },
  {
    id: 'sorts',
    label: 'orden (`sort` y `sorts`)',
    present: (s) => anyEndpoint(s, (ep) => ep.sorts || (ep.sort ?? []).length > 1),
    states: { msw: 'same', supabase: 'different', prism: 'different', wiremock: 'partial' },
    notes: {
      supabase: 'PostgREST ordena en SQL: los nulos y el `nullsfirst` no caen donde caen aquí',
      prism: 'declara el parámetro y lo ignora: el orden es el del ejemplo',
      wiremock: 'solo las peticiones que aparecen en los flujos'
    }
  },
  {
    id: 'scopes',
    label: 'scopes (parámetro → filtro booleano)',
    present: (s) => anyEndpoint(s, (ep) => ep.scopes),
    states: { msw: 'same', supabase: 'different', prism: 'different', wiremock: 'partial' },
    notes: {
      supabase: 'el filtro tiene que existir en la vista; si no, PostgREST responde con su error',
      prism: 'no evalúa el parámetro',
      wiremock: 'un valor por scope'
    }
  },
  {
    id: 'envelope',
    label: 'sobre (`envelope`, `pick`, `total_pages`)',
    present: (s) => anyEndpoint(s, (ep) => ep.envelope || ep.pick),
    states: { msw: 'same', supabase: 'different', prism: 'same', wiremock: 'same' },
    notes: {
      supabase: 'la forma la dicta PostgREST (array o `{data,count}`), no el sobre'
    }
  },
  {
    id: 'singleton',
    label: 'detalle y singleton (`shape: object`, `wrap`, `/:id`)',
    present: (s) => anyEndpoint(s, (ep) => ep.shape === 'object' || ep.wrap || ep.detail),
    states: { msw: 'same', supabase: 'different', prism: 'partial', wiremock: 'same' },
    notes: {
      supabase: '`.single()` necesita `Accept: application/vnd.pgrst.object+json`',
      prism: 'devuelve siempre la primera fila del ejemplo'
    }
  },
  {
    id: 'relations',
    label: 'relaciones (`include`, `embed`, `counts`, `pluck`)',
    present: (s) => anyEndpoint(s, (ep) => ep.embed || ep.counts?.length || ep.pluck),
    states: { msw: 'same', supabase: 'different', prism: 'same', wiremock: 'same' },
    notes: {
      supabase: 'el embed tiene que ser una FK real y la proyección se pide distinto'
    }
  },
  {
    id: 'nested-routes',
    label: 'rutas anidadas con varios parámetros',
    present: (s) => anyEndpoint(s, (ep) => (ep.path.match(/:/g) ?? []).length > 1),
    states: { msw: 'same', supabase: 'different', prism: 'partial', wiremock: 'partial' },
    notes: {
      supabase: 'cada segmento es una tabla o una vista',
      prism: 'el patrón del spec no distingue los dos parámetros',
      wiremock: 'el mapping solo fija el primer segmento; el resto da 404'
    }
  },
  {
    id: 'world-filters',
    label: 'filtros de mundo y `$user`',
    present: (s) => anyEndpoint(s, (ep) => ep.worldFilters?.length || ep.userFilters?.length),
    states: { msw: 'same', supabase: 'different', prism: 'same', wiremock: 'same' },
    notes: {
      supabase: 'el filtro por usuario lo pone RLS, no el escenario'
    }
  },
  {
    id: 'writes',
    label: 'escrituras y `reset` (`writes`)',
    present: (s) => (s.writes ?? []).length > 0,
    states: { msw: 'same', supabase: 'different', prism: 'declined', wiremock: 'declined' },
    notes: {
      supabase: 'escribe de verdad en Postgres: el reset del mundo no lo deshace',
      prism: 'no emite las rutas de escritura',
      wiremock: 'no emite las rutas de escritura'
    }
  },
  {
    id: 'rpc',
    label: 'funciones `rpc`',
    present: (s) => (s.rpc ?? []).length > 0,
    states: { msw: 'same', supabase: 'different', prism: 'declined', wiremock: 'declined' },
    notes: {
      supabase: 'la función tiene que existir en Postgres; el escenario no la crea',
      prism: 'no emite el endpoint',
      wiremock: 'no emite el endpoint'
    }
  },
  {
    id: 'streams',
    label: 'SSE (`streams`)',
    present: (s) => (s.streams ?? []).length > 0,
    states: { msw: 'declined', supabase: 'different', prism: 'declined', wiremock: 'declined' },
    notes: {
      msw: 'un 501 explícito en la ruta del stream: el flujo ve el aviso, no los eventos',
      supabase: 'no hay SSE en PostgREST',
      prism: 'no emite el endpoint',
      wiremock: 'no emite el endpoint'
    }
  },
  {
    id: 'passthrough-error',
    label: '`passthrough` y `error`',
    present: (s) => anyEndpoint(s, (ep) => ep.passthrough || ep.error),
    states: { msw: 'same', supabase: 'same', prism: 'same', wiremock: 'same' },
    notes: {}
  },
  {
    id: 'latency',
    label: 'latencia (`latency`)',
    present: (s) => anyEndpoint(s, (ep) => ep.latency !== undefined),
    states: { msw: 'same', supabase: 'different', prism: 'different', wiremock: 'different' },
    notes: {
      supabase: 'la latencia la pone Postgres',
      prism: 'no aplica `latency`',
      wiremock: 'tiene `fixedDelayMilliseconds` pero el artefacto no lo usa'
    }
  },
  {
    id: 'diagnostic-headers',
    label: 'cabeceras de diagnóstico (`X-Total-Count`, `X-Atrezzo-*`)',
    present: (s) => s.endpoints.length > 0,
    states: { msw: 'same', supabase: 'declined', prism: 'partial', wiremock: 'partial' },
    notes: {
      supabase: 'las cabeceras las pone PostgREST (`Content-Range`)',
      prism: 'solo el total del ejemplo, sin `X-Atrezzo-Ignored`',
      wiremock: 'total sí; `X-Atrezzo-Ignored` no'
    }
  }
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

/** El estado de una capacidad en un runtime: `same` | `partial` | `declined` | `different`. */
export function stateOf(id, runtime) {
  const cap = BY_ID.get(id);
  if (!cap) throw new Error(`unknown capability: ${id}`);
  if (runtime === 'builtin') return 'same';
  return cap.states[runtime] ?? 'declined';
}

/** Las capacidades que este escenario usa de verdad, con el estado de cada runtime. */
export function usedCapabilities(scenario) {
  return CAPABILITIES.filter((c) => {
    try { return Boolean(c.present(scenario)); } catch { return false; }
  }).map((c) => ({
    id: c.id,
    label: c.label,
    states: Object.fromEntries(RUNTIMES.filter((r) => r !== 'builtin').map((r) => [r, stateOf(c.id, r)])),
    notes: c.notes
  }));
}

/**
 * Lo que hay que decirle a alguien que va a generar con `runtime`:
 * cada capacidad usada que no se reproduce igual, con su motivo.
 */
export function degradations(scenario, runtime) {
  if (runtime === 'builtin') return [];
  return usedCapabilities(scenario)
    .filter((c) => c.states[runtime] && c.states[runtime] !== 'same')
    .map((c) => ({ id: c.id, label: c.label, state: c.states[runtime], note: c.notes?.[runtime] ?? null }));
}

/** `writes, rpc, latency` — la lista corta que cabe en una línea de aviso. */
export function degradationList(scenario, runtime) {
  return degradations(scenario, runtime).map((d) => d.id);
}


/**
 * Qué capacidad cubre cada clave del DSL. `core` es lo que no puede faltar en
 * ningún runtime (la ruta y la entidad). Vive aquí para que una clave nueva en
 * `scenario.mjs` sin entrada rompa un test en vez de pasar desapercibida.
 */
export const KEY_COVERAGE = {
  path: 'core',
  entity: 'core',
  filters: 'filters',
  pagination: 'pagination',
  sort: 'sorts',
  sorts: 'sorts',
  scopes: 'scopes',
  include: 'relations',
  embed: 'relations',
  counts: 'relations',
  pluck: 'relations',
  shape: 'singleton',
  wrap: 'singleton',
  detail: 'singleton',
  envelope: 'envelope',
  pick: 'envelope',
  latency: 'latency',
  error: 'passthrough-error',
  passthrough: 'passthrough-error'
};

/** Claves del escenario que no son de endpoint y también tienen capacidad. */
export const SCENARIO_KEY_COVERAGE = {
  writes: 'writes',
  rpc: 'rpc',
  streams: 'streams',
  auth: 'world-filters'
};

/** La tabla completa, en Markdown, para `references/capabilities.md`. */
export function renderCapabilities() {
  const runtimes = RUNTIMES.filter((r) => r !== 'builtin');
  const icon = { same: '✅', partial: '◐', declined: '✖', different: '⚠' };
  const head = `| Capacidad | ${runtimes.join(' | ')} |`;
  const sep = `|---|${runtimes.map(() => '---').join('|')}|`;
  const rows = CAPABILITIES.map((c) => {
    const cells = runtimes.map((r) => icon[stateOf(c.id, r)]);
    return `| \`${c.id}\` · ${c.label} | ${cells.join(' | ')} |`;
  });
  const notes = [];
  for (const c of CAPABILITIES) {
    for (const r of runtimes) {
      const st = stateOf(c.id, r);
      if (st !== 'same' && c.notes?.[r]) notes.push(`- **${c.id} × ${r}** (${STATE_LABEL[st]}): ${c.notes[r]}`);
    }
  }
  return [
    '# Capacidades por runtime',
    '',
    'Generado por `scripts/lib/capabilities.mjs` (`node scripts/cli.mjs capabilities --write`). No editar a mano.',
    '',
    '`builtin` es el motor y el oráculo: siempre `✅`. ✅ igual · ◐ parcial y declinado el resto · ✖ no soportado y declarado · ⚠ **distinto sin avisar** (es lo que hay que cerrar).',
    '',
    head,
    sep,
    ...rows,
    '',
    '## Por qué cada celda no es ✅',
    '',
    ...notes,
    ''
  ].join('\n');
}
