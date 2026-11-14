# Runtimes: dónde se sirve el mock

El escenario (mundo + endpoints + expect) **no depende del runtime**. `atrezzo world` escribe siempre la fuente de verdad, `<generatedDir>/<escenario>.json` (el mundo) y `runtime.mjs` (el motor de proyección, sin dependencias), y después lo que pida cada runtime de `atrezzo.config.json → runtime` (uno o una lista: `"runtime": ["msw", "supabase"]`).

```bash
atrezzo init                       # detecta y elige (imprime qué encontró, por qué y las alternativas)
atrezzo init --runtime wiremock    # o lo eliges tú (varios: --runtime msw,supabase)
atrezzo runtimes                   # puntuación de cada adaptador en este proyecto y cómo se arranca
atrezzo world atrezzo/escenarios/pedidos.yaml
```

Una config de 0.1 sin campo `runtime` equivale a `msw` (el comportamiento de antes: handlers en cada `world`).

## Tabla de decisión

| el proyecto… | runtime | por qué |
|---|---|---|
| es un front JS con `msw` instalado (Vite, Next cliente, Storybook, vitest) | **msw** | intercepta `fetch` sin cambiar URLs; mismo motor que `serve` |
| usa Supabase (`supabase/`, `@supabase/supabase-js`, `SUPABASE_URL`) | **supabase** | no hay capa de mock: la "API" es PostgREST sobre Postgres → se carga el mundo en la BD local |
| ya tiene WireMock (mappings/`__files`, docker-compose, dependencia) | **wiremock** | stubs estáticos que el equipo ya sabe operar |
| ya usa Prism (`@stoplight/prism-cli` en deps o en scripts) | **prism** | mock desde un OpenAPI generado con examples del mundo |
| tiene un backend en otro lenguaje, E2E, apps que no se pueden instrumentar, o nada de lo anterior | **builtin** | `atrezzo serve`: HTTP real sin dependencias, filtros y paginación de verdad |

### Cómo puntúa `auto`

Cada adaptador devuelve 0..3 con sus motivos; gana el mayor y, si empatan, la prioridad fija `msw > supabase > wiremock > builtin > prism`.

| adaptador | señales (peso) |
|---|---|
| builtin | siempre 1: fallback universal |
| msw | `msw` en dependencias (3) · `public/mockServiceWorker.js` (2) |
| supabase | `supabase/config.toml` (3) · `@supabase/supabase-js` (2) · carpeta `supabase/` (2) · `*SUPABASE_URL` en `.env*` (2) |
| prism | `@stoplight/prism-cli` (3) · `prism mock/proxy` en scripts (2) · un spec OpenAPI en el repo (1) |
| wiremock | dependencia `*wiremock*` (3) · `mappings/` + `__files/` en la raíz o en `wiremock/` (3) · `wiremock` en scripts o docker-compose (2) |

**Un `openapi.yaml` solo no elige Prism**: empata a 1 con builtin y gana builtin. Un spec es un contrato, no la prueba de que el equipo use Prism; úsalo con `atrezzo import` (escenario desde el contrato) y sírvelo con el runtime que tengas. Con `prism-cli` en dependencias, prism sí gana.

En un monorepo se suman las señales de la raíz, del front y del backend (p. ej. `msw` en `apps/web` y `supabase/config.toml` en `services/api` empatan a 3 → msw por prioridad; `init` lo dice y propone `--runtime msw,supabase`).

## Cada runtime: qué hace, qué NO hace, cómo se arranca

### builtin (`atrezzo serve`)

- **Hace**: sirve las proyecciones por HTTP (`GET /api/x?filtro=&limit=&offset=`, detalle `/:id`, envoltorios, `X-Total-Count`), cambia de escenario sin reiniciar (`POST /__atrezzo/reset {"escenario":"x"}`), relee el YAML (`POST /__atrezzo/reload`), estáticos con `--static`, y registra los huecos (`atrezzo misses`).
- **No hace**: escrituras (405, registradas como hueco), latencias ni errores inyectados.
- **Arranque**: `atrezzo serve --escenario pedidos --port 4010`.

