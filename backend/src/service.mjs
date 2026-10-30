import { randomUUID } from 'node:crypto';
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const check = (condition, message) => { if (!condition) throw new HttpError(400, message); };
export function uuid(value) {
  check(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value), 'Invalid identifier.');
  return value;
}
export function counter(value) {
  check(value && typeof value.hostname === 'string' && value.hostname.length <= 253 &&
    /^[a-z0-9.[\]:-]+$/.test(value.hostname), 'Invalid hostname.');
  let parsed;
  try { parsed = new URL(`https://${value.hostname}/`); } catch { throw new HttpError(400, 'Invalid hostname.'); }
  check(parsed.hostname === value.hostname && !value.hostname.startsWith('www.'), 'Hostname must be normalized.');
  check(Number.isSafeInteger(value.totalMs) && value.totalMs >= 0, 'Invalid duration.');
  return { hostname: value.hostname, totalMs: value.totalMs };
}
export function createHandler(store) {
  return async event => {
    try {
      const claims = event.requestContext?.authorizer?.jwt?.claims;
      if (!claims?.sub || claims.token_use !== 'access') throw new HttpError(401, 'Sign in required.');
      const accountId = uuid(claims.sub);
      const method = event.requestContext.http.method;
      const path = event.rawPath;
      let body = {};
      if (event.body) {
        const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
        check(Buffer.byteLength(raw) <= 32_768, 'Request is too large.');
        try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON.'); }
        check(body && typeof body === 'object' && !Array.isArray(body), 'Invalid request.');
      }
      const profile = await store.account(accountId);
      let result;
      if (method === 'GET' && path === '/v1/account') {
        // Access tokens normally omit email; the user ID is sufficient for ownership.
        result = { accountId, email: claims.email || 'Google account', generation: profile.generation };
      } else if (method === 'PUT' && path === '/v1/installations') {
        uuid(body.generation); uuid(body.installationId);
        await store.register(accountId, body.generation, body.installationId);
        result = { ok: true };
      } else if (method === 'PUT' && path === '/v1/usage') {
        uuid(body.generation); uuid(body.installationId);
        check(Array.isArray(body.counters) && body.counters.length > 0 && body.counters.length <= 50, 'Send between 1 and 50 counters.');
        const counters = body.counters.map(counter);
        check(new Set(counters.map(row => row.hostname)).size === counters.length, 'Duplicate hostnames.');
        // Partial batches are intentional: the client retries absolute values safely.
        for (const row of counters) await store.upload(accountId, body.generation, body.installationId, row);
        result = { ok: true };
      } else if (method === 'GET' && path === '/v1/usage') {
        const generation = uuid(event.queryStringParameters?.generation);
        if (profile.generation !== generation) throw new HttpError(409, 'Cloud history changed.');
        result = await store.usage(accountId, generation, event.queryStringParameters?.cursor);
        if ((await store.account(accountId)).generation !== generation) throw new HttpError(409, 'Cloud history changed.');
        result.generation = generation;
      } else if (method === 'DELETE' && path === '/v1/usage') {
        uuid(body.generation);
        result = { generation: await store.clear(accountId, body.generation, randomUUID()) };
      } else throw new HttpError(404, 'Not found.');
      return response(200, result);
    } catch (error) {
      // Do not log SDK inputs, tokens, hostnames, claims, or request bodies.
      if (!error.status) console.error('SiteClock backend operation failed', { name: error.name });
      return response(error.status || 503, { message: error.status ? error.message : 'Service temporarily unavailable. Please retry.' });
    }
  };
}
function response(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}
