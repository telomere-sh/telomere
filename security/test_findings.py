"""Negative tests for the finding gate, with a disposable source tree."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('finding_gate', Path(__file__).with_name('check-findings.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class FindingGateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.previous = gate.ROOT
        gate.ROOT = Path(self.directory.name)
        self.addCleanup(setattr, gate, 'ROOT', self.previous)
        (gate.ROOT / 'contracts').mkdir()
        (gate.ROOT / 'contracts/Example.sol').write_text('contract Example {}', encoding='utf-8')
        (gate.ROOT / 'security/baselines').mkdir(parents=True)
        self.report = {'success': True, 'results': {'detectors': [{
            'check': 'example', 'impact': 'High', 'description': 'Example finding',
            'elements': [{'source_mapping': {'filename_relative': 'contracts/Example.sol'}}]}]}}
        row = next(iter(gate.slither_rows(self.report).values()))
        self.baseline = {'schemaVersion': 1, 'tool': 'slither', 'findings': [{
            **row, 'classification': 'accepted_design_risk', 'rationale': 'Explicit fixture review.'}]}
        self.save()

    def save(self):
        (gate.ROOT / 'security/baselines/slither.json').write_text(json.dumps(self.baseline), encoding='utf-8')

    def test_exact_review_retains_high_severity(self):
        result = gate.review('slither', self.report)
        self.assertTrue(result['passed'])
        self.assertEqual(self.baseline['findings'][0]['severity'], 'High')

    def test_new_finding_blocks(self):
        report = copy.deepcopy(self.report)
        report['results']['detectors'][0]['description'] += ' changed'
        self.assertFalse(gate.review('slither', report)['passed'])

    def test_source_change_blocks(self):
        (gate.ROOT / 'contracts/Example.sol').write_text('contract Example { uint x; }', encoding='utf-8')
        self.assertFalse(gate.review('slither', self.report)['passed'])

    def test_stale_review_blocks(self):
        self.assertFalse(gate.review('slither', {'success': True, 'results': {'detectors': []}})['passed'])

    def test_missing_rationale_blocks(self):
        self.baseline['findings'][0]['rationale'] = ''
        self.save()
        self.assertFalse(gate.review('slither', self.report)['passed'])

    def test_scanner_error_blocks(self):
        with self.assertRaises(ValueError):
            gate.slither_rows({'success': False})

    def test_traversal_blocks(self):
        self.report['results']['detectors'][0]['elements'][0]['source_mapping']['filename_relative'] = 'contracts/../../other.sol'
        with self.assertRaises(ValueError):
            gate.slither_rows(self.report)

    def test_unredacted_secret_blocks_before_git_access(self):
        with self.assertRaisesRegex(ValueError, 'fully redacted'):
            gate.gitleaks_rows([{'Secret': 'fixture-not-redacted'}])


if __name__ == '__main__':
    unittest.main()
