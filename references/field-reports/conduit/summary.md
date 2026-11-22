# Field report: Conduit (project B)

## Project

| | |
|---|---|
| Project | `gothinkster/react-redux-realworld-example-app` (public), commit `ee72eba` (2021-09-07), shallow clone nobody in the atrezzo project had touched |
| Stack | React 16 + Redux + react-router 4, superagent, create-react-app (`react-scripts` 1.1.1). The API origin is a constant: `API_ROOT = 'https://conduit.productionready.io/api'` in `src/agent.js` |
| Contract | official RealWorld OpenAPI 3.1 (`gothinkster/realworld`, `specs/api/openapi.yml`): 12 paths, 19 operations |
| Backend | the public API is dead (`307` to `api.realworld.io`, which does not resolve): without a mock the app cannot show anything |
| atrezzo | `50b9372` (branch `32-f5-field-report`) |
| Period | one session, 2026-11-22, about 25 minutes of wall clock from `init` to the last bug reproduced |
| Who | an AI coding agent (Claude) acting as the adopter. **The times are a lower bound for a person**: command latency is real, reading and typing are not human-speed, and the DSL reference had been read before T0 |

Raw timeline: [`field-log.md`](field-log.md). Every scenario, flow, `verify --json` output and helper script is in
[`artifacts/`](artifacts/).

## Getting the app to run

- `npm install`: OK in 531 s, no `--legacy-peer-deps` needed.
- `npm start` **does not start** on Node 26: `Error: No such module: http_parser` (`http-deceiver`, a dependency of
  the react-scripts 1.x dev server, calls the removed `process.binding('http_parser')`). This is not a
  peer-dependency problem, so `--legacy-peer-deps` cannot fix it.
- `npm run build` works (49 s). Every measurement below runs on **the production build**, served by
  `atrezzo serve --static`, in a real Chromium driven by `verify --driver playwright`.
- To make the unmodified app call the mock, the build was copied to a scratch directory and `API_ROOT` was rewritten
  to `/api` **in that copy** (finding F1). The app's source was not modified.

## Results

### 1. Time to the first working mock
- **Value: 155 s** from `atrezzo init` to the first `verify` exit 0 on a real screen (home page: 10 article previews,
  6 tags, 3 page links; playwright driver, `--diagnose`).
- Milestones (offset from `init`): `init` done +3 s · `import` fails (YAML) +14 s · `import` from JSON writes 0 endpoints
  +29 s · bundle copy rewritten +70 s · first `world` (exit 0) +91 s · first `serve` +97 s · first `verify` (exit 2,
  no playwright in the project) +111 s · **first green +155 s**.
- Outside the 155 s: 531 s of `npm install` and 49 s of build (the app's cost, not atrezzo's), and the time spent
  reading the DSL reference before T0 (not measured).
- **Decision:** the plan's alarm is B > 2 h; 155 s (×10 for a human would still be under 30 min) does not trigger it.
  Even so, **all** of the friction was in the `init` / `import` path (F1–F4): `import` produced nothing usable and
  the scenario was written by hand from `src/agent.js`. If time is invested anywhere, it belongs in `import`
  (named envelopes, `wrap`, writes, nested paths), as the plan's rule says, not in features.

### 2. Time to a complex scenario
- **Value: 436 s** from `init` (234 s after starting the second scenario) to a green 3-step flow
  (`flows/session.yaml`: feed with a click on a favourite → article page with comments → profile with a click on
  Follow) on `conduit-session.yaml`: **4 entities** (tags, authors, articles, comments), seeded auth user, a
  world-resolved feed filter, **4 declared writes** (favourite, unfavourite, follow, comment). 7/7 assertions; stable
  in 5 more runs (5/5 green). The writes really mutate the world: after the flow the article reads
  `favorited: true`, dave reads `following: true`, and the feed grows from 16 to 21 articles because the filter sees
  the follow.
- It needed two workarounds that cost correctness: the favourite and follow writes answer a **static** wrapped body
  (`echo` ignores `wrap`, F5), and the comment write is stateless (`:slug` cannot be bound in `writes`, F6). The
  static favourite body names one slug, so it is only right for the article the flow clicks.
- **Decision:** far below the 1-day alarm; the DSL is not too verbose for this app. The defaults that did hurt were
  `POST` = `create` on action routes (F10) and the missing `wrap` on `echo` (F5).

