globalThis.testFailures = 0;
globalThis.testDone = false;

function assert(condition, message = 'Assertion failed') {
  if (!condition) throw new Error(message);
}
function equal(actual, expected) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function signal() {
  const listeners = [];
  return { addListener: callback => listeners.push(callback), emit: (...args) => listeners.forEach(callback => callback(...args)) };
}

function environment(persistent = {}, session = {}) {
  const env = {
    now: 1_000_000, persistent, session, idle: 'active', focused: 1,
    tabList: [
      { id: 1, windowId: 1, active: true, url: 'https://www.example.com/first', incognito: false },
      { id: 2, windowId: 1, active: false, url: 'https://other.test/', incognito: false }
    ],
    writes: 0, failNextSave: false, notifications: [], errors: [], alarms: {}, maxWrites: 0, writesInFlight: 0
  };
  const window = id => {
    if (id !== 1 && id !== 2) throw Error('No such window');
    return { id, focused: env.focused === id, tabs: clone(env.tabList.filter(tab => tab.windowId === id)) };
  };
  env.chrome = {
    runtime: {
      id: 'siteclock-test', onMessage: signal(), onStartup: signal(), onInstalled: signal()
    },
    storage: {
      local: {
        async get(key) { return env.persistent[key] ? { [key]: clone(env.persistent[key]) } : {}; },
        async set(values) {
          env.writesInFlight++;
          env.maxWrites = Math.max(env.maxWrites, env.writesInFlight);
          await Promise.resolve();
          env.writesInFlight--;
          if (env.failNextSave) { env.failNextSave = false; throw Error('Simulated disk failure'); }
          Object.assign(env.persistent, clone(values));
          env.writes++;
        },
        async setAccessLevel(value) { env.accessLevel = value.accessLevel; }
      },
      session: {
        async get(key) { return env.session[key] ? { [key]: env.session[key] } : {}; },
        async set(values) { Object.assign(env.session, values); }
      }
    },
    tabs: {
      onActivated: signal(), onUpdated: signal(), onCreated: signal(), onRemoved: signal(), onReplaced: signal(), onAttached: signal(), onDetached: signal(),
      async get(id) {
        const tab = env.tabList.find(tab => tab.id === id);
        if (!tab) throw Error('No such tab');
        return clone(tab);
      },
      async sendMessage(id, message) { env.notifications.push({ id, message }); }
    },
    windows: {
      WINDOW_ID_NONE: -1, onFocusChanged: signal(), onRemoved: signal(),
      async getAll() { return [window(1), window(2)]; },
      async get(id) { return window(id); }
    },
    idle: {
      onStateChanged: signal(), async queryState(seconds) { equal(seconds, 1800); return env.idle; },
      setDetectionInterval(seconds) { env.idleInterval = seconds; }
    },
    alarms: {
      onAlarm: signal(), async get(name) { return env.alarms[name]; },
      async create(name, options) { env.alarms[name] = options; }
    }
  };
  env.start = async () => {
    const factory = new Function('chrome', 'importScripts', 'SiteClockCore', 'crypto', 'Date', 'console',
      backgroundSource + '\nreturn { drain: () => queue.tail };');
    env.worker = factory(env.chrome, () => {}, SiteClockCore,
      { randomUUID: () => `session-${env.now}` }, { now: () => env.now },
      { error: (...args) => env.errors.push(args.join(' ')) });
    await env.worker.drain();
  };
  env.send = (id = 1, type = 'siteclock:heartbeat') => new Promise(resolve => {
    const tab = env.tabList.find(tab => tab.id === id);
    const sender = type === 'siteclock:summary' ? { id: env.chrome.runtime.id }
      : { id: env.chrome.runtime.id, tab: clone(tab), url: tab.url, frameId: 0 };
    env.chrome.runtime.onMessage.emit({ type }, sender, resolve);
  });
  env.advance = ms => { env.now += ms; };
  env.switchTab = id => {
    const target = env.tabList.find(tab => tab.id === id);
    for (const tab of env.tabList) if (tab.windowId === target.windowId) tab.active = tab.id === id;
    env.chrome.tabs.onActivated.emit({ tabId: id, windowId: target.windowId });
  };
  env.focus = id => { env.focused = id; env.chrome.windows.onFocusChanged.emit(id); };
  env.setIdle = state => { env.idle = state; env.chrome.idle.onStateChanged.emit(state); };
  env.navigate = (id, url) => {
    const tab = env.tabList.find(tab => tab.id === id);
    tab.url = url;
    env.chrome.tabs.onUpdated.emit(id, { url }, clone(tab));
  };
  env.total = host => env.persistent.siteclock.totals[host] || 0;
  env.drain = () => env.worker.drain();
  return env;
}

