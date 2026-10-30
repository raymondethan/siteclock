# SiteClock Privacy Policy

Last updated: October 29, 2026

SiteClock measures cumulative active browsing time per website. It works locally without an account. Optional cloud backup lets you restore saved totals and see combined usage across computers. Cloud backup is off by default for each installation.

## Information used

SiteClock uses the selected tab's URL to determine its hostname, such as `example.com`, and uses tab/window focus and Chrome's active, idle, and locked signals to decide when to count time. It does not record individual keystrokes, clicks, or mouse movements. Incognito browsing is not tracked.

Chrome may provide full URLs, titles, and other tab metadata in memory. SiteClock does not persist or upload URL paths, query strings, page titles, page contents, forms, passwords, or cookies. A leading `www.` is removed; other subdomains remain separate.

## Local storage

Chrome extension-local storage holds hostname totals, accounting checkpoints, a random installation identifier, account-separated contributions and cached cloud totals, and backup preferences. Temporary browser-session state distinguishes worker restarts from browser restarts. The installation identifier is random, is not a hardware identifier, and is replaced when extension-local data is erased.

After sign-in, the extension also stores SiteClock authentication tokens locally to maintain your session. These tokens are restricted to trusted extension contexts; they are not exposed to website content scripts. People or software with access to your Chrome profile may be able to access local data. SiteClock does not add its own local encryption layer.

## Accounts and optional cloud backup

You can choose Continue with Google to create or access your SiteClock account. Google handles your Google credentials; SiteClock never receives your Google password. Google and Amazon Cognito process the identity information needed for authentication, including your account identifier and email. SiteClock requests basic identity access, not access to Google browsing history.

Signing in alone does not enable usage backup. When you enable backup, SiteClock uploads existing unassigned hostname totals from this installation and subsequent cumulative usage. Previously assigned history stays separate between accounts. Your account stores each installation's hostname totals and registration/sync timestamps, allowing contributions to be combined without duplicate counting.

Backup uses Amazon Web Services: Cognito for authentication, API Gateway and Lambda for authenticated requests, and DynamoDB for stored usage. The default deployment region is US East (Northern Virginia). Hosting providers necessarily process connection and authentication metadata needed to operate the service. Application logs exclude hostnames, usage payloads, tokens, and full URLs; configured operational logs expire after 14 days.

While backup is enabled, the extension normally uploads changes and refreshes totals about once a minute while Chrome runs, and at startup or when you open the popup. Timing is best-effort. Offline tracking continues locally; unsent changes upload when connectivity returns. A sudden failure or deletion of local storage before upload can lose recent unbacked-up time.

## Your controls and retention

- With backup off, usage stays local. Signing in still communicates with Google and the account service for authentication.
- Pause cloud backup to stop usage uploads and downloads on this installation. Local tracking continues, and accumulated changes are included when you re-enable it. Existing cloud history is retained.
- Sign out to clear local credentials and the displayed cloud cache. This does not delete cloud history. Other installations continue according to their settings.
- Delete cloud history in SiteClock settings to delete usage across the account and pause backup. This keeps your sign-in account. Other installations detect the deletion when they next connect, pause, and cannot automatically restore the deleted contribution. Existing local contributions remain local; re-enabling starts a fresh cloud contribution.
- Deletion immediately makes the retired cloud history unavailable through the API. Physical record cleanup runs in retryable batches. Disaster-recovery copies can retain deleted information for up to seven days; recovery procedures preserve deletion decisions.
- Removing SiteClock or clearing its storage erases that installation's local data and identifier. Cloud data remains until you delete it through settings. Sign in and enable backup on another installation to restore previously uploaded totals.
- Disabling the extension stops tracking and keeps its local data. Hostname totals have no automatic expiration while retained locally or in an enabled cloud account.

Account identity remains after deleting cloud usage. To request deletion of the remaining SiteClock account identity, contact the developer using the support link below without posting private information. The settings deletion action is labeled Delete cloud history and does not claim to delete your Google or SiteClock sign-in identity.

## Use and sharing

Information is used only to provide website timing, account authentication, backup, restoration, and synchronization. SiteClock does not sell data, use it for advertising, assess creditworthiness, or include third-party analytics. Google and AWS process information as required to provide the requested authentication and hosting services. Browsing information is not used for unrelated profiling.

SiteClock follows the Chrome Web Store User Data Policy, including its Limited Use requirements. All executable extension code is included in the package; remote services provide authentication and data, not downloaded executable code.

## Policy changes and contact

Material changes to data handling will be reflected in this policy and its date. For support or account-deletion requests, use the [SiteClock project support page](https://github.com/raymondethan/siteclock/issues). Issues are public; do not include browsing history, credentials, or other private information. Ask for a private contact method when needed.
