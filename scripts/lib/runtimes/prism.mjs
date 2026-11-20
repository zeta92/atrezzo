// prism: emit an OpenAPI 3.1 document generated from the scenario endpoints,
// with `examples` computed by the projection engine (the same bytes `serve`
// returns), and run `prism mock` on it. Prism serves examples: it does NOT
// filter or paginate.
import { createEngine } from '../contract.mjs';
import { emitYaml } from '../yaml-emit.mjs';
import { columnInfo, metaFrom, p, slug } from './common.mjs';

function signals(ctx) {
  const out = [];
  const dep = ctx.dep('@stoplight/prism-cli');
  if (dep) out.push({ text: `@stoplight/prism-cli in ${dep}`, weight: 3 });
  const script = ctx.scripts.find((s) => /\bprism\s+(mock|proxy)\b/.test(s.text));
  if (script) out.push({ text: `"prism" in ${script.where}`, weight: 2 });
  if (ctx.specs.length) out.push({ text: `contract ${ctx.specs[0]} (weak signal: prefer \`atrezzo import ${ctx.specs[0]}\`; prism is not needed to use it)`, weight: 1 });
  return out;
}

export const meta = metaFrom({
  id: 'prism',
  label: 'Prism (mock from a generated OpenAPI)',
  needsOpenapi: true,
  signals,
  none: 'no OpenAPI spec and no @stoplight/prism-cli',
  startHint: 'start the Prism CLI against atrezzo/.generated/<scenario>.openapi.yaml',
});

