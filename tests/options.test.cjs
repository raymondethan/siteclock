const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '../options.js'), 'utf8');
const welcome = fs.readFileSync(require('node:path').join(__dirname, '../welcome.html'), 'utf8');
const settingsHtml = fs.readFileSync(require('node:path').join(__dirname, '../options.html'), 'utf8');
const styles = fs.readFileSync(require('node:path').join(__dirname, '../options.css'), 'utf8');

function settings(sendMessage) {
  const ids = ['account', 'authState', 'encryptionStatus', 'signin', 'signout', 'backupIntro', 'backupSetup', 'backupActive', 'backupChoices', 'keyOptions', 'recoveryInputRow', 'recoveryCode', 'backupConsent', 'enableBackup', 'backupToggle', 'privacyMode', 'status', 'retry', 'delete', 'backfillPanel', 'backfillSummary', 'backfillSource', 'backfill', 'recoveryPanel', 'recoveryHeading', 'recoveryInstructions', 'newRecoveryCode', 'savedCodeLabel', 'savedCode', 'migrationConsentRow', 'migrationConsent', 'confirmRecoveryCode'];
  const elements = Object.fromEntries(ids.map(id => [id, {
    id, textContent: '', className: '', hidden: false, disabled: false, checked: false, listeners: {},
    addEventListener(event, callback) { this.listeners[event] = callback; },
    options: [], value: '',
    matches(selector) { return selector === 'button, input, select'; },
    replaceChildren() { this.options = []; this.value = ''; },
    append(option) { this.options.push(option); if (!this.value) this.value = option.value; }
  }]));
  const radios = [
    ...['recovery', 'unencrypted'].map(value => ({ name: 'backupMode', value, checked: value === 'recovery', disabled: false, listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; } })),
    ...['generate', 'use'].map(value => ({ name: 'keyAction', value, checked: value === 'generate', disabled: false, listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; } }))
  ];
  elements.backupSetup.hidden = true;
  elements.backupActive.hidden = true;
  elements.recoveryPanel.hidden = true;
  elements.enableBackup.disabled = true;
  elements.savedCodeLabel.hidden = false;
  elements.migrationConsentRow.hidden = true;
  const document = {
    getElementById: id => elements[id],
    createElement: () => ({ value: '', textContent: '' }),
    querySelector: selector => radios.find(item => selector.includes(item.name) && item.checked),
    querySelectorAll: selector => radios.filter(item => selector.includes(item.name))
  };
  const timers = [];
  const calls = [];
  const runtime = { async sendMessage(message) { calls.push(message); return sendMessage(message); } };
  const context = vm.createContext({ document, chrome: { runtime },
    confirm: () => true, Date, Promise, Error, Object, setInterval() {}, setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {} });
  vm.runInContext(source, context);
  return { elements, radios, timers, calls };
}

test('settings expose sign-in recovery when cloud status times out', async () => {
  const ui = settings(() => new Promise(() => {}));
  const timer = ui.timers.find(item => item.delay === 10_000);
  assert.ok(timer);
  timer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.elements.signin.disabled, false);
  assert.equal(ui.elements.signin.hidden, false);
  assert.equal(ui.elements.signin.textContent, 'Retry account check');
  assert.match(ui.elements.authState.textContent, /does not mean Google sign-in failed/);
  assert.equal(ui.elements.authState.className, 'auth-state unknown');
  assert.equal(ui.elements.enableBackup.disabled, true);
  assert.match(ui.elements.status.textContent, /taking too long/);
});

test('settings explain which cloud environment the account uses', async () => {
  const ui = settings(async () => ({ configured: true, environment: 'development', signedIn: false, enabled: false }));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(ui.elements.status.textContent, /Development service/);
  assert.equal(ui.elements.signin.disabled, false);
  assert.equal(ui.elements.signin.hidden, false);
  assert.equal(ui.elements.backupSetup.hidden, true);
});

