# Field log: Conduit (react-redux-realworld-example-app)

Raw timeline of the field session. Epochs come from `date +%s` taken around each command; offsets are from
T0 = `atrezzo init`. One session, 2026-11-22, on atrezzo `50b9372` (branch `32-f5-field-report`) and the
front end at `ee72eba` (2021-09-07, shallow clone, never touched by the atrezzo project).

**Who ran it:** an AI coding agent (Claude), not a human developer. Wall-clock times are therefore a
lower bound for a person: command latency is real, but reading and typing are much faster than a human's.
Before T0 the agent had read `references/scenario.md` (≈ 900 lines), the `init`/`verify` skills and the
README headings; that reading is **not** inside the measured times.

## Before T0 (getting the front end to run)

| epoch | offset | step | result |
|---|---|---|---|
| 1795375883 | −694 s | `npm install` | exit 0 after **531 s**; 164 audit warnings; no `--legacy-peer-deps` needed |
| 1795376423 | −154 s | `npm start` (react-scripts 1.1.1 dev server, port 4100) | **fails** on Node 26: `Error: No such module: http_parser` from `http-deceiver` (`process.binding` removed). Not a peer-dependency problem, so `--legacy-peer-deps` cannot fix it |
| 1795376521 | −56 s | `npm run build` | exit 0 after **49 s** (`build/static/js/main.*.js`, 86.5 KB gzip) |
| — | — | public backend | `https://conduit.productionready.io/api/tags` → `307` to `api.realworld.io`, which does not resolve: **the app has no working backend** without a mock |
| — | — | contract | official spec downloaded from `gothinkster/realworld` `specs/api/openapi.yml` (OpenAPI 3.1, 12 paths, 19 operations) |

## T0 → first green

| epoch | offset | command | result |
|---|---|---|---|
| 1795376577 | 0 s | `atrezzo runtimes` + `atrezzo init` | exit 0 in 3 s. Runtime `builtin` (only signal). `stack: other` for a create-react-app project. `mock baseUrl: http://127.0.0.1:4010 (default: the front end declares no proxy or *_API_URL)`: the hard-coded `API_ROOT = 'https://conduit.productionready.io/api'` in `src/agent.js` was not seen |
| 1795376591 | +14 s | `atrezzo import openapi.yml --name conduit --base /api` | **exit 3**: `invalid YAML: unexpected indentation inside a map` at line 167, a multi-line plain scalar (`description:` wrapped onto a second line), valid YAML that atrezzo's subset rejects. The message suggests converting to JSON |
| 1795376606 | +29 s | same, after converting the spec to JSON with PyYAML | exit 3, **0 endpoints inferred** of 19 operations: 4 GETs marked TODO ("returns an object (articles, articlesCount), not a collection"), 12 writes ignored ("mutation not supported: atrezzo only projects reads (GET)"), 2 details ignored (no projectable list), 1 nested path ignored. Scenario written empty and invalid |
| 1795376647 | +70 s | copy `build/` to a scratch dir and rewrite `https://conduit.productionready.io/api` → `/api` in the copy's bundle | the only way found to point the unmodified app at the mock (see finding F1). The app's source is untouched |
| 1795376668 | +91 s | first `atrezzo world atrezzo/scenarios/conduit.yaml` (hand-written: tags, authors, articles; `pluck`+`pick` for `{tags: […]}`, `envelope: {items: articles, total: articlesCount}`, `include: [authors]`) | exit 0 at the first try |
| 1795376674 | +97 s | `atrezzo serve --scenario conduit --static <build copy> --port 4010` | up; answers the Conduit shapes |
| 1795376688 | +111 s | first `atrezzo verify flows/home.yaml --driver playwright` | **exit 2**: playwright not installed in the project. Resolved without touching the project's `package.json` by `NODE_PATH=<atrezzo>/node_modules` (atrezzo resolves it with `createRequire`, which honours `NODE_PATH`) |
| 1795376732 | **+155 s** | `atrezzo verify flows/home.yaml --driver playwright --diagnose` | **GREEN**: 3/3 (10 article previews, 6 tags, 3 pages) on the real built app. Run time 26 s |

