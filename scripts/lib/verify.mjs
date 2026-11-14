// Verification loop: run the flow steps against a served mock, compare with the
// expectations, and (optionally) diagnose mismatches instead of regenerating.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AtrezzoError, EXIT } from './errors.mjs';
import { generateWorld } from './world.mjs';

// ---------- helpers ----------

function extractItems(body, pick) {
  let v = body;
  if (pick) for (const k of pick.split('.')) v = v?.[k];
  else if (v && !Array.isArray(v) && Array.isArray(v.data)) v = v.data;
  if (Array.isArray(v)) return v;
  return v === undefined || v === null ? [] : [v];
}

function whereMatch(item, where) {
  if (!where) return true;
  return Object.entries(where).every(([k, w]) => {
    const values = Array.isArray(w) ? w : [w];
    return values.some((x) => String(x) === String(item?.[k] ?? null));
  });
}

function expectedText(e) {
  if (e.count !== undefined) return `=${e.count}`;
  if (e.min !== undefined && e.max !== undefined) return `${e.min}..${e.max}`;
  if (e.min !== undefined) return `>=${e.min}`;
  return `<=${e.max}`;
}

function passes(e, n) {
  if (e.count !== undefined) return n === e.count;
  if (e.min !== undefined && n < e.min) return false;
  if (e.max !== undefined && n > e.max) return false;
  return true;
}

function joinUrl(base, path) {
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString().replace(/([^:]\/)\/+/g, '$1');
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, headers: res.headers, body };
}

function header(h, name) {
  return typeof h?.get === 'function' ? h.get(name) : h?.[name] ?? null;
}

function withoutPagination(path) {
  const u = new URL(path, 'http://x');
  for (const k of ['limit', 'offset', 'page', 'per_page', 'pageSize', 'skip', 'take']) u.searchParams.delete(k);
  return u.pathname + (u.search || '');
}

// ---------- diagnosis ----------

/**
 * Build hypotheses for a failed assertion. Pure function: all evidence comes in `ctx`.
 * ctx: { expected, obtained, driver, response?, items?, matched?, fullMatched?, domCount? }
 */
