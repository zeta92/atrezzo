---
name: desde-intencion
description: Planifica estados atrezzo para ir de una pantalla X a un objetivo Y. Úsalo cuando el usuario describa un recorrido ("estoy en el dashboard y quiero conciliar las incidencias") y haya que derivar la ruta de pantallas, un escenario por paso y los huecos de cobertura.
---

# /atrezzo:desde-intencion

1. Reformula la intención como `origen → objetivo` y pregunta solo lo que bloquee (rol del usuario, datos mínimos).
2. Deriva la **ruta de estados**: lista de pantallas con el estado de datos que cada una necesita para avanzar (p. ej. `dashboard (hay incidencias) → lista-pedidos (filtro incidencia) → conciliacion (pedido con cliente)`). Ese es el `path` del escenario y `entry` su primera pantalla.
3. Para cada paso decide si basta **un mundo** compartido (mismo escenario, distintas proyecciones) o hace falta **otro escenario** (estado vacío, error, límite). Prefiere un mundo; crea escenarios extra solo para estados excluyentes.
4. Crea los escenarios con `/atrezzo:escena` (formato en `${CLAUDE_PLUGIN_ROOT}/references/escenario.md`) y un `flujo.yaml` con un paso por pantalla (`screen`, `visit`, `requests`, `expect`).
5. Lista los **huecos de cobertura**: estados que el recorrido toca y ningún escenario cubre — vacío, un solo elemento, página exacta (n = limit), nulos en campos leídos, enums nuevos, errores 4xx/5xx (fuera del mock; anótalos). Usa la matriz de `${CLAUDE_PLUGIN_ROOT}/references/suposiciones.md`.
6. Cierra con `/atrezzo:verifica` sobre el flujo y entrega: ruta, escenarios creados, resultado de verify y huecos pendientes.