### msw

- **Hace**: `world` escribe `<escenario>.handlers.mjs`, que importan el JSON y `runtime.mjs` y proyectan con el mismo motor que `serve`. Con `workspace.front`, los handlers van a `<front>/src/mocks/atrezzo/` con imports relativos a `atrezzo/.generated/`; si no, a `.generated/`.
- **No hace**: instalar msw (usa `init --install`, anunciándolo); registrar el worker por ti.
- **Arranque**:
  ```js
  import { setupWorker } from 'msw/browser';           // navegador, solo en desarrollo
  import { handlers } from './mocks/atrezzo/pedidos.handlers.mjs';
  await setupWorker(...handlers).start({ onUnhandledRequest: 'bypass' });
  // tests Node: import { setupServer } from 'msw/node'; setupServer(...handlers).listen();
  ```
  Requiere importar JSON con `with { type: 'json' }` (Node 22+, Vite 5+, Next 14+).

### supabase

Supabase no tiene capa de mock: su API es PostgREST sobre Postgres. El "runtime" es **la base de datos local con el mundo cargado**.

- **Hace**: `world` escribe en `<backend>/supabase/atrezzo/<escenario>/` (o `supabase/atrezzo/…` en la raíz; si no hay carpeta `supabase/`, en `.generated/supabase/<escenario>/`):
  - `schema.sql`: `CREATE TABLE IF NOT EXISTS` mínimo con tipos inferidos de los datos y FKs (para que PostgREST pueda hacer joins); `GRANT SELECT … TO anon` si el rol existe.
  - `seed.sql`: en una transacción, `TRUNCATE … RESTART IDENTITY CASCADE` + `INSERT … OVERRIDING SYSTEM VALUE` con los ids del mundo (los mismos que en `serve`/MSW) y `setval` de la secuencia si la columna `id` es serial/identity.
  - `reset.sh`: aplica los dos con `psql`, es idempotente y **se niega a tocar una `DATABASE_URL` que no parezca local** (exit 2; `ATREZZO_ALLOW_REMOTE=1` para forzarlo).
  - `README.md`: pasos con Supabase CLI o Postgres + PostgREST sueltos.
  - Tu `supabase/seed.sql` no se toca.
- **No hace**: proyectar con el motor de atrezzo. Filtros, orden, paginación (`Range`, `limit/offset`) y embeds los resuelve PostgREST; las rutas del escenario (`/api/orders`) no existen allí (supabase-js consulta `/rest/v1/<entidad>`). Los datos son idénticos; la forma de la respuesta es la de PostgREST. Tampoco simula RLS ni auth: con RLS activa, `anon` solo ve lo que permitan tus políticas. Si tus migraciones ya crean las tablas con otras columnas, `seed.sql` falla con `column … does not exist` (el escenario no coincide con tu esquema; ajústalo).
- **Arranque**:
  ```bash
  supabase start
  DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres services/api/supabase/atrezzo/pedidos/reset.sh
  ```
  O con `supabase db reset`: en `config.toml`, `[db.seed] sql_paths = ["./atrezzo/pedidos/seed.sql"]` (si tu versión del CLI soporta `sql_paths`).

Probado contra PostgreSQL 17 real (test `supabase: reset.sh …`, se salta si no hay `initdb`): dos ejecuciones seguidas, conteos y ids iguales al JSON, y una tabla previa con `id GENERATED ALWAYS AS IDENTITY`.

#### Alternativa: fachada PostgREST sobre `serve`/MSW

Si no quieres levantar Postgres, puedes apuntar `SUPABASE_URL` al mock y traducir delante de `engine.handle` lo que la app usa: `estado=eq.x` → `estado=x`, `in.(a,b)` → `a,b`, `Range: 0-11` → `offset=0&limit=12` (y responder `Content-Range`), `Accept: application/vnd.pgrst.object+json` → detalle. GoTrue: `POST /auth/v1/token` con una sesión fija de un usuario del mundo. No reimplementes PostgREST: solo lo que la pantalla usa.

