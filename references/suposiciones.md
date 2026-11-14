# Schema prometido vs. cliente asumido

Un mock que solo cumple el schema hace pasar pantallas que romperán en producción. El hueco peligroso no es "el schema está mal", sino **lo que el cliente da por hecho y el schema no garantiza**. Este documento es el método para encontrarlo y convertirlo en escenarios.

## Tres fuentes, tres verdades

| fuente | dice | ejemplo |
|---|---|---|
| Contrato (OpenAPI, tipos, migraciones) | lo que el servidor **promete** | `email: string \| null` |
| Tráfico (HAR) | lo que el servidor **suele hacer** | en el HAR nunca vino `null` |
| Código del cliente | lo que el cliente **asume** | `user.email.toLowerCase()` |

Un hueco es un campo donde el cliente asume más de lo que el contrato promete. El tráfico no cierra el hueco: solo explica por qué nadie lo ha visto aún.

## Método

1. **Inventario de lecturas**: por pantalla, lista los campos que el cliente lee del JSON. Con scripts, no a ojo:
   ```bash
   grep -rnoE '\b(order|pedido|item|row|cliente|user)\??\.[a-zA-Z_]+(\??\.[a-zA-Z_]+)*' src | sort | uniq -c | sort -rn | head -80
   ```
2. **Para cada lectura, busca la garantía** en el contrato: ¿required?, ¿nullable?, ¿enum cerrado?, ¿minItems?, ¿formato/precisión?
3. **Busca la guarda en el cliente**: `?.`, `?? valor`, `if (x)`, `.length ?`, `default:` en el switch, `toFixed` con redondeo explícito.
4. **Clasifica** cada lectura en la matriz de abajo.
5. **Convierte cada celda roja en un escenario** (o en `nulos:` de uno existente) con su aserción. Escribe el hueco en el escenario como comentario: `# hueco: cliente.email puede ser null y la fila lo usa sin guarda`.

## Patrones a buscar

| patrón | señal en el código | qué no garantiza el schema | escenario que lo destapa |
|---|---|---|---|
| Campo nulo sin guarda | `x.campo.metodo()`, `x.campo.length`, plantilla `{x.campo}` que pinta "null" | `nullable: true` o campo no `required` | `nulos: { campo: 1 }` + aserción de filas |
| Array asumido no vacío | `items[0].`, `reduce` sin inicial, `Math.max(...arr)` | sin `minItems: 1` | entidad con `total: 0` (estado vacío) |
| Enum cerrado | `switch` sin `default`, mapa `ICONOS[estado]` sin fallback, tipos `'a' \| 'b'` | enum abierto o string libre | `distribucion` con un valor nuevo (`en_revision: 1`) |
| Redondeos | sumas en cliente de importes, `toFixed(2)` tras sumar, comparación `===` de decimales | precisión, moneda, decimal vs. float | `valor` con rango que fuerce céntimos; aserción sobre el total pintado |
| Unicidad de id | `key={id}`, deduplicación con `Map` | ids únicos por página/entre páginas | paginar con `limit` pequeño y comparar con `X-Total-Count` |
| Orden implícito | "el primero es el más reciente" sin `sort` en la petición | orden no especificado | `sort:` distinto en el endpoint |
| Página completa | "si vienen < limit, no hay más" | tamaño de página exacto | `total` múltiplo exacto de `limit` |
| Relación siempre presente | `pedido.cliente.nombre` | fk nullable / join opcional | `nulos: { client_id: 1 }` con `include` |

## Matriz schema-válido × cliente-asumido

|  | **El cliente lo guarda** (guarda, fallback, default) | **El cliente lo asume** (sin guarda) |
|---|---|---|
| **El schema lo garantiza** (required, minItems, enum cerrado) | OK. Guarda redundante; no hace falta escenario. | OK mientras el contrato se respete. Escenario de contrato: si el backend cambia, `captura` lo detecta. |
| **El schema no lo garantiza** (nullable, opcional, enum abierto) | OK. Un escenario de regresión para que la guarda no se pierda. | **HUECO.** Escenario obligatorio que lo provoque + aserción. Decide: guarda en el cliente o garantía en el contrato. |

Solo la celda inferior derecha es un bug latente. El resto es documentación.

## Qué no hace atrezzo aquí

atrezzo no "arregla" la suposición haciendo que el mock nunca devuelva `null`: eso esconde el hueco. Tampoco aplica reglas de negocio para fabricar coherencia (p. ej. recalcular un total): si la pantalla depende de una regla de negocio, esa regla vive en el backend y se prueba allí. El mock produce los estados válidos según el schema; la verificación muestra qué hace la pantalla con ellos.

## Cómo lo usa `verify --diagnose`

Las hipótesis `campo-nulo`, `deduplicacion-por-id`, `paginacion-desalineada` y `filtro-en-cliente` son las celdas de esta matriz vistas desde el síntoma (faltan filas). Cuando aparecen, vuelve aquí y clasifica el campo antes de cambiar nada.
