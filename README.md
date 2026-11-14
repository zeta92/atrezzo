# atrezzo

A Claude Code plugin that generates and serves **API mocks from application states**, not from isolated endpoints.

- You declare a **world**: an entity graph with a fixed seed (3 customers, 40 orders, 3 with an issue).
- Each endpoint is a deterministic **projection** of that world: filters, pagination, sorting, joins.
- A versioned **scenario** (YAML) bundles world + screen path + assertions (`12 rows`, `3 issue badges`).
- The output is **code**: `atrezzo world` writes readable modules (JSON + MSW handlers + engine) that you commit and review in the PR.
- There is a **verification loop**: serve → open the screen → count the DOM → compare → if it does not match, **diagnose** (do not regenerate blindly).

## Hard rules

1. **Determinism.** Same seed ⇒ same data, byte for byte. Generation never calls `Math.random()` or `Date.now()` (a test checks this); "now" is injected with `now:` in the scenario. Custom PRNG (xmur3 + sfc32) with one stream per entity: adding an entity does not change the others.
2. **Referential integrity.** Every fk in a projection exists in the world. Never `user_id: 42` without a 42. `world` checks this before writing.
3. **The LLM picks distributions and narrative; the code produces the data.** The skills forbid hand-writing data JSON: you change the scenario and regenerate.
4. **The mock shapes data; it does not implement business rules.** GET only; writes ⇒ 405. No recomputing totals, no simulating RLS.

## Breaking changes

### Unreleased (after 0.3.0): English DSL, CLI and output

The whole user surface is now in English. There is no backward compatibility (pre-1.0): Spanish keys are rejected as `unknown field`. Rename them in your scenarios and flows:

| where | old | new |
|---|---|---|
| scenario `world.<entity>` | `distribucion` | `distribution` |
| | `campo_distribucion` | `distribution_field` |
| | `valor: { min, max, moneda }` | `amount: { min, max, currency }` |
| | `nulos` | `nulls` |
| | `valores` | `values` |
| | `dias` | `days` |
| | `campos` | `fields` |
| `fields` types | `texto`, `entero`, `numero`, `booleano`, `fecha` | `string`, `integer`, `number`, `boolean`, `date` (`email`, `uuid`, `url` unchanged) |
| flow | `escenario` | `scenario` |
| `serve` flags | `--escenario`, `--escenarios` | `--scenario`, `--scenarios` |
| `POST /__atrezzo/reset` | `{"escenario":"x"}`, `?escenario=x` | `{"scenario":"x"}`, `?scenario=x` |
| `GET /__atrezzo/state` | `escenario`, `disponibles`, `generado` (`"al día"`) | `scenario`, `available`, `generated` (`"up to date"`) |
| misses (`/__atrezzo/misses`, `misses --json`, `state.misses`) | `sinResolver`, `borrados` | `unresolved`, `cleared` |
| 404/405 body for a gap | `atrezzo.hueco`, `veces`, `siguiente` | `atrezzo.gap`, `times`, `next` |
| `misses.json` entry | `ejemplo` | `example` |
| response header | `x-atrezzo-escenario` | `x-atrezzo-scenario` |
| `verify --json` hypotheses | `{ tipo, confianza, evidencia }`, `alta`/`media`/`baja` | `{ type, confidence, evidence }`, `high`/`medium`/`low` |
| hypothesis types | `respuesta-no-200`, `filtro-no-declarado`, `paginacion-desalineada`, `deduplicacion-por-id`, `campo-nulo`, `filtro-en-cliente`, `mundo-distinto`, `sin-datos`, `sin-hipotesis`, `navegacion` | `non-200-response`, `undeclared-filter`, `pagination-mismatch`, `dedupe-by-id`, `null-field`, `client-side-filter`, `world-mismatch`, `no-data`, `no-hypothesis`, `navigation` (`render` unchanged) |
| Prism example key | `escenario` (`Prefer: example=escenario`) | `scenario` |
| Prism operationIds | `listar_*`, `detalle_*` | `list_*`, `detail_*` |
| WireMock 501 body | `generadas` | `generated` |
| config `stack` default | `otro` | `other` |

