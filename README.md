# atrezzo

Plugin de Claude Code que genera y sirve **mocks de API a partir de estados de aplicación**, no de endpoints sueltos.

- Declaras un **mundo**: grafo de entidades con semilla fija (3 clientes, 40 pedidos, 3 con incidencia).
- Cada endpoint es una **proyección** determinista de ese mundo: filtros, paginación, orden, joins.
- Un **escenario** versionado (YAML) reúne mundo + ruta de pantallas + aserciones (`12 filas`, `3 badges de incidencia`).
- La salida es **código**: `atrezzo world` escribe módulos legibles (JSON + handlers MSW + motor) que se commitean y se revisan en el PR.
- Hay un **bucle de verificación**: servir → abrir la pantalla → contar el DOM → comparar → si no cuadra, **diagnosticar** (no regenerar a ciegas).

## Reglas duras

1. **Determinismo.** Misma semilla ⇒ mismos datos, byte a byte. La generación no usa `Math.random()` ni `Date.now()` (hay un test que lo comprueba); el "ahora" se inyecta con `now:` en el escenario. PRNG propio (xmur3 + sfc32) con un flujo por entidad: añadir una entidad no altera las demás.
2. **Integridad referencial.** Toda fk de una proyección existe en el mundo. Nunca `user_id: 42` sin el 42. `world` lo comprueba antes de escribir.
3. **El LLM elige distribuciones y narrativa; el código produce los datos.** Las skills prohíben escribir JSON de datos a mano: se cambia el escenario y se regenera.
4. **El mock da forma a los datos, no implementa reglas de negocio.** Solo GET; escrituras ⇒ 405. Nada de recalcular totales ni simular RLS.

## Instalación

```bash
claude --plugin-dir /ruta/a/atrezzo          # para una sesión
# o publícalo en un marketplace y: claude plugin install atrezzo@<marketplace>
```

Requisitos: Node ≥ 22. Sin dependencias en tiempo de ejecución (parser YAML y servidor propios). Opcionales en el proyecto: `msw` (handlers en navegador/tests) y `playwright` o `playwright-core` (driver DOM). Con `playwright-core` se usa el Chromium del sistema (`/usr/bin/chromium`; otro binario con `ATREZZO_CHROME=/ruta`); el paquete se carga de forma perezosa y, si falta, `verify --driver playwright` sale con exit 2.

## Skills

| comando | para qué |
|---|---|
| `/atrezzo:atrezzo` | router: decide qué skill usar y explica el bucle |
| `/atrezzo:init` | inspecciona el repo y ejecuta `init` (no instala nada sin decirlo) |
| `/atrezzo:captura` | contrato: OpenAPI/tipos → HAR (con scripts) → código; avisa de huecos |
| `/atrezzo:escena` | intención ("12 filas, 3 con incidencia") → escenario versionado |
| `/atrezzo:verifica` | sirve, verifica y diagnostica antes de tocar el escenario |
| `/atrezzo:desde-intencion` | "estoy en X, quiero Y" → ruta de estados, escenarios por paso, huecos |
| `/atrezzo:hueco` | la app pide una ruta que el escenario no tiene → busca el consumidor y el contrato, parchea el escenario, recarga y comprueba |

> En Claude Code 2.1.319 el comando de una skill de plugin es `/<plugin>:<directorio>`; el `name:` del frontmatter no lo cambia. Por eso los comandos llevan el prefijo `atrezzo-` del directorio.

## CLI

```
node scripts/cli.mjs init [--dir .] [--runtime auto|builtin|msw|supabase|prism|wiremock] [--front <ruta> --backend <ruta>] [--contract <spec>] [--install] [--force]
node scripts/cli.mjs runtimes
node scripts/cli.mjs import [<openapi.yaml|json>] [--name api] [--base /api] [--format yaml|json] [--force]
node scripts/cli.mjs world <escenario.yaml> [--out dir]
node scripts/cli.mjs serve [--escenario demo] [--port 4010] [--static dir] [--runtime builtin] [--on-miss log|stub]
node scripts/cli.mjs misses [--json] [--clear]
node scripts/cli.mjs verify <flujo.yaml> [--url …] [--driver http|playwright] [--diagnose] [--no-reset] [--json]
node scripts/cli.mjs doctor
```