const cases = [
  ['hostname normalization and unsupported URLs', async () => {
    equal(SiteClockCore.hostname('https://WWW.Example.COM:8443/a?q=1'), 'example.com');
    equal(SiteClockCore.hostname('http://docs.example.com/a'), 'docs.example.com');
    equal(SiteClockCore.hostname('chrome://extensions'), null);
    equal(SiteClockCore.hostname('file:///tmp/a'), null);
    equal(SiteClockCore.hostname('garbage'), null);
    equal(SiteClockCore.formatTime(3_661_999), '1h 1m 01s');
  }],
  ['checkpoint then exit counts only the unsaved remainder', async () => {
    const e = environment(); await e.start();
    equal(e.idleInterval, 1800); equal(e.accessLevel, 'TRUSTED_CONTEXTS');
    e.advance(10_000); await e.send(); equal(e.total('example.com'), 10_000);
    e.advance(3_250); e.switchTab(2); await e.drain();
    equal(e.total('example.com'), 13_250);
    e.advance(200); e.switchTab(1); await e.drain();
    equal(e.total('other.test'), 200);
  }],
  ['rapid switches keep subsecond visits and event-time timestamps', async () => {
    const e = environment(); await e.start();
    e.advance(200); e.switchTab(2);
    e.advance(150); e.switchTab(1);
    e.advance(100); e.switchTab(2);
    await e.drain();
    equal(e.total('example.com'), 300); equal(e.total('other.test'), 150);
    equal(e.maxWrites, 1);
  }],
  ['two tabs on one hostname never double-count', async () => {
    const e = environment();
    e.tabList[1].url = 'https://example.com/second'; await e.start();
    e.advance(10_000); await e.send();
    e.switchTab(2); await e.drain();
    e.advance(10_000); await e.send(2);
    equal(e.total('example.com'), 20_000);
  }],
  ['background heartbeats and iframes cannot add time', async () => {
    const e = environment(); await e.start();
    e.advance(10_000); const before = e.writes;
    await e.send(2); equal(e.writes, before); equal(e.total('other.test'), 0);
    let responded = false;
    e.chrome.runtime.onMessage.emit({ type: 'siteclock:heartbeat' },
      { id: e.chrome.runtime.id, tab: e.tabList[0], frameId: 1 }, () => { responded = true; });
    await e.drain(); equal(responded, false);
    await e.send(); equal(e.total('example.com'), 10_000);
  }],
  ['focus loss pauses, focus return resumes', async () => {
    const e = environment(); await e.start();
    e.advance(2500); e.focus(-1); await e.drain();
    e.advance(10_000); const paused = await e.send(); equal(paused.running, false);
    equal(e.total('example.com'), 2500);
    e.focus(1); await e.drain(); e.advance(1000); await e.send();
    equal(e.total('example.com'), 3500);
  }],
  ['idle and lock events pause until active input returns', async () => {
    const e = environment(); await e.start();
    e.advance(1000); e.setIdle('idle'); await e.drain();
    e.advance(20_000); await e.send(); equal(e.total('example.com'), 1000);
    e.setIdle('active'); await e.drain();
    e.advance(2000); e.setIdle('locked'); await e.drain();
    e.advance(20_000); await e.send(); equal(e.total('example.com'), 3000);
  }],
  ['the first 30 inactive minutes count, then idle pauses tracking', async () => {
    const e = environment(); await e.start();
    for (let i = 0; i < 180; i++) { e.advance(10_000); await e.send(); }
    e.setIdle('idle'); await e.drain(); equal(e.total('example.com'), 1_800_000);
    e.advance(10_000); await e.send(); equal(e.total('example.com'), 1_800_000);
  }],
  ['same-host navigation keeps total; cross-host navigation switches', async () => {
    const e = environment(); await e.start();
    e.advance(1000); e.navigate(1, 'https://example.com/second'); await e.drain();
    e.advance(2000); e.navigate(1, 'https://docs.example.com/'); await e.drain();
    e.advance(500); await e.send();
    equal(e.total('example.com'), 3000); equal(e.total('docs.example.com'), 500);
  }],
  ['sleep gaps and backward clock changes are not added', async () => {
    const e = environment(); await e.start();
    e.advance(10_000); await e.send();
    e.advance(8 * 60 * 60 * 1000); await e.send(); equal(e.total('example.com'), 10_000);
    e.advance(-60_000); await e.send(); equal(e.total('example.com'), 10_000);
    e.advance(1000); await e.send(); equal(e.total('example.com'), 11_000);
  }],
  ['worker restart restores the last boundary without replay', async () => {
    const e = environment(); await e.start();
    e.advance(10_000); await e.send();
    const restarted = environment(e.persistent, e.session);
    restarted.now = e.now + 2000; await restarted.start();
    equal(restarted.total('example.com'), 12_000);
    restarted.advance(1000); await restarted.send(); equal(restarted.total('example.com'), 13_000);
  }],
  ['browser restart preserves totals and excludes offline time', async () => {
    const e = environment(); await e.start();
    e.advance(10_000); await e.send();
    const restarted = environment(e.persistent, {});
    restarted.now = e.now + 8 * 60 * 60 * 1000; await restarted.start();
    equal(restarted.total('example.com'), 10_000);
    restarted.advance(1000); await restarted.send(); equal(restarted.total('example.com'), 11_000);
  }],
  ['failed saves retry without poisoning queue or losing accrued time', async () => {
    const e = environment(); await e.start();
    e.advance(10_000); e.failNextSave = true;
    assert((await e.send()).error); equal(e.total('example.com'), 0);
    e.advance(1000); await e.send(); equal(e.total('example.com'), 11_000);
    equal(e.errors.length, 1);
  }],
  ['concurrent heartbeats serialize and do not count an interval twice', async () => {
    const e = environment(); await e.start(); e.advance(10_000);
    await Promise.all([e.send(), e.send(), e.send()]);
    equal(e.total('example.com'), 10_000); equal(e.maxWrites, 1);
  }],
  ['closing the tracked tab saves its remainder and stops tracking', async () => {
    const e = environment(); await e.start(); e.advance(500);
    e.tabList = e.tabList.filter(tab => tab.id !== 1);
    e.chrome.tabs.onRemoved.emit(1); await e.drain();
    equal(e.total('example.com'), 500); equal(e.persistent.siteclock.active, null);
  }],
  ['Chrome prerender replacement transfers tracking to the replacement tab', async () => {
    const e = environment(); await e.start(); e.advance(700);
    e.tabList[0] = { ...e.tabList[0], id: 3, url: 'https://replacement.test/' };
    e.chrome.tabs.onReplaced.emit(3, 1); await e.drain();
    equal(e.total('example.com'), 700);
    e.advance(500); await e.send(3); equal(e.total('replacement.test'), 500);
  }],
  ['only selected tab of the focused window receives time', async () => {
    const e = environment(); e.tabList[1].windowId = 2; e.tabList[1].active = true;
    await e.start(); e.advance(1000); e.focus(2); await e.drain();
    e.advance(2000); await e.send(2);
    equal(e.total('example.com'), 1000); equal(e.total('other.test'), 2000);
  }],
  ['startup and alarm reconciliation recover missed focus changes', async () => {
    const e = environment(); await e.start();
    equal(e.alarms['siteclock:reconcile'].periodInMinutes, 0.5);
    e.advance(10_000); e.focused = -1;
    e.chrome.alarms.onAlarm.emit({ name: 'siteclock:reconcile' }); await e.drain();
    equal(e.persistent.siteclock.active, null);
    e.focused = 1; e.chrome.runtime.onStartup.emit(); await e.drain();
    equal(e.persistent.siteclock.active.hostname, 'example.com');
  }],
  ['unsupported URLs and incognito tabs are excluded', async () => {
    const e = environment(); e.tabList[1].incognito = true; await e.start();
    e.navigate(1, 'chrome://extensions'); await e.drain();
    e.advance(10_000); e.switchTab(2); await e.drain();
    e.advance(10_000); await e.send(2);
    equal(e.total('other.test'), 0); equal(e.persistent.siteclock.active, null);
  }]
];

globalThis.testCompletion = (async () => {
  for (const [name, run] of cases) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { globalThis.testFailures++; console.error(`FAIL ${name}: ${error.stack || error}`); }
  }
  console.log(`${cases.length - testFailures}/${cases.length} tests passed`);
  globalThis.testDone = true;
})();