Unchanged: directory and file names (`atrezzo/escenarios/`, `atrezzo/flujos/`, skill commands such as `/atrezzo:escena`), the built-in entity templates (`clientes`, `pedidos`… and their fields `nombre`, `estado`, `importe`, `creado_en`), and generated data. A scenario rewritten with the new keys keeps its hash, so committed `.generated/` files stay up to date. The exception is scenarios with `fields`: the type names are part of the normalized scenario, so their hash changes; run `atrezzo world` once (`doctor` flags them as stale).

## Installation

```bash
claude --plugin-dir /path/to/atrezzo          # for one session
# or publish it to a marketplace and: claude plugin install atrezzo@<marketplace>
```

Requirements: Node ≥ 22. No runtime dependencies (own YAML parser and server). Optional in the project: `msw` (browser/test handlers) and `playwright` or `playwright-core` (DOM driver). With `playwright-core` the system Chromium is used (`/usr/bin/chromium`; another binary with `ATREZZO_CHROME=/path`); the package is loaded lazily and, if missing, `verify --driver playwright` exits with 2.

## Skills

| command | what for |
|---|---|
| `/atrezzo:atrezzo` | router: picks the right skill and explains the loop |
| `/atrezzo:init` | inspects the repo and runs `init` (installs nothing without saying so) |
| `/atrezzo:captura` | contract: OpenAPI/types → HAR (with scripts) → code; flags gaps |
| `/atrezzo:escena` | intent ("12 rows, 3 with an issue") → versioned scenario |
| `/atrezzo:verifica` | serves, verifies and diagnoses before touching the scenario |
| `/atrezzo:desde-intencion` | "I'm on X, I want Y" → state path, scenarios per step, gaps |
| `/atrezzo:hueco` | the app requests a route the scenario lacks → finds the consumer and the contract, patches the scenario, reloads and checks |

> In Claude Code 2.1.319 a plugin skill's command is `/<plugin>:<directory>`; the frontmatter `name:` does not change it. That is why the commands carry the directory name.

## CLI

```
node scripts/cli.mjs init [--dir .] [--runtime auto|builtin|msw|supabase|prism|wiremock] [--front <path> --backend <path>] [--contract <spec>] [--install] [--force]
node scripts/cli.mjs runtimes
node scripts/cli.mjs import [<openapi.yaml|json>] [--name api] [--base /api] [--format yaml|json] [--force]
node scripts/cli.mjs world <scenario.yaml> [--out dir]
node scripts/cli.mjs serve [--scenario demo] [--port 4010] [--static dir] [--runtime builtin] [--on-miss log|stub]
node scripts/cli.mjs misses [--json] [--clear]
node scripts/cli.mjs verify <flow.yaml> [--url …] [--driver http|playwright] [--diagnose] [--no-reset] [--json]
node scripts/cli.mjs doctor
```

- `init` detects a monorepo (pnpm/npm/yarn workspaces, turbo, nx, lerna) or `client/`+`server/` folders, the runtime, and the `baseUrl` the front end calls, and **prints what it found, why, and which alternatives there were**. With two front ends or none, it does not guess: candidate table and exit 2.
- `world` always writes `<scenario>.json` + `runtime.mjs` (source of truth), then the runtime output: MSW handlers, `seed.sql`/`reset.sh`, OpenAPI for Prism or WireMock mappings. See [`references/runtimes.md`](references/runtimes.md).
- `import` infers a scenario from an OpenAPI spec (entities, typed fields, `{data: […]}` envelopes → `pick`, enum filters, pagination) with a report of what it could not infer.

Exit codes: `0` OK · `1` assertion failed · `2` not verifiable (no mock, no playwright, or an assertion without data; **never** reported as OK) · `3` invalid input.

