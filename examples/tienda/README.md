# Ejemplo: tienda

App estática mínima (`index.html`) que pinta clientes, incidencias y los 12 pedidos más recientes desde `/api/*`. Dos escenarios: `pedidos` (3 clientes, 40 pedidos, 3 incidencias) y `vacio` (1 cliente, 0 pedidos).

```bash
cd examples/tienda
node ../../scripts/cli.mjs world escenarios/pedidos.yaml     # genera atrezzo/.generated/
node ../../scripts/cli.mjs serve &                          # http://127.0.0.1:4010 (sirve también index.html)
node ../../scripts/cli.mjs verify flujo.yaml --driver http  # verde, exit 0
node ../../scripts/cli.mjs verify flujo-roto.yaml --diagnose  # rojo a propósito: paginación desalineada
curl -X POST localhost:4010/__atrezzo/reset -d '{"escenario":"vacio"}'
```

Con `playwright` o `playwright-core` instalado (en este repo: `npm i -D playwright-core`, usa `/usr/bin/chromium` o `ATREZZO_CHROME`): `verify flujo.yaml --driver playwright` cuenta en el DOM real.

### Cabeceras (apps con sesión)

Esta tienda no tiene login, pero un flujo puede declarar cabeceras para autenticarse contra una app real (sesión por cookie, bearer…):

```yaml
viewport: { width: 1440, height: 1000 }
headers:                          # todas las peticiones del flujo
  Cookie: "${APP_COOKIE}"         # desde el entorno: APP_COOKIE="$(cat /tmp/cookie.txt)" atrezzo verify …
steps:
  - screen: clientes
    visit: /clientes
    headers: { Accept-Language: es-ES }   # se mezclan con las del flujo; gana el paso
    wait_for: "table tbody tr"
    expect:
      - selector: "table tbody tr"
        count: 6
```

`Cookie` y `Authorization` salen como `***` en el informe. Si la app redirige a `/login` (sesión ausente o caducada), el paso sale KO con el motivo, nunca verde.
