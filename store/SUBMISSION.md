# SiteClock launch checklist

## Current release status (November 1, 2026)

Version 0.4.0 implements onboarding with recovery-code encryption (default), profile-only encryption, and explicit unencrypted backup. The updated backend is deployed to `siteclock-dev` and, on November 1, 2026, to the separate `siteclock-prod` stack in `us-east-2`. The production-configured package is prepared at `dist/siteclock-0.4.0-production.zip` (SHA-256 in the adjacent file); its current SHA-256 is `543202ab12184044092f4f833ff354fa2f880322177cf90c1c14579e9dd6fc2d`. It is not yet submitted to the Chrome Web Store. Local verification passes 19 tracking checks, 65 Node tests, and seven deployment tests. CloudFormation lint and project cfn-guard checks pass. Ten deployed accounting checks and four deployed privacy scenarios pass against development; synthetic account data was removed. Privacy scenarios cover opaque persisted keys/rows, local decryption, duplicate counters, key validation, separate installations, migration locking, owner checks, and atomic encrypted generation changes. These Lambda/DynamoDB scenarios do not establish a complete Chrome/Google/API Gateway end-to-end journey for this release.

The code review corrected wrong-recovery-code uploads, migration lifetime accounting, interrupted local rebuilds, second-profile device key creation, and the missing authenticated privacy API route. Production Lambda/DynamoDB privacy smoke checks passed for recovery, device-only, plaintext, and migration scenarios using synthetic accounts; cleanup was verified. The production SNS email subscription is confirmed and a test alert arrived. A PITR restore to a temporary table reached `ACTIVE` and the table was deleted. An independent cryptographic review has not been performed. Dates and durations remain readable; only hostname strings are encrypted.

The owner's unpacked SiteClock 0.4.0 now points to the production API and Cognito pool. Production Cognito allows both the published store extension callback and this explicitly configured unpacked owner-verification callback. On November 1, Google sign-in completed with `eraymond1411@gmail.com`; the settings page showed the production service and backup remained off. The settings UI also bounds status waits to 10 seconds and interactive actions to two minutes. A full production backup journey across two installations remains untested.

Existing published item: `bmbcnjfikfnchmpcpoheggcbppgkeojm`, publisher Rhea, currently version 0.1.0. Update this item instead of creating another. Public support alias: `rhea_development.unnatural809@slmails.com`, supported by the Chrome Web Store contact verification email dated October 18, 2026. The production OAuth client and AWS stack are configured for this extension ID. The OAuth audience is External/In production, so Google-account sign-in is available to any user. Google branding verification and the Chrome Web Store update are still outstanding.

The domain siteclock.dev is registered with Cloudflare. The public homepage, privacy, support and beta terms pages are deployed using the siteclock static-assets Worker; DNS and HTTPS are configured. Website copy labels cloud backup as forthcoming until the updated store package ships.

Still required: submit the production Google OAuth branding for verification; verify sign-in and recovery/device/plaintext flows in the actual Chrome package; test two real Google accounts/installations; replace promotional screenshots; update dashboard disclosures; and submit the production ZIP for review. Local static website assets and packaging helpers are prepared; the store-draft ZIP has no cloud endpoints and must not be submitted as the cloud-enabled release.

## Previous verified status (November 1, 2026)

The development backend remains deployed in AWS Ohio (`us-east-2`); the checked-in public extension configuration currently points to the separate production stack. Version 0.3.0 supports optional Google accounts, opt-in cloud backup, local-calendar daily counters, last-seven-day views, and transactionally consistent lifetime summaries. The on-page timer shows Total and reveals Today and Last 7 days on hover or keyboard focus.

Local verification passes 70 tracking, sync, authentication, backend, and deployment tests. Eight deployed Lambda/DynamoDB checks cover legacy migration, duplicate/older counters, concurrent installations, date ranges, summary consistency, legacy-client protection, date validation, and deletion. The installed development extension has also successfully signed in and uploaded daily usage through the authenticated API. This does not establish that the full store-install journey or isolation between two real Google accounts has been tested.

The Chrome Web Store submission has not been completed as part of this work. Existing promotional screenshots show the earlier local-only interface and need replacement. The current development ZIP is not the production distribution package.

