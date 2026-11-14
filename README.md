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

Requisitos: Node ≥ 22. Sin dependencias en tiempo de ejecución (parser YAML y servidor propios). Opcionales en el proyecto: `msw` (handlers en navegador/tests) y `playwright` (driver DOM).

## Skills

| comando | para qué |
|---|---|
| `/atrezzo:atrezzo` | router: decide qué skill usar y explica el bucle |
| `/atrezzo:atrezzo-init` | inspecciona el repo y ejecuta `init` (no instala nada sin decirlo) |
| `/atrezzo:atrezzo-captura` | contrato: OpenAPI/tipos → HAR (con scripts) → código; avisa de huecos |
| `/atrezzo:atrezzo-escena` | intención ("12 filas, 3 con incidencia") → escenario versionado |
| `/atrezzo:atrezzo-verifica` | sirve, verifica y diagnostica antes de tocar el escenario |
| `/atrezzo:atrezzo-desde-intencion` | "estoy en X, quiero Y" → ruta de estados, escenarios por paso, huecos |

> En Claude Code 2.1.319 el comando de una skill de plugin es `/<plugin>:<directorio>`; el `name:` del frontmatter no lo cambia. Por eso los comandos llevan el prefijo `atrezzo-` del directorio.

## CLI

```
node scripts/cli.mjs init [--dir .] [--install] [--force]
node scripts/cli.mjs world <escenario.yaml> [--out dir]
node scripts/cli.mjs serve [--escenario demo] [--port 4010] [--static dir]
node scripts/cli.mjs verify <flujo.yaml> [--url …] [--driver http|playwright] [--diagnose] [--no-reset] [--json]
node scripts/cli.mjs doctor
```

Códigos de salida: `0` OK · `1` aserción fallida · `2` no verificable (sin mock, sin playwright o aserción sin datos; **nunca** se reporta como OK) · `3` entrada inválida.

`serve` expone `GET /api/<recurso>?limit=&offset=&<filtros>`, el detalle `/<recurso>/:id`, `POST /__atrezzo/reset {"escenario":"x"}` y `GET /__atrezzo/state`. Usa el mismo motor (`scripts/lib/contract.mjs`) que los handlers MSW: `world` lo copia byte a byte como `runtime.mjs`.

## Estructura

```
.claude-plugin/plugin.json   manifiesto
skills/                      router + 5 skills
scripts/cli.mjs              CLI (bin: atrezzo)
scripts/lib/                 prng, yaml, world, scenario, contract, codegen, serve, verify, doctor, init, config
references/                  escenario.md · suposiciones.md · runtimes.md
examples/tienda/             ejemplo ejecutable end-to-end
tests/                       node --test tests/
```

## Ejemplo

Ver [`examples/tienda`](examples/tienda/README.md): `world` → `serve` → `verify --driver http` en verde, y `reset` entre escenarios sin reiniciar.

## Límites conocidos

- YAML: subconjunto (sin anclas/alias/multi-documento); el parser lo rechaza con línea y motivo.
- El driver `playwright` está probado con un `page` falso en los tests; con Playwright real depende de que el proyecto lo tenga instalado con Chromium.
- Errores HTTP, latencias y escrituras no son parte del mundo: se inyectan en el runtime (ver `references/runtimes.md`).
