# Runtimes: where the mock is served

The scenario (world + endpoints + expect) **does not depend on the runtime**. `atrezzo world` always writes the source of truth, `<generatedDir>/<scenario>.json` (the world) and `runtime.mjs` (the projection engine, no dependencies), and then whatever each runtime in `atrezzo.config.json → runtime` needs (one, or a list: `"runtime": ["msw", "supabase"]`).

```bash
atrezzo init                       # detects and chooses (prints what it found, why, and the alternatives)
atrezzo init --runtime wiremock    # or you choose (several: --runtime msw,supabase)
atrezzo runtimes                   # each adapter's score in this project and how to start it
atrezzo world atrezzo/scenarios/orders.yaml
```

A 0.1 config without a `runtime` field means `msw` (the old behavior: handlers on every `world`).

## Decision table

| the project… | runtime | why |
|---|---|---|
| is a JS front end with `msw` installed (Vite, Next client, Storybook, vitest) | **msw** | intercepts `fetch` without changing URLs; same engine as `serve` |
| uses Supabase (`supabase/`, `@supabase/supabase-js`) | **supabase** | there is no mock layer: the "API" is PostgREST over Postgres → the world is loaded into the local DB |
| already has WireMock (mappings/`__files`, docker-compose, dependency) | **wiremock** | static stubs the team already knows how to run |
| already uses Prism (`@stoplight/prism-cli` in deps or scripts) | **prism** | mock from a generated OpenAPI with examples from the world |
| has a backend in another language, E2E, apps that cannot be instrumented, or none of the above | **builtin** | `atrezzo serve`: real HTTP with no dependencies, real filtering and pagination |

### How `auto` scores

Each adapter returns 0..3 with its reasons; the highest wins and, on a tie, the fixed priority `msw > supabase > wiremock > builtin > prism`.

| adapter | signals (weight) |
|---|---|
| builtin | always 1: universal fallback |
| msw | `msw` in dependencies (3) · `public/mockServiceWorker.js` (2) |
| supabase | `supabase/config.toml` (3) · `@supabase/supabase-js` (2) · `supabase/` folder (2) |
| prism | `@stoplight/prism-cli` (3) · `prism mock/proxy` in scripts (2) · an OpenAPI spec in the repo (1) |
| wiremock | `*wiremock*` dependency (3) · `mappings/` + `__files/` at the root or in `wiremock/` (3) · `wiremock` in scripts or docker-compose (2) |

**An `openapi.yaml` alone does not pick Prism**: it ties at 1 with builtin and builtin wins. A spec is a contract, not proof that the team uses Prism; use it with `atrezzo import` (scenario from the contract) and serve it with whatever runtime you have. With `prism-cli` in dependencies, prism does win.

In a monorepo the signals of the root, the front end and the backend add up (e.g. `msw` in `apps/web` and `supabase/config.toml` in `services/api` tie at 3 → msw by priority; `init` says so and suggests `--runtime msw,supabase`).

## Each runtime: what it does, what it does NOT do, how to start it

### builtin (`atrezzo serve`)

- **Does**: serves the projections over HTTP (`GET /api/x?filter=&limit=&offset=`, `/:id` detail, envelopes, `X-Total-Count`), `passthrough` fixtures with `patch` overrides (`atrezzo record`), declared `writes` (`POST`/`PUT`/`PATCH`/`DELETE` against the in-memory world), and declared SSE `streams` (`Content-Type: text/event-stream`), switches or resets scenarios without restarting (`POST /__atrezzo/reset {"scenario":"x"}`), rereads the YAML (`POST /__atrezzo/reload`), serves static files with `--static`, and records gaps (`atrezzo misses`).
- **Does not**: undeclared writes (405, recorded as a gap), injected latency or errors.
- **Start**: `atrezzo serve --scenario orders --port 4010`.

### msw

- **Does**: `world` writes `<scenario>.handlers.mjs`, which imports the JSON and `runtime.mjs` and projects with the same engine as `serve`. With `workspace.front`, the handlers go to `<front>/src/mocks/atrezzo/` with relative imports to `atrezzo/.generated/`; otherwise to `.generated/`.
- **Does not**: install msw (use `init --install`, which announces it) or register the worker for you.
- **Start**:
  ```js
  import { setupWorker } from 'msw/browser';           // browser, development only
  import { handlers } from './mocks/atrezzo/orders.handlers.mjs';
  await setupWorker(...handlers).start({ onUnhandledRequest: 'bypass' });
  // Node tests: import { setupServer } from 'msw/node'; setupServer(...handlers).listen();
  ```
  Requires importing JSON with `with { type: 'json' }` (Node 22+, Vite 5+, Next 14+).

