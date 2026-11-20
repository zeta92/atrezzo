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
| `atrezzo record` | captures a real HTTP response (without credentials/headers) into `atrezzo/fixtures/<name>.json` for `passthrough` + `patch` endpoints |
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
| `builtin` | nothing more specific; any backend or language | real HTTP via `atrezzo serve`: filters, pagination, envelopes, detail routes, declared `writes`, SSE `streams`, scenario reset, hot reload, gap log | undeclared writes (405), injected latency or errors |
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

- **Declarative writes.** Without `writes:`, the mock projects reads only (undeclared writes return 405/404). When a scenario declares `writes:`, `serve` and the MSW handlers mutate the in-memory world for subsequent reads in the same session, and `POST /__atrezzo/reset` restores the initial state. The mock still does not recompute totals, enforce RLS, or infer writes in `import`/`harvest`. Latency is timing, not data: `serve --latency <ms>` or a per-endpoint `latency:` delays contract responses without changing what they contain.
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
node scripts/cli.mjs record <url> --scenario <file> --endpoint <path> [--fixture <name>] [--header "Name: value"|@-]… [--write]
node scripts/cli.mjs verify <flow.yaml> [--url …] [--driver http|playwright] [--header "Name: value"|@-]… [--diagnose] [--strict-console] [--no-reset] [--json]
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

### 0.22.0

**Passthrough-and-patch mode (`record` and `passthrough`).** Added `atrezzo record <url> --scenario <file> --endpoint <path> [--fixture <name>] [--header …] [--write]` to freeze a real HTTP response into `atrezzo/fixtures/<name>.json` storing only `{ status, contentType, body }` (discarding all request/response headers, cookies, and query secrets), and endpoint-level `passthrough: { fixture, patch: { "nested.field": value } }` in scenarios so rare states (such as a locked item or empty market) can be reproduced without modeling an entire world. `atrezzo serve` (and generated MSW/Prism/WireMock outputs) serves the recorded fixture with only the declared dot-path patches applied, preserving all other fields, key order, and array elements byte-for-byte. Validation rejects missing fixtures, invalid paths, non-existent patch keys/indices, and conflicting options (`error`, `detail: true`) with exit `3`; scenarios without `passthrough` keep their exact behaviour and hash. Documented in `references/scenario.md` and `references/runtimes.md`, covered in `tests/passthrough.test.mjs`.

### 0.21.0

**Server-Sent Events streams (`streams`).** A scenario can now declare a root `streams:` map keyed by `"/path"` with `{ interval, events, loop }` so screens that subscribe to live updates after initial REST loads (prices, markets, status feeds) can be simulated in `atrezzo serve`. `serve` responds with `Content-Type: text/event-stream`, emits each declared event serialized as `data: <json>\n\n` at the configured `interval` in order, repeats from the start when `loop: true` or closes after the last event when `loop: false`, lists declared stream paths in `GET /__atrezzo/state`, and closes active streams and timers cleanly on client disconnect, `POST /__atrezzo/reset`, `POST /__atrezzo/reload`, or server shutdown. Validation rejects empty `streams`, invalid/duplicate paths, `interval <= 0` (or non-integer), empty `events`, and non-boolean `loop` with exit `3`; scenarios without `streams` keep their exact behaviour and hash. Documented in `references/scenario.md` and `references/runtimes.md`, covered in `tests/scenario.test.mjs` and `tests/serve.test.mjs`.

### 0.20.0

**Business writes against the in-memory world (`writes`).** A scenario can now declare a root `writes:` map keyed by `"<METHOD> /path"` (`POST`, `PUT`, `PATCH`, `DELETE`) with `expect: { status, echo, body }` and `mutate: { entity, action, set, where }` so submit-driven UI states work end-to-end. Both `atrezzo serve` and the generated MSW handlers (`http.post`/`put`/`patch`/`delete`, plus `POST /__atrezzo/reset` and `reset()`) apply mutations to the in-memory world, invalidate child count/embed caches, respond with the declared status and deterministic canonicalized body (independent of request key arrival order or cross-entity order), and expose the updated state to subsequent reads in the same session until `POST /__atrezzo/reset` restores the initial world. Validation rejects routes without an explicit write method, unknown entities, unknown `set`/`where` fields, unbound path parameters, and conflicting `expect` options with exit `3`; scenarios without `writes` keep their exact behaviour and hash. Documented in `references/scenario.md` and `references/runtimes.md`, covered in `tests/contract.test.mjs`, `tests/serve.test.mjs`, and `tests/codegen.test.mjs`.

