"""Reviewed-input-only, unchanged two-file diagnostic; never install/deploy/services.

SOURCE must be an already separately prepared private frozen runtime, not the
original full-regression checkout. A caller must review and explicitly launch.
"""
import collections
import datetime
import hashlib
import json
import importlib.util
import os
import pathlib
import signal
import stat
import subprocess
import sys
import time
import urllib.request

FILES = {
    'tests/platform-runtime.test.ts': 'e35a8b4a9a02da60b3e70a73d01ca1fa31fb64faea4891c29db484d175a87906',
    'tests/selection-reputation-publisher.test.ts': 'f6405b9f6c38a28e32ab9fdf3dfe47eb6d8509db54a0c00a67bfbfd1e911688c',
}
ORIGINAL = pathlib.Path('/opt/telomere-host-runtime/backend-completion-20261015-d10f22b3259a')
CACHE = pathlib.Path('/opt/telomere-host-runtime/backend-completion-final-20261015-090932a350a5')
REVISION = 'bc3ca04617c2ec6b0fec32ee59aa34af97ba867d'
ARCHIVE_SHA = '3ed17e69fc55c944999ca0449a3384beba7c0ef8753589d502463fa55a332ee2'
SUPPORT_SHA = 'd6774dbaafcb18574053d7d9f20649e558cabfc4471f3fe38c427edbc78190f4'
SERVICES = ['telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service']
PROFILE_SHA256 = 'a400feb3475b91168a5419d0a98c00ea804ba817c1c0ad34dea65d7d8808df8f'


def require(value):
    if not value:
        raise RuntimeError('Two-file recheck precondition refused')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def read_regular(path, maximum):
    value = path.lstat()
    require(stat.S_ISREG(value.st_mode) and not path.is_symlink() and value.st_nlink == 1
            and value.st_uid == os.getuid() and value.st_size <= maximum)
    data = path.read_bytes()
    require(len(data) == value.st_size)
    return data


def inspect_services():
    result = {}
    for service in SERVICES:
        value = subprocess.check_output(['systemctl', 'show', service, '--property=ActiveState', '--property=SubState',
                                         '--property=NRestarts', '--property=MainPID', '--property=WorkingDirectory'],
                                        text=True, timeout=15)
        fields = dict(line.split('=', 1) for line in value.strip().splitlines())
        require(fields['ActiveState'] == 'active' and fields['SubState'] == 'running'
                and fields['NRestarts'] == '0' and int(fields['MainPID']) > 1)
        result[service] = fields
    require(sha(pathlib.Path('/opt/telomere-pilot/config/staging.env').read_bytes()) == PROFILE_SHA256)
    return result


def health():
    result = {}
    for name, expected in [('live', 'ok'), ('ready', 'ready')]:
        with urllib.request.urlopen('http://127.0.0.1:13280/health/' + name, timeout=10) as response:
            body = json.load(response)
            require(response.status == 200 and body['status'] == expected)
            result[name] = {'statusCode': response.status, 'body': body}
    return result


def verify_source(source, manifest):
    checked = 0
    for item in manifest['files']:
        name = pathlib.PurePosixPath(item['path'])
        require(not name.is_absolute() and '..' not in name.parts
                and not any(part in ('.git', '.local', 'node_modules', '.env') for part in name.parts))
        data = read_regular(source / name, 32 * 1024 * 1024)
        require(len(data) == item['bytes'] and sha(data) == item['sha256'])
        checked += 1
    require(checked == len(manifest['files']) and 703 <= checked <= 1500)
    return {'unchanged': True, 'verified': checked, 'changed': []}


def write_report(path, report):
    pending = path.with_suffix('.pending.json')
    with pending.open('x', encoding='utf-8', newline='\n') as output:
        json.dump(report, output, indent=2)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    if path.exists():
        read_regular(path, 4 * 1024 * 1024)
    os.replace(pending, path)


