---
name: atrezzo-captura
description: Captura el contrato de la API (OpenAPI, tipos, HAR) para atrezzo. Úsalo cuando haya que saber qué endpoints y campos consume una pantalla antes de escribir un escenario, o el usuario aporte un OpenAPI, un HAR o una grabación de tráfico.
---

# /atrezzo:atrezzo-captura

Objetivo: endpoints, parámetros (filtros, paginación, orden) y campos que **el cliente lee**, con su fuente.

## Orden de fuentes (no te saltes niveles)

1. **Contrato declarado**: OpenAPI/Swagger, tipos generados (`supabase gen types`, GraphQL schema, zod). Es lo que el servidor *promete*.
2. **Tráfico real**: HAR o grabación. Es lo que el servidor *hace*.
3. **Lectura de código** del cliente: último recurso; dice lo que el cliente *asume*.

## HAR: siempre con scripts

Nunca metas el HAR entero en contexto. Resume con un script y lee solo el resumen:

```bash
node -e '
const h=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const seen={};
for(const e of h.log.entries){const u=new URL(e.request.url);if(!/json/.test(e.response.content.mimeType||""))continue;
const k=e.request.method+" "+u.pathname.replace(/\/\d+(?=\/|$)/g,"/:id");
const s=seen[k]??={n:0,params:new Set(),keys:new Set(),status:new Set()};s.n++;s.status.add(e.response.status);
u.searchParams.forEach((_,p)=>s.params.add(p));
try{const b=JSON.parse(e.response.content.text||"null");const it=Array.isArray(b)?b[0]:b?.data?.[0]??b;Object.keys(it||{}).forEach(x=>s.keys.add(x));}catch{}}
for(const[k,s]of Object.entries(seen))console.log(k,"×"+s.n,"status",[...s.status],"params",[...s.params],"campos",[...s.keys]);
' trafico.har
```

Elimina tokens, cookies y datos personales de cualquier cosa que guardes.

## Salida

- Escribe o actualiza `atrezzo/escenarios/<nombre>.yaml` (formato: `${CLAUDE_PLUGIN_ROOT}/references/escenario.md`) con `endpoints:` (path, entity, filters, pagination, sort, include). Los datos los genera `world`; no copies respuestas del HAR como fixtures.
- Valida: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs world <fichero>` (exit 3 = inválido, el mensaje dice campo y motivo).
- **Avisa de huecos**: lista los campos que el cliente lee y el contrato no garantiza (nullable, opcionales, enums abiertos, arrays posiblemente vacíos). Método y matriz en `${CLAUDE_PLUGIN_ROOT}/references/suposiciones.md`. Propón un escenario con `nulos:` para cada hueco relevante.
