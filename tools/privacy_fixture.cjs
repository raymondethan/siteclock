/* Synthetic smoke-test crypto. JSON input/output stays in the invoking process. */
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../hostname-crypto.js'), 'utf8'));
(async () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const secret = input.secret || SiteClockHostnameCrypto.generateSecret();
  const namespace = input.mode === 'device' ? `${input.accountId}#${input.installationId}` : input.accountId;
  const keys = await SiteClockHostnameCrypto.derive(secret, namespace);
  const scope = { accountId: input.accountId, generation: input.generation,
    keyId: input.mode === 'device' ? input.installationId : keys.keyId,
    ...(input.mode === 'device' ? { installationId: input.installationId, keyNamespace: namespace } : {}) };
  if (input.record) {
    const hostname = await SiteClockHostnameCrypto.decrypt(keys, input.record, scope);
    process.stdout.write(JSON.stringify({ hostname }));
  } else {
    process.stdout.write(JSON.stringify({ secret, keyId: scope.keyId,
      row: await SiteClockHostnameCrypto.encrypt(keys, 'privacy-smoke.example', scope) }));
  }
})().catch(error => { console.error(error.name); process.exitCode = 1; });
