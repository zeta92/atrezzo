---
name: verifica
description: Verifies a screen against an atrezzo scenario and diagnoses failures. Use it when the user wants to check that a screen renders what it should, when "the rows don't show up" or "badges are missing", or before accepting a change that affects displayed data.
---

# /atrezzo:verifica

CLI: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs` (`atrezzo` below).

1. `atrezzo world <scenario.yaml>` if `doctor` says "STALE".
2. Serve in the background: `atrezzo serve --scenario <name> [--static <dir>]`. If the app runs on its own dev server, point its API at `mock.baseUrl` (or use the generated MSW handlers).
3. Verify: `atrezzo verify <flow.yaml> --driver http` (data) and, if `playwright` or `playwright-core` is available, `--driver playwright` (real DOM; `headers` in the flow for apps with a session, `${VAR}` so secrets are not committed). `verify` resets to the flow's scenario before starting.
4. Read the exit code: `0` green · `1` some assertion KO · `2` not verifiable (no mock, no playwright, assertion without `data`) · `3` invalid flow/scenario. **A 2 is never an OK**: say so.
5. On KO: `atrezzo verify <flow.yaml> --diagnose` and reason about the hypotheses **before** touching the scenario:
   - `render` / `client-side-filter`: the mock delivers what was expected; the failure is in the screen. Do not touch the scenario.
   - `pagination-mismatch`: the data exists outside the page; check the client's or the endpoint's `limit`/`offset`/`sort`.
   - `dedupe-by-id`, `null-field`: a client assumption; see `${CLAUDE_PLUGIN_ROOT}/references/suposiciones.md`.
   - `undeclared-filter`: the client filters by a parameter the contract does not have.
   - `world-mismatch`: only then fix `world` or the assertion.
6. Never regenerate with another seed "to make it pass". Report: the table, the hypothesis you chose, the evidence and the proposed change.