### 3. Real bugs reproduced
- **Value: 2 / 2 attempted, 52 s and 60 s.** The two open upstream issues that touch data the mock controls were
  attempted; both reproduce as a flow that stays red while the bug exists:
  - **#197** "Your Feed pagination broken, not adding offset" (`Articles.feed()` ignores the page and always asks
    for `offset=0`): `flows/bugs/issue-197-feed-offset.yaml` on the correct scenario shows 10 rows on page 2 instead
    of 6. `--diagnose`: `[confirmed] render` (the mock delivers the expected 6). Right.
  - **#198** "No pagination for My Articles and Favorited Articles of a user" (`ListPagination` assumes 10 per page,
    the profile asks for 5): `flows/bugs/issue-198-profile-pages.yaml` shows 0 page links for 7 articles, so articles
    6–7 are unreachable. `--diagnose`: only `[possible] no-data` (a page count has no `data` to compare).
    Reproducing it needed a world with **one** author, because `?author=<username>` cannot be filtered (F7).
  - #198 was first found by accident, from a red row in the session flow, before looking at the tracker.
- The plan's metric is "every bug of the project in the period"; this project has no live period, so the sample is
  the tracker's open issues, chosen by the adopter. That is a weaker sample than A's.
- **Decision:** ≥ 50 %, so no new capability is justified by this metric. The capability that made #198 awkward
  (filtering through a parent's field, F7) is noted as the candidate if project A hits the same thing.

### 4. Maintenance when the front end changes
- **Not measured.** The front end did not change during the field period: the repository is frozen (last commit
  2021-09-07) and nobody is sending it PRs. A change made by the adopter would measure the adopter, not the DSL.
  This metric can only come from project A.
- **Decision:** none taken.

### 5. Gaps per week
- **Value at the end of the session: 0** (`atrezzo misses --json` → `[]`, `artifacts/misses.json`). There is no
  weekly series (a single session), so the trend the decision needs was **not measured**.
- The 0 is real but flattering: every endpoint was declared up front by reading `src/agent.js` (all 19 calls are in
  one file). The coverage holes this project does have are **query parameters the mock ignores**
  (`?author=`, `?favorited=`, `?tag=`), and those never appear in `misses` (F9): only in the
  `X-Atrezzo-Ignored` header.
- **Decision:** none on `gap`/`harvest` (no trend). F9 is a finding: ignored parameters are the real gaps of an app
  whose routes are all known.

### 6. Diagnosis accuracy in the field
Every KO row produced with `--diagnose` during the session (the session flow, the author-filter flow, 11 injected
causes × 2 drivers, and the two upstream bugs; the 5 repetition runs are left out):

| | rows | right |
|---|---|---|
| KO rows with a `confirmed` first hypothesis | 5 | **5 (1.00)**: 3 `page-error`, 1 `declared-error`, 1 `render` |
| KO rows with a `likely` first hypothesis | 9 | **6 (0.67)** |
| KO rows with nothing above `possible` | 10 | — (not counted as diagnosis) |

The three wrong `likely` share one mechanism: the hypothesis stays `likely` when the response cannot support it.
- `?author=carol` ignored by the mock (http): `[likely] pagination-mismatch` ("check the client's limit/offset");
  the cause is the ignored filter, which only gets `possible`. `pagination-mismatch` does not look at
  `X-Atrezzo-Ignored` the way `render` and `client-side-filter` do.
- page-style pagination declared, client sends `offset` (http): `[likely] world-mismatch`; the cause is the ignored
  `offset`, which is also reported as an "undeclared filter" with the advice to add it to `filters` (wrong: it is a
  pagination parameter).
- comments envelope declared with the wrong key (http): `[likely] world-mismatch`; the world is fine, the flow picks
  `comments` and the body has `data`. A missing `pick` key in the body is a provable fact that no heuristic checks.

Two more observations:
- `world-mismatch` only exists without a DOM count: the same empty-world cause is `[likely] world-mismatch` under
  `--driver http` and `[possible] no-hypothesis` under `--driver playwright` (2 cases).
- A `page-error` after a `click:` was caught in 6 of 7 runs; the miss left the row KO with only `[possible] no-data`
  (never green).

- **Decision:** the plan's alarm is `likely` < 60 % in the field; 0.67 does not trigger "remove heuristics". It
  is below the corpus threshold (0.8), and all three misses point at the same fix, which is **not** made here:
  `pagination-mismatch` and `world-mismatch` should drop to `possible` when the mock ignored a parameter it could not
  test (the rule `render` already follows), and a `pick` key absent from the body should be a finding of its own.
  With the field cases added, the corpus still holds (below), so by the plan's rule no heuristic is degraded yet.

### 7. Silent divergences between runtimes
- **Value: 0.** The app's request sequence (22 requests: every read the screens make, the three filters the mock
  ignores, two 404s, 4 writes and the reads after each) replayed through `serve` and through the generated handlers
  on real `msw/node` (`msw@2`): same status, `x-total-count`, `x-atrezzo-ignored`, `allow` and body on all 22, and
  the same state after every write. The only difference is the text of the 405 error, which
  `tests/parity-real.test.mjs` already documents (`artifacts/parity-serve-vs-msw.txt`).
