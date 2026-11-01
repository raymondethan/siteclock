# SiteClock

A dependency-free Chrome extension that shows today, last 7 days, and lifetime
active browsing time in a small corner timer and toolbar popup.

## Chrome Web Store submission

Open `store/review.html` locally to review the icon, promotional artwork, live
screenshots, listing copy, and privacy disclosures. See `store/REVIEW.md` for
rebuild commands and package details. The store submission is not complete yet.
The public privacy policy is [PRIVACY.md](https://github.com/raymondethan/siteclock/blob/master/PRIVACY.md).
See `store/SUBMISSION.md` for the current submission checklist.

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

`chrome.storage.local` contains a version-3 `siteclock` checkpoint: the current
installation's contribution, active accounting boundary, random installation ID,
account-separated local counters, acknowledgements, and downloaded contributions.
Version-1 totals migrate locally without enabling backup or making network requests.
A separate `siteclockAuth` record holds trusted-context authentication tokens after
sign-in. Active tab/session information stays local.

Onboarding offers three cloud hostname modes. Recovery-code encryption is the
recommended default and enables site-name matching across computers; the code
must be saved because SiteClock cannot recover it. Device-only encryption keeps
its key in one Chrome profile, so site names and matching site totals from other
computers cannot be combined. Unencrypted backup keeps cross-computer site totals
and lets the service read hostnames. Dates and durations remain readable in every
mode. Existing plaintext history is migrated only after a local snapshot and an
explicit confirmation.

Local mode requires no account. Open **Accounts & settings** from the popup to sign
in with Google and explicitly enable cloud backup for this installation. Enabling
includes existing unassigned local totals. Both the popup and on-page timer then
show the combined account total, including local time awaiting upload. Updates
sync approximately every minute, at startup, and on popup opening. Offline changes
retry automatically. Pause backup to stop usage communication and resume later;
**Delete cloud history** separately removes account-wide usage and pauses old
installations. Switching accounts keeps assigned history separate.

A build with empty `cloud-config.js` remains local and shows that cloud backup is
not configured. See [backend/README.md](backend/README.md) for deployment,
configuration, schema, cost assumptions, and the two-installation release checks.

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

Install backend test dependencies with `pnpm --dir backend install --frozen-lockfile`,
then use Node 22+:

```sh
node tests/run.js
node --test tests/sync.test.cjs tests/cloud-client.test.cjs backend/tests/*.test.mjs
```

The original accounting suite also runs without packages on macOS:

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
or upload page contents. Optional backup uses configured AWS endpoints; Google
sign-in uses Chrome’s `identity` API.

## Calendar views (0.3.0)

Today follows the local calendar date on the computer where usage is tracked.
Last 7 days includes today and the six preceding dates. Travel and daylight saving
changes do not rewrite previously assigned dates. Total includes all saved usage,
including undated history from earlier versions; daily history starts at upgrade.
Each daily counter and its cloud lifetime summary update in one transaction.
The popup displays all three counters. The on-page timer shows Total by default;
hover over it or focus it with the keyboard to reveal Today and Last 7 days. Reload the extension and
refresh existing website tabs after upgrading the unpacked version.
