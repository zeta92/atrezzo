---
name: hueco
description: Rellena un hueco del mock atrezzo (la app pide una ruta que el escenario no declara) a partir del código que la consume y del contrato. Úsalo cuando el mock responde 404 con "atrezzo.miss", `atrezzo misses` o `doctor` muestran huecos sin resolver, "la app pide una ruta que no existe", "404 del mock", "mock incompleto", o falta un endpoint en el escenario.
---

# /atrezzo:hueco

CLI: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs` (abajo `atrezzo`). Formato del escenario: `${CLAUDE_PLUGIN_ROOT}/references/escenario.md` (sección "Tapar un hueco").

`atrezzo serve` registra en `atrezzo/.atrezzo/misses.json` cada petición que no casa con el contrato (deduplicada por `MÉTODO ruta`, ids colapsados a `:id`, secretos de la query como `***`) y responde:

```json
{ "error": "GET /api/users no está en el contrato del escenario \"catalogo\"",
  "atrezzo": { "miss": true, "hueco": "GET /api/users", "veces": 3,
               "siguiente": "atrezzo misses", "endpoints": ["/api/products"] } }
```

(405 con el mismo cuerpo si la ruta existe pero el método es una escritura.) Con `--on-miss stub` responde 200 con `[]`/`{}` y `x-atrezzo-stub: true`: sirve para explorar, **no tapa el hueco** (sigue sin resolver).

## El bucle (corto y verificable)

1. **Elige el hueco.** `atrezzo misses` → el de más `veces` **sin resolver**. La propuesta de cada línea te dice si el contrato ya lo tiene (`→ atrezzo import <spec>`: hazlo y salta al paso 5), si un escenario ya lo declara (solo falta `world` + reload) o si es una mutación. `atrezzo misses --json` da `query`, `referer` (qué pantalla lo pidió) y `accept`.

2. **Busca el consumidor.** En el front (`workspace.front` de la config si existe), busca la llamada:
   ```bash
   grep -rnE "fetch\(|axios|useQuery|useSWR|\\\$fetch|ky\.|apiClient|/api/users" src/ --include='*.{ts,tsx,js,jsx,vue,svelte}'
   ```
   Busca también el nombre del recurso sin prefijo (`users`, `"/users"`) y el cliente HTTP propio del proyecto (`api.get(`, `http.get(`, `client.users.list(`). Anota:
   - **método** y **ruta** (con o sin `:id`);
   - **query que envía**: solo esos parámetros serán `filters`/`pagination`;
   - **qué campos lee** de la respuesta (`u.nombre`, `data.items`, `res.total`, destructuring, columnas de tabla, tipos TS del componente). **Esos campos definen el esquema; no se inventan.**
   - si lee `res.data` / `res.items` → hay **envoltorio** (`shape: envelope` + `pick`).

3. **Contrato primero.** Si hay OpenAPI o tipos del backend (`workspace.contract`, `src/types/database.ts`, DTOs), son la fuente de verdad del shape (nombres, tipos, enums). El código del front solo añade lo que el contrato no dice (qué filtros usa de verdad, cuántas filas espera la pantalla). Si contrato y front discrepan, dilo: es un bug real, no algo que el mock deba tapar.

4. **Parchea el escenario** (`atrezzo/escenarios/<escenario>.yaml`, el que nombra el 404). Nunca escribas el JSON de datos: el mundo los genera.
   ```yaml
   world:
     clientes: 3                       # ya estaba
     usuarios:                         # entidad nueva (o reutiliza una existente)
       total: 8
       ref: clientes                   # solo si el front lee u.cliente.*  → client_id + include
       campos:                         # SOLO los campos que el front lee (con campos, la plantilla
         nombre: texto                 #   de la entidad se sustituye entera; sin campos, usuarios
         email: email                  #   trae nombre, email, rol, creado_en)
         rol: [admin, operador]        # lista = enum (valores que el front distingue)
         avatar_url: url
   endpoints:
     - path: /api/users                # exactamente la ruta del hueco
       entity: usuarios
       filters: [rol]                  # solo los parámetros que el front ENVÍA
       pagination: { param_limit: limit, param_offset: offset }   # solo si los envía
       include: [clientes]             # embebe "cliente" (requiere el ref)
       shape: envelope                 # si lee res.items / res.data…
       pick: items                     #   …con esa clave → { items, total, limit, offset }
   ```
   Tipos de `campos`: texto, entero, numero, booleano, fecha, email, uuid, url o lista (enum).
   Detalle (`/api/users/:id`) va incluido por defecto (`detail: true`). Ruta anidada (`/api/clientes/:id/pedidos`): no se proyecta; usa la colección con filtro (`/api/orders?client_id=`) si el front puede, o déjalo anotado como limitación.

5. **Genera y recarga.** `atrezzo world atrezzo/escenarios/<escenario>.yaml` (revisa el resumen: entidad y `GET /api/users` en "Endpoints cubiertos") y `curl -s -X POST <mock>/__atrezzo/reload` (relee el YAML sin reiniciar `serve`; devuelve el mismo resumen que `reset`, con `generado: "al día"`). Si no hay serve corriendo, reinícialo.

6. **Verifica que el hueco desaparece.** `atrezzo verify <flujo.yaml>` (si el flujo cubre esa pantalla) o recarga la pantalla. Después `atrezzo misses`: la línea debe decir **resuelta** (se marca sola cuando el mock sirve la ruta). Si sigue "sin resolver", la app pide otra cosa (prefijo distinto, barra final, otro método): compara `ejemplo` de `misses --json` con el `path` del escenario.

7. **Mutaciones (POST/PUT/PATCH/DELETE).** Dilo explícitamente: atrezzo solo proyecta lecturas. Opciones: `atrezzo serve --on-miss stub` (200 `{}` para que la pantalla no reviente; no persiste nada) o dejarlo sin resolver y anotarlo. No inventes lógica de negocio en el mock.

## Informe

Hueco elegido (`MÉTODO ruta`, veces) · consumidor (`fichero:línea`) · campos leídos y de dónde sale cada uno (contrato o front) · diff del escenario · salida de `world` · `misses` antes y después. Si no lo has podido resolver, el motivo real.