### prism

- **Hace**: `world` escribe `<generatedDir>/<escenario>.openapi.yaml` (OpenAPI 3.1) desde los endpoints del escenario: un schema por entidad con `required` = campos que nunca son nulos en el mundo, parámetros de filtro y paginación, `X-Total-Count`, detalle `/{id}` con 404, y `examples` calculados con el motor (la proyección sin query, más uno por valor del primer filtro con ≤ 10 valores, p. ej. `estado-incidencia`).
- **No hace**: filtrar ni paginar. Prism devuelve el example por defecto para **cualquier** query (`?estado=incidencia` da los 40 pedidos); otro example solo con la cabecera `Prefer: example=estado-incidencia`. El detalle devuelve siempre el primer id (`/api/orders/999` → 200 con el id 1) salvo `Prefer: code=404`. Con `-d` (dinámico) genera datos que no son el mundo. Los filtros se declaran `string` sin `enum` porque con enum Prism rechazaría las listas `a,b` que el motor acepta.
- **Sí hace (de Prism)**: validar las peticiones contra los parámetros: `?limit=abc` → 400.
- **Arranque**: `npx @stoplight/prism-cli mock atrezzo/.generated/pedidos.openapi.yaml --port 4010`.

Comprobado con `@stoplight/prism-cli` 5.16.0 sobre el `pedidos` del ejemplo (todo lo de arriba).

### wiremock

WireMock no puede ejecutar la proyección: Handlebars no tiene una forma sensata de filtrar + ordenar + trocear un array embebido. Por eso las listas se **pregeneran**.

- **Hace**: `world` escribe una raíz WireMock por escenario en `<generatedDir>/wiremock/<escenario>/`, con `mappings/<endpoint>.json` y los cuerpos en `__files/`. Para cada lista hay una mapping (`urlPath` + `queryParameters` con `equalTo`/`absent`) por cada combinación enumerable:
  - sin query;
  - cada valor de cada filtro, de uno en uno (si el campo tiene ≤ 20 valores distintos; `null` incluido);
  - páginas de `default_limit`/`max_limit` (`limit=N` y `limit=N&offset=k`, hasta 50 páginas);
  - **las peticiones exactas de los flujos** (`flujo.yaml` cuyo `escenario` apunta a este), p. ej. `?estado=incidencia&limit=12`.
  Cuerpo y `X-Total-Count` salen del motor: los mismos bytes que `serve`. El detalle `/{id}` usa **response templating**: `bodyFileName: "<escenario>/<endpoint>/id/{{request.pathSegments.[n]}}.json"` con `transformers: ["response-template"]` declarado en la mapping; los ids que no existen dan 404.
- **No hace**: filtros cruzados, listas `a,b`, órdenes distintos ni páginas no enumeradas. Esas peticiones caen en una mapping de prioridad baja que responde **501** con `{"error": …, "generadas": [...]}`: nunca una página equivocada. Si una pantalla pide una combinación nueva, añádela a un flujo y vuelve a ejecutar `world`. Tampoco emite `X-Atrezzo-Ignored`. No mezcles dos escenarios en la misma carpeta `mappings/` (las rutas chocan): cada escenario es su propia raíz.
- **Arranque**:
  ```bash
  docker run --rm -p 4010:8080 -v "$PWD/atrezzo/.generated/wiremock/pedidos:/home/wiremock" wiremock/wiremock:3.13.2
  # o: java -jar wiremock-standalone-3.13.2.jar --root-dir atrezzo/.generated/wiremock/pedidos --port 4010
  ```
  Para cambiar de escenario sin reiniciar: `POST /__admin/mappings/reset` + `POST /__admin/mappings/import` con los mappings del otro escenario.

