const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const file of ['sync-core.js', 'core.js', 'hostname-crypto.js']) vm.runInThisContext(fs.readFileSync(path.join(root, file), 'utf8'));
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
test('explicit history backfill combines prior local and remote counters once and preserves its source', () => {
  const l = ledger(a); l.signIn(a, 'same@example.test'); l.enable(g);
  l.account.local = { 'example.com': 100, 'legacy.test': 25 };
  l.account.daily = { '2026-10-30': { 'example.com': 60 } };
  l.account.localOnly = { 'example.com': 10 };
  l.account.localOnlyDaily = { '2026-10-30': { 'example.com': 5 } };
  l.account.remote = { [b]: { 'example.com': 300 } };
  l.account.remoteDaily = { [b]: { '2026-10-30': { 'example.com': 120 } } };
  const sourceSnapshot = JSON.stringify(l.account);
  l.signIn(b, 'same@example.test'); l.enable(g2);
  l.account.local['example.com'] = 7;
  assert.deepEqual(l.availableBackfills(), [{ sourceAccountId: a, email: 'same@example.test', siteCount: 2, totalMs: 435, dayCount: 1 }]);
  assert.deepEqual(l.backfill(a), { siteCount: 2, totalMs: 435, dayCount: 1 });
  assert.equal(l.account.local['example.com'], 417);
  assert.equal(l.account.local['legacy.test'], 25);
  assert.equal(l.account.daily['2026-10-30']['example.com'], 185);
  assert.equal(JSON.stringify(l.state.accounts[a]), sourceSnapshot);
  assert.deepEqual(l.availableBackfills(), []);
  assert.throws(() => l.backfill(a), /already imported/);
});
test('history backfill only offers prior accounts with the same email', () => {
  const l = ledger(a); l.signIn(a, 'current@example.test'); l.enable(g);
  l.signIn(b, 'other@example.test'); l.enable(g2); l.account.local['private.test'] = 100;
  l.signIn(a, 'current@example.test');
  assert.deepEqual(l.availableBackfills(), []);
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
  return { configured: true, calls: [], generation: g, privacyMode: 'unencrypted', pages: [{ contributions: [], cursor: null }],
    async signIn() { return { accountId: a, email: 'a@example.test', generation: this.generation, privacyMode: this.privacyMode, keyId: this.keyId, legacyData: this.legacyData, migrationId: this.migrationId, migrationInstallationId: this.migrationInstallationId }; },
    async signOut() {},
    async api(url, method = 'GET', body, expectedAccount) {
      this.calls.push({ url, method, body, expectedAccount });
      if (this.intercept) await this.intercept(url, method, body);
      if (url === '/v1/account') return { accountId: a, generation: this.generation, privacyMode: this.privacyMode, keyId: this.keyId, legacyData: this.legacyData, migrationId: this.migrationId, migrationInstallationId: this.migrationInstallationId };
      if (url === '/v1/privacy') { this.privacyMode = body.privacyMode; this.keyId = body.keyId; return { privacyMode: this.privacyMode, keyId: this.keyId }; }
      if (method === 'DELETE') { this.migrationId = body.migrationId; this.migrationInstallationId = body.installationId; this.privacyMode = undefined; this.legacyData = false; this.pages = [{ contributions: [], cursor: null }]; this.generation = g2; return { generation: g2 }; }
      if (url.startsWith('/v1/usage?')) return this.pages[Number(new URLSearchParams(url.split('?')[1]).get('cursor') || 0)];
      return { ok: true };
    }
  };
}
async function worker(cloud = fakeCloud(), installation = 'dddddddd-dddd-4ddd-bddd-dddddddddddd') {
  const e = environment(); e.crypto = { subtle: crypto.subtle, getRandomValues: crypto.getRandomValues.bind(crypto), randomUUID: () => installation }; e.now = Date.parse('2026-11-01T15:00:00Z'); e.cloud = cloud; await e.start();
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
test('worker backfills a prior same-email account once and syncs the imported totals', async () => {
  const e = await worker();
  await control(e, 'enable');
  const l = e.worker.ledger();
  l.signIn(a, 'a@example.test');
  l.account.local = { 'current.test': 11 };
  l.signIn(b, 'a@example.test');
  l.enable(g2);
  l.account.local = { 'old.test': 20 };
  l.account.daily = { '2026-10-30': { 'old.test': 20 } };
  l.signIn(a, 'a@example.test');
  const sourceBefore = JSON.stringify(l.state.accounts[b]);
  const result = await e.worker.controlCloud({ type: 'siteclock:cloud:backfill', sourceAccountId: b });
  assert.deepEqual(result.backfilled, { siteCount: 1, totalMs: 20, dayCount: 1 });
  assert.equal(l.account.local['old.test'], 20);
  assert.equal(JSON.stringify(l.state.accounts[b]), sourceBefore);
  const uploads = e.cloud.calls.filter(call => call.method === 'PUT' && call.url === '/v1/usage');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body.counters.length, 2);
  assert.equal(uploads[0].expectedAccount, a);
  await assert.rejects(e.worker.controlCloud({ type: 'siteclock:cloud:backfill', sourceAccountId: b }), /already imported/);
});
test('reauthentication resumes an opted-in backup, while an explicit pause remains off', async () => {
  const e = await worker();
  await control(e, 'enable');
  const l = e.worker.ledger();
  l.account.local['example.com'] = 9000;
  const expired = Error('Sign in again to resume backup.'); expired.status = 401;
  e.cloud.intercept = async url => { if (url === '/v1/account') throw expired; };
  await e.worker.syncCloud(true);
  assert.equal(l.account.enabled, true);
  assert.equal(l.account.reauthRequired, true);
  assert.equal(l.account.error, 'Sign in again to resume backup.');
  const blockedCallCount = e.cloud.calls.length;
  await e.worker.syncCloud(true);
  assert.equal(e.cloud.calls.length, blockedCallCount);

  e.cloud.intercept = null;
  const reconnected = await e.worker.controlCloud({ type: 'siteclock:cloud:signin' });
  assert.equal(reconnected.enabled, true);
  assert.equal(l.account.reauthRequired, false);
  assert.equal(l.account.error, null);
  assert.ok(e.cloud.calls.length > blockedCallCount);

  e.cloud.intercept = async url => { if (url === '/v1/account') throw expired; };
  await e.worker.syncCloud(true);
  await control(e, 'pause');
  assert.equal(l.account.enabled, false);
  assert.equal(l.account.reauthRequired, false);
  assert.equal(l.account.error, null);
  e.cloud.intercept = null;
  const afterPause = e.cloud.calls.length;
  await e.worker.controlCloud({ type: 'siteclock:cloud:signin' });
  assert.equal(l.account.enabled, false);
  assert.equal(e.cloud.calls.length, afterPause);
});
test('encrypted backup asks to save a generated recovery key before enabling, while unencrypted backup continues directly', async () => {
  const encryptedCloud = fakeCloud(); encryptedCloud.privacyMode = undefined;
  const encrypted = await worker(encryptedCloud);
  const setup = await encrypted.worker.controlCloud({ type: 'siteclock:cloud:enable', privacyMode: 'recovery', generateRecoveryCode: true });
  assert.equal(setup.awaitingRecoveryAcknowledgement, true);
  assert.ok(setup.recoveryCode);
  assert.equal(setup.enabled, false);
  assert.equal(encryptedCloud.calls.some(call => call.method === 'PUT' && call.url === '/v1/usage'), false);
  const saved = await encrypted.worker.controlCloud({ type: 'siteclock:cloud:enable', privacyMode: 'recovery',
    recoveryCode: setup.recoveryCode, savedRecoveryCode: true });
  assert.equal(saved.enabled, true);
  assert.equal(saved.privacyMode, 'recovery');

  const plaintextCloud = fakeCloud(); plaintextCloud.privacyMode = undefined;
  const plaintext = await worker(plaintextCloud);
  const enabled = await plaintext.worker.controlCloud({ type: 'siteclock:cloud:enable', privacyMode: 'unencrypted' });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.privacyMode, 'unencrypted');
  assert.equal(plaintextCloud.calls.some(call => call.url === '/v1/privacy' && call.method === 'PUT' && call.body.privacyMode === 'unencrypted'), true);
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
test('worker uploads schema 3 and downloads bounded daily history separately from lifetime summaries', async () => {
  const e = await worker(); await control(e, 'enable');
  e.advance(5000); await e.send(); await e.worker.syncCloud(true);
  const upload = e.cloud.calls.find(call => call.method === 'PUT' && call.url === '/v1/usage');
  assert.equal(upload.body.schemaVersion, 3);
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

test('first install opens onboarding, while updates and Chrome updates do not', async () => {
  const e = await worker();
  e.chrome.runtime.onInstalled.emit({ reason: 'update' }); await e.drain();
  e.chrome.runtime.onInstalled.emit({ reason: 'chrome_update' }); await e.drain();
  assert.equal(e.createdTabs, undefined);
  e.chrome.runtime.onInstalled.emit({ reason: 'install' }); await e.drain();
  assert.deepEqual(e.createdTabs, [{ url: 'chrome-extension://siteclock-test/welcome.html' }]);
});
test('consented onboarding signs in, enables backup and completes its initial sync', async () => {
  const e = await worker();
  const result = await control(e, 'signin-enable');
  assert.equal(result.enabled, true);
  assert.ok(result.lastSync);
  const sender = { id: e.chrome.runtime.id, tab: { id: 99 }, url: `chrome-extension://${e.chrome.runtime.id}/welcome.html` };
  const status = await new Promise(resolve => e.chrome.runtime.onMessage.emit({ type: 'siteclock:cloud:status' }, sender, resolve));
  assert.equal(status.enabled, true);
});
test('cancelled Google onboarding leaves backup disabled and local tracking usable', async () => {
  const e = await worker();
  e.cloud.signIn = async () => { throw Error('Sign-in cancelled.'); };
  await assert.rejects(control(e, 'signin-enable'), /cancelled/);
  assert.equal(e.worker.cloudStatus().enabled, false);
  e.advance(5000); await e.send();
  assert.equal(e.total('example.com'), 5000);
});

test('default recovery onboarding requires acknowledgement and uploads no readable hostname', async () => {
  const cloud = fakeCloud(); cloud.privacyMode = undefined;
  const e = await worker(cloud);
  const setup = await control(e, 'signin-enable');
  assert.equal(setup.enabled, false);
  assert.equal(setup.awaitingRecoveryAcknowledgement, true);
  assert.match(setup.recoveryCode, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(cloud.calls.some(c => c.url === '/v1/usage' && c.method === 'PUT'), false);
  await assert.rejects(control(e, 'enable'), /Save and confirm/);
  await e.worker.controlCloud({ type: 'siteclock:cloud:enable', savedRecoveryCode: true });
  e.advance(5000); await e.send(); await e.worker.syncCloud(true);
  const upload = cloud.calls.find(c => c.url === '/v1/usage' && c.method === 'PUT');
  assert.equal(JSON.stringify(upload.body).includes('example.com'), false);
  assert.equal(upload.body.schemaVersion, 3);
  assert.equal(upload.body.counters[0].encryptedHostname.keyId, cloud.keyId);
});

test('recovery on another profile restores site totals and rejects a wrong code before uploading', async () => {
  const cloud = fakeCloud(); cloud.privacyMode = undefined;
  const first = await worker(cloud);
  const setup = await control(first, 'signin-enable');
  await first.worker.controlCloud({ type: 'siteclock:cloud:enable', savedRecoveryCode: true });
  first.advance(5000); await first.send(); await first.worker.syncCloud(true);
  const uploaded = cloud.calls.find(c => c.url === '/v1/usage' && c.method === 'PUT').body.counters[0];
  cloud.pages = [{ contributions: [{ ...uploaded, day: undefined, installationId: 'dddddddd-dddd-4ddd-bddd-dddddddddddd' }], cursor: null }];
  const second = await worker(cloud, b);
  const before = cloud.calls.filter(c => c.url === '/v1/usage' && c.method === 'PUT').length;
  await assert.rejects(second.worker.controlCloud({ type: 'siteclock:cloud:signin-enable', recoveryCode: SiteClockHostnameCrypto.generateSecret() }), /does not match/);
  assert.equal(second.worker.cloudStatus().enabled, false);
  assert.equal(cloud.calls.filter(c => c.url === '/v1/usage' && c.method === 'PUT').length, before);
  await second.worker.controlCloud({ type: 'siteclock:cloud:signin-enable', recoveryCode: setup.recoveryCode });
  assert.equal(second.worker.cloudStatus().error, null);
  assert.equal((await second.send(1, 'siteclock:summary')).totals['example.com'], 5000);
});

test('device encryption creates a separate key on another profile and skips foreign ciphertext', async () => {
  const cloud = fakeCloud(); cloud.privacyMode = undefined;
  const first = await worker(cloud);
  await first.worker.controlCloud({ type: 'siteclock:cloud:signin-enable', privacyMode: 'device' });
  first.advance(5000); await first.send(); await first.worker.syncCloud(true);
  const uploaded = cloud.calls.find(c => c.url === '/v1/usage' && c.method === 'PUT').body.counters[0];
  cloud.pages = [{ contributions: [{ ...uploaded, installationId: 'dddddddd-dddd-4ddd-bddd-dddddddddddd' }], cursor: null }];
  const second = await worker(cloud, b);
  await second.worker.controlCloud({ type: 'siteclock:cloud:signin-enable', privacyMode: 'device' });
  assert.equal(second.worker.cloudStatus().error, null);
  assert.equal(second.total('example.com'), 0);
  second.advance(2000); await second.send(); await second.worker.syncCloud(true);
  const later = cloud.calls.filter(c => c.url === '/v1/usage' && c.method === 'PUT').at(-1).body.counters[0];
  assert.equal(later.encryptedHostname.keyId, b);
  assert.notEqual(later.domainId, uploaded.domainId);
});

async function migrationWorker() {
  const cloud = fakeCloud(); cloud.legacyData = true;
  const api = cloud.api;
  cloud.api = async function(url, method, body, expected) {
    if (url.startsWith('/v1/usage?') && this.generation === g) {
      const q = new URLSearchParams(url.split('?')[1]);
      const day = '2026-11-01';
      return { contributions: !q.has('from') ? [{ installationId: b, hostname: 'example.com', totalMs: 10000 }]
        : q.get('from') <= day && q.get('to') >= day ? [{ installationId: b, hostname: 'example.com', totalMs: 3000, day }] : [], cursor: null };
    }
    return api.call(this, url, method, body, expected);
  };
  return worker(cloud);
}
test('plaintext migration preserves daily and lifetime totals and cancels safely before deletion', async () => {
  const e = await migrationWorker();
  const setup = await e.worker.controlCloud({ type: 'siteclock:cloud:signin-enable', privacyMode: 'recovery' });
  assert.equal(setup.awaitingMigrationConfirmation, true);
  await e.worker.controlCloud({ type: 'siteclock:cloud:enable', privacyMode: 'recovery', savedRecoveryCode: true, confirmMigration: true });
  assert.equal(e.total('example.com'), 10000);
  const uploads = e.cloud.calls.filter(c => c.url === '/v1/usage' && c.method === 'PUT').flatMap(c => c.body.counters);
  assert.deepEqual(uploads.map(r => r.totalMs).sort((a,b) => a-b), [3000, 7000]);
  assert.equal(JSON.stringify(uploads).includes('example.com'), false);
  assert.equal(e.persistent.siteclockPrivacyMigration, undefined);
  const cancelled = await migrationWorker();
  await cancelled.worker.controlCloud({ type: 'siteclock:cloud:signin-enable', privacyMode: 'device' });
  await control(cancelled, 'cancel-migration');
  assert.equal(cancelled.cloud.calls.some(c => c.method === 'DELETE'), false);
  assert.equal(cancelled.worker.cloudStatus().privacyMode, 'unencrypted');
});

test('migration resumes after generation advancement and preserves activity after the local rebuild', async () => {
  const e = await migrationWorker();
  await e.worker.controlCloud({ type: 'siteclock:cloud:signin-enable', privacyMode: 'recovery' });
  let failed = false;
  e.cloud.intercept = async (url, method) => {
    if (url === '/v1/privacy' && e.cloud.generation === g2 && !failed) { failed = true; throw Error('offline after delete'); }
  };
  await assert.rejects(e.worker.controlCloud({ type: 'siteclock:cloud:enable', privacyMode: 'recovery', savedRecoveryCode: true, confirmMigration: true }), /offline/);
  assert.ok(e.persistent.siteclockPrivacyMigration);
  e.advance(2000); await e.send();
  e.cloud.intercept = null;
  await control(e, 'cancel-migration').catch(error => assert.match(error.message, /recovered locally/));
  assert.equal(e.total('example.com'), 12000);
  assert.equal(e.worker.cloudStatus().privacyMode, 'recovery');
  assert.equal(e.persistent.siteclockPrivacyMigration, undefined);
  await e.worker.syncCloud(true);
  assert.equal(e.total('example.com'), 12000);
});
