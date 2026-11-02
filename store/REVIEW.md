# SiteClock store submission review

These are the approved store-submission materials. The privacy policy is
published in the public repository. The Chrome Web Store submission is not yet
complete; see `SUBMISSION.md` for current status and the remaining steps.

## Start here

- `review.html`: local gallery with the artwork, screenshots, listing copy, and
  privacy-policy draft.
- `assets/icon-preview.png`: minimal browser-window clock on light/dark surfaces.
- `assets/promo-small-440x280.png`: required promotional tile.
- `assets/promo-marquee-1400x560.png`: optional wide promotional artwork.
- `listing.md`: short description, full description, single purpose, and testing
  instructions ready to copy into the dashboard.
- `privacy-practices.md`: permission explanations and data-handling disclosures.
- `../PRIVACY.md` and `privacy-policy.html`: the same policy in source and
  standalone HTML forms.
- `../dist/siteclock-0.4.0-production.zip`: production-configured upload package.

## Design

A browser outline with two clock hands, using dark slate and mint. No gradients,
lettering inside the icon, or decorative detail. The 128-pixel PNG has transparent
padding around a 96-pixel mark. Smaller icons use the same geometry. The SVG
source and deterministic PNG renderer are included in the repository.

Promotional copy describes the 0.4.0 release. The public policy and support
page use the SiteClock domain and private support alias.

## Screenshots

Capture notes and file dimensions are listed in `screenshots/NOTES.md`. Only
neutral public-page content should appear in publishable screenshots; personal
tab lists, browsing totals, emails, bookmarks, and account information must not
be included. Preview artwork is not represented as a browser capture.

## Package

The ZIP contains `manifest.json` at its root, production JavaScript, popup HTML
and CSS, and four PNG icons. It excludes tests, development tools, `.git`, store
copy, screenshots, keys, credentials, and personal runtime data. The SVG source
is kept for editing; Chrome uses the PNG files.

The current published listing is version `0.1.0`; the 0.4.0 production package
is prepared as an update to that same item. It contains encrypted-hostname
backup options, with recovery-code encryption selected by default and backup
remaining opt-in.

Rebuild locally:

```sh
swift tools/build_assets.swift
python3 tools/build_review.py
python3 tools/package.py
swift tests/run.swift .
```

Generated ZIPs and checksums are in ignored `dist/`. Artwork and copy can be
committed. Any screenshot originals containing personal browser chrome must
remain outside the repository.

## Review status

The public privacy-policy URL is listed in `SUBMISSION.md`. The owner reports that the production package, refreshed screenshots, and privacy disclosures have been submitted to the Chrome Web Store. Review is still required by Google; these files do not imply approval. Switching from an unpacked extension to the store
installation may require migrating existing local totals; that feature is not
included in this packaging work.

## Version 0.4 cloud release

Accounts, optional cloud backup, and hostname encryption are implemented. New
backup setup offers encrypted backup with a recovery key or unencrypted backup;
previously configured profile-only accounts remain supported.
The production package is configured for the production stack and existing store
extension ID. Complete the fresh-profile checks in `SUBMISSION.md`. Existing
local screenshot assets have been refreshed to show the current timer overlay;
the owner reports they have been uploaded to the Chrome Web Store listing for review.
