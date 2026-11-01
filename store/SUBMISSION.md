# SiteClock 0.3.0 launch checklist

## Current status (November 1, 2026)

The development backend is deployed in AWS Ohio (`us-east-2`). The checked-in public configuration points to that development stack. Version 0.3.0 supports optional Google accounts, opt-in cloud backup, local-calendar daily counters, last-seven-day views, and transactionally consistent lifetime summaries. The on-page timer shows Total and reveals Today and Last 7 days on hover or keyboard focus.

Local verification passes 70 tracking, sync, authentication, backend, and deployment tests. Eight deployed Lambda/DynamoDB checks cover legacy migration, duplicate/older counters, concurrent installations, date ranges, summary consistency, legacy-client protection, date validation, and deletion. The installed development extension has also successfully signed in and uploaded daily usage through the authenticated API. This does not establish that the full store-install journey or isolation between two real Google accounts has been tested.

The Chrome Web Store submission has not been completed as part of this work. Existing promotional screenshots show the earlier local-only interface and need replacement. The current development ZIP is not the production distribution package.

## Current user journey

Local use: install or load the extension, then open a new website or refresh an existing website tab. Tracking needs no account. The unpacked development path requires Developer mode and a local source directory.

Cloud use: open the toolbar popup, choose Accounts & settings, Continue with Google, then explicitly enable Cloud backup and confirm import of unassigned totals. Google sign-in creates the SiteClock identity on first use; there is no separate account-registration form. Each installation must opt in separately.

The install handler currently reconciles tracking only: it does not open a welcome page or guide users into cloud backup. Existing website tabs require a refresh for their content scripts. This is functional but not yet a seamless first-run experience.

## Before inviting external users

1. **Store identity and distribution.** Create or identify the Chrome Web Store item and obtain its stable extension ID. Configure Cognito's production callback for that exact ID (`https://EXTENSION_ID.chromiumapp.org/oauth2`). An unlisted store release is appropriate for a link-only pilot; it still requires review. Do not ask ordinary users to install a ZIP through Developer mode.
2. **Production accounts and storage.** Deploy a separate production stack using `Environment=prod`, its Google OAuth client/secret, alert address, and the store extension ID. The template enables seven-day PITR and deletion protection for production. Restrict callbacks to the intended production extension; leave local/test callbacks in development. `tools/deploy_cloud.py` is intentionally development-only; use the documented SAM path or add a separately reviewed production deployment workflow.
3. **Production Google sign-in.** Use a separate Google Cloud project for production. Configure the External audience, production publishing/branding, accurate support details, and an owned, verified homepage with privacy and terms links. SiteClock requests only `openid`, `email`, and `profile`; Google's current basic-identity exception means Testing status alone does not necessarily restrict it to allowlisted users. Verify the actual consent experience with a Google account that has never used SiteClock rather than assuming it is blocked or warning-free. Sensitive/restricted Google API scopes are not needed.
4. **First-run onboarding.** Add a welcome screen on initial install with clear choices to use locally or enable backup. The backup choice should explain hostname/date/duration uploads, start Google sign-in, and preserve explicit backup consent. Show successful sync and explain refreshing existing tabs. Avoid reopening onboarding after every update. No account should be required for local timing.
5. **Production package and disclosures.** Configure the extension using production outputs, validate exact hosts/CSP and callback routing, and rebuild with `python3 tools/package.py`. Refresh screenshots and store disclosures for daily hostname usage, identity, and stored tokens. Publish the policy and provide a working private support/account-deletion contact. The current settings delete cloud history, not the Cognito identity.
6. **Fresh-user release test.** Install the actual production-configured store build in a clean Chrome profile with a new Google account. Verify local use, optional sign-in/consent, backup success, a second installation, offline catch-up, reconnect/refresh, account switching and separation, history deletion, and restore after removal. Confirm daily/weekly/lifetime views and hover behavior. Do not use real user history as disposable fixtures.
7. **Operations and pilot limits.** Confirm alert subscriptions, budget delivery, cleanup, log privacy, and production recovery with deletion decisions preserved. Add durable audit logging; the development preflight previously verified only management event history. Exercise rollback and recovery before depending on backups. Review per-account storage/request limits and abuse controls before broad distribution. The template's global API limit is 10 requests/second with burst 20 and Lambda reserved concurrency 10; current sync makes roughly five API requests per installation/minute before pagination. A cost notification is not a hard spending cap. Start with a small pilot and measure load before expanding.

An unpacked extension and store extension can have separate local storage and installation IDs. Enable backup on the existing installation before moving to the store version, then sign into the same account and enable backup there to restore uploaded totals.

## Dashboard

Open https://chrome.google.com/webstore/devconsole. Complete any publisher registration, agreement, payment, contact verification, or two-step verification steps personally. Upload the production-configured ZIP, enter the current listing and privacy disclosures, and submit for review when ready. Publishing is a separate release action; committing code does not publish the extension.

## References

- [Chrome Web Store publishing](https://developer.chrome.com/docs/webstore/publish)
- [Public, unlisted and private distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- [Google OAuth app states and basic identity exception](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)
- [Google OAuth production policies](https://developers.google.com/identity/protocols/oauth2/policies)
