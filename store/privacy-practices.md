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
worker restarts from browser restarts. When explicitly enabled, sync cumulative hostname contributions and cache account-wide totals; store authentication tokens in trusted extension storage.

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
included in the package. Configured AWS endpoints provide authentication and optional data backup. Google handles sign-in. No executable code is fetched remotely.

## Data-type disclosures

Disclose local processing as well as transmission; do not claim that the
extension handles no user data just because it has no server.

- **Web history / web browsing activity:** Yes. The extension processes tab URLs
  to identify hostnames and retains hostname totals and daily counters labeled by local calendar date locally. When backup is enabled, it uploads hostnames either as readable text or as client-encrypted ciphertext with keyed opaque identifiers, depending on the selected account mode. Dates and durations remain readable by the service. It does not retain visited URL paths, query strings, or page titles.
- **User activity:** Yes. The extension measures active browsing duration and
  uses window focus and Chrome's active/idle/locked state. It does not log
  individual clicks, mouse movements, or keystrokes.
- **Personally identifiable information:** Yes, basic Google account identity and email for optional account sign-in.
- **Authentication information:** Yes, SiteClock access and refresh tokens. The extension never receives the Google password.
- Website content, messages, payment details, health data, and precise location are not intentionally accessed.

## Limited Use certifications

The current implementation supports the following statements:

- Data is not sold. Google and AWS process data only for the requested sign-in and backup services.
- Recovery-code mode encrypts hostnames before upload; the code is never sent to the service. Device-only mode encrypts hostnames with a key kept in that Chrome profile. Plaintext mode is an explicit user choice.
- Data is used only for the stated website-timing purpose.
- Data is not used to assess creditworthiness or for lending.
- Browsing data is not used for advertising or unrelated profiling.

## Privacy policy URL

Use https://siteclock.dev/privacy.html. The same policy is maintained in
`PRIVACY.md` and `store/privacy-policy.html`.

## References checked

- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- https://developer.chrome.com/docs/webstore/images
- https://developer.chrome.com/docs/webstore/prepare

### identity

Open a user-initiated Google sign-in flow through Cognito and return securely to the extension. The extension uses authorization code + PKCE and does not request Google browsing-history access.

### Configured host permissions

Access only the configured AWS API and Cognito origins from the background worker for sign-in, token refresh/revocation, and optional hostname-duration backup. The release configuration tool writes exact origins; no wildcard cloud hosts are needed.

## Release controls

Backup defaults to off on each installation. Enabling includes existing unassigned totals with an explicit confirmation. Pausing stops usage uploads/downloads and preserves the cloud copy; deletion removes cloud history and prevents stale installations from re-uploading it automatically. Account identity remains after usage deletion. See the policy for retention and account identity deletion requests.
