// World generation: scenario (normalized) -> deterministic dataset.
// Rules: no Math.random(), no clock. "now" comes from the scenario.
import { createHash } from 'node:crypto';
import { createRng } from './prng.mjs';

const FIRST = ['Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Ethan', 'Mia', 'Lucas', 'Nora', 'Owen',
  'Chloe', 'Adam', 'Iris', 'Felix', 'Ruby', 'Hugo', 'Alice', 'Leo', 'Maya', 'Jonas'];
const LAST = ['Bennett', 'Carter', 'Hayes', 'Novak', 'Fischer', 'Moreau', 'Rossi', 'Silva', 'Larsen', 'Weber',
  'Doyle', 'Marsh', 'Quinn', 'Keller', 'Brandt', 'Costa', 'Hale', 'Frost', 'Vance', 'Reyes'];
const COMPANY_A = ['Northwind', 'Brightline', 'Copperfield', 'Blue Oak', 'Ironwood', 'Harbor',
  'Summit', 'Lantern', 'Redwood', 'Meridian', 'Stonebridge', 'Clearwater'];
const COMPANY_B = ['Trading', 'Logistics', 'Supply', 'Studio', 'Works', 'Foods',
  'Systems', 'Partners', 'Group', 'Industries', 'Labs', 'Collective'];
const CITIES = ['London', 'Berlin', 'Lisbon', 'Amsterdam', 'Dublin', 'Vienna', 'Milan', 'Prague',
  'Copenhagen', 'Zurich', 'Porto', 'Ghent'];
const PRODUCTS = ['Bolt', 'Washer', 'Hinge', 'Lock', 'Drill', 'Sandpaper', 'Tape', 'Paint',
  'Brush', 'Hammer', 'Wrench', 'Level'];

function slug(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
}

const person = (rng) => `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
const company = (rng) => `${rng.pick(COMPANY_A)} ${rng.pick(COMPANY_B)}`;

/**
 * Known entity templates. `fields` is the closed list of fields the template
 * produces (before options add more). `{fk}` placeholders are replaced by the
 * foreign keys of the entity's references.
 */
export const TEMPLATES = {
  customers: {
    singular: 'customer', fk: 'customer_id',
    fields: ['id', 'name', 'email', 'city', 'created_at'],
    make: (rng, id) => {
      const name = company(rng);
      return { name, email: `contact${id}@${slug(name)}.example`, city: rng.pick(CITIES) };
    },
  },
  users: {
    singular: 'user', fk: 'user_id',
    fields: ['id', 'name', 'email', 'role', 'created_at'],
    make: (rng, id) => {
      const name = person(rng);
      return { name, email: `${slug(name)}.${id}@example.com`, role: id === 1 ? 'admin' : 'operator' };
    },
  },
  orders: {
    singular: 'order', fk: 'order_id', defaultRef: ['customers'], statusField: 'status',
    defaultStatus: 'paid', amountField: 'amount',
    defaultAmount: { min: 10, max: 500, currency: 'EUR' },
    fields: ['id', 'reference', '{fk}', 'status', 'amount', 'currency', 'created_at'],
    make: (rng, id) => ({ reference: `ORD-${String(id).padStart(5, '0')}` }),
  },
  products: {
    singular: 'product', fk: 'product_id', amountField: 'price',
    defaultAmount: { min: 1, max: 120, currency: 'EUR' },
    fields: ['id', 'name', 'sku', 'price', 'currency', 'stock'],
    make: (rng, id) => ({ name: `${rng.pick(PRODUCTS)} ${rng.int(1, 99)}`, sku: `SKU-${String(id).padStart(4, '0')}`, stock: rng.int(0, 250) }),
  },
};

/**
 * Template names used before 0.4. They are rejected (not translated) so a
 * scenario that still uses them fails loudly instead of becoming a generic entity.
 */
export const RENAMED_TEMPLATES = { clientes: 'customers', usuarios: 'users', pedidos: 'orders', productos: 'products' };

/**
 * English nouns whose plural turns -f/-fe into -ves (a closed set of the language, not of any app).
 * Every other -ves word is a plain -ve + s (drives -> drive, archives -> archive).
 */
const VES_SINGULARS = ['calf', 'dwarf', 'elf', 'half', 'hoof', 'knife', 'leaf', 'life', 'loaf', 'scarf', 'self', 'sheaf', 'shelf', 'thief', 'wife', 'wolf'];
const VES_PLURALS = new Map(VES_SINGULARS.map((s) => [`${s.replace(/fe?$/, '')}ves`, s]));
/** `shelf` -> `shelves` for the -f/-fe nouns above; null for any other word. */
export const irregularPlural = (word) => {
  const m = /^(.*?)([a-z]+)$/.exec(word);
  return m && VES_SINGULARS.includes(m[2]) ? `${m[1]}${m[2].replace(/fe?$/, '')}ves` : null;
};

/** English singular of a collection name: invoices -> invoice, categories -> category, boxes -> box, shelves -> shelf. */
export function singularize(name) {
  // Last word only (`top_shelves` -> `top_shelf`): the irregular set is matched on whole words.
  const m = /^(.*?)([a-z]+)$/.exec(name);
  if (m && VES_PLURALS.has(m[2])) return `${m[1]}${VES_PLURALS.get(m[2])}`;
  if (/ies$/.test(name) && name.length > 4) return `${name.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/.test(name)) return name.slice(0, -2);
  return name.replace(/s$/, '');
}

