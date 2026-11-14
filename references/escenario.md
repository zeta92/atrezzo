# Especificación del fichero de escenario

Un escenario es un YAML versionado que describe **un estado de la aplicación**: el mundo de datos, cómo lo ven los endpoints, la ruta de pantallas y lo que debe verse. `atrezzo world` lo valida de forma estricta: cualquier error dice el **campo** y el **motivo** y sale con código 3.

## Ejemplo completo

```yaml
name: conciliacion-con-incidencias   # obligatorio, kebab-case; nombre del escenario
description: Texto libre para humanos # opcional
seed: 7712                            # obligatorio, entero >= 0
now: 2025-03-01T09:00:00Z             # opcional; "ahora" inyectado (por defecto 2025-01-15T09:00:00Z)
world:
  clientes: 3                         # forma corta: solo el total
  pedidos:
    total: 40
    distribucion: { pagado: 34, pendiente: 3, incidencia: 3 }   # suma == total
    valor: { min: 20, max: 900, moneda: EUR }
    ref: clientes                     # opcional: pedidos ya referencia clientes por defecto
    nulos: { client_id: 0 }           # opcional: n registros con el campo a null
    dias: 90                          # opcional: ventana de fechas hacia atrás desde now
  usuarios:
    total: 4
    valores: { rol: [admin, operador, lectura] }   # opcional: vocabulario de un campo
endpoints:
  - path: /api/orders
    entity: pedidos
    filters: [estado, client_id]      # ?estado=incidencia  ·  ?estado=pendiente,incidencia
    pagination: { param_limit: limit, param_offset: offset, default_limit: 50, max_limit: 100 }
    sort: -creado_en                  # o lista: [estado, -importe]; por defecto id
    include: [clientes]               # embebe el padre como "cliente"
    shape: array                      # array (por defecto) | envelope → { data, total, limit, offset }
    detail: true                      # genera también /api/orders/:id (por defecto true)
  - path: /api/customers
    entity: clientes
entry: dashboard-vacio
path: [dashboard-vacio, lista-pedidos, conciliacion]
expect:
  - selector: "[data-testid=order-row]"
    count: 12
    data: { request: pedidos }
  - selector: "[data-testid=badge-incidencia]"
    min: 1
    max: 3
    screen: lista-pedidos             # por defecto, la última pantalla de path
    data: { request: incidencias, where: { estado: incidencia } }
```

## Campos

### Raíz
| campo | tipo | regla |
|---|---|---|
| `name` | texto | obligatorio, `^[a-z0-9][a-z0-9-]*$` |
| `seed` | entero | obligatorio, >= 0 |
| `now` | fecha ISO | opcional; todas las fechas se calculan desde aquí |
| `world` | mapa | obligatorio, al menos una entidad |
| `endpoints` | lista | obligatoria, al menos uno |
| `entry` | texto | opcional; si hay `path`, debe ser su primer elemento |
| `path` | lista de textos | opcional; pantallas en orden |
| `expect` | lista | opcional |

Cualquier otro campo es un error (`campo desconocido`).

### Entidades (`world.<nombre>`)
Entero (= `total`) o mapa con: `total` (obligatorio), `distribucion`, `campo_distribucion` (por defecto `estado`), `valor`, `ref`, `nulos`, `valores`, `dias`.

Plantillas conocidas y sus campos:

| entidad | campos |
|---|---|
| `clientes` (`customers`) | id, nombre, email, ciudad, creado_en |
| `usuarios` (`users`) | id, nombre, email, rol, creado_en |
| `pedidos` (`orders`) | id, referencia, client_id, estado, importe, moneda, creado_en |
| `productos` (`products`) | id, nombre, sku, precio, moneda, stock |
| cualquier otra | id, nombre, `<fk de sus refs>`, creado_en |

Garantías del generador:
- ids enteros 1..n.
- `distribucion` exacta (no aproximada) y barajada con la semilla.
- Cada fk existe; si hay al menos tantos hijos como padres, todo padre tiene algún hijo.
- Un hijo nunca es anterior a su padre (`creado_en`).
- Cada entidad usa su propio flujo del PRNG: añadir una entidad no cambia las demás.

### Endpoints
`path` (empieza por `/`, sin query ni `:param`), `entity` (obligatoria, declarada en `world`), `filters` (campos existentes), `pagination`, `sort`, `include` (solo entidades referenciadas), `shape`, `detail`.

