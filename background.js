importScripts('sync-core.js', 'core.js', 'hostname-crypto.js', 'cloud-config.js', 'cloud-client.js');

const { hostname, IDLE_SECONDS, Tracker, SerialQueue } = SiteClockCore;
const queue = new SerialQueue();
const tabs = new Map();
const selected = new Map();
let focusedWindowId = chrome.windows.WINDOW_ID_NONE;
let idleState = 'active';
let tracker;
let initialized = false;
let syncing = null;
let controlling = false;
let controlTail = Promise.resolve();
let syncRevision = 0;

function remember(tab) {
  tabs.set(tab.id, { ...tab });
  if (tab.active) selected.set(tab.windowId, tab.id);
}

function currentActive() {
  if (idleState !== 'active') return null;
  const tab = tabs.get(selected.get(focusedWindowId));
  const host = tab && !tab.incognito && hostname(tab.url);
  return host ? { tabId: tab.id, hostname: host } : null;
}

async function save() {
  // Totals and their accounting boundary are one storage item: never replay a
  // successfully saved interval after the service worker is recreated.
  await chrome.storage.local.set({ siteclock: tracker.serialize() });
}

function snapshot(tabId) {
  return tracker.snapshot(hostname(tabs.get(tabId)?.url), tabId);
}

async function notify(tabIds) {
  await Promise.all([...new Set(tabIds)].filter(id => id != null).map(async tabId => {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'siteclock:state', ...snapshot(tabId) }, { frameId: 0 });
    } catch { /* Restricted pages, closed tabs, and not-yet-loaded scripts. */ }
  }));
}

async function refreshWindows() {
  const windows = await chrome.windows.getAll({ populate: true });
  tabs.clear();
  selected.clear();
  focusedWindowId = chrome.windows.WINDOW_ID_NONE;
  for (const window of windows) {
    if (window.focused) focusedWindowId = window.id;
    for (const tab of window.tabs || []) remember(tab);
  }
}

async function initialize(at) {
  // Only trusted extension pages and the worker can read the history map.
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const [{ siteclock }, session] = await Promise.all([
    chrome.storage.local.get('siteclock'), chrome.storage.session.get('browserSessionId')
  ]);
  const sessionId = session.browserSessionId || crypto.randomUUID();
  await chrome.storage.session.set({ browserSessionId: sessionId });
  await refreshWindows();
  idleState = await chrome.idle.queryState(IDLE_SECONDS);
  tracker = new Tracker(siteclock, sessionId, at, () => crypto.randomUUID());
  // Reconcile against the live browser. A different browser session never
  // resumes an old timestamp, so overnight downtime is never counted.
  tracker.transition(currentActive(), at);
  await save();
  if (!await chrome.alarms.get('siteclock:reconcile')) {
    await chrome.alarms.create('siteclock:reconcile', { periodInMinutes: 0.5 });
  }
  await chrome.alarms.create('siteclock:sync', { periodInMinutes: 1 });
  initialized = true;
  await notify([tracker.active?.tabId]);
}

function dispatch(change, at = Date.now()) {
  return queue.push(async () => {
    if (!initialized) await initialize(at);
    const previous = tracker.active?.tabId;
    await change();
    tracker.transition(currentActive(), at);
    await save();
    await notify([previous, tracker.active?.tabId]);
  });
}

function report(error) { console.error('SiteClock:', error); }
function event(change) { dispatch(change).catch(report); }

// Register listeners synchronously, before asynchronous initialization.
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => event(async () => {
  selected.set(windowId, tabId);
  if (!tabs.has(tabId)) {
    try { tabs.set(tabId, await chrome.tabs.get(tabId)); } catch { /* Already closed. */ }
  }
}));

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url === undefined && change.status !== 'complete') return;
  // Preserve event-time URL instead of querying a newer navigation later.
  const observed = { ...tab };
  event(async () => {
    tabs.set(tabId, { ...tabs.get(tabId), ...observed });
  });
});

chrome.tabs.onCreated.addListener(tab => {
  const observed = { ...tab };
  event(async () => { remember(observed); });
});
chrome.tabs.onRemoved.addListener(tabId => event(async () => {
  tabs.delete(tabId);
  for (const [windowId, id] of selected) if (id === tabId) selected.delete(windowId);
}));
chrome.tabs.onReplaced.addListener((addedId, removedId) => event(async () => {
  tabs.delete(removedId);
  for (const [windowId, id] of selected) if (id === removedId) selected.set(windowId, addedId);
  try { tabs.set(addedId, await chrome.tabs.get(addedId)); } catch { /* Already closed. */ }
}));
chrome.tabs.onAttached.addListener(() => event(refreshWindows));
chrome.tabs.onDetached.addListener(() => event(refreshWindows));
chrome.windows.onRemoved.addListener(windowId => event(async () => {
  selected.delete(windowId);
  for (const [id, tab] of tabs) if (tab.windowId === windowId) tabs.delete(id);
  if (focusedWindowId === windowId) focusedWindowId = chrome.windows.WINDOW_ID_NONE;
}));
chrome.windows.onFocusChanged.addListener(windowId => event(async () => {
  focusedWindowId = windowId;
  if (windowId !== chrome.windows.WINDOW_ID_NONE && !selected.has(windowId)) {
    try {
      const window = await chrome.windows.get(windowId, { populate: true });
      for (const tab of window.tabs || []) remember(tab);
    } catch { /* The window was closed before this event was processed. */ }
  }
}));
chrome.idle.onStateChanged.addListener(state => event(async () => { idleState = state; }));
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'siteclock:sync') { void syncCloud(); return; }
  if (alarm.name !== 'siteclock:reconcile') return;
  event(async () => {
    await refreshWindows();
    idleState = await chrome.idle.queryState(IDLE_SECONDS);
  });
});

