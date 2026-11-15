<p align="center">
  <img src="https://raw.githubusercontent.com/zeta92/atrezzo/media/assets/readme/hero.png" width="100%" alt="atrezzo: API mocks built from application states, not from isolated endpoints. A seeded world of 40 orders, 3 with an issue, projected onto a screen as 12 rows and 3 issue badges.">
</p>

<p align="center">
  <a href="https://github.com/zeta92/atrezzo/actions/workflows/test.yml"><img src="https://github.com/zeta92/atrezzo/actions/workflows/test.yml/badge.svg" alt="tests"></a>
</p>

**atrezzo** is a Claude Code plugin for API mocks. You describe one application state: a seeded world of entities, such as 3 customers and 40 orders, 3 of them with an issue. Every endpoint is a deterministic projection of that world. A versioned YAML scenario ties the world to the screen and to what the screen must show. `verify` opens the screen, counts the DOM and, when the count is wrong, tells you why.

```text
/plugin marketplace add zeta92/atrezzo
/plugin install atrezzo@atrezzo
```

The first line registers this repository as a marketplace; the second installs the plugin from it.
If you already have a checkout of this repository, you can load the plugin straight from it instead:

```bash
claude --plugin-dir <path-to-your-checkout>
```

<h2><img src="https://raw.githubusercontent.com/zeta92/atrezzo/media/assets/readme/section-01-see-it-work.png" width="100%" alt="01 See it work"></h2>

<p align="center">
  <img src="https://raw.githubusercontent.com/zeta92/atrezzo/media/assets/readme/atrezzo-story.gif" width="100%" alt="18-second explainer in five beats: per-endpoint fixtures drift apart while one seeded world stays locked; every endpoint is a projection of that world; the projections populate the real page; verify counts the rendered DOM and reports 2 against 3 as a pagination mismatch with the mock untouched; the fixed flow is green.">
</p>

All output below is literal, cut only where a block says so. It comes from [`examples/tienda`](examples/tienda/README.md) unless a block says otherwise. In this README, `atrezzo` is short for `node <plugin>/scripts/cli.mjs`. Inside Claude Code, the skills run it for you.

### The screen matches the scenario

```text
$ atrezzo verify flow.yaml --driver http
Scenario: orders (seed 7712) · driver: http · http://127.0.0.1:4010

#  screen      selector                                                        expected  obtained  result
-  ----------  --------------------------------------------------------------  --------  --------  ------
1  dashboard   [data-testid=customer-chip]                                     =3        3         OK
2  order-list  [data-testid=order-row] [data-testid=amount] (visible amounts)  1..12     12        OK
3  order-list  [data-testid=order-row]                                         =12       12        OK
4  order-list  [data-testid=issue-badge]                                       =3        3         OK

4 OK · 0 KO · 0 not verified → GREEN
```

### When it does not match, it says why

`flow-broken.yaml` is wrong on purpose. It counts the issues inside the first page of 12 instead of asking the API for them. Output abridged to the result table:

```text
$ atrezzo verify flow-broken.yaml --diagnose
1  order-list  [data-testid=order-row] [data-status=issue]  =3        2         KO
2  order-list  [data-testid=order-row]                      =12       12        OK
3  order-list  [data-testid=issue-badge]                    =3        3         OK
  #1 hypothesis [high] pagination-mismatch: the response has 12 of 40 items; unpaginated, 3 match the condition, but this page has only 2. Check the client's limit/offset or the endpoint's sort.

2 OK · 1 KO · 0 not verified → RED
```

`verify` compares the DOM with the JSON the request returned. It does not regenerate data until the numbers happen to match.

### No session means red, never green

One flow, run twice with the Playwright driver (real Chromium) against a small cookie-protected app. That app is a scratch server, not part of this repo; the same case runs in `tests/headers.test.mjs` if you want to reproduce it. The flow holds no session; you hand it to `verify` with `--header`, and your shell fills in the value. atrezzo reads no environment variable. Abridged: the table headers are cut.

