---
name: escena
description: Creates an atrezzo scenario from an intent ("12 rows, 3 with an issue"). Use it when the user describes a screen state they want to see or test (empty, with errors, paginated, lots of data) and it has to become a versioned world + assertions.
---

# /atrezzo:escena

Turn the intent into `world` + `endpoints` + `path` + `expect`. Format: `${CLAUDE_PLUGIN_ROOT}/references/escenario.md`.

1. Pull the numbers out of the intent and turn them into exact counts and distributions: "40 orders, 3 with an issue" ⇒ `pedidos: { total: 40, distribution: { pagado: 34, pendiente: 3, incidencia: 3 } }`. The sums must match `total`.
2. Decide what the screen sees (projection): does it paginate? filter? sort? That goes in `endpoints`, not in the data. If "12 rows" is the first page, the assertion is about `?limit=12`.
3. Set `seed` (any integer) and `now` (ISO date). Changing the seed changes the data, never the counts.
4. Write `expect` with `selector` + `count` (or `min`/`max`) and `data: { request, where }` so `verify --driver http` can check it without a browser.
5. To test client assumptions, use `nulls: { field: n }` or a separate scenario (see `${CLAUDE_PLUGIN_ROOT}/references/suposiciones.md`).
6. Save to `atrezzo/escenarios/<name>.yaml` and generate: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs world atrezzo/escenarios/<name>.yaml`. Check the printed summary (counts, endpoints) and commit the YAML + `.generated/`.

**Forbidden**: hand-writing the data JSON, editing `.generated/` or pasting ids into the YAML. If you need a different data shape, change the distribution, `values:` or `nulls:` and regenerate.
