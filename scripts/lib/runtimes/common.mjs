// Helpers shared by the runtime adapters.
import { posix } from 'node:path';

/** Score from weighted signals, capped to 0..3. */
export function scoreOf(signals) {
  return Math.min(3, signals.reduce((s, x) => s + x.weight, 0));
}

export function describeSignals(signals, none) {
  return signals.length ? signals.map((s) => s.text).join('; ') : none;
}

/** Build the standard `meta` object from a signals(ctx) function. */
export function metaFrom({ id, label, needsOpenapi = false, signals, none, startHint }) {
  return {
    id, label, needsOpenapi, startHint,
    detect: (ctx) => scoreOf(signals(ctx)),
    describe: (ctx) => describeSignals(signals(ctx), none),
    signals,
  };
}

/** Normalize a project-relative path to POSIX without leading "./". */
export const p = (...parts) => posix.normalize(posix.join(...parts.filter(Boolean))).replace(/^\.\//, '');

/** Stable file-name slug: "/api/orders" -> "api-orders". */
export const slug = (s) => String(s).replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-') || 'root';

/** Parents before children (refs), ties in declaration order. */
export function entityOrder(dataset) {
  const names = Object.keys(dataset.schema);
  const order = [];
  const visit = (n, stack = []) => {
    if (order.includes(n) || stack.includes(n)) return;
    for (const target of Object.values(dataset.schema[n].refs)) visit(target, [...stack, n]);
    order.push(n);
  };
  names.forEach((n) => visit(n));
  return order;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Column type inferred from the generated rows (never from guesses):
 * 'integer' | 'number' | 'boolean' | 'datetime' | 'string', plus nullability.
 */
export function columnInfo(rows, field) {
  const vals = rows.map((r) => r[field]);
  const present = vals.filter((v) => v !== null && v !== undefined);
  const nullable = present.length !== vals.length;
  let type = 'string';
  if (present.length && present.every((v) => Number.isInteger(v))) type = 'integer';
  else if (present.length && present.every((v) => typeof v === 'number')) type = 'number';
  else if (present.length && present.every((v) => typeof v === 'boolean')) type = 'boolean';
  else if (present.length && present.every((v) => typeof v === 'string' && ISO.test(v))) type = 'datetime';
  return { type, nullable, distinct: [...new Set(present.map(String))].sort() };
}