```text
$ atrezzo verify flow.yaml --driver playwright --header "Cookie: $SESSION"     # SESSION=session=valid
Headers: Cookie: ***
1  customers  table tbody tr (customer rows)  =6        6         OK
1 OK · 0 KO · 0 not verified → GREEN

$ atrezzo verify flow.yaml --driver playwright --header "Cookie: $SESSION"     # SESSION=session=expired
Headers: Cookie: ***
1  customers  table tbody tr (customer rows)  =6        0         KO
  #1: the app redirected /customers → /login?next=%2Fcustomers (login screen: no session or session expired; check the flow headers/Cookie)
0 OK · 1 KO · 0 not verified → RED
```

If the final URL is not the one the step asked for, the step fails even when the count would match. Secrets in `Cookie` and `Authorization` print as `***`.

`--header "Cookie: $SESSION"` keeps the value out of your shell history (the history holds `$SESSION`), but the expanded value is in the process arguments, which `ps` shows while `verify` runs. To keep it out of those as well, pipe it in: `printf 'Cookie: %s\n' "$SESSION" | atrezzo verify flow.yaml --header @-` (`printf` is a shell builtin, so it never shows up as a process).

### A scenario from an OpenAPI spec

Run on `tests/fixtures/petstore.yaml`, copied to `api/openapi.yaml` (abridged):

```text
$ atrezzo import api/openapi.yaml --name shop
Inferred endpoints (2):
  GET /api/pets → pets · array
      filters: status · pagination: param_limit=limit param_offset=offset default_limit=20 max_limit=100 · detail: /api/pets/:id (from /pets/{petId})
  GET /api/owners → owners · envelope {data: [...]} → pick: data
Ignored (3):
  POST /pets: mutation not supported: atrezzo only projects reads (GET)
  GET /health: 200 without schema (no content)
  GET /pets/{petId}/photo: binary/non-JSON response (image/png)
Written: atrezzo/scenarios/shop.yaml (valid scenario)
```

### A missing route becomes a task

The app asks for a route the scenario does not declare. The mock answers with a 404 that says what to do, and records the request:

```text
$ curl -s "localhost:4010/api/users?limit=5"
{"error":"GET /api/users is not in the contract of scenario \"orders\"","atrezzo":{"miss":true,"gap":"GET /api/users","times":1,"next":"atrezzo misses","endpoints":["/api/orders","/api/customers"]}}

$ atrezzo misses
atrezzo misses · atrezzo/.atrezzo/misses.json · no workspace.contract
GET /api/users   1 time     unresolved  0 s ago       → add the endpoint to the scenario (skill /atrezzo:gap)
1 gap · 1 unresolved
Details per gap (query, referer, accept): atrezzo misses --json · clear: atrezzo misses --clear
```

`/atrezzo:gap` finds the front-end code that makes the call and the fields it reads, then adds the endpoint to the scenario. Here the patch is two lines (`- path: /api/users`, `entity: users`). After a hot reload, with no restart, the next request is served and the gap closes:

```text
$ curl -s -o /dev/null -X POST localhost:4010/__atrezzo/reload    # rereads the scenario YAML
$ atrezzo misses
atrezzo misses · atrezzo/.atrezzo/misses.json · no workspace.contract
GET /api/users   1 time     resolved    5 s ago
1 gap · 0 unresolved
```

Run `atrezzo world` afterwards so the committed `.generated/` files match the new scenario. `doctor` flags them as stale until you do.

<h2><img src="https://raw.githubusercontent.com/zeta92/atrezzo/media/assets/readme/section-02-how-it-works.png" width="100%" alt="02 How it works"></h2>

<p align="center">
  <img src="https://raw.githubusercontent.com/zeta92/atrezzo/media/assets/readme/how-it-works.png" width="100%" alt="Four stages: scenario, world, projection, screen. verify --diagnose and atrezzo misses lead back from the screen to the scenario.">