### 0.19.0

**Pre-assertion click interactions on flow steps (`click`, `click_timeout`, `click-target-missing`).** A flow step can declare `click: "<selector>"` (including `text=…`) or an ordered list `click: [sel1, sel2]` under `--driver playwright` to open collapsibles, tabs, or disclosures on the same step before `expect` assertions are measured. Each target waits to exist up to a configurable timeout (default `5000` ms via `click_timeout` on step/flow or `verify --click-timeout`) before performing a real Playwright click; clicks do not create extra steps, and a missing target fails the step (`KO`) with the `click-target-missing` hypothesis under `--diagnose` (`click:` is ignored with a `WARNING` under `--driver http`). Documented in `references/scenario.md` and `skills/verify/SKILL.md`, covered in `tests/verify.test.mjs`.

### 0.18.0

**Browser console and uncaught exception capture in `verify` (`pageerror`, `console.error`, `--strict-console`).** Under `--driver playwright`, `verify` now collects `pageerror` (uncaught exceptions and unhandled rejections) and `console.error` throughout each step's load and assertion checks. An uncaught `pageerror` always marks the step `KO`—even if selector counts match (so a blank-screen crash like `RangeError: Invalid array length` or an error toast never passes as `OK`)—and under `--diagnose` emits a `page-error` hypothesis with the message clipped to 300 characters. `console.error` entries are reported as `WARNING` lines without breaking passing steps unless `--strict-console` is passed (which requires `--driver playwright`, is rejected with exit `3` under `--driver http`, and marks the step `KO` with a `console-error` hypothesis). With `--json`, each Playwright step includes `console: [{ level, text }]`. Documented in `references/scenario.md` and `skills/verify/SKILL.md`, covered in `tests/verify.test.mjs`.

### 0.17.0

**Declarative child counts on entities and endpoints (`counts`).** An entity (`world.<name>.counts`) or endpoint (`endpoints[i].counts`) can declare `counts: { tasks: { entity: tasks, on: bucket_id } }` to expose a numeric `tasks_count` (when the key matches `entity`) or any declared field name (such as `count`) on each projected row. Counts are computed deterministically over all matching rows in `world` (returning `0` when none match or when the child entity has 0 rows), remain exact even when the endpoint applies filters or `limit`/`offset` pagination, work on list, detail (`/:id`), `envelope`, and `object` routes without mutating the dataset, and are reflected in Prism OpenAPI schemas. Validation rejects undeclared child entities, missing or non-matching foreign keys, duplicate output names, and `pluck` combinations (exit 3); scenarios without `counts` keep their exact behaviour and hash. Documented in `references/scenario.md`, covered in `tests/contract.test.mjs`.

### 0.16.0

**Configurable pagination envelope keys per endpoint (`envelope`).** Endpoints with `shape: envelope` can declare `envelope: { items: articles, total: articlesCount }` (and optionally `page`, `per_page`, including dot-paths like `meta.total`) so APIs returning custom envelope structures such as `{ articles, articlesCount }` or `{ data, meta: { total } }` project exact keys without leaving client reads `undefined`. Without `envelope`, the default `{ data, total, limit, offset }` (or `pick`) envelope and scenario hashes stay unchanged. Validation rejects non-`envelope` shapes, `pick` combinations, empty/invalid keys, duplicates, and nested path conflicts (exit 3); `serve`, `verify`, and Prism OpenAPI output honour the declared keys. Documented in `references/scenario.md`, covered in `tests/contract.test.mjs`.

