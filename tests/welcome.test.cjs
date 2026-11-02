const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../welcome.js'), 'utf8');
async function welcome(configured = true, requireExistingRecoveryCode = false) {
  const elements = Object.fromEntries(['local', 'consent', 'backup', 'status', 'retry', 'browse', 'privacyChoices', 'existingCodeDetails', 'recoveryCode', 'recoveryPanel', 'newRecoveryCode', 'savedCode', 'savedCodeLabel', 'migrationConsent', 'migrationConsentRow', 'recoveryHeading', 'recoveryInstructions', 'enableAfterRecovery', 'cancelMigration'].map(id => [id, {
    checked: false, disabled: false, hidden: false, open: false, listeners: {},
    value: '', querySelectorAll() { return []; }, addEventListener(event, callback) { this.listeners[event] = callback; }
  }]));
  elements.recoveryPanel.hidden = true;
  const calls = [];
  const state = { configured, enabled: false };
  const chrome = { runtime: { async sendMessage(message) {
    calls.push(message.type);
    if (requireExistingRecoveryCode && message.type.endsWith(':signin-enable')) return { error: 'Enter your recovery code to unlock this account.' };
    if (message.type.endsWith(':signin-enable')) Object.assign(state, { enabled: true, lastSync: 123 });
    return { ...state };
  } }, tabs: { async update() {} } };
  vm.runInNewContext(source, { document: { getElementById: id => elements[id], querySelector: () => ({ value: 'recovery' }) }, chrome, setInterval() {} });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, calls };
}
test('welcome requires explicit unchecked consent before requesting sign-in and backup', async () => {
  const { elements, calls } = await welcome();
  assert.equal(elements.consent.checked, false);
  assert.equal(elements.backup.disabled, true);
  await elements.backup.listeners.click();
  assert.deepEqual(calls, ['siteclock:cloud:status']);
  elements.consent.checked = true; elements.consent.listeners.change();
  assert.equal(elements.backup.disabled, false);
  await elements.backup.listeners.click();
  assert.equal(calls.at(-1), 'siteclock:cloud:signin-enable');
  assert.match(elements.status.textContent, /Your time is backed up/);
});
test('local-only choice never requests Google sign-in or enables backup', async () => {
  const { elements, calls } = await welcome();
  await elements.local.listeners.click();
  assert.deepEqual(calls, ['siteclock:cloud:status', 'siteclock:cloud:pause']);
  assert.match(elements.status.textContent, /stays on this computer/);
});
test('unconfigured builds still offer local use and keep backup unavailable', async () => {
  const { elements } = await welcome(false);
  elements.consent.checked = true; elements.consent.listeners.change();
  assert.equal(elements.backup.disabled, true);
  assert.equal(elements.local.disabled, false);
});
test('existing encrypted account opens the recovery-code entry when required', async () => {
  const { elements } = await welcome(true, true);
  elements.consent.checked = true; elements.consent.listeners.change();
  await elements.backup.listeners.click();
  assert.equal(elements.existingCodeDetails.open, true);
  assert.match(elements.status.textContent, /account already has encrypted history/);
});
