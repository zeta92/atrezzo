// Turns field-cases.json into CASES entries for tests/diagnosis.test.mjs.
import { readFileSync } from 'node:fs';
const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const lit = (v) => JSON.stringify(v).replace(/"([A-Za-z_$][\w$]*)":/g, '$1: ').replace(/,(?=[{\[A-Za-z"\d-])/g, ', ').replace(/'/g, "\\'").replace(/"/g, "'");
const lines = cases.map((c) => {
  const { ctx } = c;
  const parts = [];
  parts.push(`obtained: ${ctx.domCount ?? (ctx.items.filter(() => true).length && undefined) ?? 0}`);
  return c;
});
const out = [];
for (const c of cases) {
  const e = { ...c.expect };
  if (!Object.keys(e.data).length) delete e.data; else e.data = { request: 'r', ...e.data };
  if (!e.data) e.data = { request: 'r' };
  const ctx = c.ctx;
  const obtained = ctx.domCount !== undefined ? ctx.domCount : ctx.matched;
  const fields = [`obtained: ${obtained}`, `response: ${lit(ctx.response)}`, `items: ${lit(ctx.items)}`];
  if (c.query) fields.push(`query: q(${lit(c.query)})`);
  fields.push(`matched: ${ctx.matched}`);
  if (ctx.fullMatched !== undefined) fields.push(`fullMatched: ${ctx.fullMatched}`);
  if (ctx.domCount !== undefined) fields.push(`domCount: ${ctx.domCount}`);
  out.push(`  { name: ${lit(c.name)}, row: { expect: ${lit(e)} }, cause: ${c.cause === null ? 'null' : lit(c.cause)},${c.truths.length ? ` truths: ${lit(c.truths)},` : ''}\n    ctx: { ${fields.join(', ')} } },`);
}
console.log(out.join('\n'));