def main(argv):
    require(len(argv) == 1)
    source = pathlib.Path(argv[0])
    require(source == pathlib.Path('/opt/telomere-host-runtime/full-twofile-corrected-20261015-3ed17e69fc55'))
    require(source.is_absolute() and source.resolve() == source and source != ORIGINAL
            and source.is_relative_to(pathlib.Path('/opt/telomere-host-runtime')))
    for directory in [source / '.local', source, *source.parents]:
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and not directory.is_symlink())
    for directory in [source, source / '.local']:
        info = directory.lstat()
        require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700)
    os.umask(0o077)
    local = source / '.local'
    manifest_bytes = read_regular(local / 'source-manifest.json', 2 * 1024 * 1024)
    manifest = json.loads(manifest_bytes)
    require(manifest['source'] == 'committed_git_blobs_only' and manifest['workingTreeIncluded'] is False)
    require(manifest['gitRevision'] == REVISION and manifest['archiveSha256'] == ARCHIVE_SHA and len(manifest['files']) == 708)
    support_path = pathlib.Path('/tmp/prepare-full-twofile-recheck-20261015.py')
    require(sha(read_regular(support_path, 64 * 1024)) == SUPPORT_SHA)
    spec = importlib.util.spec_from_file_location('twofile_support', support_path)
    support = importlib.util.module_from_spec(spec); spec.loader.exec_module(support)
    continuity_bytes = read_regular(local / 'source-continuity.json', 2 * 1024 * 1024)
    continuity = json.loads(continuity_bytes)
    require(continuity['baselineRevision'] == '079bb31fa76217df9d3d3d0e309293bf4f58e89c' and continuity['finalRevision'] == REVISION
            and continuity['archiveSha256'] == ARCHIVE_SHA and continuity['sourceManifestSha256'] == sha(manifest_bytes)
            and continuity['changedRuntimePaths'] == list(FILES) and continuity['productionChangedPaths'] == []
            and continuity['addedPaths'] == continuity['deletedPaths'] == [])
    require({row['path']: row['after'] for row in continuity['files']} == {item['path']: {key: item[key] for key in ['sha256', 'bytes', 'gitBlob']} for item in manifest['files']})
    old_manifest_bytes = read_regular(CACHE / '.local/source-manifest.json', 2 * 1024 * 1024)
    require(sha(old_manifest_bytes) == '16b7ddcfb62c1d6fde5bd0f6c4a2b55013d0dbe508c62e4ff233efd896e69028')
    old_manifest = json.loads(old_manifest_bytes)
    full_manifest = json.loads(read_regular(ORIGINAL / '.local/source-manifest.json', 2 * 1024 * 1024))
    preparation_bytes = read_regular(local / 'preparation.json', 2 * 1024 * 1024)
    preparation = json.loads(preparation_bytes)
    require(preparation['status'] == 'accepted_preparation_only' and preparation['success'] is True and preparation['gitRevision'] == REVISION)
    dependencies_before, copied_before = support.dependency_inventory(CACHE), support.dependency_inventory(source)
    require(dependencies_before == copied_before and support.inventory_sha(dependencies_before) == preparation['dependencyInventoryBeforeSha256'])
    for name, digest in FILES.items():
        require(sha(read_regular(source / name, 1024 * 1024)) == digest)
    original_report_bytes = read_regular(ORIGINAL / '.local/full-acceptance.json', 4 * 1024 * 1024)
    original = json.loads(original_report_bytes)
    require(sha(original_report_bytes) == 'e245c533d1da366eece0a8adf83c1e792ef3133f32ffe6cd0369d7b944876bfa')
    original_node_bytes = read_regular(ORIGINAL / '.local/full-node.json', 32 * 1024 * 1024)
    require(sha(original_node_bytes) == '3cf0f93ee928382bc09b3d85b41e751bed4d24a5f72151998ebb92e06071c110')
    baseline_cases = sorted((pathlib.Path(row['name']).relative_to(ORIGINAL).as_posix(), case['fullName'])
        for row in json.loads(original_node_bytes)['testResults'] if pathlib.Path(row['name']).relative_to(ORIGINAL).as_posix() in FILES
        for case in row['assertionResults'])
    require(len(baseline_cases) == len(set(baseline_cases)) == 59 and collections.Counter(name for name, _ in baseline_cases) == {list(FILES)[0]: 29, list(FILES)[1]: 30})
    require(original['status'] == 'failed' and original['finishedAt'] == '2026-10-15T13:38:03.525885+00:00'
            and original['nodeTests']['numTotalTests'] == 2482 and original['nodeTests']['numFailedTests'] == 28
            and original['node']['timedOut'] is False)
    report_path = local / 'unexpected-twofile-acceptance.json'
    raw_path = local / 'unexpected-twofile.json'
    log_path = local / 'unexpected-twofile.log'
    typecheck_log = local / 'unexpected-twofile-typecheck.log'
    require(all(not item.exists() and not item.is_symlink() for item in [report_path, raw_path, log_path, typecheck_log]))
    require(subprocess.check_output(['node', '--version'], text=True, timeout=10).strip() == 'v22.23.3')
    report = {'schemaVersion': 1, 'status': 'running', 'startedAt': now(), 'sourceDirectory': str(source),
              'gitRevision': manifest['gitRevision'], 'archiveSha256': manifest['archiveSha256'],
              'sourceManifestSha256': sha(manifest_bytes), 'originalFailedReportSha256': sha(original_report_bytes),
              'reviewedFixtureHashes': FILES, 'sourceFiles': 708, 'baselineRevision': continuity['baselineRevision'],
              'changedRuntimePaths': list(FILES), 'productionChangedPaths': [],
              'sourceContinuitySha256': sha(continuity_bytes), 'preparationSha256': sha(preparation_bytes), 'preparerSha256': SUPPORT_SHA,
              'sourceBefore': verify_source(source, manifest), 'oldSourceBefore': verify_source(CACHE, old_manifest),
              'baselineFullSourceBefore': verify_source(ORIGINAL, full_manifest), 'oldManifestSha256': sha(old_manifest_bytes),
              'originalFullNodeSha256': sha(original_node_bytes),
              'originalDependencyInventoryBeforeSha256': support.inventory_sha(dependencies_before),
              'copiedDependencyInventoryBeforeSha256': support.inventory_sha(copied_before),
              'dependencyEntries': {name: len(rows) for name, rows in dependencies_before.items()},
              'servicesBefore': inspect_services(), 'profileSha256': PROFILE_SHA256, 'healthBefore': health(),
              'scope': '59 cases in two complete corrected fixture files after the actual failed complete baseline; no final full-suite acceptance.',
              'timeoutSeconds': 1200, 'paidProviderRequests': 0, 'publicTransactions': 0, 'serviceMutations': False,
              'dockerOptInEnabled': False, 'dependencyOrSourceMutations': False, 'dependenciesCopiedToOwnedDirectory': True,
              'reinstallPerformed': False, 'rebuildPerformed': False}
    write_report(report_path, report)
    accepted = False
    child = None
    def interrupted(_signal, _frame):
        raise RuntimeError('Two-file diagnostic interrupted')
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    try:
        for name in ['home', 'tmp']: (local / name).mkdir(mode=0o700)
        environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(local / 'home'), 'TMPDIR': str(local / 'tmp'), 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
        original_config = read_regular(source / 'vitest.config.ts', 64 * 1024).decode()
        require(original_config.count('defineConfig({ test:') == 1)
        private_config = original_config.replace('defineConfig({ test:', 'defineConfig({ cacheDir: ' + json.dumps(str(local / 'vite-cache')) + ', test:')
        with (local / 'corrected-vitest.config.ts').open('x') as output:
            output.write(private_config); output.flush(); os.fsync(output.fileno())
        report['testRunnerConfig'] = {'cacheEnabled': False, 'configLoader': 'runner', 'cacheDir': str(local / 'vite-cache'),
            'sourceConfigSha256': sha(original_config.encode()), 'derivedConfigSha256': sha(private_config.encode())}
        started = time.monotonic()
        with typecheck_log.open('xb') as output:
            checked = subprocess.run(['node', 'node_modules/typescript/bin/tsc', '--noEmit'], cwd=source, env=environment,
                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, timeout=180)
        report['typecheck'] = {'exitCode': checked.returncode, 'seconds': round(time.monotonic() - started, 3), 'timedOut': False}
        require(checked.returncode == 0)
        write_report(report_path, report)
        started = time.monotonic()
        with log_path.open('xb') as output:
            child = subprocess.Popen(['node', 'node_modules/vitest/vitest.mjs', 'run', *FILES,
                                      '--reporter=json', '--outputFile=.local/unexpected-twofile.json', '--no-cache',
                                      '--configLoader=runner', '--config=.local/corrected-vitest.config.ts'],
                                     cwd=source, env=environment, stdin=subprocess.DEVNULL, stdout=output,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            timed_out, limited = False, False
            while child.poll() is None:
                timed_out = time.monotonic() - started >= 1200
                limited = os.fstat(output.fileno()).st_size > 16 * 1024 * 1024
                if timed_out or limited:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=10)
                    break
                time.sleep(0.5)
        report['node'] = {'exitCode': child.returncode, 'seconds': round(time.monotonic() - started, 3),
                          'timedOut': timed_out, 'logLimitExceeded': limited}
        raw = json.loads(read_regular(raw_path, 32 * 1024 * 1024))
        require({row['name'] for row in raw['testResults']} == {str(source / name) for name in FILES}
                and len(raw['testResults']) == 2)
        cases = [case for row in raw['testResults'] for case in row['assertionResults']]
        statuses = dict(collections.Counter(case['status'] for case in cases))
        require(len(cases) == raw['numTotalTests'] == 59 and statuses.get('passed', 0) == raw['numPassedTests'])
        actual_cases = sorted((pathlib.Path(row['name']).relative_to(source).as_posix(), case['fullName'])
            for row in raw['testResults'] for case in row['assertionResults'])
        require(actual_cases == baseline_cases)
        report['caseIdentitiesEqualOriginalFullSubsets'] = True
        report['baselineCaseIdentitySha256'] = sha((json.dumps(baseline_cases, separators=(',', ':')) + '\n').encode())
        report['actualCaseIdentitySha256'] = sha((json.dumps(actual_cases, separators=(',', ':')) + '\n').encode())
        report['nodeTests'] = {key: raw.get(key) for key in ['success', 'numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests']}
        report['nodeTests']['actualAssertionStatuses'] = statuses
        report['nodeTests']['files'] = [{'name': pathlib.Path(row['name']).relative_to(source).as_posix(), 'status': row['status'],
            'assertions': len(row['assertionResults'])} for row in raw['testResults']]
        report['nodeTests']['failures'] = [{'file': pathlib.Path(row['name']).name, 'name': case['fullName'],
                                           'duration': case.get('duration'), 'messages': case['failureMessages']}
                                          for row in raw['testResults'] for case in row['assertionResults'] if case['status'] == 'failed']
        accepted = child.returncode == 0 and not timed_out and not limited and raw['success'] is True
        accepted = accepted and statuses == {'passed': 59}
        regression = next(case for row in raw['testResults'] for case in row['assertionResults']
            if case['fullName'].endswith('never repeats a paid ambiguous POST, settles CPU at zero inference charge, and frees the receipt hour'))
        report['clockLagRegression'] = {'testFileSha256': FILES['tests/platform-runtime.test.ts'], 'case': regression['fullName'],
            'status': regression['status'], 'proofKind': 'reviewed_git_pinned_case_assertions_with_real_local_subprocess_and_Anvil',
            'assertions': ['original_endedAt_gt_canonical_head', 'canSeal_false_before_and_after_reopen',
                'canonical_advance_only_to_original_endedAt', 'original_settlement_unchanged', 'receipt_recorded',
                'paid_callback_once', 'closed_hour_canSeal_true_before_final_drain', 'final_completed']}
        accepted = accepted and regression['status'] == 'passed'
    except BaseException as error:
        report['failureType'] = type(error).__name__
        accepted = False
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN); signal.signal(signal.SIGINT, signal.SIG_IGN)
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=10)
        try:
            report['sourceAfter'] = verify_source(source, manifest)
            report['oldSourceAfter'] = verify_source(CACHE, old_manifest)
            report['baselineFullSourceAfter'] = verify_source(ORIGINAL, full_manifest)
            require(sha(read_regular(local / 'source-manifest.json', 2 * 1024 * 1024)) == report['sourceManifestSha256'])
            dependencies_after, copied_after = support.dependency_inventory(CACHE), support.dependency_inventory(source)
            report['originalDependencyInventoryAfterSha256'] = support.inventory_sha(dependencies_after)
            report['copiedDependencyInventoryAfterSha256'] = support.inventory_sha(copied_after)
            require(dependencies_before == copied_before == dependencies_after == copied_after)
            report['servicesAfter'], report['healthAfter'] = inspect_services(), health()
            report['profileBeforeSha256'] = report['profileSha256']; report['profileAfterSha256'] = PROFILE_SHA256
            require(report['servicesAfter'] == report['servicesBefore'])
        except BaseException as error:
            report['postflightFailureType'] = type(error).__name__
            accepted = False
        remaining = []
        for process in pathlib.Path('/proc').iterdir():
            if process.name.isdigit():
                try:
                    command = (process / 'cmdline').read_bytes()
                    if b'anvil' in command and str(source).encode() in command:
                        remaining.append(int(process.name))
                except (FileNotFoundError, PermissionError):
                    pass
        report['ownedAnvilProcessesRemaining'] = remaining
        report['success'] = bool(accepted and not remaining)
        report['status'] = 'accepted_corrected_twofile_regressions' if report['success'] else 'failed'
        report['finishedAt'] = now()
        write_report(report_path, report)
        print(json.dumps({key: report.get(key) for key in ['status', 'finishedAt', 'node', 'nodeTests', 'failureType', 'postflightFailureType']}, separators=(',', ':')))
    return 0 if report['success'] else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