## Current user journey

Local use: install or load the extension, then open a new website or refresh an existing website tab. Tracking needs no account. The unpacked development path requires Developer mode and a local source directory.

Cloud use: open the toolbar popup, choose Accounts & settings, Continue with Google, then explicitly enable Cloud backup and confirm import of unassigned totals. Google sign-in creates the SiteClock identity on first use; there is no separate account-registration form. Each installation must opt in separately.

The install handler opens welcome.html on first installation. Existing website tabs require a refresh for their content scripts. The full production store-install journey remains to be verified.

## Before inviting external users

1. **Store identity and distribution.** Create or identify the Chrome Web Store item and obtain its stable extension ID. Configure Cognito's production callback for that exact ID (`https://EXTENSION_ID.chromiumapp.org/oauth2`). An unlisted store release is appropriate for a link-only pilot; it still requires review. Do not ask ordinary users to install a ZIP through Developer mode.
2. **Production accounts and storage.** Deploy a separate production stack using `Environment=prod`, its Google OAuth client/secret, alert address, and the store extension ID. The template enables seven-day PITR and deletion protection for production. The published store callback is retained; an optional, explicitly configured unpacked owner-verification ID can be added with `UnpackedExtensionId`. `tools/deploy_cloud.py --environment prod` uses separate production metadata and leaves the development extension configuration unchanged.
3. **Production Google sign-in.** Use a separate Google Cloud project for production. Configure the External audience, production publishing/branding, accurate support details, and an owned, verified homepage with privacy and terms links. SiteClock requests only `openid`, `email`, and `profile`; Google's current basic-identity exception means Testing status alone does not necessarily restrict it to allowlisted users. Verify the actual consent experience with a Google account that has never used SiteClock rather than assuming it is blocked or warning-free. Sensitive/restricted Google API scopes are not needed.
4. **First-run onboarding.** The welcome screen now offers local-only use and three cloud hostname privacy modes. Verify its recovery-code acknowledgement, device-only limitations, migration consent, account restore behavior, and options-page recovery flow. Show successful sync and explain refreshing existing tabs. Avoid reopening onboarding after every update. No account should be required for local timing.
5. **Production package and disclosures.** Configure the extension using production outputs, validate exact hosts/CSP and callback routing, and rebuild with `python3 tools/package.py`. Refresh screenshots and store disclosures for daily hostname usage, identity, and stored tokens. Publish the policy and provide a working private support/account-deletion contact. The current settings delete cloud history, not the Cognito identity.
6. **Fresh-user release test.** Install the actual production-configured store build in a clean Chrome profile with a new Google account. Verify local use, optional sign-in/consent, backup success, a second installation, offline catch-up, reconnect/refresh, account switching and separation, history deletion, and restore after removal. Confirm daily/weekly/lifetime views and hover behavior. Do not use real user history as disposable fixtures.
7. **Operations and pilot limits.** Production SNS email delivery and a DynamoDB point-in-time restore drill have been verified. Still review cleanup, log privacy, rollback behavior, per-account storage/request limits, and abuse controls before broad distribution. CloudTrail is logging; confirm retention and access to its delivered records during the operational review. The template's global API limit is 10 requests/second with burst 20 and Lambda reserved concurrency 10; current sync makes roughly five API requests per installation/minute before pagination. A cost notification is not a hard spending cap. Start with a small pilot and measure load before expanding.

An unpacked extension and store extension can have separate local storage and installation IDs. Enable backup on the existing installation before moving to the store version, then sign into the same account and enable backup there to restore uploaded totals.

## Dashboard

Open https://chrome.google.com/webstore/devconsole. Complete any publisher registration, agreement, payment, contact verification, or two-step verification steps personally. Upload the production-configured ZIP, enter the current listing and privacy disclosures, and submit for review when ready. Publishing is a separate release action; committing code does not publish the extension.

## References

- [Chrome Web Store publishing](https://developer.chrome.com/docs/webstore/publish)
- [Public, unlisted and private distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- [Google OAuth app states and basic identity exception](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)
- [Google OAuth production policies](https://developers.google.com/identity/protocols/oauth2/policies)