export function diagnose(row, ctx) {
  const hyps = [];
  const add = (tipo, confianza, evidencia) => hyps.push({ tipo, confianza, evidencia });
  const exp = row.expect;
  const target = exp.count ?? exp.min ?? exp.max;
  const r = ctx.response;
  if (r && r.status !== 200) add('respuesta-no-200', 'alta', `la petición devolvió ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
  if (r) {
    const ignored = header(r.headers, 'x-atrezzo-ignored');
    if (ignored) add('filtro-no-declarado', 'media', `el cliente envía parámetros que el contrato no declara como filtro y se ignoraron: ${ignored}. Si el cliente espera que el servidor filtre, añádelos a endpoints[].filters.`);
  }
  if (ctx.items) {
    const total = Number(header(r?.headers, 'x-total-count'));
    if (Number.isFinite(total) && total > ctx.items.length && ctx.fullMatched !== undefined && ctx.fullMatched >= target && ctx.matched < target) {
      add('paginacion-desalineada', 'alta', `la respuesta trae ${ctx.items.length} de ${total} elementos; sin paginar habría ${ctx.fullMatched} que cumplen la condición, pero en esta página solo ${ctx.matched}. Revisa limit/offset del cliente o el orden (sort) del endpoint.`);
    }
    const ids = ctx.items.map((i) => i?.id).filter((x) => x !== undefined);
    const dup = ids.length - new Set(ids).size;
    if (dup > 0) add('deduplicacion-por-id', 'alta', `${dup} ids repetidos en la respuesta; si el cliente deduplica por id pinta ${new Set(ids).size} filas.`);
    const nullFields = {};
    for (const it of ctx.items) for (const [k, v] of Object.entries(it ?? {})) if (v === null) nullFields[k] = (nullFields[k] ?? 0) + 1;
    const nullRows = ctx.items.filter((it) => Object.values(it ?? {}).some((v) => v === null)).length;
    if (nullRows > 0) {
      const strong = ctx.domCount !== undefined && ctx.domCount === ctx.matched - nullRows;
      add('campo-nulo', strong ? 'alta' : 'baja', `${nullRows} elementos con campos nulos (${Object.entries(nullFields).map(([k, n]) => `${k}: ${n}`).join(', ')}); si el cliente los descarta o rompe al pintarlos, faltan filas. Ver references/suposiciones.md.`);
    }
    if (ctx.domCount !== undefined && ctx.domCount < ctx.matched && dup === 0 && nullRows === 0) {
      add('filtro-en-cliente', 'media', `el JSON trae ${ctx.matched} elementos que cumplen, el DOM muestra ${ctx.domCount}: el cliente filtra u oculta elementos. El escenario es correcto; mira el componente.`);
    }
    if (ctx.domCount !== undefined && ctx.matched === target && ctx.domCount !== target) {
      add('render', 'alta', `el mock entrega exactamente lo esperado (${target}); la diferencia está en la pantalla, no en el escenario. No regeneres el mundo.`);
    }
    if (ctx.domCount === undefined && ctx.fullMatched !== undefined && ctx.fullMatched !== target && ctx.matched === ctx.fullMatched) {
      add('mundo-distinto', 'media', `el mundo tiene ${ctx.fullMatched} elementos que cumplen y se esperaban ${expectedText(exp)}: revisa world (total/distribución) o la condición "where" de la aserción.`);
    }
  } else if (ctx.domCount !== undefined) {
    add('sin-datos', 'baja', 'la aserción no tiene "data" para comparar con el JSON; añade data.request para poder separar fallo de datos y fallo de pantalla.');
  }
  if (!hyps.length) add('sin-hipotesis', 'baja', `obtenido ${ctx.obtained}, esperado ${expectedText(exp)}; ninguna heurística encaja. Revisa la ruta de pantallas y los selectores.`);
  return hyps;
}

// ---------- playwright ----------

export async function loadPlaywright(cwd) {
  const req = createRequire(join(cwd, 'package.json'));
  for (const mod of ['playwright', '@playwright/test']) {
    try { return await import(pathToFileURL(req.resolve(mod)).href); } catch { /* next */ }
  }
  return null;
}

async function defaultPageFactory(cwd) {
  const pw = await loadPlaywright(cwd);
  if (!pw) {
    throw new AtrezzoError('El driver playwright necesita el paquete "playwright" y no está instalado en este proyecto.\n  Instálalo con: npm i -D playwright && npx playwright install chromium\n  O usa --driver http. No se ha verificado nada.', { exitCode: EXIT.UNVERIFIABLE });
  }
  const chromium = pw.chromium ?? pw.default?.chromium;
  let browser;
  try { browser = await chromium.launch(); } catch (e) {
    throw new AtrezzoError(`Playwright está instalado pero no puede lanzar Chromium: ${e.message.split('\n')[0]}\n  Ejecuta: npx playwright install chromium`, { exitCode: EXIT.UNVERIFIABLE });
  }
  const page = await browser.newPage();
  return { page, close: () => browser.close() };
}

// ---------- main ----------

/**
 * @param {object} flow   result of loadFlow()
 * @param {{ url: string, driver?: 'http'|'playwright', diagnose?: boolean, reset?: boolean,
 *           fetchImpl?: typeof fetch, pageFactory?: () => Promise<{page:any, close:()=>Promise<void>}>, cwd?: string }} opts
 */
export async function runVerify(flow, opts) {
  const { url, driver = 'http', diagnose: wantDiag = false, reset = true, fetchImpl = fetch, cwd = process.cwd() } = opts;
  const warnings = [];
  const local = generateWorld(flow.scenario);

  try {
    if (reset) {
      const res = await fetchImpl(joinUrl(url, '/__atrezzo/reset'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ escenario: flow.scenario.name }) });
      const body = await res.json().catch(() => ({}));
      if (res.status !== 200) throw new AtrezzoError(`El mock en ${url} no pudo cargar el escenario "${flow.scenario.name}": ${body.error ?? res.status}`, { exitCode: EXIT.UNVERIFIABLE });
      if (body.hash && body.hash !== local.hash) warnings.push(`el mock sirve "${body.escenario}" con hash ${body.hash} pero el escenario local tiene ${local.hash}: ¿ficheros distintos?`);
    }
  } catch (e) {
    if (e instanceof AtrezzoError) throw e;
    throw new AtrezzoError(`No hay ningún mock escuchando en ${url} (${e.cause?.code ?? e.message}). Arráncalo con: atrezzo serve --escenario ${flow.scenario.name}`, { exitCode: EXIT.UNVERIFIABLE });
  }

  let pw = null;
  if (driver === 'playwright') pw = await (opts.pageFactory ? opts.pageFactory() : defaultPageFactory(cwd));

  const rows = [];
  try {
    for (const step of flow.steps) {
      const responses = {};
      const needHttp = driver === 'http' || wantDiag;
      if (needHttp) {
        for (const [name, path] of Object.entries(step.requests)) {
          try { responses[name] = { path, ...(await getJson(fetchImpl, joinUrl(url, path))) }; } catch (e) {
            throw new AtrezzoError(`Fallo de red pidiendo ${path}: ${e.message}`, { exitCode: EXIT.UNVERIFIABLE });
          }
        }
      }
      if (pw) {
        if (!step.visit) {
          for (const e of step.expect) rows.push({ screen: step.screen, expect: e, status: 'N/V', obtained: null, note: 'el paso no tiene "visit": playwright no sabe qué página abrir' });
          continue;
        }
        await pw.page.goto(joinUrl(url, step.visit));
        await pw.page.waitForLoadState?.('networkidle');
        if (step.waitFor) await pw.page.waitForSelector(step.waitFor, { timeout: 10_000 });
      }
      for (const e of step.expect) {
        const row = { screen: step.screen, expect: e, status: 'N/V', obtained: null, note: '' };
        const ctx = { driver };
        if (e.data && responses[e.data.request]) {
          const r = responses[e.data.request];
          ctx.response = r;
          ctx.items = r.status === 200 ? extractItems(r.body, e.data.pick) : [];
          ctx.matched = ctx.items.filter((it) => whereMatch(it, e.data.where)).length;
          if (wantDiag && r.status === 200) {
            const full = await getJson(fetchImpl, joinUrl(url, withoutPagination(r.path))).catch(() => null);
            if (full?.status === 200) ctx.fullMatched = extractItems(full.body, e.data.pick).filter((it) => whereMatch(it, e.data.where)).length;
          }
        }
        if (pw) {
          ctx.domCount = await pw.page.locator(e.selector).count();
          row.obtained = ctx.domCount;
        } else if (ctx.items) {
          row.obtained = ctx.matched;
        } else {
          row.note = 'sin "data": el driver http no puede contar un selector; añade data.request o usa --driver playwright';
          rows.push(row);
          continue;
        }
        ctx.obtained = row.obtained;
        row.status = passes(e, row.obtained) ? 'OK' : 'KO';
        if (row.status === 'KO' && wantDiag) row.hypotheses = diagnose(row, ctx);
        rows.push(row);
      }
    }
  } finally {
    if (pw) await pw.close();
  }

  const ko = rows.filter((r) => r.status === 'KO').length;
  const nv = rows.filter((r) => r.status === 'N/V').length;
  const exitCode = ko ? EXIT.FAIL : nv || !rows.length ? EXIT.UNVERIFIABLE : EXIT.OK;
  return { rows, exitCode, warnings, scenario: flow.scenario.name, seed: flow.scenario.seed, url, driver };
}

export function formatReport(result) {
  const head = [`Escenario: ${result.scenario} (semilla ${result.seed}) · driver: ${result.driver} · ${result.url}`];
  for (const w of result.warnings) head.push(`AVISO: ${w}`);
  const cols = ['#', 'pantalla', 'selector', 'esperado', 'obtenido', 'resultado'];
  const data = result.rows.map((r, i) => [String(i + 1), r.screen, r.expect.label ? `${r.expect.selector} (${r.expect.label})` : r.expect.selector, expectedText(r.expect), r.obtained === null ? '-' : String(r.obtained), r.status]);
  const widths = cols.map((c, i) => Math.max(c.length, ...data.map((d) => d[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const out = [...head, '', fmt(cols), fmt(widths.map((w) => '-'.repeat(w))), ...data.map(fmt)];
  result.rows.forEach((r, i) => {
    if (r.note) out.push(`  #${i + 1}: ${r.note}`);
    for (const h of r.hypotheses ?? []) out.push(`  #${i + 1} hipótesis [${h.confianza}] ${h.tipo}: ${h.evidencia}`);
  });
  const ok = result.rows.filter((r) => r.status === 'OK').length;
  const ko = result.rows.filter((r) => r.status === 'KO').length;
  const nv = result.rows.length - ok - ko;
  out.push('', `${ok} OK · ${ko} KO · ${nv} sin verificar → ${result.exitCode === 0 ? 'VERDE' : result.exitCode === 1 ? 'ROJO' : 'NO VERIFICADO'}`);
  return out.join('\n');
}