### 0.15.0

**Declared redirects on flow steps (`redirects_to` and `allow_redirect`).** A flow step can declare `redirects_to: /login` (or `allow_redirect: true`) when an auth guard or route redirect is expected under `--driver playwright`. `verify` treats a matching redirect as the expected outcome—running `wait_for` and the step's `expect` assertions against the destination screen and reporting OK when the final URL matches—while a missing or wrong destination is KO, and steps without the field keep the existing unexpected-redirect warning and KO behaviour. With `--json`, redirected steps include `redirect: { from, to, declared }`. Documented in `references/scenario.md`, covered in `tests/verify.test.mjs`.

### 0.14.0

**Seeded current user (`auth` and `$user.<field>` filters).** A scenario can declare `auth: { user: { entity: authors, id: 1 } }` at the root to designate a seeded row from `world` as the current session user. The projection engine exposes that row as `currentUser` and resolves `$user.<field>` tokens in endpoint `filters` (such as `filters: { id: "$user.id" }` on `/api/user` or `/api/me` with `shape: object`, or `filters: { author_id: "$user.id" }` on collection endpoints, as well as inside `{ from, where }` world filters) without exposing a client-overridable query parameter. Validation rejects undeclared entities, nonexistent `id`s, and invalid `$user.<field>` references with a scenario error (exit 3); scenarios without `auth` keep their exact behaviour and hash. Documented in `references/scenario.md`, covered in `tests/contract.test.mjs`.

### 0.13.0

**World-resolved filters (`filters: { <fk>: { from, where } }`).** An endpoint can filter by a condition on a referenced entity in `world` instead of requiring a query parameter (e.g., `filters: { source_id: { from: sources, where: { active: true } } }`). The contract engine resolves matching target ids from `from` and returns rows whose foreign key points to them, combining cleanly with normal query filters, path parameters, `sort`/`sorts`, `pagination` (`X-Total-Count` reflects the resolved subset), `shape: object`, and `head=true`. Validation rejects undeclared `from` entities, filter keys that are not foreign keys to `from`, and unknown fields in `where`; short-form `filters` (`[field]` and `{ field: field, ":param": field }`) keep their exact behaviour and scenario hashes. Documented in `references/scenario.md`, covered in `tests/contract.test.mjs`.

### 0.12.0

**Conditional fields in `world` (`{ default, when, value }`).** An entity field in `fields` can declare `{ default: [2], when: { is_archived: true }, value: [0] }` so rows matching `when` on other fields of the same row deterministically override their drawn `default` value before the world is finalized. Validation checks that `when` references existing fields of the same entity (without cycles), that `value` matches the field's type, and rejects impossible conditions (such as comparing a `boolean` field to a non-boolean or an enum to an undeclared value); scenarios without conditional fields keep their exact normalized form and hash. Documented in `references/scenario.md`, covered in `tests/world.test.mjs`.

### 0.11.0

**Dynamic sorting per endpoint (`sorts`).** An endpoint can declare `sorts: { by: sort_by, order: order_by, fields: [id, title, created_at] }` (with configurable query parameter names and an explicit field allowlist). The contract engine resolves `order=asc|desc`, `-field` / `+field`, and `field.asc` / `field.desc` before pagination and `shape: object`, consumes the declared parameters so they leave `X-Atrezzo-Ignored`, and rejects any disallowed field or invalid direction loudly (`400`, never silent). Scenario validation checks `fields` against the entity and rejects parameter collisions; endpoints without `sorts` keep their exact behaviour and scenario hash. Documented in `references/scenario.md`, covered in `tests/contract.test.mjs` and `tests/scenario.test.mjs`.

### 0.10.0

**Four things a response could not say.** `embed` entries nest (`- entity: items` + `embed: [tags]`, up to 4 levels; a cycle is a scenario error naming its path); `pluck: <field>` answers that field of each row as a string (`["1","2","3"]`) with filters, sort, pagination, `envelope` and `detail`; `values_order: cycle` hands out each list of values in the written order on every seed; `error: { status, body }` makes an endpoint always answer that error (reported by `serve`, read by `verify` as a real answer). Scenarios without them keep their hash; see `references/scenario.md`, covered in `tests/projection.test.mjs`: 226 tests green.

