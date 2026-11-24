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
    sorts: { by: sort_by, order: order_by, fields: [id, status, created_at] }   # optional dynamic sort
    scopes: { is_archived: archived } # optional: ?is_archived=true widens the set to archived rows (needs a boolean field)
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
| `auth` | map | optional; `{ user: { entity, id } }` seeds the current user for `$user.<field>` filters |
| `world` | map | required, at least one entity |
| `endpoints` | list | required, at least one |
| `writes` | map | optional; `<METHOD> /path`: `{ expect, mutate }` for `POST`/`PUT`/`PATCH`/`DELETE` |
| `streams` | map | optional; `/path`: `{ interval, events, loop }` for SSE (`text/event-stream`) in `serve` |
| `rpc` | map | optional; `<function>`: `{ expect, body, match }` for PostgREST functions (`POST /rpc/<fn>`, `/rest/v1/rpc/<fn>`) |
| `entry` | string | optional; with `path`, it must be its first element |
| `path` | list of strings | optional; screens in order |
| `expect` | list | optional |

Any other field is an error (`unknown field`). A scenario can also be `.json` with the same structure (`atrezzo import --format json`).

### Entities (`world.<name>`)
An integer (= `total`) or a map with: `total` (required), `distribution`, `distribution_field` (default `status`), `amount`, `ref`, `nulls`, `values`, `days`, `fields`, `derive`, `seed_first`, `values_order`, `counts`.

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

Types: `string`, `integer`, `number`, `boolean`, `date` (ISO, within `days` before `now`), `email`, `uuid`, `url`, or a list of values. A field can also be written as `{ type: <type> }`, and a `string` one can add `empty:` (see below). With `fields`, the entity has **exactly** `id` + the fks of its `ref` + `fields` (+ the `distribution` field and the `amount` fields if you declare them): the template (`customers`, `orders`…) adds neither its own fields nor its defaults. `id` cannot be declared (always integers 1..n). Values come from a dedicated PRNG stream (`fields:<entity>`): adding `fields` to one entity does not change the others.

##### Empty strings (`{ type: string, empty }`)

A `string` field can come out as `""` in some rows, to exercise branches such as "No description available" without touching the rest of `fields`:

```yaml
world:
  notes:
    total: 10
    nulls: { description: 2 }
    fields:
      title: string
      description: { type: string, empty: 0.4 }   # 4 of 10 rows with ""
      summary: { type: string, empty: true }      # every row with ""
```

- `{ type: <type> }` is the object form of a plain field: `{ type: string }` is exactly `string` (same normalized scenario, same hash).
- `empty` (optional): a number `0..1` (share of rows: `round(empty × total)` rows get `""`) or `true` (every row). `empty: 1` = `true`; `empty: 0` = not declared. It can also go on a conditional field whose `default` is `string` (`{ default: string, when, value, empty }`).
- The rows come from their own stream (`empty:<entity>.<field>`): the drawn values of every other field and entity stay as they were, the non-empty rows keep their value, and scenarios that do not use it keep their hash.
- With `nulls:` on the same field, the empty rows are drawn among the rows that are not null: a row is null or `""`, never both (with `empty: true`, every non-null row is `""`). The nulls fall on the same rows as without `empty`.
- Applied after `nulls` and before conditional fields, so a `when: { description: "" }` matches the empty rows. On a conditional field itself, the emptied rows are preserved (just like `nulls`), so a matching `when` does not overwrite `""`.
- Validation (scenario error): `empty` only on `string` fields (not `email`, `url`, `uuid`, enums or any other type), and only `0..1` or `true`.

##### Conditional field values (`{ default, when, value }`)

A field in `fields` can override its drawn `default` when another field (or fields) of the **same row** matches `when`:

```yaml
world:
  groups:
    total: 10
    fields:
      name: string
      locked: boolean
      tier_level: { default: [2], when: { locked: true }, value: [0] }
```

- `default` (required): any valid `fields` type (`string`, `integer`, `number`, `boolean`, `date`, `email`, `uuid`, `url`, or a non-empty list of scalar values). Drawn as usual before conditions are evaluated, so other fields and entities keep the values they had without the rule.
- `when` (required): non-empty map `<field>: <value>` (or `<field>: [<values>]`). Matches when every listed field of the row equals the given value (or one of the given values).
- `value` (required): scalar or non-empty list of scalar values compatible with `default`. Single-item lists assign that value directly; multi-item lists pick deterministically per row from a dedicated stream (`when:<entity>.<field>`).
- Evaluation order: runs deterministically after normal field draws, `values_order: cycle`, `seed_first`, and `nulls`/`empty` on other fields (explicit `nulls` and `empty` strings on the target field itself are preserved). Without conditional fields, scenario normalization and hashes are unchanged.
- Validation (scenario error): every key in `when` must reference another existing field of the same entity (no self-references or cycles); `value` must be compatible with `default`'s type; impossible conditions (such as matching a `boolean` field against a non-boolean, an enum/distribution field against an undeclared value, or an `id`/foreign key outside `1..total`) are rejected.

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

##### `values_order: { cycle: { by: <field> } }`: the sequence restarts for every group

Plain `cycle` counts over the whole entity: row *i* of 15 gets `values[i % n]`, so the 6 members of the second team continue where the first team left off and a screen that lists them per team shows 6/3/6 with the roles out of order. Naming a field gives **each value of that field its own cursor**, starting again at the first value:

```yaml
world:
  teams: 3
  members:
    total: 15
    ref: teams
    fields: { role: [owner, reader, guest], name: string }
    values_order: { cycle: { by: team_id } }   # cada equipo: owner, reader, guest, owner…
```

