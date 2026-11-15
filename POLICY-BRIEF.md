# Problem: one policy hold that the current design cannot satisfy as it stands

You are working in a copy of `atrezzo`, a Claude Code plugin (pure ESM, no dependencies, no MCP
server) that serves API mocks from a seeded application state and verifies a rendered screen against
a YAML scenario. Read `README.md` and `references/scenario.md` first, then `scripts/lib/headers.mjs`,
`scripts/lib/env.mjs`, `scripts/cli.mjs` and the seven `skills/*/SKILL.md`.

Anthropic's plugin directory validator put a **policy hold** on the submission. This is its text,
verbatim:

> **Uses a credential from the user's machine**
>
> Across its surfaces this plugin reads the installer's YOUR_API_KEY and can send data off the machine
> (skill capture body: node code). Read together that is a credential leaving the machine in two steps;
> held for review beside the per-surface findings.
>
> **If the credential is sent nowhere, or only to its own vendor's host, you can leave it as it is and
> a reviewer confirms it. Otherwise ask the user for it: declare a userConfig option (sensitive: true)
> and put “${user_config.KEY}” in a remote MCP server's headers or, for Verified organizations only, in
> a local MCP server's env. Removing every part that reads a credential clears this hold.**

The plugin has no MCP server. What it does have is a real feature: a flow (`flow.yaml`) can declare
`headers:` such as `Cookie: "${SESSION}"`, and `verify` expands `${VAR}` from the environment so a
reviewer can check a screen that needs a session. `scripts/lib/env.mjs` is the only module that reads
`process.env`, and `headers.mjs` masks secret-looking values as `***` everywhere they are printed.

Two findings are already fixed in this copy: there is no `YOUR_API_KEY` example anywhere, and the
`capture` skill states that a response body stays on the machine and secret-looking fields are masked.

## Your task

Find the most elegant way to keep authenticated-screen verification while making the plugin read **no
credential from the user's machine**, and implement it. "Elegant" here means: the fewest moving parts,
no secrets written to disk, no secrets in shell history if that can be avoided, nothing that pretends
to be an MCP server, and no feature the user cannot discover from `--help`.

Investigate before deciding — do not assume:

- Whether a Claude Code plugin can declare `userConfig` entries with `sensitive: true` and whether a
  **skill or a CLI it runs** can read them (`${user_config.KEY}`). Check the plugin schema and the
  docs (`claude.com/docs/plugins/*`, `code.claude.com/docs/en/plugins/*`), and the installed CLI
  (`claude plugin configure --help`, the plugin schema). If it is only for MCP servers, say so with the
  quote that proves it — that rules the option out and is a legitimate finding.
- What the validator actually flags (a `process.env` read? a `fetch` next to an exec? a header name?).
  The prior findings in this repo were cleared by removing the pattern, so aim for "every part that
  reads a credential" being gone, not merely renamed.
- Whether the flow can carry the value without the plugin reading anything: literal headers in the YAML,
  a CLI flag, stdin, a file the user passes explicitly, or the shell expanding the variable before the
  process starts. Weigh each: convenience, leakage (history, `ps`, disk), and what a reviewer will see.

Then implement the option you chose, in this working copy:

- Keep `--driver http` and `--driver playwright` working, keep per-step headers, keep `***` masking.
- Update the CLI help, `references/scenario.md`, the example (`examples/tienda`) and any skill that
  tells the model how to write headers, so the documented way is the one that passes.
- Add tests for the new path (a header supplied the new way, combined with a header declared in the
  flow, and a secret-looking one still printed as `***`).
- `node --test tests/*.test.mjs` → 113 or more passing, 0 failing. `claude plugin validate .` passes.
  The example must still end `4 OK · 0 KO · 0 not verified → GREEN`.
- Bump the version to 0.5.0 in `.claude-plugin/plugin.json` if the CLI surface changes.
- Commit. **Do not push.**

## What to report

1. The design you chose, in five lines, and the two you rejected with the reason (one line each).
2. The evidence that `userConfig` is or is not usable by a plugin like this, quoted.
3. What the user types now, before and after, for the session-cookie case.
4. What is still leaked, if anything (history, `ps`, disk), stated plainly rather than glossed.
5. The verification output: tests, validate, example.
