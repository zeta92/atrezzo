# Example: shop (tienda)

A minimal static app (`index.html`) that renders customers, issues and the 12 most recent orders from `/api/*`. Two scenarios: `orders` (3 customers, 40 orders, 3 issues) and `empty` (1 customer, 0 orders).

Both scenarios declare `fields` for every entity, so the API returns exactly the keys listed there (`name`, `reference`, `status: issue`, `amount`, plus `id` and the foreign key `customer_id`) rather than the full built-in templates. The page joins each order to its customer through `customer_id`.

`atrezzo/.generated/` is not committed in this example. `serve` does not need it (it reads the scenario YAML and builds the world in memory), but run `world` first anyway: it writes the JSON, `runtime.mjs` and the MSW handlers, and `serve` reports them as `up to date` instead of `not generated`.

```bash
cd examples/tienda
node ../../scripts/cli.mjs world scenarios/orders.yaml      # generates atrezzo/.generated/
node ../../scripts/cli.mjs world scenarios/empty.yaml
node ../../scripts/cli.mjs serve --scenario orders &        # http://127.0.0.1:4010 (also serves index.html)
node ../../scripts/cli.mjs verify flow.yaml --driver http  # green, exit 0
node ../../scripts/cli.mjs verify flow-broken.yaml --diagnose  # red on purpose: pagination-mismatch
curl -X POST localhost:4010/__atrezzo/reset -d '{"scenario":"empty"}'
```

With `playwright` or `playwright-core` available in the project (system Chromium, or `ATREZZO_CHROME`), `verify flow.yaml --driver playwright` counts in the real DOM.

### Headers

This shop needs none, but a flow can declare headers for every request and per step (format in `references/scenario.md`). Secret-looking header values print as `***` in the report. If the app redirects to `/login` (missing or expired session), the step fails with the reason, never green.
