"""Render the local store review gallery and public-ready policy HTML."""
from pathlib import Path
from html import escape
import re

ROOT = Path(__file__).resolve().parents[1]

def inline(text):
    text = escape(text)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    return re.sub(r'\[([^\]]+)\]\((https://[^)]+)\)', r'<a href="\2">\1</a>', text)

def markdown(text):
    """Small renderer for the controlled headings/paragraphs/lists used here."""
    result, paragraph, in_list = [], [], False
    def flush():
        if paragraph:
            result.append('<p>' + inline(' '.join(paragraph)) + '</p>')
            paragraph.clear()
    for line in text.splitlines() + ['']:
        if line.startswith('#'):
            flush()
            if in_list:
                result.append('</ul>'); in_list = False
            level = len(line) - len(line.lstrip('#'))
            result.append(f'<h{level}>{inline(line[level:].strip())}</h{level}>')
        elif line.startswith('- '):
            flush()
            if not in_list:
                result.append('<ul>'); in_list = True
            result.append('<li>' + inline(line[2:]) + '</li>')
        elif line.startswith('  ') and in_list:
            result[-1] = result[-1][:-5] + ' ' + inline(line.strip()) + '</li>'
        elif not line.strip():
            flush()
            if in_list:
                result.append('</ul>'); in_list = False
        else:
            if in_list:
                result.append('</ul>'); in_list = False
            paragraph.append(line.strip())
    return '\n'.join(result)

CSS = '''
:root{color-scheme:light;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#19232b;background:#f4f8f6}
*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:0 auto;padding:64px 32px 96px}
h1,h2,h3{line-height:1.2;letter-spacing:-.025em}h1{font-size:42px;margin:0 0 18px}h2{margin:40px 0 16px;font-size:26px}
h3{margin-top:28px;font-size:19px}p,li{max-width:78ch}a{color:#176244;text-underline-offset:3px}code{font-size:.88em;overflow-wrap:anywhere}
.intro{font-size:19px;color:#50645e}.status{display:inline-block;padding:5px 12px;border:1px solid #b8cfc2;border-radius:99px;font-size:12px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}.card{background:white;border:1px solid #dbe5df;border-radius:16px;padding:24px;overflow:hidden}
figure{margin:0}figcaption{font-size:13px;color:#50645e;margin-top:12px}img{max-width:100%;height:auto;display:block;border-radius:8px}
.wide{grid-column:1/-1}.files{display:flex;gap:14px;flex-wrap:wrap;margin:24px 0 40px}.files a{padding:9px 14px;background:white;border:1px solid #dbe5df;border-radius:8px;text-decoration:none}
details{border-top:1px solid #ccd9d0;padding:20px 0}summary{font-size:21px;font-weight:600;cursor:pointer}article{max-width:820px}
nav{display:flex;gap:20px;flex-wrap:wrap;margin:0 0 40px;font-size:14px}.foot{color:#50645e;margin-top:40px;font-size:13px}
@media(max-width:700px){main{padding:32px 20px}.grid{grid-template-columns:1fr}h1{font-size:32px}.wide{grid-column:auto}}
@media print{details>*{display:block!important}main{padding:0}.files,nav{display:none}.card{break-inside:avoid}}
'''

def page(title, content):
    return f'<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{escape(title)}</title><style>{CSS}</style></head><body><main>{content}</main></body></html>\n'

policy = markdown((ROOT/'PRIVACY.md').read_text())
(ROOT/'store/privacy-policy.html').write_text(page('SiteClock Privacy Policy', '<article>'+policy+'</article>'))
screenshots = [
    ('screenshots/02-on-page-timer-640x400.png', 'Compact live capture · 640 × 400'),
    ('screenshots/01-on-page-timer-1280x800.png', 'Full live capture · 1280 × 800'),
]
shots = ''.join(f'<figure class="card"><a href="{src}"><img src="{src}" alt="SiteClock timer on the public example domain"></a><figcaption>{label}. Actual capture; the timer is paused at zero on this new site. No personal browsing history is shown.</figcaption></figure>' for src,label in screenshots)
gallery = '''
<span class="status">Approved submission materials · store submission pending</span>
<h1>SiteClock</h1><p class="intro">A minimal website timer. Here are the package, artwork, and store copy.</p>
<nav><a href="#artwork">Artwork</a><a href="#screenshots">Screenshots</a><a href="#copy">Listing copy</a><a href="#privacy">Privacy</a></nav>
<div class="files"><a href="../dist/siteclock-0.1.0.zip">Release ZIP · v0.1.0</a><a href="listing.md">Listing source</a><a href="privacy-practices.md">Dashboard privacy fields</a><a href="privacy-policy.html">Standalone privacy policy</a></div>
<h2 id="artwork">Icon &amp; promotional artwork</h2><div class="grid">
<figure class="card"><img src="assets/icon-preview.png" alt="Browser-window clock icon on light and dark backgrounds"><figcaption>Browser outline + clock hands. Slate and mint. PNG sizes: 16, 32, 48, and 128 pixels. <a href="../icons/siteclock.svg">Editable SVG</a>.</figcaption></figure>
<figure class="card"><a href="assets/promo-small-440x280.png"><img src="assets/promo-small-440x280.png" alt="SiteClock — Time spent on each website."></a><figcaption>Required small promotional tile · 440 × 280.</figcaption></figure>
<figure class="card wide"><a href="assets/promo-marquee-1400x560.png"><img src="assets/promo-marquee-1400x560.png" alt="SiteClock — Time spent on each website. A small timer. A running total. Stored locally."></a><figcaption>Optional marquee · 1400 × 560.</figcaption></figure></div>
<h2 id="screenshots">Live screenshots</h2><p>The installed extension on a neutral public page. These are genuine captures, not simulated product UI.</p><div class="grid">'''+shots+'''</div>
<h2 id="copy">Copy &amp; disclosures</h2><details open><summary>Store listing</summary>'''+markdown((ROOT/'store/listing.md').read_text())+'''</details>
<details id="privacy"><summary>Privacy policy</summary>'''+policy+'''</details>
<details><summary>Dashboard privacy answers</summary>'''+markdown((ROOT/'store/privacy-practices.md').read_text())+'''</details>
<p class="foot">The ZIP contains only production files and PNG icons. The policy is hosted in the public repository. The store submission is pending; see SUBMISSION.md for account and dashboard steps.</p>
'''
(ROOT/'store/review.html').write_text(page('SiteClock · Store submission review', gallery))
print('Built store/review.html and store/privacy-policy.html from the review drafts.')
