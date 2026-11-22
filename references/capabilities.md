# Capacidades por runtime

Generado por `scripts/lib/capabilities.mjs` (`node scripts/cli.mjs capabilities --write`). No editar a mano.

`builtin` es el motor y el oráculo: siempre `✅`. ✅ igual · ◐ parcial y declinado el resto · ✖ no soportado y declarado · ⚠ **distinto sin avisar** (es lo que hay que cerrar).

| Capacidad | msw | supabase | prism | wiremock |
|---|---|---|---|---|
| `filters` · filtros (igualdad, `a,b`, `null`) | ✅ | ⚠ | ✖ | ◐ |
| `pgrst-operators` · operadores PostgREST (`eq.`, `in.()`, `ilike.`) | ✅ | ✅ | ✖ | ◐ |
| `pagination` · paginación (`limit`/`offset`/`page`) | ✅ | ⚠ | ✖ | ◐ |
| `sorts` · orden (`sort` y `sorts`) | ✅ | ⚠ | ⚠ | ◐ |
| `scopes` · scopes (parámetro → filtro booleano) | ✅ | ⚠ | ⚠ | ◐ |
| `envelope` · sobre (`envelope`, `pick`, `total_pages`) | ✅ | ⚠ | ✅ | ✅ |
| `singleton` · detalle y singleton (`shape: object`, `wrap`, `/:id`) | ✅ | ⚠ | ◐ | ✅ |
| `relations` · relaciones (`include`, `embed`, `counts`, `pluck`) | ✅ | ⚠ | ✅ | ✅ |
| `nested-routes` · rutas anidadas con varios parámetros | ✅ | ⚠ | ◐ | ◐ |
| `world-filters` · filtros de mundo y `$user` | ✅ | ⚠ | ✅ | ✅ |
| `writes` · escrituras y `reset` (`writes`) | ✅ | ⚠ | ✖ | ✖ |
| `rpc` · funciones `rpc` | ✅ | ⚠ | ✖ | ✖ |
| `streams` · SSE (`streams`) | ✖ | ⚠ | ✖ | ✖ |
| `passthrough-error` · `passthrough` y `error` | ✅ | ✅ | ✅ | ✅ |
| `latency` · latencia (`latency`) | ✅ | ⚠ | ⚠ | ⚠ |
| `diagnostic-headers` · cabeceras de diagnóstico (`X-Total-Count`, `X-Atrezzo-*`) | ✅ | ✖ | ◐ | ◐ |

## Por qué cada celda no es ✅

- **filters × supabase** (distinto): PostgREST compara con su propio tipo: `null` y las listas no son iguales
- **filters × prism** (no soportado (declarado)): no evalúa filtros: devuelve el ejemplo del spec
- **filters × wiremock** (parcial): igualdad de un valor; varias combinaciones acaban en 501
- **pgrst-operators × prism** (no soportado (declarado)): no evalúa operadores
- **pgrst-operators × wiremock** (parcial): un operador por mapping; el resto acaba en 501
- **pagination × supabase** (distinto): PostgREST pagina con `Range`; el `limit` de la query no es el mismo corte
- **pagination × prism** (no soportado (declarado)): ignora los parámetros de paginación
- **pagination × wiremock** (parcial): solo las páginas enumeradas en el flujo; el resto acaba en 501
- **sorts × supabase** (distinto): PostgREST ordena en SQL: los nulos y el `nullsfirst` no caen donde caen aquí
- **sorts × prism** (distinto): declara el parámetro y lo ignora: el orden es el del ejemplo
- **sorts × wiremock** (parcial): solo las peticiones que aparecen en los flujos
- **scopes × supabase** (distinto): el filtro tiene que existir en la vista; si no, PostgREST responde con su error
- **scopes × prism** (distinto): no evalúa el parámetro
- **scopes × wiremock** (parcial): un valor por scope
- **envelope × supabase** (distinto): la forma la dicta PostgREST (array o `{data,count}`), no el sobre
- **singleton × supabase** (distinto): `.single()` necesita `Accept: application/vnd.pgrst.object+json`
- **singleton × prism** (parcial): devuelve siempre la primera fila del ejemplo
- **relations × supabase** (distinto): el embed tiene que ser una FK real y la proyección se pide distinto
- **nested-routes × supabase** (distinto): cada segmento es una tabla o una vista
- **nested-routes × prism** (parcial): el patrón del spec no distingue los dos parámetros
- **nested-routes × wiremock** (parcial): el mapping solo fija el primer segmento; el resto da 404
- **world-filters × supabase** (distinto): el filtro por usuario lo pone RLS, no el escenario
- **writes × supabase** (distinto): escribe de verdad en Postgres: el reset del mundo no lo deshace
- **writes × prism** (no soportado (declarado)): no emite las rutas de escritura
- **writes × wiremock** (no soportado (declarado)): no emite las rutas de escritura
- **rpc × supabase** (distinto): la función tiene que existir en Postgres; el escenario no la crea
- **rpc × prism** (no soportado (declarado)): no emite el endpoint
- **rpc × wiremock** (no soportado (declarado)): no emite el endpoint
- **streams × msw** (no soportado (declarado)): un 501 explícito en la ruta del stream: el flujo ve el aviso, no los eventos
- **streams × supabase** (distinto): no hay SSE en PostgREST
- **streams × prism** (no soportado (declarado)): no emite el endpoint
- **streams × wiremock** (no soportado (declarado)): no emite el endpoint
- **latency × supabase** (distinto): la latencia la pone Postgres
- **latency × prism** (distinto): no aplica `latency`
- **latency × wiremock** (distinto): tiene `fixedDelayMilliseconds` pero el artefacto no lo usa
- **diagnostic-headers × supabase** (no soportado (declarado)): las cabeceras las pone PostgREST (`Content-Range`)
- **diagnostic-headers × prism** (parcial): solo el total del ejemplo, sin `X-Atrezzo-Ignored`
- **diagnostic-headers × wiremock** (parcial): total sí; `X-Atrezzo-Ignored` no