const reconcile = async () => {
  await refreshWindows();
  idleState = await chrome.idle.queryState(IDLE_SECONDS);
};
chrome.runtime.onStartup.addListener(() => event(reconcile));
chrome.runtime.onInstalled.addListener(details => {
  event(reconcile);
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }).catch(report);
  }
});

function isExtensionPage(sender) {
  // Chrome includes sender.tab for options pages opened in a tab. A content
  // script also has sender.tab, but its sender.url is the website's URL.
  if (!sender.tab) return true;
  const page = sender.url?.split(/[?#]/)[0];
  const origin = `chrome-extension://${chrome.runtime.id}/`;
  return page === `${origin}options.html` || page === `${origin}popup.html` || page === `${origin}welcome.html`;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'siteclock:heartbeat' && sender.tab && sender.frameId === 0) {
    const tabId = sender.tab.id;
    const host = hostname(sender.url || sender.tab.url);
    // A sender cannot supply elapsed time or choose which host gets charged.
    // Ignore old documents and background tabs for accounting purposes.
    const at = Date.now();
    queue.push(async () => {
      if (!initialized) await initialize(at);
      if (selected.get(focusedWindowId) === tabId && hostname(tabs.get(tabId)?.url) === host) {
        const previous = tracker.active?.tabId;
        idleState = await chrome.idle.queryState(IDLE_SECONDS);
        // Query actual OS window focus too, including when events were missed.
        const window = await chrome.windows.get(focusedWindowId);
        if (!window.focused) focusedWindowId = chrome.windows.WINDOW_ID_NONE;
        tracker.transition(currentActive(), at);
        await save();
        await notify([previous, tracker.active?.tabId]);
      }
      return tracker.snapshot(host, tabId);
    }).then(respond, error => { report(error); respond({ error: 'Could not save time. Retrying on the next update.' }); });
    return true;
  }
  if (message?.type === 'siteclock:summary' && isExtensionPage(sender)) {
    const at = Date.now();
    dispatch(async () => {
      await refreshWindows();
      idleState = await chrome.idle.queryState(IDLE_SECONDS);
    }, at).then(() => respond({ totals: tracker.displayTotals(), periods: tracker.periods(), active: tracker.active, cloud: cloudStatus() }), error => {
      report(error); respond({ error: 'Could not load totals.' });
    });
    return true;
  }
  if (message?.type?.startsWith('siteclock:cloud:') && isExtensionPage(sender)) {
    controlCloud(message).then(respond, error => respond({ error: error.message }));
    return true;
  }
});

chrome.idle.setDetectionInterval(IDLE_SECONDS);
// Rehydrate on every worker start; storage.session distinguishes this from a
// full browser restart. Browser startup/onInstalled also run this top-level code.
queue.push(() => initialize(Date.now())).then(() => syncCloud(true)).catch(report);


function cloudStatus() {
  const account = tracker.ledger.account;
  return { configured: SiteClockCloud.configured, environment: SiteClockCloud.environment, signedIn: Boolean(account), email: account?.email,
    enabled: Boolean(account?.enabled), privacyMode: account?.privacyMode || null, lastSync: account?.lastSync, error: account?.error,
    syncing: Boolean(syncing), localOnly: Boolean(account && Object.keys(account.localOnly).length),
    backfillSources: tracker.ledger.availableBackfills() };
}

const keyStorageName = (accountId, installationId, mode) => `siteclockHostnameKey:${accountId}:${mode === 'device' ? installationId : 'account'}`;
async function saveHostnameKey(accountId, installationId, mode, secret, confirmed = mode !== 'recovery') {
  const namespace = mode === 'device' ? `${accountId}#${installationId}` : accountId;
  const keys = await SiteClockHostnameCrypto.derive(secret, namespace);
  const keyId = mode === 'device' ? installationId : keys.keyId;
  if (mode === 'recovery' && tracker.ledger.account.keyId && tracker.ledger.account.keyId !== keyId) {
    throw Error('This recovery code does not match the account. Check it and try again.');
  }
  await chrome.storage.local.set({ [keyStorageName(accountId, installationId, mode)]: { secret, keyId, mode, confirmed } });
  return { keys, keyId, confirmed, secret };
}
async function loadHostnameKey(accountId, installationId, mode) {
  const name = keyStorageName(accountId, installationId, mode);
  const value = (await chrome.storage.local.get(name))[name];
  if (!value) return null;
  const namespace = mode === 'device' ? `${accountId}#${installationId}` : accountId;
  return { keys: await SiteClockHostnameCrypto.derive(value.secret, namespace), keyId: value.keyId, confirmed: Boolean(value.confirmed), secret: value.secret };
}

