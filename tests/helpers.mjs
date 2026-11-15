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
  customers: 3
  orders:
    total: 40
    distribution: { paid: 34, pending: 3, issue: 3 }
    amount: { min: 20, max: 900, currency: EUR }
  users: 2
endpoints:
  - path: /api/orders
    entity: orders
    filters: [status, customer_id]
    pagination: { param_limit: limit, param_offset: offset }
  - path: /api/customers
    entity: customers
entry: dashboard
path: [dashboard, lista]
expect:
  - selector: "[data-testid=order-row]"
    count: 12
    data: { request: orders }
  - selector: "[data-testid=badge-issue]"
    count: 3
    data: { request: issues, where: { status: issue } }
`;

export const SMALL = `name: pequeno
seed: 99
world:
  customers: 1
  orders: { total: 5, distribution: { paid: 4, issue: 1 } }
endpoints:
  - path: /api/orders
    entity: orders
    filters: [status]
    pagination: { param_limit: limit, param_offset: offset }
  - path: /api/customers
    entity: customers
`;

export const FLOW = `scenario: scenarios/conciliacion.yaml
steps:
  - screen: dashboard
    visit: /
    requests:
      customers: GET /api/customers
    expect:
      - selector: "[data-testid=customer-chip]"
        count: 3
  - screen: lista
    visit: /lista
    requests:
      orders: GET /api/orders?limit=12
      issues: GET /api/orders?status=issue
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
export function cliAsync(args, cwd, env = {}, stdin = '') {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } });
    child.stdin.end(stdin);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => ok({ code, stdout, stderr }));
  });
}
