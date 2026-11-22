# Field report: Mealie (F5-bis, FastAPI + Nuxt)

## Project

| | |
|---|---|
| Project | `mealie-recipes/mealie` (public), branch `mealie-next`, commit `b4cadf7` (shallow clone; zero tracked files modified) |
| Stack | Backend: Python / FastAPI + Pydantic v2 (camelCase JSON via `CamelModel`, UUID v4 primary keys). Frontend: Nuxt 4.6.4 + Vue 3.5.45 + Vuetify 4.3.3 + Vite 8.3.8 + Axios (`ssr: false`, static SPA under `frontend/`). API calls use relative `/api/...` paths (`baseURL: "/"` in `frontend/app/plugins/axios.ts`) |
| Contract | Official Mealie OpenAPI 3.1.0 (`mealie.openapi.json`, 406,421 bytes, downloaded from `https://demo.mealie.io/openapi.json`): **197 paths, 285 operations** (126 GET, 85 POST, 38 PUT, 33 DELETE, 3 PATCH), **265 schemas** |
| Backend | Not started; all screens and API flows ran exclusively against `atrezzo serve` (and `msw/node` for parity) |
| atrezzo | `a6ad5e7` (branch `33-f5-mealie`) |
| Period | One session, 2026-11-22, ~16 minutes of wall clock from `init` to parity and final misses |
| Who | AI coding agent acting as the adopter. **Times are a lower bound for a human developer**: command execution and build latency are real, while reading and YAML authoring are faster than human speed. `references/scenario.md` and Mealie's frontend boot/API files were read before T0 (not inside the measured times) |

Raw command log with `date +%s` timestamps: [`field-log.md`](field-log.md). Archived scenarios, flows, fixtures, `import` output, `verify --json` outputs, `misses.json`, and parity script/report: [`artifacts/`](artifacts/).

## Getting the Mealie front end to run

- `frontend/node_modules` was already present in the cloned workspace (`pnpm install` was not re-run; **not measured**).
- `cd frontend && pnpm run generate` (`nuxt generate --spa`) **succeeded cleanly in 195 s** (`1795379915` → `1795380110`, exit 0), building `frontend/.output/public` (513 precached entries, 13.46 MiB).
- Because Mealie's Axios client uses relative `baseURL: "/"` (`frontend/app/plugins/axios.ts:74`), `atrezzo serve --static frontend/.output/public --port 4010` served the **unmodified** production Nuxt 4 SPA directly alongside the mocked `/api/*` routes in real Chromium (`--driver playwright`), with no bundle rewriting needed (a notable improvement over Conduit's hard-coded `API_ROOT`).

## Import (`init --contract mealie.openapi.json` + `import`)

Commands run in `/root/work/field-mealie`:

```bash
node /root/work/atrezzo/scripts/cli.mjs init --contract mealie.openapi.json
node /root/work/atrezzo/scripts/cli.mjs import mealie.openapi.json
```