- `init` detecta monorepo (pnpm/npm/yarn workspaces, turbo, nx, lerna) o carpetas `client/`+`server/`, el runtime y el `baseUrl` que consume el front, e **imprime qué encontró, por qué y qué alternativas había**. Si hay dos fronts o ninguno, no adivina: tabla de candidatos y exit 2.
- `world` escribe siempre `<escenario>.json` + `runtime.mjs` (fuente de verdad) y después lo del runtime: handlers MSW, `seed.sql`/`reset.sh`, OpenAPI para Prism o mappings de WireMock. Ver [`references/runtimes.md`](references/runtimes.md).
- `import` infiere un escenario desde un OpenAPI (entidades, campos con tipo, envoltorios `{data: […]}` → `pick`, filtros por enum, paginación) con un informe de lo que no pudo inferir.

Códigos de salida: `0` OK · `1` aserción fallida · `2` no verificable (sin mock, sin playwright o aserción sin datos; **nunca** se reporta como OK) · `3` entrada inválida.

`serve` expone `GET /api/<recurso>?limit=&offset=&<filtros>`, el detalle `/<recurso>/:id`, `POST /__atrezzo/reset {"escenario":"x"}`, `POST /__atrezzo/reload` (relee el YAML del escenario actual), `GET /__atrezzo/state` y `GET|DELETE /__atrezzo/misses`. Usa el mismo motor (`scripts/lib/contract.mjs`) que los handlers MSW: `world` lo copia byte a byte como `runtime.mjs`.

## Cuando falta una ruta

Si la app pide algo que el escenario no declara, `serve` no se limita a dar un 404: **registra el hueco** y dice qué hacer.

```
$ curl -s localhost:4010/api/users
{"error":"GET /api/users no está en el contrato del escenario \"catalogo\"",
 "atrezzo":{"miss":true,"hueco":"GET /api/users","veces":3,"siguiente":"atrezzo misses","endpoints":["/api/products"]}}

$ atrezzo misses
GET /api/users      3 veces    sin resolver  hace 12 s   → el contrato lo tiene (GET /users) → atrezzo import api/openapi.yaml
GET /api/invoices   1 vez      sin resolver  hace 40 s   → no está en el contrato → añade el endpoint al escenario (skill /atrezzo:hueco)
POST /api/orders    2 veces    sin resolver  hace 1 min  → mutación: atrezzo solo proyecta lecturas → serve --on-miss stub (o no se resuelve)
```

- Se guarda en `atrezzo/.atrezzo/misses.json` (junto a `.generated/`; la carpeta lleva su propio `.gitignore`): un objeto indexado por `MÉTODO ruta` con `method`, `path`, `ejemplo`, `query`, `times`, `first_seen`, `last_seen`, `referer`, `accept`, `resolved`. La misma ruta solo incrementa `times`; los segmentos con pinta de id (`/users/42`, UUID, hex largo) se colapsan a `:id`, y hay un tope de 200 entradas (se descartan primero las resueltas más antiguas).
- La `query` y el `referer` se guardan sin secretos: parámetros como `token`, `api_key`, `password`, `session`, `auth`, `signature`… y valores con forma de JWT o clave larga salen como `***`; el referer, sin query. El log de `serve` también enmascara.
- No son huecos: estáticos (`/favicon.ico`, `.js`, `.css`, imágenes, fuentes) ni rutas `/__atrezzo/*`. Sí lo son las escrituras sobre una ruta del contrato (`POST /api/orders` → 405 con el mismo cuerpo).
- Cuando añades el endpoint, ejecutas `atrezzo world` y `POST /__atrezzo/reload`, la siguiente petición que se sirve marca el hueco `resolved: true`. `doctor` avisa de los que quedan sin resolver.
- `atrezzo serve --on-miss stub` responde 200 con `[]` (ruta con pinta de colección) o `{}` (detalle, singular o escritura) y `x-atrezzo-stub: true`, para explorar sin que la pantalla reviente. Se registra igual y **no** cuenta como resuelto. Nunca es el modo por defecto.