export function templateFor(name) {
  if (Object.hasOwn(TEMPLATES, name)) return TEMPLATES[name];
  const singular = singularize(name);
  return {
    singular, fk: `${singular}_id`, generic: true,
    fields: ['id', 'name', '{fk}', 'created_at'],
    make: (rng, id) => ({ name: `${singular} ${id}` }),
  };
}

/**
 * Field list an entity will have, given its normalized spec. Used both by the
 * generator and by the scenario validator (filters must reference real fields).
 */
export function entityFields(spec) {
  const t = templateFor(spec.name);
  const fks = spec.refs.map((r) => templateFor(r).fk);
  const out = [];
  if (spec.fields) {
    // Explicit `fields` (e.g. from `atrezzo import`): the field list is exactly
    // id + fks + fields; the template's own fields are not added.
    out.push('id', ...fks.filter((f) => !(f in spec.fields)), ...Object.keys(spec.fields));
  } else {
    for (const f of t.fields) {
      if (f === '{fk}') out.push(...fks);
      else out.push(f);
    }
    if (!t.fields.includes('{fk}')) out.push(...fks.filter((f) => !out.includes(f)));
  }
  if (spec.distribution && !out.includes(spec.distribution.field)) out.push(spec.distribution.field);
  if (spec.amount) {
    const af = t.amountField || 'amount';
    if (!out.includes(af)) out.push(af);
    if (!out.includes('currency')) out.push('currency');
  }
  for (const f of Object.keys(spec.pools || {})) if (!out.includes(f)) out.push(f);
  return out;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const fieldType = (entry) => (isObj(entry) ? entry.default : entry);

/**
 * Value list `seed_first` takes the first value of, or null when the field has none: its `values`
 * vocabulary, else its enum (a list in `fields`), else `[false, true]` for a boolean.
 */
export function firstValueList(spec, field) {
  if (spec.pools && Object.hasOwn(spec.pools, field)) return spec.pools[field];
  const type = fieldType(spec.fields?.[field]);
  if (Array.isArray(type)) return type;
  if (type === 'boolean') return [false, true];
  return null;
}

/**
 * Fields `values_order` applies to: those with a written list of values (`values:` or an enum in
 * `fields:`), except the id, the foreign keys and the distribution field (they have their own rules).
 */
export function valueListFields(spec) {
  const fks = spec.refs.map((r) => templateFor(r).fk);
  return entityFields(spec).filter((k) => k !== 'id' && !fks.includes(k) && k !== spec.distribution?.field
    && ((spec.pools && Object.hasOwn(spec.pools, k)) || Array.isArray(fieldType(spec.fields?.[k]))));
}

const DAY_MS = 86_400_000;

const hex = (rng, n) => Array.from({ length: n }, () => rng.int(0, 15).toString(16)).join('');

/** Value for a typed `fields` entry. Uses its own PRNG stream (fields:<entity>). */
function typedValue(type, field, rng, id, entity, nowMs, days) {
  if (Array.isArray(type)) return rng.pick(type);
  const lower = field.toLowerCase();
  switch (type) {
    case 'integer': return /price|amount|total/.test(lower) ? rng.int(1, 999) : rng.int(0, 1000);
    case 'number': return rng.int(0, 100_000) / 100;
    case 'boolean': return rng.next() < 0.5;
    case 'date': return new Date(nowMs - rng.int(0, days * 1440) * 60_000).toISOString();
    case 'email': return `${slug(person(rng))}.${id}@example.com`;
    case 'uuid': return `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-${'89ab'[rng.int(0, 3)]}${hex(rng, 3)}-${hex(rng, 12)}`;
    case 'url': return `https://example.com/${entity}/${id}`;
    default: // string
      if (/(^|_)(first|last)?_?name$|^name$|fullname|username/i.test(field)) return /user/i.test(field) ? `${slug(person(rng))}${id}` : person(rng);
      if (/compan|org/.test(lower)) return company(rng);
      if (/city/.test(lower)) return rng.pick(CITIES);
      if (/title|product/.test(lower)) return `${rng.pick(PRODUCTS)} ${rng.int(1, 99)}`;
      return `${field} ${id}`;
  }
}

function matchesWhen(row, when) {
  return Object.entries(when).every(([k, expected]) => (Array.isArray(expected) ? expected.includes(row[k]) : row[k] === expected));
}

function generateEntity(spec, scenario, counts, built) {
  const t = templateFor(spec.name);
  const rng = createRng(scenario.seed, `entity:${spec.name}`);
  const nowMs = Date.parse(scenario.now);
  const fields = entityFields(spec);
  const n = spec.count;

  // Status distribution: exact counts, shuffled deterministically.
  let statuses = null;
  if (spec.distribution) {
    const list = [];
    for (const [value, c] of Object.entries(spec.distribution.counts)) for (let i = 0; i < c; i++) list.push(value);
    statuses = createRng(scenario.seed, `dist:${spec.name}`).shuffle(list);
  }

  // Foreign keys: first min(n, parentCount) children cover every parent once,
  // the rest pick a random parent. Every id exists by construction.
  const fkValues = {};
  const derive = spec.derive ?? {};
  for (const ref of spec.refs) {
    if (Object.hasOwn(derive, templateFor(ref).fk)) continue; // copied below, never drawn
    const parentCount = counts[ref];
    const frng = createRng(scenario.seed, `fk:${spec.name}->${ref}`);
    const cover = frng.shuffle([...Array(parentCount).keys()].map((i) => i + 1));
    const assigned = [];
    for (let i = 0; i < n; i++) assigned.push(i < cover.length ? cover[i] : frng.int(1, parentCount));
    fkValues[templateFor(ref).fk] = frng.shuffle(assigned);
  }
  // Derived fks: the value of `field` in the row the `from` fk points at (built first: it is a ref).
  for (const [fk, { from, field }] of Object.entries(derive)) {
    const via = fkValues[templateFor(from).fk];
    fkValues[fk] = via.map((pid) => built[from][pid - 1]?.[field] ?? null);
  }

  const amount = spec.amount;
  const amountField = t.amountField || 'amount';
  const frng = spec.fields ? createRng(scenario.seed, `fields:${spec.name}`) : null;
  // `values_order: cycle`: row i takes values[i % n], in the written order, whatever the seed.
  const cycled = spec.valuesOrder === 'cycle' ? valueListFields(spec) : [];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const id = i + 1;
    const base = t.make(rng, id);
    const typed = {};
    if (frng) for (const [f, entry] of Object.entries(spec.fields)) typed[f] = typedValue(fieldType(entry), f, frng, id, spec.name, nowMs, spec.days);
    const row = {};
    for (const f of fields) {
      if (f === 'id') row.id = id;
      else if (f in fkValues) row[f] = fkValues[f][i];
      else if (spec.distribution && f === spec.distribution.field) row[f] = statuses[i];
      else if (amount && f === amountField) row[f] = rng.int(Math.round(amount.min * 100), Math.round(amount.max * 100)) / 100;
      else if (amount && f === 'currency') row[f] = amount.currency;
      else if (f === 'created_at' && !(f in typed)) {
        // Template timestamp (a `created_at` declared in `fields` stays a typed date):
        // a child never predates its parent, its date falls between the parent's and "now".
        const parentMs = Math.max(nowMs - spec.days * DAY_MS, ...spec.refs.map((r) => {
          const p = built[r]?.[(fkValues[templateFor(r).fk][i] ?? 0) - 1];
          return p?.created_at ? Date.parse(p.created_at) : -Infinity;
        }));
        const spanMin = Math.max(0, Math.floor((nowMs - parentMs) / 60_000));
        row[f] = new Date(nowMs - rng.int(0, spanMin) * 60_000).toISOString();
      }
      else if (spec.pools && f in spec.pools) row[f] = rng.pick(spec.pools[f]);
      else if (f in typed) row[f] = typed[f];
      else row[f] = f in base ? base[f] : null;
    }
    // `cycle` and `seed_first`: after the draws, so the other fields keep the values they have without them.
    for (const f of cycled) { const list = firstValueList(spec, f); row[f] = list[i % list.length]; }
    for (const f of spec.seedFirst ?? []) row[f] = firstValueList(spec, f)[0];
    rows.push(row);
  }

  // Explicit nulls ("nulls: { email: 2 }") to exercise client assumptions.
  const nulled = new Map();
  for (const [field, k] of Object.entries(spec.nulls || {})) {
    const indices = createRng(scenario.seed, `nulls:${spec.name}.${field}`).sample(n, k);
    for (const idx of indices) rows[idx][field] = null;
    nulled.set(field, new Set(indices));
  }

  // Conditional field overrides: applied after normal field assignment (and nulls on other fields)
  // in topological order, preserving explicit nulls on the target field itself.
  if (spec.fields) {
    const entries = Object.entries(spec.fields).filter(([, entry]) => isObj(entry));
    if (entries.length) {
      const byKey = new Map(entries);
      const added = new Set();
      const visiting = new Set();
      const conditionals = [];
      const pushCond = (f) => {
        if (added.has(f) || visiting.has(f) || !byKey.has(f)) return;
        visiting.add(f);
        const entry = byKey.get(f);
        for (const dep of Object.keys(entry.when)) pushCond(dep);
        visiting.delete(f);
        added.add(f);
        conditionals.push({
          field: f,
          when: entry.when,
          value: entry.value,
          rng: entry.value.length > 1 ? createRng(scenario.seed, `when:${spec.name}.${f}`) : null,
        });
      };
      for (const [f] of entries) pushCond(f);
      for (let i = 0; i < rows.length; i++) {
        for (const c of conditionals) {
          if (nulled.get(c.field)?.has(i)) continue;
          if (matchesWhen(rows[i], c.when)) rows[i][c.field] = c.rng ? c.rng.pick(c.value) : c.value[0];
        }
      }
    }
  }
  return { rows, fields };
}

