// Find the requests that flows (flow YAML files) make against a scenario, so static
// runtimes (wiremock) can pre-compute exactly those combinations.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseYaml } from './yaml.mjs';

/** Top-level *.yaml in the usual places; flows whose `scenario` resolves to scenarioFile. */
export function flowRequests(projectDir, scenariosDir, scenarioFile) {
  const dirs = [...new Set([projectDir, join(projectDir, 'atrezzo'), join(projectDir, 'atrezzo', 'flujos'), dirname(scenariosDir)].map((d) => resolve(d)))];
  const out = [];
  const files = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort()) {
      if (!/\.ya?ml$/.test(f)) continue;
      const file = join(d, f);
      let doc;
      try { doc = parseYaml(readFileSync(file, 'utf8'), file); } catch { continue; }
      if (!doc || typeof doc.scenario !== 'string' || !Array.isArray(doc.steps)) continue;
      if (resolve(dirname(file), doc.scenario) !== resolve(scenarioFile)) continue;
      files.push(file);
      for (const st of doc.steps) {
        for (const v of Object.values(st?.requests ?? {})) {
          const m = typeof v === 'string' ? /^GET\s+(\/\S*)$/.exec(v.trim()) : null;
          if (m) out.push(m[1]);
        }
      }
    }
  }
  return { requests: [...new Set(out)], files };
}