Para rellenarlo, la skill `/atrezzo:hueco` busca en el front quién hace la llamada y qué campos lee, usa el contrato como fuente de verdad del shape y añade entidad + endpoint al escenario (los datos los sigue generando el mundo). Solo `serve` registra huecos; qué pasa en los demás runtimes está en [`references/runtimes.md`](references/runtimes.md#huecos-en-cada-runtime).

## Proyectos sin Supabase y proyectos con Supabase

El escenario es el mismo en los dos casos; cambia **dónde se sirve**.

### Sin Supabase: front Vite + API propia con OpenAPI

```
tienda/
  package.json          react, vite, msw (dev)
  vite.config.ts        server.proxy['/api'] → { target: 'http://localhost:3000' }
  api/openapi.yaml      (el de tests/fixtures/petstore.yaml: GET/POST /pets, /pets/{petId}, /owners → {data: [...]}, /health, foto PNG)
```

```bash
cd tienda
atrezzo init
#   Estructura:
#     proyecto simple (sin monorepo ni carpetas front/back): todo vive en la raíz
#     contrato encontrado: api/openapi.yaml (úsalo con: atrezzo import)
#     baseUrl del mock: http://localhost:3000 (proxy de Vite "/api" → http://localhost:3000 en vite.config.ts)
#   Runtime: msw — puntuación 3/3: msw en package.json
#     → msw       3/3  msw en package.json
#       builtin   1/3  fallback universal: HTTP real sin dependencias, vale para cualquier backend o lenguaje
#       prism     1/3  contrato api/openapi.yaml (señal débil: mejor `atrezzo import api/openapi.yaml`; prism no es necesario para usarlo)
atrezzo import api/openapi.yaml --name tienda
#   Endpoints inferidos (2):
#     GET /api/pets → pets · array            filtros: status · paginación: limit/offset · detalle: /api/pets/:id
#     GET /api/owners → owners · envoltorio {data: [...]} → pick: data · paginación: page/per_page
#   Ignoradas (3): POST /pets (mutación) · GET /health (200 sin esquema) · GET /pets/{petId}/photo (respuesta binaria)
#   Escrito: atrezzo/escenarios/tienda.yaml (escenario válido)
# ajusta conteos/distribución/expect (skill /atrezzo:escena) y genera:
atrezzo world atrezzo/escenarios/tienda.yaml
#   atrezzo/.generated/tienda.json · runtime.mjs · tienda.handlers.mjs
```

En `src/main.tsx` (solo desarrollo): `setupWorker(...handlers).start({ onUnhandledRequest: 'bypass' })` con `handlers` de `atrezzo/.generated/tienda.handlers.mjs`. Para E2E o si la API es de otro lenguaje: `atrezzo serve --escenario tienda --port 3000` (el proxy de Vite apunta ahí) y `atrezzo verify flujo.yaml`. Si el equipo ya tiene WireMock o Prism, `atrezzo init --force --runtime wiremock` (o `prism`) y `world` emite sus ficheros; lo que no hacen está en `references/runtimes.md`.

### Con Supabase: Next + supabase-js + Supabase CLI

```
app/
  package.json          next, @supabase/supabase-js
  supabase/config.toml  (supabase init)
  .env.local            NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
```

Escenario con los nombres de tabla que consulta la app (`supabase.from('pedidos')`):

```yaml
name: pedidos-incidencias
seed: 7712
world:
  clientes: 3
  pedidos: { total: 40, distribucion: { pagado: 34, pendiente: 3, incidencia: 3 } }
endpoints:
  - path: /rest/v1/pedidos
    entity: pedidos
    filters: [estado]
```

```bash
atrezzo init
#   Runtime: supabase — puntuación 3/3: supabase/config.toml (proyecto Supabase CLI); @supabase/supabase-js en package.json; NEXT_PUBLIC_SUPABASE_URL en .env.local
atrezzo world atrezzo/escenarios/pedidos-incidencias.yaml
#   supabase/atrezzo/pedidos-incidencias/{schema.sql, seed.sql, reset.sh, README.md}
supabase start
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres supabase/atrezzo/pedidos-incidencias/reset.sh
#   atrezzo: escenario pedidos-incidencias restaurado (43 filas)
```

La app habla con su Supabase local de siempre; `pedidos` tiene exactamente 40 filas, 3 con `estado = 'incidencia'`, con los mismos ids que verías en `serve`. `reset.sh` es idempotente (truncate + inserts) y se niega a tocar una `DATABASE_URL` no local. Lo que **no** hace: simular RLS o auth, ni usar el motor de atrezzo (filtros y paginación son de PostgREST). Para tests de componentes sin base de datos, añade MSW con una fachada (`--runtime supabase,msw`; ver `references/runtimes.md`).

## Estructura

```
.claude-plugin/plugin.json   manifiesto
skills/                      router + 6 skills
scripts/cli.mjs              CLI (bin: atrezzo)
scripts/lib/                 prng, yaml, yaml-emit, world, scenario, contract, codegen, serve, verify, doctor, init, config,
                             project (monorepo/front/back), openapi (import), flows, misses (huecos)
scripts/lib/runtimes/        builtin, msw, supabase, prism, wiremock + registro (index.mjs)
references/                  escenario.md · suposiciones.md · runtimes.md (runtimes, monorepo)
examples/tienda/             ejemplo ejecutable end-to-end
tests/                       node --test tests/ (fixtures/petstore.yaml para import)
```

## Ejemplo

Ver [`examples/tienda`](examples/tienda/README.md): `world` → `serve` → `verify --driver http` en verde, y `reset` entre escenarios sin reiniciar.

## Límites conocidos

- YAML: subconjunto (sin anclas/alias/multi-documento); el parser lo rechaza con línea y motivo.
- El driver `playwright` está probado con un `page` falso y con Chromium real (`tests/headers.test.mjs`, se saltan si no hay `playwright-core` + Chromium). Para apps con sesión, el flujo puede declarar `headers` (p. ej. `Cookie: "${APP_COOKIE}"`); ver `references/escenario.md`.
- Errores HTTP, latencias y escrituras no son parte del mundo: se inyectan en el runtime (ver `references/runtimes.md`).
- Runtimes: solo `builtin` y `msw` ejecutan la proyección. **Prism** devuelve examples (no filtra ni pagina); **WireMock** sirve combinaciones pregeneradas y responde 501 al resto; **Supabase** carga el mundo en Postgres y la forma de las respuestas es la de PostgREST. Detalle en `references/runtimes.md`.
- Huecos: solo los registra `atrezzo serve` (no MSW, Prism, WireMock ni Supabase). Una ruta pedida con prefijos distintos (`/api/users` y `/users`) son dos huecos. Las rutas anidadas (`/api/clientes/:id/pedidos`) se registran pero el motor no las proyecta. `--on-miss stub` no persiste escrituras.
- `import`: solo GET de colecciones (array de objetos o envoltorio `data`/`items`/`results`/`records`/`content`); campos anidados se omiten (lo dice el informe); ids siempre enteros 1..n; `$ref` externos no; specs YAML con anclas o colecciones `{…}` multilínea → conviértelos a JSON.