test('successful Google sign-in reveals the explicit backup choices', async () => {
  const ui = settings(async () => ({ configured: true, environment: 'production', signedIn: true, enabled: false, email: 'person@example.test' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.elements.signin.hidden, false);
  assert.equal(ui.elements.signin.textContent, 'Switch Google account');
  assert.equal(ui.elements.authState.className, 'auth-state success');
  assert.match(ui.elements.authState.textContent, /Google sign-in successful/);
  assert.match(ui.elements.status.textContent, /Signed in\. Cloud backup has not started/);
  assert.equal(ui.elements.backupSetup.hidden, false);
  assert.equal(ui.elements.backupActive.hidden, true);
  assert.match(ui.elements.encryptionStatus.textContent, /NOT SET UP/);
});

test('expired cloud credentials say reconnect required, not Google sign-in failed', async () => {
  const ui = settings(async () => ({ configured: true, environment: 'production', signedIn: true, enabled: false,
    email: 'person@example.test', error: 'Sign in again to resume backup.' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.elements.authState.className, 'auth-state expired');
  assert.match(ui.elements.authState.textContent, /Reconnect required/);
  assert.doesNotMatch(ui.elements.authState.textContent, /sign-in failed/i);
  assert.equal(ui.elements.signin.textContent, 'Reconnect Google account');
  await ui.elements.signin.listeners.click();
  assert.equal(ui.calls.at(-1).type, 'siteclock:cloud:signin');
});

test('credential refresh error offers Google reconnect rather than an account-check retry', async () => {
  const ui = settings(async message => message.type.endsWith(':signin')
    ? { configured: true, environment: 'production', signedIn: true, enabled: false, email: 'person@example.test' }
    : { error: 'Sign in again to resume backup.' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.elements.authState.className, 'auth-state expired');
  assert.equal(ui.elements.signin.textContent, 'Reconnect Google account');
  ui.elements.signin.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.calls.at(-1).type, 'siteclock:cloud:signin');
  assert.equal(ui.elements.authState.className, 'auth-state success');
});

test('Google sign-in shows pending then success explicitly', async () => {
  let completeSignIn;
  const signedOut = { configured: true, environment: 'production', signedIn: false, enabled: false };
  const signedIn = { configured: true, environment: 'production', signedIn: true, enabled: false, email: 'person@example.test' };
  const ui = settings(message => message.type.endsWith(':signin')
    ? new Promise(resolve => { completeSignIn = resolve; }) : Promise.resolve(signedOut));
  await new Promise(resolve => setImmediate(resolve));
  ui.elements.signin.listeners.click();
  assert.equal(ui.elements.authState.className, 'auth-state pending');
  assert.match(ui.elements.authState.textContent, /in progress/);
  completeSignIn(signedIn);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.elements.authState.className, 'auth-state success');
  assert.match(ui.elements.authState.textContent, /connected as person@example\.test/);
});

test('Google sign-in failures are labeled as failures with a real sign-in retry', async () => {
  const state = { configured: true, environment: 'production', signedIn: false, enabled: false };
  const ui = settings(async message => message.type.endsWith(':signin') ? { error: 'User cancelled Google sign-in.' } : state);
  await new Promise(resolve => setImmediate(resolve));
  ui.elements.signin.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.elements.authState.className, 'auth-state failed');
  assert.match(ui.elements.authState.textContent, /Google sign-in failed: User cancelled/);
  assert.equal(ui.elements.signin.textContent, 'Try Google sign-in again');
});

test('settings offer a one-time import for a prior matching account while backup is enabled', async () => {
  const sourceAccount = { sourceAccountId: 'old-account', email: 'person@example.test', siteCount: 12, totalMs: 7_200_000, dayCount: 5 };
  const ui = settings(async message => ({ configured: true, environment: 'production', signedIn: true, enabled: true,
    email: 'person@example.test', privacyMode: 'recovery', backfillSources: message.type.endsWith(':backfill') ? [] : [sourceAccount],
    ...(message.type.endsWith(':backfill') ? { backfilled: { siteCount: 12, totalMs: 7_200_000 } } : {}) }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.elements.backfillPanel.hidden, false);
  assert.equal(ui.elements.backfillSource.value, 'old-account');
  await ui.elements.backfill.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.calls.at(-1).sourceAccountId, 'old-account');
  assert.match(ui.elements.status.textContent, /Imported and synced 12 sites/);
});

test('recovery code is the default and its display uses dark high-contrast text', () => {
  assert.match(welcome, /value="recovery" checked/);
  assert.match(styles, /#recoveryPanel \{[^}]*color: #17251c/);
  assert.match(styles, /#newRecoveryCode \{[^}]*color: #142018/);
});

test('signup keeps the secure default in the primary path and collapses advanced choices', () => {
  assert.match(welcome, /Back up across computers/);
  assert.match(welcome, /Continue with Google/);
  assert.match(welcome, /Continue with local tracking/);
  assert.match(welcome, /<details id="privacyOptionsDetails">/);
  assert.match(welcome, /<details id="existingCodeDetails" class="existing-code">/);
  assert.match(welcome, /value="recovery" checked/);
});

test('settings sign-in is always available when signed out and backup offers two protection choices', () => {
  assert.match(settingsHtml, /<button id="signin">Sign in with Google<\/button>/);
  assert.match(settingsHtml, /name="backupMode" value="recovery" checked/);
  assert.match(settingsHtml, /name="backupMode" value="unencrypted"/);
  assert.match(settingsHtml, /name="keyAction" value="generate" checked/);
  assert.match(settingsHtml, /name="keyAction" value="use"/);
  assert.doesNotMatch(settingsHtml, /id="backup" type="checkbox"/);
});

test('settings clearly report hostname encryption state for encrypted and unencrypted accounts', async () => {
  const encrypted = settings(async () => ({ configured: true, signedIn: true, enabled: true, privacyMode: 'recovery' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(encrypted.elements.encryptionStatus.hidden, false);
  assert.match(encrypted.elements.encryptionStatus.textContent, /encryption: ON/);
  const plaintext = settings(async () => ({ configured: true, signedIn: true, enabled: true, privacyMode: 'unencrypted' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(plaintext.elements.encryptionStatus.textContent, /encryption: OFF/);
});
