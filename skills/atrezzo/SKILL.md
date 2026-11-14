---
name: atrezzo
description: API mocks from app states (world + scenario). Use it when the user asks for mocks, fixtures, test data or to "simulate the API" for a screen or flow, wants to reproduce a specific state ("12 rows, 3 with an issue"), or wants to check that a screen renders what it should. Decides which atrezzo skill applies.
---

# atrezzo — router

atrezzo generates API mocks from **application states**, not isolated endpoints. A **world** (a seeded entity graph) is **projected** onto each endpoint; a versioned **scenario** pins world + screen path + assertions; the output is committable code.

CLI: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs <command>` (`atrezzo` below).

## Pick the skill

| The user says… | Use |
|---|---|
| "set up atrezzo", "configure mocks in this repo", there is no `atrezzo.config.json` | `/atrezzo:init` |
| "get the contract", "I have an OpenAPI/HAR", "what does the API return" | `/atrezzo:captura` |
| "I want 12 orders, 3 with an issue", "an empty state", "data for this screen" | `/atrezzo:escena` |
| "check the screen", "the rows don't show up", "does it match?" | `/atrezzo:verifica` |
| "I'm on X and want to get to Y", "which states do I need for this flow" | `/atrezzo:desde-intencion` |
| "the app requests a route that doesn't exist", "mock 404", "incomplete mock", a response with `atrezzo.miss`, `doctor`/`atrezzo misses` with unresolved gaps | `/atrezzo:hueco` |

With no config, always start with `/atrezzo:init`. With no contract, run `/atrezzo:captura` before `/atrezzo:escena`.

## The loop

1. **World** — entities, counts, distributions and seed (`world:` in the scenario).
2. **Scenario** — endpoints as projections + a `path` of screens + `expect`. See `${CLAUDE_PLUGIN_ROOT}/references/escenario.md`.
3. **Generate** — `atrezzo world <scenario.yaml>` writes JSON + `runtime.mjs` and the configured runtime's output (MSW handlers, Supabase seed.sql, OpenAPI for Prism or WireMock mappings); `atrezzo runtimes` says which and why.
4. **Serve** — `atrezzo serve --scenario <name>` (real HTTP; `POST /__atrezzo/reset` switches scenario, `POST /__atrezzo/reload` rereads the YAML). Whatever the app requests and the scenario does not declare is recorded as a gap (`atrezzo misses`) → `/atrezzo:hueco`.
5. **Verify** — `atrezzo verify <flow.yaml>`; if it fails, `--diagnose` and diagnose before touching anything.

## Hard rules

1. Determinism: same seed ⇒ same bytes. "Now" goes in the scenario's `now:`.
2. Referential integrity: ids exist in the world; never invent a `client_id`.
3. You pick distributions and narrative; **the code produces the data**. Do not hand-write data JSON.
4. The mock shapes data; it does not implement business rules (GET only; no domain calculations).

Environment check: `atrezzo doctor`.
