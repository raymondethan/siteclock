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
  assert.equal(Object.values(e.persistent.siteclock.cloud.accounts[a].acknowledgedDaily)[0]['example.com'], 5000);
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
test('options and popup pages opened as tabs can request trusted extension data', async () => {
  const e = await worker();
  for (const page of ['options.html', 'popup.html?view=totals']) {
    const sender = { id: e.chrome.runtime.id, tab: { id: 99 }, url: `chrome-extension://${e.chrome.runtime.id}/${page}` };
    const status = await new Promise(resolve => e.chrome.runtime.onMessage.emit({ type: 'siteclock:cloud:status' }, sender, resolve));
    assert.equal(status.signedIn, true);
    const summary = await new Promise(resolve => e.chrome.runtime.onMessage.emit({ type: 'siteclock:summary' }, sender, resolve));
    assert.equal(summary.cloud.configured, true);
  }
});
test('website URLs and other extension origins cannot invoke trusted controls', async () => {
  const e = await worker();
  for (const url of ['https://example.com/options.html', 'https://example.com/?next=chrome-extension://siteclock-test/options.html', 'chrome-extension://another-extension/options.html']) {
    let responded = false;
    e.chrome.runtime.onMessage.emit({ type: 'siteclock:cloud:status' },
      { id: e.chrome.runtime.id, tab: { id: 99 }, url }, () => { responded = true; });
    await e.drain();
    assert.equal(responded, false);
  }
});


test('daily migration preserves lifetime, resets legacy acknowledgements, and never invents historical dates', () => {
  const l = ledger(a, { 'example.com': 100 }); enable(l);
  l.account.acknowledged['example.com'] = 100;
  const old = JSON.parse(JSON.stringify(l.state));
  delete old.accounts[a].periodVersion;
  const upgraded = new Ledger(old, {}, () => b);
  assert.equal(upgraded.totals()['example.com'], 100);
  assert.deepEqual(upgraded.periodTotals('2026-01-01', '2026-12-31'), Object.create(null));
  assert.deepEqual(upgraded.pending(), [{ hostname: 'example.com', totalMs: 100 }]);
  upgraded.acknowledge(upgraded.pending());
  const restored = new Ledger(JSON.parse(JSON.stringify(upgraded.state)), {}, () => b);
  assert.deepEqual(restored.pending(), []);
});
test('midnight splits usage exactly, and last seven days excludes the eighth calendar date', () => {
  const l = ledger(); enable(l);
  const midnight = Date.parse('2026-11-01T00:00:00Z');
  l.record('example.com', midnight - 5000, midnight + 7000, 0);
  l.record('example.com', Date.parse('2026-10-25T12:00:00Z'), Date.parse('2026-10-25T12:00:01Z'), 0);
  assert.equal(l.totals()['example.com'], 13000);
  assert.equal(l.periodTotals('2026-11-01', '2026-11-01')['example.com'], 7000);
  assert.equal(l.periodTotals('2026-10-26', '2026-11-01')['example.com'], 12000);
  const rows = l.pending();
  assert.equal(rows.length, 3); // all time is dated, no invented baseline
  l.record('example.com', midnight + 7000, midnight + 8000, 0);
  l.acknowledge(rows);
  assert.deepEqual(l.pending(), [{ hostname: 'example.com', day: '2026-11-01', totalMs: 8000 }]);
});
test('daily imports, cross-installation merging, pauses, deletion and account changes preserve ownership', () => {
  const l = ledger();
  const at = Date.parse('2026-11-01T12:00:00Z');
  l.record('example.com', at, at + 1000, 0);
  enable(l); l.pause(); l.enable(g); // unassigned import exactly once
  l.merge([{ installationId: b, hostname: 'example.com', day: '2026-11-01', totalMs: 2000 },
    { installationId: a, hostname: 'example.com', day: '2026-11-01', totalMs: 1000 }]);
  assert.equal(l.periodTotals('2026-11-01', '2026-11-01')['example.com'], 3000);
  l.pause(); assert.equal(l.periodTotals('2026-11-01', '2026-11-01')['example.com'], 1000);
  l.generation(g2);
  assert.equal(l.periodTotals('2026-11-01', '2026-11-01')['example.com'], 1000);
  l.enable(g2);
  assert.equal(l.periodTotals('2026-11-01', '2026-11-01')['example.com'], undefined);
  assert.deepEqual(l.pending(), []);
  l.signOut(); l.signIn(b, 'b@example.test'); l.enable(g);
  assert.equal(l.periodTotals('2026-11-01', '2026-11-01')['example.com'], undefined);
});
test('timezone changes preserve assigned dates and use the new timezone for subsequent intervals', () => {
  const l = ledger();
  const at = Date.parse('2026-11-01T01:00:00Z');
  l.record('example.com', at, at + 1000, 240); // October 31 in New York
  l.record('example.com', at + 1000, at + 2000, -60); // November 1 in Europe
  assert.equal(l.periodTotals('2026-10-31', '2026-10-31')['example.com'], 1000);
  assert.equal(l.periodTotals('2026-11-01', '2026-11-01')['example.com'], 1000);
  assert.equal(l.totals()['example.com'], 2000);
});
test('worker uploads schema 2 and downloads bounded daily history separately from lifetime summaries', async () => {
  const e = await worker(); await control(e, 'enable');
  e.advance(5000); await e.send(); await e.worker.syncCloud(true);
  const upload = e.cloud.calls.find(call => call.method === 'PUT' && call.url === '/v1/usage');
  assert.equal(upload.body.schemaVersion, 2);
  assert.match(upload.body.counters[0].day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(e.cloud.calls.some(call => call.url.includes('&from=') && call.url.includes('&to=')));
  const summary = await e.send(1, 'siteclock:summary');
  assert.equal(summary.periods.today['example.com'], 5000);
  assert.equal(summary.periods.week['example.com'], 5000);
});

test('daylight saving fallback counts elapsed time once and the week uses seven calendar dates', () => {
  const timezone = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const at = Date.parse('2026-11-01T05:59:55Z');
    const tracker = new SiteClockCore.Tracker(null, 'session', at, () => a);
    const active = { tabId: 1, hostname: 'example.com' };
    tracker.transition(active, at);
    tracker.transition(active, at + 10000); // 01:59:55 EDT -> 01:00:05 EST
    tracker.transition(active, at + 20000);
    assert.equal(tracker.displayTotals()['example.com'], 20000);
    assert.equal(tracker.periods().today['example.com'], 20000);
    assert.deepEqual(SiteClockSync.recentDays(Date.parse('2026-11-02T05:00:00Z')),
      { from: '2026-10-27', to: '2026-11-02' });
    assert.equal(SiteClockSync.localDay(Date.parse('2026-11-02T04:59:59Z')), '2026-11-01');
  } finally {
    if (timezone === undefined) delete process.env.TZ; else process.env.TZ = timezone;
  }
});