async function migrateLegacyHistory(account, mode) {
  const id = tracker.ledger.state.accountId;
  const installationId = tracker.ledger.state.installationId;
  const call = (path, method, body) => SiteClockCloud.api(path, method, body, id);
  const targetKeyId = mode === 'recovery' ? tracker.ledger.account.keyId : undefined;
  const migrationId = account.pendingMigrationId || crypto.randomUUID();
  await call('/v1/privacy', 'PUT', { generation: account.generation, privacyMode: 'migrating', targetMode: mode,
    migrationId, installationId, ...(targetKeyId ? { targetKeyId } : {}) });
  const collect = async params => {
    const rows = []; let cursor;
    do {
      const query = new URLSearchParams({ generation: account.generation, ...params });
      if (cursor) query.set('cursor', cursor);
      const page = await call(`/v1/usage?${query}`);
      rows.push(...(page.contributions || [])); cursor = page.cursor;
      if (rows.length > 1_000_000) throw Error('This history is too large to migrate safely in one pass. Your cloud history is unchanged.');
    } while (cursor);
    return rows;
  };
  const summaries = await collect({});
  const dailyRows = [];
  const today = new Date(); today.setUTCHours(0, 0, 0, 0); today.setUTCDate(today.getUTCDate() + 1);
  const lastDay = today; // Include tomorrow in UTC for installations east of UTC.
  for (let start = new Date('2010-01-01T00:00:00Z'); start <= lastDay;) {
    const end = new Date(Math.min(start.getTime() + 364 * 86_400_000, lastDay.getTime()));
    const from = start.toISOString().slice(0, 10);
    const to = end.toISOString().slice(0, 10);
    dailyRows.push(...await collect({ from, to }));
    if (dailyRows.length > 1_000_000) throw Error('This history is too large to migrate safely in one pass. Your cloud history is unchanged.');
    start = new Date(end.getTime() + 86_400_000);
  }
  const ledger = tracker.ledger;
  const a = ledger.account;
  const ownLifetime = Object.assign(Object.create(null), a.local);
  for (const [host, ms] of Object.entries(ledger.state.unassigned)) ownLifetime[host] = (ownLifetime[host] || 0) + ms;
  const ownDaily = Object.create(null);
  for (const [day, hosts] of Object.entries(a.daily || {})) ownDaily[day] = { ...hosts };
  for (const [day, hosts] of Object.entries(ledger.state.unassignedDaily || {})) {
    ownDaily[day] ||= Object.create(null);
    for (const [host, ms] of Object.entries(hosts)) ownDaily[day][host] = (ownDaily[day][host] || 0) + ms;
  }
  const life = Object.create(null), daily = Object.create(null), currentSeen = new Set(), currentDaySeen = new Set();
  for (const row of summaries) {
    const value = row.installationId === installationId ? Math.max(ownLifetime[row.hostname] || 0, row.totalMs) : row.totalMs;
    if (row.installationId === installationId) currentSeen.add(row.hostname);
    life[row.hostname] = (life[row.hostname] || 0) + value;
  }
  for (const [host, ms] of Object.entries(ownLifetime)) if (!currentSeen.has(host)) life[host] = (life[host] || 0) + ms;
  for (const row of dailyRows) {
    const key = `${row.day}\n${row.hostname}`;
    const value = row.installationId === installationId ? Math.max(ownDaily[row.day]?.[row.hostname] || 0, row.totalMs) : row.totalMs;
    if (row.installationId === installationId) currentDaySeen.add(key);
    const hosts = daily[row.day] ||= Object.create(null);
    hosts[row.hostname] = (hosts[row.hostname] || 0) + value;
  }
  for (const [day, hosts] of Object.entries(ownDaily)) for (const [host, ms] of Object.entries(hosts)) {
    const key = `${day}\n${host}`;
    if (!currentDaySeen.has(key)) (daily[day] ||= Object.create(null))[host] = ((daily[day] || {})[host] || 0) + ms;
  }
  const rows = [];
  const datedByHost = Object.create(null);
  for (const hosts of Object.values(daily)) for (const [host, ms] of Object.entries(hosts)) datedByHost[host] = (datedByHost[host] || 0) + ms;
  for (const [hostname, totalMs] of Object.entries(life)) {
    const dated = datedByHost[hostname] || 0;
    const baseline = Math.max(0, totalMs - dated);
    if (baseline) rows.push({ hostname, totalMs: baseline });
  }
  for (const [day, hosts] of Object.entries(daily)) for (const [hostname, totalMs] of Object.entries(hosts)) {
    if (totalMs) rows.push({ hostname, day, totalMs });
  }
  const previousLocalOnly = JSON.parse(JSON.stringify(a.localOnly || {}));
  const previousLocalOnlyDaily = JSON.parse(JSON.stringify(a.localOnlyDaily || {}));
  const serialized = JSON.stringify({ rows, createdAt: Date.now(), mode, sourceGeneration: account.generation, migrationId, installationId,
    targetKeyId, accountLocal: a.local, accountDaily: a.daily, unassigned: ledger.state.unassigned,
    unassignedDaily: ledger.state.unassignedDaily, previousLocalOnly, previousLocalOnlyDaily });
  if (serialized.length > 7 * 1024 * 1024) throw Error('This history is too large to migrate within local browser storage. Your cloud history is unchanged.');
  await chrome.storage.local.set({ siteclockPrivacyMigration: JSON.parse(serialized) });
  const deleted = await call('/v1/usage', 'DELETE', { generation: account.generation, migrationId, installationId });
  await mutateCloud(current => {
    const latestLifetime = Object.assign(Object.create(null), a.local);
    for (const [host, ms] of Object.entries(current.state.unassigned || {})) latestLifetime[host] = (latestLifetime[host] || 0) + ms;
    const latestDaily = Object.create(null);
    for (const [day, hosts] of Object.entries(a.daily || {})) latestDaily[day] = { ...hosts };
    for (const [day, hosts] of Object.entries(current.state.unassignedDaily || {})) {
      latestDaily[day] ||= Object.create(null);
      for (const [host, ms] of Object.entries(hosts)) latestDaily[day][host] = (latestDaily[day][host] || 0) + ms;
    }
    const finalRows = rows.map(row => ({ ...row }));
    const hosts = new Set([...Object.keys(ownLifetime), ...Object.keys(latestLifetime)]);
    const days = new Set([...Object.keys(ownDaily), ...Object.keys(latestDaily)]);
    const lifetimeDelta = Object.create(null), dailyDelta = Object.create(null);
    for (const host of hosts) lifetimeDelta[host] = Math.max(0, (latestLifetime[host] || 0) - (ownLifetime[host] || 0));
    for (const day of days) for (const host of new Set([...Object.keys(ownDaily[day] || {}), ...Object.keys(latestDaily[day] || {})])) {
      const delta = Math.max(0, (latestDaily[day]?.[host] || 0) - (ownDaily[day]?.[host] || 0));
      if (delta) { (dailyDelta[day] ||= Object.create(null))[host] = delta; }
    }
    for (const host of hosts) {
      const datedDelta = Object.values(dailyDelta).reduce((sum, values) => sum + (values[host] || 0), 0);
      const baselineDelta = Math.max(0, lifetimeDelta[host] - datedDelta);
      if (baselineDelta) finalRows.push({ hostname: host, totalMs: baselineDelta });
    }
    for (const [day, values] of Object.entries(dailyDelta)) for (const [hostname, totalMs] of Object.entries(values)) finalRows.push({ hostname, day, totalMs });
    current.generation(deleted.generation);
    const state = current.account;
    state.localOnly = Object.assign(Object.create(null), previousLocalOnly);
    state.localOnlyDaily = previousLocalOnlyDaily;
    state.local = Object.create(null); state.daily = Object.create(null);
    state.remote = {}; state.remoteDaily = {}; state.acknowledged = Object.create(null); state.acknowledgedDaily = {};
    for (const row of finalRows) {
      if (row.day) {
        const hosts = state.daily[row.day] ||= Object.create(null);
        hosts[row.hostname] = (hosts[row.hostname] || 0) + row.totalMs;
      }
      state.local[row.hostname] = (state.local[row.hostname] || 0) + row.totalMs;
    }
    state.migrationAppliedId = migrationId;
    state.generation = deleted.generation; state.enabled = false; state.privacyMode = null; state.keyId = null;
    current.state.unassigned = Object.create(null); current.state.unassignedDaily = {};
  });
  const keyId = targetKeyId;
  const configured = await call('/v1/privacy', 'PUT', { generation: deleted.generation, privacyMode: mode, ...(keyId ? { keyId } : {}) });
  await mutateCloud(current => {
    current.account.privacyMode = configured.privacyMode; current.account.keyId = configured.keyId || (mode === 'device' ? installationId : null);
    current.account.enabled = true;
  });
  await chrome.storage.local.remove('siteclockPrivacyMigration');
}

