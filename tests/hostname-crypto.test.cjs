const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
vm.runInThisContext(fs.readFileSync(require('node:path').join(__dirname, '../hostname-crypto.js'), 'utf8'));
const codec = SiteClockHostnameCrypto;
const scope = { accountId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', generation: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', keyId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc' };
test('separate installations derive matching opaque IDs but randomized ciphertext and decrypt locally', async () => {
  const secret = codec.generateSecret();
  const a = await codec.derive(secret, scope.accountId);
  const b = await codec.derive(secret, scope.accountId);
  const first = await codec.encrypt(a, 'example.com', scope);
  const second = await codec.encrypt(b, 'example.com', scope);
  assert.equal(first.domainId, second.domainId);
  assert.notEqual(first.encryptedHostname.iv, second.encryptedHostname.iv);
  assert.notEqual(first.encryptedHostname.ciphertext, second.encryptedHostname.ciphertext);
  assert.equal(JSON.stringify(first).includes('example.com'), false);
  assert.equal(await codec.decrypt(b, first, scope), 'example.com');
});
test('wrong keys and changed ciphertext, account, generation or key context cannot decrypt', async () => {
  const keys = await codec.derive(codec.generateSecret(), scope.accountId);
  const record = await codec.encrypt(keys, 'example.com', scope);
  const wrong = await codec.derive(codec.generateSecret(), scope.accountId);
  await assert.rejects(codec.decrypt(wrong, record, scope));
  for (const field of ['accountId', 'generation', 'keyId']) await assert.rejects(codec.decrypt(keys, record, { ...scope, [field]: 'dddddddd-dddd-4ddd-dddd-dddddddddddd' }));
  const changed = structuredClone(record);
  changed.encryptedHostname.ciphertext = (changed.encryptedHostname.ciphertext[0] === 'A' ? 'B' : 'A') + changed.encryptedHostname.ciphertext.slice(1);
  await assert.rejects(codec.decrypt(keys, changed, scope));
});
test('account-scoped lookup keys prevent comparing site identifiers across accounts', async () => {
  const secret = codec.generateSecret();
  const a = await codec.derive(secret, scope.accountId);
  const b = await codec.derive(secret, 'dddddddd-dddd-4ddd-dddd-dddddddddddd');
  assert.notEqual(await codec.domainId(a, 'example.com'), await codec.domainId(b, 'example.com'));
  assert.equal(a.encryption.extractable, false);
  assert.equal(a.lookup.extractable, false);
});
test('malformed hostname, encryption envelope and key inputs are rejected', async () => {
  const keys = await codec.derive(codec.generateSecret(), scope.accountId);
  for (const host of ['www.example.com', 'example.com/path', 'EXAMPLE.COM', 'example.com?x=y', '']) await assert.rejects(codec.encrypt(keys, host, scope));
  await assert.rejects(codec.derive('not-a-real-key', scope.accountId));
  const record = await codec.encrypt(keys, 'example.com', scope);
  await assert.rejects(codec.decrypt(keys, { ...record, encryptedHostname: { ...record.encryptedHostname, iv: 'AA' } }, scope));
});