| Item | Measured value |
|---|---|
| `init --contract mealie.openapi.json` duration | **0 s** (`1795380130` → `1795380130`, exit 0) |
| `import mealie.openapi.json` duration | **2 s** (`1795380140` → `1795380142`, exit 0) |
| Spec size | 197 paths, 285 operations, 265 schemas (OpenAPI 3.1.0, 406 KB) |
| Inferred list endpoints | **33** (+ **24** derived `/:id` detail routes = **57 / 285 operations**, 20.0%) |
| Inferred entities | **28** (`atrezzo/scenarios/api.yaml`, 21,177 bytes, valid scenario out of the box) |
| Marked `# TODO` in YAML | **29** (25 singleton object endpoints such as `/api/app/about`, `/api/users/self`, `/api/groups/self`; 4 schemaless/untyped responses) |
| Ignored operations | **199**: 159 writes (`mutation not supported: atrezzo only projects reads (GET)`), 24 nested paths with parameters in the middle (all `/api/explore/groups/{group_slug}/*` public SPA routes and `/api/media/*`), 8 detail routes without a projectable list, 8 `200 without schema (no content)` |
| Skipped fields across the 28 entities | **84 fields lost**: **63 `(no type)`** — **63 / 63 (100%)** are OpenAPI 3.1 / Pydantic v2 nullable `anyOf: [{type: ...}, {type: "null"}]` fields — plus 16 nested arrays (`tags`, `tools`, `recipeCategory`, ...) and 5 nested objects |
| Warnings / Notes emitted | **27 notes**: 25 entities with `id: string (uuid4)` coerced to integer `1..n`; 2 entities (`invite_token_outs`, `recipe_suggestion_response_items`) with synthetic integer `id` added; per-endpoint notes on ignored query params (`orderBy`, `orderByNullPosition`, `orderDirection`, `queryFilter`, `paginationSeed`) and envelope mismatch (`page, per_page, total, total_pages, next, previous` vs atrezzo's default `pick: items` emitting `{items, total, limit, offset}`) |

**What `init` warned / missed:** `init` did not detect the `frontend/` + `mealie/` Python/Nuxt split; it reported `single project (no monorepo or front/back folders)`, `workspace: front=.`, `detected stack: other`, and missed `runtimeConfig.apiUrl` in `frontend/nuxt.config.ts` (finding **M1**).

**Contrast with Conduit:** unlike Conduit (0 / 19 inferred), `import` immediately generated a valid 28-entity, 33-endpoint scenario in 2 seconds that built with `atrezzo world` in 1 second (`1795380164` → `1795380165`) and answered real populated rows (`GET /api/recipes?page=1&perPage=3` → 3 of 30 rows) without manual edits. However, the imported scenario **could not boot the Mealie UI** because `GET /api/app/about` (marked `# TODO`), `/api/explore/groups/{group_slug}/*` (ignored as nested paths), all 63 Pydantic nullable fields (including `RecipeSummary.description`, `rating`, `createdAt`, `UserOut.username`, `fullName`), and `tags: []` were missing.

## Results (the seven F5 metrics)

### 1. Time to the first working mock
- **Value (API — list with real rows, not `[]`):** **72 s** from `init` (`1795380130` → `1795380202`) using the directly imported `api.yaml` (`GET /api/recipes?page=1&perPage=3`, `/api/organizers/tags`, `/api/foods`, `/api/admin/groups`).
- **Value (real Mealie UI — first `verify --driver playwright` exit 0):** **199 s** (3 min 19 s) from `init` (`1795380130` → `1795380329`) on `/g/home` (`mealie-home.yaml` + `flows/home.yaml`: 12 real Mealie recipe cards rendered in Chromium, 0 console errors, 0 misses).
- **Milestones (offset from T0 = `init` at `1795380130`):**
  - `init --contract mealie.openapi.json`: **+0 s** (`1795380130`)
  - `import mealie.openapi.json`: **+12 s** (`1795380142`, duration 2 s)
  - `world api.yaml`: **+35 s** (`1795380165`, duration 1 s)
  - `serve --scenario api --static frontend/.output/public`: **+52 s** (`1795380182`)
  - First populated API list (`GET /api/recipes?page=1&perPage=3`): **+72 s** (`1795380202`)
  - First UI boot probe against `api.yaml` (RED on missing `/api/app/about`): **+121 s** (`1795380251`)
  - `world mealie-home.yaml` (hand-authored for real SPA boot + `/api/explore/groups/:group_slug/*`): **+169 s** (`1795380299`)
  - **First green `verify --driver playwright` on real Mealie UI (`/g/home`, 12 cards):** **+199 s** (`1795380329`)
- **Outside T0:** 195 s for `pnpm run generate` (`frontend/node_modules` pre-existing, `pnpm install` not measured) and pre-T0 reading of `references/scenario.md` and Mealie's API client files.
- **Decision:** Far below the 2 h alarm (`> 2 h → invest in init/import/scene`). Even so, `import` got us to an HTTP mock in 72 s but could not boot a single UI screen because of OpenAPI 3.1 `anyOf` nullables (M3), missing singleton inference (M5), ignored nested paths (M5), and `pick:` instead of `envelope:` (M4). Investing in those exact `import` gaps would cut the UI path dramatically.

### 2. Time to a complex scenario
- **What was built (`atrezzo/scenarios/kitchen.yaml`):** **15 entities** with relational `ref:` + `derive:` chains (`groups → households → users`, `groups → labels → foods`, `recipes → ingredients → foods`, `recipes → tags / tools / comments`, `cookbooks`, `categories`, `units`, `app_about`, `app_theme`), seeded session user (`auth: { user: { entity: users, id: 1 } }`), **26 GET endpoints** (using `envelope:` with `total_pages`, `sorts:`, `embed:`, `include:`, `counts:`, `$user.*`, and `passthrough:` + `patch:`), and **9 declared `writes`** (`POST`/`PUT`/`DELETE /api/organizers/tags`, `POST /api/foods`, `POST /api/recipes`, `PATCH /api/recipes/:slug`, `POST`/`DELETE /api/admin/groups`, `POST /api/comments` with `set: { user_id: "$user.id" }`).
- **Both HTTP and real UI flows were verified GREEN:**
  - **3-step HTTP flow (`flows/kitchen-http.yaml`) + live writes/FK integrity:** **484 s** (8 min 04 s) from `init` (`1795380130` → `1795380614`; 9/9 OK across `recipes → ingredients`, `groups → users`, `tags`, `foods → labels`, `comments`). Live write verification (`1795380614` → `1795380617`, 3 s) confirmed stateful `POST`/`PUT`/`DELETE` on tags, `POST` + `DELETE` on groups (returning `409` on group #1 with children and `204` on empty group #3), `422` on nonexistent `foods.label_id=999`, `$user.id` injection on `POST /api/comments`, and slug-keyed `PATCH /api/recipes/pasta-carbonara` reflected on subsequent `GET`.
  - **3-step real UI Playwright flow (`flows/kitchen-ui.yaml`):** **703 s** (11 min 43 s) from `init` (`1795380130` → `1795380833`; **5/5 OK, 0 console errors, 0 misses**) against the unmodified Mealie Nuxt SPA in real Chromium:
    1. `/g/home` (Recipe Explorer): 12 recipe cards + 6 embedded tag chips rendered.
    2. `/g/home/cookbooks/weeknight` (Cookbook detail): 6 filtered weeknight recipe cards rendered.
    3. `/g/home/r/pasta-carbonara` (Recipe detail): 3 visible recipe ingredients + 3 organizer chips (categories & tags) rendered.
- **Workarounds required:**
  - `GET /api/explore/groups/home/recipes/pasta-carbonara` had to use `passthrough:` + `patch:` instead of pure world projection because atrezzo forbids camelCase entity names (`world.recipeIngredient` → exit 3) and has no key-rename on `embed:` (finding **M7**).
  - Organizer/food/tag/cookbook list endpoints had to omit `pagination:` because Mealie sends `page=1&perPage=-1`, which atrezzo rejects with HTTP 400 (finding **M2**).
  - Authenticated UI pages (`/admin/manage/groups`) could not be verified in Playwright because Mealie reads `document.cookie` (`mealie.access_token`) and `verify` only sets `extraHTTPHeaders` (`--header "Cookie: ..."`) or `localStorage`/`sessionStorage`, not browser cookies (finding **M8**). Those endpoints (`groups → users`, `foods`, `tags`, `labels`, `writes`) were therefore verified via `kitchen-http.yaml` and HTTP write checks.
- **Decision:** Well below the 1-day alarm (`> 1 day → DSL too verbose`). The DSL handled 15 related entities and 9 writes concisely; the real friction came from FastAPI/Pydantic camelCase & `perPage=-1` conventions (M2, M7, M9, M11) and browser cookie auth (M8).

### 3. Real bugs reproduced
- **Not measured.** This session focused on F5-bis adoption (import, real UI boot, complex scenario, gaps, diagnosis, and runtime parity) rather than reproducing Mealie upstream GitHub issues. (One minor upstream typo was noticed while reading `frontend/app/lib/api/public/explore/organizers.ts:14` where `toolsGroupSlugToolId` omits `/${toolId}`, not turned into a flow.)
- **Decision:** None taken from this metric.

### 4. Maintenance when the front end changes
- **Not measured.** Single session against a static checkout (`b4cadf7`); no front-end PRs were authored or merged during the field work.
- **Decision:** None taken.

### 5. Gaps per week
- **Value at end of session:** **0 unresolved gaps** (`atrezzo misses --json` → `{"misses": [], "unresolved": 0}`, archived in [`artifacts/misses.json`](artifacts/misses.json)).
- **During the session**, `misses` proved genuinely useful for closing UI boot gaps iteratively:
  - Boot probe on `api.yaml`: 1 gap (`GET /api/app/about`).
  - `kitchen-ui` v1: 3 gaps (`GET /api/households/cookbooks`, `GET /api/units`, `GET /api/groups/households/undefined` — the last caused by missing camelCase `householdId`, finding **M11**).
  - `kitchen-ui` v2: 1 gap (`GET /api/groups/members`).
  - Final `kitchen-ui` & `kitchen-http`: **0 gaps**.
- **Weekly trend:** **not measured** (single session). As in Conduit, ignored query parameters (`page`, `perPage`, `orderBy`, `orderDirection` on unpaginated lists) never show up in `misses`, only in `X-Atrezzo-Ignored`.
- **Decision:** None on weekly trend.

### 6. Diagnosis accuracy in the field
Every real KO row produced with `verify --diagnose` during the session (5 organic KOs encountered while adopting + 12 injected-cause KOs: 7 HTTP + 5 Playwright; archived under [`artifacts/verify/`](artifacts/verify/)):

| Category | Rows | Right | Accuracy |
|---|---:|---:|---:|
| KO rows with a `confirmed` first hypothesis (all `verify` outputs) | 7 | **5** | **0.71** |
| — of which inside `diagnose()` / non-`wait_for` (`declared-error`, `non-200-response`, `render`, redirect `navigation`) | 5 | **5** | **1.00** |
| — of which `wait_for` timeout synthesized as `confirmed: navigation` by `verify.mjs` | 2 | **0** | **0.00** |
| KO rows with a `likely` first hypothesis | 7 | **4** | **0.57** |
| KO rows with nothing above `possible` | 3 | — | not counted |

Full breakdown of all 17 KO rows:

| # | Run / Case | Driver | Real cause | First strong hypothesis | Right? |
|---|---|---|---|---|---|
| 1 | `boot-probe` (`api.yaml`) | playwright | Missing `GET /api/app/about` (404) broke Nuxt boot | `confirmed: navigation` | **No** (not navigation; `wait_for` timeout) |
| 2 | `kitchen-http` v1 row 9 | http | `comments: 6` across 12 recipes → recipe 1 had 0 | `likely: world-mismatch` | **Yes** |
| 3 | `kitchen-ui` v1 row 4 | playwright | Missing camelCase `recipeIngredient` crashed Vue (`console.error`) | `confirmed: navigation` ("scenario not the cause") | **No** (false `confirmed`; scenario WAS the cause) |
| 4 | `kitchen-ui` v2 row 4 | playwright | `.ingredient-list-item` matched 9 DOM copies (normal+cook+print) vs 3 JSON | `confirmed: render` (also emitted `possible: null-field` despite 9 > 3) | **Yes** |
| 5 | `auth-cookie-probe` | playwright | Redirect `/admin/manage/groups` → `/login` (cookie not in `document.cookie`) | `confirmed: navigation` | **Yes** |
| 6 | `inj-declared-500` | http | Declared `error: { status: 500 }` | `confirmed: declared-error` | **Yes** |
| 7 | `inj-declared-500` | playwright | Declared `error: { status: 500 }` | `confirmed: declared-error` | **Yes** |
| 8 | `inj-perpage-neg1` | http | `perPage=-1` rejected with HTTP 400 | `confirmed: non-200-response` | **Yes** |
| 9 | `inj-empty-tags` | http | `tags.total: 0` | `likely: world-mismatch` | **Yes** |
| 10 | `inj-empty-tags` | playwright | `tags.total: 0` | — (`possible: no-hypothesis`) | no strong |
| 11 | `inj-ignored-cookbook` | http | `cookbook` omitted from `filters` | `likely: undeclared-filter` | **Yes** |
| 12 | `inj-ignored-cookbook` | playwright | `cookbook` omitted from `filters` | `likely: undeclared-filter` | **Yes** |
| 13 | `inj-ignored-sort` | http | `sorts:` omitted; client sends `orderBy=rating&orderDirection=desc` | `likely: pagination-mismatch` (`orderDirection` labeled `undeclared-filter`) | **No** |
| 14 | `inj-max-limit` | http | `max_limit: 5` on `perPage=24` (`X-Total-Count: 12`) | `likely: world-mismatch` ("unpaginated, 5 items match") | **No** |
| 15 | `inj-max-limit` | playwright | `max_limit: 5` on `perPage=24` (`X-Total-Count: 12`) | — (`possible: no-hypothesis`) | no strong |
| 16 | `inj-wrong-envelope` | http | `envelope.items: data`, flow picks `items` | `likely: world-mismatch` | **No** |
| 17 | `inj-wrong-envelope` | playwright | `envelope.items: data`, flow picks `items` | — (`possible: no-hypothesis`; Vue logged `TypeError` in `console.error`) | no strong |

- **Decision (ALARM TRIGGERED):**
  1. **`likely` precision in the field is 4/7 = 0.57 (< 0.60 plan alarm).** Two of the three misses are directly caused by FastAPI/Mealie conventions that Conduit did not exercise: `max_limit` clamping `verify`'s unpaginated probe on `perPage` page pagination (ignoring `X-Total-Count: 12`, bug **B2**) and `orderDirection` not recognized as a sort-direction parameter (bug **B3**), plus the wrong-envelope-key bug already seen in Conduit (**B4**).
  2. **Two false `confirmed: navigation` hypotheses** occurred on real Mealie UI screens because `verify.mjs` turns any `wait_for` timeout without an uncaught `pageerror` into `confirmed: navigation` ("the scenario and selectors are not the cause"), even when the browser never redirected and Vue logged a `TypeError` via `console.error` or an API boot call returned 404 (bug **B1**). By the plan's rule (`confirmed` precision must be 1.0), `wait_for` timeout without an actual redirect or HTTP ≥ 400 document response should **not** be `confirmed: navigation`.
  3. `tests/diagnosis.test.mjs` was **not modified** in this branch (per task instructions). Running the untouched corpus passes: `node --test tests/diagnosis.test.mjs` (56 cases; `confirmed` 18/18 = 1.00, `likely` 28/32 = 0.88, top-1 46/56 = 0.82).

### 7. Silent divergences between runtimes (`serve` vs MSW)
- **Value: 0 silent divergences.**
- **Evidence:** Generated `kitchen.handlers.mjs` with `runtime: msw` in a scratch workspace (`2 s`, `1795380961` → `1795380963`) and replayed **27 Mealie requests** (`artifacts/tools/parity.mjs` → `artifacts/parity-serve-vs-msw.txt`, `10 s`, `1795381004` → `1795381014`) against both `atrezzo serve` (port 4011) and real `msw/node` (`msw@2`):
  - All reads (`shape: object`, `$user.*`, `embed`, `include`, `counts`, `sorts`, page pagination, `cookbook` filter, literal `passthrough`+`patch` overriding `:group_slug/:slug`, `perPage=-1` 400 error, `HEAD /api/recipes` with `Prefer: count=exact`).
  - Undeclared write (`DELETE /api/foods/1` → 405 with identical `Allow: GET` header; only the 405 JSON body differs because `serve` adds `atrezzo.miss` gap metadata while MSW returns the compact error string — already documented in F2/Conduit).
  - Stateful writes (`POST`/`PUT`/`DELETE /api/organizers/tags`, `DELETE /api/admin/groups/1` → 409 FK conflict, `POST /api/foods` with bad `label_id=999` → 422, `POST /api/comments` with `$user.id`, `PATCH /api/recipes/pasta-carbonara` by `:slug`, and subsequent `GET` verifying mutated state).
- **Limit:** MSW was measured in Node (`msw/node`), not in the Mealie browser worker (registering a Service Worker would require modifying Mealie's source code). Unlike Conduit's Webpack 3, Mealie's Vite 8 / Nuxt 4 toolchain supports ESM `with { type: "json" }`.
- **Decision:** 0 silent divergences → the F2 parity matrix holds for Mealie as well.

## Field findings

Nothing in atrezzo was patched during this validation. Severity: **blocks** = no way forward inside the DSL/CLI without an external workaround or abandoning a screen, **cost** = workaround or wrong result, **minor** = friction.

| # | Finding | Triggering command / Where | Workaround used | Severity |
|---|---|---|---|---|
| M1 | `init` and `doctor` miss the `frontend/` + `mealie/` (Python/FastAPI + Nuxt) layout, reporting `single project`, `front=.`, `stack: other — no package.json`, and missing `runtimeConfig.apiUrl` in `frontend/nuxt.config.ts` | `node /root/work/atrezzo/scripts/cli.mjs init --contract mealie.openapi.json` and `doctor` in `/root/work/field-mealie` | Passed `--static frontend/.output/public` explicitly to `serve` | minor |
| M2 | Pagination rejects `perPage=-1` with HTTP 400 (`"perPage" must be an integer >= 0; got "-1"`). Mealie's `BaseCRUDAPIReadOnly.getAll()` sends `?page=1&perPage=-1` on almost every organizer/food/tag/cookbook/group list to mean "all rows" | `curl -i "http://127.0.0.1:4010/api/recipes?page=1&perPage=-1"` against `api` or `kitchen` | Omitted `pagination:` on all `perPage=-1` endpoints (causing `page, perPage` to appear in `X-Atrezzo-Ignored`) | cost |
| M3 | `import` drops **100% of OpenAPI 3.1 / Pydantic v2 nullable fields** (`anyOf: [{type: ...}, {type: "null"}]`) as `(no type)` — 63 of 63 `(no type)` skipped fields across the 28 entities (including `description`, `rating`, `image`, `createdAt`, `username`, `fullName`, `slug`) | `node /root/work/atrezzo/scripts/cli.mjs import mealie.openapi.json` | Authored `mealie-home.yaml` and `kitchen.yaml` by hand | cost |
| M4 | `import` emits `pick: items` (`{items, total, limit, offset}`) instead of `envelope: {items, total, page, per_page, total_pages}` even though the OpenAPI `PaginationBase_*` schemas declare those exact keys and atrezzo already supports `envelope:` + `total_pages` | `node /root/work/atrezzo/scripts/cli.mjs import mealie.openapi.json` | Replaced `pick: items` with `envelope:` by hand | cost |
| M5 | `import` leaves all 25 singleton endpoints as `# TODO` (including `/api/app/about`, `/api/users/self`, `/api/groups/self`), ignores all 24 nested paths with middle params (every `/api/explore/groups/{group_slug}/*` route) and all 159 writes, emits noisy duplicated Pydantic schema entity names (`user_out_outputs` vs `user_summaries`), and infers zero `ref:` relations | `node /root/work/atrezzo/scripts/cli.mjs import mealie.openapi.json` | Wrote `mealie-home.yaml` and `kitchen.yaml` by hand | cost |
| M6 | Generated values break realistic Mealie UI assumptions: `slug: string` contains spaces (`"slug 1"`), `name: string` generates person names (`"Olivia Rossi"`) for recipes/tags/foods/groups, `id` is integer `1..n` instead of UUID string (Mealie's explorer calls `category.id.includes(...)`), and independent `date` fields can generate `updated_at < created_at` | `atrezzo world api.yaml` + `curl http://127.0.0.1:4010/api/recipes?page=1&perPage=3` | Declared explicit `values:` / `values_order: cycle` lists | minor |
| M7 | **CamelCase embedded arrays cannot be projected**: `world` rejects camelCase entity names (`world.recipeIngredient` → exit 3: `entity names use lowercase letters, digits or "_"`) and `embed:` has no key-rename syntax. Mealie's `RecipePage.vue` requires `recipeIngredient`, `recipeInstructions`, `recipeCategory` (and nested objects `settings`, `nutrition`) and crashes with 3 Vue `TypeError`s when they are absent | `node /root/work/atrezzo/scripts/cli.mjs world /tmp/test-camel.yaml` (exit 3); `verify atrezzo/flows/kitchen-ui.yaml --driver playwright` before passthrough | Used `passthrough:` + `patch:` fixture for `/api/explore/groups/home/recipes/pasta-carbonara` (static for one slug only); kept world-projected `ingredients` on `/api/recipes` | blocks (for world-projected camelCase embeds) |
| M8 | **No browser cookie seeding in `verify` / `storage:`**: Mealie reads its session token from `document.cookie` (`mealie.access_token`). `--header "Cookie: ..."` only sets Playwright's `extraHTTPHeaders` (invisible to `document.cookie`), and `storage:` only seeds `localStorage`/`sessionStorage`, so auth-gated screens (`/admin/manage/groups`) always redirect to `/login` | `NODE_PATH=/root/work/atrezzo/node_modules node /root/work/atrezzo/scripts/cli.mjs verify atrezzo/flows/auth-cookie-probe.yaml --driver playwright --diagnose --header "Cookie: mealie.access_token=..."` | Verified authenticated routes (`groups → users`, `tags`, `foods`, `labels`, writes) via `--driver http` and verified public screens in Playwright | blocks (for cookie-auth SPAs in Playwright) |
| M9 | Query filters cannot alias to a differently-named entity field (`filters: { cookbook: cookbookSlug }` → exit 3), unlike path parameters (`":group_slug": groupSlug`) | `node /root/work/atrezzo/scripts/cli.mjs world atrezzo/scenarios/kitchen.yaml` (attempt 1, exit 3) | Renamed entity field from `cookbookSlug` to `cookbook` | minor |
| M10 | **False `confirmed: navigation` on `wait_for` timeouts**: when a screen stays on the target URL (200 OK, no redirect) but fails to render `wait_for` because of a 404 boot API (`boot-probe`) or a Vue-caught `TypeError` in `console.error` (`kitchen-ui` v1), `verify --diagnose` emits `[confirmed] navigation: ... the scenario and selectors are not the cause` | `verify atrezzo/flows/boot-probe.yaml --driver playwright --diagnose` and `verify atrezzo/flows/kitchen-ui.yaml --driver playwright --diagnose` (v1) | Read `console.error` warnings and `atrezzo misses` manually | cost |
| M11 | `ref:` always generates snake_case FK names (`household_id`, `group_id`, `user_id`), whereas Mealie's FastAPI/Pydantic API reads camelCase (`householdId`, `groupId`, `userId`); `RecipePageHeader.vue` fired `GET /api/groups/households/undefined` when `householdId` was absent | `verify atrezzo/flows/kitchen-ui.yaml --driver playwright` (v1) + `atrezzo misses --json` | Added camelCase fields alongside FKs or used `passthrough` fixture | minor |
| M12 | `verify --diagnose` misdiagnoses two camelCase/page-pagination cases: (a) `max_limit: 5` on `perPage=24` reports `likely: world-mismatch` (HTTP) / `possible: no-hypothesis` (Playwright) despite `X-Total-Count: 12`; (b) ignored `orderBy=rating&orderDirection=desc` classifies `orderDirection` as `undeclared-filter` and promotes `likely: pagination-mismatch` over `ignored-sort`; (c) `possible: null-field` fires even when `obtained (9) > expected (3)` | `verify atrezzo/flows/inject/inj-max-limit.yaml --driver http --diagnose`; `verify atrezzo/flows/inject/inj-ignored-sort.yaml --driver http --diagnose`; `kitchen-ui` v2 row 4 | Manual inspection of `X-Total-Count` and `X-Atrezzo-Ignored` | cost |
| M13 | Slug-keyed detail routes (`/api/recipes/:slug`) collide with default `detail: true` (`/:id`) unless `detail: false` is explicitly added on the collection endpoint; `doctor` also warns on tenant path params (`:group_slug` having 1 value across 12 rows: `"the parameter cannot select one row"`) even though `:group_slug` scopes a list, not a single row | `atrezzo doctor` in `/root/work/field-mealie` | Added `detail: false` on slug-keyed collections; ignored `doctor` `:group_slug` warnings | minor |

## Clear bugs to file

The findings above include 6 concrete bugs in atrezzo (not fixed here, per F5 rules):

1. **B1 — False `confirmed: navigation` on `wait_for` timeout without redirect (M10):** `verify.mjs` emits `[confirmed] navigation` ("the scenario and selectors are not the cause") when `wait_for` times out on the intended URL due to a 404 boot request or a Vue-caught `TypeError` logged to `console.error`. Violates the F4 invariant (`confirmed` precision = 1.0).
2. **B2 — `max_limit` on `perPage` page-paginated endpoints breaks `fullMatched` and misdiagnoses as `world-mismatch` / `no-hypothesis` (M12a):** With `pagination: { param_page: page, param_limit: perPage, default_limit: 24, max_limit: 5 }`, `verify`'s unpaginated probe is still clamped to 5, ignoring `X-Total-Count: 12`, so HTTP emits `[likely] world-mismatch` ("unpaginated, 5 items match") and Playwright emits `[possible] no-hypothesis`.
3. **B3 — CamelCase `orderDirection` misclassified as `undeclared-filter`, breaking `ignored-sort` counterfactual (M12b):** On `?orderBy=rating&orderDirection=desc`, `diagnose.mjs` flags `orderDirection` as an undeclared equality filter instead of a sort direction, leaving `ignored-sort` at `possible` while `pagination-mismatch` wrongly wins `likely`.
4. **B4 — Missing `pick` key in JSON envelope misdiagnosed as `likely: world-mismatch` (M12 / also in Conduit):** When an endpoint returns `{ data: [...] }` and the flow picks `items`, `verify --driver http` reports `[likely] world-mismatch` instead of reporting that the `items` key is absent from the response object.
5. **B5 — `import` skips all OpenAPI 3.1 nullable `anyOf: [T, null]` properties as `(no type)` (M3):** Every FastAPI / Pydantic v2 optional field is silently dropped (63/63 `(no type)` skips in `mealie.openapi.json`).
6. **B6 — `possible: null-field` fires when `obtained > expected` (M12c):** When the DOM had 9 elements vs expected 3 (`kitchen-ui` v2 row 4), `diagnose()` still emitted `null-field` claiming "rows go missing".

## What was not measured, and why

- **`pnpm install` duration:** `frontend/node_modules` was already populated in `/root/work/field-mealie/frontend` before the session started.
- **Real bugs reproduced (metric 3):** Not attempted in this session (focused on adoption, complex UI/API scenario, gaps, diagnosis, and runtime parity).
- **Maintenance when the front end changes (metric 4):** Single session against a static checkout (`b4cadf7`); no front-end PRs.
- **Gaps per week trend (metric 5):** Single session (end-of-session count `0` was measured; multi-week trend was not).
- **MSW in the Mealie browser (metric 7):** Wiring `setupWorker` into Mealie's Nuxt plugins would violate the rule against modifying `/root/work/field-mealie`; parity was measured in Node with real `msw/node` (`msw@2`).
- **Human adopter speed (metrics 1–2):** Adopted by an AI agent; measured times are a lower bound.
