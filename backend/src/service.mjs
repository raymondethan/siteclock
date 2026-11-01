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
function encryptedCounter(value) {
  check(value && typeof value.domainId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.domainId), 'Invalid hostname identifier.');
  const envelope = value.encryptedHostname;
  check(envelope && envelope.version === 1 &&
    typeof envelope.iv === 'string' && /^[A-Za-z0-9_-]{16}$/.test(envelope.iv) &&
    typeof envelope.ciphertext === 'string' && envelope.ciphertext.length >= 23 && envelope.ciphertext.length <= 359 && /^[A-Za-z0-9_-]+$/.test(envelope.ciphertext),
  'Invalid encrypted hostname.');
  uuid(envelope.keyId);
  check(Number.isSafeInteger(value.totalMs) && value.totalMs >= 0, 'Invalid duration.');
  return { domainId: value.domainId, encryptedHostname: { version: 1, keyId: envelope.keyId, iv: envelope.iv, ciphertext: envelope.ciphertext }, totalMs: value.totalMs };
}
export function date(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, 'Invalid calendar date.');
  return value;
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
        result = { accountId, email: claims.email || 'Google account', generation: profile.generation,
          privacyMode: profile.privacyMode || null, keyId: profile.keyId || null,
          pendingPrivacyMode: profile.pendingPrivacyMode || null, pendingKeyId: profile.pendingKeyId || null,
          pendingMigrationId: profile.pendingMigrationId || null,
          pendingMigrationInstallation: profile.pendingMigrationInstallation || null,
          migrationId: profile.lastMigrationId || null, migrationInstallationId: profile.lastMigrationInstallation || null,
          legacyData: profile.privacyMode === 'migrating' || (['unencrypted', undefined].includes(profile.privacyMode) &&
            typeof store.hasUsage === 'function' && await store.hasUsage(accountId, profile.generation)) };
      } else if (method === 'PUT' && path === '/v1/privacy') {
        uuid(body.generation);
        if (body.privacyMode === 'migrating') {
          check(['recovery', 'device'].includes(body.targetMode), 'Invalid migration target.');
          if (body.targetMode === 'recovery') uuid(body.targetKeyId);
          else check(body.targetKeyId === undefined, 'Unexpected encryption key identifier.');
          uuid(body.migrationId); uuid(body.installationId);
          const configured = await store.configurePrivacy(accountId, body.generation, 'migrating', undefined,
            { targetMode: body.targetMode, targetKeyId: body.targetKeyId, migrationId: body.migrationId, installationId: body.installationId });
          result = { privacyMode: configured.privacyMode, pendingPrivacyMode: configured.pendingPrivacyMode };
        } else {
          check(['recovery', 'device', 'unencrypted'].includes(body.privacyMode), 'Invalid hostname privacy setting.');
          if (body.privacyMode === 'recovery') uuid(body.keyId);
          else check(body.keyId === undefined, 'Unexpected encryption key identifier.');
          if (body.installationId !== undefined) uuid(body.installationId);
          const configured = await store.configurePrivacy(accountId, body.generation, body.privacyMode, body.keyId,
            { ownerInstallationId: body.installationId });
          result = { privacyMode: configured.privacyMode, keyId: configured.keyId || null };
        }
      } else if (method === 'PUT' && path === '/v1/installations') {
        uuid(body.generation); uuid(body.installationId);
        await store.register(accountId, body.generation, body.installationId, profile.privacyMode);
        result = { ok: true };
      } else if (method === 'PUT' && path === '/v1/usage') {
        uuid(body.generation); uuid(body.installationId);
        if (profile.privacyMode === 'migrating') throw new HttpError(409, 'Cloud backup is paused for an encrypted history migration.');
        check(Array.isArray(body.counters) && body.counters.length > 0 && body.counters.length <= 50, 'Send between 1 and 50 counters.');
        check(body.schemaVersion === undefined || [2, 3].includes(body.schemaVersion), 'Unsupported usage schema.');
        const encrypted = body.schemaVersion === 3 && ['recovery', 'device'].includes(profile.privacyMode);
        check(!(profile.privacyMode && profile.privacyMode !== 'unencrypted' && body.schemaVersion !== 3), 'Update SiteClock to use encrypted hostname backup.');
        check(!(encrypted && body.counters.some(value => value?.hostname !== undefined)), 'Plaintext hostnames are not accepted for this account.');
        check(!(body.schemaVersion === 3 && profile.privacyMode === 'unencrypted' && body.counters.some(value => value?.domainId !== undefined)), 'Encrypted hostnames are not enabled for this account.');
        const counters = body.counters.map(value => ({ ...(encrypted ? encryptedCounter(value) : counter(value)),
          ...(body.schemaVersion >= 2 && value.day !== undefined ? { day: date(value.day) } : {}) }));
        if (profile.privacyMode === 'recovery') check(counters.every(row => row.encryptedHostname?.keyId === profile.keyId), 'Hostname encryption key does not match this account.');
        if (profile.privacyMode === 'device') check(counters.every(row => row.encryptedHostname?.keyId === body.installationId), 'Hostname encryption key does not match this installation.');
        check(new Set(counters.map(row => `${row.day || 'BASE'}/${row.domainId || row.hostname}`)).size === counters.length, 'Duplicate hostnames.');
        await store.register(accountId, body.generation, body.installationId, profile.privacyMode);
        // Partial batches are intentional: the client retries absolute values safely.
        for (const row of counters) await (body.schemaVersion >= 2 ? store.uploadPeriod : store.upload).call(store, accountId, body.generation, body.installationId, row, profile.privacyMode);
        result = { ok: true };
      } else if (method === 'GET' && path === '/v1/usage') {
        const generation = uuid(event.queryStringParameters?.generation);
        if (profile.generation !== generation) throw new HttpError(409, 'Cloud history changed.');
        const { from, to } = event.queryStringParameters || {};
        let range;
        if (from !== undefined || to !== undefined) {
          date(from); date(to);
          check(from <= to && Date.parse(to) - Date.parse(from) <= 366 * 86_400_000, 'Invalid date range.');
          range = { from, to };
        }
        result = await store.usage(accountId, generation, event.queryStringParameters?.cursor, range);
        if ((await store.account(accountId)).generation !== generation) throw new HttpError(409, 'Cloud history changed.');
        result.generation = generation; result.privacyMode = profile.privacyMode || null; result.keyId = profile.keyId || null;
      } else if (method === 'DELETE' && path === '/v1/usage') {
        uuid(body.generation);
        if (body.migrationId !== undefined) { uuid(body.migrationId); uuid(body.installationId); }
        result = { generation: await store.clear(accountId, body.generation, randomUUID(), body.migrationId, body.installationId) };
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
