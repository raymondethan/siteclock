# Chrome Web Store privacy fields — draft for review

These answers describe the current packaged extension. They are prepared for the
publisher to review and enter in the developer dashboard; nothing is submitted.
Use the exact field labels presented by the current dashboard.

## Single purpose

Track cumulative active browsing time per website and display it in an on-page
timer and a toolbar list of website totals.

## Permission justifications

### storage

Save hostname-to-duration totals and accounting checkpoints on this computer so
totals persist across visits and browser restarts. Session storage distinguishes
worker restarts from browser restarts. No data is synchronized or transmitted.

### tabs

Identify the hostname of the selected tab and detect tab switches, navigation,
and closures so elapsed time is assigned to the correct website. Full URLs and
other browser-provided tab metadata are transient; only hostnames and accounting
metadata are persisted.

### idle

Pause timing when Chrome reports that the machine is locked or has received no
user input for 30 minutes, and resume when it becomes active. SiteClock does not
record individual keystrokes, mouse movements, or clicks.

### alarms

Periodically reconcile the active window, selected tab, and idle state if an
event was missed or the background worker restarted. This keeps the timer aligned
with the current browser state.

### Website access / content script matches

HTTP and HTTPS content scripts display the timer automatically on the websites
the user visits and send periodic checkpoints to the background worker. Broad
website access supports timing arbitrary websites, which is the extension's
single purpose. The scripts do not inspect page text or form contents. No script
runs in subframes; incognito tracking is disabled.

## Remote code

No, this extension does not use remote code. All JavaScript, styles, and icons are
included in the package. There are no runtime network requests, external script
libraries, or dynamically downloaded executable code.

## Data-type disclosures

Disclose local processing as well as transmission; do not claim that the
extension handles no user data just because it has no server.

- **Web history / web browsing activity:** Yes. The extension processes tab URLs
  to identify hostnames and retains hostname totals locally. It does not retain
  visited URL paths, query strings, or page titles.
- **User activity:** Yes. The extension measures active browsing duration and
  uses window focus and Chrome's active/idle/locked state. It does not log
  individual clicks, mouse movements, or keystrokes.
- Other listed categories: not handled by the current functionality. The
  extension does not intentionally access website content, messages, payment
  details, authentication data, health data, or precise location.

## Limited Use certifications

The current implementation supports the following statements:

- Data is not sold or transferred to third parties.
- Data is used only for the stated website-timing purpose.
- Data is not used to assess creditworthiness or for lending.
- Browsing data is not used for advertising or unrelated profiling.

## Privacy policy URL

Use https://github.com/raymondethan/siteclock/blob/master/PRIVACY.md.
The same policy is available as a standalone HTML source in
`store/privacy-policy.html` if a dedicated hosted page is wanted later.

## References checked

- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- https://developer.chrome.com/docs/webstore/images
- https://developer.chrome.com/docs/webstore/prepare
