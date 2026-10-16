importScripts('core.js');

const { hostname, IDLE_SECONDS, Tracker, SerialQueue } = SiteClockCore;
const queue = new SerialQueue();
const tabs = new Map();
const selected = new Map();
let focusedWindowId = chrome.windows.WINDOW_ID_NONE;
let idleState = 'active';
let tracker;
let initialized = false;

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
  tracker = new Tracker(siteclock, sessionId, at);
  // Reconcile against the live browser. A different browser session never
  // resumes an old timestamp, so overnight downtime is never counted.
  tracker.transition(currentActive(), at);
  await save();
  if (!await chrome.alarms.get('siteclock:reconcile')) {
    await chrome.alarms.create('siteclock:reconcile', { periodInMinutes: 0.5 });
  }
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
    }, at).then(() => respond({ totals: { ...tracker.totals }, active: tracker.active }), error => {
      report(error); respond({ error: 'Could not load totals.' });
    });
    return true;
  }
});

chrome.idle.setDetectionInterval(IDLE_SECONDS);
// Rehydrate on every worker start; storage.session distinguishes this from a
// full browser restart. Browser startup/onInstalled also run this top-level code.
queue.push(() => initialize(Date.now())).catch(report);
