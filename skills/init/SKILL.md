---
name: init
description: Sets up atrezzo in a repo (scenario-based mocks). Use it when the user wants to start with atrezzo, there is no atrezzo.config.json, they ask to detect the stack or the runtime (MSW, Supabase, Prism, WireMock, serve), or the project is a monorepo or has a separate front end and backend.
---

# /atrezzo:init

1. Inspect the repo without changing it:
   - Layout: a monorepo (`pnpm-workspace.yaml`, `workspaces` in `package.json`, `turbo.json`, `nx.json`, `lerna.json`)? `client/`+`server/`, `web/`+`api/`, `frontend/`+`backend/` folders? Or is the backend in another repo?
   - Front-end framework and data layer: fetch/axios/react-query/swr/supabase-js/apollo; where URLs are built (`grep -rn "fetch(\|axios\.\|from('" src | head -50`), the Vite proxy, `NEXT_PUBLIC_API_URL`.
   - Existing mocks: msw, WireMock (`mappings/`+`__files/`, docker-compose), Prism, json-server, `supabase/`.
   - Contracts: OpenAPI, generated types (`database.ts`), migrations.
2. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs runtimes` (read-only), then `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs init`.
   - Never use `--force` unless the user asks: `init` does not overwrite an existing config.
   - **Do not install dependencies without saying so.** If they are needed (`msw`), announce the exact command and wait for confirmation before `init --install`. `serve` and `verify --driver http` need nothing.

## Runtime detection (`--runtime auto`, the default)

`init` scores each adapter from 0 to 3 with its reasons and picks the highest; on a tie, priority wins: `msw > supabase > wiremock > builtin > prism`. It **always prints** the score table, the reason for the choice and the alternatives with signals. Read it and explain it to the user in your own words; do not summarize it as "detected X" without the why.

| runtime | signals | what `world` emits |
|---|---|---|
| `msw` | `msw` in deps, `public/mockServiceWorker.js` | `.mjs` handlers (in `<front>/src/mocks/atrezzo/` with a workspace) |
| `supabase` | `supabase/config.toml`, `@supabase/supabase-js`, `supabase/`, `*SUPABASE_URL` in `.env*` | `schema.sql`, `seed.sql`, `reset.sh`, README next to `<backend>/supabase/` |
| `wiremock` | dependency, `mappings/`+`__files/`, docker-compose/scripts | pre-generated `mappings/` + `__files/` (501 for anything not enumerated) |
| `prism` | `@stoplight/prism-cli`, `prism mock` in scripts; a spec alone scores 1 | `<scenario>.openapi.yaml` with examples |
| `builtin` | always 1 (universal fallback) | nothing else: `atrezzo serve` |

- An `openapi.yaml` without Prism installed does **not** pick Prism (it ties with builtin and builtin wins): suggest `atrezzo import` to get the scenario from the contract.
- If two runtimes have strong signals (e.g. msw in the front end and Supabase in the backend), ask whether they want both: `init --force --runtime msw,supabase`.
- If the user picks another one: `init --force --runtime <id>`. Explain what that runtime does **not** do (Prism does not filter or paginate; WireMock only serves pre-generated combinations; Supabase uses PostgREST, not the engine). Details: `${CLAUDE_PLUGIN_ROOT}/references/runtimes.md`.

## Monorepo and separate front end/backend

- `init` classifies each package as front end (UI deps, `vite.config`, name `web`/`client`…) or backend (server deps, `openapi.*`, `supabase/`, a non-JS manifest, name `api`/`server`…) and writes `workspace: { front, backend, contract }`.
- **On exit 2** ("Not choosing for you"), show the table to the user and ask which one is the front end; then `init --front <path> --backend <path> [--contract <spec>]`. Never choose silently yourself.
- Two repos: run `init` in the front-end repo with paths relative to the other one: `--front . --backend ../api --contract ../api/openapi.yaml`.
- The mock `baseUrl` comes from the front end (Vite proxy or `*_API_URL`); check it in the output (`mock baseUrl: …`).

3. If MSW or another mock already exists, explain how they coexist: atrezzo's handlers are added as one more (`index.mjs` in `handlersDir`); do not replace the existing ones.
4. Finish with a summary: layout (workspace), runtime chosen and why, alternatives, baseUrl, files written and the next step (`atrezzo import <spec>` if there is a contract → `/atrezzo:captura`; otherwise `/atrezzo:escena`).
