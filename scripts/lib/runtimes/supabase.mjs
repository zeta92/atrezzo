// supabase: there is no mock layer in Supabase — its API is PostgREST over
// Postgres. So the "runtime" is the database itself: we emit schema.sql (minimal
// tables, only if missing), seed.sql (idempotent truncate + inserts of the world)
// and reset.sh. Filtering/pagination are then PostgREST's, not atrezzo's.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { columnInfo, entityOrder, metaFrom, p } from './common.mjs';

function signals(ctx) {
  const out = [];
  const toml = ctx.files('supabase/config.toml');
  if (toml.length) out.push({ text: `${toml[0]} (proyecto Supabase CLI)`, weight: 3 });
  const dep = ctx.dep('@supabase/supabase-js');
  if (dep) out.push({ text: `@supabase/supabase-js en ${dep}`, weight: 2 });
  if (!toml.length) {
    const dir = ctx.files('supabase');
    if (dir.length) out.push({ text: `carpeta ${dir[0]}/`, weight: 2 });
  }
  const envKey = Object.keys(ctx.env).sort().find((k) => /SUPABASE_URL$/.test(k));
  if (envKey) out.push({ text: `${envKey} en ${ctx.env[envKey].file}`, weight: 2 });
  return out;
}

export const meta = metaFrom({
  id: 'supabase',
  label: 'Supabase (seed.sql para Postgres + PostgREST)',
  signals,
  none: 'sin supabase/, @supabase/supabase-js ni SUPABASE_URL',
  startHint: 'DATABASE_URL=… <dir>/reset.sh (Supabase CLI o Postgres + PostgREST local)',
});

const PG_TYPE = { integer: 'bigint', number: 'numeric', boolean: 'boolean', datetime: 'timestamptz', string: 'text' };
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Where the files go: next to <backend>/supabase if it exists, else under generatedDir. */
export function outDir({ config, dir, dataset }) {
  const backend = config.workspace?.backend;
  for (const base of [backend && backend !== '.' ? p(backend, 'supabase') : null, 'supabase']) {
    if (base && existsSync(join(dir, base))) return p(base, 'atrezzo', dataset.scenario);
  }
  return p(config.generatedDir, 'supabase', dataset.scenario);
}

function header(dataset, what) {
  return [
    `-- Generado por atrezzo (${what}). No editar a mano: cambia el escenario y ejecuta \`atrezzo world\`.`,
    `-- Escenario: ${dataset.scenario} · semilla ${dataset.seed} · now ${dataset.now} · hash ${dataset.hash}`,
  ];
}

export function schemaSql(dataset) {
  const order = entityOrder(dataset);
  const out = [...header(dataset, 'esquema mínimo'),
    '-- Solo para una base de datos LOCAL sin migraciones. CREATE TABLE IF NOT EXISTS no toca',
    '-- tablas que ya existan: si tus migraciones las crean con otras columnas, seed.sql fallará',
    '-- con "column ... does not exist" (y eso es lo correcto: el escenario no coincide con tu esquema).',
    '',
    'SET client_min_messages = warning;',
    ''];
  for (const name of order) {
    const meta = dataset.schema[name];
    const rows = dataset.entities[name];
    const cols = meta.fields.map((f) => {
      if (f === 'id') return `  ${ident('id')} bigint PRIMARY KEY`;
      const info = columnInfo(rows, f);
      const ref = meta.refs[f];
      return `  ${ident(f)} ${PG_TYPE[info.type]}${info.nullable || !rows.length ? '' : ' NOT NULL'}${ref ? ` REFERENCES ${ident(ref)} (${ident('id')})` : ''}`;
    });
    out.push(`CREATE TABLE IF NOT EXISTS ${ident(name)} (`, cols.join(',\n'), ');', '');
  }
  out.push('-- PostgREST/Supabase: lectura para el rol anónimo si existe (Supabase lo crea; PostgREST suelto, según tu config).',
    'DO $$',
    'BEGIN',
    "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN",
    `    GRANT SELECT ON ${order.map(ident).join(', ')} TO anon;`,
    '  END IF;',
    'END',
    '$$;', '');
  return out.join('\n');
}

export function seedSql(dataset) {
  const order = entityOrder(dataset);
  const out = [...header(dataset, 'datos'),
    '-- Idempotente: vacía las tablas del escenario y vuelve a insertar el mundo con ids estables.',
    '-- TRUNCATE ... CASCADE vacía también las tablas que referencien a estas: úsalo solo en local.',
    '',
    'SET client_min_messages = warning;',
    'BEGIN;',
    `TRUNCATE TABLE ${[...order].reverse().map(ident).join(', ')} RESTART IDENTITY CASCADE;`,
    ''];
  for (const name of order) {
    const { fields } = dataset.schema[name];
    const rows = dataset.entities[name];
    out.push(`-- ${name}: ${rows.length} filas`);
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      // OVERRIDING SYSTEM VALUE: works with GENERATED ALWAYS identity ids too.
      out.push(`INSERT INTO ${ident(name)} (${fields.map(ident).join(', ')}) OVERRIDING SYSTEM VALUE VALUES`);
      out.push(`${chunk.map((r) => `  (${fields.map((f) => sqlLiteral(r[f])).join(', ')})`).join(',\n')};`);
    }
    // If the real table has a serial/identity id, move the sequence past our ids.
    const seq = `pg_get_serial_sequence('${ident(name).replace(/'/g, "''")}', 'id')`;
    out.push(`DO $$ BEGIN PERFORM setval(${seq}, GREATEST((SELECT max(${ident('id')}) FROM ${ident(name)}), 1)) WHERE ${seq} IS NOT NULL; END $$;`);
    out.push('');
  }
  out.push('COMMIT;', '');
  return out.join('\n');
}