Comprobado con WireMock standalone 3.13.2 (Java 21) sobre el `pedidos` del ejemplo: 15 stubs cargados; `/api/orders`, `?estado=incidencia` y `?limit=12` dan 40/3/12 filas con su `X-Total-Count`; `/api/orders/7` sale por plantilla; `/api/orders/999` → 404; `?estado=incidencia&limit=12` (no pregenerada) → 501.

## Huecos en cada runtime

Un hueco es una petición que el escenario no declara. **Solo `atrezzo serve` (builtin) los registra** en `atrezzo/.atrezzo/misses.json`; el resto de runtimes se comporta así:

| runtime | qué recibe la app ante una ruta no declarada | cómo verlo | se registra en `misses.json` |
|---|---|---|---|
| builtin (`serve`) | 404 con `{ error, atrezzo: { miss, hueco, veces, siguiente, endpoints } }` (405 si es una escritura sobre una ruta del contrato); con `--on-miss stub`, 200 `[]`/`{}` + `x-atrezzo-stub: true` | `atrezzo misses`, `GET /__atrezzo/misses`, `doctor` | sí |
| msw | depende de `onUnhandledRequest`: el arranque sugerido usa `'bypass'` (la petición sale a la red real, o falla si no hay backend). `'warn'` la imprime en consola; `'error'` la rompe | la consola del navegador/test: `[MSW] Warning: intercepted a request without a matching request handler: GET /api/users` | no |
| prism | no aplica: Prism sirve el OpenAPI que genera `world`, que contiene exactamente los endpoints del escenario; lo demás es 404 de Prism (`NO_PATH_MATCHED_ERROR`) | log de Prism | no |
| wiremock | rutas declaradas con una query no pregenerada → **501** con `{ error, generadas: [...] }` (la lista de combinaciones que sí existen). Rutas no declaradas → 404 propio de WireMock ("Request was not matched", con near misses) | `GET /__admin/requests/unmatched` | no |
| supabase | no hay rutas: supabase-js consulta `/rest/v1/<tabla>`. Una tabla que no existe → error de PostgREST (`42P01` / `PGRST205`, "relation does not exist") | respuesta de PostgREST | no |

Para cazar huecos con MSW sin cambiar de runtime, arranca la pantalla una vez contra `atrezzo serve` (mismo motor, mismas rutas) o usa un `onUnhandledRequest` propio:

```js
await setupWorker(...handlers).start({
  onUnhandledRequest(req, print) {
    if (new URL(req.url).pathname.startsWith('/api/')) print.warning(); // hueco: /atrezzo:hueco
  },
});
```

Rellenar el hueco es igual en todos: entidad + endpoint en el escenario (`/atrezzo:hueco`) y `atrezzo world`, que regenera handlers, OpenAPI, mappings o `seed.sql`.

Latencias, errores 5xx y timeouts no son parte del mundo: inyéctalos en el runtime (MSW `delay()`/`HttpResponse.error()`, WireMock `fixedDelayMilliseconds`/`fault`), no en el escenario.

## Monorepo y front/back separados

`atrezzo.config.json` puede llevar un bloque `workspace` (rutas relativas a la config):

```json
"workspace": {
  "front": "apps/web",
  "backend": "services/api",
  "contract": "services/api/openapi.yaml"
}
```

- `front`: donde vive el cliente. `msw` escribe ahí los handlers (`apps/web/src/mocks/atrezzo/`) y de ahí sale el `baseUrl` del mock: el destino del proxy de Vite (`server.proxy['/api'].target`) o `NEXT_PUBLIC_API_URL`/`VITE_API_URL`/`REACT_APP_API_URL` en `.env*`. El prefijo (`/api`) se guarda en `mock.apiPrefix`.
- `backend`: donde vive el contrato y/o la base de datos. `supabase` escribe junto a `<backend>/supabase/` si existe.
- `contract`: el spec, si no está dentro de `backend` (o para fijarlo). `atrezzo import` sin argumentos usa este.