### supabase

Supabase has no mock layer: its API is PostgREST over Postgres. The "runtime" is **the local database with the world loaded**.

- **Does**: `world` writes to `<backend>/supabase/atrezzo/<scenario>/` (or `supabase/atrezzo/…` at the root; without a `supabase/` folder, to `.generated/supabase/<scenario>/`):
  - `schema.sql`: minimal `CREATE TABLE IF NOT EXISTS` with types inferred from the data and FKs (so PostgREST can join); `GRANT SELECT … TO anon` if the role exists.
  - `seed.sql`: in one transaction, `TRUNCATE … RESTART IDENTITY CASCADE` + `INSERT … OVERRIDING SYSTEM VALUE` with the world's ids (the same as in `serve`/MSW) and `setval` on the sequence if the `id` column is serial/identity.
  - `reset.sh`: applies both with `psql`, is idempotent and **refuses a connection string that does not look local** unless you add `--allow-remote` (exit 2).
  - `README.md`: steps with the Supabase CLI or standalone Postgres + PostgREST.
  - Your `supabase/seed.sql` is left alone.
- **Does not**: project with the atrezzo engine. PostgREST handles filters, sorting, pagination (`Range`, `limit/offset`) and embeds; the scenario routes (`/api/orders`) do not exist there (supabase-js queries `/rest/v1/<entity>`). The data is identical; the response shape is PostgREST's. It does not simulate RLS or auth either: with RLS on, `anon` only sees what your policies allow. If your migrations already create the tables with other columns, `seed.sql` fails with `column … does not exist` (the scenario does not match your schema; adjust it).
- **Start**:
  ```bash
  supabase start
  services/api/supabase/atrezzo/orders/reset.sh postgresql://postgres@127.0.0.1:54322/postgres
  ```
  Or with `supabase db reset`: in `config.toml`, `[db.seed] sql_paths = ["./atrezzo/orders/seed.sql"]` (if your CLI version supports `sql_paths`).

Tested against a real PostgreSQL 17 (test `supabase: reset.sh …`, skipped without `initdb`): two runs in a row, counts and ids equal to the JSON, and a pre-existing table with `id GENERATED ALWAYS AS IDENTITY`.

#### Alternative: a PostgREST facade over `serve`/MSW

If you do not want to run Postgres, you can point the app's Supabase URL (in your app's own config) at the mock and translate what the app uses in front of `engine.handle`: `status=eq.x` → `status=x`, `in.(a,b)` → `a,b`, `Range: 0-11` → `offset=0&limit=12` (and answer `Content-Range`), `Accept: application/vnd.pgrst.object+json` → detail. GoTrue: `POST /auth/v1/token` with a fixed session for a world user. Do not reimplement PostgREST: only what the screen uses.

### prism

