"""Build and verify the Chrome Web Store ZIP from an explicit production allowlist."""
from pathlib import Path
import hashlib
import json
import struct
import zipfile

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'manifest.json').read_text())
paths = ['manifest.json', 'background.js', 'core.js', 'content.js',
         'popup.html', 'popup.css', 'popup.js']
paths += sorted(set(manifest['icons'].values()) | set(manifest['action']['default_icon'].values()))
assert manifest['manifest_version'] == 3
assert len(manifest['description']) <= 132
assert not manifest.get('key'), 'Store submission must not bundle a development identity override.'
for path in paths:
    assert (ROOT / path).is_file(), f'Missing production resource: {path}'
for size, path in manifest['icons'].items():
    image = (ROOT / path).read_bytes()
    assert image[:8] == b'\x89PNG\r\n\x1a\n'
    assert struct.unpack('>II', image[16:24]) == (int(size), int(size))
out = ROOT / 'dist' / f'siteclock-{manifest["version"]}.zip'
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for path in paths:
        # Fixed metadata makes repeated builds of identical sources reproducible.
        info = zipfile.ZipInfo(path, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, (ROOT / path).read_bytes())
with zipfile.ZipFile(out) as archive:
    assert archive.testzip() is None
    assert set(archive.namelist()) == set(paths)
    assert json.loads(archive.read('manifest.json')) == manifest
    for path in paths:
        assert archive.read(path) == (ROOT / path).read_bytes()
digest = hashlib.sha256(out.read_bytes()).hexdigest()
out.with_suffix('.zip.sha256').write_text(f'{digest}  {out.name}\n')
print(f'Built and verified {out.name}: {len(paths)} production files, {out.stat().st_size:,} bytes')
print(f'SHA-256: {digest}')
