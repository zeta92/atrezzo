// One table of what each runtime reproduces, and how faithfully.
//
// Everything that warns the user (world, doctor, adapters) reads from here: if the
// table and the code drift apart, the warning lies, which is worse than no warning.
// `builtin` is the oracle and is always `same`; the other columns say where they
// differ and why. The states are:
//
//   same      · behaves like the engine
//   partial   · covers part of it and explicitly declines the rest
//   declined  · not supported, and the artifact says so (a 501 or a warning)
//   different · behaves differently: the scenario is not reproduced
//
// `different` is the dangerous state: it is the one that needed a name.

import { RUNTIMES } from './config.mjs';

export const STATES = ['same', 'partial', 'declined', 'different'];

export const STATE_LABEL = {
  same: 'same',
  partial: 'partial',
  declined: 'not supported (declared)',
  different: 'different'
};

const anyEndpoint = (s, fn) => s.endpoints.some(fn);
const hasHeaders = (h) => Boolean(h && typeof h === 'object' && Object.keys(h).length > 0);
const hasWriteHeaders = (s) => (s.writes ?? []).some((w) => hasHeaders(w.expect?.headers) || (w.cases ?? []).some((c) => hasHeaders(c.expect?.headers)));

/**
 * Each capability: how to tell that the scenario uses it, and what each runtime
 * does with it. `notes` only exist for the columns that are not `same`.
 */