function resetSh(dataset, total) {
  return `#!/usr/bin/env sh
# Generado por atrezzo. Restaura el escenario "${dataset.scenario}" (hash ${dataset.hash}) en un Postgres LOCAL.
# Idempotente: se puede ejecutar las veces que quieras (CREATE IF NOT EXISTS + TRUNCATE + INSERT).
set -eu
: "\${DATABASE_URL:=postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$DATABASE_URL" in
  *localhost*|*127.0.0.1*|*@db:*|*@postgres:*|*host.docker.internal*) ;;
  *)
    if [ "\${ATREZZO_ALLOW_REMOTE:-}" != "1" ]; then
      echo "atrezzo: DATABASE_URL no parece local y este script hace TRUNCATE. Exporta ATREZZO_ALLOW_REMOTE=1 si de verdad quieres." >&2
      exit 2
    fi ;;
esac
command -v psql >/dev/null 2>&1 || { echo "atrezzo: falta psql (cliente de PostgreSQL)" >&2; exit 2; }
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$here/schema.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$here/seed.sql"
echo "atrezzo: escenario ${dataset.scenario} restaurado (${total} filas)"
`;
}

function readme(dataset, dir) {
  const tables = Object.keys(dataset.schema);
  const ep = dataset.endpoints.map((e) => `| \`${e.path}\` | \`/rest/v1/${e.entity}\`${e.filters.length ? ` (\`?${e.filters[0]}=eq.<valor>\`)` : ''} |`).join('\n');
  return `# Escenario \`${dataset.scenario}\` para Supabase

Generado por atrezzo (hash \`${dataset.hash}\`). Supabase no tiene capa de mock: su API es PostgREST sobre Postgres,
así que el "mock" es **la base de datos local con el mundo cargado**. Tablas: ${tables.map((t) => `\`${t}\``).join(', ')}.

| fichero | qué hace |
|---|---|
| \`schema.sql\` | \`CREATE TABLE IF NOT EXISTS\` mínimo (solo si no tienes migraciones) |
| \`seed.sql\` | \`TRUNCATE … RESTART IDENTITY CASCADE\` + \`INSERT\` con ids estables, en una transacción |
| \`reset.sh\` | aplica ambos con \`psql\`; se niega a tocar una \`DATABASE_URL\` no local |

## Opción A: Supabase CLI (recomendada)

\`\`\`bash
supabase start                        # Postgres en :54322, API en :54321 (PostgREST + GoTrue)
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres ${dir}/reset.sh
\`\`\`

O deja que \`supabase db reset\` lo cargue: en \`supabase/config.toml\`, \`[db.seed]\` → \`sql_paths = ["./atrezzo/${dataset.scenario}/seed.sql"]\`
(la ruta es relativa a \`supabase/\`; comprueba que tu versión del CLI soporta \`sql_paths\`). Tu \`supabase/seed.sql\` no se toca.

## Opción B: Postgres + PostgREST sueltos

\`\`\`bash
docker run -d --name atrezzo-pg -e POSTGRES_PASSWORD=postgres -p 54322:5432 postgres:16
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres ${dir}/reset.sh
docker run --rm -p 3000:3000 -e PGRST_DB_URI=postgresql://postgres:postgres@host.docker.internal:54322/postgres \\
  -e PGRST_DB_ANON_ROLE=postgres -e PGRST_DB_SCHEMAS=public postgrest/postgrest
# GoTrue (auth) no viene incluido: si la app necesita sesión, usa la opción A.
\`\`\`

## Qué cambia respecto a \`atrezzo serve\`

| escenario | PostgREST |
|---|---|
${ep}

- Las rutas del escenario (\`${dataset.endpoints[0]?.path ?? '/api/…'}\`) **no existen** aquí: supabase-js consulta \`/rest/v1/<tabla>\`.
- Filtros, orden, paginación (\`Range\`, \`limit/offset\`) y joins (\`select=*,cliente:clientes(*)\`) los resuelve PostgREST, no el motor de atrezzo.
  Los datos son los mismos (mismos ids y filas); la proyección no es byte a byte la de \`serve\`.
- RLS: si tus migraciones activan RLS, el rol \`anon\` solo verá lo que permitan tus políticas. atrezzo no simula RLS.
- Auth/Storage/Realtime: fuera de alcance; vienen del Supabase local de la opción A.
`;
}

export function emit({ dataset, config, dir }) {
  const out = outDir({ config, dir, dataset });
  const total = Object.values(dataset.entities).reduce((s, r) => s + r.length, 0);
  return {
    files: [
      { path: p(out, 'schema.sql'), content: schemaSql(dataset) },
      { path: p(out, 'seed.sql'), content: seedSql(dataset) },
      { path: p(out, 'reset.sh'), content: resetSh(dataset, total), mode: 0o755 },
      { path: p(out, 'README.md'), content: readme(dataset, out) },
    ],
    start: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres ${out}/reset.sh   (tras supabase start)`,
    notes: [
      `${total} filas en ${Object.keys(dataset.entities).length} tablas; ids estables 1..n (los mismos que en serve/msw)`,
      'la app consulta /rest/v1/<entidad> (PostgREST): las rutas del escenario no se usan; filtros y paginación los hace PostgREST',
      'no simula RLS ni auth: con RLS activa, el rol anon solo ve lo que permitan tus políticas',
      out.startsWith(p(config.generatedDir)) ? 'no hay carpeta supabase/: ficheros en .generated (pasa --backend si vive en otro sitio)' : `junto a ${out.split('/atrezzo/')[0]}; tu supabase/seed.sql no se toca`,
    ],
  };
}
