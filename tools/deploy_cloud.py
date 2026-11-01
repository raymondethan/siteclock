"""Deploy isolated SiteClock development or production through the existing AWS CLI.

Uses ignored environment metadata and google-oauth.json under .test-build/deploy. Never
prints credentials, passes secret values in arguments, or modifies unrelated stacks. Production requires --environment prod.
Run `python3 tools/deploy_cloud.py preflight` before `... deploy`.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.test-build/deploy'


def write_json(path, value, private=False):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600 if private else 0o644)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    if private:
        os.chmod(path, 0o600)


class Deployment:
    def __init__(self, environment='dev'):
        self.environment = environment
        filename = 'production.json' if environment == 'prod' else 'development.json'
        self.settings = json.loads((WORK / filename).read_text())
        self.profile = self.settings['profile']
        self.region = self.settings['region']
        self.stack = self.settings['stackName']
        if environment not in ['dev', 'prod'] or self.stack != f'siteclock-{environment}' or self.region != 'us-east-2':
            raise SystemExit('This helper requires the matching siteclock-dev/prod stack in Ohio.')
        self.account = self.settings['awsAccountId']
        self.domain = self.settings['authDomainPrefix']
        self.bucket = f'{self.stack}-artifacts-{self.account}-{self.region}'

    def aws(self, *arguments, optional=False):
        command = ['aws', '--profile', self.profile, '--region', self.region,
                   '--no-cli-pager', '--output', 'json', *map(str, arguments)]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode:
            if optional:
                return None, result.stderr.strip()
            # Secret values are passed only through owner-only files. SDK/CLI errors
            # still receive redaction as a defense against unexpected diagnostics.
            reason = re.sub(r'GOCSPX-[A-Za-z0-9_-]+', '[REDACTED]', result.stderr)
            raise RuntimeError(f'{arguments[0]} {arguments[1]} failed: {reason.strip()}')
        value = json.loads(result.stdout) if result.stdout.strip() else {}
        return (value, None) if optional else value

    def existing_stack(self, name):
        response, error = self.aws('cloudformation', 'describe-stacks', '--stack-name', name, optional=True)
        if response is not None:
            return response['Stacks'][0]
        if 'does not exist' in error:
            return None
        raise RuntimeError(error)

    def preflight(self):
        identity = self.aws('sts', 'get-caller-identity')
        if identity['Account'] != self.account:
            raise RuntimeError('AWS account does not match the configured AWS account.')
        print(f'AWS account verified: {self.account}; region: {self.region}', flush=True)
        limits = self.aws('lambda', 'get-account-settings')
        available = limits['AccountLimit']['UnreservedConcurrentExecutions']
        if available < 111:
            raise RuntimeError(f'Lambda has only {available} unreserved executions. This template needs 11 reserved and 100 left unreserved.')
        print(f'Lambda unreserved concurrency available: {available}', flush=True)
        trails, error = self.aws('cloudtrail', 'describe-trails', '--include-shadow-trails', optional=True)
        logging = []
        for trail in (trails or {}).get('trailList', []):
            status, _ = self.aws('cloudtrail', 'get-trail-status', '--name', trail['TrailARN'], optional=True)
            if status and status.get('IsLogging'):
                logging.append(trail['Name'])
        print('CloudTrail logging trails: ' + (', '.join(logging) if logging else 'none verified; management event history only, reduced durable auditability'), flush=True)
        existing = self.existing_stack(self.stack)
        print(f'Target stack: {existing["StackStatus"] if existing else "not deployed"}', flush=True)
        if existing and existing['StackStatus'].endswith('_IN_PROGRESS'):
            raise RuntimeError('A stack operation is already running; inspect status before retrying.')
        domain = self.aws('cognito-idp', 'describe-user-pool-domain', '--domain', self.domain).get('DomainDescription', {})
        if domain.get('UserPoolId'):
            resource = self.aws('cloudformation', 'describe-stack-resource', '--stack-name', self.stack,
                                '--logical-resource-id', 'Users') if existing else {}
            if domain['UserPoolId'] != resource.get('StackResourceDetail', {}).get('PhysicalResourceId'):
                raise RuntimeError('The selected Cognito domain is already owned by another user pool.')
        values = {'Environment': self.environment, 'ExtensionId': self.settings['extensionId'],
                  'GoogleClientId': self.settings['googleClientId'], 'AuthDomainPrefix': self.domain,
                  'AlertEmail': self.settings['alertEmail']}
        template = json.loads((ROOT / 'backend/template.json').read_text())
        for name, value in values.items():
            pattern = template['Parameters'][name].get('AllowedPattern')
            if pattern and re.fullmatch(pattern, value) is None:
                raise RuntimeError(f'{name} does not satisfy the template constraint.')
        artifact = WORK / 'backend.zip'
        if hashlib.sha256(artifact.read_bytes()).hexdigest() != self.settings['artifactSha256']:
            raise RuntimeError('Deployment artifact digest changed; rebuild and review before deploying.')
        print('Domain, public parameters and backend artifact verified.', flush=True)

    def stack_events(self, name):
        response, error = self.aws('cloudformation', 'describe-events', '--stack-name', name, optional=True)
        if response:
            write_json(WORK / f'{name}-operation-events.json', response, private=True)
        if error:
            print('Operation validation events unavailable; deployment status will still be checked.', flush=True)

    def review_replacements(self, name, changes, change_set):
        replacements = [c for c in changes if c['action'] == 'Remove' or c['replacement'] in ['True', 'Conditional']]
        if not replacements:
            return
        # SAM can mark this permission as conditionally replaced when only the
        # referenced Lambda's code changes. Permit that case only after comparing
        # both processed templates; never generalize this to stateful resources.
        if any(c['action'] != 'Modify' or c['id'] != 'CleanupSchedulePermission' or
               c['type'] != 'AWS::Lambda::Permission' or c['replacement'] != 'Conditional' for c in replacements):
            raise RuntimeError('Change set includes deletion/replacement; explicit review is required before executing.')
        def processed(**values):
            arguments = ['cloudformation', 'get-template', '--stack-name', name, '--template-stage', 'Processed']
            if values.get('change_set'):
                arguments += ['--change-set-name', values['change_set']]
            body = self.aws(*arguments)['TemplateBody']
            return json.loads(body) if isinstance(body, str) else body
        before, after = processed(), processed(change_set=change_set)
        for change in replacements:
            resource = change['id']
            if before['Resources'][resource]['Properties'] != after['Resources'][resource]['Properties']:
                raise RuntimeError('Cleanup permission scope changes require explicit review before replacement.')
        print('Reviewed conditional cleanup permission: processed properties and access scope are identical.', flush=True)

    def apply(self, name, template_path, parameters=None, capabilities=None):
        existing = self.existing_stack(name)
        if existing and existing['StackStatus'] == 'ROLLBACK_COMPLETE':
            raise RuntimeError(f'{name} is ROLLBACK_COMPLETE. Inspect retained resources before recreating it.')
        request = {'StackName': name, 'ChangeSetName': f'siteclock-{time.time_ns()}',
                   'ChangeSetType': 'UPDATE' if existing else 'CREATE',
                   'TemplateBody': template_path.read_text(),
                   'Tags': [{'Key': 'Project', 'Value': self.stack}],
                   'Parameters': parameters or []}
        if capabilities:
            request['Capabilities'] = capabilities
        request_path = WORK / f'{name}-change-set.json'
        write_json(request_path, request, private=True)
        result = self.aws('cloudformation', 'create-change-set', '--cli-input-json', f'file://{request_path}')
        change_set = result['Id']
        print(f'{name}: created change set; validating before provisioning.', flush=True)
        for _ in range(120):
            detail = self.aws('cloudformation', 'describe-change-set', '--change-set-name', change_set)
            if detail['Status'] in ['CREATE_COMPLETE', 'FAILED']:
                break
            time.sleep(3)
        else:
            raise RuntimeError('Change-set validation timed out. Inspect before retrying.')
        self.stack_events(name)
        if detail['Status'] == 'FAILED':
            reason = detail.get('StatusReason', '')
            if "didn't contain changes" in reason or 'No updates are to be performed' in reason:
                print(f'{name}: no changes.', flush=True)
                return
            raise RuntimeError(f'Change set failed: {reason}')
        changes = [{'action': c['ResourceChange']['Action'],
                    'id': c['ResourceChange']['LogicalResourceId'],
                    'type': c['ResourceChange']['ResourceType'],
                    'replacement': c['ResourceChange'].get('Replacement')}
                   for c in detail.get('Changes', [])]
        write_json(WORK / f'{name}-changes.json', changes)
        print(f'{name}: reviewed {len(changes)} resource changes: ' + ', '.join(f'{c["action"]} {c["id"]}' for c in changes), flush=True)
        self.review_replacements(name, changes, change_set)
        self.aws('cloudformation', 'execute-change-set', '--change-set-name', change_set)
        print(f'{name}: executing deployment.', flush=True)
        previous = None
        for _ in range(400):
            stack = self.existing_stack(name)
            status = stack['StackStatus']
            if status != previous:
                print(f'{name}: {status}', flush=True)
                previous = status
            if status in ['CREATE_COMPLETE', 'UPDATE_COMPLETE']:
                return
            if not status.endswith('_IN_PROGRESS'):
                self.stack_events(name)
                events = self.aws('cloudformation', 'describe-stack-events', '--stack-name', name)
                failures = [{k: event.get(k) for k in ['LogicalResourceId', 'ResourceStatus', 'ResourceStatusReason']}
                            for event in events['StackEvents'] if event['ResourceStatus'].endswith('_FAILED')]
                write_json(WORK / f'{name}-failures.json', failures, private=True)
                raise RuntimeError(f'Deployment stopped at {status}: {json.dumps(failures)}')
            time.sleep(3)
        raise RuntimeError('Stack deployment timed out. Inspect status before retrying.')

    def bootstrap(self):
        template = {'AWSTemplateFormatVersion': '2010-09-09',
                    'Description': 'Private encrypted SiteClock development deployment artifacts; retained independently of application updates.',
                    'Metadata': {'AWSToolsMetrics': {'AWSAgentToolkit': 'aws-cloudformation@3'}},
                    'Resources': {
                        'Artifacts': {'Type': 'AWS::S3::Bucket', 'DeletionPolicy': 'Retain', 'UpdateReplacePolicy': 'Retain',
                                      'Metadata': {'com.aws.cloudformation.Context': {'why': 'Deploy immutable backend archives without installing SAM locally',
                                                   'must': ['Block public access and require HTTPS', 'Retain versioned artifacts for rollback']}},
                                      'Properties': {'BucketName': self.bucket,
                                                     'PublicAccessBlockConfiguration': {key: True for key in ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets']},
                                                     'OwnershipControls': {'Rules': [{'ObjectOwnership': 'BucketOwnerEnforced'}]},
                                                     'BucketEncryption': {'ServerSideEncryptionConfiguration': [{'ServerSideEncryptionByDefault': {'SSEAlgorithm': 'AES256'}}]},
                                                     'VersioningConfiguration': {'Status': 'Enabled'},
                                                     'LifecycleConfiguration': {'Rules': [{'Id': 'retire-old-versions', 'Status': 'Enabled',
                                                           'NoncurrentVersionExpiration': {'NoncurrentDays': 30},
                                                           'AbortIncompleteMultipartUpload': {'DaysAfterInitiation': 1}}]}}},
                        'ArtifactPolicy': {'Type': 'AWS::S3::BucketPolicy',
                                           'Metadata': {'com.aws.cloudformation.Context': {'why': 'Deny insecure transport for deployment artifacts', 'must': ['All artifact access requires TLS']}},
                                           'Properties': {'Bucket': {'Ref': 'Artifacts'}, 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
                                               {'Effect': 'Deny', 'Principal': '*', 'Action': 's3:*', 'Resource': [f'arn:aws:s3:::{self.bucket}', f'arn:aws:s3:::{self.bucket}/*'],
                                                'Condition': {'Bool': {'aws:SecureTransport': 'false'}}}]}}}}}
        path = WORK / 'artifacts-template.json'
        write_json(path, template)
        self.apply(self.stack + '-artifacts', path)
        key = f'backend/{self.settings["artifactSha256"]}.zip'
        self.aws('s3api', 'put-object', '--bucket', self.bucket, '--key', key,
                 '--body', WORK / 'backend.zip', '--server-side-encryption', 'AES256', '--expected-bucket-owner', self.account)
        print('Uploaded verified backend artifact to the private encrypted bucket.', flush=True)
        return key

    def secret(self):
        name = f'{self.stack}/google-oauth'
        existing, error = self.aws('secretsmanager', 'describe-secret', '--secret-id', name, optional=True)
        if existing is not None:
            if existing.get('DeletedDate'):
                raise RuntimeError('OAuth secret is scheduled for deletion; inspect before restoring.')
            print('Using the existing SiteClock development OAuth secret.', flush=True)
            return existing['ARN']
        if 'ResourceNotFoundException' not in error:
            raise RuntimeError(error)
        oauth = json.loads((WORK / 'google-oauth.json').read_text())['web']
        if oauth['client_id'] != self.settings['googleClientId']:
            raise RuntimeError('OAuth client ID does not match approved setup.')
        path = WORK / 'secret-value.json'
        write_json(path, {'client_secret': oauth['client_secret']}, private=True)
        response = self.aws('secretsmanager', 'create-secret', '--name', name,
                            '--description', 'SiteClock development Google OAuth client secret for Cognito only',
                            '--secret-string', f'file://{path}', '--tags', json.dumps([{'Key': 'Project', 'Value': self.stack}]))
        print('Stored Google OAuth secret in AWS Secrets Manager; value not printed.', flush=True)
        return response['ARN']

    def deploy(self):
        self.preflight()
        artifact_key = self.bootstrap()
        secret = self.secret()
        template = json.loads((ROOT / 'backend/template.json').read_text())
        for name in ['Handler', 'Cleanup']:
            template['Resources'][name]['Properties']['CodeUri'] = {'Bucket': self.bucket, 'Key': artifact_key}
        for extension_id in (self.settings.get('testExtensionIds', []) if self.environment == 'dev' else []):
            if re.fullmatch('[a-p]{32}', extension_id) is None:
                raise RuntimeError('Invalid isolated test extension ID.')
            callback = f'https://{extension_id}.chromiumapp.org/oauth2'
            if callback not in template['Resources']['App']['Properties']['CallbackURLs']:
                template['Resources']['App']['Properties']['CallbackURLs'].append(callback)
        if self.environment == 'dev' and self.settings.get('localhostTestCallback'):
            callback = self.settings['localhostTestCallback']
            if re.fullmatch(r'http://localhost:[0-9]{4,5}/oauth/callback', callback) is None:
                raise RuntimeError('Invalid temporary localhost test callback.')
            template['Resources']['App']['Properties']['CallbackURLs'].append(callback)
        path = WORK / 'application-template.json'
        write_json(path, template)
        values = {'Environment': self.environment, 'ExtensionId': self.settings['extensionId'],
                  'GoogleClientId': self.settings['googleClientId'], 'GoogleSecretArn': secret,
                  'AuthDomainPrefix': self.domain, 'AlertEmail': self.settings['alertEmail']}
        self.apply(self.stack, path, [{'ParameterKey': k, 'ParameterValue': v} for k, v in values.items()],
                   ['CAPABILITY_IAM', 'CAPABILITY_AUTO_EXPAND'])
        outputs = self.existing_stack(self.stack)['Outputs']
        write_json(WORK / 'outputs.json', outputs)
        print(f'{self.stack} deployed. Public outputs saved in {WORK / "outputs.json"}.', flush=True)
        if self.environment == 'dev':
            subprocess.run(['python3', str(ROOT / 'tools/configure_cloud.py'), str(WORK / 'outputs.json')], check=True, cwd=ROOT)
        else:
            print('Development extension configuration preserved. Use tools/prepare_release.py for the production package.', flush=True)


def main():
    global WORK
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['preflight', 'deploy', 'status', 'permissions', 'events', 'resources', 'recover-empty-create'])
    parser.add_argument('--environment', choices=['dev', 'prod'], default='dev')
    parser.add_argument('--check-region', choices=['us-east-1', 'us-east-2'], help='Read-only permission checks in another region')
    arguments = parser.parse_args()
    if arguments.environment == 'prod':
        WORK = WORK / 'production'
    deployment = Deployment(arguments.environment)
    try:
        if arguments.action == 'preflight':
            deployment.preflight()
        elif arguments.action == 'deploy':
            deployment.deploy()
        elif arguments.action == 'recover-empty-create':
            if deployment.environment != 'dev':
                raise RuntimeError('Empty-create recovery is development-only. Production recovery requires a separate review.')
            stack = deployment.existing_stack(deployment.stack)
            if not stack or stack['StackStatus'] != 'ROLLBACK_COMPLETE':
                raise RuntimeError('Recovery applies only to a failed initial development creation.')
            resources = deployment.aws('cloudformation', 'list-stack-resources', '--stack-name', deployment.stack)['StackResourceSummaries']
            retained = [r for r in resources if r['ResourceStatus'] == 'DELETE_SKIPPED' and r.get('PhysicalResourceId')]
            if any(r['LogicalResourceId'] not in ['Users', 'AlertKey', 'Data'] for r in retained):
                raise RuntimeError('Unexpected retained resources require separate review.')
            for resource in retained:
                if resource['LogicalResourceId'] == 'Users':
                    pool = resource['PhysicalResourceId']
                    users = deployment.aws('cognito-idp', 'list-users', '--user-pool-id', pool, '--limit', '1')
                    clients = deployment.aws('cognito-idp', 'list-user-pool-clients', '--user-pool-id', pool, '--max-results', '1')
                    if users.get('Users') or clients.get('UserPoolClients'):
                        raise RuntimeError('Retained user pool contains users or app clients; do not remove it.')
                elif resource['LogicalResourceId'] == 'Data':
                    contents = deployment.aws('dynamodb', 'scan', '--table-name', resource['PhysicalResourceId'], '--limit', '1', '--consistent-read')
                    if contents.get('Items'):
                        raise RuntimeError('Retained table contains application data; do not remove it.')
            write_json(WORK / 'failed-create-retained-resources.json', retained, private=True)
            deployment.aws('cloudformation', 'delete-stack', '--stack-name', deployment.stack)
            for _ in range(120):
                if deployment.existing_stack(deployment.stack) is None:
                    break
                time.sleep(3)
            else:
                raise RuntimeError('Failed stack metadata removal has not finished.')
            for resource in retained:
                if resource['LogicalResourceId'] == 'Users':
                    deployment.aws('cognito-idp', 'delete-user-pool', '--user-pool-id', resource['PhysicalResourceId'])
                    print('Removed verified-empty user pool from failed creation.', flush=True)
                elif resource['LogicalResourceId'] == 'Data':
                    deployment.aws('dynamodb', 'delete-table', '--table-name', resource['PhysicalResourceId'])
                    print('Removed verified-empty table from failed creation.', flush=True)
                else:
                    deployment.aws('kms', 'schedule-key-deletion', '--key-id', resource['PhysicalResourceId'], '--pending-window-in-days', '7')
                    print('Scheduled unused failed-create alert key for reversible seven-day deletion.', flush=True)
            print('Empty failed initial creation recovered; artifact stack and OAuth secret retained.', flush=True)
        elif arguments.action == 'resources':
            resources = deployment.aws('cloudformation', 'list-stack-resources', '--stack-name', deployment.stack)
            for resource in resources['StackResourceSummaries']:
                print(json.dumps({key: resource.get(key) for key in ['LogicalResourceId', 'PhysicalResourceId', 'ResourceType', 'ResourceStatus']}), flush=True)
        elif arguments.action == 'events':
            events = deployment.aws('cloudformation', 'describe-stack-events', '--stack-name', deployment.stack)
            for event in events['StackEvents']:
                if event['ResourceStatus'].endswith('_FAILED'):
                    print(json.dumps({key: event.get(key) for key in ['LogicalResourceId', 'ResourceStatus', 'ResourceStatusReason']}), flush=True)
        elif arguments.action == 'permissions':
            if arguments.check_region:
                deployment.region = arguments.check_region
            print('Checking service access in ' + deployment.region, flush=True)
            checks = [
                ('cloudformation', 'list-stacks', '--max-items', '1'),
                ('lambda', 'list-functions', '--max-items', '1'),
                ('dynamodb', 'list-tables', '--limit', '1'),
                ('secretsmanager', 'list-secrets', '--max-results', '1'),
                ('cloudtrail', 'describe-trails', '--include-shadow-trails'),
                ('cognito-idp', 'list-user-pools', '--max-results', '1'),
            ]
            for check in checks:
                result, error = deployment.aws(*check, optional=True)
                print(f'{check[0]} {check[1]}: ' + ('allowed' if result is not None else error), flush=True)
        else:
            for name in [deployment.stack + '-artifacts', deployment.stack]:
                stack = deployment.existing_stack(name)
                print(name, stack['StackStatus'] if stack else 'not deployed')
    except RuntimeError as error:
        raise SystemExit(str(error))


if __name__ == '__main__':
    main()
