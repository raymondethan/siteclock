const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '../options.js'), 'utf8');

function settings(sendMessage) {
  const elements = Object.fromEntries(['account', 'signin', 'signout', 'backup', 'status', 'retry', 'delete', 'privacyMode', 'backupIntro'].map(id => [id, {
    id, textContent: '', hidden: false, disabled: false, checked: false, listeners: {},
    addEventListener(event, callback) { this.listeners[event] = callback; },
    matches(selector) { return selector === 'button, input'; }
  }]));
  const timers = [];
  const context = vm.createContext({ document: { getElementById: id => elements[id] }, chrome: { runtime: { sendMessage } },
    confirm: () => true, Date, Promise, Error, Object, setInterval() {}, setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {} });
  vm.runInContext(source, context);
  return { elements, timers };
}

test('settings expose sign-in recovery when cloud status times out', async () => {
  const ui = settings(() => new Promise(() => {}));
  const timer = ui.timers.find(item => item.delay === 10_000);
  assert.ok(timer);
  timer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.elements.signin.disabled, false);
  assert.equal(ui.elements.backup.disabled, true);
  assert.match(ui.elements.status.textContent, /taking too long/);
});

test('settings explain which cloud environment the account uses', async () => {
  const ui = settings(async () => ({ configured: true, environment: 'development', signedIn: false, enabled: false }));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(ui.elements.status.textContent, /Development service/);
  assert.equal(ui.elements.signin.disabled, false);
});
