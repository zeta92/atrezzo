---
name: gap
description: "Fills a gap in the atrezzo mock (the app requests a route the scenario does not declare) from the code that consumes it and the contract. Use it when the mock answers 404 with `atrezzo.miss: true` and the missing route in `atrezzo.gap`, `atrezzo misses` or `doctor` show unresolved gaps, \"the app requests a route that doesn't exist\", \"mock 404\", \"incomplete mock\", or an endpoint is missing from the scenario."
---

# /atrezzo:gap

CLI: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs` (`atrezzo` below). Scenario format: `${CLAUDE_PLUGIN_ROOT}/references/scenario.md` (section "Filling a gap").

`atrezzo serve` records in `atrezzo/.atrezzo/misses.json` every request that does not match the contract (deduplicated by `METHOD path`, ids collapsed to `:id`, query secrets as `***`) and answers:

```json
{ "error": "GET /api/users is not in the contract of scenario \"catalogo\"",
  "atrezzo": { "miss": true, "gap": "GET /api/users", "times": 3,
               "next": "atrezzo misses", "endpoints": ["/api/products"] } }
```

(405 with the same body if the route exists but the method is a write.) With `--on-miss stub` it answers 200 with `[]`/`{}` and `x-atrezzo-stub: true`: useful for exploring, but it **does not fill the gap** (it stays unresolved).

## The loop (short and verifiable)

1. **Pick the gap.** `atrezzo misses` → the **unresolved** one with the most `times`. Each line's suggestion tells you whether the contract already has it (`→ atrezzo import <spec>`: do it and jump to step 5), whether a scenario already declares it (only `world` + reload are missing) or whether it is a mutation. `atrezzo misses --json` gives `query`, `referer` (which screen requested it) and `accept`.

2. **Find the consumer.** In the front end (`workspace.front` in the config, if present), find the call:
   ```bash
   grep -rnE "fetch\(|axios|useQuery|useSWR|\\\$fetch|ky\.|apiClient|/api/users" src/ --include='*.{ts,tsx,js,jsx,vue,svelte}'
   ```
   Also search for the resource name without a prefix (`users`, `"/users"`) and the project's own HTTP client (`api.get(`, `http.get(`, `client.users.list(`). Note:
   - **method** and **route** (with or without `:id`);
   - **the query it sends**: only those parameters become `filters`/`pagination`;
   - **which fields it reads** from the response (`u.name`, `data.items`, `res.total`, destructuring, table columns, the component's TS types). **Those fields define the schema; do not invent any.**
   - if it reads `res.data` / `res.items` → there is an **envelope** (`shape: envelope` + `pick`).

3. **Contract first.** If there is an OpenAPI spec or backend types (`workspace.contract`, `src/types/database.ts`, DTOs), they are the source of truth for the shape (names, types, enums). The front-end code only adds what the contract does not say (which filters it really uses, how many rows the screen expects). If contract and front end disagree, say so: it is a real bug, not something the mock should paper over.

4. **Patch the scenario** (`atrezzo/scenarios/<scenario>.yaml`, the one the 404 names). Never write the data JSON: the world generates it.
   ```yaml
   world:
     customers: 3                      # already there
     users:                            # new entity (or reuse an existing one)
       total: 8
       ref: customers                  # only if the front end reads u.customer.*  → customer_id + include
       fields:                         # ONLY the fields the front end reads (with fields, the entity
         name: string                  #   template is replaced entirely; without fields, users
         email: email                  #   brings name, email, role, created_at)
         role: [admin, operator]       # list = enum (values the front end tells apart)
         avatar_url: url
   endpoints:
     - path: /api/users                # exactly the gap's route
       entity: users
       filters: [role]                 # only the parameters the front end SENDS
       pagination: { param_limit: limit, param_offset: offset }   # only if it sends them
       include: [customers]            # embeds "customer" (requires the ref)
       shape: envelope                 # if it reads res.items / res.data…
       pick: items                     #   …with that key → { items, total, limit, offset }
   ```
   `fields` types: string, integer, number, boolean, date, email, uuid, url, or a list (enum).
   The detail route (`/api/users/:id`) is included by default (`detail: true`). Nested route (`/api/customers/:id/orders`): not projected; use the collection with a filter (`/api/orders?customer_id=`) if the front end can, or note it as a limitation.

5. **Generate and reload.** `atrezzo world atrezzo/scenarios/<scenario>.yaml` (check the summary: the entity and `GET /api/users` under "Endpoints covered") and `curl -s -X POST <mock>/__atrezzo/reload` (rereads the YAML without restarting `serve`; returns the same summary as `reset`, with `generated: "up to date"`). If serve is not running, restart it.

6. **Check that the gap is gone.** `atrezzo verify <flow.yaml>` (if the flow covers that screen) or reload the screen. Then `atrezzo misses`: the line must say **resolved** (it is marked automatically when the mock serves the route). If it still says "unresolved", the app requests something else (different prefix, trailing slash, another method): compare `example` in `misses --json` with the scenario `path`.

7. **Mutations (POST/PUT/PATCH/DELETE).** Say it explicitly: atrezzo only projects reads. Options: `atrezzo serve --on-miss stub` (200 `{}` so the screen does not crash; nothing is persisted) or leave it unresolved and note it. Do not invent business logic in the mock.

## Report

Gap picked (`METHOD path`, times) · consumer (`file:line`) · fields read and where each comes from (contract or front end) · scenario diff · `world` output · `misses` before and after. If you could not resolve it, the real reason.
