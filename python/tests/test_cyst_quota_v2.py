"""Explicit quota negotiation uses real bounded HTTP and keeps the default512 profile."""
from __future__ import annotations

import copy
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'src'))
from telomere_sdk import ApiTransport, TelomereClient
from telomere_sdk.cysts import CAPABILITIES, QUOTA_POLICY_V2, _capabilities
from test_cysts import CHECKPOINT_ID, ENVELOPE, OWNER, metadata
from test_sdk import FixtureServer

CAPABILITIES_V2 = {**CAPABILITIES, 'maxOwnerCheckpoints': 4096, 'quotaPolicy': QUOTA_POLICY_V2}


class CystQuotaV2Tests(unittest.TestCase):
    def setUp(self):
        self.server = FixtureServer()
        self.responses = {'/api/me': {'address': OWNER, 'demo': True},
                          '/api/cysts/capabilities': copy.deepcopy(CAPABILITIES_V2),
                          '/api/cysts': {'checkpoints': [metadata()], 'usage': {'bytes': metadata()['ciphertextBytes'], 'checkpoints': 960},
                                         'capabilities': copy.deepcopy(CAPABILITIES_V2)},
                          '/api/cysts/' + CHECKPOINT_ID: metadata(),
                          '/api/cysts/' + CHECKPOINT_ID + '/blob': {'metadata': metadata(), 'ciphertext': ENVELOPE['ciphertext']}}
        self.server.response = lambda path: (200, {}, json.dumps(self.responses[path]).encode())
        self.transport = ApiTransport(self.server.origin)

    def tearDown(self):
        self.server.close()

    def test_explicit_v2_real_http_header_and_usage_over512_are_scoped_to_cysts(self):
        client = TelomereClient(self.server.origin, transport=self.transport, cyst_quota_version=2)
        self.assertEqual(client.cysts.capabilities(), CAPABILITIES_V2)
        self.assertEqual(client.cysts.list()['usage']['checkpoints'], 960)
        self.assertEqual(client.cysts.metadata(CHECKPOINT_ID)['id'], CHECKPOINT_ID)
        self.assertEqual(client.cysts.download(CHECKPOINT_ID), ENVELOPE)
        self.responses['/api/cysts'] = {'checkpoint': metadata(), 'replayed': False}
        self.assertFalse(client.cysts.upload(ENVELOPE, idempotency_key='original-v2-cyst')['replayed'])
        for path, _, headers, _ in self.server.requests:
            normalized = {key.lower(): value for key, value in headers.items()}
            self.assertEqual(normalized.get('x-telomere-cyst-quota'), '2' if path.startswith('/api/cysts') else None)

    def test_legacy_default_does_not_opt_in_or_accept_a_silent_quota_change(self):
        client = TelomereClient(self.server.origin, transport=self.transport)
        with self.assertRaises(ValueError):
            client.cysts.capabilities()
        self.responses['/api/cysts/capabilities'] = CAPABILITIES
        self.assertEqual(client.cysts.capabilities(), CAPABILITIES)
        self.assertTrue(all('x-telomere-cyst-quota' not in {key.lower() for key in headers} for _, _, headers, _ in self.server.requests))

    def test_explicit_quota_cannot_downgrade_or_raise_the_fixed_byte_count_caps(self):
        client = TelomereClient(self.server.origin, transport=self.transport, cyst_quota_version=2)
        self.responses['/api/cysts/capabilities'] = CAPABILITIES
        with self.assertRaises(ValueError):
            client.cysts.capabilities()
        for field, invalid in [('version', 2.0), ('maxOwnerCheckpoints', 4096.0), ('maxOwnerBytes', 67108864)]:
            changed = copy.deepcopy(CAPABILITIES_V2); changed['quotaPolicy'][field] = invalid
            with self.subTest(field=field), self.assertRaises(ValueError):
                _capabilities(changed, 2)
        self.responses['/api/cysts']['usage']['checkpoints'] = 4097
        with self.assertRaises(ValueError):
            client.cysts.list()

    def test_invalid_or_non_cyst_transport_profile_is_rejected_before_any_http(self):
        for invalid in (True, False, 1, 2.0, '2', 3):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                TelomereClient(self.server.origin, transport=self.transport, cyst_quota_version=invalid)
            with self.assertRaises(ValueError):
                self.transport.request('/api/cysts', cyst_quota_version=invalid)
        for path in ('/api/me', '/api/cyst-registry/capabilities', '/api/cysts-evil', '/api/platform/config'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.transport.request(path, cyst_quota_version=2)
        self.assertEqual(self.server.requests, [])


if __name__ == '__main__':
    unittest.main()