- Limit: MSW was **not** run in the app's browser. The generated handlers import JSON with
  `with { type: "json" }`, which this toolchain (react-scripts 1.1.1, webpack 3, Babel 6) cannot compile (F12), so for
  this front end the `msw` runtime is not adoptable at all; `serve` is the only option.
- **Decision:** 0 → the matrix holds for this project; nothing to stop.

## Field findings

Nothing in atrezzo was patched during the session. Severity: **blocks** = no way forward inside atrezzo,
**cost** = a workaround outside the DSL or wrong results, **minor** = friction.

| # | Finding | Where | Workaround | Severity |
|---|---|---|---|---|
| F1 | No way to point a front end with a hard-coded absolute API origin at the mock: `serve`/`verify` have no proxy or origin mapping, and `init` reports `mock baseUrl … the front end declares no proxy or *_API_URL` without noticing `API_ROOT` in `src/agent.js` | first screen | rewrote the origin in a copy of the built bundle | blocks |
| F2 | `init` says `stack: other` for a create-react-app (`react-scripts`) project | `init` | none needed | minor |
| F3 | The YAML subset rejects the official RealWorld OpenAPI (multi-line plain scalar at line 167, valid YAML) | `import` | converted the spec to JSON outside atrezzo | cost |
| F4 | `import` infers **0 of 19 operations**: named envelopes (`{articles, articlesCount}`) and wrapped singletons are TODOs although `envelope:` and `wrap:` exist; writes are "not supported: atrezzo only projects reads" although `writes:` exists; nested paths with a parameter in the middle are dropped although the engine projects them | `import` | wrote the scenario by hand | cost |
| F5 | A write's `echo: true` answers the bare row, ignoring the GET endpoint's `wrap: article`; the app reads `payload.article.slug` and crashes | favourite / follow | static wrapped `body` + `mutate` (right for one slug only) | cost |
| F6 | In `writes`, a path parameter cannot be bound through the parent (`:slug` of `POST /api/articles/:slug/comments`) nor accepted as any value (`null`), which `endpoints` filters allow | comment write | `mutate: false` with a static body | cost |
| F7 | Filters cannot express a query parameter matched against a parent's field (`?author=<username>`, `?favorited=<username>`) or array membership (`?tag=` in `tagList`); the mock answers unfiltered with `X-Atrezzo-Ignored` | profile, tag tab | none inside the DSL; for #198, a world with a single author | cost |
| F8 | **False green**: with `--driver playwright` a row is OK whenever the DOM count matches; `data.where` and `X-Atrezzo-Ignored` are not looked at (`scripts/lib/verify.mjs:385`). The profile showed 5 articles by other authors and the row `carol's articles, first page` was OK | `profile-by-author.yaml` row 1 | none: kept the flow red on purpose for the pagination row | cost |
| F9 | `misses` reports 0 while the app's real coverage holes are ignored query parameters, which only show in a header | end of session | none | minor |
| F10 | `POST` on an action route (`/favorite`, `/follow`) defaults to `action: create`; the `world` banner shows it (`→ create articles`), which is how it was caught | `writes` | `action: update` | minor |
| F11 | Generated data: `slug: string` gives values with spaces (`"slug 13"`, bad in a URL); a typed `updatedAt` can precede `createdAt` | first world | `slug: uuid` | minor |
| F12 | Generated MSW handlers use import attributes (`with { type: "json" }`): unusable with older toolchains (webpack 3 / Babel 6) | parity | MSW measured in Node only | cost |
| F13 | Diagnosis: `pagination-mismatch` / `world-mismatch` stay `likely` when the mock ignored a parameter or the `pick` key is absent (3 of 9 field `likely` wrong); `world-mismatch` never fires under playwright; an ignored pagination parameter is reported as an undeclared filter | §6 | — | cost |
| F14 | A `page-error` raised by a `click:` was caught in 6 of 7 runs (timing); the miss stays KO, only the hypothesis is lost | `f5-favorite-echo` | — | minor |