- `by` must be a field of the entity (a foreign key counts); rows whose `by` value is missing or `null` group together. `{ cycle: {} }` is the flat cycle.
- Everything else is unchanged: the same list order, the same rows on every seed, `seed_first`/`nulls` still win, and the other fields keep the values they had. The grouped form does change the scenario hash (it is a different world from the flat one).
- Validation: `cycle` or `random`, or `{ cycle: { by: <field> } }` with an existing field; an entity with no field with a list of values is an error.
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
`path` (starts with `/`, no query; `:name` segments are path parameters), `entity` (declared in `world`; optional when `passthrough` is set), `filters` (existing fields for query filters, `{ <field>: "$user.<field>" }` for seeded-user filters, `{ <fk>: { from, where } }` for world-resolved filters; a map also binds path parameters), `pagination`, `sort`, `sorts` (dynamic sort query parameters and allowed fields), `scopes` (query parameters that pick the set of rows by a boolean field), `include` (referenced entities only), `embed` (entities that reference this one, nestable), `counts` (child count fields `{ <name>: { entity, on } }`), `shape` (`array` default, `envelope`, `object`), `envelope` (custom response keys `{ items, total, page, per_page, total_pages }` when `shape: envelope`), `wrap` (key name wrapping a `shape: object` response as `{ <key>: <row> }`), `detail`, `pick`, `latency`, `pluck` (a field: answer its values, not rows), `error` (always answer this error), `passthrough` (serve a frozen fixture `{ fixture, patch }` with dot-path overrides).

- Offset `pagination`: `{ param_limit, param_offset, default_limit, max_limit }`. By page: `{ param_page: page, param_limit: per_page, default_limit: 10 }` (`default_limit` required; `offset = (page - 1) × limit`; `page=0` ⇒ 400; cannot be combined with `param_offset`).
- `pick: items` ⇒ an envelope with that key: `{ items: [...], total, limit, offset }` (implies `shape: envelope`; `shape: envelope` without `pick` or `envelope` uses `data`). A single key, no nested paths.

#### Custom envelopes (`envelope`)

When an endpoint uses `shape: envelope`, `envelope` lets you name the keys of the response JSON instead of using the default `{ data, total, limit, offset }` shape:

```yaml
endpoints:
  - path: /api/records
    entity: records
    pagination: { param_limit: limit, param_offset: offset, default_limit: 10 }
    shape: envelope
    envelope: { items: records, total: recordCount }         # → { "records": […], "recordCount": 40 }
  - path: /api/paged-records
    entity: records
    pagination: { param_page: page, param_limit: per_page, default_limit: 10 }
    shape: envelope
    envelope: { items: records, total: recordCount, page: page, per_page: per_page }
  - path: /api/meta-records
    entity: records
    pagination: { param_page: page, param_limit: per_page, default_limit: 10 }
    shape: envelope
    envelope: { items: data, total: meta.total, page: meta.page }  # → { "data": […], "meta": { "total": 40, "page": 1 } }
```

- **Configurable keys**: `items` (list of rows; defaults to `"data"` if omitted), `total` (filtered total before pagination), and optionally `page` (1-based current page number, computed from `param_page` or `Math.floor(offset / limit) + 1`, defaulting to `1`), `per_page` (effective page size, or `null` when unpaginated/no limit) and `total_pages` (**derived**, never drawn: `ceil(total / per_page)`, or `1` when the endpoint is not paginated). The number of pages is what a paginator reads, so it does not need a column in the world. Only the keys declared in `envelope` (plus `items`) are emitted: omitting `page` and `per_page` leaves them out of the JSON body.
- **Dot-paths**: a key value such as `meta.total` places the value inside nested objects (`{ meta: { total: … } }`).
- **Default unchanged**: omitting `envelope` keeps `{ [pick ?? "data"], total, limit, offset }` and preserves scenario hashes.
- **Validation (scenario error)**: `shape` must be `"envelope"`, `envelope` cannot be combined with `pick`, and every key name must be non-empty (no whitespace, empty segments, duplicates, or nested path conflicts).
- **`verify` and `serve`**: `serve` returns the configured envelope directly, and `verify` automatically reads `envelope.items` from the scenario when `data.pick` is omitted on a flow assertion.

#### Dynamic sorting (`sorts`)

`sort` sets the endpoint's default order; `sorts` lets the client choose it at request time from an explicit allowlist of fields:

```yaml
endpoints:
  - path: /api/orders
    entity: orders
    sort: -created_at                                          # default when the request sends no sort param
    sorts: { by: sort_by, order: order_by, fields: [id, status, created_at] }
  - path: /api/items
    entity: items
    sorts: { by: sort, fields: [id, name, created_at] }        # single param: ?sort=-created_at or ?sort=name
  - path: /api/entries
    entity: entries
    sorts: { by: order, fields: [id, created_at] }             # PostgREST style: ?order=created_at.desc
```

- **`by`** (default `sort_by`): query parameter naming the field(s) to sort by. Accepts `field`, `-field` / `+field`, `field.asc` / `field.desc`, and comma-separated lists (`status.asc,created_at.desc`).
- **`order`** (optional): query parameter naming the direction (`asc` or `desc`, case-insensitive) when sent separately (`?sort_by=id&order_by=desc`); omitted when direction lives in `by` (`-field` or `field.desc`). Defaults to `asc` when `by` is sent without direction, or applies to `sort[0]` when only `order` is sent.
- **`fields`** (required, non-empty list): allowed fields of the entity. Declared `by`/`order` parameters are consumed by sorting (not listed in `X-Atrezzo-Ignored`), and sorting runs **before** pagination and `shape: object`.
- **No silent errors**: in the scenario, an unknown entity field in `fields`, missing/empty `fields`, duplicate field, `by == order`, or collision with `filters`/`pagination` is a scenario error (exit 3). At request time, a field outside `fields`, an invalid direction (anything other than `asc`/`desc`), or a conflicting direction (`?sort_by=-id&order_by=asc`) answers `400 { error: ... }`.
- Without `sorts:`, behaviour and scenario hashes are unchanged (client sort parameters stay in `X-Atrezzo-Ignored`).

#### Scopes (`scopes`)

Some parameters do not filter rows by a value: they choose **which set** the list is drawn from. `?is_archived=true` usually means "include the archived rows too", not "only the archived rows". A filter cannot say that, so `scopes` declares those parameters explicitly:

```yaml
world:
  widgets:
    total: 30
    fields: { name: string, finish: [matte, gloss], archived: boolean }
endpoints:
  - path: /api/widgets
    entity: widgets
    filters: [finish]
    scopes:
      is_archived:                 # query parameter name
        field: archived            # boolean field of the entity (required)
        default: exclude           # without the parameter: exclude (hide rows with archived: true) | include (every row)
        when_true: add             # ?is_archived=true:  add (default set + rows with archived: true) | only (just those rows)
        when_false: only           # ?is_archived=false: only (just rows with archived ≠ true) | add (default set + those rows)
  - path: /api/widgets-all
    entity: widgets
    scopes: { is_archived: archived }   # short form: same as { field: archived } with the defaults above
```