## Complex scenario (4 entities, 4 writes, 3 steps)

| epoch | offset | command | result |
|---|---|---|---|
| 1795376779 | +202 s | write `conduit-session.yaml` (auth user, feed with a world-resolved filter, article detail with `wrap`, comments, profile, 4 writes) | — |
| 1795376780 | +203 s | `atrezzo world` | exit 3: `writes[POST /api/articles/:slug/comments]: parameter ":slug" does not match any field of "comments"` (finding F6). Comment write made stateless |
| 1795376790 | +213 s | `atrezzo world` | exit 0. The banner shows `POST /api/articles/:slug/favorite → create articles`: a POST defaults to `create`; fixed with `action: update` (finding F10) |
| 1795376859 | +282 s | `atrezzo verify flows/session.yaml --driver playwright --diagnose` | RED 3/7: `[confirmed] page-error: TypeError: Cannot read properties of undefined (reading 'slug')`; the write's `echo` answers the bare row and the reducer reads `payload.article` (finding F5). Step 3 (profile by author) red as well |
| 1795376978 | +401 s | same, with a static wrapped `body` + `mutate` on the favorite write | RED 6/7: only the `?author=` profile step (finding F7). Moved to its own flow (`profile-by-author.yaml`, red on purpose); step 3 becomes "follow dave" |
| 1795377013 | **+436 s** | same | **GREEN 7/7**. After it, `GET /api/articles/<slug>` has `favorited: true`, `GET /api/profiles/dave` has `following: true`, and the feed grew from 16 to 21 articles (the world-resolved filter sees the follow) |
| — | — | 5 more runs of `flows/session.yaml` | 5/5 green |

## Injected causes, gaps, parity

| epoch | offset | command | result |
|---|---|---|---|
| — | — | 11 scenario variants, one injected cause each (`artifacts/tools/injected-causes.tsv`), `verify --diagnose --json` with `--driver http` and `--driver playwright` | 22 runs archived in `artifacts/verify/`; summary in `summary.md` §6 |
| — | — | `f5-favorite-echo` repeated 5 times | page-error caught 5/5 (it had been missed once in the batch run: 6/7 overall) |
| 1795377669 | +1092 s | `atrezzo misses` / `misses --json` | **0 gaps** recorded |
| — | — | `atrezzo doctor` | all OK; one useful WARN on the duplicate-slug variant (`":slug" … single value across 23 rows`) |
| — | — | serve vs real `msw/node` (`msw@2`, scratch project, `artifacts/tools/parity.mjs`) | 22 requests of the app's sequence (incl. 4 writes and the reads after them): 0 differences in status, `x-total-count`, `x-atrezzo-ignored`, `allow` or body; only the 405 error text differs, as `tests/parity-real.test.mjs` already documents. `npm install msw@2`: 68 s |

## Real bugs (upstream issues)

| epoch | offset | command | result |
|---|---|---|---|
| 1795377955 | +1378 s | flow `bugs/issue-197-feed-offset.yaml` on the correct `conduit-session` scenario | **reproduced** in 52 s: page 2 of the feed shows 10 instead of 6; `[confirmed] render` (the mock delivers 6) |
| 1795378016 | +1439 s | scenario `issue-198-profile-pages.yaml` (one author, 7 articles) + flow `bugs/issue-198-profile-pages.yaml` | **reproduced** in 60 s: 0 page links for 7 articles at 5 per page; articles 6–7 unreachable. Diagnosis only `[possible] no-data` |

## Things left in the front-end repo

`atrezzo.config.json`, `atrezzo/` (scenarios, flows, generated files, misses) and `package-lock.json` (from
`npm install`) are untracked files in `/root/work/field-conduit`; `build/` is git-ignored. No tracked file of
the app was modified (`git status` shows only untracked files).