export function scenarioHash(scenario) {
  return createHash('sha256').update(JSON.stringify(scenario)).digest('hex').slice(0, 16);
}

/** Build the full dataset for a normalized scenario. Pure and deterministic. */
export function generateWorld(scenario) {
  const counts = Object.fromEntries(scenario.world.map((e) => [e.name, e.count]));
  const schema = {};
  const built = {};
  // Parents before children (refs are validated acyclic-by-construction: no self refs;
  // cycles fall back to declaration order).
  const order = [];
  const visit = (spec, stack = []) => {
    if (order.includes(spec) || stack.includes(spec)) return;
    for (const r of spec.refs) visit(scenario.world.find((s) => s.name === r), [...stack, spec]);
    order.push(spec);
  };
  scenario.world.forEach((s) => visit(s));
  for (const spec of order) {
    const { rows, fields } = generateEntity(spec, scenario, counts, built);
    built[spec.name] = rows;
  }
  const entities = {};
  for (const spec of scenario.world) {
    const t = templateFor(spec.name);
    const rows = built[spec.name];
    const fields = entityFields(spec);
    schema[spec.name] = {
      singular: t.singular,
      fk: t.fk,
      fields,
      refs: Object.fromEntries(spec.refs.map((r) => [templateFor(r).fk, r])),
    };
    entities[spec.name] = rows;
  }
  const dataset = {
    atrezzo: 1,
    scenario: scenario.name,
    seed: scenario.seed,
    now: scenario.now,
    hash: scenarioHash(scenario),
    schema,
    endpoints: scenario.endpoints,
    entities,
  };
  if (scenario.auth) dataset.auth = scenario.auth;
  if (scenario.writes?.length) dataset.writes = scenario.writes;
  if (scenario.streams?.length) dataset.streams = scenario.streams;
  return dataset;
}

/** Referential integrity check: returns a list of violations (empty = OK). */
export function checkIntegrity(dataset) {
  const problems = [];
  for (const [name, meta] of Object.entries(dataset.schema)) {
    for (const [fk, target] of Object.entries(meta.refs)) {
      const ids = new Set((dataset.entities[target] || []).map((r) => r.id));
      for (const row of dataset.entities[name]) {
        if (row[fk] !== null && !ids.has(row[fk])) problems.push(`${name}#${row.id}.${fk}=${row[fk]} does not exist in ${target}`);
      }
    }
  }
  return problems;
}