With the defaults (`exclude` / `add` / `only`):

| request | rows |
|---|---|
| `/api/widgets` | the endpoint default: rows whose `archived` is not `true` |
| `/api/widgets?is_archived=true` | the set widens: every row, archived or not |
| `/api/widgets?is_archived=false` | only rows whose `archived` is not `true` |
| `/api/widgets?is_archived=maybe` | `400 { error: "\"is_archived\" must be \"true\" or \"false\"; got \"maybe\"" }` |

- **Not a filter**: a declared scope parameter is consumed by the engine and never listed in `X-Atrezzo-Ignored`. `null` and `false` both count as "not `true`".
- **Values**: `true` or `false` (case-insensitive). An empty value (`?is_archived=`) is the same as absent. Anything else, or the parameter repeated with different values, answers `400`.
- **Combines**: the scope runs together with path parameters, world/user filters and query filters (intersection), then `sort`/`sorts`, pagination, `shape: object` and `head=true`. `X-Total-Count`, `Content-Range` and envelope `total` count the resulting set before pagination.
- **Lists only**: the detail route (`/api/widgets/:id`) is not scoped; an archived row is still reachable by id.
- **Runtimes**: `serve` and MSW run the same engine; Prism documents the parameter as `enum: [true, false]`; WireMock pre-computes `?param=true` and `?param=false`.
- **Validation (scenario error, exit 3)**: `field` must exist and be a boolean (`fields: { archived: boolean }`, or a `values:`/enum list of booleans); `default` must be `exclude`/`include`, `when_true`/`when_false` must be `add`/`only`; unknown keys are rejected; the parameter name cannot collide with a declared filter, a pagination or sort parameter, `select` or `head`.
- Without `scopes:`, behaviour and scenario hashes are unchanged (the parameter stays in `X-Atrezzo-Ignored`).

#### World-resolved filters (`filters: { <fk>: { from, where } }`)

When an endpoint shows only the rows whose foreign key points to rows of another entity matching a condition (such as a personal feed whose backend resolves the filter server-side without a query parameter), `filters` accepts the long form `{ from, where }`:

```yaml
world:
  sources:
    total: 6
    fields: { name: string, active: boolean }
  items:
    total: 30
    ref: sources
    fields: { title: string, status: [draft, live] }
endpoints:
  - path: /api/feed
    entity: items
    filters:
      source_id: { from: sources, where: { active: true } }
      status: status              # normal query filter: ?status=live
    pagination: { param_limit: limit, param_offset: offset }
    sort: -id
```

- **Semantics**: returns only the rows of the endpoint's entity whose foreign key (`source_id`) points to a row of `from` (`sources`) where every field in `where` matches (a list in `where` matches any of its values, e.g. `where: { tier: [core, extra] }`). Rows with `null` in that foreign key are excluded.
- **No query parameter**: unlike `status: status` or `[status]`, a world-resolved filter does not expose a query parameter (sending `?source_id=1` is ignored and listed in `X-Atrezzo-Ignored`).
- **Combines naturally**: runs together with path parameters, normal query filters (`?status=live`), `sort`/`sorts`, `pagination` (`X-Total-Count` counts the resolved + filtered rows before pagination), `shape: object`, and `head=true`.
- **Short form unchanged**: `filters: [status, source_id]` and `filters: { status: status, ":cid": cabinet_id }` keep their exact behaviour and scenario hashes.
- **Validation (scenario error)**: `from` must be a declared entity in `world`; the filter key must be a foreign key of the endpoint's entity pointing to `from` (via `ref:`); `where` must be a non-empty map whose keys are existing fields of `from` with scalar or non-empty scalar-list values compatible with each field's type.

#### Seeded user (`auth` and `$user.<field>`)

