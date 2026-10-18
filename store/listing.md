# Chrome Web Store listing draft

## Name

SiteClock

## Short description

See your total time on each website in a small on-page timer. All data stays on your computer.

## Detailed description

SiteClock keeps a running total of the time you spend on each website and shows
it in a small timer in the corner of the page.

The total carries across pages and visits. Open the toolbar popup to see your
website totals, sorted by time spent.

- Counts the selected tab in the focused Chrome window.
- Pauses when Chrome loses focus, your computer locks, or you have been inactive
  for 30 minutes.
- Keeps totals across browser and computer restarts, with no daily reset.
- Stores data on this computer. No account, syncing, ads, or analytics.
- Groups pages by hostname, ignoring a leading www. Other subdomains are separate.

The first 30 minutes without input are counted before the inactivity pause.
Incognito browsing is not tracked. Chrome's internal pages and other protected
pages cannot show the timer. Sleep, delayed timers, and sudden shutdowns can
cause small amounts of time to go uncounted.

Removing SiteClock from Chrome deletes its saved totals.

## Listing fields

- Category: Productivity (choose the corresponding category in the dashboard).
- Language: English.
- Homepage: https://github.com/raymondethan/siteclock
- Support: https://github.com/raymondethan/siteclock/issues
- Privacy policy: https://github.com/raymondethan/siteclock/blob/master/PRIVACY.md
- Price: Free.

## Store images

- Store icon: `icons/icon-128.png`.
- Required small promotional tile: `store/assets/promo-small-440x280.png`.
- Optional marquee: `store/assets/promo-marquee-1400x560.png`.
- Screenshot files and their capture notes are described in `store/REVIEW.md`.

## Single purpose

Track cumulative active browsing time per website and display it in an on-page
timer and a toolbar list of website totals.

## Review testing instructions

Install SiteClock and open an ordinary HTTP or HTTPS website. A small timer
appears at the bottom right. Spend a few seconds there, switch to a second
website, and return: the first site's timer continues from its existing total.
Open the SiteClock toolbar popup to see both totals. Switch to another app to
pause counting. Restart Chrome and revisit the website to confirm its saved
total remains. No login or test account is needed.
