---
name: verify
description: "Verifies a screen against an atrezzo scenario and diagnoses failures. Use it when the user wants to check that a screen renders what it should, when \"the rows don't show up\" or \"badges are missing\", or before accepting a change that affects displayed data."
---

# /atrezzo:verify

CLI: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs` (`atrezzo` below).

1. `atrezzo world <scenario.yaml>` if `doctor` says "STALE".
2. Serve in the background: `atrezzo serve --scenario <name> [--static <dir>]`. If the app runs on its own dev server, point its API at `mock.baseUrl` (or use the generated MSW handlers).
3. Verify: `atrezzo verify <flow.yaml> --driver http` (data) and, if `playwright` or `playwright-core` is available, `--driver playwright` (real DOM). `verify` resets to the flow's scenario before starting.
   - **App with a session**: never write the cookie or token into the flow and never ask the user for its value. Flow `headers:` hold only committable values (`Accept-Language`, `X-Tenant: acme`); `${…}` in a flow is rejected. The user passes the secret at run time: `atrezzo verify <flow.yaml> --header "Cookie: $SESSION"`, or `--header @-` with `Name: value` lines on stdin. Give the user that command to run themselves (in their terminal, or with `!` in the prompt so the masked report lands in the conversation); do not run it yourself with a value from the environment. Secret-looking headers print as `***`. If the app keeps its session in `localStorage` (Supabase: `sb-<ref>-auth-token`), headers are not enough: add a flow `storage: { local: { … } }` block holding a fake session made up for the mock, never a real token (the mock checks none; `${…}` is rejected), and use `--driver playwright`.
4. Read the exit code: `0` green · `1` some assertion KO · `2` not verifiable (no mock, no playwright, assertion without `data`) · `3` invalid flow/scenario. **A 2 is never an OK**: say so.
5. On KO: `atrezzo verify <flow.yaml> --diagnose` and reason about the hypotheses **before** touching the scenario:
   - `render` / `client-side-filter`: the mock delivers what was expected; the failure is in the screen. Do not touch the scenario.
   - `pagination-mismatch`: the data exists outside the page; check the client's or the endpoint's `limit`/`offset`/`sort`.
   - `dedupe-by-id`, `null-field`: a client assumption; see `${CLAUDE_PLUGIN_ROOT}/references/assumptions.md`.
   - `undeclared-filter`: the client filters by a parameter the contract does not have.
   - `world-mismatch`: only then fix `world` or the assertion.
6. Never regenerate with another seed "to make it pass". Report: the table, the hypothesis you chose, the evidence and the proposed change.