`atrezzo` (config, escenarios y `.generated/`) vive en la raíz desde la que ejecutas `init`; normalmente la raíz del monorepo o el repo del front.

### Caso 1: monorepo

`init` lee `pnpm-workspace.yaml`, `workspaces` de `package.json`, `lerna.json`, `turbo.json` o `nx.json` (estos dos sin lista de paquetes → `apps/*`, `packages/*`, `libs/*`, `services/*`) y clasifica cada paquete:

- **front**: dependencias de UI (react, vue, svelte, next, nuxt, vite, @angular/core, solid, preact, astro), `vite.config.*`/`next.config.*`/`index.html`, nombre `web`/`client`/`app`/`frontend`/`ui`.
- **backend**: dependencias de servidor (express, fastify, @nestjs/core, hono, koa, @prisma/client, @supabase/supabase-js…), `openapi.{yaml,json}` o `supabase/` (cuentan doble), un manifiesto no JS (`requirements.txt`, `go.mod`, `pom.xml`…), nombre `api`/`server`/`backend`.

```bash
cd mi-monorepo
atrezzo init                              # detecta apps/web (front) y services/api (backend)
atrezzo init --runtime msw,supabase       # handlers en apps/web y seed en services/api/supabase/atrezzo/
atrezzo import                            # usa workspace.contract
atrezzo world atrezzo/escenarios/api.yaml
```

### Caso 2: dos carpetas sin manifiesto

Carpetas hermanas `client/`+`server/`, `web/`+`api/`, `frontend/`+`backend/` (y combinaciones): se clasifican igual.

```bash
cd proyecto                               # client/ (Vue + Vite)  server/ (FastAPI + openapi.json)
atrezzo init                              # front=client, backend=server, contract=server/openapi.json
atrezzo import                            # endpoints desde server/openapi.json
atrezzo world atrezzo/escenarios/api.yaml
atrezzo serve --escenario api             # builtin: el backend no es JS, HTTP real en el puerto del front
```

### Caso 3: dos repos

Ejecuta `init` en el repo del front y apunta al otro con rutas relativas:

```bash
cd ~/code/web
atrezzo init --front . --backend ../api --contract ../api/openapi.yaml
atrezzo import                            # lee ../api/openapi.yaml
atrezzo world atrezzo/escenarios/api.yaml
```

Si el backend es Supabase en el otro repo, `--backend ../api` hace que `supabase` escriba en `../api/supabase/atrezzo/<escenario>/` (fuera de este repo: commitea allí o pon `--backend` a una carpeta propia).

### Ambigüedad: nunca una elección silenciosa

Si hay **dos candidatos a front o ninguno** (o más de un backend), `init` no escribe nada, imprime la tabla y sale con **2**:

```
atrezzo: No elijo por ti: hay 2 candidatos a front (apps/admin, apps/web).
Estructura: monorepo: package.json#workspaces · paquetes según apps/*
  paquete     front  backend  rol       motivos
  apps/admin      2        0  front     dep vue, dep vite
  apps/api        0        2  backend   dep express, nombre "api"
  apps/web        3        0  front     dep react, dep vite, nombre "web"
Indica el front y el backend: atrezzo init --front <ruta> --backend <ruta> [--contract <spec>]
```

```bash
atrezzo init --front apps/admin --backend apps/api
```

Con `--front`/`--backend` explícitos no se adivina nada; lo que no pases se toma de la detección solo si es único.

### Base de las rutas: front vs spec

El `servers[0].url` del spec puede ser relativo (`/api`) o absoluto (`https://api.x.com/v2`): `import` se queda con la ruta, la antepone a cada path y lo anota en el informe (`Base: /v2 (servers[0].url = "https://api.x.com/v2", absoluta: me quedo con la ruta)`). Si el front consume otro prefijo (`mock.apiPrefix`, p. ej. un proxy que reescribe `/api` → `/v2`), el informe lo avisa: reimporta con `--base /api`.
