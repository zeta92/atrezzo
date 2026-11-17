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
An integer (= `total`) or a map with: `total` (required), `distribution`, `distribution_field` (default `status`), `amount`, `ref`, `nulls`, `values`, `days`, `fields`, `derive`, `seed_first`, `values_order`.

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

#### `derive`: a foreign key copied through another one

When an entity references two entities that are themselves related (`ref: [widgets, gadgets]`, and each gadget belongs to a widget), the two keys are drawn separately by default, so a piece can end up with `widget_id: 1` and a `gadget_id` of a gadget that belongs to widget 3. `/api/widgets/1/gadgets/<that id>/pieces` is then rightly empty. `derive` ties them together:

```yaml
world:
  widgets: 4
  gadgets: { total: 9, ref: widgets }
  pieces:
    total: 60
    ref: [widgets, gadgets]
    derive:
      widget_id: { from: gadgets, field: widget_id }   # a piece belongs to the widget of its gadget
```

- `derive.<fk>` is resolved **after** the references are drawn: the row `from` points at (through this row's own fk to `from`) is read and its `field` copied. The derived fk is no longer drawn; the other fields and the other entities keep exactly the values they had without `derive`. Same seed, same rows.
- `field` defaults to the fk's own name (a reference to the same entity has the same name everywhere); `widget_id: gadgets` is the short form of `{ from: gadgets }`.
- Validation (each a clear scenario error): the key must be a foreign key of the entity (one of its `ref:`s); `from` must be another entity of its `ref:`; `field` must exist in `from` **and be its reference to the same entity** (`gadgets` needs `ref: widgets`), so the copy is always an id that exists; `from` cannot reference this entity back (its rows must be built first); the fk to `from` cannot itself be derived (one hop).
- `nulls:` still applies afterwards, and a null in `from`'s field is copied as null.

#### `seed_first`: every row in its first declared state

Enums and booleans are drawn per row, so a screen can come up with its row disabled, retired or in a secondary mode. `seed_first` fixes them without rewriting the enum as a one-value list:

```yaml
world:
  widgets:
    total: 4
    fields: { name: string, finish: [matte, gloss, satin], is_retired: boolean }
    seed_first: true              # every widget: finish matte, is_retired false
  gadgets:
    total: 9
    ref: widgets
    fields: { label: string, mode: [list, grid], visible: boolean }
    seed_first: [mode]            # only mode is fixed (list); visible is still drawn
```

- `true` seeds every field that has a value list: an enum in `fields` (its **first** value), a `boolean` (`false`), or a field with `values:` (its first value). A list seeds only those fields. `false` or no key: everything is drawn as before.
- The values are drawn first and then replaced, so the other fields of the row keep their values.
- Validation: a listed field must exist and be an enum, a boolean or have `values:`; a foreign key (use `derive`) or the `distribution` field (its counts decide) cannot be seeded; `true` on an entity with nothing to seed is an error.

#### `values_order`: lists of values in the written order

A field with a list of values (`values:`, or an enum in `fields`) is drawn at random per row. With `values_order: cycle` row *i* (0-based, ids 1..n) takes `values[i % n]`: the order you wrote, the same row on every seed. That fixes a sequence a screen shows in order, or ties generated rows to ids of an external feed:

```yaml
world:
  slots:
    total: 5
    fields: { label: [first, second, third], title: string }
    values: { external_id: ["70001", "70002", "70003", "70004", "70005"] }
    values_order: cycle           # labels: first, second, third, first, second · external_id: 70001…70005
```

- Applies to every field of the entity with a written list (`values:` or an enum in `fields`); booleans, foreign keys and the `distribution` field keep their own rules. `random` (the default) changes nothing, not even the scenario hash.
- The values are drawn first and then replaced, so the other fields keep the values they have without it. `seed_first` (applied after) and `nulls` still win on the fields they name.
- Validation: `cycle` or `random`; an entity with no field with a list of values is an error.
- With `pluck` (below), `values_order: cycle` gives an endpoint that answers a known list of ids in order: `pluck: external_id` ⇒ `["70001", …]`.

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
- Every fk exists; if there are at least as many children as parents, every parent has a child (a `derive`d fk copies its value instead, so it inherits the coverage of the fk it reads).
- A child never predates its parent (the template's `created_at`; a `created_at` declared in `fields` is a plain typed date).
- Each entity uses its own PRNG stream: adding an entity does not change the others.

### Endpoints
`path` (starts with `/`, no query; `:name` segments are path parameters), `entity` (required, declared in `world`), `filters` (existing fields; a map also binds path parameters), `pagination`, `sort`, `include` (referenced entities only), `embed` (entities that reference this one, nestable), `shape` (`array` default, `envelope`, `object`), `detail`, `pick`, `latency`, `pluck` (a field: answer its values, not rows), `error` (always answer this error).

- Offset `pagination`: `{ param_limit, param_offset, default_limit, max_limit }`. By page: `{ param_page: page, param_limit: per_page, default_limit: 10 }` (`default_limit` required; `offset = (page - 1) × limit`; `page=0` ⇒ 400; cannot be combined with `param_offset`).
- `pick: items` ⇒ an envelope with that key: `{ items: [...], total, limit, offset }` (implies `shape: envelope`; `shape: envelope` without `pick` uses `data`). A single key, no nested paths.

#### Paths with parameters (`/projects/:project_id/views/:view_id/tasks`)

A detail screen with tabs asks for the children of one row through a nested route. Any segment of `path` can be a parameter `:name`; each one is an **equality filter on a field of the entity**:

```yaml
world:
  projects: 3
  views: { total: 6, ref: projects }          # → project_id
  tasks: { total: 40, ref: [projects, views] } # → project_id, view_id
endpoints:
  - path: /api/v2/projects/:project_id/views/:view_id/tasks
    entity: tasks                  # GET /api/v2/projects/1/views/4/tasks → tasks with project_id=1 and view_id=4
  - path: /api/v2/projects/:id/views
    entity: views                  # a bare :id, the path's only parameter, names the segment before it → project_id
  - path: /api/v2/p/:pid/lists/:list/tasks
    entity: tasks
    filters: { ":pid": project_id, ":list": null, done: done }   # explicit binding; null = accept any value
```

- Binding, in this order: an explicit `filters: { ":name": field }` entry; else the field called `name`; else `<name>_id` (`:project` → `project_id`). A bare `:id` in the middle binds only to the singular of the segment before it + `_id` (`/projects/:id/views` → `project_id`), never to the row's own `id`, and only when it is the path's **single** parameter: with two or more (`/projects/:id/views/:view/tasks`) nothing is guessed, so name it (`:project_id`) or map it (`filters: { ":id": project_id }`). Nothing else is tried: a parameter that binds to no field makes the scenario invalid, and the error lists the names it looked for and the `filters` entry that would map it.
- `filters` as a map: `":name": <field>` binds a parameter (`null` accepts any value without filtering, for a segment the world does not model, such as a view id the tasks do not carry); a plain key is a query filter and names its own field (`done: done`). The list form (`filters: [done]`) keeps working for paths without parameters, and for paths whose parameters bind by name.
- A value no row has is an empty list (`200 []`), not a 404: the route exists. Query filters, `sort`, pagination and `shape` apply on top of the parameters.
- **PostgREST operators are understood**, because supabase-js always sends them: `eq.`, `neq.`, `gt.`, `gte.`, `lt.`, `lte.`, `like.` / `ilike.` (`*` and `%` are wildcards), `is.` (`null`/`true`/`false`) and `in.(1,2)`. `?status=eq.issue` is the same as `?status=issue`; a comma list without a prefix stays an OR of equalities, and an unknown prefix is a literal value (`?status=bogus.issue` ⇒ `[]`), never a silent widening. This is what makes a `.eq()` from supabase-js match at all: before 0.9.5 `?expediente_id=eq.1` returned `[]`.
- **`Accept: application/vnd.pgrst.object+json`** (what `.single()` sends) returns the row as an object whatever `shape` says, and answers `406 {code: "PGRST116"}` unless exactly one row survives the filters. Still declare the columns the client filters on in `filters` (atrezzo models the contract, not the whole table), including `id` when the client uses `.eq('id', …)`.
- The detail route still comes with `detail: true`: `GET /api/v2/projects/1/views/4` answers view 4 only if its `project_id` is 1 (else 404). A trailing `/:id` is that detail route, so it cannot be declared.
- When two endpoints fit a request, the one with the fewest parameters wins (`/api/projects/archived/tasks` before `/api/projects/:id/tasks`); list routes are tried before detail routes. Two paths that differ only in parameter names are duplicates.
- MSW registers the same `:name` path (the generated handlers run the same engine). Prism gets an OpenAPI path with `{name}` parameters and examples for the first row's values. WireMock does not pre-generate parameterised endpoints (the note says so); use `serve` or MSW for them.

#### Embedded children (`embed`)

`embed: [views]` adds to every returned row a `views` key with **the rows of `views` that point at it** (the reverse of `ref:`), as objects, in world order:

```yaml
world:
  projects: 3
  views: { total: 6, ref: projects }
endpoints:
  - path: /api/v2/projects
    entity: projects
    embed: [views]                 # → [{ "id": 1, "name": "…", "views": [{ "id": 4, "project_id": 1, … }] }, …]
```

- Same relation as the embedded counts (`select=*,views(count)`), returning rows instead of `[{ count }]`. A row with no children gets `"views": []`.
- Works on list rows, the detail route and `shape: object`, and combines with `include` and with path parameters: `/api/v2/projects/:id` answers the project with its `views`, and `/api/v2/projects/:project_id/views/:view_id/tasks` answers the tasks of one of them.
- The child entity must `ref:` the endpoint's entity (else the scenario is invalid and says which `ref:` to add); an embed name cannot be a field of the entity.

**Nested** (children of children): an entry can be a map `{ entity, embed }`, and its rows carry their own embeds:

```yaml
world:
  sections: 3
  items: { total: 9, ref: sections }    # → section_id
  tags: { total: 18, ref: items }       # → item_id
endpoints:
  - path: /api/sections
    entity: sections
    embed:
      - entity: items
        embed: [tags]                   # → [{ "id": 1, …, "items": [{ "id": 2, "section_id": 1, …, "tags": [{ "id": 5, "item_id": 2, … }] }] }]
```

- Each level resolves its own relation: the child must `ref:` the entity it is embedded in (its fk is `<singular of that entity>_id`), and every embedded row is the full row of the world, with its nested lists added.
- At most **4 levels** below the endpoint's entity. An entity that would end up inside its own rows (`alphas → betas → alphas`) is a cycle, and the scenario is invalid with that path in the message.
- The short form still works (`embed: [items]`, `embed: items`); `{ entity: items }` without `embed` is the same as `items` (same scenario hash).

#### Plain values (`pluck`)

Some clients ask for a list of ids and compare with `ids.includes(String(id))`. `pluck: <field>` answers **that field of each row, as a string**, instead of the rows:

```yaml
endpoints:
  - path: /api/events
    entity: events
    pluck: id                       # → ["1", "2", "3"]   (?kind=live → ["1", "3"])
  - path: /api/event-ids
    entity: events
    pluck: id
    pick: items                     # → { "items": ["1", "2", "3"], "total": 3, "limit": null, "offset": 0 }
```

- Filters, path parameters, `sort`, pagination and `X-Total-Count` work as on rows; only each item changes. A null stays `null`.
- The detail route answers the single value (`GET /api/events/2` ⇒ `"2"`), `shape: object` the first row's value, `.single()` one value or the 406.
- Validation: the field must exist in the entity (the error lists its fields); `pluck` with `include` or `embed` is an error (there are no rows to attach them to).
- Prism declares the list as `string` items; WireMock pre-computes it like any other list.

#### Declared errors (`error`)

To bring up the screen's error states, an endpoint can always answer one error status with a given body, whatever the world holds:

```yaml
endpoints:
  - path: /api/submit
    entity: submissions
    error: { status: 503, body: { code: "SERVICE_DOWN", retryAfter: 30 } }   # → 503 with that JSON, verbatim
  - path: /api/totals
    entity: totals
    error: { status: 500 }          # → 500 { "error": "500" }
```

- The list route and the detail route answer `status` and `body` exactly (any JSON value; `null` sends an empty body), with `X-Atrezzo-Error: declared`. Filters, pagination and the world are not looked at; the other endpoints do not change. Writes to it are still a 405 gap.
- Validation: `status` is required, an integer from 400 to 599; `body` is optional (default `{ "error": "<status>" }`); any other key is an error.
- `serve` prints each one in its banner (`(declared error 503)`) and `GET /__atrezzo/state` lists them as `errors: { path: status }`. It is not a gap.
- `verify` treats it as a real answer: a `data` assertion reads 0 rows from it, so a step that expects data is KO (with the note "answered the error the scenario declares", and a `declared-error` hypothesis under `--diagnose`), while an assertion that expects the error state (`count: 0`, or the screen's error banner with the playwright driver) can pass.
- Prism declares only that response, with the body as its example; WireMock gets one static mapping for the list and the detail route.

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
- Nested routes (gap `GET /api/customers/:id/orders`): declare the path with a named parameter, `path: /api/customers/:customer_id/orders` (or `/api/customers/:id/orders`: a bare `:id` names the segment before it when it is the only parameter), on an entity that carries `customer_id` (`ref: customers`). If the row reads a list of children (`customer.orders[]`), add `embed: [orders]` to the parent's endpoint.
- Writes (POST/PUT/PATCH/DELETE): not declared. `serve --on-miss stub` answers 200 `{}` for exploring.

#### Discovering and filling gaps with a browser (`atrezzo harvest`)

```bash
atrezzo harvest <url> --scenario <file> [--storage <file.json|@->] [--until <css|text=…>] [--rounds 5] [--types <file.ts>] [--write]
```

`harvest` starts the built-in mock on a free port (unless `--port`), opens `<url>` in Chromium (using `ATREZZO_CHROME` like `verify`), collects every 404 gap the mock records (and any request retried after a failure), infers endpoints and entities, reloads the mock (`/__atrezzo/reload`), and repeats until a round adds nothing, `--until` appears, or `--rounds` is reached.

- **Authenticated apps (`--storage`)**: `--storage <file.json>` (or `@-` from stdin) reads a `{ "local": {…}, "session": {…} }` map with the same parser as flow `storage:` and applies it via `context.addInitScript` before the first navigation, so router guards see the session on initial load. `${…}` in a key or value is invalid (exit 3), and the report prints only the keys (`Storage (keys): …`).

- **Path and query keys**: path parameters become `:name` segments; pagination (`limit`/`offset` or `page`/`per_page`) and equality query params become `pagination` and `filters`.
- **Path parameters are bound by name**: a path with parameters always gets `filters` in the **map** form, every parameter bound explicitly (`":widget_id": widget_id`, `":gadget_id": gadget_id`) and each query filter as `field: field`; never the list form, which binds nothing once there are two parameters. A parameter that names a world entity becomes its `ref:` and binds its FK; one for a segment the world does not model gets a field of its own name holding the observed value (the observed URL has rows, any other value answers `[]`); `null` (accept any value) is used, and reported, only for an entity another endpoint already projects.
- **Flags are not filters**: a query key that starts with `sort`, `order`, `filter`, `with`, `is_` or `has_`, ends in `_by`, is a known behaviour key (`expand`, `include`, `fields`, `search`, `q`, …) or arrives with a boolean value stays out of `filters` and is listed as `query parameter "sort_by" left out of the filters (a flag, not a subset of rows)`. A key ending in `_id` is a foreign key and stays a filter (`order_id=3`).
- **Detail routes**: a numeric id in the path (`/api/widgets/7`) first widens the entity to `total >= 7`, whether it has no rows yet or fewer than the id, and only then is the detail judged; only an id atrezzo cannot number (not an integer, below 1, or above 1000) is left out, with the reason.
- **Response envelope by trial**: a new list endpoint starts as a plain array. If, on the next round, the page requested it but did not advance (no request and no selector it had not seen before), harvest retries it as `shape: envelope` with `pick:` `items`, `data`, `results`, `records`, `rows`, in that order, one per round, and keeps the first that makes the page advance; the report says which attempt won (`shape: envelope, pick: items (attempt 2 of 6: array → items; …)`). If none does (or the rounds run out mid-trial), it stays an array and the report says so. The trial needs to read the page's selectors (always the case in Chromium); without them a quiet round proves nothing and the array is kept.
- **Fields preference**: (1) `--types <file.ts>` (`interface X` / `type X = { … }`: `string → string`, `number → integer`, `boolean → boolean`, ISO date strings → `date`, string literal unions → enum list, primitive arrays → `values:` repeated array); (2) `select=` query columns; (3) plural of the last path segment plus `id`.
- **The nesting of the route is its coherence (`derive`)**: when two or more path parameters bind to world entities (`/api/widgets/:widget_id/gadgets/:gadget_id/pieces`), the entity of the last segment derives every outer parent's fk through the innermost parent (`derive: { widget_id: { from: gadgets, field: widget_id } }`), and the innermost parent gets `ref:` to the outer one if it lacks it (unless that would be a cycle, which is reported). Only the shape of the route decides, never the names. If the observed URL itself is not coherent in the world (its gadget belongs to another widget), the report says so and names the URL that has rows, for the flow's `visit:`. The report lists each derivation under `Coherence (from the path nesting)`.
- **First declared state (`seed_first`)**: an entity created from `--types` (endpoint type or `T[]` child) with an enum (literal union) or a `boolean` field gets `seed_first: true`, so the screen does not come up in a drawn disabled or secondary state; the report lists them under `Seeded by first value`.
- **Singletons (`shape: object`)**: paths ending in `info`, `user`, `me`, `config`, `settings`, or a `--types` response type with no `items`/`data` key.
- **Relations (`--types`)**: when the endpoint's type is matched, each property whose type is another `interface`/`type` declared **in the same file** is a relation; the decision uses only the type graph and the scenario's own `ref:`s, never names:
  - `field: T[]`, `field: Array<T>`, `field?: T[]`, `readonly field: readonly T[]`, `T[] | null`, `Array<T> | null`, `T[] | undefined` (or an alias of one of them) → **children**. The JSON key is the **property**, so the child entity is named `field` exactly as written (`items: Array<StoreItem>` → `items`, never `store_items`); `T` only supplies its fields. A world entity already named `field` that `ref:`s this one is reused as is; one without the `ref:` is reported; otherwise `field` is created with `T`'s fields, the parent FK `<singular of the parent>_id` (added when `T` lacks it; never derived from the child) and `ref: <this entity>` (total: twice the parent's). The parent endpoint gets `embed: [field]`. A property that is not a valid entity name (`topItems`) is reported, not renamed.
  - `field: T` (`T | null`, optional) → **parent**: `include: [<entity of T>]` when a world entity for `T` exists and this entity `ref:`s it (the ref, whose FK is `<singular>_id`, is added only to an entity no other endpoint projects yet); the property name must equal the entity's singular (`include` answers that key).
  - A route the app requests later under the parent (`/widgets/:widget_id/gadgets/:gadget_id/sprockets`) binds `:gadget_id` to the same embedded entity, and its own entity takes the fields of its interface: the id the app put in the URL came from the embedded rows.
  - Never invented: a type not declared in the file, a world entity for `T` without the `ref:`, a self reference, a cycle or a name mismatch leaves the scenario untouched and is listed under "Could not infer / not mocked" as `Widget.parts: Part[] → relation not mocked (missing entity + ref): <reason> (types:<file>:<line>)`. Scalars, enums, literal unions, primitive arrays (`string[]`), generics (`Record<…>`) and built-ins (`Date`) are fields, never relations.
- **Output**: prints a table (`endpoint`, `entity`, `shape`, `source`, `fields`), a `Relations (from --types)` section, one line per relation with the property and the type (`Shelf.items → embed [items] (type StoreItem, new entity items, ref: shelves, types:types.ts:5)`), a `Response shape` section for each envelope found by trial, and anything it could not infer (including `POST`/`PUT`/`DELETE` writes, which are never mocked). With `--write`, merges into `<file>` keeping existing keys; without it, writes to a temporary copy.

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