`serve` exposes `GET /api/<resource>?limit=&offset=&<filters>`, the `/<resource>/:id` detail, `POST /__atrezzo/reset {"scenario":"x"}`, `POST /__atrezzo/reload` (rereads the current scenario's YAML), `GET /__atrezzo/state` and `GET|DELETE /__atrezzo/misses`. It uses the same engine (`scripts/lib/contract.mjs`) as the MSW handlers: `world` copies it byte for byte as `runtime.mjs`.

## When a route is missing

If the app requests something the scenario does not declare, `serve` does more than return 404: it **records the gap** and says what to do.

```
$ curl -s localhost:4010/api/users
{"error":"GET /api/users is not in the contract of scenario \"catalogo\"",
 "atrezzo":{"miss":true,"gap":"GET /api/users","times":3,"next":"atrezzo misses","endpoints":["/api/products"]}}

$ atrezzo misses
GET /api/users      3 times    unresolved  12 s ago    → the contract has it (GET /users) → atrezzo import api/openapi.yaml
GET /api/invoices   1 time     unresolved  40 s ago    → not in the contract → add the endpoint to the scenario (skill /atrezzo:hueco)
POST /api/orders    2 times    unresolved  1 min ago   → mutation: atrezzo only projects reads → serve --on-miss stub (or leave it unresolved)
```

- Stored in `atrezzo/.atrezzo/misses.json` (next to `.generated/`; the folder has its own `.gitignore`): an object keyed by `METHOD path` with `method`, `path`, `example`, `query`, `times`, `first_seen`, `last_seen`, `referer`, `accept`, `resolved`. The same route only increments `times`; id-like segments (`/users/42`, UUID, long hex) collapse to `:id`, and there is a cap of 200 entries (the oldest resolved ones go first).
- `query` and `referer` are stored without secrets: parameters such as `token`, `api_key`, `password`, `session`, `auth`, `signature`… and values shaped like a JWT or a long key come out as `***`; the referer, without its query. The `serve` log masks them too.
- Not gaps: static files (`/favicon.ico`, `.js`, `.css`, images, fonts) and `/__atrezzo/*` routes. Writes to a contract route are gaps (`POST /api/orders` → 405 with the same body).
- Once you add the endpoint, run `atrezzo world` and `POST /__atrezzo/reload`; the next request served marks the gap `resolved: true`. `doctor` warns about the unresolved ones.
- `atrezzo serve --on-miss stub` answers 200 with `[]` (collection-looking route) or `{}` (detail, singular or write) and `x-atrezzo-stub: true`, so you can explore without the screen crashing. It is still recorded and does **not** count as resolved. It is never the default.

To fill it, the `/atrezzo:hueco` skill finds who makes the call in the front end and which fields it reads, uses the contract as the source of truth for the shape, and adds entity + endpoint to the scenario (the world still generates the data). Only `serve` records gaps; what happens in the other runtimes is in [`references/runtimes.md`](references/runtimes.md#gaps-in-each-runtime).

## Projects with and without Supabase

The scenario is the same in both cases; what changes is **where it is served**.

### Without Supabase: Vite front end + own API with OpenAPI

```
tienda/
  package.json          react, vite, msw (dev)
  vite.config.ts        server.proxy['/api'] → { target: 'http://localhost:3000' }
  api/openapi.yaml      (the one in tests/fixtures/petstore.yaml: GET/POST /pets, /pets/{petId}, /owners → {data: [...]}, /health, PNG photo)
```

```bash
cd tienda
atrezzo init
#   Layout:
#     single project (no monorepo or front/back folders): everything lives at the root
#     contract found: api/openapi.yaml (use it with: atrezzo import)
#     mock baseUrl: http://localhost:3000 (Vite proxy "/api" → http://localhost:3000 in vite.config.ts)
#   Runtime: msw — score 3/3: msw in package.json
#     → msw       3/3  msw in package.json
#       builtin   1/3  universal fallback: real HTTP with no dependencies, works with any backend or language
#       prism     1/3  contract api/openapi.yaml (weak signal: prefer `atrezzo import api/openapi.yaml`; prism is not needed to use it)
atrezzo import api/openapi.yaml --name tienda
#   Inferred endpoints (2):
#     GET /api/pets → pets · array            filters: status · pagination: limit/offset · detail: /api/pets/:id
#     GET /api/owners → owners · envelope {data: [...]} → pick: data · pagination: page/per_page
#   Ignored (3): POST /pets (mutation) · GET /health (200 without schema) · GET /pets/{petId}/photo (binary response)
#   Written: atrezzo/escenarios/tienda.yaml (valid scenario)
# adjust counts/distribution/expect (skill /atrezzo:escena) and generate:
atrezzo world atrezzo/escenarios/tienda.yaml
#   atrezzo/.generated/tienda.json · runtime.mjs · tienda.handlers.mjs
```

In `src/main.tsx` (development only): `setupWorker(...handlers).start({ onUnhandledRequest: 'bypass' })` with `handlers` from `atrezzo/.generated/tienda.handlers.mjs`. For E2E or an API in another language: `atrezzo serve --scenario tienda --port 3000` (the Vite proxy points there) and `atrezzo verify flujo.yaml`. If the team already runs WireMock or Prism, `atrezzo init --force --runtime wiremock` (or `prism`) and `world` emits their files; what they do not do is in `references/runtimes.md`.

### With Supabase: Next + supabase-js + Supabase CLI

```
app/
  package.json          next, @supabase/supabase-js
  supabase/config.toml  (supabase init)
  .env.local            NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
```

A scenario with the table names the app queries (`supabase.from('pedidos')`):

```yaml
name: pedidos-incidencias
seed: 7712
world:
  clientes: 3
  pedidos: { total: 40, distribution: { pagado: 34, pendiente: 3, incidencia: 3 } }
endpoints:
  - path: /rest/v1/pedidos
    entity: pedidos
    filters: [estado]
```

```bash
atrezzo init
#   Runtime: supabase — score 3/3: supabase/config.toml (Supabase CLI project); @supabase/supabase-js in package.json; NEXT_PUBLIC_SUPABASE_URL in .env.local
atrezzo world atrezzo/escenarios/pedidos-incidencias.yaml
#   supabase/atrezzo/pedidos-incidencias/{schema.sql, seed.sql, reset.sh, README.md}
supabase start
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres supabase/atrezzo/pedidos-incidencias/reset.sh
#   atrezzo: scenario pedidos-incidencias restored (43 rows)
```

The app talks to its usual local Supabase; `pedidos` has exactly 40 rows, 3 with `estado = 'incidencia'`, with the same ids you would see in `serve`. `reset.sh` is idempotent (truncate + inserts) and refuses to touch a non-local `DATABASE_URL`. What it does **not** do: simulate RLS or auth, or use the atrezzo engine (filters and pagination are PostgREST's). For component tests without a database, add MSW with a facade (`--runtime supabase,msw`; see `references/runtimes.md`).

## Layout

```
.claude-plugin/plugin.json   manifest
skills/                      router + 6 skills
scripts/cli.mjs              CLI (bin: atrezzo)
scripts/lib/                 prng, yaml, yaml-emit, world, scenario, contract, codegen, serve, verify, doctor, init, config,
                             project (monorepo/front/back), openapi (import), flows, misses (gaps)
scripts/lib/runtimes/        builtin, msw, supabase, prism, wiremock + registry (index.mjs)
references/                  escenario.md (scenario spec) · suposiciones.md (client assumptions) · runtimes.md (runtimes, monorepo)
examples/tienda/             runnable end-to-end example
tests/                       node --test tests/ (fixtures/petstore.yaml for import)
```

## Example

See [`examples/tienda`](examples/tienda/README.md): `world` → `serve` → `verify --driver http` green, and `reset` between scenarios without restarting.

## Known limits

- YAML: a subset (no anchors/aliases/multi-document); the parser rejects them with line and reason.
- The `playwright` driver is tested with a fake `page` and with real Chromium (`tests/headers.test.mjs`; skipped without `playwright-core` + Chromium). For apps with a session, the flow can declare `headers` (e.g. `Cookie: "${APP_COOKIE}"`); see `references/escenario.md`.
- HTTP errors, latency and writes are not part of the world: inject them in the runtime (see `references/runtimes.md`).
- Runtimes: only `builtin` and `msw` run the projection. **Prism** returns examples (no filtering or pagination); **WireMock** serves pre-generated combinations and answers 501 to the rest; **Supabase** loads the world into Postgres and responses take PostgREST's shape. Details in `references/runtimes.md`.
- Gaps: only `atrezzo serve` records them (not MSW, Prism, WireMock or Supabase). A route requested with different prefixes (`/api/users` and `/users`) counts as two gaps. Nested routes (`/api/clientes/:id/pedidos`) are recorded but the engine does not project them. `--on-miss stub` does not persist writes.
- `import`: GET collections only (array of objects or a `data`/`items`/`results`/`records`/`content` envelope); nested fields are skipped (the report says so); ids are always integers 1..n; no external `$ref`; YAML specs with anchors or multi-line `{…}` collections → convert them to JSON.