</p>

A mock built endpoint by endpoint is a set of canned responses. They drift apart, ids point nowhere, and a list of 40 orders has no reason to agree with a badge that says 3 issues. atrezzo starts from the state instead:

- **A world, not responses.** The scenario declares entities and their distribution. A seeded PRNG builds the world with one stream per entity. The same seed gives the same bytes. Generation never calls `Math.random()` or `Date.now()`, and a test checks this. Every foreign key points to a row that exists (or is null where the scenario asks for `nulls:`).
- **Endpoints are projections.** An endpoint declares filters, pagination, sort order, joins and envelopes over the world. `serve` and the MSW handlers use the same engine. `world` copies it next to the data as `runtime.mjs`, and you commit and review it like any other code.
- **The scenario carries its assertions.** `expect` says what the screen must show (`=12` rows, `3` badges) and which request feeds each count. That link lets `verify` tell a data problem from a rendering problem.
- **Diagnosis, not regeneration.** A failed count produces typed hypotheses: `pagination-mismatch`, `client-side-filter`, `dedupe-by-id`, `undeclared-filter`, `null-field`, `navigation` and others. The skills forbid hand-writing data JSON: you change the scenario and regenerate.

### Six commands

| command | what it does |
|---|---|
| `atrezzo init` | detects the project, monorepo layout and API base URL; picks an adapter and prints why, with the alternatives |
| `atrezzo import` | infers a scenario from an OpenAPI spec and reports what it could not infer |
| `atrezzo world` | builds the world and writes the files each adapter needs |
| `atrezzo serve` | serves the projections over HTTP, switches scenarios without a restart, records gaps |
| `atrezzo harvest` | opens a URL in Chromium, discovers 404 gaps across rounds, infers entities/fields (`--types`, `select=`, or guess), and updates the scenario |
| `atrezzo verify` | runs a flow against the screen, compares counts, diagnoses failures |

Helpers: `atrezzo misses` (recorded gaps), `atrezzo runtimes` (adapter scores for this project), `atrezzo doctor` (what is installed, valid or stale).

### Seven skills

| skill | use it when |
|---|---|
| `/atrezzo:atrezzo` | you are not sure which skill applies; it routes and explains the loop |
| `/atrezzo:init` | setting atrezzo up in a repo; installs nothing without saying so |
| `/atrezzo:capture` | you need the contract first: OpenAPI or types, then HAR, then code |
| `/atrezzo:scene` | you have an intent ("12 rows, 3 with an issue") and need a scenario |
| `/atrezzo:verify` | a screen does not show what it should |
| `/atrezzo:from-intent` | you describe a journey ("I'm on X, I want Y") and need one scenario per step |
| `/atrezzo:gap` | the app calls a route the scenario lacks |

Only the skill descriptions load at session start: about 2 KB of frontmatter for all seven.

<h2><img src="https://raw.githubusercontent.com/zeta92/atrezzo/media/assets/readme/section-03-install.png" width="100%" alt="03 Install"></h2>

```text
/plugin marketplace add zeta92/atrezzo
/plugin install atrezzo@atrezzo
```

The first line registers this repository as a marketplace; the second installs the plugin from it.
If you already have a checkout of this repository, you can load the plugin straight from it instead:

```bash
claude --plugin-dir <path-to-your-checkout>
```

Requirements: Node 22 or newer. No runtime dependencies: atrezzo has its own YAML parser and HTTP server. Optional in your project: `msw` for in-browser or test handlers, and `playwright` or `playwright-core` for the DOM driver. With `playwright-core`, atrezzo uses the system Chromium (`/usr/bin/chromium`, or set `ATREZZO_CHROME=/path`).

### First run

Get a scenario first: ask `/atrezzo:scene` for one, or run `atrezzo import api/openapi.yaml`. Then:

