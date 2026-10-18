"""Exact, source-bound finding review. No path/rule exclusions or severity downgrades."""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def project_path(value):
    normalized = value.replace('\\', '/')
    prefix = ROOT.as_posix().rstrip('/') + '/'
    if normalized.startswith(prefix):
        normalized = normalized[len(prefix):]
    return normalized


def reviewed_inputs(tool):
    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
    result = {
        'toolsManifestSha256': digest(canonical(json.loads((ROOT / 'security/tools.json').read_text(encoding='utf-8')))),
        'scannerScriptSha256': digest((ROOT / 'security/run-scans.py').read_bytes().replace(b'\r\n', b'\n')),
    }
    if tool == 'slither':
        lock = json.loads((ROOT / 'package-lock.json').read_text(encoding='utf-8'))
        result['openzeppelinLockEntrySha256'] = digest(canonical(lock['packages']['node_modules/@openzeppelin/contracts']))
        result['scannerEnvironmentSha256'] = digest((ROOT / 'security/requirements-tools.lock').read_bytes().replace(b'\r\n', b'\n'))
    return result


def slither_rows(report):
    if report.get('success') is not True:
        raise ValueError('Slither did not successfully analyze the contracts')
    result = {}
    for finding in report['results']['detectors']:
        files = sorted({project_path(e['source_mapping'].get('filename_relative', ''))
                        for e in finding['elements'] if 'source_mapping' in e})
        files = [name for name in files if name.startswith('contracts/')]
        if not files:
            continue
        if any(not re.fullmatch(r'contracts/[A-Za-z][A-Za-z0-9_]*\.sol', name) for name in files):
            raise ValueError('Unexpected project source path')
        description = finding['description'].replace('\\', '/').replace(ROOT.as_posix() + '/', '')
        # Slither iterates sets when emitting call/event diagnostic lines. Keep
        # every line and its raw report, but stabilize their order for identity.
        # Exact source hashes still reject any change to the reviewed contract.
        canonical = '\n'.join(sorted(description.splitlines()))
        identifier = digest((finding['check'] + '\n' + finding['impact'] + '\n' + canonical).encode())
        result[identifier] = {'id': identifier, 'detector': finding['check'], 'severity': finding['impact'],
                              'description': description, 'sourceHashes': {name: digest((ROOT / name).read_bytes()) for name in files}}
    return result


def gitleaks_rows(report):
    rows = {}
    for finding in report:
        if finding.get('Secret') != 'REDACTED':
            raise ValueError('Gitleaks report must be fully redacted')
        commit, filename = finding['Commit'], finding['File']
        path = PurePosixPath(filename)
        if not re.fullmatch('[a-f0-9]{40}', commit) or path.is_absolute() or '..' in path.parts or '\0' in filename:
            raise ValueError('Invalid finding source binding')
        blob = subprocess.check_output(['git', 'cat-file', 'blob', commit + ':' + filename], cwd=ROOT)
        rows[finding['Fingerprint']] = {'id': finding['Fingerprint'], 'detector': finding['RuleID'],
                                       'commit': commit, 'file': filename, 'sourceBlobSha256': digest(blob)}
    return rows


def review(tool, report):
    baseline = json.loads((ROOT / ('security/baselines/' + tool + '.json')).read_text(encoding='utf-8'))
    if baseline.get('inputs') != reviewed_inputs(tool):
        raise ValueError('Reviewed scanner/toolchain inputs differ')
    rows = gitleaks_rows(report) if tool == 'gitleaks' else slither_rows(report)
    expected = {row['id']: row for row in baseline['findings']}
    if len(expected) != len(baseline['findings']) or baseline['schemaVersion'] != 1:
        raise ValueError('Invalid finding review baseline')
    if baseline.get('tool') != tool:
        raise ValueError('Finding review tool differs')
    unexpected, changed = sorted(set(rows) - set(expected)), []
    stale = sorted(set(expected) - set(rows))
    for identifier in rows.keys() & expected.keys():
        retained = expected[identifier]
        if not retained.get('rationale') or retained.get('classification') not in ('false_positive', 'accepted_design_risk', 'informational'):
            changed.append(identifier)
        if any(retained.get(key) != value for key, value in rows[identifier].items() if key != 'description'):
            changed.append(identifier)
    return {'tool': tool, 'rawFindings': len(report) if tool == 'gitleaks' else len(report['results']['detectors']),
            'reviewedDistinctFindings': len(rows), 'unreviewed': unexpected, 'changedSourceOrReview': sorted(set(changed)),
            'staleReviews': stale, 'passed': not (unexpected or changed or stale),
            'meaning': 'Accepted findings remain visible; zero unreviewed is not zero findings.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('tool', choices=('gitleaks', 'slither'))
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    result = review(args.tool, json.loads(args.report.read_text(encoding='utf-8-sig')))
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['passed'] else 1)
