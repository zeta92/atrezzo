---
name: capture
description: "Captures the API contract (OpenAPI, types, HAR) for atrezzo. Use it when you need to know which endpoints and fields a screen consumes before writing a scenario, or when the user provides an OpenAPI spec, a HAR or a traffic recording."
---

# /atrezzo:capture

Goal: the endpoints, parameters (filters, pagination, sorting) and fields **the client reads**, each with its source.

## With an OpenAPI spec: start with `atrezzo import`

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs import <openapi.yaml|json> --name <scenario> [--base /api]
# no argument: uses workspace.contract from atrezzo.config.json
```

- Writes `atrezzo/scenarios/<scenario>.yaml` with `world` (entities with typed `fields`, default counts), `endpoints` (path with the `servers[0].url` base, filters = query enums, `limit/offset` or `page` pagination, `pick` if the response is `{data: […]}`/`{items: […]}`) and `expect: []`.
- **Read the whole report and bring it to the user**: inferred endpoints, envelopes, `# TODO`s (GETs that do not return a collection), ignored routes with their reason (mutations, no schema, binary, nested) and notes (non-integer ids, a spec base that differs from the front-end prefix → `--base`).
- Exit 3 = the scenario is not valid yet (e.g. no inferable collection): complete the `# TODO`s by hand before `world`.
- Do not edit the data: adjust counts, distributions and `expect` (skill `/atrezzo:scene`) and regenerate with `world`.
- Then check against the client code (level 3 below): which fields it actually reads and which filters it sends. The spec says what the server promises, not what the screen uses.

Without an OpenAPI spec, follow the source order.

## Source order (do not skip levels)

1. **Declared contract**: OpenAPI/Swagger (→ `atrezzo import`), generated types (`supabase gen types`, GraphQL schema, zod). It is what the server *promises*.
2. **Real traffic**: a HAR or recording. It is what the server *does*.
3. **Client code**: last resort; it says what the client *assumes*.

## HAR: always with scripts

Never load the whole HAR into context. Summarize it with a local script and read only the summary. The script reads the HAR file from disk, makes no network requests, uploads nothing (the plugin ships no network client) and writes nothing: it parses each JSON response body only to list its field names, and prints method, path, status, query parameter names and field names. It never prints values, so tokens, cookies and personal data in bodies or headers stay out of the output and on the machine.

```bash
node -e '
const h=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const seen={};
for(const e of h.log.entries){const u=new URL(e.request.url);if(!/json/.test(e.response.content.mimeType||""))continue;
const k=e.request.method+" "+u.pathname.replace(/\/\d+(?=\/|$)/g,"/:id");
const s=seen[k]??={n:0,params:new Set(),keys:new Set(),status:new Set()};s.n++;s.status.add(e.response.status);
u.searchParams.forEach((_,p)=>s.params.add(p));
try{const b=JSON.parse(e.response.content.text||"null");const it=Array.isArray(b)?b[0]:b?.data?.[0]??b;Object.keys(it||{}).forEach(x=>s.keys.add(x));}catch{}}
for(const[k,s]of Object.entries(seen))console.log(k,"×"+s.n,"status",[...s.status],"params",[...s.params],"fields",[...s.keys]);
' traffic.har
```

The HAR and the summary stay local. If you save anything derived from them, keep only field names and shapes: no tokens, cookies or personal data.

## Output

- Write or update `atrezzo/scenarios/<name>.yaml` (format: `${CLAUDE_PLUGIN_ROOT}/references/scenario.md`) with `endpoints:` (path, entity, filters, pagination, sort, include). `world` generates the data; do not copy HAR responses as fixtures.
- Validate: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs world <file>` (exit 3 = invalid; the message names the field and the reason).
- **Flag gaps**: list the fields the client reads that the contract does not guarantee (nullable, optional, open enums, possibly empty arrays). Method and matrix in `${CLAUDE_PLUGIN_ROOT}/references/assumptions.md`. Propose a scenario with `nulls:` for each relevant gap.
