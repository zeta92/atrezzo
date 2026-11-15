// Browser storage a flow seeds before the page loads: `storage: { local: {…}, session: {…} }`,
// at flow level and step level. The playwright driver writes it through an init script on the
// browser context, so every document of the step's origin already sees it, reloads included.
// Keys and values are literal: atrezzo reads no environment variable. Values are never printed.

export const AREAS = ['local', 'session'];

const empty = () => ({ local: {}, session: {} });

/**
 * Validate and normalise a `storage:` block. Adds problems to `issues` and returns
 * { local: { key: 'value' }, session: { key: 'value' } } (possibly empty maps).
 * @param {unknown} raw
 * @param {string} field   e.g. "storage" or "steps[0].storage"
 * @param {{ add(field: string, msg: string): void }} issues
 */
export function parseStorage(raw, field, issues) {
  const out = empty();
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.add(field, 'must be a map { local: { key: "value" }, session: { key: "value" } }');
    return out;
  }
  for (const k of Object.keys(raw)) if (!AREAS.includes(k)) issues.add(`${field}.${k}`, `unknown field (allowed: ${AREAS.join(', ')})`);
  for (const area of AREAS) {
    const map = raw[area];
    if (map === undefined || map === null) continue;
    const f = `${field}.${area}`;
    if (typeof map !== 'object' || Array.isArray(map)) { issues.add(f, 'must be a map key: "value"'); continue; }
    for (const [key, value] of Object.entries(map)) {
      const fk = `${f}.${key}`;
      if (key === '') { issues.add(f, 'a key cannot be empty'); continue; }
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        issues.add(fk, `must be a string; got ${Array.isArray(value) ? 'a list' : value === null ? 'null' : typeof value}${value !== null && typeof value === 'object' ? ' (write JSON as a quoted string)' : ''}`);
        continue;
      }
      const text = String(value);
      if (/\$\{[^}]*\}/.test(key) || /\$\{[^}]*\}/.test(text)) {
        issues.add(fk, '${…} is not expanded: atrezzo reads no environment variables. Write the literal value in the flow (against the mock a fake session is enough), or remove the key');
        continue;
      }
      out[area][key] = text;
    }
  }
  return out;
}

/** Effective storage for a step: the flow's, overridden key by key by the step's. Keys are case-sensitive. */
export function mergeStorage(...layers) {
  const out = empty();
  for (const layer of layers) for (const area of AREAS) Object.assign(out[area], layer?.[area] ?? {});
  return out;
}

export function hasStorage(storage) {
  return AREAS.some((a) => Object.keys(storage?.[a] ?? {}).length > 0);
}

/** Keys only (values may be sessions): { local: [...], session: [...] }. */
export function storageKeys(storage) {
  return Object.fromEntries(AREAS.map((a) => [a, Object.keys(storage?.[a] ?? {})]));
}

export function formatStorage(keys) {
  return AREAS.filter((a) => keys?.[a]?.length).map((a) => `${a}: ${keys[a].join(', ')}`).join(' · ');
}

/**
 * Source of an init script that, on every document whose origin is `origin`, removes the keys in
 * `drop` (seeded by an earlier step, not by this one) and writes `storage`. Other origins
 * (third-party iframes, about:blank) are left alone.
 */
export function storageScript(origin, storage, drop = { local: [], session: [] }) {
  const data = JSON.stringify({ origin, drop: { local: drop.local ?? [], session: drop.session ?? [] }, local: storage.local, session: storage.session });
  return `(() => {
  const d = ${data};
  if (location.origin !== d.origin) return;
  try {
    for (const [area, s] of [['local', localStorage], ['session', sessionStorage]]) {
      for (const k of d.drop[area]) s.removeItem(k);
      for (const [k, v] of Object.entries(d[area])) s.setItem(k, v);
    }
  } catch { /* storage disabled for this document */ }
})();`;
}

/**
 * Per-run seeding state for the playwright driver. Init scripts cannot be removed once added, so
 * each change registers a new script that runs after the earlier ones: it drops what they seeded
 * and this step does not declare, then writes this step's values. Unchanged storage adds nothing.
 */
export function createSeeder() {
  const seeded = { local: new Set(), session: new Set() };
  let last = JSON.stringify({ origin: null, storage: empty() });
  return {
    /** The script to register before this step's visit, or null if nothing changes. */
    next(origin, storage) {
      const key = JSON.stringify({ origin, storage });
      if (key === last || (!hasStorage(storage) && !seeded.local.size && !seeded.session.size)) return null;
      last = key;
      const drop = Object.fromEntries(AREAS.map((a) => [a, [...seeded[a]].filter((k) => !(k in storage[a]))]));
      for (const a of AREAS) for (const k of Object.keys(storage[a])) seeded[a].add(k);
      return storageScript(origin, storage, drop);
    },
  };
}