```bash
atrezzo init                                             # detects the project, picks an adapter, says why
atrezzo world atrezzo/scenarios/orders.yaml              # world + files for the chosen adapter
atrezzo serve --scenario orders &                        # builtin adapter on http://127.0.0.1:4010
atrezzo verify atrezzo/flows/orders.yaml --diagnose     # count the screen, compare, diagnose
```

### Or run the example

```bash
cd examples/tienda
node ../../scripts/cli.mjs world scenarios/orders.yaml
node ../../scripts/cli.mjs serve --scenario orders &
node ../../scripts/cli.mjs verify flow.yaml --driver http          # green, exit 0
node ../../scripts/cli.mjs verify flow-broken.yaml --diagnose        # red on purpose, exit 1
```

Exit codes: `0` OK · `1` assertion failed · `2` not verifiable (no mock, no Playwright, or an assertion without data; never reported as OK) · `3` invalid input.

<h2><img src="https://raw.githubusercontent.com/zeta92/atrezzo/media/assets/readme/section-04-adapters.png" width="100%" alt="04 Adapters"></h2>

The scenario does not depend on where it is served. `world` always writes the world (`<scenario>.json`) and the engine (`runtime.mjs`), then whatever each configured adapter needs. `init` chooses from what it finds in the repo and prints its reasons. You can override it with `--runtime`, and you can combine adapters, as in `--runtime msw,supabase`.

| adapter | picked when the repo has | does | does not |
|---|---|---|---|
| `builtin` | nothing more specific; any backend or language | real HTTP via `atrezzo serve`: filters, pagination, envelopes, detail routes, scenario reset, hot reload, gap log | writes (405), injected latency or errors |
| `msw` | `msw` in dependencies | handlers that run the same engine as `serve`, in the browser or in Node tests | install msw or register the worker for you; record gaps |
| `supabase` | `supabase/config.toml`, `@supabase/supabase-js`, `supabase/` | `schema.sql`, `seed.sql` with the world's ids, and an idempotent `reset.sh` that refuses a non-local database | simulate RLS or auth; filtering and pagination are PostgREST's, not atrezzo's |
| `prism` | `@stoplight/prism-cli` (a spec alone is not enough) | an OpenAPI 3.1 file whose examples come from the world | filter or paginate: any query gets the default example |
| `wiremock` | a WireMock dependency, `mappings/` + `__files/`, or docker-compose | mappings for every enumerable combination: each filter value, pages, and the exact requests in your flows | combined filters or unlisted pages: those get a **501** with the list of combinations it did generate, never a wrong page |

The `prism` and `wiremock` rows describe behaviour checked by hand against 0.3; they were not re-run against 0.4, and their own limits are listed in [`references/runtimes.md`](references/runtimes.md). Full detail, including how `auto` scores each adapter and what each one does with a missing route, is there too.

### Monorepos and separate front end and backend

`init` reads `pnpm-workspace.yaml`, `workspaces` in `package.json`, `lerna.json`, `turbo.json` or `nx.json`. It also recognizes sibling folders such as `client/` + `server/`, `web/` + `api/` or `frontend/` + `backend/`. It classifies each package as front end or backend and writes:

```json
"workspace": { "front": "apps/web", "backend": "services/api", "contract": "services/api/openapi.yaml" }
```

MSW handlers then go to the front end, and the Supabase seed goes to the backend. With two candidate front ends, or none, `init` does not guess: it prints the candidates and exits with 2, and you pass `--front <path> --backend <path>`.

<h2><img src="https://raw.githubusercontent.com/zeta92/atrezzo/media/assets/readme/section-05-limits.png" width="100%" alt="05 Limits"></h2>

