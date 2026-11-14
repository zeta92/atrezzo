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

Con `playwright` instalado: `verify flujo.yaml --driver playwright` cuenta en el DOM real.
