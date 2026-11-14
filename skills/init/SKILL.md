---
name: init
description: Configura atrezzo en un repo (init de mocks por escenarios). Úsalo cuando el usuario quiera empezar con atrezzo, no exista atrezzo.config.json, pida detectar el stack o el runtime (MSW, Supabase, Prism, WireMock, serve), o el proyecto sea un monorepo o tenga front y backend separados.
---

# /atrezzo:init

1. Inspecciona el repo sin modificarlo:
   - Estructura: ¿monorepo (`pnpm-workspace.yaml`, `workspaces` en `package.json`, `turbo.json`, `nx.json`, `lerna.json`)? ¿carpetas `client/`+`server/`, `web/`+`api/`, `frontend/`+`backend/`? ¿o el backend está en otro repo?
   - Framework del front y capa de datos: fetch/axios/react-query/swr/supabase-js/apollo; dónde se construyen las URLs (`grep -rn "fetch(\|axios\.\|from('" src | head -50`), proxy de Vite, `NEXT_PUBLIC_API_URL`.
   - Mocks existentes: msw, WireMock (`mappings/`+`__files/`, docker-compose), Prism, json-server, `supabase/`.
   - Contratos: OpenAPI, tipos generados (`database.ts`), migraciones.
2. Ejecuta `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs runtimes` (solo lee) y luego `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs init`.
   - Nunca uses `--force` sin que el usuario lo pida: `init` no pisa una config existente.
   - **No instales dependencias sin decirlo.** Si hacen falta (`msw`), anuncia el comando exacto y espera confirmación antes de `init --install`. `serve` y `verify --driver http` no necesitan nada.

## Detección de runtime (`--runtime auto`, por defecto)

`init` puntúa cada adaptador de 0 a 3 con sus motivos y elige el mayor; si empatan, gana por prioridad `msw > supabase > wiremock > builtin > prism`. **Siempre imprime** la tabla de puntuaciones, el motivo de la elección y las alternativas con señales. Léela y explícasela al usuario con sus palabras; no la resumas como "detectado X" sin el porqué.

| runtime | señales | qué emite `world` |
|---|---|---|
| `msw` | `msw` en deps, `public/mockServiceWorker.js` | handlers `.mjs` (en `<front>/src/mocks/atrezzo/` si hay workspace) |
| `supabase` | `supabase/config.toml`, `@supabase/supabase-js`, `supabase/`, `*SUPABASE_URL` en `.env*` | `schema.sql`, `seed.sql`, `reset.sh`, README junto a `<backend>/supabase/` |
| `wiremock` | dependencia, `mappings/`+`__files/`, docker-compose/scripts | `mappings/` + `__files/` pregenerados (501 para lo no enumerado) |
| `prism` | `@stoplight/prism-cli`, `prism mock` en scripts; un spec solo puntúa 1 | `<escenario>.openapi.yaml` con examples |
| `builtin` | siempre 1 (fallback universal) | nada más: `atrezzo serve` |

- Un `openapi.yaml` sin Prism instalado **no** elige Prism (empata con builtin y gana builtin): propón `atrezzo import` para sacar el escenario del contrato.
- Si dos runtimes tienen señales fuertes (p. ej. msw en el front y Supabase en el backend), pregunta si quiere ambos: `init --force --runtime msw,supabase`.
- Si el usuario elige otro: `init --force --runtime <id>`. Explica qué **no** hace ese runtime (Prism no filtra ni pagina; WireMock solo sirve combinaciones pregeneradas; Supabase usa PostgREST, no el motor). Detalle: `${CLAUDE_PLUGIN_ROOT}/references/runtimes.md`.

## Monorepo y front/back separados

- `init` clasifica cada paquete como front (deps de UI, `vite.config`, nombre `web`/`client`…) o backend (deps de servidor, `openapi.*`, `supabase/`, manifiesto no JS, nombre `api`/`server`…) y escribe `workspace: { front, backend, contract }`.
- **Si sale exit 2** ("No elijo por ti"), muestra la tabla al usuario y pregúntale cuál es el front; después `init --front <ruta> --backend <ruta> [--contract <spec>]`. Nunca elijas tú en silencio.
- Dos repos: ejecuta `init` en el del front con rutas relativas al otro: `--front . --backend ../api --contract ../api/openapi.yaml`.
- El `baseUrl` del mock sale del front (proxy de Vite o `*_API_URL`); compruébalo en la salida (`baseUrl del mock: …`).

3. Si ya hay MSW u otro mock, explica cómo convive: los handlers de atrezzo se añaden como uno más (`index.mjs` de `handlersDir`); no reemplaces los existentes.
4. Termina con un resumen: estructura (workspace), runtime elegido y por qué, alternativas, baseUrl, ficheros escritos y siguiente paso (`atrezzo import <spec>` si hay contrato → `/atrezzo:captura`; si no, `/atrezzo:escena`).
