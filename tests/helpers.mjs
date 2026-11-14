import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(ROOT, 'scripts', 'cli.mjs');

export const SCENARIO = `name: conciliacion
seed: 7712
now: 2025-03-01T09:00:00Z
world:
  clientes: 3
  pedidos:
    total: 40
    distribution: { pagado: 34, pendiente: 3, incidencia: 3 }
    amount: { min: 20, max: 900, currency: EUR }
  usuarios: 2
endpoints:
  - path: /api/orders
    entity: pedidos
    filters: [estado, client_id]
    pagination: { param_limit: limit, param_offset: offset }
  - path: /api/customers
    entity: clientes
entry: dashboard
path: [dashboard, lista]
expect:
  - selector: "[data-testid=order-row]"
    count: 12
    data: { request: pedidos }
  - selector: "[data-testid=badge-incidencia]"
    count: 3
    data: { request: incidencias, where: { estado: incidencia } }
`;

export const SMALL = `name: pequeno
seed: 99
world:
  clientes: 1
  pedidos: { total: 5, distribution: { pagado: 4, incidencia: 1 } }
endpoints:
  - path: /api/orders
    entity: pedidos
    filters: [estado]
    pagination: { param_limit: limit, param_offset: offset }
  - path: /api/customers
    entity: clientes
`;

export const FLOW = `scenario: escenarios/conciliacion.yaml
steps:
  - screen: dashboard
    visit: /
    requests:
      clientes: GET /api/customers
    expect:
      - selector: "[data-testid=customer-chip]"
        count: 3
  - screen: lista
    visit: /lista
    requests:
      pedidos: GET /api/orders?limit=12
      incidencias: GET /api/orders?estado=incidencia
`;

/** Temp project with the given files. */
export function tmpProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atrezzo-test-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

export function cli(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Async variant: required when the child talks to a server running in this process
 * (spawnSync would block our event loop and deadlock). */
export function cliAsync(args, cwd, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => ok({ code, stdout, stderr }));
  });
}
