# Example: shop (tienda)

A minimal static app (`index.html`) that renders customers, issues and the 12 most recent orders from `/api/*`. Two scenarios: `pedidos` (3 customers, 40 orders, 3 issues) and `vacio` (1 customer, 0 orders).

The data uses atrezzo's built-in `clientes`/`pedidos` templates, so field names and values stay in Spanish (`estado: incidencia`, `importe`): they are the API keys this demo backend would return.

```bash
cd examples/tienda
node ../../scripts/cli.mjs world escenarios/pedidos.yaml     # generates atrezzo/.generated/
node ../../scripts/cli.mjs serve &                          # http://127.0.0.1:4010 (also serves index.html)
node ../../scripts/cli.mjs verify flujo.yaml --driver http  # green, exit 0
node ../../scripts/cli.mjs verify flujo-roto.yaml --diagnose  # red on purpose: pagination mismatch
curl -X POST localhost:4010/__atrezzo/reset -d '{"scenario":"vacio"}'
```

With `playwright` or `playwright-core` installed (in this repo: `npm i -D playwright-core`, uses `/usr/bin/chromium` or `ATREZZO_CHROME`), `verify flujo.yaml --driver playwright` counts in the real DOM.

### Headers (apps with a session)

This shop has no login, but a flow can declare headers to authenticate against a real app (cookie session, bearer token…):

```yaml
viewport: { width: 1440, height: 1000 }
headers:                          # every request in the flow
  Cookie: "${APP_COOKIE}"         # from the environment: APP_COOKIE="$(cat /tmp/cookie.txt)" atrezzo verify …
steps:
  - screen: clientes
    visit: /clientes
    headers: { Accept-Language: es-ES }   # merged with the flow headers; the step wins
    wait_for: "table tbody tr"
    expect:
      - selector: "table tbody tr"
        count: 6
```

`Cookie` and `Authorization` print as `***` in the report. If the app redirects to `/login` (missing or expired session), the step fails with the reason, never green.
