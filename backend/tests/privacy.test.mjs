import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/service.mjs';
const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const generation = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const installation = 'cccccccc-cccc-4ccc-bccc-cccccccccccc';
const envelope = { version: 1, keyId: installation, iv: 'A'.repeat(16), ciphertext: 'B'.repeat(32) };
const row = { domainId: 'C'.repeat(43), encryptedHostname: envelope, totalMs: 12, day: '2026-11-01' };
function fixture(privacyMode) {
  const writes = [];
  const store = { async account() { return { generation, privacyMode, keyId: installation }; },
    async register() {}, async uploadPeriod(...args) { writes.push(args); },
    async configurePrivacy(...args) { writes.push(args); return { privacyMode: args[2], keyId: args[3] }; } };
  const handler = createHandler(store);
  const call = async (body, path = '/v1/usage') => handler({ rawPath: path, body: JSON.stringify(body), requestContext: {
    http: { method: 'PUT' }, authorizer: { jwt: { claims: { sub: id, token_use: 'access' } } } } });
  return { call, writes };
}
test('encrypted accounts reject plaintext, old clients, wrong key IDs and malformed envelopes without writes', async () => {
  for (const mode of ['recovery', 'device']) {
    const { call, writes } = fixture(mode);
    for (const counters of [[{ hostname: 'example.com', totalMs: 1 }], [{ ...row, encryptedHostname: { ...envelope, keyId: generation } }],
      [{ ...row, encryptedHostname: { ...envelope, ciphertext: 'AA' } }], [null]]) {
      const result = await call({ generation, installationId: installation, schemaVersion: 3, counters });
      assert.equal(result.statusCode, 400);
    }
    assert.equal((await call({ generation, installationId: installation, schemaVersion: 2, counters: [{ hostname: 'example.com', totalMs: 1 }] })).statusCode, 400);
    assert.equal(writes.length, 0);
    assert.equal((await call({ generation, installationId: installation, schemaVersion: 3, counters: [row] })).statusCode, 200);
    assert.equal(writes[0][4], mode);
    assert.equal(JSON.stringify(writes).includes('hostname'), false);
  }
});
test('privacy configuration validates migration ownership and is scoped to the signed-in account', async () => {
  const { call, writes } = fixture(undefined);
  assert.equal((await call({ generation, privacyMode: 'migrating', targetMode: 'device' }, '/v1/privacy')).statusCode, 400);
  assert.equal((await call({ accountId: generation, generation, privacyMode: 'recovery', keyId: installation }, '/v1/privacy')).statusCode, 200);
  assert.equal(writes[0][0], id);
});
