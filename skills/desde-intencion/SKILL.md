---
name: desde-intencion
description: Plans atrezzo states to get from screen X to goal Y. Use it when the user describes a journey ("I'm on the dashboard and want to reconcile the issues") and you need to derive the screen path, one scenario per step and the coverage gaps.
---

# /atrezzo:desde-intencion

1. Restate the intent as `origin → goal` and ask only what blocks you (user role, minimum data).
2. Derive the **state path**: the list of screens with the data state each one needs to move on (e.g. `dashboard (there are issues) → lista-pedidos (issue filter) → conciliacion (order with customer)`). That is the scenario's `path`, and `entry` is its first screen.
3. For each step decide whether **one world** is enough (same scenario, different projections) or **another scenario** is needed (empty state, error, limit). Prefer one world; create extra scenarios only for mutually exclusive states.
4. Create the scenarios with `/atrezzo:escena` (format in `${CLAUDE_PLUGIN_ROOT}/references/escenario.md`) and a `flujo.yaml` with one step per screen (`screen`, `visit`, `requests`, `expect`).
5. List the **coverage gaps**: states the journey touches that no scenario covers — empty, a single item, an exact page (n = limit), nulls in fields that are read, new enum values, 4xx/5xx errors (outside the mock; note them). Use the matrix in `${CLAUDE_PLUGIN_ROOT}/references/suposiciones.md`.
6. Finish with `/atrezzo:verifica` on the flow and deliver: path, scenarios created, verify result and pending gaps.