async function restoreInterruptedMigration(account, snapshot) {
  if (!snapshot || snapshot.migrationId !== account.migrationId || snapshot.installationId !== account.migrationInstallationId ||
      snapshot.sourceGeneration === account.generation) return false;
  const id = tracker.ledger.state.accountId;
  let configured = account;
  if (account.privacyMode !== snapshot.mode) {
    configured = await SiteClockCloud.api('/v1/privacy', 'PUT', { generation: account.generation, privacyMode: snapshot.mode,
      ...(snapshot.mode === 'recovery' ? { keyId: snapshot.targetKeyId } : {}) }, id);
  }
  await mutateCloud(current => {
    if (current.account.generation !== account.generation) current.generation(account.generation);
    const state = current.account;
    if (state.migrationAppliedId === snapshot.migrationId) {
      state.privacyMode = snapshot.mode; state.keyId = configured.keyId || snapshot.targetKeyId || null;
      state.enabled = true; state.error = null;
      return;
    }
    const lifetimeDelta = Object.create(null), dailyDelta = Object.create(null);
    for (const host of new Set([...Object.keys(snapshot.accountLocal || {}), ...Object.keys(state.localOnly || {})])) {
      const delta = Math.max(0, (state.localOnly?.[host] || 0) - (snapshot.previousLocalOnly?.[host] || 0) - (snapshot.accountLocal?.[host] || 0));
      if (delta) lifetimeDelta[host] = delta;
    }
    for (const day of new Set([...Object.keys(snapshot.accountDaily || {}), ...Object.keys(state.localOnlyDaily || {})])) {
      for (const host of new Set([...Object.keys(snapshot.accountDaily?.[day] || {}), ...Object.keys(state.localOnlyDaily?.[day] || {})])) {
        const delta = Math.max(0, (state.localOnlyDaily?.[day]?.[host] || 0) - (snapshot.previousLocalOnlyDaily?.[day]?.[host] || 0) - (snapshot.accountDaily?.[day]?.[host] || 0));
        if (delta) (dailyDelta[day] ||= Object.create(null))[host] = delta;
      }
    }
    for (const host of new Set([...Object.keys(snapshot.unassigned || {}), ...Object.keys(current.state.unassigned || {})])) {
      const delta = Math.max(0, (current.state.unassigned?.[host] || 0) - (snapshot.unassigned?.[host] || 0));
      if (delta) lifetimeDelta[host] = (lifetimeDelta[host] || 0) + delta;
    }
    for (const day of new Set([...Object.keys(snapshot.unassignedDaily || {}), ...Object.keys(current.state.unassignedDaily || {})])) {
      for (const host of new Set([...Object.keys(snapshot.unassignedDaily?.[day] || {}), ...Object.keys(current.state.unassignedDaily?.[day] || {})])) {
        const delta = Math.max(0, (current.state.unassignedDaily?.[day]?.[host] || 0) - (snapshot.unassignedDaily?.[day]?.[host] || 0));
        if (delta) (dailyDelta[day] ||= Object.create(null))[host] = (dailyDelta[day]?.[host] || 0) + delta;
      }
    }
    const rows = (snapshot.rows || []).map(row => ({ ...row }));
    const datedDeltaByHost = Object.create(null);
    for (const hosts of Object.values(dailyDelta)) for (const [host, ms] of Object.entries(hosts)) datedDeltaByHost[host] = (datedDeltaByHost[host] || 0) + ms;
    for (const host of new Set([...Object.keys(lifetimeDelta), ...Object.values(dailyDelta).flatMap(values => Object.keys(values))])) {
      const dated = datedDeltaByHost[host] || 0;
      const baseline = Math.max(0, (lifetimeDelta[host] || 0) - dated);
      if (baseline) rows.push({ hostname: host, totalMs: baseline });
    }
    for (const [day, hosts] of Object.entries(dailyDelta)) for (const [hostname, totalMs] of Object.entries(hosts)) rows.push({ hostname, day, totalMs });
    state.localOnly = Object.assign(Object.create(null), snapshot.previousLocalOnly || {});
    state.localOnlyDaily = snapshot.previousLocalOnlyDaily || {};
    state.local = Object.create(null); state.daily = Object.create(null);
    state.remote = {}; state.remoteDaily = {}; state.acknowledged = Object.create(null); state.acknowledgedDaily = {};
    for (const row of rows) {
      if (row.day) { const hosts = state.daily[row.day] ||= Object.create(null); hosts[row.hostname] = (hosts[row.hostname] || 0) + row.totalMs; }
      state.local[row.hostname] = (state.local[row.hostname] || 0) + row.totalMs;
    }
    state.migrationAppliedId = snapshot.migrationId;
    state.generation = account.generation; state.privacyMode = snapshot.mode;
    state.keyId = configured.keyId || snapshot.targetKeyId || null; state.enabled = true; state.error = null;
    current.state.unassigned = Object.create(null); current.state.unassignedDaily = {};
  });
  await chrome.storage.local.remove('siteclockPrivacyMigration');
  return true;
}

