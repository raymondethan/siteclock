"""Build public SiteClock assets after domain, store ID and support contact approval.

Generated output is static and has no credentials, forms, cookies or analytics.
Terms are a draft for the publisher to review before making the site public.
"""
import argparse
from html import escape
from pathlib import Path
import re
import shutil

from build_review import markdown

ROOT = Path(__file__).resolve().parents[1]


def build(domain, email, extension_id, preview=False):
    if not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}', domain):
        raise ValueError('Provide an approved DNS hostname without a scheme or path.')
    if not re.fullmatch(r'[A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', email):
        raise ValueError('Provide the approved public support email.')
    if not re.fullmatch('[a-p]{32}', extension_id):
        raise ValueError('Provide the actual Chrome Web Store extension ID.')
    out = ROOT / 'dist' / ('site-preview' if preview else 'site')
    out.mkdir(parents=True, exist_ok=True)
    store_url = f'https://chromewebstore.google.com/detail/{extension_id}'
    index = (ROOT / 'web/index.html').read_text().replace('{{STORE_URL}}', store_url)
    (out / 'index.html').write_text(index)
    shutil.copy2(ROOT / 'web/style.css', out / 'style.css')
    shutil.copy2(ROOT / 'icons/icon-128.png', out / 'icon.png')
    def page(title, body):
        return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + escape(title) + '</title><link rel="stylesheet" href="style.css"></head><body><main><header><a class="brand" href="./">SiteClock</a><nav><a href="privacy.html">Privacy</a><a href="support.html">Support</a></nav></header><article class="policy">' + body + '</article><footer><a href="terms.html">Terms</a><a href="support.html">Support</a></footer></main></body></html>'
    policy = (ROOT / 'PRIVACY.md').read_text()
    policy = policy.replace('contact the developer using the support link below', f'email {email}')
    policy = policy.replace('For support or account-deletion requests, use the [SiteClock project support page](https://github.com/raymondethan/siteclock/issues). Issues are public; do not include browsing history, credentials, or other private information. Ask for a private contact method when needed.', f'For support or account-deletion requests, email {email}. Do not send passwords, authentication tokens, or browsing history. We may ask you to verify ownership of the account before acting on a deletion request.')
    (out / 'privacy.html').write_text(page('SiteClock Privacy Policy', markdown(policy)))
    support = f'<h1>Support &amp; account deletion</h1><p>Email <a href="mailto:{escape(email, quote=True)}">{escape(email)}</a> for help or to request removal of your SiteClock account identity.</p><p>To delete backed-up usage immediately, open SiteClock’s Accounts &amp; settings and choose Delete cloud history. That keeps your sign-in identity. For account identity removal, contact us from the email associated with your SiteClock Google account. We may verify ownership before acting.</p><p>Do not include passwords, authentication tokens, or browsing history in your message.</p>'
    (out / 'support.html').write_text(page('SiteClock Support', support))
    terms = '<h1>SiteClock beta terms — draft for publisher review</h1><p>SiteClock measures active website usage and optionally backs up your totals. You choose whether to use an account and enable backup.</p><p>Use the service only for your own authorized browsing activity. Do not attempt to access another person’s data, interfere with the service, or bypass usage limits.</p><p>SiteClock is provided as a beta. Timing and synchronization can be delayed or interrupted. It should not be used as a billing record or a guarantee of complete activity history. Keep any records you need independently.</p><p>See the privacy policy for data handling and deletion controls. Contact support with any questions.</p>'
    (out / 'terms.html').write_text(page('SiteClock Beta Terms', terms))
    (out / 'robots.txt').write_text('User-agent: *\nAllow: /\n')
    print(f'Built static website in {out}; review terms before publishing https://{domain}.')
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preview', action='store_true')
    parser.add_argument('--domain', required=True)
    parser.add_argument('--support-email', required=True)
    parser.add_argument('--extension-id', required=True)
    args = parser.parse_args()
    build(args.domain, args.support_email, args.extension_id, args.preview)


if __name__ == '__main__':
    main()
