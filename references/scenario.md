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
    shape: array                      # array (default) | envelope → { data, total, limit, offset }
    detail: true                      # also generates /api/orders/:id (default true)
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
`path` (starts with `/`, no query or `:param`), `entity` (required, declared in `world`), `filters` (existing fields), `pagination`, `sort`, `include` (referenced entities only), `shape`, `detail`, `pick`.

- Offset `pagination`: `{ param_limit, param_offset, default_limit, max_limit }`. By page: `{ param_page: page, param_limit: per_page, default_limit: 10 }` (`default_limit` required; `offset = (page - 1) × limit`; `page=0` ⇒ 400; cannot be combined with `param_offset`).
- `pick: items` ⇒ an envelope with that key: `{ items: [...], total, limit, offset }` (implies `shape: envelope`; `shape: envelope` without `pick` uses `data`). A single key, no nested paths.

Projection semantics (identical in `serve` and the MSW handlers, same `runtime.mjs` file):
1. Equality filters; a comma means any of the values; `null` matches nulls.
2. Sorted by `sort`, nulls last, ties broken by original position (stable).
3. `X-Total-Count` = total after filters, before pagination.
4. `limit` above the total ⇒ everything; out-of-range `offset` ⇒ `[]`; non-integer values ⇒ 400.
5. Undeclared parameters are ignored and listed in `X-Atrezzo-Ignored`.
6. GET/HEAD only. Writes ⇒ 405: the mock shapes data, it does not implement business rules.

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
  X-Tenant: "${TENANT}"               # any value can come from the shell you run verify in
steps:
  - screen: order-list
    visit: /orders                    # route for playwright
    headers: { Accept-Language: en-GB }  # optional; merged with the flow headers
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
- `${NAME}` in a value is replaced by the variable you set in the shell that runs the command. If it is not set, the flow is invalid (exit 3) rather than sending an empty header.
- Secrets: `Cookie`, `Authorization`, `Proxy-Authorization`, `X-Api-Key` and any name containing `token`, `secret`, `session`, `auth`, `password` or `api-key` print as `***` in the table, in `--json` and in error messages. Values are never written to logs.
- Values: single-line text (numbers and booleans are converted to text). Names per RFC 7230.

### Real app (no `scenario`)

If the flow declares no `scenario`, `verify` does not `reset` or compare hashes: it verifies the app as it is at `base_url` (useful to validate selectors against the real app, with its session in `headers`). `data` assertions still work if the app exposes the JSON.

### Navigation with playwright: never green by accident

After opening `visit`, if the final URL is another route (e.g. a redirect to `/login` for lack of a session), the response is HTTP ≥ 400, or `wait_for` does not appear within 10 s, **every assertion of the step is KO** even if the count matches (a `count: 0` on the login screen is not an OK). The report says where it redirected and, with `--diagnose`, adds the `navigation` hypothesis.

## Supported YAML subset

Block maps and lists (spaces only), single-line `{…}` and `[…]` collections, single and double quotes, `null`/`~`, booleans, numbers, `|` and `>` blocks, comments. Anchors, aliases, tags and multiple documents are rejected: the parser says so with a line number.

## Exit codes
`0` OK · `1` assertion failed · `2` not verifiable (no mock, playwright/Chromium or `data`) · `3` invalid input.