Semántica de la proyección (idéntica en `serve` y en los handlers MSW, mismo fichero `runtime.mjs`):
1. Filtros por igualdad; coma = cualquiera de los valores; `null` filtra nulos.
2. Orden por `sort`, nulos al final, desempate por posición original (estable).
3. `X-Total-Count` = total tras filtros, antes de paginar.
4. `limit` mayor que el total ⇒ todo; `offset` fuera de rango ⇒ `[]`; valores no enteros ⇒ 400.
5. Parámetros no declarados se ignoran y se listan en `X-Atrezzo-Ignored`.
6. Solo GET/HEAD. Escrituras ⇒ 405: el mock da forma a los datos, no implementa reglas de negocio.

### Aserciones (`expect`)
| campo | regla |
|---|---|
| `selector` | obligatorio, CSS |
| `count` | entero exacto; excluyente con `min`/`max` |
| `min`, `max` | enteros; `min <= max` |
| `screen` | pantalla de `path` |
| `data.request` | nombre de una petición del paso del flujo |
| `data.where` | mapa campo: valor (o lista) para contar en el JSON |
| `data.pick` | ruta al array (`data.items`); por defecto array raíz o `data` |
| `label` | texto para el informe |

Con `--driver http` una aserción sin `data` queda **sin verificar** (exit 2), nunca OK.

## Fichero de flujo (`flujo.yaml`)

```yaml
escenario: escenarios/pedidos.yaml    # relativa al flujo (opcional: ver «App real» abajo)
base_url: http://127.0.0.1:4010       # opcional (si no, --url o config)
viewport: { width: 1440, height: 1000 }  # opcional, solo playwright (por defecto 1280x720)
headers:                              # opcional: se envían en TODAS las peticiones del flujo
  Cookie: "${APP_COOKIE}"             # ${VAR} se toma del entorno; no commitees secretos
steps:
  - screen: lista-pedidos
    visit: /pedidos                   # ruta para playwright
    headers: { Accept-Language: es-ES }  # opcional; se mezclan con las del flujo
    wait_for: "[data-testid=listo]"   # opcional; espera a que el elemento exista (no a que sea visible)
    requests:                         # peticiones equivalentes para el driver http
      pedidos: GET /api/orders?limit=12
      incidencias: GET /api/orders?estado=incidencia
    expect: [ … ]                     # aserciones propias del paso
```

Las aserciones del escenario se añaden al paso de su `screen` (por defecto la última de `path`).

### Cabeceras (`headers`)

- A nivel de flujo y/o de paso. Cabeceras efectivas de un paso = las del flujo + las del paso; si se repite un nombre (sin distinguir mayúsculas) gana el paso.
- Driver `playwright`: `context.setExtraHTTPHeaders()` con las cabeceras efectivas antes de abrir cada `visit` (las recibe toda petición de la página: documento, fetch, RSC…). Driver `http`: las mismas cabeceras en cada `fetch` de `requests`.
- `${NOMBRE}` en un valor se sustituye por la variable de entorno. Si no está definida, el flujo es inválido (exit 3) en vez de enviar una cabecera vacía.
- Secretos: `Cookie`, `Authorization`, `Proxy-Authorization`, `X-Api-Key` y cualquier nombre que contenga `token`, `secret`, `session`, `auth`, `password` o `api-key` se muestran como `***` en la tabla, en `--json` y en los mensajes de error. Los valores no se escriben nunca en logs.
- Valores: texto de una línea (números y booleanos se convierten a texto). Nombres según RFC 7230.

### App real (sin `escenario`)

Si el flujo no declara `escenario`, `verify` no hace `reset` ni compara hashes: verifica la app tal cual está en `base_url` (útil para validar los selectores contra la app de verdad, con su sesión en `headers`). Las aserciones `data` siguen funcionando si la app expone el JSON.

### Navegación con playwright: nunca verde por accidente

Tras abrir `visit`, si la URL final es otra ruta (p. ej. redirect a `/login` por falta de sesión), la respuesta es HTTP ≥ 400 o `wait_for` no aparece en 10 s, **todas las aserciones del paso son KO** aunque el conteo cuadre (un `count: 0` en la pantalla de login no es un OK). El informe dice a dónde redirigió y, con `--diagnose`, añade la hipótesis `navegacion`.

## Subconjunto YAML soportado

Mapas y listas en bloque (solo espacios), colecciones `{…}` y `[…]` en una línea, comillas simples y dobles, `null`/`~`, booleanos, números, bloques `|` y `>`, comentarios. No se aceptan anclas, alias, etiquetas ni varios documentos: el parser lo dice con número de línea.

## Códigos de salida
`0` OK · `1` aserción fallida · `2` no verificable (falta mock, playwright/Chromium o `data`) · `3` entrada inválida.
