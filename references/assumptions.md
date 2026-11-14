# Promised schema vs. assumed client

A mock that only satisfies the schema lets screens pass that will break in production. The dangerous gap is not "the schema is wrong" but **what the client takes for granted that the schema does not guarantee**. This document is the method to find it and turn it into scenarios.

## Three sources, three truths

| source | says | example |
|---|---|---|
| Contract (OpenAPI, types, migrations) | what the server **promises** | `email: string \| null` |
| Traffic (HAR) | what the server **usually does** | `null` never showed up in the HAR |
| Client code | what the client **assumes** | `user.email.toLowerCase()` |

A gap is a field where the client assumes more than the contract promises. Traffic does not close the gap: it only explains why nobody has seen it yet.

## Method

1. **Read inventory**: per screen, list the fields the client reads from the JSON. With scripts, not by eye:
   ```bash
   grep -rnoE '\b(order|item|row|customer|user)\??\.[a-zA-Z_]+(\??\.[a-zA-Z_]+)*' src | sort | uniq -c | sort -rn | head -80
   ```
2. **For each read, look for the guarantee** in the contract: required? nullable? closed enum? minItems? format/precision?
3. **Look for the guard in the client**: `?.`, `?? value`, `if (x)`, `.length ?`, `default:` in the switch, `toFixed` with explicit rounding.
4. **Classify** each read in the matrix below.
5. **Turn each red cell into a scenario** (or into `nulls:` on an existing one) with its assertion. Write the gap into the scenario as a comment: `# gap: customer.email can be null and the row uses it unguarded`.

## Patterns to look for

| pattern | signal in the code | what the schema does not guarantee | scenario that exposes it |
|---|---|---|---|
| Unguarded null field | `x.field.method()`, `x.field.length`, a `{x.field}` template that renders "null" | `nullable: true` or a non-`required` field | `nulls: { field: 1 }` + row assertion |
| Array assumed non-empty | `items[0].`, `reduce` without an initial value, `Math.max(...arr)` | no `minItems: 1` | entity with `total: 0` (empty state) |
| Closed enum | `switch` without `default`, an `ICONS[status]` map with no fallback, `'a' \| 'b'` types | open enum or free string | `distribution` with a new value (`under_review: 1`) |
| Rounding | client-side sums of amounts, `toFixed(2)` after summing, `===` on decimals | precision, currency, decimal vs. float | `amount` with a range that forces cents; assertion on the rendered total |
| Id uniqueness | `key={id}`, dedupe with a `Map` | unique ids per page/across pages | paginate with a small `limit` and compare with `X-Total-Count` |
| Implicit order | "the first one is the most recent" without `sort` in the request | unspecified order | a different `sort:` on the endpoint |
| Full page | "fewer than limit means no more" | exact page size | `total` an exact multiple of `limit` |
| Relation always present | `order.customer.name` | nullable fk / optional join | `nulls: { customer_id: 1 }` with `include` |

## Schema-valid × client-assumed matrix

|  | **The client guards it** (guard, fallback, default) | **The client assumes it** (no guard) |
|---|---|---|
| **The schema guarantees it** (required, minItems, closed enum) | OK. Redundant guard; no scenario needed. | OK as long as the contract holds. Contract scenario: if the backend changes, `captura` detects it. |
| **The schema does not guarantee it** (nullable, optional, open enum) | OK. A regression scenario so the guard does not get lost. | **GAP.** A mandatory scenario that triggers it + an assertion. Decide: guard in the client or guarantee in the contract. |

Only the bottom-right cell is a latent bug. The rest is documentation.

## What atrezzo does not do here

atrezzo does not "fix" the assumption by making the mock never return `null`: that hides the gap. Nor does it apply business rules to manufacture consistency (e.g. recomputing a total): if the screen depends on a business rule, that rule lives in the backend and is tested there. The mock produces the states the schema allows; verification shows what the screen does with them.

## How `verify --diagnose` uses it

The `null-field`, `dedupe-by-id`, `pagination-mismatch` and `client-side-filter` hypotheses are the cells of this matrix seen from the symptom (missing rows). When they show up, come back here and classify the field before changing anything.
