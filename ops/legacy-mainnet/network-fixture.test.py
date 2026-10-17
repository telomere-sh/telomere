"""Pure synthetic fixture tests; no ip command, privilege check or host network mutation."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('owned_network_guard', Path(__file__).with_name('prepare-network.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

OWN = {'ifname': 'tlmr-mainnet0', 'ifindex': 500, 'ifalias': guard.ALIAS, 'mtu': 1500,
       'flags': ['BROADCAST', 'MULTICAST', 'UP'], 'linkinfo': {'info_kind': 'bridge'},
       'addr_info': [{'family': 'inet', 'local': '172.31.254.1', 'prefixlen': 24, 'scope': 'global'}]}
LEGACY = {'ifname': 'docker0', 'ifindex': 3136, 'mtu': 1500, 'address': '12:55:08:e6:d9:95',
          'flags': ['UP'], 'addr_info': [{'family': 'inet', 'local': '172.17.0.1', 'prefixlen': 16, 'scope': 'global'}]}


class Fixtures(unittest.TestCase):
    def test_exact_ownership(self):
        guard.validate_ownership(copy.deepcopy(guard.OWNERSHIP))

    def test_ownership_rejects_substitution(self):
        for key in guard.OWNERSHIP:
            with self.subTest(key=key), self.assertRaises(ValueError):
                changed = copy.deepcopy(guard.OWNERSHIP)
                changed[key] = 'wrong'
                guard.validate_ownership(changed)

    def test_exact_owned_bridge(self):
        guard.validate_bridge(copy.deepcopy(OWN))

    def test_bridge_refuses_renamed_unowned_nonbridge_down_wrong_mtu_or_enslaved(self):
        for key, value in [('ifname', 'docker0'), ('ifalias', ''), ('linkinfo', {'info_kind': 'veth'}),
                           ('flags', []), ('mtu', 9000), ('master', 'docker0'), ('addr_info', [])]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                guard.validate_bridge({**copy.deepcopy(OWN), key: value})

    def test_additional_ipv4_and_global_ipv6_refused(self):
        for address in [{'family': 'inet', 'local': '10.0.0.1', 'prefixlen': 24, 'scope': 'global'},
                        {'family': 'inet6', 'local': '2001:db8::1', 'prefixlen': 64, 'scope': 'global'}]:
            with self.subTest(address=address), self.assertRaises(ValueError):
                changed = copy.deepcopy(OWN)
                changed['addr_info'].append(address)
                guard.validate_bridge(changed)

    def test_snapshot_excludes_only_owned_bridge(self):
        self.assertEqual(guard.network_snapshot([LEGACY]), guard.network_snapshot([LEGACY, OWN]))

    def test_snapshot_requires_existing_legacy_bridge(self):
        with self.assertRaises(ValueError):
            guard.network_snapshot([OWN])

    def test_snapshot_records_legacy_address_mac_index_mtu_and_flags(self):
        original = guard.network_snapshot([LEGACY])
        for key, value in [('ifindex', 3137), ('mtu', 9000), ('address', '00:11:22:33:44:55'),
                           ('flags', []), ('master', 'unexpected')]:
            with self.subTest(key=key):
                self.assertNotEqual(original, guard.network_snapshot([{**LEGACY, key: value}]))


if __name__ == '__main__':
    unittest.main()
