importScripts('sync-core.js', 'core.js', 'cloud-config.js', 'cloud-client.js');

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
chrome.runtime.onInstalled.addListener(() => event(reconcile));

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
  if (message?.type === 'siteclock:summary' && !sender.tab) {
    const at = Date.now();
    dispatch(async () => {
      await refreshWindows();
      idleState = await chrome.idle.queryState(IDLE_SECONDS);
    }, at).then(() => respond({ totals: tracker.displayTotals(), active: tracker.active, cloud: cloudStatus() }), error => {
      report(error); respond({ error: 'Could not load totals.' });
    });
    return true;
  }
  if (message?.type?.startsWith('siteclock:cloud:') && !sender.tab) {
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
  return { configured: SiteClockCloud.configured, signedIn: Boolean(account), email: account?.email,
    enabled: Boolean(account?.enabled), lastSync: account?.lastSync, error: account?.error,
    syncing: Boolean(syncing), localOnly: Boolean(account && Object.keys(account.localOnly).length) };
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
      if (controlling || !initialized || !tracker.ledger.account?.enabled) return null;
      const a = tracker.ledger.account;
      if (!force && (at < a.retryAt || (a.lastSync && at - a.lastSync < 60_000))) return null;
      tracker.transition(currentActive(), at);
      await save();
      return { accountId: tracker.ledger.state.accountId, installationId: tracker.ledger.state.installationId,
        generation: a.generation, revision: syncRevision, rows: tracker.ledger.pending() };
    });
    if (!captured) return;
    const valid = () => !controlling && tracker.ledger.state.accountId === captured.accountId &&
      tracker.ledger.account?.enabled && syncRevision === captured.revision;
    const call = (path, method, body) => SiteClockCloud.api(path, method, body, captured.accountId);
    try {
      const account = await call('/v1/account');
      if (account.generation !== captured.generation) {
        await mutateCloud(ledger => { if (valid()) { ledger.generation(account.generation); syncRevision++; } });
        return;
      }
      if (!valid()) return;
      await call('/v1/installations', 'PUT', { generation: captured.generation, installationId: captured.installationId });
      for (let index = 0; index < captured.rows.length; index += 50) {
        if (!valid()) return;
        const batch = captured.rows.slice(index, index + 50);
        await call('/v1/usage', 'PUT', { generation: captured.generation, installationId: captured.installationId, counters: batch });
        await mutateCloud(ledger => { if (valid()) ledger.acknowledge(batch); });
      }
      let cursor;
      do {
        if (!valid()) return;
        const query = new URLSearchParams({ generation: captured.generation });
        if (cursor) query.set('cursor', cursor);
        const page = await call(`/v1/usage?${query}`);
        await mutateCloud(ledger => { if (valid()) ledger.merge(page.contributions); });
        cursor = page.cursor;
      } while (cursor);
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
        a.error = error.status === 401 ? 'Sign in again to resume backup.' : 'Could not sync. Local tracking continues; backup will retry.';
        if (error.status === 401) a.enabled = false;
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
    try {
      if (syncing) await syncing;
      if (action === 'signin') {
        const account = await SiteClockCloud.signIn();
        await mutateCloud(ledger => {
          if (ledger.state.accountId !== account.accountId) ledger.pause();
          ledger.signIn(account.accountId, account.email);
          ledger.generation(account.generation);
        });
      } else if (action === 'signout') {
        await mutateCloud(ledger => ledger.signOut());
        await SiteClockCloud.signOut();
      } else if (action === 'enable') {
        const id = tracker.ledger.state.accountId;
        if (!id) throw Error('Sign in first.');
        const account = await SiteClockCloud.api('/v1/account', 'GET', undefined, id);
        await mutateCloud(ledger => ledger.enable(account.generation));
      } else if (action === 'pause') {
        await mutateCloud(ledger => ledger.pause());
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
    if (action === 'enable' || action === 'retry') await syncCloud(true);
    return queue.push(() => cloudStatus());
  });
  controlTail = task.catch(() => {});
  return task;
}
