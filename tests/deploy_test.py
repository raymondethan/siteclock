"""Regression checks for deployment wiring that CloudFormation lint cannot catch."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('deploy_cloud', ROOT / 'tools/deploy_cloud.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def deployment():
    instance = module.Deployment.__new__(module.Deployment)
    instance.profile = 'test-profile'
    instance.region = 'us-east-2'
    instance.stack = 'siteclock-dev'
    return instance


class DeploymentChecks(unittest.TestCase):
    def test_optional_cli_calls_return_a_consistent_success_or_error_pair(self):
        instance = deployment()
        for result, expected in [
            (subprocess.CompletedProcess([], 0, '{"Stacks": []}', ''), ({'Stacks': []}, None)),
            (subprocess.CompletedProcess([], 1, '', 'AccessDenied'), (None, 'AccessDenied')),
        ]:
            with patch.object(module.subprocess, 'run', return_value=result):
                self.assertEqual(instance.aws('cloudformation', 'describe-stacks', optional=True), expected)

    def test_missing_stack_is_distinct_from_permission_failure(self):
        instance = deployment()
        with patch.object(instance, 'aws', return_value=(None, 'Stack does not exist')):
            self.assertIsNone(instance.existing_stack('siteclock-dev'))
        with patch.object(instance, 'aws', return_value=(None, 'AccessDenied')):
            with self.assertRaisesRegex(RuntimeError, 'AccessDenied'):
                instance.existing_stack('siteclock-dev')

    def test_sensitive_failure_messages_are_redacted(self):
        instance = deployment()
        fake_secret = 'GOCSPX-' + 'placeholder-not-a-real-secret'
        result = subprocess.CompletedProcess([], 1, '', 'Rejected ' + fake_secret)
        with patch.object(module.subprocess, 'run', return_value=result):
            with self.assertRaises(RuntimeError) as captured:
                instance.aws('secretsmanager', 'create-secret')
        self.assertNotIn(fake_secret, str(captured.exception))

    def test_replacements_are_not_executed_without_review(self):
        instance = deployment()
        calls = []
        def aws(*arguments, **options):
            calls.append(arguments)
            if arguments[1] == 'create-change-set':
                return {'Id': 'change-set'}
            if arguments[1] == 'describe-change-set':
                return {'Status': 'CREATE_COMPLETE', 'Changes': [{'ResourceChange': {
                    'Action': 'Modify', 'LogicalResourceId': 'Data',
                    'ResourceType': 'AWS::DynamoDB::Table', 'Replacement': 'True'}}]}
            raise AssertionError('Unexpected AWS call')
        with tempfile.TemporaryDirectory() as directory:
            template = Path(directory) / 'template.json'
            template.write_text('{}')
            with patch.object(module, 'WORK', Path(directory)), patch.object(instance, 'existing_stack', return_value={'StackStatus': 'UPDATE_COMPLETE'}), patch.object(instance, 'stack_events'), patch.object(instance, 'aws', side_effect=aws):
                with self.assertRaisesRegex(RuntimeError, 'deletion/replacement'):
                    instance.apply('siteclock-dev', template)
        self.assertFalse(any(call[1] == 'execute-change-set' for call in calls))

    def test_only_identical_conditional_cleanup_permissions_can_be_replaced(self):
        instance = deployment()
        change = {'id': 'CleanupSchedulePermission', 'type': 'AWS::Lambda::Permission',
                  'action': 'Modify', 'replacement': 'Conditional'}
        properties = {'Principal': 'events.amazonaws.com', 'SourceArn': {'Fn::GetAtt': ['CleanupSchedule', 'Arn']}}
        def template(props):
            return {'TemplateBody': {'Resources': {'CleanupSchedulePermission': {'Properties': props}}}}
        with patch.object(instance, 'aws', side_effect=[template(properties), template(properties)]):
            instance.review_replacements('siteclock-dev', [change], 'change-set')
        with patch.object(instance, 'aws', side_effect=[template(properties), template({**properties, 'Principal': '*'})]):
            with self.assertRaisesRegex(RuntimeError, 'scope changes'):
                instance.review_replacements('siteclock-dev', [change], 'change-set')
        with self.assertRaisesRegex(RuntimeError, 'deletion/replacement'):
            instance.review_replacements('siteclock-dev', [{**change, 'id': 'Data', 'type': 'AWS::DynamoDB::Table'}], 'change-set')

    def test_dev_does_not_send_a_recovery_period_when_pitr_is_disabled(self):
        template = json.loads((ROOT / 'backend/template.json').read_text())
        settings = template['Resources']['Data']['Properties']['PointInTimeRecoverySpecification']
        def resolve(value, production):
            if isinstance(value, dict) and 'Fn::If' in value:
                _, yes, no = value['Fn::If']
                return resolve(yes if production else no, production)
            if value == {'Ref': 'AWS::NoValue'}:
                return None
            return value
        dev = {key: resolve(value, False) for key, value in settings.items()}
        production = {key: resolve(value, True) for key, value in settings.items()}
        self.assertFalse(dev['PointInTimeRecoveryEnabled'])
        self.assertIsNone(dev.get('RecoveryPeriodInDays'))
        self.assertTrue(production['PointInTimeRecoveryEnabled'])
        self.assertEqual(production['RecoveryPeriodInDays'], 7)

    def test_api_gateway_does_not_receive_unsupported_extension_cors_origins(self):
        template = json.loads((ROOT / 'backend/template.json').read_text())
        cors = template['Resources']['Api']['Properties'].get('CorsConfiguration', {})
        self.assertFalse(any('chrome-extension://' in json.dumps(origin) for origin in cors.get('AllowOrigins', [])))


if __name__ == '__main__':
    unittest.main()
