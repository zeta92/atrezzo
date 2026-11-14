---
name: atrezzo
description: Mocks de API desde estados de app (mundo + escenario). Úsalo cuando el usuario pida mocks, fixtures, datos de prueba o "simular la API" para una pantalla o flujo, quiera reproducir un estado concreto ("12 filas, 3 con incidencia"), o verificar que una pantalla pinta lo que debe. Decide qué skill de atrezzo aplicar.
---

# atrezzo — router

atrezzo genera mocks de API a partir de **estados de aplicación**, no de endpoints sueltos. Un **mundo** (grafo de entidades con semilla) se **proyecta** en cada endpoint; un **escenario** versionado fija mundo + ruta de pantallas + aserciones; la salida es código commiteable.

CLI: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs <comando>` (en adelante `atrezzo`).

## Elige la skill

| El usuario dice… | Usa |
|---|---|
| "monta atrezzo", "configura mocks en este repo", no existe `atrezzo.config.json` | `/atrezzo:init` |
| "saca el contrato", "tengo un OpenAPI/HAR", "qué devuelve la API" | `/atrezzo:captura` |
| "quiero 12 pedidos, 3 con incidencia", "un estado vacío", "datos para esta pantalla" | `/atrezzo:escena` |
| "comprueba la pantalla", "no salen las filas", "¿cuadra?" | `/atrezzo:verifica` |
| "estoy en X y quiero llegar a Y", "qué estados necesito para este flujo" | `/atrezzo:desde-intencion` |

Si no hay config, empieza siempre por `/atrezzo:init`. Si no hay contrato, `/atrezzo:captura` antes de `/atrezzo:escena`.

## El bucle

1. **Mundo** — entidades, conteos, distribuciones y semilla (`world:` en el escenario).
2. **Escenario** — endpoints como proyecciones + `path` de pantallas + `expect`. Ver `${CLAUDE_PLUGIN_ROOT}/references/escenario.md`.
3. **Generar** — `atrezzo world <escenario.yaml>` escribe JSON + `runtime.mjs` y lo del runtime de la config (handlers MSW, seed.sql de Supabase, OpenAPI para Prism o mappings de WireMock); `atrezzo runtimes` dice cuál y por qué.
4. **Servir** — `atrezzo serve --escenario <nombre>` (HTTP real; `POST /__atrezzo/reset` cambia de escenario).
5. **Verificar** — `atrezzo verify <flujo.yaml>`; si falla, `--diagnose` y diagnostica antes de tocar nada.

## Reglas duras

1. Determinismo: misma semilla ⇒ mismos bytes. El "ahora" va en `now:` del escenario.
2. Integridad referencial: los ids existen en el mundo; nunca inventes un `client_id`.
3. Tú eliges distribuciones y narrativa; **el código produce los datos**. No escribas JSON de datos a mano.
4. El mock da forma a los datos; no implementa reglas de negocio (solo GET; nada de cálculos de dominio).

Diagnóstico de entorno: `atrezzo doctor`.
