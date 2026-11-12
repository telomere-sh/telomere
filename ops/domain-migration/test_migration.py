import hashlib
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import domain_health
import migrate


class MigrationTests(unittest.TestCase):
    def test_origin_change_preserves_financial_and_release_bindings(self):
        profile = b'MODE=mainnet\nPUBLIC_ORIGIN=https://telomere.sh\nCHAIN_ID=8453\nSENTINEL=preserved\n'
        digest = hashlib.sha256(profile).hexdigest()
        expected = {'publicOrigin': 'https://telomere.sh', 'profileSha256': digest,
                    'releaseId': 'a' * 40, 'runtimePins': [{'path': 'dist/example', 'sha256': 'b' * 64}], 'token': 'unchanged'}
        activation = {'profileSha256': digest, 'deploymentTransactionHash': '0x' + 'c' * 64}
        updated, result, activated = migrate.origin_profile(profile, expected, activation)
        self.assertEqual(updated, profile.replace(b'https://telomere.sh', b'https://my-telomere.com'))
        self.assertEqual(result['profileSha256'], hashlib.sha256(updated).hexdigest())
        self.assertEqual(result['profileSha256'], activated['profileSha256'])
        self.assertEqual({k: v for k, v in result.items() if k not in ['profileSha256', 'publicOrigin']},
                         {k: v for k, v in expected.items() if k not in ['profileSha256', 'publicOrigin']})
        self.assertEqual(activated['deploymentTransactionHash'], activation['deploymentTransactionHash'])
        self.assertEqual(expected['publicOrigin'], 'https://telomere.sh')

    def test_profile_mismatch_and_duplicate_are_rejected(self):
        for profile in [b'PUBLIC_ORIGIN=https://attacker.invalid\n', b'PUBLIC_ORIGIN=https://telomere.sh\n' * 2]:
            digest = hashlib.sha256(profile).hexdigest()
            with self.assertRaises(AssertionError):
                migrate.origin_profile(profile, {'publicOrigin': 'https://telomere.sh', 'profileSha256': digest}, {'profileSha256': digest})
        with self.assertRaises(AssertionError):
            migrate.origin_profile(b'PUBLIC_ORIGIN=https://telomere.sh\n', {'publicOrigin': 'https://telomere.sh', 'profileSha256': 'bad'}, {'profileSha256': 'bad'})

    def test_nginx_preserves_proxies_root_csp_and_compression(self):
        original = ('server_name telomere.sh;\nssl_certificate /etc/letsencrypt/live/review.telomere.sh/fullchain.pem;\n'
                    'ssl_certificate_key /etc/letsencrypt/live/review.telomere.sh/privkey.pem;\n'
                    'root /var/www/reviewed;\ninclude csp;\ninclude gzip;\nproxy_set_header Host $host;\n')
        result = migrate.https_server(original)
        for line in ['root /var/www/reviewed;', 'include csp;', 'include gzip;', 'proxy_set_header Host $host;']:
            self.assertIn(line, result)
        self.assertNotIn('review.telomere.sh', result)
        self.assertIn('server_name www.my-telomere.com;', result)
        self.assertIn('return 308 https://my-telomere.com$request_uri;', result)
        final = result + migrate.legacy_redirect()
        self.assertEqual(len(re.findall(r'^root /var/www/reviewed;', final, re.M)), 1)
        self.assertEqual(migrate.DOMAIN_HOME, migrate.BASE / 'operator/domain-migration')
        with self.assertRaises(AssertionError):
            migrate.https_server('unexpected config')

    def test_legacy_unsafe_methods_cannot_forward_payments(self):
        value = migrate.legacy_redirect()
        self.assertIn('if ($request_method !~ ^(GET|HEAD)$) { return 409; }', value)
        self.assertIn('https://my-telomere.com$request_uri', value)
        self.assertNotIn('proxy_pass', value)
        self.assertIn('/.well-known/acme-challenge/', migrate.http_server())

    def test_new_domain_failure_is_alerted(self):
        with patch.object(domain_health.socket, 'create_connection', side_effect=OSError):
            result = domain_health.observe()
        self.assertEqual(result['status'], 'attention')
        self.assertEqual(result['alerts'], ['PRIMARY_DOMAIN_UNAVAILABLE'])

    def test_new_https_waits_for_nginx_reload(self):
        version = {'sourceCommit': 'a' * 40}
        with patch.object(migrate, 'json_get', side_effect=[OSError('reload pending'), {'status': 'ready'}, version]), patch.object(migrate.time, 'sleep') as sleep:
            migrate.https_ready(version)
        sleep.assert_called_once_with(1)

    def test_new_https_failure_never_proceeds_to_redirect(self):
        with patch.object(migrate, 'json_get', side_effect=OSError('wrong certificate')), patch.object(migrate.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'did not become ready'):
                migrate.https_ready({'sourceCommit': 'a' * 40})

    def test_domain_failure_preserves_existing_financial_alerts(self):
        with tempfile.TemporaryDirectory() as folder:
            private = Path(folder)
            existing = {'alerts': ['FINANCIAL_EXISTING'], 'status': 'attention', 'invalidFinancialRows': 3}
            (private / 'cpu-monitor-status.json').write_text(json.dumps(existing))
            failure = {'origin': domain_health.ORIGIN, 'status': 'attention', 'alerts': ['PRIMARY_DOMAIN_UNAVAILABLE']}
            with patch.object(domain_health, 'PRIVATE', private), patch.object(domain_health, 'observe', return_value=failure):
                self.assertEqual(domain_health.main(), 2)
            observed = json.loads((private / 'cpu-monitor-status.json').read_text())
            self.assertEqual(observed['invalidFinancialRows'], 3)
            self.assertEqual(observed['alerts'], ['FINANCIAL_EXISTING', 'PRIMARY_DOMAIN_UNAVAILABLE'])

    def test_healthy_domain_does_not_clear_financial_alerts(self):
        with tempfile.TemporaryDirectory() as folder:
            private = Path(folder)
            original = b'{"alerts":["EXISTING"],"status":"attention"}'
            (private / 'cpu-monitor-status.json').write_bytes(original)
            with patch.object(domain_health, 'PRIVATE', private), patch.object(domain_health, 'observe', return_value={'status': 'ok', 'alerts': []}):
                self.assertEqual(domain_health.main(), 0)
            self.assertEqual((private / 'cpu-monitor-status.json').read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
