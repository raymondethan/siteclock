"""Prepare an isolated store draft or production package without changing local config.

Drafts have no cloud configuration and are only for obtaining a store item ID.
Production requires live production stack outputs and is never inferred from
hostname strings. No credentials are read or copied into the extension staging.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

from package import build, SOURCE_FILES

ROOT = Path(__file__).resolve().parents[1]
FILES = list(SOURCE_FILES)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--outputs', type=Path, help='Production CloudFormation outputs, not credentials')
    parser.add_argument('--draft', action='store_true')
    args = parser.parse_args()
    if bool(args.outputs) == bool(args.draft):
        parser.error('Choose either --draft or --outputs.')
    mode = 'draft' if args.draft else 'production'
    target = ROOT / '.test-build' / f'extension-{mode}'
    target.mkdir(parents=True, exist_ok=True)
    for filename in FILES:
        shutil.copy2(ROOT / filename, target / filename)
    shutil.copytree(ROOT / 'icons', target / 'icons', dirs_exist_ok=True)
    manifest = json.loads((target / 'manifest.json').read_text())
    if args.draft:
        (target / 'cloud-config.js').write_text('globalThis.SiteClockCloudConfig = Object.freeze({});\n')
        manifest.pop('host_permissions', None)
        manifest['content_security_policy'] = {'extension_pages': "script-src 'self'; object-src 'self'; connect-src 'self';"}
        (target / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    else:
        outputs = json.loads(args.outputs.read_text())
        if isinstance(outputs, dict) and 'Stacks' in outputs:
            outputs = outputs['Stacks'][0]['Outputs']
        if isinstance(outputs, list):
            outputs = {row['OutputKey']: row['OutputValue'] for row in outputs}
        if outputs.get('Environment') != 'prod' or outputs.get('StackName') != 'siteclock-prod':
            raise SystemExit('Production packaging requires outputs identifying siteclock-prod and Environment=prod.')
        subprocess.run(['python3', str(ROOT / 'tools/configure_cloud.py'), str(args.outputs.resolve()), '--root', str(target)], check=True)
    # Use the same explicit packaging allowlist for every release variant.
    source = build(target)
    output = ROOT / 'dist' / f'siteclock-{manifest["version"]}-{mode}.zip'
    shutil.copy2(source, output)
    import hashlib
    output.with_suffix('.zip.sha256').write_text(f'{hashlib.sha256(output.read_bytes()).hexdigest()}  {output.name}\n')
    with zipfile.ZipFile(output) as package:
        assert set(package.namelist()) == set(FILES + sorted(set(manifest['icons'].values()) | set(manifest['action']['default_icon'].values())))
    print(f'Prepared {output.relative_to(ROOT)}. Source development configuration was not changed.')


if __name__ == '__main__':
    main()