async function mutateCloud(change) {
  const at = Date.now();
  return queue.push(async () => {
    if (!initialized) await initialize(at);
    tracker.transition(currentActive(), at);
    const result = change(tracker.ledger);
    tracker.bindLedger();
    await save();
    await notify([tracker.active?.tabId]);
    return result;
  });
}

function syncCloud(force = false) {
  if (!SiteClockCloud.configured || controlling) return Promise.resolve();
  if (syncing) return syncing;
  syncing = (async () => {
    const at = Date.now();
    const captured = await queue.push(async () => {
      const a = tracker.ledger.account;
      if (controlling || !initialized || !a?.enabled || a.reauthRequired || a.privacyMode === 'migrating') return null;
      if (!force && (at < a.retryAt || (a.lastSync && at - a.lastSync < 60_000))) return null;
      tracker.transition(currentActive(), at);
      await save();
      return { accountId: tracker.ledger.state.accountId, installationId: tracker.ledger.state.installationId,
        generation: a.generation, privacyMode: a.privacyMode, keyId: a.keyId, revision: syncRevision, rows: tracker.ledger.pending() };
    });
    if (!captured) return;
    const valid = () => !controlling && tracker.ledger.state.accountId === captured.accountId &&
      tracker.ledger.account?.enabled && syncRevision === captured.revision;
    const call = (path, method, body) => SiteClockCloud.api(path, method, body, captured.accountId);
    try {
      const account = await call('/v1/account');
      const migration = (await chrome.storage.local.get('siteclockPrivacyMigration')).siteclockPrivacyMigration;
      if (await restoreInterruptedMigration(account, migration)) return;
      if (account.generation !== captured.generation) {
        await mutateCloud(ledger => { if (valid()) { ledger.generation(account.generation); syncRevision++; } });
        return;
      }
      if (!valid()) return;
      if (!captured.privacyMode) throw Error('Choose a hostname privacy setting before enabling backup.');
      const localKey = ['recovery', 'device'].includes(captured.privacyMode)
        ? await loadHostnameKey(captured.accountId, captured.installationId, captured.privacyMode) : null;
      if (captured.privacyMode === 'recovery' && localKey && localKey.keys.keyId !== account.keyId) throw Error('The recovery code does not match this account. Enter the correct code in settings.');
      if (['recovery', 'device'].includes(captured.privacyMode) && !localKey) throw Error('The hostname encryption key is unavailable. Enter your recovery code in settings.');
      await call('/v1/installations', 'PUT', { generation: captured.generation, installationId: captured.installationId });
      for (let index = 0; index < captured.rows.length; index += 50) {
        if (!valid()) return;
        const batch = captured.rows.slice(index, index + 50);
        const wireRows = localKey ? await Promise.all(batch.map(async row => ({
          ...await SiteClockHostnameCrypto.encrypt(localKey.keys, row.hostname, { accountId: captured.accountId,
            generation: captured.generation, keyId: localKey.keyId, ...(captured.privacyMode === 'device' ? { installationId: captured.installationId, keyNamespace: `${captured.accountId}#${captured.installationId}` } : {}) }),
          totalMs: row.totalMs, ...(row.day ? { day: row.day } : {})
        }))) : batch;
        await call('/v1/usage', 'PUT', { generation: captured.generation, installationId: captured.installationId, schemaVersion: 3, counters: wireRows });
        await mutateCloud(ledger => { if (valid()) ledger.acknowledge(batch); });
      }
      // Lifetime summaries and only the visible seven-day window are downloaded.
      // Historical daily records remain in DynamoDB for future date-range views.
      const range = SiteClockSync.recentDays(Date.now());
      for (const period of [null, range]) {
        let cursor;
        do {
          if (!valid()) return;
          const query = new URLSearchParams({ generation: captured.generation, ...(period || {}) });
          if (cursor) query.set('cursor', cursor);
          const page = await call(`/v1/usage?${query}`);
          let contributions = page.contributions || [];
          if (captured.privacyMode === 'device') {
            const local = [];
            for (const row of contributions) {
              if (row.installationId !== captured.installationId) continue;
              local.push({ ...row, hostname: await SiteClockHostnameCrypto.decrypt(localKey.keys, row, {
                accountId: captured.accountId, generation: captured.generation, keyId: localKey.keyId,
                installationId: captured.installationId, keyNamespace: `${captured.accountId}#${captured.installationId}` }) });
            }
            contributions = local;
          } else if (captured.privacyMode === 'recovery') {
            contributions = await Promise.all(contributions.map(async row => ({ ...row,
              hostname: await SiteClockHostnameCrypto.decrypt(localKey.keys, row, { accountId: captured.accountId,
                generation: captured.generation, keyId: captured.keyId }) })));
          }
          await mutateCloud(ledger => { if (valid()) ledger.merge(contributions); });
          cursor = page.cursor;
        } while (cursor);
      }
      await mutateCloud(ledger => {
        if (!valid()) return;
        Object.assign(ledger.account, { lastSync: Date.now(), error: null, failures: 0, retryAt: 0 });
      });
    } catch (error) {
      if (!valid()) return;
      if (error.status === 409) {
        try {
          const account = await call('/v1/account');
          await mutateCloud(ledger => { if (valid()) { ledger.generation(account.generation); syncRevision++; } });
          return;
        } catch { /* Preserve the original error and retry. */ }
      }
      await mutateCloud(ledger => {
        if (!valid()) return;
        const a = ledger.account;
        a.failures++;
        a.retryAt = Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(a.failures - 1, 5)) * (0.75 + Math.random() * 0.5);
        a.error = error.status === 429 ? 'Cloud backup limit reached. Local tracking continues; contact support or check your account settings.' : error.status === 426 ? 'Update SiteClock to resume backup.' : error.status === 401 ? 'Sign in again to resume backup.' : 'Could not sync. Local tracking continues; backup will retry.';
        if (error.status === 401) a.reauthRequired = true;
      });
    }
  })().catch(report).finally(() => { syncing = null; });
  return syncing;
}

