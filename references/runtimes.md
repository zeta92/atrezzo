# Runtimes: dónde sirve el mock

atrezzo separa **qué datos** (mundo + proyección, en `runtime.mjs` y `<escenario>.json`) de **dónde se sirven**. El motor de proyección es un fichero sin dependencias; cualquier runtime que pueda llamar a `engine.handle({ method, pathname, query })` sirve los mismos bytes.

## Elegir

| situación | runtime | por qué |
|---|---|---|
| Front en navegador (Vite, Next cliente), tests de componentes, Storybook | **MSW** con `<escenario>.handlers.mjs` | intercepta `fetch` sin cambiar URLs; los handlers generados se commitean |
| Tests Node (vitest/jest) | **MSW** `setupServer` | mismo fichero de handlers |
| E2E, apps que no se pueden instrumentar, otros lenguajes | **`atrezzo serve`** | HTTP real, `reset` entre escenarios sin reiniciar |
| Hay OpenAPI fiable y solo quieres validar forma | **Prism** | valida peticiones/respuestas contra el spec; datos de ejemplo o dinámicos |
| Entorno Java/JVM, equipos QA con WireMock, proxies de grabación | **WireMock** | stubs JSON y grabación; carga `atrezzo serve` como upstream o mappings exportados |
| Supabase (PostgREST + GoTrue) | **fachada** sobre `atrezzo serve` o MSW | ver abajo |

### MSW

```js
// navegador (p. ej. src/main.ts, solo en desarrollo)
import { setupWorker } from 'msw/browser';
import { handlers } from '../atrezzo/.generated/conciliacion.handlers.mjs';
await setupWorker(...handlers).start({ onUnhandledRequest: 'bypass' });

// tests Node
import { setupServer } from 'msw/node';
const server = setupServer(...handlers);
```

Los handlers importan `<escenario>.json` con `with { type: 'json' }` (Node 22+, Vite, Next). Requiere `msw` en el proyecto (`atrezzo init --install`, anunciándolo).

### Prism

Útil como **segunda opinión**: arranca `prism mock openapi.yaml` y compara con `atrezzo serve` usando el mismo `flujo.yaml` (`verify --url`). Si Prism acepta lo que atrezzo devuelve, la proyección respeta el contrato; si no, el escenario usa campos que el spec no declara. También `prism proxy openapi.yaml http://127.0.0.1:4010` valida en vivo las respuestas de atrezzo contra el spec.

### WireMock

Dos opciones: (a) proxy: `{"request":{"urlPattern":"/api/.*"},"response":{"proxyBaseUrl":"http://127.0.0.1:4010"}}` y WireMock aporta latencias/fallos inyectados; (b) exportar: recorre los endpoints con las combinaciones de `flujo.yaml` y escribe mappings estáticos (pierdes filtros arbitrarios; solo las URLs grabadas).

Latencias, errores 5xx y timeouts no son parte del mundo: inyéctalos en el runtime (MSW `delay()`/`HttpResponse.error()`, WireMock `fault`), no en el escenario.

## Supabase: fachada PostgREST + GoTrue

supabase-js habla con `/<proyecto>/rest/v1/<tabla>` (PostgREST) y `/auth/v1/*` (GoTrue). No intentes reimplementar PostgREST: monta una **fachada fina** que traduzca lo que la app usa a la proyección de atrezzo.

1. **URL**: apunta `SUPABASE_URL` al mock (`http://127.0.0.1:4010`). La anon key puede ser cualquier JWT con formato válido.
2. **Rutas**: declara endpoints con el path que usa PostgREST:
   ```yaml
   endpoints:
     - path: /rest/v1/pedidos
       entity: pedidos
       filters: [estado, client_id]
       pagination: { param_limit: limit, param_offset: offset }
   ```
3. **Traducción de query** (la fachada, unas decenas de líneas delante de `engine.handle`):
   - `estado=eq.incidencia` → `estado=incidencia`; `estado=in.(a,b)` → `estado=a,b`.
   - `select=*,cliente:clientes(*)` → `include` del endpoint (decláralo; la fachada solo comprueba que coincide).
   - `order=creado_en.desc` → `sort` declarado en el endpoint (si difiere, que falle: el contrato es el escenario).
   - Cabecera `Range: 0-11` → `offset=0&limit=12`; responde `Content-Range: 0-11/<X-Total-Count>` cuando la app pide `count=exact`.
   - `Accept: application/vnd.pgrst.object+json` (`.single()`) → ruta de detalle o primer elemento; 406 si hay 0 o >1.
4. **GoTrue**: `POST /auth/v1/token?grant_type=password` devuelve una sesión fija generada desde `usuarios` del mundo (el `id` del usuario existe: integridad referencial). `GET /auth/v1/user` devuelve ese usuario. Nada de validar contraseñas: no es lógica del mock.
5. **RLS**: no la simules. Si la pantalla depende de que RLS filtre por usuario, modela el mundo *ya filtrado* para ese usuario (es lo que vería) y cubre RLS con tests contra un Supabase local (`supabase start`).
6. **Realtime/Storage**: fuera de alcance; stub vacío o servicio real local.

La fachada vive en el proyecto (`atrezzo/handlers/supabase.mjs`), importa `createEngine` del `runtime.mjs` generado y se registra como handler MSW (`http.get('*/rest/v1/:tabla', …)`) o como servidor Node delante de `engine.handle`.
