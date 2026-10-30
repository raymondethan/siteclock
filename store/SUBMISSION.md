# SiteClock 0.2.0 release checklist

## Current status

The repository contains optional Google accounts, account-wide totals, and opt-in cloud backup. The default source configuration is local-only until AWS outputs are configured. No 0.2.0 store submission or cloud deployment has been performed.

The earlier 0.1.0 package and screenshots describe the local-only release. Refresh screenshots and promotional text for 0.2.0; do not publish the new cloud listing with an unconfigured build.

## Before submission

1. Deploy development infrastructure and configure a stable unpacked extension ID. Follow `../backend/README.md` for Google OAuth setup, AWS parameters, public endpoint configuration, costs, and recovery.
2. Complete the two-installation smoke tests, including offline catch-up, restore after local deletion, account switching, token refresh, and stale uploads after cloud deletion.
3. Create or identify the Chrome Web Store item to obtain its stable published extension ID. Configure a separate production stack and Google OAuth client for that ID. Complete Google's consent-screen/publishing requirements for public Google sign-in.
4. Configure the extension against production outputs, run the documented tests, and build `dist/siteclock-0.2.0.zip` using `python3 tools/package.py`. Use the generated `.sha256` file for its digest. Inspect the package's exact AWS host permissions and confirm it contains no credentials or development manifest key.
5. Update the public privacy policy, screenshots, listing, and dashboard disclosures from the files in this directory. The extension still requires no login for local tracking; cloud backup requires a Google account and explicit opt-in.
6. Confirm AWS alert subscriptions, cost-allocation tag activation, production PITR/deletion protection, cleanup processing, and operational log privacy.

## Dashboard

Open https://chrome.google.com/webstore/devconsole and complete any publisher registration, agreement, payment, contact verification, or two-step verification requirements yourself.

Upload the configured package, enter `listing.md`, supply updated artwork and screenshots, and enter the permission/data disclosures from `privacy-practices.md`. Use https://github.com/raymondethan/siteclock/blob/master/PRIVACY.md as the policy URL. Answer publisher declarations from actual circumstances. Publishing is a separate release step.

An unpacked extension and store extension may have separate local storage and installation IDs. Enable backup on the existing installation before moving to the store version, then sign into the same account and enable backup there to restore uploaded totals.
