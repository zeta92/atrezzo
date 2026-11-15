# Scenario file specification

A scenario is a versioned YAML file that describes **one application state**: the data world, how the endpoints see it, the screen path and what must be visible. `atrezzo world` validates it strictly: every error names the **field** and the **reason** and exits with code 3.

## Full example

```yaml
name: reconciliation-with-issues      # required, kebab-case; the scenario name
description: Free text for humans     # optional
seed: 7712                            # required, integer >= 0
now: 2025-03-01T09:00:00Z             # optional; injected "now" (default 2025-01-15T09:00:00Z)
world:
  customers: 3                        # short form: just the total
  orders:
    total: 40
    distribution: { paid: 34, pending: 3, issue: 3 }   # sum == total
    amount: { min: 20, max: 900, currency: EUR }
    ref: customers                    # optional: orders already references customers by default
    nulls: { customer_id: 0 }         # optional: n records with the field set to null
    days: 90                          # optional: date window going back from now
  users:
    total: 4
    values: { role: [admin, operator, viewer] }   # optional: vocabulary for a field
endpoints:
  - path: /api/orders
    entity: orders
    filters: [status, customer_id]    # ?status=issue  ·  ?status=pending,issue
    pagination: { param_limit: limit, param_offset: offset, default_limit: 50, max_limit: 100 }
    sort: -created_at                 # or a list: [status, -amount]; default id
    include: [customers]              # embeds the parent as "customer"
    shape: array                      # array (default) | envelope → { data, total, limit, offset } | object → first row
    detail: true                      # also generates /api/orders/:id (default true)
    latency: 150                      # optional: ms this endpoint waits under `serve` (wins over --latency)
  - path: /api/customers
    entity: customers
entry: empty-dashboard
path: [empty-dashboard, order-list, reconciliation]
expect:
  - selector: "[data-testid=order-row]"
    count: 12
    data: { request: orders }
  - selector: "[data-testid=issue-badge]"
    min: 1
    max: 3
    screen: order-list                # default: the last screen of path
    data: { request: issues, where: { status: issue } }
```

## Fields

### Root
| field | type | rule |
|---|---|---|
| `name` | string | required, `^[a-z0-9][a-z0-9-]*$` |
| `seed` | integer | required, >= 0 |
| `now` | ISO date | optional; every date is computed from here |
| `world` | map | required, at least one entity |
| `endpoints` | list | required, at least one |
| `entry` | string | optional; with `path`, it must be its first element |
| `path` | list of strings | optional; screens in order |
| `expect` | list | optional |

Any other field is an error (`unknown field`). A scenario can also be `.json` with the same structure (`atrezzo import --format json`).

### Entities (`world.<name>`)
An integer (= `total`) or a map with: `total` (required), `distribution`, `distribution_field` (default `status`), `amount`, `ref`, `nulls`, `values`, `days`, `fields`.

#### `fields`: typed fields (written by `atrezzo import`)

```yaml
world:
  pets:
    total: 30
    distribution: { available: 10, pending: 10, sold: 10 }
    distribution_field: status
    fields:
      name: string
      status: [available, pending, sold]   # list = enum
      createdAt: date
```

Types: `string`, `integer`, `number`, `boolean`, `date` (ISO, within `days` before `now`), `email`, `uuid`, `url`, or a list of values. With `fields`, the entity has **exactly** `id` + the fks of its `ref` + `fields` (+ the `distribution` field and the `amount` fields if you declare them): the template (`customers`, `orders`…) adds neither its own fields nor its defaults. `id` cannot be declared (always integers 1..n). Values come from a dedicated PRNG stream (`fields:<entity>`): adding `fields` to one entity does not change the others.

Built-in templates and their fields:

| entity | fields |
|---|---|
| `customers` | id, name, email, city, created_at |
| `users` | id, name, email, role (`admin` for id 1, else `operator`), created_at |
| `orders` | id, reference (`ORD-00001`…), customer_id, status (default `paid`), amount (10–500), currency (`EUR`), created_at |
| `products` | id, name, sku, price (1–120), currency (`EUR`), stock |
| any other | id, name, `<fk of its refs>`, created_at |