### 0.9.6

**A world that does not contradict itself.** `derive` (per entity) copies a foreign key from the row another reference of the same row points at: with `ref: [widgets, gadgets]` and `derive: { widget_id: { from: gadgets, field: widget_id } }`, every piece belongs to the widget of its gadget, so `/widgets/1/gadgets/2/pieces` can no longer be empty because the two keys were drawn apart. The derived key stops being drawn and nothing else changes; a `from` outside `ref:`, a field that is not a foreign key, or a source field that is not a reference to the same entity is a clear scenario error. **`seed_first`** (`true` or a list of fields) gives every row the first value of its enum, `false` for a boolean, or the first of its `values:`; a field that is none of these is an error. **`atrezzo harvest`** emits both: a route nesting two parents declares `derive` of the outer one through the inner one (adding the inner parent's `ref:` when missing, and noting when the observed URL is itself incoherent, with the URL that has rows), and an entity created from `--types` with an enum or boolean gets `seed_first: true`. Scenarios without the new keys keep their normalized form and hash. Documented in `references/scenario.md`, covered in `tests/coherence.test.mjs`: 209 tests green.

### 0.9.5

**PostgREST query operators**, because supabase-js never sends a bare value: `?expediente_id=eq.1` used to be compared literally against the string `eq.1` and answered `200 []`, so every `.eq()`, `.neq()`, `.in()`, `.like()` of a Supabase app looked like an empty table (a red dressed as green). The engine now understands the prefixes `eq.`, `neq.`, `gt.`, `gte.`, `lt.`, `lte.`, `like.`/`ilike.` (`*` and `%` are wildcards), `is.` (`null`/`true`/`false`) and `in.(1,2)`, keeping a top-level comma list as an OR of equalities and an unknown prefix as a literal value. **`.single()`**: a request with `Accept: application/vnd.pgrst.object+json` answers one row as an object whatever `shape` says, and `406 {code: "PGRST116"}` unless exactly one row survives the filters. Both are documented in `references/scenario.md` and covered in `tests/contract.test.mjs`. Nothing breaks: 194 tests green.

### 0.9.4

`atrezzo harvest` closes four gaps that kept a harvested view from rendering. A path with parameters always gets `filters` in the map form with every parameter bound by name (`":widget_id": widget_id, ":gadget_id": gadget_id`, plus `field: field` for query filters), so both segments filter; a segment the world does not model gets a field of its own name instead of `null`. A new list endpoint the page requests but does not advance with is retried as `shape: envelope` with `pick: items`, `data`, `results`, `records`, `rows` (one per round), keeping the first that makes the page advance and reporting which attempt won, or leaving the array and saying so. Query keys starting with `sort`/`order`/`filter`/`with`/`is_`/`has_`, ending in `_by`, or sent with a boolean value are reported as flags, not filters (`*_id` keys stay filters). A numeric detail id widens the entity to `total >= id` before the detail is judged (up to 1000, was 50); only a non-numeric id is left out. The mock server takes an `onRequest` hook. Nothing breaks.

### 0.9.3

`atrezzo harvest --types` names an embedded relation after the **property**, not the type: `items?: Array<StoreItem> | null` gives `embed: [items]` and an `items` entity with `StoreItem`'s fields, the parent FK (`shelf_id`, added when the type lacks it) and `ref: shelves`; a world `items` that already refs the parent is reused as is. `X[]`, `Array<X>`, `X[] | null`, `Array<X> | null` and `X[] | undefined` count the same. Each relation is reported with both names (`Shelf.items → embed [items] (type StoreItem, …)`). Singulars of the English `-f/-fe → -ves` nouns are now right (`shelves` → `shelf`, FK `shelf_id`, was `shelve_id`); other `-ves` words are unchanged (`drives` → `drive`).

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