When a screen boots by reading `/api/user` or `/api/me` (or lists the logged-in user's own items) without sending a query parameter, declare a root `auth` block pointing to one row in `world`:

```yaml
auth:
  user:
    entity: accounts
    id: 2
world:
  accounts: 4
  records: { total: 20, ref: accounts, fields: { title: string, status: [draft, published] } }
endpoints:
  - path: /api/user
    entity: accounts
    shape: object
    filters: { id: "$user.id" }          # answers accounts row #2 instead of row #1
  - path: /api/my-records
    entity: records
    filters:
      account_id: "$user.id"             # only rows where account_id == currentUser.id
      status: status                     # normal query filter: ?status=published
```

- **Current user row**: the projection engine exposes the row as `currentUser` (`null` when `auth` is omitted). Any endpoint filter `{ <field>: "$user.<userField>" }` (or `$user.<userField>` inside a world-resolved filter's `where`) compares `<field>` against `currentUser[userField]` without requiring a query parameter.
- **No query parameter**: like world-resolved filters, `$user.<field>` filters do not expose a query parameter (sending `?account_id=1` is ignored and listed in `X-Atrezzo-Ignored`). If `currentUser[userField]` is `null`, no rows match.
- **Validation (scenario error)**: `auth.user.entity` must be declared in `world`, and `auth.user.id` must be an integer `>= 1` within `1..total` of that entity. Using `$user.<field>` without `auth`, naming a field missing from `auth.user.entity`, or referencing a user field whose type is incompatible with the filtered field is also a scenario error.
- **Without `auth`**: behaviour and scenario hashes are completely unchanged.

#### Paths with parameters (`/cabinets/:cabinet_id/drawers/:drawer_id/items`)

A detail screen with tabs asks for the children of one row through a nested route. Any segment of `path` can be a parameter `:name`; each one is an **equality filter on a field of the entity**:

```yaml
world:
  cabinets: 3
  drawers: { total: 6, ref: cabinets }          # → cabinet_id
  items: { total: 40, ref: [cabinets, drawers] } # → cabinet_id, drawer_id
endpoints:
  - path: /api/cabinets/:cabinet_id/drawers/:drawer_id/items
    entity: items                  # GET /api/cabinets/1/drawers/4/items → items with cabinet_id=1 and drawer_id=4
  - path: /api/cabinets/:id/drawers
    entity: drawers                # a bare :id, the path's only parameter, names the segment before it → cabinet_id
  - path: /api/c/:cid/lists/:list/items
    entity: items
    filters: { ":cid": cabinet_id, ":list": null, done: done }   # explicit binding; null = accept any value
```

- Binding, in this order: an explicit `filters: { ":name": field }` entry; else the field called `name`; else `<name>_id` (`:cabinet` → `cabinet_id`). A bare `:id` in the middle binds only to the singular of the segment before it + `_id` (`/cabinets/:id/drawers` → `cabinet_id`), never to the row's own `id`, and only when it is the path's **single** parameter: with two or more (`/cabinets/:id/drawers/:drawer/items`) nothing is guessed, so name it (`:cabinet_id`) or map it (`filters: { ":id": cabinet_id }`). Nothing else is tried: a parameter that binds to no field makes the scenario invalid, and the error lists the names it looked for and the `filters` entry that would map it.
- `filters` as a map: `":name": <field>` binds a parameter (`null` accepts any value without filtering, for a segment the world does not model, such as a drawer id the items do not carry); a plain key is a query filter and names its own field (`done: done`). The list form (`filters: [done]`) keeps working for paths without parameters, and for paths whose parameters bind by name.
- A value no row has is an empty list (`200 []`), not a 404: the route exists. Query filters, `sort`, pagination and `shape` apply on top of the parameters.
- **PostgREST operators are understood**, because supabase-js always sends them: `eq.`, `neq.`, `gt.`, `gte.`, `lt.`, `lte.`, `like.` / `ilike.` (`*` and `%` are wildcards), `is.` (`null`/`true`/`false`) and `in.(1,2)`. `?status=eq.issue` is the same as `?status=issue`; a comma list without a prefix stays an OR of equalities, and an unknown prefix is a literal value (`?status=bogus.issue` ⇒ `[]`), never a silent widening. This is what makes a `.eq()` from supabase-js match at all: before 0.9.5 `?customer_id=eq.1` returned `[]`.
- **`Accept: application/vnd.pgrst.object+json`** (what `.single()` sends) returns the row as an object whatever `shape` says, and answers `406 {code: "PGRST116"}` unless exactly one row survives the filters. Still declare the columns the client filters on in `filters` (atrezzo models the contract, not the whole table), including `id` when the client uses `.eq('id', …)`.
- The detail route still comes with `detail: true`: `GET /api/cabinets/1/drawers/4` answers drawer 4 only if its `cabinet_id` is 1 (else 404). A trailing `/:id` is that detail route, so it cannot be declared.
- When two endpoints fit a request, the one with the fewest parameters wins (`/api/cabinets/archived/items` before `/api/cabinets/:id/items`); list routes are tried before detail routes. Two paths that differ only in parameter names are duplicates.
- MSW registers the same `:name` path (the generated handlers run the same engine). Prism gets an OpenAPI path with `{name}` parameters and examples for the first row's values. WireMock does not pre-generate parameterised endpoints (the note says so); use `serve` or MSW for them.

#### Embedded children (`embed`)

`embed: [drawers]` adds to every returned row a `drawers` key with **the rows of `drawers` that point at it** (the reverse of `ref:`), as objects, in world order:

```yaml
world:
  cabinets: 3
  drawers: { total: 6, ref: cabinets }
endpoints:
  - path: /api/cabinets
    entity: cabinets
    embed: [drawers]               # → [{ "id": 1, "name": "…", "drawers": [{ "id": 4, "cabinet_id": 1, … }] }, …]
```

- Same relation as the embedded counts (`select=*,drawers(count)`), returning rows instead of `[{ count }]`. A row with no children gets `"drawers": []`.
- Works on list rows, the detail route and `shape: object`, and combines with `include` and with path parameters: `/api/cabinets/:id` answers the cabinet with its `drawers`, and `/api/cabinets/:cabinet_id/drawers/:drawer_id/items` answers the items of one of them.
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

#### Child counts (`counts`)

When a parent row needs the number of child rows pointing to it (for example a group's `count` or `items_count` when the child list is paginated or limited), declare `counts` on the **entity** (`world.<name>.counts`) or on an **endpoint** (`endpoints[i].counts`):

```yaml
world:
  groups: 4
  items:
    total: 20
    ref: groups
endpoints:
  - path: /api/groups
    entity: groups
    filters: [id]
    pagination: { param_limit: limit, param_offset: offset }
    counts:
      items: { entity: items, on: group_id }   # → numeric `items_count` on each row
      count: { entity: items, on: group_id }   # → numeric `count` on each row (declared name)
```

- **Field naming**: when the key equals the child `entity` name (`items: { entity: items, on: group_id }`), the row exposes `<entity>_count` (`items_count`); any other key (`count`, `open_items`, `items_count`) is exposed under that exact declared name.
- **Entity or endpoint**: declaring `counts` on `world.<entity>` applies to every endpoint projecting that entity; declaring `counts` on an endpoint adds to (or overrides by output field name) the entity's counts.
- **World-computed and deterministic**: counts are computed over **all** rows of `entity` in `world` whose `on` foreign key equals the parent row's `id` (`null` foreign keys are skipped; empty child sets or parents with no matching children yield `0`). Counts ignore endpoint `pagination` / `limit` and endpoint filters on the rows—every surviving row after the endpoint's filters, path parameters, `sort`/`sorts`, `shape: object`, `shape: envelope`, and `/:id` detail routes carries its exact world count without mutating `dataset.entities`.
- **Validation (scenario error)**: `entity` must be declared in `world`, `on` must be an existing foreign key of `entity` pointing to the parent entity, output field names must be unique and not collide with any field of the parent entity (or `include`/`embed` keys on the endpoint), and `counts` (on the entity or endpoint) cannot be combined with `pluck`. Without `counts`, behaviour and scenario hashes stay unchanged.

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

#### Passthrough-and-patch (`passthrough` and `atrezzo record`)

To reproduce rare edge states (a locked row, a disabled state) without modeling a whole world for that payload, freeze a real response with `atrezzo record` and override specific fields with `patch`:

```bash
atrezzo record https://api.example.com/api/batch --scenario atrezzo/scenarios/batch.yaml --endpoint /api/batch --header "Authorization: Bearer $TOKEN"
```

```yaml
endpoints:
  - path: /api/batch
    passthrough:
      fixture: api-batch            # reads atrezzo/fixtures/api-batch.json
      patch:
        "batch.open": false         # dot-path override (objects and numeric array indices)
        "items.0.locked": true
```

- **No secrets saved**: `atrezzo record` discards all request headers and all response headers (cookies, auth tokens, tracking headers, query tokens); `atrezzo/fixtures/<name>.json` stores **only** `{ status, contentType, hasBody, body }` (`hasBody` distinguishes JSON `null` from an empty/bodiless response).
- **Byte-for-byte preservation**: `serve` (and generated MSW handlers) respond with the recorded `status`, `contentType`, and `body` with only the declared `patch` paths modified, keeping every other key, order, array element, and value intact.
- **`entity` and `world` optional**: when `passthrough` is set, `entity` is optional on the endpoint, and `world` is optional at the root if every endpoint uses `passthrough`. `detail` defaults to `false` and cannot be `true`; `passthrough` cannot be combined with `error`.
- **Validation (exit 3)**: a missing fixture file or any `patch` path whose key, nested segment, or array index does not exist in the fixture body fails loudly in `loadScenario`, `world`, `serve`, and `doctor` (never silently creates missing paths). `POST /__atrezzo/reload` picks up edited fixtures and patches without restarting `serve`.
- **Fixture path resolution (`serve` and `doctor`)**: without CLI overrides, `serve` and `doctor` resolve fixtures from `fixturesDir` in `atrezzo.config.json` (default `atrezzo/fixtures`), even if a sibling `fixtures/` folder exists. `--fixtures <dir>` is an explicit override relative to the current working directory and takes precedence over project config, bundle config, and sibling folders. Passing `--scenarios <dir>` to an external bundle without `--fixtures` auto-discovers bundle-local fixtures without walking arbitrary ancestors outside the bundle: a bundle-local `atrezzo.config.json` `fixturesDir` wins first; otherwise an existing `atrezzo/fixtures/` is preferred over `fixtures/`, defaulting to `atrezzo/fixtures/` if neither exists. `serve` keeps using the same resolved fixtures directory across `POST /__atrezzo/reload` and `POST /__atrezzo/reset`, and `doctor` accepts matching `--scenarios`/`--fixtures` flags to validate effective scenario and fixture paths.

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
- No `Authorization` header semantics: the mock does not read `Authorization`. Use `auth: { user: { entity, id } }` with `filters: { id: "$user.id" }` to bind `/api/user` or `/api/me` to a specific seeded user; without `auth` (or `$user.id`), the current user is whichever row the query filters and `sort` pick.

##### Wrapped singletons (`wrap`)

Some APIs (such as Conduit / RealWorld) wrap every singleton object under a single key (`{ "article": {…} }`, `{ "user": {…} }`) instead of returning the raw row. Add `wrap: <key>` alongside `shape: object`:

```yaml
endpoints:
  - path: /api/articles/:slug
    entity: articles
    include: [authors]
    shape: object
    wrap: article                 # → 200 { "article": { "id": 1, "slug": "…", "author": {…} } }
  - path: /api/user
    entity: users
    shape: object
    wrap: user                    # → 200 { "user": { "id": 1, "name": "…", "email": "…" } }
```

- **Without `wrap`**: the response stays the raw row (`{ "id": 1, … }`) and scenario hashes are unchanged.
- **404s unchanged**: empty entities (`atrezzo.miss: true`) and unmatched filters keep their exact 404 bodies (never wrapped).
- **Detail route and relations**: when `detail: true`, the derived `/:id` route wraps under the same key (`{ "user": <row> }`), and `include`, `embed` and `counts` stay inside the wrapped row.
- **Validation (scenario error)**: `wrap` requires `shape: "object"`, must match `/^[A-Za-z_][A-Za-z0-9_]*$/`, and is incompatible with `pick`, `envelope`, `pluck` and `pagination`.

#### Latency (`latency:` and `serve --latency`)

A mock that answers in 1 ms can expose races a real backend (100-300 ms) hides, or hide timing bugs the real one shows. `atrezzo serve --latency <ms>` (default `0`) delays every contract response; an endpoint's `latency:` wins over the flag for that endpoint (list and detail route):

```yaml
endpoints:
  - path: /api/v2/info
    entity: info
    shape: object
    latency: 800                  # the app's boot request arrives late, as against the real API
  - path: /api/v2/cabinets
    entity: cabinets              # waits whatever `serve --latency` says (0 by default)
```

- Integer milliseconds, `0`–`60000`. Applies to answers of contract endpoints (including their 400/404s); static files (`--static`), `/__atrezzo/*` control routes and gaps for undeclared routes answer immediately, so a slow mock does not make the harness crawl.
- The serve banner prints the effective latency and each override; `GET /__atrezzo/state` returns it as `latency: { default, endpoints: { path: ms } }`.
- Only `serve` waits: the MSW handlers ignore `latency` (wrap them with MSW's own `delay()` if you need it there). The data never changes with the latency.

Projection semantics (identical in `serve` and the MSW handlers, same `runtime.mjs` file):
1. Scopes (`scopes`), world-resolved filters (`{ from, where }`) and query equality filters; a comma means any of the values; `null` matches nulls.
2. Sorted by `sorts` query parameters when declared and sent (else the endpoint's `sort`), nulls last, ties broken by original position (stable).
3. `X-Total-Count` = total after filters, before pagination.
4. `limit` above the total ⇒ everything; out-of-range `offset` ⇒ `[]`; non-integer values ⇒ 400.
5. Undeclared parameters are ignored and listed in `X-Atrezzo-Ignored`.
6. Undeclared writes (`POST`/`PUT`/`PATCH`/`DELETE` not listed under `writes:`) ⇒ 405 on endpoint routes (or 404 elsewhere). `POST /rpc/<fn>` and `/rest/v1/rpc/<fn>` are PostgREST functions, answered from `rpc:`.

### Writes (`writes`)

When a screen depends on a form submit or mutation (`POST`, `PUT`, `PATCH`, `DELETE`), declare a root `writes` map in the scenario so both `atrezzo serve` and the generated MSW handlers mutate the in-memory world and reflect changes on subsequent reads in the same server session:

```yaml
writes:
  "POST /api/orders":
    expect: { status: 201, echo: true }
    mutate: { entity: orders, set: { status: "nuevo" } }
  "PATCH /api/orders/:id":
    expect: { status: 200, echo: true }
    mutate: { entity: orders, set: { status: "enviado" } }
  "DELETE /api/orders/:id":
    expect: { status: 204 }
    mutate: { entity: orders }
```

- **Integrity on writes**: deleting a row that has children in the world answers `409 { error: "cannot delete <entity>#<id>: N rows of "<child>" point at it (<fk>); delete them first" }`, and creating or updating a row with a foreign key that does not exist answers `422 { error: "<entity>.<fk>=… does not exist in <target>" }`. A foreign key sent as a string (`"1"`) is stored with the type of the target's ids (`1`). A `POST` without the foreign key stores `null` when the world already has nulls in that key (`nulls:`), and otherwise answers `422 { error: "<entity>.<fk> is required: …" }`. There is no implicit cascade: if you want cascading deletes, declare the children's DELETEs in the flow.
- **Route keys**: must be `"<METHOD> /path"` with an explicit HTTP method (`POST`, `PUT`, `PATCH`, `DELETE`) and a path starting with `/` (no query or fragment). Path parameters (`:id`, `:customer_id`, etc.) bind to fields of `mutate.entity` (`:id` at the end of a path or before an action segment binds to `id`; `:<entity>_id` binds to `id` for the target entity; other `:name` segments match `name` or `<name>_id`).
- **`expect`**: `{ status, echo, body }` (optional; defaults to `201` + `echo: true` for `POST`, `204` for `DELETE`, `200` + `echo: true` for `PUT`/`PATCH`):
  - `status`: integer HTTP status `200..599`.
  - `echo: true`: echoes the created/updated row (or deleted row / request payload when no `mutate` is given). Mutually exclusive with `body` and with `204`/`205`/`304`.
  - `body`: static JSON value returned verbatim.
- **`mutate`**: `{ entity, action, set, where }`, or `false` for an explicitly stateless response. When omitted, the entity is **inferred** if the route is a contract endpoint (see below); otherwise the answer is stateless:
  - `entity` (required): declared entity in `world`.
  - `action`: `'create' | 'update' | 'delete'` (defaults to `create` for `POST`, `update` for `PUT`/`PATCH`, `delete` for `DELETE`).
  - `set` (for `create` and `update`): map `<field>: <scalar | "$user.<field>">` of existing fields of `entity` (`id` cannot be set). Values in `set` override incoming request body fields.
  - `where` (for `update` and `delete`): map `<field>: <scalar | [scalars] | "$user.<field>">` to select target rows alongside any bound path parameters (404 when no row matches).
- **Inferred `mutate`**: a write without `mutate` whose route is a GET endpoint of the contract behaves as `mutate: { entity: <that endpoint's entity> }` with the default action for its method. This covers `POST <endpoint>` (create; not on `shape: object`), `PUT`/`PATCH`/`DELETE <endpoint>/:param` (update/delete through the detail route; needs `detail` on) and `PUT`/`PATCH <endpoint>` on a `shape: object` endpoint (update its row). Parameters compare by position (`:id` matches `:post_id`). Inference needs every path parameter to bind to a field of the entity. It never applies to endpoints with `pluck`, `error` or `passthrough`, or to routes that are not endpoints (`POST /api/login`, `POST /api/posts/:id/archive`): those stay stateless. The `serve` banner marks these rules `inferred from GET <path>`. Use `mutate: false` to keep an endpoint write stateless.

  ```yaml
  writes:
    "POST /api/posts":                    # explicit: creates with kind = archived
      expect: { status: 201, echo: true }
      mutate: { entity: posts, set: { kind: archived } }
    "DELETE /api/posts/:id":              # inferred: deletes from posts (GET /api/posts)
      expect: { status: 204 }
    "POST /api/posts/:id/preview":        # not an endpoint route: stateless
      expect: { status: 200, body: { ok: true } }
    "PUT /api/posts/:id":                 # endpoint route, explicitly stateless
      expect: { status: 200 }
      mutate: false
  ```
- **Response body**: `expect.body` when declared, else the resulting row(s) with `echo: true`, else `{}` (no body for `204`/`205`/`304`). In `serve`, an undeclared method on a contract route answers `405` with `Allow` and an unknown route answers `404`. Both are recorded as gaps, and their `atrezzo` payload lists `endpoints` and the declared `writes`.
- **Determinism**: no `Math.random()` or wall clock is used. Each entity assigns sequential integer `id`s independently (`maxId + 1`), mutated rows keep only declared entity schema fields in canonical schema order (formatted like reads when a GET endpoint exists, ignoring unknown request fields), stateless `echo: true` sorts payload keys deterministically, and `GET` projections preserve deterministic sort order across mutations.
- **Session & reset**: `serve` and MSW handlers keep mutations in memory across subsequent reads in the same session (`embed` and `counts` indexes are invalidated automatically). `POST /__atrezzo/reset` (in both `serve` and MSW handlers, plus `reset()` exported from `<scenario>.handlers.mjs`) restores the world and ID counters to their initial seeded state.
- **Validation (scenario error, exit 3)**: rejects empty `writes`, route keys without an explicit `POST`/`PUT`/`PATCH`/`DELETE` method, duplicate write routes, unknown `mutate.entity`, unknown fields in `set`/`where`, `id` in `set`, unbound `:param` segments, `set` on `delete`, `where` on `create`, and `echo: true`/`body` with `204`. Scenarios without `writes` keep their exact behaviour and hash.

### PostgREST functions (`rpc`)

When a screen calls a database function through PostgREST (`supabase.rpc('fn', args)` ⇒ `POST /rest/v1/rpc/fn`), declare a root `rpc` map with the function name and its answer:

```yaml
rpc:
  is_feature_on:                       # any arguments, always true
    expect: { status: 200 }
    body: true
  feature_settings:                    # only this argument set; anything else is 400
    body: { mode: compact, limit: 5 }
    match: { feature: beta, level: 2 }
  touch_session:                       # no response body
    expect: { status: 204 }
```

- **Keys**: the bare function name (letters, digits and `_`, not starting with a digit). The route is not part of the scenario: `serve` and the MSW handlers answer both `POST /rpc/<fn>` and `POST /rest/v1/rpc/<fn>`, whichever prefix the client adds. Other prefixes (`/api/rpc/<fn>`) are not PostgREST routes and are left alone.
- **`expect`**: `{ status }` (optional, default `200`; integer `200..599`).
- **`body`**: JSON value answered verbatim (`true`, a number, an object, a list, `null`). Absent ⇒ JSON `null`, or no body on `204`/`205`/`304`. The answer is static: it does not read or change the world.
- **`match`** (optional): `{ <argument>: <value> }`. Without it the request body is ignored. With it, every listed argument must arrive in the JSON body with exactly that value (compared as JSON, so `"2"` is not `2`), otherwise `400` with `message` naming the first mismatched argument and `atrezzo: { rpc, match }`. Arguments the scenario does not list are ignored.
- **Undeclared function**: `POST /rest/v1/rpc/<other>` answers `404` with `code: "PGRST202"` and the usual gap payload (`atrezzo.miss`, `atrezzo.gap`, plus the declared functions under `atrezzo.rpc`), and `serve` records it in `atrezzo misses` with the hint to declare it under `rpc:`. This holds even when the scenario has no `rpc` block. `serve --on-miss stub` answers `200 {}` instead, as for any gap.
- **Methods**: functions answer `POST`. Another method on a declared function answers `405` with `Allow: POST`.
- **MSW**: the generated handlers register one `http.post('*/rpc/:fn', …)` that runs the same engine, so the answers, the `400` and the `404` are identical to `serve`. `GET /__atrezzo/state` lists declared functions under `rpc`.
- **Validation (scenario error, exit 3)**: rejects an empty `rpc`, invalid function names, unknown fields, a status outside `200..599`, `body` with `204`/`205`/`304`, an empty or non-map `match`, and a function also declared as a `POST /rpc/<fn>` or `POST /rest/v1/rpc/<fn>` write. Scenarios without `rpc` keep their exact behaviour and hash.

### Streams (`streams`)

When a screen connects to a Server-Sent Events (SSE) feed after loading REST data (status ticks, progress events), declare a root `streams` map in the scenario:

```yaml
streams:
  "/api/ticks":
    interval: 1000
    events:
      - { seq: 1, status: "running" }
      - { seq: 2, status: "done" }
    loop: true
```

- **Route keys**: paths starting with `/` (no whitespace, query or fragment; trailing slashes normalized). Must not collide with any `endpoints` route (including `/:id` detail routes unless `detail: false` is set on the endpoint).
- **`interval`** (required): integer between `1` and `2147483647` (milliseconds, Node.js `setTimeout` limit) between emitted events.
- **`events`** (required): non-empty list of JSON values. Each event is serialized as `data: <json>\n\n`.
- **`loop`** (optional, default `false`): when `true`, cycles back to the first event after the last; when `false`, closes the HTTP stream cleanly after emitting all declared events once.
- **Runtime & lifecycle**: `atrezzo serve` answers `200` with `Content-Type: text/event-stream`, flushes headers immediately, emits each event in order at `interval`, and closes active streams cleanly (clearing timers and ending the response) on client disconnect, `POST /__atrezzo/reset`, `POST /__atrezzo/reload`, or server shutdown. `GET /__atrezzo/state` lists declared streams under `streams`.
- **Validation (scenario error, exit 3)**: rejects empty `streams`, invalid or duplicate paths, paths colliding with `endpoints` (list, parameterized, or `/:id` detail routes), `interval <= 0`, `interval > 2147483647`, non-integer `interval`, empty or missing `events`, non-boolean `loop`, and unknown fields. Scenarios without `streams` keep their exact behaviour and hash.

### Counted relations (PostgREST `select` and `head=true`)

A relation is declared once, with `ref:` on the child (`items: { total: 6, ref: cabinets }` ⇒ every item carries `cabinet_id`). Two PostgREST shapes read it:

- **Embedded count**: `GET /rest/v1/cabinets?select=*,items(count)` adds `"items": [{ "count": n }]` to every returned row (list and detail), where `n` is the number of `items` rows in the same world whose `cabinet_id` is that row's `id`. Several at once (`select=*,items(count),tags(count)`) and aliased (`select=*,total:items(count)` ⇒ `"total": [{ "count": n }]`) work too. The count always matches `GET /rest/v1/items?cabinet_id=<id>` on an endpoint that declares that filter.
- **Count only**: `?head=true` (with or without `Prefer: count=exact`), or a `HEAD` request with `Prefer: count=exact`, answers `200` with an empty body and `Content-Range: 0-<n-1>/<n>`, where `n` counts the rows that pass the endpoint's filters (pagination does not apply). No rows ⇒ `Content-Range: 0-0/0`.

Not supported: only the exact `child(count)` item is a count; any other embed (`items(id,name)`, `items(*)`, `customer:customers(*)`) and column lists (`select=id,name`) are ignored, rows keep their shape and `select` shows up in `X-Atrezzo-Ignored`. A name that is no entity, or an entity that does not `ref:` this endpoint's entity, adds nothing. Filters keep the engine's equality syntax (`?cabinet_id=2`); PostgREST operators such as `eq.2` are not parsed. The MSW handlers register `GET` routes only, so there a count goes through `head=true`, not a `HEAD` request.

### Static files and the SPA fallback (`serve --static <dir>`)

`serve --static dist` serves the built front end next to the projections. A single-page app routes on the client, so a deep link such as `/orders/42` has no file in `dist/`: for those, `serve` answers `200` with `dist/index.html` and the app's router takes over. The fallback applies only when **all** of these hold:

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
- Writes (`POST`/`PUT`/`PATCH`/`DELETE`): declare them under `writes:` to mutate the in-memory world; undeclared writes return 405/404 (`serve --on-miss stub` answers 200 `{}` for exploring).

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
| `data.pick` | non-empty path to the array (`data.items`); default: root array or `data` (or `envelope.items`). Blank/whitespace-only `data.pick` is rejected (exit 3); an explicit pick absent from a 200 response (or on a non-object body) is KO, never falls back to another key, and skips the full-set probe |
| `label` | text for the report |

With `--driver http` an assertion without `data` stays **not verified** (exit 2), never OK.

## Flow file (`flow.yaml`)

```yaml
scenario: scenarios/orders.yaml      # relative to the flow (optional: see "Real app" below)
base_url: http://127.0.0.1:4010       # optional (otherwise --url or the config)
viewport: { width: 1440, height: 1000 }  # optional, playwright only (default 1280x720)
click_timeout: 5000                   # optional, playwright only: ms to wait per click target (default 5000)
clock: { time: 2025-06-01T10:00:00Z }  # optional, playwright only: el reloj del navegador antes de navegar
headers:                              # optional: sent on EVERY request of the flow
  X-Tenant: acme                      # only values safe to commit; a session goes in verify --header
storage:                              # optional, playwright only: seeded before the page loads
  local:   { "sb-127-auth-token": "{\"access_token\":\"…\"}" }
  session: { some-key: value }
steps:
  - screen: order-list
    visit: /orders                    # route for playwright
    redirects_to: /login              # optional: expect a redirect to /login (or allow_redirect: true)
    headers: { Accept-Language: en-GB }  # optional; merged with the flow headers
    storage: { local: { theme: dark } }  # optional; merged with the flow storage, the step wins
    wait_for: "[data-testid=ready]"   # optional; waits for the element to exist (not to be visible)
    click: "[data-testid=expand]"     # optional, playwright only: selector (or list of selectors) clicked before expect
    click_timeout: 3000               # optional, playwright only: overrides flow click_timeout for this step
    clock: { time: scenario }         # optional: overrides the flow clock; "scenario" = el now del escenario
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

What the runtime detects decides how sure that hypothesis is:

- **Route mismatch or main-document HTTP ≥ 400** (an undeclared redirect, a `redirects_to` that did not match, a 404 on the page itself): `navigation` is `confirmed`, and the scenario and selectors are not the cause. The route check compares the final URL's origin and path with `visit`, or with `redirects_to` (plus its query and hash when it declares them); `allow_redirect` accepts any route. The status is the one of the main document, not of the app's API calls.
- **Only `wait_for` timed out** (`wait_for` is waited for after those checks found nothing): the step is still KO, but the timeout only shows that the selector never appeared. `navigation` is `possible`, with `finding` = the timeout and no uncaught `pageerror` captured; it does not rule out the scenario or the selectors (a render error the framework caught and logged, a failed API call, or a wrong `wait_for` selector fit the same symptom). With `--strict-console`, any `console.error` of the step is also reported as `console-error` (`confirmed`).

#### Expected redirects (`redirects_to` and `allow_redirect`)

When a flow step intentionally verifies an auth guard or a route redirect, declare it on the step:

- `redirects_to: /login` (a path starting with `/` or an `http(s)://` URL): `verify` expects `visit` to land on that route. `wait_for` and `expect` are evaluated against the destination screen, and the step is OK if the final URL matches and the assertions pass. When `redirects_to` omits query parameters (`/login`), extra query parameters such as `/login?next=%2Forders` still match; if `redirects_to` specifies query parameters, they must match as well. Staying on `visit` or redirecting elsewhere is KO.
- `allow_redirect: true`: allows any redirect (as well as staying on `visit`) and evaluates `wait_for` and `expect` on whichever screen the browser lands on. Mutually exclusive with `redirects_to`.
- Without either field, behaviour is unchanged: any redirect is KO with the unexpected-redirect notice.
- With `--json`, each step in `steps` that redirected includes `redirect: { from, to, declared }`, where `declared` is `true` for a matching declared redirect and `false` otherwise.

#### Browser console and uncaught exceptions (`pageerror` / `--strict-console`)

Under `--driver playwright`, `verify` listens for `pageerror` (uncaught runtime exceptions and unhandled rejections) and `console.error` throughout each step's page load and assertion checks:

- **Uncaught exceptions (`pageerror`)**: any uncaught exception marks every assertion of the step `KO` (even if its selector counts happen to match, so a blank-screen crash or error toast never produces a false `OK`), records the message (clipped to 300 characters) in the failure note, and under `--diagnose` emits a `page-error` hypothesis (`certainty: confirmed`) with the clipped message. If `wait_for` timed out on a crashed page, `page-error` is surfaced instead of `navigation`.
- **Console errors (`console.error`)**: by default, `console.error` entries are emitted as `WARNING:` lines in the report without breaking a step whose assertions pass. Pass `--strict-console` (requires `--driver playwright`; rejected with exit `3` under `--driver http`) to fail (`KO`) any step that emits `console.error` (with a `console-error` hypothesis under `--diagnose`).
- **`--json` output**: each Playwright step in `steps` includes `console: [{ level, text }]`, where `level` is `'pageerror'` for uncaught exceptions or `'error'` for `console.error` (or `[]` when none occurred).

#### Reloj del navegador (`clock`)

Un contador del tipo «quedan 3 días» o un plazo que vence a medianoche depende de `Date` en el navegador, y sin fijarlo el flujo cambia de resultado según el día en que se ejecute (y un test que pasa hoy falla el mes que viene). `clock: { time: <ISO> }` llama a `page.clock.install()` **antes** de la primera navegación, así que todo lo que la app mida con `Date`/`setTimeout` sale del reloj fijado.

- Se declara en el flujo (vale para todos los pasos) o en un paso concreto (lo sobrescribe).
- `time: scenario` usa el `now` del escenario: la fecha de los datos y la del navegador son la misma, que es lo que hace coherente «caduca en 3 días».
- Con `--driver http` no hay navegador y la clave se ignora.
- Playwright instala el reloj una sola vez por página; los pasos siguientes con otra hora usan `setFixedTime`.
#### Pre-assertion interactions (`click` and `click_timeout`)

When content lives inside a collapsed accordion, tab, or disclosure that must be opened before `expect` measures the DOM, declare `click` on the step (`--driver playwright` only):

- **`click: "<selector>"`** (CSS selector or Playwright text selector such as `text=Show details`): waits for the element to exist (`attached`), performs a real Playwright click, and then evaluates the step's `expect` assertions.
- **Multiple clicks in order**: `click: [sel1, sel2]` clicks each target sequentially before `expect` runs. Clicks do not create extra steps: the step remains the same (one entry in `steps`) and all `expect` assertions are measured afterwards.
- **Timeout (`click_timeout`)**: configurable in milliseconds on the step (`click_timeout: 2000`), at the flow root, or via `verify --click-timeout <ms>` (default `5000` ms / `5 s`; step overrides CLI, which overrides flow root). If any target does not appear or cannot be clicked within the timeout, every assertion of the step is marked `KO` and `--diagnose` emits `click-target-missing` (`certainty: confirmed`).
- **`http` driver**: `click:` is ignored with a `WARNING:` line (there is no browser to click in).

## Supported YAML subset

Block maps and lists (spaces only), single-line `{…}` and `[…]` collections, single and double quotes, `null`/`~`, booleans, numbers, `|` and `>` blocks, comments. Anchors, aliases, tags and multiple documents are rejected: the parser says so with a line number.

## Exit codes
`0` OK · `1` assertion failed · `2` not verifiable (no mock, playwright/Chromium or `data`) · `3` invalid input.