const OAS = {
  integer: { type: 'integer' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  datetime: { type: 'string', format: 'date-time' },
  string: { type: 'string' },
};
const pascal = (s) => s.replace(/(^|[_-])(\w)/g, (_, __, c) => c.toUpperCase());

/** components.schemas: one per entity; `required` = fields never null in the world. */
function componentSchemas(dataset) {
  const names = {};
  const schemas = {};
  for (const [entity, meta] of Object.entries(dataset.schema)) {
    let n = pascal(meta.singular);
    while (Object.values(names).includes(n)) n += 'X';
    names[entity] = n;
  }
  for (const [entity, meta] of Object.entries(dataset.schema)) {
    const rows = dataset.entities[entity];
    const properties = {};
    const required = [];
    for (const f of meta.fields) {
      const info = columnInfo(rows, f);
      const base = { ...OAS[info.type] };
      properties[f] = info.nullable ? { ...base, type: [base.type, 'null'] } : base;
      if (!info.nullable && rows.length) required.push(f);
    }
    schemas[names[entity]] = { type: 'object', properties, required };
  }
  return { names, schemas };
}

/** Schema of one embedded row: the child entity, plus its own embeds (`{ entity, embed }`). */
function embedSchema(e, names) {
  if (typeof e === 'string') return { $ref: `#/components/schemas/${names[e]}` };
  const properties = {};
  for (const inner of e.embed) properties[typeof inner === 'string' ? inner : inner.entity] = { type: 'array', items: embedSchema(inner, names) };
  return { allOf: [{ $ref: `#/components/schemas/${names[e.entity]}` }, { type: 'object', properties, required: Object.keys(properties) }] };
}

/** Item schema for an endpoint: the entity plus embedded parents (`include`) and children (`embed`). */
function itemSchema(ep, dataset, names) {
  // `pluck`: each item is the field's value as a string (null when the world has nulls in it).
  if (ep.pluck) return columnInfo(dataset.entities[ep.entity], ep.pluck).nullable ? { type: ['string', 'null'] } : { type: 'string' };
  const ref = { $ref: `#/components/schemas/${names[ep.entity]}` };
  if (!ep.include.length && !ep.embed?.length && !ep.counts?.length) return ref;
  const meta = dataset.schema[ep.entity];
  const properties = {};
  const required = [];
  for (const e of ep.embed ?? []) {
    const child = typeof e === 'string' ? e : e.entity;
    properties[child] = { type: 'array', items: embedSchema(e, names) };
    required.push(child);
  }
  for (const c of ep.counts ?? []) {
    properties[c.field] = { type: 'integer' };
    if (!required.includes(c.field)) required.push(c.field);
  }
  for (const [fk, target] of Object.entries(meta.refs)) {
    if (!ep.include.includes(target)) continue;
    const key = dataset.schema[target].singular;
    const nullable = columnInfo(dataset.entities[ep.entity], fk).nullable;
    properties[key] = nullable ? { anyOf: [{ $ref: `#/components/schemas/${names[target]}` }, { type: 'null' }] } : { $ref: `#/components/schemas/${names[target]}` };
    if (!nullable) required.push(key);
  }
  return { allOf: [ref, { type: 'object', properties, required }] };
}

export function openapiDocument(dataset, config) {
  const engine = createEngine(dataset);
  const { names, schemas } = componentSchemas(dataset);
  const paths = {};
  const errorSchema = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };
  for (const ep of dataset.endpoints) {
    const rows = dataset.entities[ep.entity];
    const parameters = [];
    // Path parameters: OpenAPI spells them {name}; the examples use the first row's values.
    const sample = rows[0] ?? {};
    let concrete = ep.path;
    for (const prm of ep.params ?? []) {
      const v = prm.field === null ? 1 : sample[prm.field] ?? 1;
      concrete = concrete.replace(`/:${prm.name}`, `/${encodeURIComponent(String(v))}`);
      parameters.push({ name: prm.name, in: 'path', required: true, description: prm.field === null ? 'Accepted, not filtered.' : `Equality on ${prm.field}.`, schema: { type: 'string' } });
    }
    const oasPath = ep.path.replace(/\/:([A-Za-z_]\w*)/g, '/{$1}');
    for (const f of ep.filters) {
      const info = columnInfo(rows, f);
      const values = info.distinct.length && info.distinct.length <= 25 ? ` Values in the world: ${info.distinct.join(', ')}.` : '';
      parameters.push({
        name: f, in: 'query', required: false,
        description: `Equality; several comma-separated values; "null" matches nulls.${values}`,
        schema: { type: 'string' },
      });
    }
    if (ep.pagination) {
      const lim = { type: 'integer', minimum: 0 };
      if (ep.pagination.maxLimit !== null) lim.maximum = ep.pagination.maxLimit;
      if (ep.pagination.defaultLimit !== null) lim.default = ep.pagination.defaultLimit;
      parameters.push({ name: ep.pagination.limit, in: 'query', required: false, schema: lim });
      if (ep.pagination.page) parameters.push({ name: ep.pagination.page, in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } });
      else parameters.push({ name: ep.pagination.offset, in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } });
    }
    if (ep.sorts) {
      parameters.push({
        name: ep.sorts.by, in: 'query', required: false,
        description: `Sort field (${ep.sorts.fields.join(', ')}); prefix "-" or suffix ".desc" for descending.`,
        schema: { type: 'string' },
      });
      if (ep.sorts.order) {
        parameters.push({ name: ep.sorts.order, in: 'query', required: false, schema: { type: 'string', enum: ['asc', 'desc'] } });
      }
    }
    const item = itemSchema(ep, dataset, names);
    const list = { type: 'array', items: item };
    let schema;
    if (ep.shape === 'envelope') {
      if (ep.envelope) {
        schema = { type: 'object', properties: {}, required: [] };
        const addProp = (keyPath, leaf) => {
          const parts = keyPath.split('.');
          let cur = schema;
          for (let i = 0; i < parts.length - 1; i++) {
            const k = parts[i];
            if (!cur.properties[k]) {
              cur.properties[k] = { type: 'object', properties: {}, required: [] };
              cur.required.push(k);
            }
            cur = cur.properties[k];
          }
          const last = parts[parts.length - 1];
          cur.properties[last] = leaf;
          cur.required.push(last);
        };
        addProp(ep.envelope.items, list);
        if (ep.envelope.total !== undefined) addProp(ep.envelope.total, { type: 'integer' });
        if (ep.envelope.page !== undefined) addProp(ep.envelope.page, { type: 'integer' });
        if (ep.envelope.per_page !== undefined) addProp(ep.envelope.per_page, { type: ['integer', 'null'] });
      } else {
        schema = { type: 'object', properties: { [ep.pick ?? 'data']: list, total: { type: 'integer' }, limit: { type: ['integer', 'null'] }, offset: { type: 'integer' } }, required: [ep.pick ?? 'data', 'total', 'limit', 'offset'] };
      }
    } else {
      schema = ep.shape === 'object' ? item : list;
    }
    const def = engine.handle({ pathname: concrete, query: {} });
    // An empty `shape: object` singleton answers 404: it has no 200 example to give.
    const examples = def.status === 200 ? { scenario: { summary: `Projection of scenario ${dataset.scenario} without a query`, value: def.body } } : {};
    // One example per value of the distribution field, selectable with `Prefer: example=<key>`.
    const distField = ep.filters.find((f) => columnInfo(rows, f).distinct.length <= 10 && f !== 'id');
    if (distField) {
      for (const v of columnInfo(rows, distField).distinct) {
        const r = engine.handle({ pathname: concrete, query: { [distField]: v } });
        examples[slug(`${distField}-${v}`)] = { summary: `?${distField}=${v}`, value: r.body };
      }
    }
    const op = slug(ep.path).replace(/[.-]/g, '_');
    if (ep.error) {
      // `error:` answers the declared status and body on the list and the detail route.
      const declared = { [ep.error.status]: { description: `Declared by the scenario (error: ${ep.error.status}); the world is not projected`, content: { 'application/json': { schema: {}, examples: { scenario: { summary: 'The body the scenario declares', value: ep.error.body } } } } } };
      paths[oasPath] = { get: { operationId: `list_${op}`, summary: `${ep.entity} (atrezzo declared error)`, parameters, responses: declared } };
      if (ep.detail) {
        const idName = ep.params?.some((x) => x.name === 'id') ? 'row_id' : 'id';
        paths[`${oasPath}/{${idName}}`] = { get: { operationId: `detail_${op}`, parameters: [...parameters.filter((x) => x.in === 'path'), { name: idName, in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }], responses: declared } };
      }
      continue;
    }
    const responses = ep.shape === 'object'
      ? {
        200: { description: `The first ${dataset.schema[ep.entity].singular} after filters and sort (shape: object)`, content: { 'application/json': { schema, examples } } },
        404: { description: 'The entity has no rows, or no row matches the filters', content: { 'application/json': { schema: errorSchema } } },
      }
      : {
        200: {
          description: `List of ${ep.entity}`,
          headers: { 'X-Total-Count': { description: 'Total after filters, before pagination', schema: { type: 'integer', example: Number(def.headers['x-total-count']) } } },
          content: { 'application/json': { schema, examples } },
        },
      };
    if (ep.pagination || ep.sorts) responses[400] = { description: 'Invalid pagination or sort query parameter', content: { 'application/json': { schema: errorSchema } } };
    paths[oasPath] = { get: { operationId: `list_${op}`, summary: `${ep.entity} (atrezzo projection)`, parameters, responses } };
    if (ep.detail) {
      const first = rows[0];
      const detailResponses = {
        200: { description: `One ${dataset.schema[ep.entity].singular}`, content: { 'application/json': { schema: item, ...(first ? { examples: { scenario: { summary: `id ${first.id}`, value: engine.handle({ pathname: `${concrete}/${first.id}` }).body } } } : {}) } } },
        404: { description: 'Does not exist in the scenario', content: { 'application/json': { schema: errorSchema } } },
      };
      const idName = ep.params?.some((x) => x.name === 'id') ? 'row_id' : 'id';
      paths[`${oasPath}/{${idName}}`] = {
        get: {
          operationId: `detail_${op}`,
          parameters: [...parameters.filter((x) => x.in === 'path'), { name: idName, in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
          responses: detailResponses,
        },
      };
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: `atrezzo · ${dataset.scenario}`,
      version: dataset.hash,
      description: `Generated by atrezzo from scenario ${dataset.scenario} (seed ${dataset.seed}). Do not edit by hand. The examples are the exact projection of the world; Prism does not filter or paginate.`,
    },
    servers: [{ url: config.mock.baseUrl }],
    paths,
    components: { schemas },
  };
}