- **Reads only.** The mock shapes data. It does not implement business rules: no writes (they return 405), no recomputed totals, no RLS. HTTP errors are not part of the world; inject them in the runtime. Latency is timing, not data: `serve --latency <ms>` or a per-endpoint `latency:` delays contract responses without changing what they contain.
- **Only `builtin` and `msw` run the projection.** Prism returns examples without filtering or paginating. WireMock serves pre-generated combinations and answers 501 to the rest. Supabase responses take PostgREST's shape.
- **Gaps are recorded by `atrezzo serve` only**, not by MSW, Prism, WireMock or Supabase. The same route under two prefixes (`/api/users`, `/users`) counts as two gaps. Nested routes such as `/api/customers/:id/orders` are recorded but not projected.
- **`import` covers GET collections only:** an array of objects, or a `data`/`items`/`results`/`records`/`content` envelope. Nested fields are skipped and reported. Ids are always integers 1..n. No external `$ref`.
- **YAML is a subset:** no anchors, aliases or multiple documents. The parser rejects them with the line and the reason.

<details>
<summary><b>CLI reference</b></summary>

```
node scripts/cli.mjs init [--dir .] [--runtime auto|builtin|msw|supabase|prism|wiremock] [--front <path> --backend <path>] [--contract <spec>] [--install] [--force]
node scripts/cli.mjs runtimes
node scripts/cli.mjs import [<openapi.yaml|json>] [--name api] [--base /api] [--format yaml|json] [--force]
node scripts/cli.mjs world <scenario.yaml> [--out dir]
node scripts/cli.mjs serve [--scenario demo] [--port 4010] [--static dir] [--runtime builtin] [--on-miss log|stub] [--latency ms]
node scripts/cli.mjs misses [--json] [--clear]
node scripts/cli.mjs harvest <url> --scenario <file> [--storage <file.json|@->] [--until <css|text=…>] [--rounds 5] [--types <file.ts>] [--write]
node scripts/cli.mjs verify <flow.yaml> [--url …] [--driver http|playwright] [--header "Name: value"|@-]… [--diagnose] [--no-reset] [--json]
node scripts/cli.mjs doctor
```

- `init` detects a monorepo (pnpm/npm/yarn workspaces, turbo, nx, lerna) or `client/`+`server/` folders, the runtime, and the `baseUrl` the front end calls, and **prints what it found, why, and which alternatives there were**. With two front ends or none, it does not guess: candidate table and exit 2.
- `world` always writes `<scenario>.json` + `runtime.mjs` (source of truth), then the runtime output: MSW handlers, `seed.sql`/`reset.sh`, OpenAPI for Prism or WireMock mappings. See [`references/runtimes.md`](references/runtimes.md).
- `import` infers a scenario from an OpenAPI spec (entities, typed fields, `{data: […]}` envelopes → `pick`, enum filters, pagination) with a report of what it could not infer.

Exit codes: `0` OK · `1` assertion failed · `2` not verifiable (no mock, no playwright, or an assertion without data; **never** reported as OK) · `3` invalid input.