export const CAPABILITIES = [
  {
    id: 'filters',
    label: 'filters (equality, `a,b`, `null`)',
    present: (s) => anyEndpoint(s, (ep) => ep.filters?.length),
    states: { msw: 'same', supabase: 'different', prism: 'declined', wiremock: 'partial' },
    notes: {
      supabase: 'PostgREST compares with its own types: `null` and lists do not behave the same',
      prism: 'does not evaluate filters: it returns the example from the spec',
      wiremock: 'one value per filter; other combinations end in 501'
    }
  },
  {
    id: 'pgrst-operators',
    label: 'PostgREST operators (`eq.`, `in.()`, `ilike.`)',
    // Decided by the client's query (`?id=eq.3`), not by the scenario: there is
    // nothing to detect when generating, so it can never show up in the warnings.
    present: () => false,
    states: { msw: 'same', supabase: 'same', prism: 'declined', wiremock: 'partial' },
    notes: {
      prism: 'does not evaluate operators',
      wiremock: 'one operator per mapping; the rest end in 501'
    }
  },
  {
    id: 'pagination',
    label: 'pagination (`limit`/`offset`/`page`)',
    present: (s) => anyEndpoint(s, (ep) => ep.pagination),
    states: { msw: 'same', supabase: 'different', prism: 'declined', wiremock: 'partial' },
    notes: {
      supabase: 'PostgREST pages with `Range`; the `limit` in the query is not the same cut',
      prism: 'ignores the pagination parameters',
      wiremock: 'only the pages listed in the flows; the rest end in 501'
    }
  },
  {
    id: 'sorts',
    label: 'ordering (`sort` and `sorts`)',
    present: (s) => anyEndpoint(s, (ep) => ep.sorts || (ep.sort ?? []).length > 1),
    states: { msw: 'same', supabase: 'different', prism: 'different', wiremock: 'partial' },
    notes: {
      supabase: 'PostgREST sorts in SQL: nulls and `nullsfirst` do not land where they land here',
      prism: 'declares the parameter and ignores it: the order is the example\'s',
      wiremock: 'only the requests that appear in the flows'
    }
  },
  {
    id: 'scopes',
    label: 'scopes (parameter → boolean filter)',
    present: (s) => anyEndpoint(s, (ep) => ep.scopes),
    states: { msw: 'same', supabase: 'different', prism: 'different', wiremock: 'partial' },
    notes: {
      supabase: 'the filter has to exist in the view; otherwise PostgREST answers with its own error',
      prism: 'does not evaluate the parameter',
      wiremock: 'one value per scope'
    }
  },
  {
    id: 'envelope',
    label: 'envelope (`envelope`, `pick`, `total_pages`)',
    present: (s) => anyEndpoint(s, (ep) => ep.envelope || ep.pick),
    states: { msw: 'same', supabase: 'different', prism: 'different', wiremock: 'same' },
    notes: {
      supabase: 'PostgREST decides the shape (an array or `{data,count}`), not the envelope',
      prism: 'the OpenAPI schema does not declare `total_pages`: only the example carries it, so dynamic mode (`-d`) and schema validation leave it out'
    }
  },
  {
    id: 'singleton',
    label: 'detail and singleton (`shape: object`, `wrap`, `/:id`)',
    present: (s) => anyEndpoint(s, (ep) => ep.shape === 'object' || ep.wrap || ep.detail),
    states: { msw: 'same', supabase: 'different', prism: 'partial', wiremock: 'same' },
    notes: {
      supabase: '`.single()` needs `Accept: application/vnd.pgrst.object+json`',
      prism: 'always returns the first row of the example'
    }
  },
  {
    id: 'relations',
    label: 'relations (`include`, `embed`, `counts`, `pluck`)',
    present: (s) => anyEndpoint(s, (ep) => ep.include?.length || ep.embed || ep.counts?.length || ep.pluck),
    states: { msw: 'same', supabase: 'different', prism: 'same', wiremock: 'same' },
    notes: {
      supabase: 'the embed has to be a real foreign key, and the projection is requested differently'
    }
  },
  {
    id: 'nested-routes',
    label: 'routes with path parameters (`/api/customers/:customer_id/orders`)',
    present: (s) => anyEndpoint(s, (ep) => ep.params?.length > 0),
    states: { msw: 'same', supabase: 'different', prism: 'different', wiremock: 'different' },
    notes: {
      supabase: 'each segment is a table or a view',
      prism: 'the example is the projection for the first row\'s values: any other parameter value gets the same rows',
      wiremock: 'no mapping is generated for routes with path parameters unless they declare `error` or `passthrough` (only a note at generation time): they answer 404'
    }
  },
  {
    id: 'world-filters',
    label: 'world filters and `$user`',
    present: (s) => anyEndpoint(s, (ep) => ep.worldFilters?.length || ep.userFilters?.length),
    states: { msw: 'same', supabase: 'different', prism: 'same', wiremock: 'same' },
    notes: {
      supabase: 'the per-user filter comes from RLS, not from the scenario'
    }
  },
  {
    id: 'writes',
    label: 'writes and `reset` (`writes`)',
    present: (s) => (s.writes ?? []).length > 0,
    states: { msw: 'same', supabase: 'different', prism: 'different', wiremock: 'different' },
    notes: {
      supabase: 'writes for real to Postgres: resetting the world does not undo them',
      prism: 'the write routes are not emitted and there is no 501: they answer 404',
      wiremock: 'the write routes are not emitted and there is no 501: they answer 404'
    }
  },
  {
    id: 'write-cases',
    label: 'body-conditioned write branches (`writes.*.cases`)',
    present: (s) => (s.writes ?? []).some((w) => w.cases?.length > 0),
    states: { msw: 'same', supabase: 'different', prism: 'different', wiremock: 'different' },
    notes: {
      supabase: 'Postgres/PostgREST does not evaluate declarative `cases` request-body predicates or mock fallback/422 branches',
      prism: 'write routes and `cases` predicates are not emitted and there is no 501: they answer 404',
      wiremock: 'write routes and `cases` predicates are not emitted and there is no 501: they answer 404'
    }
  },
  {
    id: 'rpc',
    label: '`rpc` functions',
    present: (s) => (s.rpc ?? []).length > 0,
    states: { msw: 'same', supabase: 'different', prism: 'different', wiremock: 'different' },
    notes: {
      supabase: 'the function has to exist in Postgres; the scenario does not create it',
      prism: 'the endpoint is not emitted and there is no 501: it answers 404',
      wiremock: 'the endpoint is not emitted and there is no 501: it answers 404'
    }
  },
  {
    id: 'streams',
    label: 'SSE (`streams`)',
    present: (s) => (s.streams ?? []).length > 0,
    states: { msw: 'declined', supabase: 'different', prism: 'different', wiremock: 'different' },
    notes: {
      msw: 'an explicit 501 on the stream route: the flow sees the warning, not the events',
      supabase: 'PostgREST has no SSE',
      prism: 'the endpoint is not emitted and there is no 501: it answers 404',
      wiremock: 'the endpoint is not emitted and there is no 501: it answers 404'
    }
  },
  {
    id: 'passthrough-error',
    label: '`passthrough` and `error`',
    present: (s) => anyEndpoint(s, (ep) => ep.passthrough || ep.error),
    states: { msw: 'same', supabase: 'different', prism: 'same', wiremock: 'same' },
    notes: {
      supabase: 'the adapter only emits SQL: neither the recorded fixture nor the declared error reaches PostgREST'
    }
  },
  {
    id: 'latency',
    label: 'latency (`latency`)',
    present: (s) => anyEndpoint(s, (ep) => ep.latency !== undefined),
    states: { msw: 'same', supabase: 'different', prism: 'different', wiremock: 'different' },
    notes: {
      supabase: 'the latency is whatever Postgres takes',
      prism: 'does not apply `latency`',
      wiremock: 'has `fixedDelayMilliseconds`, but the generated mappings do not use it'
    }
  },
  {
    id: 'diagnostic-headers',
    label: 'diagnostic headers (`X-Total-Count`, `X-Atrezzo-*`)',
    present: (s) => s.endpoints.length > 0,
    states: { msw: 'same', supabase: 'declined', prism: 'partial', wiremock: 'partial' },
    notes: {
      supabase: 'PostgREST sets the headers (`Content-Range`)',
      prism: 'only the example\'s total, no `X-Atrezzo-Ignored`',
      wiremock: 'the total, yes; `X-Atrezzo-Ignored`, no'
    }
  },
  {
    id: 'response-headers',
    label: 'response headers (endpoint and passthrough fixture)',
    present: (s) => anyEndpoint(s, (ep) => hasHeaders(ep.headers) || hasHeaders(s._passthrough?.[ep.path]?.headers)) || hasWriteHeaders(s),
    states: { msw: 'partial', supabase: 'declined', prism: 'partial', wiremock: 'same' },
    notes: {
      msw: 'Node preserves multiple `Set-Cookie` values; browsers may block scripted `Set-Cookie`',
      supabase: 'PostgREST controls HTTP headers',
      prism: 'OpenAPI scalar headers are supported, but `Set-Cookie` is omitted to avoid merging distinct values'
    }
  }
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

/** The state of a capability in a runtime: `same` | `partial` | `declined` | `different`. */
export function stateOf(id, runtime) {
  const cap = BY_ID.get(id);
  if (!cap) throw new Error(`unknown capability: ${id}`);
  if (runtime === 'builtin') return 'same';
  return cap.states[runtime] ?? 'declined';
}

/** The capabilities this scenario really uses, with the state in each runtime. */
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
 * What to tell someone about to generate for `runtime`: every capability the
 * scenario uses that is not reproduced the same way, with the reason.
 */
export function degradations(scenario, runtime) {
  if (runtime === 'builtin') return [];
  return usedCapabilities(scenario)
    .filter((c) => c.states[runtime] && c.states[runtime] !== 'same')
    .map((c) => ({ id: c.id, label: c.label, state: c.states[runtime], note: c.notes?.[runtime] ?? null }));
}

/** `writes, rpc, latency`: the short list that fits in a one-line warning. */
export function degradationList(scenario, runtime) {
  return degradations(scenario, runtime).map((d) => d.id);
}


/**
 * Which capability covers each DSL key. `core` is what no runtime can lack (the
 * path and the entity). It lives here so that a new key in `scenario.mjs` without
 * an entry breaks a test instead of going unnoticed.
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
  passthrough: 'passthrough-error',
  headers: 'response-headers'
};

/** Every scenario-level key (`SCENARIO_KEYS`): its capability, or `core` when every runtime reproduces it. */
export const SCENARIO_KEY_COVERAGE = {
  name: 'core',
  description: 'core',
  seed: 'core',
  now: 'core',
  world: 'core',
  endpoints: 'core',
  entry: 'core',
  path: 'core',
  expect: 'core',
  writes: 'writes',
  rpc: 'rpc',
  streams: 'streams',
  auth: 'world-filters'
};

/** The full table, in Markdown, for `references/capabilities.md`. */
export function renderCapabilities() {
  const runtimes = RUNTIMES.filter((r) => r !== 'builtin');
  const icon = { same: '✅', partial: '◐', declined: '✖', different: '⚠' };
  const head = `| Capability | ${runtimes.join(' | ')} |`;
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
    '# Capabilities by runtime',
    '',
    'Generated by `scripts/lib/capabilities.mjs` (`node scripts/cli.mjs capabilities --write`). Do not edit by hand.',
    '',
    '`builtin` is the engine and the oracle: always `✅`. ✅ same · ◐ partial, the rest declined · ✖ not supported, and declared · ⚠ **different without a warning** (what still has to be closed).',
    '',
    'The `msw` cells are checked in `tests/parity.test.mjs` (fast, with a stub that runs the handlers) and in `tests/parity-real.test.mjs` (real `msw/node`, `ATREZZO_PARITY=real`, nightly), with `write-cases` covered in its dedicated `tests/write-cases.test.mjs`. A cell without a test is a promise.',
    '',
    head,
    sep,
    ...rows,
    '',
    '## Why each cell is not ✅',
    '',
    ...notes,
    ''
  ].join('\n');
}
