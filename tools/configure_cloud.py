"""Write public extension configuration and exact network permissions from stack outputs.

Usage: aws cloudformation describe-stacks --stack-name ... --query 'Stacks[0].Outputs' > /tmp/siteclock-outputs.json
       python3 tools/configure_cloud.py /tmp/siteclock-outputs.json
Never pass credentials or a Google client secret to this tool.
"""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]

def configuration(outputs):
    if isinstance(outputs, dict) and 'Stacks' in outputs:
        outputs = outputs['Stacks'][0]['Outputs']
    if isinstance(outputs, list):
        outputs = {entry['OutputKey']: entry['OutputValue'] for entry in outputs}
    required = {'ApiBase': 'apiBase', 'AuthBase': 'authBase', 'ClientId': 'clientId', 'UserPoolId': 'userPoolId'}
    values = {target: outputs[source].rstrip('/') for source, target in required.items()}
    for key, pattern in [('apiBase', r'[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com'),
                         ('authBase', r'[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com')]:
        url = urlparse(values[key])
        if url.scheme != 'https' or not re.fullmatch(pattern, url.netloc) or url.path or url.query or url.fragment:
            raise ValueError(f'Invalid AWS origin for {key}')
    if not re.fullmatch(r'[a-z0-9]+', values['clientId']) or not re.fullmatch(r'[a-z0-9-]+_[A-Za-z0-9]+', values['userPoolId']):
        raise ValueError('Invalid Cognito public identifiers')
    return values

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('outputs', type=Path)
    args = parser.parse_args()
    values = configuration(json.loads(args.outputs.read_text()))
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    origins = [values['apiBase'], values['authBase']]
    manifest['host_permissions'] = [origin + '/*' for origin in origins]
    manifest['content_security_policy'] = {'extension_pages': "script-src 'self'; object-src 'self'; connect-src 'self' " + ' '.join(origins) + ';'}
    (ROOT / 'cloud-config.js').write_text('/* Public deployment configuration. No secrets. */\n' +
        'globalThis.SiteClockCloudConfig = Object.freeze(' + json.dumps(values, indent=2) + ');\n')
    (ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Configured public AWS endpoints and exact extension host permissions. Reload SiteClock in Chrome.')

if __name__ == '__main__':
    main()
