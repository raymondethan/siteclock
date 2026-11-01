# SiteClock Privacy Policy

Last updated: November 1, 2026

SiteClock measures cumulative active browsing time per website. It works locally without an account. Optional cloud backup lets you restore saved totals and see combined usage across computers. Cloud backup is off by default for each installation.

## Information used

SiteClock uses the selected tab's URL to determine its hostname, such as `example.com`, and uses tab/window focus and Chrome's active, idle, and locked signals to decide when to count time. It does not record individual keystrokes, clicks, or mouse movements. Incognito browsing is not tracked.

Chrome may provide full URLs, titles, and other tab metadata in memory. SiteClock does not persist or upload URL paths, query strings, page titles, page contents, forms, passwords, or cookies. A leading `www.` is removed; other subdomains remain separate.

## Local storage

Chrome extension-local storage holds hostname totals and daily usage counters labeled by local calendar date, accounting checkpoints, a random installation identifier, account-separated contributions and cached cloud totals, backup preferences, and (for encrypted backup) the local encryption key. Temporary browser-session state distinguishes worker restarts from browser restarts. The installation identifier is random, is not a hardware identifier, and is replaced when extension-local data is erased.

After sign-in, the extension also stores SiteClock authentication tokens locally to maintain your session. These tokens and encryption keys are restricted to trusted extension contexts; they are not exposed to website content scripts. People or software with access to your Chrome profile may be able to access local data and keys. SiteClock does not encrypt local tracking data.

## Accounts and optional cloud backup

You can choose Continue with Google to create or access your SiteClock account. Google handles your Google credentials; SiteClock never receives your Google password. Google and Amazon Cognito process the identity information needed for authentication, including your account identifier and email. SiteClock requests basic identity access, not access to Google browsing history.

Signing in alone does not enable usage backup. During onboarding, choose one of three backup modes. **Encrypted with a recovery code** is the recommended default: the extension encrypts hostnames with AES-GCM and replaces them in database keys with account-scoped keyed identifiers. The recovery code is generated locally and is never sent to SiteClock; you need it to unlock names on another computer. If you lose the code and every installation that has the key, encrypted names cannot be recovered. **Encrypted on this computer only** keeps a random key in that Chrome profile; other computers cannot decrypt its names or combine matching site totals. **Unencrypted** stores readable hostnames and preserves cross-computer site totals. You can also use SiteClock locally without an account or cloud backup.

Dates and durations remain readable by SiteClock's backend and in the database in all three modes so the service can compute daily and lifetime totals. Encrypted modes hide hostname strings from ordinary database and backend access, but still expose account and installation identifiers, repeated opaque site identifiers within an account, dates, durations, and sync timing. This is hostname encryption, not anonymous or fully encrypted browsing history. The browser profile, extension code, and anyone who can access an unlocked profile remain trusted.

When you enable backup, SiteClock uploads existing unassigned usage from this installation and subsequent cumulative usage. Previously assigned history stays separate between accounts. Encrypted accounts store keyed site identifiers and ciphertext; unencrypted accounts store hostnames. Daily counters remain labeled by local calendar date, and contributions combine without duplicate counting when the selected mode supports shared site identifiers.

Backup uses Amazon Web Services: Cognito for authentication, API Gateway and Lambda for authenticated requests, and DynamoDB for stored usage. The current development deployment region is US East (Ohio); production deployment configuration determines its region. Hosting providers necessarily process connection and authentication metadata needed to operate the service. Application logs exclude hostnames, usage payloads, tokens, and full URLs; configured operational logs expire after 14 days.

While backup is enabled, the extension normally uploads changes and refreshes totals about once a minute while Chrome runs, and at startup or when you open the popup. Timing is best-effort. Offline tracking continues locally; unsent changes upload when connectivity returns. A sudden failure or deletion of local storage before upload can lose recent unbacked-up time.

Daily dates reflect the local timezone on the computer when tracking occurs. Last 7 days means today and the preceding six calendar dates. Historical dates are not rewritten when you travel. Usage saved before daily tracking was introduced is included in lifetime totals only.

## Your controls and retention

- With backup off, usage stays local. Signing in still communicates with Google and the account service for authentication.
- Pause cloud backup to stop usage uploads and downloads on this installation. Local tracking continues, and accumulated changes are included when you re-enable it. Existing cloud history is retained.
- Sign out to clear local credentials and the displayed cloud cache. This does not delete cloud history. Other installations continue according to their settings.
- Delete cloud history in SiteClock settings to delete usage across the account and pause backup. This keeps your sign-in account. Other installations detect the deletion when they next connect, pause, and cannot automatically restore the deleted contribution. Existing local contributions remain local; re-enabling starts a fresh cloud contribution.
- Deletion immediately makes the retired cloud history unavailable through the API. Physical record cleanup runs in retryable batches. Disaster-recovery copies can retain deleted information for up to seven days; recovery procedures preserve deletion decisions.
- Migrating existing plaintext history to an encrypted mode saves a local snapshot, advances the cloud generation, and rebuilds the totals with the selected privacy mode after your confirmation. Prior disaster-recovery copies may still contain plaintext hostnames until their retention period expires.
- Removing SiteClock or clearing its storage erases that installation's local data and identifier. Cloud data remains until you delete it through settings. Sign in and enable backup on another installation to restore previously uploaded totals.
- Disabling the extension stops tracking and keeps its local data. Hostname totals have no automatic expiration while retained locally or in an enabled cloud account.

Account identity remains after deleting cloud usage. To request deletion of the remaining SiteClock account identity, email rhea_development.unnatural809@slmails.com. The settings deletion action is labeled Delete cloud history and does not claim to delete your Google or SiteClock sign-in identity.

## Use and sharing

Information is used only to provide website timing, account authentication, backup, restoration, and synchronization. SiteClock does not sell data, use it for advertising, assess creditworthiness, or include third-party analytics. Google and AWS process information as required to provide the requested authentication and hosting services. Browsing information is not used for unrelated profiling.

SiteClock follows the Chrome Web Store User Data Policy, including its Limited Use requirements. All executable extension code is included in the package; remote services provide authentication and data, not downloaded executable code.

## Policy changes and contact

Material changes to data handling will be reflected in this policy and its date. For support or account-deletion requests, email rhea_development.unnatural809@slmails.com. Do not send browsing history, passwords, or authentication tokens. We may ask you to verify account ownership before acting on a deletion request.