function controlCloud(message) {
  const action = message.type.slice('siteclock:cloud:'.length);
  if (action === 'status') return queue.push(() => cloudStatus());
  if (action === 'sync') return syncCloud(true).then(() => queue.push(() => cloudStatus()));
  const task = controlTail.then(async () => {
    // Invalidate merges immediately; wait for outstanding authenticated requests
    // before changing credentials, so one account can never upload another's counters.
    controlling = true;
    syncRevision++;
    let recoveryCode;
    let backfilled;
    let awaitingRecoveryAcknowledgement = false;
    let awaitingMigrationConfirmation = false;
    try {
      if (syncing) await syncing;
      if (action === 'signin' || action === 'signin-enable') {
        const account = await SiteClockCloud.signIn();
        await mutateCloud(ledger => {
          const previous = ledger.state.accounts[account.accountId];
          const hadOptedIn = Boolean(previous && (previous.enabled || previous.reauthRequired || previous.error === 'Sign in again to resume backup.'));
          if (ledger.state.accountId !== account.accountId) ledger.pause();
          ledger.signIn(account.accountId, account.email);
          const generationMatches = ledger.generation(account.generation);
          if (account.privacyMode) { ledger.account.privacyMode = account.privacyMode; ledger.account.keyId = account.keyId || null; }
          if (action === 'signin' && hadOptedIn && generationMatches) {
            ledger.account.enabled = true;
            ledger.account.reauthRequired = false;
            ledger.account.error = null;
            ledger.account.failures = 0;
            ledger.account.retryAt = 0;
          }
        });
        if (action === 'signin-enable') {
          const id = tracker.ledger.state.accountId;
          const installationId = tracker.ledger.state.installationId;
          const switchingFromPlaintext = account.privacyMode === 'unencrypted' && message.privacyMode && message.privacyMode !== 'unencrypted';
          const mode = account.privacyMode && account.privacyMode !== 'migrating' && !switchingFromPlaintext ? account.privacyMode : account.pendingPrivacyMode || message.privacyMode || 'recovery';
          const setupMode = !account.privacyMode || account.privacyMode === 'migrating' || switchingFromPlaintext;
          const migrating = Boolean(account.legacyData && ['recovery', 'device'].includes(mode));
          if (setupMode && mode === 'recovery') {
            let key = await loadHostnameKey(id, installationId, mode);
            if (!key) {
              recoveryCode = message.recoveryCode || SiteClockHostnameCrypto.generateSecret();
              const keyId = (await SiteClockHostnameCrypto.derive(recoveryCode, id)).keyId;
              if (account.pendingKeyId && account.pendingKeyId !== keyId) throw Error('Enter the recovery code already chosen for this migration.');
              await mutateCloud(ledger => { ledger.account.keyId = keyId; });
              await saveHostnameKey(id, installationId, mode, recoveryCode);
              awaitingRecoveryAcknowledgement = true;
            } else if (!key.confirmed) {
              recoveryCode = key.secret; awaitingRecoveryAcknowledgement = true;
            }
            if (key && !tracker.ledger.account.keyId) await mutateCloud(ledger => { ledger.account.keyId = key.keyId; });
          }
          if (setupMode && mode === 'device' && !await loadHostnameKey(id, installationId, mode)) {
            await saveHostnameKey(id, installationId, mode, SiteClockHostnameCrypto.generateSecret());
          }
          if (migrating) awaitingMigrationConfirmation = true;
          else if (setupMode) {
            const keyId = mode === 'recovery' ? tracker.ledger.account.keyId || crypto.randomUUID() : undefined;
            if (mode === 'recovery' && !tracker.ledger.account.keyId) await mutateCloud(ledger => { ledger.account.keyId = keyId; });
            const configured = await SiteClockCloud.api('/v1/privacy', 'PUT', { generation: account.generation, privacyMode: mode, ...(keyId ? { keyId } : {}) }, id);
            account.privacyMode = configured.privacyMode; account.keyId = configured.keyId;
            await mutateCloud(ledger => { ledger.account.privacyMode = account.privacyMode; ledger.account.keyId = account.keyId; });
            if (mode === 'recovery' && !recoveryCode && !(await loadHostnameKey(id, installationId, mode))?.confirmed) {
              const key = await loadHostnameKey(id, installationId, mode);
              recoveryCode = key.secret; awaitingRecoveryAcknowledgement = true;
            }
          } else if (mode === 'recovery') {
            let key = message.recoveryCode ? await saveHostnameKey(id, installationId, mode, message.recoveryCode, true) : await loadHostnameKey(id, installationId, mode);
            if (!key) {
              if (!message.recoveryCode) throw Error('Enter the recovery code for this account to unlock its website names.');
              key = await saveHostnameKey(id, installationId, mode, message.recoveryCode, true);
            } else if (!key.confirmed) {
              recoveryCode = key.secret; awaitingRecoveryAcknowledgement = true;
            }
          }
          if (mode === 'device' && !await loadHostnameKey(id, installationId, mode)) await saveHostnameKey(id, installationId, mode, SiteClockHostnameCrypto.generateSecret());
          if (!awaitingRecoveryAcknowledgement && !awaitingMigrationConfirmation) await mutateCloud(ledger => ledger.enable(account.generation));
        }
      } else if (action === 'signout') {
        await mutateCloud(ledger => ledger.signOut());
        await SiteClockCloud.signOut();
      } else if (action === 'enable') {
        const id = tracker.ledger.state.accountId;
        if (!id) throw Error('Sign in first.');
        const account = await SiteClockCloud.api('/v1/account', 'GET', undefined, id);
        const switchingFromPlaintext = account.privacyMode === 'unencrypted' && message.privacyMode && message.privacyMode !== 'unencrypted';
        const mode = account.privacyMode && account.privacyMode !== 'migrating' && !switchingFromPlaintext ? account.privacyMode : account.pendingPrivacyMode || message.privacyMode || 'recovery';
        const installationId = tracker.ledger.state.installationId;
        const settingUpPrivacy = !account.privacyMode || account.privacyMode === 'migrating' || switchingFromPlaintext;
        if (account.legacyData && settingUpPrivacy && ['recovery', 'device'].includes(mode)) {
          if (!message.confirmMigration) throw Error('Confirm the local migration before replacing the existing unencrypted cloud history.');
          if (mode === 'recovery') {
            let key = await loadHostnameKey(id, installationId, mode);
            if (!key && message.recoveryCode) key = await saveHostnameKey(id, installationId, mode, message.recoveryCode, true);
            if (!key) throw Error('Enter your recovery code to unlock the cloud website names.');
            if (!key.confirmed && !message.savedRecoveryCode) throw Error('Save and confirm the recovery code before migration.');
            if (!key.confirmed) await saveHostnameKey(id, installationId, mode, key.secret, true);
            await mutateCloud(ledger => { if (!ledger.account.keyId) ledger.account.keyId = key.keyId || account.pendingKeyId; });
          } else if (!await loadHostnameKey(id, installationId, mode)) {
            await saveHostnameKey(id, installationId, mode, SiteClockHostnameCrypto.generateSecret());
          }
          await migrateLegacyHistory(account, mode);
        } else if (settingUpPrivacy) {
          let key = mode === 'recovery' ? await loadHostnameKey(id, installationId, mode) : null;
          if (mode === 'recovery' && !key) {
            if (message.recoveryCode) key = await saveHostnameKey(id, installationId, mode, message.recoveryCode, true);
            else if (message.generateRecoveryCode) {
              recoveryCode = SiteClockHostnameCrypto.generateSecret();
              key = await saveHostnameKey(id, installationId, mode, recoveryCode, false);
              awaitingRecoveryAcknowledgement = true;
            } else throw Error('Choose whether to use an existing recovery key or generate a new one.');
          } else if (mode === 'recovery' && !key.confirmed) {
            recoveryCode = key.secret;
            awaitingRecoveryAcknowledgement = true;
          }
          if (mode === 'recovery' && !tracker.ledger.account.keyId) {
            await mutateCloud(ledger => { ledger.account.keyId = key.keyId; });
          }
          if (mode === 'device' && !await loadHostnameKey(id, installationId, mode)) {
            await saveHostnameKey(id, installationId, mode, SiteClockHostnameCrypto.generateSecret());
          }
          const keyId = mode === 'recovery' ? key.keyId : undefined;
          const configured = await SiteClockCloud.api('/v1/privacy', 'PUT',
            { generation: account.generation, privacyMode: mode, ...(keyId ? { keyId } : {}) }, id);
          account.privacyMode = configured.privacyMode; account.keyId = configured.keyId || keyId;
          await mutateCloud(ledger => { ledger.account.privacyMode = account.privacyMode; ledger.account.keyId = account.keyId || null; });
        } else {
          if (mode === 'recovery' && !await loadHostnameKey(id, installationId, mode)) {
            if (!message.recoveryCode) throw Error('Enter your recovery code to unlock the cloud website names.');
            await saveHostnameKey(id, installationId, mode, message.recoveryCode, true);
          }
          if (mode === 'device' && !await loadHostnameKey(id, installationId, mode)) await saveHostnameKey(id, installationId, mode, SiteClockHostnameCrypto.generateSecret());
          await mutateCloud(ledger => { ledger.account.privacyMode = account.privacyMode; ledger.account.keyId = account.keyId || null; });
        }
        if (mode === 'recovery' && !awaitingRecoveryAcknowledgement) {
          const key = await loadHostnameKey(id, tracker.ledger.state.installationId, 'recovery');
          if (!key?.confirmed && !message.savedRecoveryCode) throw Error('Save and confirm the recovery code before enabling backup.');
          if (!key.confirmed) await saveHostnameKey(id, tracker.ledger.state.installationId, 'recovery', key.secret, true);
        }
        if (!awaitingRecoveryAcknowledgement && !awaitingMigrationConfirmation && (!account.legacyData || account.privacyMode || mode === 'unencrypted')) {
          await mutateCloud(ledger => ledger.enable(tracker.ledger.account.generation));
        }
      } else if (action === 'pause') {
        await mutateCloud(ledger => ledger.pause());
      } else if (action === 'backfill') {
        const account = tracker.ledger.account;
        if (!account?.enabled || !account.privacyMode) throw Error('Enable cloud backup before importing previous totals.');
        backfilled = await mutateCloud(ledger => ledger.backfill(message.sourceAccountId));
      } else if (action === 'cancel-migration') {
        const id = tracker.ledger.state.accountId;
        if (!id) throw Error('Sign in first.');
        const account = await SiteClockCloud.api('/v1/account', 'GET', undefined, id);
        const snapshot = (await chrome.storage.local.get('siteclockPrivacyMigration')).siteclockPrivacyMigration;
        if (snapshot && snapshot.migrationId === account.migrationId && snapshot.sourceGeneration !== account.generation) {
          await restoreInterruptedMigration(account, snapshot);
          throw Error('The cloud generation already changed. The encrypted migration was recovered locally; keep using the selected encrypted mode.');
        }
        const configured = account.privacyMode === 'unencrypted' ? account : await SiteClockCloud.api('/v1/privacy', 'PUT',
          { generation: account.generation, privacyMode: 'unencrypted', installationId: tracker.ledger.state.installationId }, id);
        await mutateCloud(ledger => { ledger.generation(account.generation); ledger.account.privacyMode = 'unencrypted';
          ledger.account.keyId = null; ledger.account.enabled = true; });
        await chrome.storage.local.remove('siteclockPrivacyMigration');
      } else if (action === 'delete') {
        const id = tracker.ledger.state.accountId;
        if (!id) throw Error('Sign in first.');
        // Persist the expected generation before sending, making crash/retry safe.
        const expected = await mutateCloud(ledger => {
          ledger.pause();
          return ledger.account.generation;
        });
        const result = await SiteClockCloud.api('/v1/usage', 'DELETE', { generation: expected }, id);
        await mutateCloud(ledger => ledger.generation(result.generation));
      } else if (action !== 'retry') throw Error('Unknown cloud action.');
    } finally { controlling = false; }
    if (['signin', 'enable', 'retry', 'signin-enable', 'backfill', 'cancel-migration'].includes(action) && !awaitingRecoveryAcknowledgement && !awaitingMigrationConfirmation) await syncCloud(true);
    return { ...await queue.push(() => cloudStatus()), ...(recoveryCode ? { recoveryCode } : {}),
      ...(backfilled ? { backfilled } : {}),
      ...(awaitingRecoveryAcknowledgement ? { awaitingRecoveryAcknowledgement } : {}), ...(awaitingMigrationConfirmation ? { awaitingMigrationConfirmation } : {}) };
  });
  controlTail = task.catch(() => {});
  return task;
}
