// Generado por atrezzo. No editar a mano: cambia el escenario y ejecuta `atrezzo world`.
// Escenario: pedidos · semilla 7712 · now 2025-03-01T09:00:00.000Z · hash 681ff6fdb90a8a35
import { http, HttpResponse } from 'msw';
import dataset from './pedidos.json' with { type: 'json' };
import { createEngine } from './runtime.mjs';

const engine = createEngine(dataset);

/** Proyecta la petición con el mismo motor que `atrezzo serve`. */
function project({ request }) {
  const url = new URL(request.url);
  const res = engine.handle({ method: request.method, pathname: url.pathname, query: url.searchParams });
  if (!res) return undefined; // no es nuestra: MSW sigue con el siguiente handler
  return HttpResponse.json(res.body, { status: res.status, headers: res.headers });
}

export const handlers = [
  // /api/orders → pedidos · filtros: estado, client_id · paginación: limit/offset · incluye: clientes
  http.get('*/api/orders', project),
  http.get('*/api/orders/:id', project),
  // /api/customers → clientes
  http.get('*/api/customers', project),
  http.get('*/api/customers/:id', project),
];

export { dataset };
