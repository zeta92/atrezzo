---
name: atrezzo-escena
description: Crea un escenario atrezzo desde una intención ("12 filas, 3 con incidencia"). Úsalo cuando el usuario describa un estado de pantalla que quiere ver o probar (vacío, con errores, paginado, muchos datos) y haya que traducirlo a mundo + aserciones versionadas.
---

# /atrezzo:atrezzo-escena

Traduce la intención a `world` + `endpoints` + `path` + `expect`. Formato: `${CLAUDE_PLUGIN_ROOT}/references/escenario.md`.

1. Extrae los números de la intención y conviértelos en conteos y distribuciones exactas: "40 pedidos, 3 con incidencia" ⇒ `pedidos: { total: 40, distribucion: { pagado: 34, pendiente: 3, incidencia: 3 } }`. Las sumas deben cuadrar con `total`.
2. Decide qué ve la pantalla (proyección): ¿pagina?, ¿filtra?, ¿ordena? Eso va en `endpoints`, no en los datos. Si "12 filas" es la primera página, la aserción es sobre `?limit=12`.
3. Fija `seed` (cualquier entero) y `now` (fecha ISO). Cambiar la semilla cambia los datos, nunca los conteos.
4. Escribe `expect` con `selector` + `count` (o `min`/`max`) y `data: { request, where }` para que `verify --driver http` pueda comprobarlo sin navegador.
5. Para probar suposiciones del cliente usa `nulos: { campo: n }` o un escenario aparte (ver `${CLAUDE_PLUGIN_ROOT}/references/suposiciones.md`).
6. Guarda en `atrezzo/escenarios/<nombre>.yaml` y genera: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs world atrezzo/escenarios/<nombre>.yaml`. Revisa el resumen impreso (conteos, endpoints) y commitea YAML + `.generated/`.

**Prohibido** escribir a mano el JSON de datos, editar `.generated/` o pegar ids en el YAML: si necesitas otra forma de datos, cambia la distribución, `valores:` o `nulos:` y regenera.
