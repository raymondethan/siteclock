"""Verify privacy modes on a deployed SiteClock Lambda and DynamoDB.

Only random synthetic account partitions are created/read/deleted. Crypto keys
stay in memory or the private temporary directory and are never printed.
API Gateway and Google sign-in require separate browser verification.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid
import deploy_cloud
from deploy_cloud import Deployment, WORK, ROOT, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', choices=['dev', 'prod'], default='dev')
    parser.add_argument('--node', default=shutil.which('node'))
    args = parser.parse_args()
    if not args.node:
        parser.error('Node.js 22+ must be on PATH, or supply --node.')
    if args.environment == 'prod':
        deploy_cloud.WORK = WORK / 'production'
    deployment = Deployment(args.environment)
    work = WORK / 'production' if args.environment == 'prod' else WORK
    outputs = {v['OutputKey']: v['OutputValue'] for v in json.loads((work / 'outputs.json').read_text())}
    table = outputs['TableName']
    checks = []
    owned = {}
    with tempfile.TemporaryDirectory(prefix='privacy-smoke-', dir=WORK) as temporary:
        directory = Path(temporary)

        def call(account, path='/v1/account', method='GET', body=None, query=None, expected=200):
            event = {'rawPath': path, 'requestContext': {'http': {'method': method},
                'authorizer': {'jwt': {'claims': {'sub': account, 'token_use': 'access'}}}},
                'queryStringParameters': query}
            if body is not None:
                event['body'] = json.dumps(body)
            request, response = directory / 'request.json', directory / 'response.json'
            write_json(request, event, private=True)
            result = deployment.aws('lambda', 'invoke', '--function-name', f'siteclock-{args.environment}-api',
                '--payload', f'fileb://{request}', response)
            assert not result.get('FunctionError'), 'Lambda execution failed'
            result = json.loads(response.read_text())
            assert result['statusCode'] == expected, (path, result['statusCode'], result['body'])
            value = json.loads(result['body'])
            if value.get('generation'):
                owned[account].add(value['generation'])
            return value

        def fixture(**kwargs):
            result = subprocess.run([args.node, str(ROOT / 'tools/privacy_fixture.cjs')],
                input=json.dumps(kwargs), text=True, capture_output=True, check=True)
            return json.loads(result.stdout)

        def query(partition):
            return deployment.aws('dynamodb', 'query', '--table-name', table,
                '--key-condition-expression', 'pk = :pk', '--expression-attribute-values',
                json.dumps({':pk': {'S': partition}}), '--consistent-read')['Items']

        def upload(account, generation, installation, counters, schema=3, expected=200):
            return call(account, '/v1/usage', 'PUT', {'generation': generation, 'installationId': installation,
                'schemaVersion': schema, 'counters': counters}, expected=expected)

        try:
            for mode in ['recovery', 'device', 'unencrypted']:
                account, installation, other = (str(uuid.uuid4()) for _ in range(3))
                owned[account] = set()
                assert not deployment.aws('dynamodb', 'get-item', '--table-name', table,
                    '--key', json.dumps({'pk': {'S': f'ACCOUNT#{account}'}, 'sk': {'S': 'PROFILE'}})).get('Item')
                generation = call(account)['generation']
                crypto = fixture(accountId=account, installationId=installation, generation=generation, mode=mode)
                call(account, '/v1/privacy', 'PUT', {'generation': generation, 'privacyMode': mode,
                    **({'keyId': crypto['keyId']} if mode == 'recovery' else {})})
                plain = {'hostname': 'privacy-smoke.example', 'totalMs': 100}
                encrypted = {**crypto['row'], 'totalMs': 100}
                baseline = plain if mode == 'unencrypted' else encrypted
                for value in [100, 100, 90]:
                    upload(account, generation, installation, [{**baseline, 'totalMs': value}])
                upload(account, generation, installation, [{**baseline, 'totalMs': 30, 'day': '2026-11-01'}])
                rows = call(account, '/v1/usage', query={'generation': generation})['contributions']
                assert len(rows) == 1 and rows[0]['totalMs'] == 130
                saved = query(f'ACCOUNT#{account}#{generation}')
                if mode != 'unencrypted':
                    assert 'privacy-smoke.example' not in json.dumps(saved)
                    assert all('hostname' not in item for item in saved)
                    assert fixture(accountId=account, installationId=installation, generation=generation, mode=mode,
                        secret=crypto['secret'], record=rows[0])['hostname'] == 'privacy-smoke.example'
                    upload(account, generation, installation, [plain], expected=400)
                    upload(account, generation, installation, [plain], schema=2, expected=400)
                    wrong = {**encrypted, 'encryptedHostname': {**encrypted['encryptedHostname'], 'keyId': str(uuid.uuid4())}}
                    upload(account, generation, installation, [wrong], expected=400)
                    second = fixture(accountId=account, installationId=other, generation=generation,
                        mode=mode, **({'secret': crypto['secret']} if mode == 'recovery' else {}))
                    assert (second['row']['domainId'] == crypto['row']['domainId']) == (mode == 'recovery')
                    upload(account, generation, other, [{**second['row'], 'totalMs': 20}])
                    checks.append(f'{mode}: opaque persisted rows, local decrypt, duplicate safety, key validation and separate installations')
                else:
                    checks.append('unencrypted: plaintext backup, duplicate safety and exact daily/lifetime summary')
                    migration = str(uuid.uuid4())
                    call(account, '/v1/privacy', 'PUT', {'generation': generation, 'privacyMode': 'migrating',
                        'targetMode': 'recovery', 'targetKeyId': crypto['keyId'], 'migrationId': migration, 'installationId': installation})
                    upload(account, generation, installation, [plain], expected=409)
                    call(account, '/v1/usage', 'DELETE', {'generation': generation, 'migrationId': migration, 'installationId': other}, expected=409)
                    deleted = call(account, '/v1/usage', 'DELETE', {'generation': generation, 'migrationId': migration, 'installationId': installation})
                    current = call(account)
                    assert current['privacyMode'] == 'recovery' and current['keyId'] == crypto['keyId']
                    assert call(account, '/v1/usage', 'DELETE', {'generation': generation, 'migrationId': migration, 'installationId': installation})['generation'] == deleted['generation']
                    new_crypto = fixture(accountId=account, installationId=installation, generation=deleted['generation'], mode='recovery', secret=crypto['secret'])
                    upload(account, deleted['generation'], installation, [{**new_crypto['row'], 'totalMs': 130}])
                    upload(account, generation, installation, [plain], expected=400)
                    checks.append('migration: write lock, owner check, atomic encrypted mode, idempotent generation and encrypted re-upload')
        finally:
            for account, generations in owned.items():
                for generation in generations:
                    for item in query(f'ACCOUNT#{account}#{generation}'):
                        deployment.aws('dynamodb', 'delete-item', '--table-name', table,
                            '--key', json.dumps({field: item[field] for field in ['pk', 'sk']}))
                    deployment.aws('dynamodb', 'delete-item', '--table-name', table,
                        '--key', json.dumps({'pk': {'S': 'CLEANUP'}, 'sk': {'S': f'{account}#{generation}'}}))
                deployment.aws('dynamodb', 'delete-item', '--table-name', table,
                    '--key', json.dumps({'pk': {'S': f'ACCOUNT#{account}'}, 'sk': {'S': 'PROFILE'}}))
    report = {'passed': len(checks), 'checks': checks, 'syntheticDataRemoved': True,
        'scope': f'{args.environment.title()} Lambda/DynamoDB; Google sign-in and API Gateway tested separately'}
    write_json(work / 'privacy-smoke-result.json', report)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
