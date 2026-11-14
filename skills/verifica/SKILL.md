---
name: verifica
description: Verifica una pantalla contra un escenario atrezzo y diagnostica fallos. Úsalo cuando el usuario quiera comprobar que una pantalla pinta lo esperado, cuando "no salen las filas" o "faltan badges", o antes de dar por bueno un cambio que afecta a datos mostrados.
---

# /atrezzo:verifica

CLI: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs` (abajo `atrezzo`).

1. `atrezzo world <escenario.yaml>` si `doctor` dice "desactualizado".
2. Sirve en segundo plano: `atrezzo serve --escenario <nombre> [--static <dir>]`. Si la app corre en su propio dev server, apunta su API a `mock.baseUrl` (o usa los handlers MSW generados).
3. Verifica: `atrezzo verify <flujo.yaml> --driver http` (datos) y, si hay `playwright` o `playwright-core`, `--driver playwright` (DOM real; `headers` en el flujo para apps con sesión, `${VAR}` para no commitear secretos). `verify` hace `reset` al escenario del flujo antes de empezar.
4. Lee el código de salida: `0` verde · `1` alguna aserción KO · `2` no verificable (sin mock, sin playwright, aserción sin `data`) · `3` flujo/escenario inválido. **Un 2 nunca es un OK**: dilo así.
5. Si hay KO: `atrezzo verify <flujo.yaml> --diagnose` y razona sobre las hipótesis **antes** de tocar el escenario:
   - `render` / `filtro-en-cliente`: el mock entrega lo esperado; el fallo está en la pantalla. No toques el escenario.
   - `paginacion-desalineada`: el dato existe fuera de la página; revisa `limit`/`offset`/`sort` del cliente o del endpoint.
   - `deduplicacion-por-id`, `campo-nulo`: suposición del cliente; ver `${CLAUDE_PLUGIN_ROOT}/references/suposiciones.md`.
   - `filtro-no-declarado`: el cliente filtra por un parámetro que el contrato no tiene.
   - `mundo-distinto`: solo entonces corrige `world` o la aserción.
6. Nunca regeneres con otra semilla para "hacer que pase". Informa: tabla, hipótesis elegida, evidencia y el cambio propuesto.
