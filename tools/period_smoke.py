"""Exercise deployed daily accounting through IAM-authenticated Lambda invocation.

Uses a freshly generated synthetic account and deletes only its own test records.
Does not sign in as a user, read real browsing history, or bypass API Gateway
for normal extension traffic. Run after deploy_cloud.py deploy in development.
"""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import uuid
from deploy_cloud import Deployment, WORK, write_json


def main():
    deployment = Deployment()
    outputs = {row['OutputKey']: row['OutputValue'] for row in json.loads((WORK / 'outputs.json').read_text())}
    table = outputs['TableName']
    account = str(uuid.uuid4())
    installation = str(uuid.uuid4())
    other_installation = str(uuid.uuid4())
    account_pk = f'ACCOUNT#{account}'
    generation = None
    generations = set()
    checks = []
    profile_key = {'pk': {'S': account_pk}, 'sk': {'S': 'PROFILE'}}
    assert not deployment.aws('dynamodb', 'get-item', '--table-name', table, '--key', json.dumps(profile_key)).get('Item')
    with tempfile.TemporaryDirectory(prefix='siteclock-periods-', dir=WORK) as temp:
        directory = Path(temp)

        def invoke(method, body=None, query=None, expected=200):
            marker = str(uuid.uuid4())
            event = {'rawPath': '/v1/usage', 'requestContext': {'http': {'method': method},
                     'authorizer': {'jwt': {'claims': {'sub': account, 'token_use': 'access'}}}},
                     'queryStringParameters': query}
            if method == 'ACCOUNT':
                event['rawPath'] = '/v1/account'
                event['requestContext']['http']['method'] = 'GET'
            if body is not None:
                event['body'] = json.dumps(body)
            payload = directory / f'{marker}-request.json'
            result_path = directory / f'{marker}-response.json'
            write_json(payload, event, private=True)
            result = deployment.aws('lambda', 'invoke', '--function-name', 'siteclock-dev-api',
                                    '--payload', f'fileb://{payload}', result_path)
            assert not result.get('FunctionError'), result
            response = json.loads(result_path.read_text())
            data = json.loads(response['body'])
            assert response['statusCode'] == expected, (response['statusCode'], data)
            return data

        def upload(rows, device=installation, schema=2, expected=200):
            return invoke('PUT', {'generation': generation, 'installationId': device,
                                 **({'schemaVersion': schema} if schema == 2 else {}), 'counters': rows}, expected=expected)

        def row(ms, day=None):
            return {'hostname': 'period-smoke.example', 'totalMs': ms, **({'day': day} if day else {})}

        def read(query=None):
            rows = []
            cursor = None
            while True:
                page = invoke('GET', query={'generation': generation, **(query or {}), **({'cursor': cursor} if cursor else {})})
                rows.extend(page['contributions'])
                cursor = page['cursor']
                if not cursor:
                    return rows

        try:
            generation = invoke('ACCOUNT')['generation']
            generations.add(generation)
            assert read() == []
            upload([row(100000)], schema=1)
            upload([row(100000)])
            checks.append('legacy lifetime baseline preserved')
            for value in [20000, 20000, 10000]:
                upload([row(value, '2026-11-01')])
            assert sum(r['totalMs'] for r in read()) == 120000
            checks.append('duplicate and older daily uploads do not double count')
            with ThreadPoolExecutor(max_workers=3) as pool:
                list(pool.map(lambda value: upload([row(value, '2026-11-01')]), [40000, 30000, 35000]))
            upload([row(10000, '2026-10-31'), row(5000, '2026-10-20')])
            upload([row(7000, '2026-11-01')], device=other_installation)
            assert sum(r['totalMs'] for r in read()) == 162000
            checks.append('concurrent and cross-installation lifetime totals are exact')
            today = read({'from': '2026-11-01', 'to': '2026-11-01'})
            week = read({'from': '2026-10-26', 'to': '2026-11-01'})
            assert sum(r['totalMs'] for r in today) == 47000
            assert sum(r['totalMs'] for r in week) == 57000
            checks.append('today and seven-day queries include exactly the requested dates')
            # Directly verify the persisted summary invariant for each installation.
            result = deployment.aws('dynamodb', 'query', '--table-name', table,
                '--key-condition-expression', 'pk = :pk', '--expression-attribute-values',
                json.dumps({':pk': {'S': f'{account_pk}#{generation}'}}), '--consistent-read')
            for device in [installation, other_installation]:
                items = [item for item in result['Items'] if item.get('installationId', {}).get('S') == device]
                summary = next(item for item in items if item['sk']['S'].startswith('USAGE#'))
                daily_sum = sum(int(item['totalMs']['N']) for item in items if item['sk']['S'].startswith('DAY#'))
                assert int(summary['dailyMs']['N']) == daily_sum
                assert int(summary['totalMs']['N']) == int(summary['baselineMs']['N']) + daily_sum
            checks.append('persisted lifetime equals baseline plus daily records')
            upload([row(999999)], schema=1, expected=426)
            assert sum(r['totalMs'] for r in read()) == 162000
            checks.append('legacy uploads cannot overwrite migrated summaries')
            upload([row(1, '2026-02-30')], expected=400)
            checks.append('invalid calendar dates rejected')
            # Registration is enforced by uploads as well as the explicit route.
            for _ in range(3):
                invoke('PUT', {'generation': generation, 'installationId': str(uuid.uuid4()),
                    'schemaVersion': 2, 'counters': [row(0)]})
            upload([row(1)], device=str(uuid.uuid4()), expected=429)
            checks.append('installation quota enforced even without explicit registration')
            saved_profile = deployment.aws('dynamodb', 'get-item', '--table-name', table,
                '--key', json.dumps(profile_key), '--consistent-read')['Item']
            actual_rows = int(saved_profile['usageRows']['N'])
            deployment.aws('dynamodb', 'update-item', '--table-name', table, '--key', json.dumps(profile_key),
                '--update-expression', 'SET usageRows = :n', '--expression-attribute-values', json.dumps({':n': {'N': '999999'}}))
            upload([{'hostname': 'quota-smoke.example', 'day': '2026-11-01', 'totalMs': 1}], expected=429)
            assert sum(r['totalMs'] for r in read()) == 162000
            deployment.aws('dynamodb', 'update-item', '--table-name', table, '--key', json.dumps(profile_key),
                '--update-expression', 'SET usageRows = :n', '--expression-attribute-values', json.dumps({':n': {'N': str(actual_rows)}}))
            checks.append('storage quota rejects the entire daily-summary transaction')
            old = generation
            generation = invoke('DELETE', {'generation': old})['generation']
            generations.add(generation)
            assert invoke('DELETE', {'generation': old})['generation'] == generation
            invoke('PUT', {'generation': old, 'installationId': installation, 'schemaVersion': 2,
                           'counters': [row(50000, '2026-11-01')]}, expected=409)
            assert read() == []
            checks.append('deletion retries and stale generations remain safe')
        finally:
            # All keys are derived from the random test account generated above.
            # No scans, real accounts, or global cleanup operations are used.
            for retired in generations:
                partition = f'{account_pk}#{retired}'
                result = deployment.aws('dynamodb', 'query', '--table-name', table,
                    '--key-condition-expression', 'pk = :pk', '--expression-attribute-values',
                    json.dumps({':pk': {'S': partition}}), '--consistent-read')
                for item in result.get('Items', []):
                    key = {field: item[field] for field in ['pk', 'sk']}
                    deployment.aws('dynamodb', 'delete-item', '--table-name', table, '--key', json.dumps(key))
                deployment.aws('dynamodb', 'delete-item', '--table-name', table,
                    '--key', json.dumps({'pk': {'S': 'CLEANUP'}, 'sk': {'S': f'{account}#{retired}'}}))
            deployment.aws('dynamodb', 'delete-item', '--table-name', table, '--key', json.dumps(profile_key))
    report = {'passed': len(checks), 'checks': checks, 'syntheticDataRemoved': True, 'region': deployment.region,
              'scope': 'Deployed Lambda and DynamoDB; API Gateway authorization verified separately in extension'}
    write_json(WORK / 'period-smoke-result.json', report)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