Template names are matched exactly; there are no aliases. A foreign key is the singular of the referenced entity + `_id` (`customers` → `customer_id`, `categories` → `category_id`, `boxes` → `box_id`). The pre-0.4 Spanish template names are rejected with the English name to use instead (e.g. `field "world.<old name>": … use "customers"`).

Generator guarantees:
- integer ids 1..n.
- `distribution` is exact (not approximate) and shuffled with the seed.
- Every fk exists; if there are at least as many children as parents, every parent has a child.
- A child never predates its parent (the template's `created_at`; a `created_at` declared in `fields` is a plain typed date).
- Each entity uses its own PRNG stream: adding an entity does not change the others.

### Endpoints
`path` (starts with `/`, no query or `:param`), `entity` (required, declared in `world`), `filters` (existing fields), `pagination`, `sort`, `include` (referenced entities only), `shape` (`array` default, `envelope`, `object`), `detail`, `pick`, `latency`.

- Offset `pagination`: `{ param_limit, param_offset, default_limit, max_limit }`. By page: `{ param_page: page, param_limit: per_page, default_limit: 10 }` (`default_limit` required; `offset = (page - 1) × limit`; `page=0` ⇒ 400; cannot be combined with `param_offset`).
- `pick: items` ⇒ an envelope with that key: `{ items: [...], total, limit, offset }` (implies `shape: envelope`; `shape: envelope` without `pick` uses `data`). A single key, no nested paths.

#### Singletons (`shape: object`)

Most SPAs boot by reading objects, not lists: their config (`GET /api/v2/info`) and the current user (`GET /api/v2/user`). With `shape: object` the endpoint answers **one row of its entity as a JSON object**, not wrapped in a list:

```yaml
world:
  info:
    total: 1
    fields: { version: string, frontend_url: url }
  users: 4
endpoints:
  - path: /api/v2/info
    entity: info
    shape: object                 # → 200 { "id": 1, "version": "…", "frontend_url": "…" }
  - path: /api/v2/user
    entity: users
    shape: object
    filters: [id]                 # the flow picks the logged-in user with ?id=2
```

- The answer is the **first row after the endpoint's filters and `sort`** (default `sort: id`). When the filters match several rows (`?id=1,2`, or no filter on a 4-row entity) you get the first of them, never a list; use `sort` to choose which one comes first.
- The entity has **no rows** ⇒ `404` with the same body as a gap (`atrezzo.miss: true`, `atrezzo.gap: "GET /api/v2/user"`), and `serve` records it in `atrezzo misses` as **unresolved**: an empty singleton is more likely a missing entity than a client error. Fix it by giving the entity `total: 1` or more. With `--on-miss stub` it answers `200 {}` like any other gap.
- The entity has rows but **no row matches** the filters (`?id=99`) ⇒ a plain `404 { "error": "no users matches id=99 …" }`, like the detail route; that is not a gap.
- No `X-Total-Count`; undeclared parameters still show up in `X-Atrezzo-Ignored`. `include` and `child(count)` embeds work as on a list row.
- The detail route keeps today's behaviour: `GET /api/v2/user/3` answers row 3 (or 404), whatever the shape. `pagination` and `pick` are rejected with `shape: object`.
- No authentication semantics: the mock does not read `Authorization`. The current user is whichever row the filters and `sort` pick.

#### Latency (`latency:` and `serve --latency`)

A mock that answers in 1 ms can expose races a real backend (100-300 ms) hides, or hide timing bugs the real one shows. `atrezzo serve --latency <ms>` (default `0`) delays every contract response; an endpoint's `latency:` wins over the flag for that endpoint (list and detail route):

```yaml
endpoints:
  - path: /api/v2/info
    entity: info
    shape: object
    latency: 800                  # the app's boot request arrives late, as against the real API
  - path: /api/v2/projects
    entity: projects              # waits whatever `serve --latency` says (0 by default)
```

- Integer milliseconds, `0`–`60000`. Applies to answers of contract endpoints (including their 400/404s); static files (`--static`), `/__atrezzo/*` control routes and gaps for undeclared routes answer immediately, so a slow mock does not make the harness crawl.
- The serve banner prints the effective latency and each override; `GET /__atrezzo/state` returns it as `latency: { default, endpoints: { path: ms } }`.
- Only `serve` waits: the MSW handlers ignore `latency` (wrap them with MSW's own `delay()` if you need it there). The data never changes with the latency.

Projection semantics (identical in `serve` and the MSW handlers, same `runtime.mjs` file):
1. Equality filters; a comma means any of the values; `null` matches nulls.
2. Sorted by `sort`, nulls last, ties broken by original position (stable).
3. `X-Total-Count` = total after filters, before pagination.
4. `limit` above the total ⇒ everything; out-of-range `offset` ⇒ `[]`; non-integer values ⇒ 400.
5. Undeclared parameters are ignored and listed in `X-Atrezzo-Ignored`.
6. GET/HEAD only. Writes ⇒ 405: the mock shapes data, it does not implement business rules.

### Counted relations (PostgREST `select` and `head=true`)

A relation is declared once, with `ref:` on the child (`documentos: { total: 6, ref: expedientes }` ⇒ every document carries `expediente_id`). Two PostgREST shapes read it:

- **Embedded count**: `GET /rest/v1/expedientes?select=*,documentos(count)` adds `"documentos": [{ "count": n }]` to every returned row (list and detail), where `n` is the number of `documentos` rows in the same world whose `expediente_id` is that row's `id`. Several at once (`select=*,documentos(count),plazos(count)`) and aliased (`select=*,total:documentos(count)` ⇒ `"total": [{ "count": n }]`) work too. The count always matches `GET /rest/v1/documentos?expediente_id=<id>` on an endpoint that declares that filter.
- **Count only**: `?head=true` (with or without `Prefer: count=exact`), or a `HEAD` request with `Prefer: count=exact`, answers `200` with an empty body and `Content-Range: 0-<n-1>/<n>`, where `n` counts the rows that pass the endpoint's filters (pagination does not apply). No rows ⇒ `Content-Range: 0-0/0`.

Not supported: only the exact `child(count)` item is a count; any other embed (`documentos(id,nombre)`, `documentos(*)`, `customer:customers(*)`) and column lists (`select=id,name`) are ignored, rows keep their shape and `select` shows up in `X-Atrezzo-Ignored`. A name that is no entity, or an entity that does not `ref:` this endpoint's entity, adds nothing. Filters keep the engine's equality syntax (`?expediente_id=2`); PostgREST operators such as `eq.2` are not parsed. The MSW handlers register `GET` routes only, so there a count goes through `head=true`, not a `HEAD` request.

### Static files and the SPA fallback (`serve --static <dir>`)

`serve --static dist` serves the built front end next to the projections. A single-page app routes on the client, so a deep link such as `/copilot` has no file in `dist/`: for those, `serve` answers `200` with `dist/index.html` and the app's router takes over. The fallback applies only when **all** of these hold:

- `--static` was given (or `mock.static` in the config) and the directory has an `index.html`;
- the method is `GET` (or `HEAD`); `POST`, `PUT`, `PATCH` and `DELETE` never fall back;
- the path is not a contract endpoint and matches no file in the directory;
- the request asks for a page: `Accept` contains `text/html` (a browser navigation), or there is no `Accept` at all and the path has no file extension;
- the path is not under the contract's API prefix (with `/api/orders` declared, `/api/…` is always an API call) and does not end in an asset extension (`.js`, `.css`, `.png`, `.html`…).

Everything else keeps the 404: a `fetch` (it sends `Accept: */*`) or a JSON `Accept` for an undeclared route, an unknown API path and a missing asset are still answered with the 404 body, and the undeclared routes are recorded as gaps for `atrezzo misses`. A navigation that got `index.html` is not a gap.

### Filling a gap (an endpoint the app requests and the scenario lacks)

`atrezzo serve` records every request outside the contract (`atrezzo misses`; details in the README, "When a route is missing"). To fill it you add **an entity and an endpoint**, never data (skill `/atrezzo:gap`):

```yaml
# 404 received: { "atrezzo": { "gap": "GET /api/users", ... } }
# the front end does: fetch(`/api/users?role=${role}&limit=20&offset=${o}`) and reads
#   res.items[i].name · .email · .role · .avatar_url · .customer.name · res.total
world:
  customers: 3
  users:
    total: 8
    ref: customers                # → customer_id; enables include
    fields:                       # only what the front end reads (replaces the entity template)
      name: string
      email: email
      role: [admin, operator]
      avatar_url: url
endpoints:
  - path: /api/users              # exactly the gap's `path` (no different prefix, no trailing slash)
    entity: users
    filters: [role]               # only what the front end sends
    pagination: { param_limit: limit, param_offset: offset }
    include: [customers]          # u.customer.name
    shape: envelope
    pick: items                   # res.items + total/limit/offset
```

Rules:
- `path` is the gap's route as is (the `path` in `misses --json`); if the gap was `GET /api/users/:id`, the collection endpoint is enough (the detail comes with `detail: true`, the default).
- `filters` and `pagination`: only the parameters in the gap's `query` or in the front end's call. Anything else is ignored and shows up in `X-Atrezzo-Ignored`.
- Fields: if there is a contract (OpenAPI/types), it rules; `atrezzo import` writes them for you. Without a contract, the ones the front end reads. Without `fields`, the built-in entities (`users`, `customers`, `orders`, `products`) bring their template.
- Then: `atrezzo world <scenario.yaml>` and `POST /__atrezzo/reload` (or restart `serve`). The gap turns `resolved: true` as soon as the mock serves the route.
- Nested routes (`/api/customers/:id/orders`) cannot be declared (`path` without `:param`): use the collection with a filter (`/api/orders?customer_id=`) if the front end allows it.
- Writes (POST/PUT/PATCH/DELETE): not declared. `serve --on-miss stub` answers 200 `{}` for exploring.

### Assertions (`expect`)
| field | rule |
|---|---|
| `selector` | required, CSS |
| `count` | exact integer; mutually exclusive with `min`/`max` |
| `min`, `max` | integers; `min <= max` |
| `screen` | a screen from `path` |
| `data.request` | name of a request in the flow step |
| `data.where` | map field: value (or list) to count in the JSON |
| `data.pick` | path to the array (`data.items`); default: root array or `data` |
| `label` | text for the report |

With `--driver http` an assertion without `data` stays **not verified** (exit 2), never OK.

## Flow file (`flow.yaml`)

```yaml
scenario: scenarios/orders.yaml      # relative to the flow (optional: see "Real app" below)
base_url: http://127.0.0.1:4010       # optional (otherwise --url or the config)
viewport: { width: 1440, height: 1000 }  # optional, playwright only (default 1280x720)
headers:                              # optional: sent on EVERY request of the flow
  X-Tenant: acme                      # only values safe to commit; a session goes in verify --header
storage:                              # optional, playwright only: seeded before the page loads
  local:   { "sb-127-auth-token": "{\"access_token\":\"…\"}" }
  session: { some-key: value }
steps:
  - screen: order-list
    visit: /orders                    # route for playwright
    headers: { Accept-Language: en-GB }  # optional; merged with the flow headers
    storage: { local: { theme: dark } }  # optional; merged with the flow storage, the step wins
    wait_for: "[data-testid=ready]"   # optional; waits for the element to exist (not to be visible)
    requests:                         # equivalent requests for the http driver
      orders: GET /api/orders?limit=12
      issues: GET /api/orders?status=issue
    expect: [ … ]                     # the step's own assertions
```

Scenario assertions are added to the step of their `screen` (default: the last one in `path`).

### Headers (`headers`)

- At flow level and/or step level. A step's effective headers = the flow's + the step's; if a name repeats (case-insensitive), the step wins.
- `playwright` driver: `context.setExtraHTTPHeaders()` with the effective headers before opening each `visit` (every request of the page gets them: document, fetch, RSC…). `http` driver: the same headers on every `fetch` of `requests`.
- Values are literal: atrezzo reads no environment variable, and a value containing `${…}` makes the flow invalid (exit 3) rather than sending it as is.
- **Secrets (session cookie, bearer token) never go in the flow.** Pass them at run time: `atrezzo verify flow.yaml --header "Cookie: $SESSION"`. Your shell expands `$SESSION` before atrezzo starts. `--header` is repeatable and applies to every request of every step. Effective headers = flow + `--header` + the step's own, so a step that names a header keeps control of it; when a name repeats (case-insensitive), the later layer wins.
- `--header @-` reads `Name: value` lines from stdin instead, so the value is in neither the process arguments (`ps`) nor the shell history: `printf 'Cookie: %s\n' "$SESSION" | atrezzo verify flow.yaml --header @-`.
- Secrets: `Cookie`, `Authorization`, `Proxy-Authorization`, `X-Api-Key` and any name containing `token`, `secret`, `session`, `auth`, `password` or `api-key` print as `***` in the table, in `--json` and in error messages. Values are never written to logs.
- Values: single-line text (numbers and booleans are converted to text). Names per RFC 7230.

### Browser storage (`storage`)

Headers do not put anything in `localStorage`. An app that keeps its session there (Supabase: `sb-<project-ref>-auth-token`) redirects every private screen to its login without it, and the step is KO. `storage:` seeds it.

- Two optional maps, `local` (`localStorage`) and `session` (`sessionStorage`), of `key: "value"`. Keys and values are literal strings (numbers and booleans become text); write a JSON value as a quoted string.
- At flow level and/or step level, merged like headers: a step's effective storage = the flow's + the step's, per area; if a key repeats, the step wins. Keys are case-sensitive.
- `playwright` driver: before the first `visit` of each step, an init script is added to the browser context (`context.addInitScript`). It runs before the app's own scripts in every document of the step's origin, so the page already sees the values on first load, after a full reload and on later navigations; a value the app writes to a seeded key is replaced at the next document load. Other origins (third-party iframes) are not touched. A key an earlier step seeded and the current step does not declare is removed.
- `http` driver: `storage:` is ignored (there is no browser to seed) and the report says so once with a `WARNING:` line.
- Values are literal: atrezzo reads no environment variable, and a key or value containing `${…}` makes the flow invalid (exit 3) before anything is requested. Against the mock any well-formed session is enough: the mock does not check tokens, so the flow can hold a fake one.
- The report lists the seeded keys (`Storage (keys): local: sb-127-auth-token`), never the values.

### Real app (no `scenario`)

If the flow declares no `scenario`, `verify` does not `reset` or compare hashes: it verifies the app as it is at `base_url` (useful to validate selectors against the real app, with its session passed as `--header "Cookie: …"`). `data` assertions still work if the app exposes the JSON.

### Navigation with playwright: never green by accident

After opening `visit`, if the final URL is another route (e.g. a redirect to `/login` for lack of a session), the response is HTTP ≥ 400, or `wait_for` does not appear within 10 s, **every assertion of the step is KO** even if the count matches (a `count: 0` on the login screen is not an OK). The report says where it redirected and, with `--diagnose`, adds the `navigation` hypothesis.

## Supported YAML subset

Block maps and lists (spaces only), single-line `{…}` and `[…]` collections, single and double quotes, `null`/`~`, booleans, numbers, `|` and `>` blocks, comments. Anchors, aliases, tags and multiple documents are rejected: the parser says so with a line number.

## Exit codes
`0` OK · `1` assertion failed · `2` not verifiable (no mock, playwright/Chromium or `data`) · `3` invalid input.