export function emit({ dataset, config }) {
  const file = p(config.generatedDir, `${dataset.scenario}.openapi.yaml`);
  const doc = openapiDocument(dataset, config);
  const exampleKeys = Object.values(doc.paths).flatMap((x) => Object.keys(x.get.responses[200]?.content['application/json'].examples ?? {})).filter((k) => k !== 'scenario');
  return {
    files: [{ path: file, content: emitYaml(doc) }],
    start: `start the Prism CLI against ${file} on port ${config.mock.port}`,
    notes: [
      'Prism returns the "scenario" example (projection without a query) for any query: it does NOT filter or paginate; X-Total-Count is the example\'s',
      exampleKeys.length ? `other examples via the Prefer: example=<key> header (${[...new Set(exampleKeys)].slice(0, 6).join(', ')}${exampleKeys.length > 6 ? ', …' : ''})` : 'no per-filter examples (no field with ≤ 10 values)',
      'detail /{id}: always the first id\'s example; unknown ids do not 404 unless you send Prefer: code=404',
      'Prism does validate requests against the declared parameters (types, minimum/maximum): it answers 400 (the spec declares 400 on paginated lists) or 422 when they do not match',
      'filters are declared as string without enum: with an enum Prism would reject the "a,b" lists the engine accepts',
      ...dataset.endpoints.filter((e) => e.error).map((e) => `${e.path}: declares only its error response (${e.error.status}) with the scenario's body; if your Prism version does not pick it on its own, send Prefer: code=${e.error.status}`),
    ],
  };
}
