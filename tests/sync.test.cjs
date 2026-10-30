const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const file of ['sync-core.js', 'core.js']) vm.runInThisContext(fs.readFileSync(path.join(root, file), 'utf8'));
const { Ledger } = SiteClockSync;
const a = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const g = '11111111-1111-4111-8111-111111111111';
const g2 = '22222222-2222-4222-8222-222222222222';
function ledger(id = a, initial = {}) { return new Ledger(null, initial, () => id); }
function enable(l) { l.signIn(a, 'a@example.test'); l.enable(g); }

test('legacy import is explicit, occurs once, and preserves installation identity', () => {
  const l = ledger(a, { 'example.com': 100 });
  l.signIn(a, 'a@example.test');
  assert.equal(l.account.enabled, false);
  assert.equal(l.totals()['example.com'], 100);
  l.enable(g); l.pause(); l.enable(g);
  assert.equal(l.account.local['example.com'], 100);
  const restored = new Ledger(JSON.parse(JSON.stringify(l.state)), {}, () => b);
  assert.equal(restored.state.installationId, a);
  assert.equal(restored.totals()['example.com'], 100);
});
test('aggregate includes live local usage but excludes own downloaded copy', () => {
  const l = ledger(); enable(l); l.account.local['example.com'] = 20;
  l.merge([{ installationId: b, hostname: 'example.com', totalMs: 10 }, { installationId: a, hostname: 'example.com', totalMs: 20 }]);
  assert.equal(l.totals()['example.com'], 30);
  assert.deepEqual(l.pending(), [{ hostname: 'example.com', totalMs: 20 }]);
});
test('downloads merge by maximum; acknowledgements preserve increments during upload', () => {
  const l = ledger(); enable(l); l.account.local['example.com'] = 20;
  const upload = l.pending(); l.account.local['example.com'] += 5;
  l.acknowledge(upload);
  l.merge([{ installationId: b, hostname: 'example.com', totalMs: 10 }]);
  l.merge([{ installationId: b, hostname: 'example.com', totalMs: 7 }]);
  assert.equal(l.totals()['example.com'], 35);
  assert.equal(l.pending()[0].totalMs, 25);
});
test('pause accumulates and re-enable catches up', () => {
  const l = ledger(); enable(l); l.account.local['example.com'] = 20;
  l.acknowledge(l.pending()); l.pause(); l.account.local['example.com'] += 5; l.enable(g);
  assert.equal(l.pending()[0].totalMs, 25);
});
test('account switching and repeated import never transfer assigned history', () => {
  const l = ledger(a, { 'example.com': 20 }); enable(l);
  l.signOut(); l.state.unassigned['signedout.test'] = 3;
  l.signIn(b, 'b@example.test'); l.enable(g);
  assert.equal(l.account.local['example.com'], undefined);
  assert.equal(l.account.local['signedout.test'], 3);
  l.signOut(); l.signIn(a, 'a@example.test'); l.enable(g);
  assert.equal(l.account.local['example.com'], 20);
  assert.equal(l.account.local['signedout.test'], undefined);
});
test('deletion retires local counters, invalidates caches, and requires fresh opt-in', () => {
  const l = ledger(); enable(l); l.account.local['example.com'] = 20;
  l.merge([{ installationId: b, hostname: 'example.com', totalMs: 10 }]);
  assert.equal(l.generation(g2), false);
  assert.equal(l.account.enabled, false);
  assert.equal(l.totals()['example.com'], 20);
  l.account.local['example.com'] = 5;
  l.enable(g2);
  assert.equal(l.totals()['example.com'], 5);
  assert.deepEqual(l.pending(), [{ hostname: 'example.com', totalMs: 5 }]);
});
test('restore into a fresh installation starts at zero contribution', () => {
  const l = ledger(b); enable(l);
  l.merge([{ installationId: a, hostname: 'example.com', totalMs: 20 }]);
  assert.equal(l.totals()['example.com'], 20);
  assert.deepEqual(l.pending(), []);
  l.account.local['example.com'] = 5;
  assert.equal(l.totals()['example.com'], 25);
});

const harness = fs.readFileSync(path.join(__dirname, 'suite.js'), 'utf8').split('const cases =')[0];
const environment = new Function('SiteClockCore', 'SiteClockSync', 'backgroundSource', harness + '\nreturn environment;')(
  SiteClockCore, SiteClockSync, fs.readFileSync(path.join(root, 'background.js'), 'utf8'));
