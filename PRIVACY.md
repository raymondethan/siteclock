# SiteClock Privacy Policy

Last updated: October 17, 2026

SiteClock shows your cumulative active browsing time for each website. Your
website totals stay in your Chrome profile on this computer. SiteClock has no
account system, analytics service, or server receiving your browsing data.

## Information used

SiteClock uses the current tab's URL to determine its hostname, such as
`example.com`. It uses tab and window state and Chrome's active, idle, and locked
signals to decide when to count time. It does not record your keystrokes, mouse
movements, or clicks.

Chrome may provide tab metadata, including full URLs and titles, while the
extension is running. SiteClock uses this information only in memory to identify
the active website. It does not persist URL paths, query strings, page titles, or
the contents of web pages, forms, passwords, or cookies.

SiteClock stores the following locally:

- Each website's hostname and cumulative active time in milliseconds.
- The last accounting timestamp, active hostname, and tab identifier needed to
  avoid counting an interval twice.
- A random browser-session identifier used to distinguish a background-worker
  restart from a full browser restart. It is not sent anywhere or used to
  identify you across devices.

## How information is used

This information is used only to calculate, save, and display your website
timers and totals. A leading `www.` is removed from hostnames; other subdomains
have separate totals. Incognito browsing is not tracked.

## Storage, retention, and access

Website totals are saved using Chrome's extension-local storage. They have no
automatic expiration and remain across browser and computer restarts. Temporary
browser-session state is cleared when Chrome ends or reloads the extension.

You can view your saved website totals by opening the SiteClock toolbar popup.
People and software with access to your Chrome profile or computer may also be
able to access this local data. SiteClock does not add its own encryption layer.

## Sharing and transmission

SiteClock does not send browsing data or website totals to its developer or to
third parties. It does not sell data, use it for advertising, synchronize it
between devices, or include third-party analytics. Its runtime makes no network
requests.

SiteClock follows the Chrome Web Store User Data Policy, including its Limited
Use requirements. Browsing information is used solely to provide the website
timer and totals, and is not used for advertising or unrelated purposes.

## Your controls and deletion

Disable SiteClock in Chrome's extension settings to stop tracking. Disabling it
keeps existing totals. Removing SiteClock from Chrome deletes its extension-local
data, including all saved totals. SiteClock cannot recover deleted totals.

## Policy changes

If SiteClock's handling of data changes, this policy and its last-updated date
will be updated with the corresponding release.

## Contact

For questions about this policy, open an issue in the
[SiteClock project](https://github.com/raymondethan/siteclock/issues).
Issues are public; please do not include your browsing history or other private
information in a report.
