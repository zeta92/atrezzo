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
  startHint: 'npx @stoplight/prism-cli mock atrezzo/.generated/<scenario>.openapi.yaml',
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

/** Item schema for an endpoint: the entity plus embedded parents (`include`). */
function itemSchema(ep, dataset, names) {
  const ref = { $ref: `#/components/schemas/${names[ep.entity]}` };
  if (!ep.include.length) return ref;
  const meta = dataset.schema[ep.entity];
  const properties = {};
  const required = [];
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
    const item = itemSchema(ep, dataset, names);
    const list = { type: 'array', items: item };
    const schema = ep.shape === 'envelope'
      ? { type: 'object', properties: { [ep.pick ?? 'data']: list, total: { type: 'integer' }, limit: { type: ['integer', 'null'] }, offset: { type: 'integer' } }, required: [ep.pick ?? 'data', 'total', 'limit', 'offset'] }
      : list;
    const def = engine.handle({ pathname: ep.path, query: {} });
    const examples = { scenario: { summary: `Projection of scenario ${dataset.scenario} without a query`, value: def.body } };
    // One example per value of the distribution field, selectable with `Prefer: example=<key>`.
    const distField = ep.filters.find((f) => columnInfo(rows, f).distinct.length <= 10 && f !== 'id');
    if (distField) {
      for (const v of columnInfo(rows, distField).distinct) {
        const r = engine.handle({ pathname: ep.path, query: { [distField]: v } });
        examples[slug(`${distField}-${v}`)] = { summary: `?${distField}=${v}`, value: r.body };
      }
    }
    const op = slug(ep.path).replace(/[.-]/g, '_');
    const responses = {
      200: {
        description: `List of ${ep.entity}`,
        headers: { 'X-Total-Count': { description: 'Total after filters, before pagination', schema: { type: 'integer', example: Number(def.headers['x-total-count']) } } },
        content: { 'application/json': { schema, examples } },
      },
    };
    if (ep.pagination) responses[400] = { description: 'Non-integer pagination parameter', content: { 'application/json': { schema: errorSchema } } };
    paths[ep.path] = { get: { operationId: `list_${op}`, summary: `${ep.entity} (atrezzo projection)`, parameters, responses } };
    if (ep.detail) {
      const first = rows[0];
      const detailResponses = {
        200: { description: `One ${dataset.schema[ep.entity].singular}`, content: { 'application/json': { schema: item, ...(first ? { examples: { scenario: { summary: `id ${first.id}`, value: engine.handle({ pathname: `${ep.path}/${first.id}` }).body } } } : {}) } } },
        404: { description: 'Does not exist in the scenario', content: { 'application/json': { schema: errorSchema } } },
      };
      paths[`${ep.path}/{id}`] = {
        get: {
          operationId: `detail_${op}`,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
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
  const exampleKeys = Object.values(doc.paths).flatMap((x) => Object.keys(x.get.responses[200].content['application/json'].examples ?? {})).filter((k) => k !== 'scenario');
  return {
    files: [{ path: file, content: emitYaml(doc) }],
    start: `npx @stoplight/prism-cli mock ${file} --port ${config.mock.port}`,
    notes: [
      'Prism returns the "scenario" example (projection without a query) for any query: it does NOT filter or paginate; X-Total-Count is the example\'s',
      exampleKeys.length ? `other examples via the Prefer: example=<key> header (${[...new Set(exampleKeys)].slice(0, 6).join(', ')}${exampleKeys.length > 6 ? ', …' : ''})` : 'no per-filter examples (no field with ≤ 10 values)',
      'detail /{id}: always the first id\'s example; unknown ids do not 404 unless you send Prefer: code=404',
      'Prism does validate requests against the declared parameters (types, minimum/maximum): it answers 400 (the spec declares 400 on paginated lists) or 422 when they do not match',
      'filters are declared as string without enum: with an enum Prism would reject the "a,b" lists the engine accepts',
    ],
  };
}
