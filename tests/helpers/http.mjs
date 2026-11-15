// Minimal HTTP client for the tests, built on node:http (no child processes here).
import { request as httpRequest } from 'node:http';

/** One request ⇒ { status, headers (a Headers object), text }. */
export function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, ko) => {
    const req = httpRequest(url, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        ok({ status: res.statusCode, headers: h, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', ko);
    });
    req.on('error', ko);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const parsed = async (p) => {
  const r = await p;
  return { status: r.status, headers: r.headers, body: r.text ? JSON.parse(r.text) : null };
};

/** GET and parse the JSON body ⇒ { status, headers, body }. */
export const getJson = (url, opts = {}) => parsed(request(url, { ...opts, method: 'GET' }));
/** POST (raw string body, as the tests send it) and parse the JSON body. */
export const postJson = (url, body, opts = {}) => parsed(request(url, { ...opts, method: 'POST', body }));
/** DELETE and parse the JSON body. */
export const del = (url, opts = {}) => parsed(request(url, { ...opts, method: 'DELETE' }));