- **Does**: `world` writes `<generatedDir>/<scenario>.openapi.yaml` (OpenAPI 3.1) from the scenario endpoints: one schema per entity with `required` = fields never null in the world, filter and pagination parameters, `X-Total-Count`, `/{id}` detail with 404, and `examples` computed by the engine (the projection without a query, plus one per value of the first filter with ≤ 10 values, e.g. `status-issue`).
- **Does not**: filter or paginate. Prism returns the default example for **any** query (`?status=issue` returns all 40 orders); another example only with the `Prefer: example=status-issue` header. The detail always returns the first id (`/api/orders/999` → 200 with id 1) unless you send `Prefer: code=404`. With `-d` (dynamic) it generates data that is not the world. Filters are declared as `string` without `enum` because with an enum Prism would reject the `a,b` lists the engine accepts.
- **Does (Prism's own)**: validate requests against the parameters: `?limit=abc` → 400.
- **Start**: with `@stoplight/prism-cli` already among your project's dev dependencies, `prism mock atrezzo/.generated/orders.openapi.yaml --port 4010`.

The generated OpenAPI is covered by the automated `prism: …` tests (parseable OpenAPI 3.1, paths, `required`, and read identically by PyYAML). The Prism behavior described above was checked by hand with `@stoplight/prism-cli` 5.16.0 on an earlier version of the example (0.3, built on the old Spanish templates); it has not been re-run against the current `orders` scenario.

### wiremock

WireMock cannot run the projection: Handlebars has no sane way to filter + sort + slice an embedded array. So lists are **pre-generated**.

- **Does**: `world` writes one WireMock root per scenario in `<generatedDir>/wiremock/<scenario>/`, with `mappings/<endpoint>.json` and the bodies in `__files/`. Each list gets one mapping (`urlPath` + `queryParameters` with `equalTo`/`absent`) per enumerable combination:
  - no query;
  - each value of each filter, one at a time (if the field has ≤ 20 distinct values; `null` included);
  - pages of `default_limit`/`max_limit` (`limit=N` and `limit=N&offset=k`, up to 50 pages);
  - **the exact requests of the flows** (`flow.yaml` files whose `scenario` points here), e.g. `?status=issue&limit=12`.
  Body and `X-Total-Count` come from the engine: the same bytes as `serve`. The `/{id}` detail uses **response templating**: `bodyFileName: "<scenario>/<endpoint>/id/{{request.pathSegments.[n]}}.json"` with `transformers: ["response-template"]` declared in the mapping; unknown ids return 404.
- **Does not**: combined filters, `a,b` lists, other sort orders or pages not enumerated. Those requests fall into a low-priority mapping that answers **501** with `{"error": …, "generated": [...]}`: never a wrong page. If a screen requests a new combination, add it to a flow and run `world` again. It does not emit `X-Atrezzo-Ignored` either. Do not mix two scenarios in the same `mappings/` folder (routes clash): each scenario is its own root.
- **Start**:
  ```bash
  docker run --rm -p 4010:8080 -v "/path/to/your/project/atrezzo/.generated/wiremock/orders:/home/wiremock" wiremock/wiremock:3.13.2
  # or: java -jar wiremock-standalone-3.13.2.jar --root-dir atrezzo/.generated/wiremock/orders --port 4010
  ```
  To switch scenarios without restarting: `POST /__admin/mappings/reset` + `POST /__admin/mappings/import` with the other scenario's mappings.

The mappings are covered by the automated `wiremock: …` tests (`urlPath` + `bodyFileName`, templating with `transformers`, the 501 fallback, and the flow requests picked up by `world`). The run against a real server was done by hand with WireMock standalone 3.13.2 (Java 21) on an earlier version of the example (0.3, built on the old Spanish templates): 15 stubs loaded; the unfiltered list, one filter value and `?limit=12` returned 40/3/12 rows with their `X-Total-Count`; `/api/orders/7` came out via the template; `/api/orders/999` → 404; a filter + `limit` combination that was not pre-generated → 501. It has not been re-run against the current `orders` scenario.

## Gaps in each runtime

A gap is a request the scenario does not declare. **Only `atrezzo serve` (builtin) records them** in `atrezzo/.atrezzo/misses.json`; the other runtimes behave like this:

| runtime | what the app gets for an undeclared route | how to see it | recorded in `misses.json` |
|---|---|---|---|
| builtin (`serve`) | 404 with `{ error, atrezzo: { miss, gap, times, next, endpoints } }` (405 for a write to a contract route); with `--on-miss stub`, 200 `[]`/`{}` + `x-atrezzo-stub: true` | `atrezzo misses`, `GET /__atrezzo/misses`, `doctor` | yes |
| msw | depends on `onUnhandledRequest`: the suggested setup uses `'bypass'` (the request goes to the real network, or fails if there is no backend). `'warn'` prints it to the console; `'error'` breaks it | the browser/test console: `[MSW] Warning: intercepted a request without a matching request handler: GET /api/users` | no |
| prism | not applicable: Prism serves the OpenAPI that `world` generates, which contains exactly the scenario endpoints; anything else is a Prism 404 (`NO_PATH_MATCHED_ERROR`) | Prism log | no |
| wiremock | declared routes with a query that was not pre-generated → **501** with `{ error, generated: [...] }` (the list of combinations that do exist). Undeclared routes → WireMock's own 404 ("Request was not matched", with near misses) | `GET /__admin/requests/unmatched` | no |
| supabase | there are no routes: supabase-js queries `/rest/v1/<table>`. A table that does not exist → PostgREST error (`42P01` / `PGRST205`, "relation does not exist") | PostgREST response | no |

To catch gaps with MSW without switching runtimes, run the screen once against `atrezzo serve` (same engine, same routes) or use your own `onUnhandledRequest`:

```js
await setupWorker(...handlers).start({
  onUnhandledRequest(req, print) {
    if (new URL(req.url).pathname.startsWith('/api/')) print.warning(); // gap: /atrezzo:gap
  },
});
```

Filling the gap is the same everywhere: entity + endpoint in the scenario (`/atrezzo:gap`) and `atrezzo world`, which regenerates handlers, OpenAPI, mappings or `seed.sql`.

Latency, 5xx errors and timeouts are not part of the world: inject them in the runtime (MSW `delay()`/`HttpResponse.error()`, WireMock `fixedDelayMilliseconds`/`fault`), not in the scenario.

## Monorepo and separate front end/backend

`atrezzo.config.json` can carry a `workspace` block (paths relative to the config):

```json
"workspace": {
  "front": "apps/web",
  "backend": "services/api",
  "contract": "services/api/openapi.yaml"
}
```

- `front`: where the client lives. `msw` writes the handlers there (`apps/web/src/mocks/atrezzo/`), and the mock `baseUrl` comes from it: the Vite proxy target (`server.proxy['/api'].target`) or `NEXT_PUBLIC_API_URL`/`VITE_API_URL`/`REACT_APP_API_URL` in `.env*`. The prefix (`/api`) is stored in `mock.apiPrefix`.
- `backend`: where the contract and/or the database live. `supabase` writes next to `<backend>/supabase/` if it exists.
- `contract`: the spec, if it is not inside `backend` (or to pin it). `atrezzo import` without arguments uses it.

`atrezzo` (config, scenarios and `.generated/`) lives at the root where you run `init`; usually the monorepo root or the front-end repo.

### Case 1: monorepo

`init` reads `pnpm-workspace.yaml`, `workspaces` in `package.json`, `lerna.json`, `turbo.json` or `nx.json` (these two have no package list → `apps/*`, `packages/*`, `libs/*`, `services/*`) and classifies each package:

- **front end**: UI dependencies (react, vue, svelte, next, nuxt, vite, @angular/core, solid, preact, astro), `vite.config.*`/`next.config.*`/`index.html`, name `web`/`client`/`app`/`frontend`/`ui`.
- **backend**: server dependencies (express, fastify, @nestjs/core, hono, koa, @prisma/client, @supabase/supabase-js…), `openapi.{yaml,json}` or `supabase/` (they count double), a non-JS manifest (`requirements.txt`, `go.mod`, `pom.xml`…), name `api`/`server`/`backend`.

```bash
cd my-monorepo
atrezzo init                              # detects apps/web (front end) and services/api (backend)
atrezzo init --runtime msw,supabase       # handlers in apps/web and seed in services/api/supabase/atrezzo/
atrezzo import                            # uses workspace.contract
atrezzo world atrezzo/scenarios/api.yaml
```

### Case 2: two folders without a manifest

Sibling folders `client/`+`server/`, `web/`+`api/`, `frontend/`+`backend/` (and combinations) are classified the same way.

```bash
cd project                                # client/ (Vue + Vite)  server/ (FastAPI + openapi.json)
atrezzo init                              # front=client, backend=server, contract=server/openapi.json
atrezzo import                            # endpoints from server/openapi.json
atrezzo world atrezzo/scenarios/api.yaml
atrezzo serve --scenario api              # builtin: the backend is not JS; real HTTP on the front end's port
```

### Case 3: two repos

Run `init` in the front-end repo and point to the other one with relative paths:

```bash
cd ~/code/web
atrezzo init --front . --backend ../api --contract ../api/openapi.yaml
atrezzo import                            # reads ../api/openapi.yaml
atrezzo world atrezzo/scenarios/api.yaml
```

If the backend is Supabase in the other repo, `--backend ../api` makes `supabase` write to `../api/supabase/atrezzo/<scenario>/` (outside this repo: commit there, or point `--backend` at a folder of your own).

### Ambiguity: never a silent choice

With **two front-end candidates or none** (or more than one backend), `init` writes nothing, prints the table and exits with **2**:

```
atrezzo: Not choosing for you: 2 front-end candidates (apps/admin, apps/web).
Layout: monorepo: package.json#workspaces · packages from apps/*
  package     front  backend  role      reasons
  apps/admin      2        0  front     dep vue, dep vite
  apps/api        0        2  backend   dep express, name "api"
  apps/web        3        0  front     dep react, dep vite, name "web"
Name the front end and the backend: atrezzo init --front <path> --backend <path> [--contract <spec>]
```

```bash
atrezzo init --front apps/admin --backend apps/api
```

With explicit `--front`/`--backend` nothing is guessed; whatever you leave out is taken from detection only if it is unique.

### Path base: front end vs spec

The spec's `servers[0].url` can be relative (`/api`) or absolute (`https://api.example.com/v2`): `import` keeps the path, prepends it to every path and notes it in the report (`Base: /v2 (servers[0].url = "https://api.example.com/v2", absolute: keeping the path)`). If the front end uses another prefix (`mock.apiPrefix`, e.g. a proxy that rewrites `/api` → `/v2`), the report warns you: re-import with `--base /api`.