What worked well and is worth keeping: `world` errors name the field and the reason (F6 was diagnosed from the
message alone); `POST /__atrezzo/reset {"scenario": …}` switched between 14 scenarios on one `serve` without a
restart; the world-resolved feed filter reacted to the follow write; `storage:` with a fake `jwt` was all the
session the app needed; `doctor` flagged the duplicate-slug variant before it was run; and the session flow was
stable (6 green runs out of 6 once fixed).

## Diagnosis cases added to the corpus

18 cases at the end of `CASES` in `tests/diagnosis.test.mjs` (block "F5 field cases: Conduit"). 17 come from the
injected-cause runs: `ctx` is rebuilt from the real responses (`artifacts/tools/capture.mjs`), and `diagnose()`
gives exactly the hypotheses `verify` printed, before and after trimming the items, for 16 of 17. The exception is
`null-author`, where `verify` shows `page-error` (the browser crash takes precedence) and the case keeps
`diagnose()`'s verdict on its data. The 18th is upstream bug #197.

| case | injected cause | first strong hypothesis | right? |
|---|---|---|---|
| `?author=` ignored, http | undeclared-filter | likely pagination-mismatch | no |
| `?tag=` ignored, http | undeclared-filter | — (undeclared-filter possible) | no strong |
| `?tag=` ignored, playwright | undeclared-filter | — (undeclared-filter possible) | no strong |
| max_limit 5, http | pagination-mismatch | likely pagination-mismatch | yes |
| max_limit 5, playwright | pagination-mismatch | likely pagination-mismatch | yes |
| endpoint sort reversed, http | pagination-mismatch | likely pagination-mismatch | yes |
| endpoint sort reversed, playwright | pagination-mismatch | likely pagination-mismatch | yes |
| empty feed (world), http | world-mismatch | likely world-mismatch | yes |
| empty feed (world), playwright | world-mismatch | — (no-hypothesis) | no strong |
| no tags (world), http | world-mismatch | likely world-mismatch | yes |
| no tags (world), playwright | world-mismatch | — (no-hypothesis) | no strong |
| declared 500 on `/api/tags`, http | declared-error | confirmed declared-error | yes |
| 3 articles without author, playwright | null-field (truth: render) | confirmed render | true finding, not the cause |
| page-style pagination / `offset` ignored, http | none of the types | likely world-mismatch | no |
| `offset` ignored, playwright (+ upstream #197) | none of the types | — (undeclared-filter possible) | right not to claim |
| wrong envelope key, http | none of the types | likely world-mismatch | no |
| wrong envelope key, playwright | none of the types | — (no-hypothesis) | right not to claim |
| upstream #197, playwright | render | confirmed render | yes |

Corpus after adding them (`node --test tests/diagnosis.test.mjs`): **56 cases; `confirmed` precision 18/18 = 1.00;
`likely` 28/32 = 0.88; top-1 46/56 = 0.82**. All 6 tests pass: the thresholds hold (`confirmed` = 1, `likely`
≥ 0.8). Top-1 is close to its 0.8 floor (it was 36/38 = 0.95 before the field cases).

## What was not measured, and why

- **Maintenance when the front end changes (metric 4):** the front end did not change during the period (frozen
  repository, no PRs). Only project A can give it.
- **Gaps per week (trend of metric 5):** one session, no weeks. Only the end value (0) was measured.
- **MSW in the browser (metric 7):** the generated handlers cannot be compiled by this app's toolchain (F12); parity
  was measured with `msw/node`.
- **Time for a human adopter (metrics 1–2):** the adopter was an AI agent; the numbers are a lower bound.
- **Saving against hand-written mocks:** the app had no mocks to compare against, and the plan treats it as an
  anecdote anyway.
- **Project A:** no access to its repository from this environment; its report is still pending.
