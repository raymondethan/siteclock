# SiteClock

A dependency-free Chrome extension that shows cumulative active browsing time in
a small corner timer.

## Install locally

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select the directory containing `manifest.json`.
4. Refresh already-open website tabs to attach their timers. New pages get a timer
   automatically. Pin SiteClock in the extensions menu to see all website totals.

After editing the source, click **Reload** on the extension and refresh open pages.
Keep this directory in place: Chrome loads the extension directly from it.

## Tracking rules

- Count only the selected HTTP/HTTPS tab in the focused Chrome window.
- Normalize hostnames to lowercase and remove one leading `www.`. Other
  subdomains remain separate. All paths and ports of a hostname share a total.
- Pause when Chrome loses focus, the computer locks, or the machine receives no
  keyboard/mouse input for **30 minutes**. The first 30 idle minutes still count.
- Count short visits too, including fractions of a second.
- Save on tab changes, navigation, closure, focus changes, and idle changes, plus
  approximately every **10 seconds** through a visible page's heartbeat.
- The toolbar popup lists all saved website totals, largest first.
- Incognito tracking is disabled. Chrome's built-in pages, the Chrome Web Store,
  and other pages that prohibit content scripts cannot display the timer.

## Storage and reliability

`chrome.storage.local` contains one `siteclock` record:

```json
{
  "version": 1,
  "totals": { "example.com": 12345 },
  "sessionId": "browser-session-identifier",
  "active": { "tabId": 42, "hostname": "example.com" },
  "lastAt": 1700000000000
}
```

Totals are a hostname-to-milliseconds map. The remaining fields identify the
accounted interval. A separate `chrome.storage.session` identifier distinguishes
worker restarts from full browser restarts. Totals survive browser/computer
restarts and extension updates/reloads at this path. Uninstalling the extension
removes its Chrome-managed data. Nothing is synced or sent over the network.

Chrome events and page heartbeats enter a promise-based serial queue owned by the
background worker. Every save stores totals together with their timestamp.
Content scripts cannot read the history map or write totals; they receive only
their own hostname's timer state. A failed save is logged, and the queue continues
so the next update can retry saving the current state.

The worker uses event arrival timestamps, not timer tick counts. Accounting gaps
over **25 seconds** are discarded as uncertain (sleep, clock changes, delayed
timers, missing scripts). A 30-second alarm reconciles focus and tab state if an
event was missed; it is not a substitute for the 10-second page heartbeat.
No browser extension can guarantee a final write during abrupt termination.
Usually at most the time since the last checkpoint is lost; delays can increase
that window. A sleep shorter than the gap limit may be counted. Restricted pages
without heartbeats and heavily throttled pages may be undercounted. The overlay
pauses its local prediction if updates stop arriving.

## Test

Run `node tests/run.js` with Node 18+ (no packages needed), or on macOS run:

```sh
swift tests/run.swift .
```

The suite exercises the real accounting code and background worker with mocked
Chrome APIs, including rapid tab switching, simultaneous messages, storage
failures, worker/browser restarts, idle/lock/focus pauses, and sleep gaps.

Manual Chrome checks: switch between two sites, open two tabs of the same host,
reload a page, move focus to another app, reload the extension, restart Chrome,
and confirm totals continue without counting background or overnight time.

## Permissions

`tabs` identifies websites and tab transitions; `storage` persists totals; `idle`
detects inactivity/locking; `alarms` recovers missed browser state changes. The
HTTP/HTTPS content script permission lets the timer appear automatically on
websites. The extension does not inspect page text, collect full URLs in storage,
or make network requests.
