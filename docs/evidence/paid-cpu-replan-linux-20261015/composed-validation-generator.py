"""Compose only actual retained frozen M8 acceptance, never rescore readiness."""
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / 'docs/evidence/paid-cpu-replan-linux-20261015'
REVISION = 'e01b776bd86a9cdc27a3e80f987930ed8116c508'
ARCHIVE_SHA = '9111430f5e2713183e4f7823ca24380cb6afde5c31acff9a4ed751e21bfd4206'
PROFILE_SHA = 'a400feb3475b91168a5419d0a98c00ea804ba817c1c0ad34dea65d7d8808df8f'
PRIOR_DEPENDENCIES_PATH = 'docs/evidence/backend-completion-linux-20261015/reused-dependencies-before.json'
PRIOR_DEPENDENCIES_SHA = '8e1255e6d331e8bcf68f8182ad8cfc03fd2f349b4987ca1e21e4e5674cd08080'
FILES = ['tests/paid-cpu-job-replan-runner.test.ts', 'tests/paid-cpu-jobs.test.ts',
         'tests/paid-host-preemption.test.ts', 'tests/paid-vault-preemption-handoff.test.ts']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(name):
    return json.loads((EVIDENCE / name).read_bytes())


def inventory_sha(value):
    return sha((json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode())


def project_inventory(rows):
    return sorted([{key: value for key, value in row.items() if key in ['path', 'type', 'bytes', 'sha256', 'target']}
                   for row in rows], key=lambda row: row['path'])


def git_files():
    roots = ['src', 'scripts', 'infra', 'contracts', 'tests', 'python', 'public', 'package.json',
             'package-lock.json', 'tsconfig.json', 'vitest.config.ts']
    entries = []
    for record in subprocess.check_output(['git', 'ls-tree', '-r', '-z', REVISION, '--', *roots], cwd=ROOT).split(b'\0'):
        if not record:
            continue
        metadata, path = record.split(b'\t', 1)
        mode, kind, oid = metadata.split()
        assert mode in [b'100644', b'100755'] and kind == b'blob'
        entries.append((path.decode(), oid.decode()))
    entries.sort()
    raw = subprocess.check_output(['git', 'cat-file', '--batch'], cwd=ROOT,
                                  input=''.join(oid + '\n' for _, oid in entries).encode())
    offset = 0
    rows = []
    for path, oid in entries:
        end = raw.index(b'\n', offset)
        header = raw[offset:end].split()
        assert header[:2] == [oid.encode(), b'blob']
        size = int(header[2])
        data = raw[end + 1:end + 1 + size]
        offset = end + 2 + size
        rows.append({'path': path, 'bytes': len(data), 'sha256': sha(data), 'gitBlob': oid})
    return rows


def main():
    generator_bytes = pathlib.Path(__file__).read_bytes()
    assert generator_bytes == (EVIDENCE / 'composed-validation-generator.py').read_bytes()
    report, retained, launch, manifest = map(read, ['acceptance.json', 'retention.json', 'launch.json', 'source-manifest.json'])
    assert report['success'] is True and report['status'] == 'accepted_focused_linux_cpu_replan'
    assert report['gitRevision'] == launch['gitRevision'] == manifest['gitRevision'] == REVISION
    assert report['archiveSha256'] == launch['archiveSha256'] == manifest['archiveSha256'] == ARCHIVE_SHA
    assert report['sourceFiles'] == launch['sourceFiles'] == len(manifest['files']) == 710
    assert manifest['source'] == 'committed_git_blobs_only' and manifest['workingTreeIncluded'] is False
    assert manifest['files'] == git_files()
    assert report['sourceManifestSha256'] == sha((EVIDENCE / 'source-manifest.json').read_bytes())
    assert retained['remoteAndLocalHashesMatch'] is True and retained['success'] is True
    for row in retained['files']:
        assert row['present'] is True
        data = (EVIDENCE / row['name']).read_bytes()
        assert row['bytes'] == len(data) and row['sha256'] == sha(data)
    assert launch['runnerSha256'] == sha((EVIDENCE / 'executed-runner.py').read_bytes())
    assert launch['controllerSha256'] == sha((EVIDENCE / 'executed-controller.py').read_bytes())
    assert launch['command'][0] == 'python3' and launch['command'][-2:] == [REVISION, ARCHIVE_SHA]
    assert report['servicesBefore'] == report['servicesAfter']
    assert report['profileBeforeSha256'] == report['profileAfterSha256'] == PROFILE_SHA
    assert report['cacheSourceBefore']['unchanged'] and report['cacheSourceAfter']['unchanged']
    assert report['sourceBefore']['unchanged'] and report['sourceAfter']['unchanged']
    assert report['sourceManifestUnchanged'] and report['copiedNodeModulesUnchanged']
    assert report['ownedProcessesRemaining'] == []
    assert all(row['statusCode'] == 200 for phase in ['healthBefore', 'healthAfter'] for row in report[phase].values())
    for key, value in report['inventories'].items():
        before, after = read(key + '-before.json'), read(key + '-after.json')
        assert before == after and value['unchanged'] and value['entries'] == len(before)
        assert value['beforeSha256'] == value['afterSha256'] == inventory_sha(before)
    assert read('copied-node-modules-after.json') == read('cache-node-modules-before.json')
    assert report['dependencyCopySha256'] == inventory_sha(read('cache-node-modules-before.json'))
    prior_dependency_bytes = (ROOT / PRIOR_DEPENDENCIES_PATH).read_bytes()
    assert sha(prior_dependency_bytes) == PRIOR_DEPENDENCIES_SHA
    assert prior_dependency_bytes == subprocess.check_output(['git', 'show', REVISION + ':' + PRIOR_DEPENDENCIES_PATH], cwd=ROOT)
    prior_dependencies = json.loads(prior_dependency_bytes)
    prior_projection_proof = {}
    for current_key, prior_key, count in [('cache-node-modules', 'node_modules', 21050), ('cache-dist', 'dist', 585)]:
        prior_projection = project_inventory(prior_dependencies[prior_key])
        current_projection = project_inventory(read(current_key + '-before.json'))
        assert len(prior_projection) == len(current_projection) == count and current_projection == prior_projection
        prior_projection_proof[prior_key] = {'entries': count, 'projectedEntriesIdentical': True,
                                           'projectionSha256': inventory_sha(prior_projection)}
    for name in ['typecheck', 'build', 'crypto-probe', 'node', 'python']:
        row = report['commands'][name]
        assert row['exitCode'] == 0 and not row['timedOut'] and not row['logLimitExceeded']
        data = (EVIDENCE / (name + '.log')).read_bytes()
        assert row['logBytes'] == len(data) and row['logSha256'] == sha(data)
    assert report['nodeTestFiles'] == FILES and report['pythonPattern'] == 'test_platform*.py'
    node = read('node.json')
    cases = [case for row in node['testResults'] for case in row['assertionResults']]
    assert len(node['testResults']) == 4 and len(cases) == report['nodeTests']['total'] == node['numTotalTests']
    assert report['nodeTests']['accepted'] and all(case['status'] == 'passed' for case in cases)
    assert {pathlib.Path(row['name']).name for row in node['testResults']} == {pathlib.Path(name).name for name in FILES}
    assert report['pythonTests']['accepted'] and report['pythonTests']['skips'] == []
    assert report['pythonTests']['total'] == report['pythonTests']['passed'] > 0
    assert report['dependencyInstalls'] == report['paidProviderRequests'] == report['publicTransactions'] == 0
    assert report['dockerOptInEnabled'] is report['deploymentPerformed'] is report['serviceMutations'] is False
    raw_files = []
    for path in sorted(EVIDENCE.iterdir()):
        assert path.is_file() and not path.is_symlink()
        data = path.read_bytes()
        raw_files.append({'path': path.relative_to(ROOT).as_posix(), 'bytes': len(data), 'sha256': sha(data)})
    result = {'schemaVersion': 1, 'status': 'accepted_focused_linux_cpu_replan', 'success': True,
              'source': {'gitRevision': REVISION, 'archiveSha256': ARCHIVE_SHA, 'files': 710,
                         'gitBlobsIndependentlyMatched': True, 'sourceManifestSha256': report['sourceManifestSha256'],
                         'before': report['sourceBefore'], 'after': report['sourceAfter']},
              'startedAtUtc': report['startedAtUtc'], 'finishedAtUtc': report['finishedAtUtc'],
              'runtime': {'node': report['nodeVersion'], **report['runtimeAndPackages']},
              'typecheck': report['commands']['typecheck'], 'applicationBuild': report['commands']['build'],
              'buildOutputInventorySha256': report['buildOutputInventorySha256'],
              'node': report['nodeTests'], 'python': report['pythonTests'],
              'dependencyCacheAndCryptoVenv': {'installs': 0, 'originalSourceUnchanged': True,
                                             'copiedNodeModulesUnchanged': True, 'inventories': report['inventories'],
                                             'priorAcceptedCacheBinding': {'path': PRIOR_DEPENDENCIES_PATH,
                                                                          'sha256': PRIOR_DEPENDENCIES_SHA,
                                                                          'matchesFrozenGitArtifact': True,
                                                                          'comparedFields': ['path', 'type', 'bytes', 'sha256', 'target'],
                                                                          'proof': prior_projection_proof}},
              'staging': {'servicesBefore': report['servicesBefore'], 'servicesAfter': report['servicesAfter'],
                          'profileBeforeSha256': PROFILE_SHA, 'profileAfterSha256': PROFILE_SHA,
                          'healthBefore': report['healthBefore'], 'healthAfter': report['healthAfter'],
                          'serviceMutations': False, 'deploymentPerformed': False},
              'ownedProcessesRemaining': [], 'publicTransactions': 0, 'paidProviderRequests': 0,
              'scope': report['scope'],
              'limitations': ['Focused four-file Node acceptance and Python platform family only; no full final 710-file backend suite claim.',
                              'Actual paid job integration used disposable local Anvil and local-process HostKit fixtures on one VPS.',
                              'No new Docker/gVisor, physical host failover, live supplier, public funded Base or sealed CPU attestation acceptance.',
                              'No application deployment, launch-readiness certification or readiness percentage rescore.'],
              'launch': launch, 'generatorSha256': sha(generator_bytes),
              'remoteLocalRetentionSha256': sha((EVIDENCE / 'retention.json').read_bytes()), 'rawFiles': raw_files}
    destination = ROOT / 'docs/paid-cpu-replan-linux-validation-2026-10-15.json'
    with destination.open('x', encoding='utf-8', newline='\n') as output:
        json.dump(result, output, indent=2); output.write('\n')
    print(json.dumps({'status': result['status'], 'node': result['node'], 'python': result['python'],
                      'reportSha256': sha(destination.read_bytes()), 'rawFiles': len(raw_files)}))


if __name__ == '__main__':
    main()
