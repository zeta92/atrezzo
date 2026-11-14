---
name: atrezzo-init
description: Configura atrezzo en un repo (init de mocks por escenarios). Úsalo cuando el usuario quiera empezar con atrezzo, no exista atrezzo.config.json, o pida detectar el stack y preparar carpetas de escenarios y handlers.
---

# /atrezzo:atrezzo-init

1. Inspecciona el repo sin modificarlo:
   - Framework: `package.json` (next, vite, express…).
   - Capa de datos: fetch/axios/react-query/swr/supabase-js/apollo; busca dónde se construyen las URLs (`grep -rn "fetch(\|axios\.\|from('" src | head -50`).
   - Mocks existentes: msw, json-server, mirage, nock, carpetas `mocks/`, `__mocks__/`, `supabase/`.
   - Contratos: OpenAPI, tipos generados (`database.ts`), migraciones.
2. Ejecuta `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs doctor` y luego `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs init`.
   - Nunca uses `--force` sin que el usuario lo pida: `init` no pisa una config existente.
   - **No instales dependencias sin decirlo.** Si hacen falta (`msw` para handlers en navegador/tests), anuncia el comando exacto y espera confirmación antes de `init --install`. `serve` y `verify --driver http` no necesitan nada.
3. Si ya hay MSW u otro mock, explica cómo convive: los handlers de atrezzo se añaden como uno más (`atrezzo/handlers/index.mjs`); no reemplaces los existentes.
4. Si el proyecto usa Supabase u otro backend no-REST plano, lee `${CLAUDE_PLUGIN_ROOT}/references/runtimes.md` y propón la fachada.
5. Termina con un resumen: stack, capa de datos, mocks existentes, ficheros escritos, siguiente paso (`/atrezzo:atrezzo-captura` o `/atrezzo:atrezzo-escena`).