`serve` exposes `GET /api/<resource>?limit=&offset=&<filters>`, the `/<resource>/:id` detail, `POST /__atrezzo/reset {"scenario":"x"}`, `POST /__atrezzo/reload` (rereads the current scenario's YAML), `GET /__atrezzo/state` and `GET|DELETE /__atrezzo/misses`. It uses the same engine (`scripts/lib/contract.mjs`) as the MSW handlers: `world` copies it byte for byte as `runtime.mjs`.

</details>

## Three ways to start

Paste one of these into Claude Code, in a project where atrezzo is installed. Each one ends in a
command you can run yourself, which is the point: the skill writes the scenario, the CLI runs it.

**1. From a contract you already have.** *"Import `api/openapi.yaml` as a scenario called `shop`,
print what you could not infer, and start the mock on 4010."* — runs `atrezzo import`, then
`serve`; the report lists every route it ignored and why.

**2. From a screen that lies.** *"The customers page shows no rows against the mock. Find which
request feeds the table, check what the scenario declares for that request, and tell me why the
counts disagree."* — reads the front end, finds the call, and `verify` counts the DOM instead of
guessing.

**3. From a state the app cannot reach yet.** *"I want the checkout screen with three abandoned
carts, one of them paid with a card that failed. Add that world, screenshot the screen and save the
scenario."* — writes the world, projects it, and captures the screen with the Playwright driver.

## When something does not work

| What you see | What it means | What to do |
|---|---|---|
| Exit `2`, `not verifiable` | Nothing answers on the flow's `base_url`, or Playwright/Chromium is missing | Start `serve` on that port (`--url` to point elsewhere); set `ATREZZO_CHROME` to a browser |
| Exit `0` but the app renders nothing | `serve` is not serving your front end, or the app calls a different origin | `serve --static <app dir>`, and check the app's base URL |
| `doctor` says the generated files are stale | The scenario changed after `atrezzo world` | Run `atrezzo world <scenario>.yaml` and commit the result |
| A route answers 404 with `"atrezzo":{"miss":true,…}` | The app asked for something no scenario declares | `atrezzo misses`, add the endpoint, `POST /__atrezzo/reload` |

## Support, data and privacy

Bugs and questions go to [issues](https://github.com/zeta92/atrezzo/issues). The plugin reads the
project it runs in and writes two places inside it: `atrezzo/.atrezzo/` (recorded gaps) and the
generated folder. It makes no network calls except to the mock it starts on `localhost`; there is
no telemetry, no account and no personal data involved. Uninstalling is deleting the plugin; deleting
the two folders removes everything it wrote.

**Credentials.** atrezzo asks for none and looks for none: a flow holds no secret, and the plugin reads no environment variable to fill a header. If a screen needs a session you pass the header yourself with `verify --header "Name: value"` or `--header @-` on stdin. Secret-looking headers print as `***` in the table, in `--json` and in error messages, and nothing is written to a log or to disk.

<details>
<summary><b>Changelog and upgrading from 0.3 or 0.4</b></summary>

### 0.9.2

`atrezzo harvest --types` deduces relations from the type graph: a `field: T[]` whose `T` is declared in the file becomes `embed: [<entity of T>]` (child entity created with T's fields and `ref:` to the parent, or reused when the world already has one that refs it), a `field: T` becomes `include` when the entity refs T's entity, and anything it cannot match is listed as `relation not mocked (missing entity + ref)` with the reason. Nothing breaks.

### 0.9.1

`atrezzo harvest --storage <file.json>` (or `@-` from stdin) seeds `localStorage`/`sessionStorage` via `context.addInitScript` before the first navigation so screens behind login guards can be harvested; `${…}` is rejected (exit 3) and only keys are printed.

### 0.9.0

Nested paths with `:name` parameters in the middle (`/projects/:project_id/views/:view_id/tasks`), `embed: [views]` to inline child rows into each parent row, and `atrezzo harvest <url> --scenario <file>`: opens the page in Chromium, collects 404 gaps and retries, infers endpoints and entities (`--types` TypeScript interfaces → `select=` → guess; singletons with `shape: object`), reloads the mock and repeats until `--until`, no new gaps, or `--rounds`. Writes are reported, never mocked; `--write` merges into the scenario. Nothing breaks.

### 0.8.0

Two things a real SPA boot needed: `shape: object` answers the first row of the entity (after filters and `sort`) as a JSON object, for singletons such as `/info` or `/user` (empty entity ⇒ 404 recorded as a gap), and `serve --latency <ms>` plus a per-endpoint `latency:` delay contract responses like a real backend; static files and `/__atrezzo/*` answer immediately. Nothing breaks.

### 0.7.0

The engine answers PostgREST counts from the world: `select=*,child(count)` (and `alias:child(count)`) embeds `[{ "count": n }]` per row, and `head=true` returns an empty body with `Content-Range: 0-<n-1>/<n>` (see "Counted relations" in `references/scenario.md`). Nothing breaks; `select=*` is no longer listed in `X-Atrezzo-Ignored`.

### 0.6.0

`serve --static` answers browser navigations to client-side routes with `index.html` (SPA fallback), and a flow's `storage:` block seeds `localStorage`/`sessionStorage` before each step with the Playwright driver. Nothing breaks.

### 0.5.0: header values come from `--header`, not the environment

atrezzo no longer expands `${…}` references in flow `headers:`; a flow that still has one is invalid (exit 3) and the error names the header. Keep only committable values in the flow and pass the secret at run time:

| before (0.4) | after (0.5) |
|---|---|
| flow: a `Cookie` whose value is a `${…}` reference · run: `atrezzo verify flow.yaml` | flow: no `Cookie` · run: `atrezzo verify flow.yaml --header "Cookie: $SESSION"` |

`--header` is repeatable and applies to every request. Effective headers = flow + `--header` + the step's own, so a step that names a header keeps control of it. `--header @-` reads `Name: value` lines from stdin. `ATREZZO_CHROME` (a browser path) is the only environment variable atrezzo still reads.

### 0.4.0: English DSL, CLI and output

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
| config `scenariosDir` default (new configs only) | `atrezzo/escenarios` | `atrezzo/scenarios` |
| built-in entity templates | `clientes`, `usuarios`, `pedidos`, `productos` | `customers`, `users`, `orders`, `products` (no aliases; the old names are rejected with an error that names the new one) |
| template fields | `nombre`, `ciudad`, `rol`, `referencia`, `estado`, `importe`, `precio`, `moneda`, `creado_en` | `name`, `city`, `role`, `reference`, `status`, `amount`, `price`, `currency`, `created_at` |
| template values | `pagado`, `operador`, `PED-00001` | `paid`, `operator`, `ORD-00001` |
| foreign keys | `client_id` (for `clientes`); generic entities drop a trailing `-es` (`categories` → `categori_id`) | `customer_id` (for `customers`); English singular (`categories` → `category_id`, `boxes` → `box_id`) |
| `include` embed key | `cliente`, `pedido`… | `customer`, `order`… (the template's singular) |
| `distribution_field` default (generic entities) | `estado` | `status` |
| `fields` value heuristics | also matched `nombre`, `empresa`, `ciudad`, `titulo`, `precio`, `importe` | English names only (`name`, `company`, `city`, `title`, `price`, `amount`, `total`…) |
| references | `references/escenario.md`, `references/suposiciones.md` | `references/scenario.md`, `references/assumptions.md` |

Unchanged: the `atrezzo/flujos/` directory and flow file names, skill commands such as `/atrezzo:scene`, an existing `atrezzo.config.json` (its `scenariosDir` is written explicitly, so the old directory keeps working until you move it), and the generated sample values (names, companies, cities were already English). Scenario hashes change: the template and field names are part of the normalized scenario, and so is the `amount` currency key. Run `atrezzo world` once per scenario (`doctor` flags the stale ones). For a scenario that already declared `fields` for every entity, like `examples/tienda`, the regenerated data is the same row for row, apart from the renamed foreign key.

</details>

<details>
<summary><b>Repository layout</b></summary>

```
.claude-plugin/              plugin.json (manifest) · marketplace.json (zeta92/atrezzo)
assets/readme/               README images (SVG) and the demo GIF
skills/                      router + 6 skills
scripts/cli.mjs              CLI (bin: atrezzo)
scripts/lib/                 world, scenario, contract (engine), codegen, serve, verify, init, project (monorepo), openapi (import), misses (gaps)…
scripts/lib/runtimes/        builtin, msw, supabase, prism, wiremock
references/                  scenario.md (scenario spec) · assumptions.md (client assumptions) · runtimes.md (adapters, monorepo)
examples/tienda/             runnable end-to-end example
tests/                       node --test tests/  (130 tests; 6 launch real Chromium, the rest of the Playwright-driver tests use a fake page; 1 skips without Postgres and 1 without PyYAML)
```

</details>

## License

MIT. See [`LICENSE`](LICENSE).