function fakeCloud() {
  return { configured: true, calls: [], generation: g, pages: [{ contributions: [], cursor: null }],
    async signIn() { return { accountId: a, email: 'a@example.test', generation: this.generation }; },
    async signOut() {},
    async api(url, method = 'GET', body, expectedAccount) {
      this.calls.push({ url, method, body, expectedAccount });
      if (this.intercept) await this.intercept(url, method, body);
      if (url === '/v1/account') return { accountId: a, generation: this.generation };
      if (method === 'DELETE') { this.generation = g2; return { generation: g2 }; }
      if (url.startsWith('/v1/usage?')) return this.pages[Number(new URLSearchParams(url.split('?')[1]).get('cursor') || 0)];
      return { ok: true };
    }
  };
}
async function worker() {
  const e = environment(); e.cloud = fakeCloud(); await e.start();
  await e.worker.controlCloud({ type: 'siteclock:cloud:signin' });
  return e;
}
const control = (e, action) => e.worker.controlCloud({ type: `siteclock:cloud:${action}` });
test('worker sync is opt-in and content scripts cannot invoke account controls', async () => {
  const e = await worker();
  assert.equal(e.cloud.calls.length, 0);
  let responded = false;
  e.chrome.runtime.onMessage.emit({ type: 'siteclock:cloud:enable' }, { id: e.chrome.runtime.id, tab: e.tabList[0] }, () => { responded = true; });
  await e.drain();
  assert.equal(responded, false);
  await control(e, 'enable');
  assert.equal(e.cloud.calls.some(call => call.url.startsWith('/v1/usage?')), true);
});
test('worker paginates, displays account totals and does not upload downloads', async () => {
  const e = await worker();
  e.cloud.pages = [
    { contributions: [{ installationId: b, hostname: 'example.com', totalMs: 10_000 }], cursor: '1' },
    { contributions: [{ installationId: b, hostname: 'other.test', totalMs: 2000 }], cursor: null }
  ];
  await control(e, 'enable');
  e.advance(5000); await e.send();
  const summary = await e.send(1, 'siteclock:summary');
  assert.equal(summary.totals['example.com'], 15_000);
  await e.worker.syncCloud(true);
  const uploads = e.cloud.calls.filter(call => call.method === 'PUT' && call.url === '/v1/usage');
  assert.equal(uploads.at(-1).body.counters[0].totalMs, 5000);
  assert.ok(uploads.every(call => call.expectedAccount === a));
});
test('worker preserves tracking while upload is in flight and retries network failures', async () => {
  const e = await worker(); await control(e, 'enable');
  e.advance(5000); await e.send();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  e.cloud.intercept = async (url, method) => { if (url === '/v1/usage' && method === 'PUT') { started(); await blocked; } };
  const sync = e.worker.syncCloud(true); await ready;
  e.advance(5000); await e.send(); release(); await sync;
  assert.equal(e.total('example.com'), 10_000);
  assert.equal(e.persistent.siteclock.cloud.accounts[a].acknowledged['example.com'], 5000);
  e.cloud.intercept = async () => { throw Error('offline'); };
  await e.worker.syncCloud(true);
  assert.match(e.worker.cloudStatus().error, /Local tracking continues/);
  assert.equal(e.total('example.com'), 10_000);
  e.cloud.intercept = null; await e.worker.syncCloud(true);
  assert.equal(e.worker.cloudStatus().error, null);
});
test('worker detects remote deletion, pauses, and does not re-upload old counters', async () => {
  const e = await worker(); await control(e, 'enable');
  e.advance(5000); await e.send();
  e.cloud.generation = g2;
  await e.worker.syncCloud(true);
  assert.equal(e.worker.cloudStatus().enabled, false);
  assert.equal(e.persistent.siteclock.cloud.accounts[a].localOnly['example.com'], 5000);
  await control(e, 'enable');
  const uploads = e.cloud.calls.filter(call => call.url === '/v1/usage' && call.method === 'PUT');
  assert.equal(uploads.length, 0);
});
test('summary refreshes do not turn minute sync into ten-second polling', async () => {
  const e = await worker(); await control(e, 'enable');
  const before = e.cloud.calls.length;
  await e.send(1, 'siteclock:summary'); await e.worker.syncCloud();
  assert.equal(e.cloud.calls.length, before);
  e.advance(60_000); await e.worker.syncCloud();
  assert.ok(e.cloud.calls.length > before);
});
test('hostname counters do not inherit JavaScript prototype properties', () => {
  const l = ledger(); enable(l); l.account.local.constructor = 5;
  l.merge([{ installationId: b, hostname: 'constructor', totalMs: 10 }]);
  assert.equal(l.totals().constructor, 15);
  assert.equal(l.pending()[0].totalMs, 5);
  const restored = new Ledger(JSON.parse(JSON.stringify(l.state)), {}, () => b);
  assert.equal(Object.getPrototypeOf(restored.local()), null);
});
test('sign-out invalidates an in-flight sync before credentials or ownership change', async () => {
  const e = await worker(); await control(e, 'enable');
  e.advance(5000); await e.send();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  e.cloud.intercept = async (url) => { if (url === '/v1/account') { started(); await blocked; } };
  const sync = e.worker.syncCloud(true); await ready;
  const before = e.cloud.calls.length;
  const signout = control(e, 'signout');
  await Promise.resolve();
  e.advance(1000); await e.send(); // tracking queue remains live
  release(); await sync; await signout;
  assert.equal(e.worker.cloudStatus().signedIn, false);
  assert.equal(e.cloud.calls.length, before); // no subsequent registration/upload/download
  assert.equal(e.persistent.siteclock.cloud.accounts[a].local['example.com'], 6000);
});
