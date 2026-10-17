import datetime, hashlib, json, os, pathlib, signal, subprocess, sys, time, urllib.request

source, revision, archive_sha = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
work = pathlib.Path('/opt/telomere-host-runtime/declared-state-gvisor-20261015')
assert source.is_absolute() and source.resolve() == source and source.parent == work.parent and source != work
manifest = json.loads((source / '.local/source-manifest.json').read_bytes())
assert manifest['gitRevision'] == revision and manifest['archiveSha256'] == archive_sha
assert manifest['source'] == 'committed_git_blobs_only' and manifest['workingTreeIncluded'] is False
image_report = json.loads((work / 'image-verification.json').read_bytes())
assert image_report['status'] == 'accepted' and image_report['gitRevision'] == revision and image_report['archiveSha256'] == archive_sha
image = image_report['image']
socket = '/run/telomere-declared-accept-20261015/docker.sock'
docker = ['docker', '--host', 'unix://' + socket]
protected = '1d7ecc9b94866b9617df656ad7e2251916a9b7ceafef9a488ef6e85540076c5e'
env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8',
    'TELOMERE_ACCEPTANCE_GVISOR_SOCKET': socket, 'TELOMERE_ACCEPTANCE_GVISOR_IMAGE': image,
    'TELOMERE_ACCEPTANCE_DECLARED_STATE_CELL': '1'}
logs = source / '.local'
assert not (logs / 'completion-gvisor.json').exists() and not (logs / 'completion-gvisor-acceptance.json').exists()
def cmd(argv): return subprocess.check_output(argv, env=env, text=True, timeout=30).strip()
def source_changes():
    return [item['path'] for item in manifest['files'] if not (source / item['path']).is_file()
        or (source / item['path']).is_symlink() or hashlib.sha256((source / item['path']).read_bytes()).hexdigest() != item['sha256']]
def services():
    values = {name: cmd(['systemctl', 'show', name, '--property=ActiveState', '--property=SubState', '--property=MainPID',
        '--property=WorkingDirectory', '--property=NRestarts']) for name in ['telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service']}
    for value in values.values():
        state = dict(line.split('=', 1) for line in value.splitlines())
        assert state['ActiveState'] == 'active' and state['SubState'] == 'running'
        assert int(state['MainPID']) > 1 and state['NRestarts'] == '0'
    return values
def profile(): return hashlib.sha256(pathlib.Path('/opt/telomere-pilot/config/staging.env').read_bytes()).hexdigest()
def health():
    result = {}
    for name, expected in [('live', 'ok'), ('ready', 'ready')]:
        with urllib.request.urlopen('http://127.0.0.1:13280/health/' + name, timeout=10) as response:
            body = json.load(response)
            assert response.status == 200 and body['status'] == expected
            result[name] = {'statusCode': response.status, 'body': body}
    return result
def protected_hash(): return hashlib.sha256(cmd(docker + ['inspect', protected]).encode()).hexdigest()
assert source_changes() == []
assert cmd(docker + ['image', 'inspect', image, '--format', '{{.Id}}']) == image_report['imageId']
assert cmd(docker + ['ps', '--all', '--quiet', '--no-trunc']).splitlines() == [protected]
report = {'schemaVersion': 1, 'gitRevision': revision, 'archiveSha256': archive_sha, 'directory': str(source),
    'sourceFiles': len(manifest['files']), 'imageRepoDigest': image, 'derivedImageId': image_report['imageId'],
    'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'servicesBefore': services(),
    'profileBeforeSha256': profile(), 'healthBefore': health(), 'protectedBeforeSha256': protected_hash(),
    'sourceChangesBefore': [], 'publicTransactions': 0, 'paidProviderRequests': 0, 'serviceMutations': False}
success = False
try:
    started = time.monotonic()
    with (logs / 'completion-gvisor.log').open('xb') as output:
        child = subprocess.Popen(['node', 'node_modules/vitest/vitest.mjs', 'run', 'tests/chunk-aead.test.ts', 'tests/large-cyst-checkpoints.test.ts', 'tests/large-cyst-agent-manifest.test.ts', 'tests/large-cyst-current-resolver.test.ts', 'tests/large-cyst-publication.test.ts', 'tests/large-cyst-s3.test.ts', 'tests/large-cyst-replication.test.ts', 'tests/cyst-key-wrap.test.ts', 'tests/paid-cyst-file-restore.test.ts', 'tests/paid-cyst-file-cache-expiry.test.ts', 'tests/declared-state-bundle.test.ts', 'tests/declared-state-restore.test.ts', 'tests/declared-state-session-checkpoint.test.ts', 'tests/paid-cpu-jobs.test.ts', 'tests/platform-cpu-offers.test.ts', '--reporter=json',
            '--outputFile=.local/completion-gvisor.json'], cwd=source, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try: child.wait(timeout=1200)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=10)
    report['execution'] = {'exitCode': child.returncode, 'seconds': round(time.monotonic() - started, 3)}
    raw = json.loads((logs / 'completion-gvisor.json').read_bytes())
    executed_files = sorted(pathlib.Path(row['name']).relative_to(source).as_posix() for row in raw['testResults'])
    expected_files = ['tests/chunk-aead.test.ts', 'tests/cyst-key-wrap.test.ts', 'tests/declared-state-bundle.test.ts', 'tests/declared-state-restore.test.ts', 'tests/declared-state-session-checkpoint.test.ts', 'tests/large-cyst-agent-manifest.test.ts', 'tests/large-cyst-checkpoints.test.ts', 'tests/large-cyst-current-resolver.test.ts', 'tests/large-cyst-publication.test.ts', 'tests/large-cyst-replication.test.ts', 'tests/large-cyst-s3.test.ts', 'tests/paid-cpu-jobs.test.ts', 'tests/paid-cyst-file-cache-expiry.test.ts', 'tests/paid-cyst-file-restore.test.ts', 'tests/platform-cpu-offers.test.ts']
    assert executed_files == expected_files
    assert all(row['assertionResults'] for row in raw['testResults'])
    report['nodeTests'] = {key: raw[key] for key in ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'success']}
    report['cases'] = [{'name': case['fullName'], 'status': case['status']} for row in raw['testResults'] for case in row['assertionResults']]
    success = child.returncode == 0 and raw['success'] and raw['numFailedTests'] == raw['numPendingTests'] == 0
    assert len(report['cases']) == raw['numTotalTests'] == raw['numPassedTests']
    assert all(case['status'] == 'passed' for case in report['cases'])
    assert any('restores declared-directory state' in case['name'] and case['status'] == 'passed' for case in report['cases'])
    assert any('runs a paid CPU job across two offers' in case['name'] and case['status'] == 'passed' for case in report['cases'])
    assert any('replaying the original tree after source cleanup (real gVisor)' in case['name'] and case['status'] == 'passed' for case in report['cases'])
except Exception as error:
    success = False
    report['failureType'] = type(error).__name__
finally:
    report['sourceChangesAfter'] = source_changes()
    try:
        report['servicesAfter'], report['profileAfterSha256'], report['healthAfter'] = services(), profile(), health()
        report['protectedAfterSha256'] = protected_hash()
        report['remainingContainers'] = cmd(docker + ['ps', '--all', '--quiet', '--no-trunc']).splitlines()
        success = success and report['servicesBefore'] == report['servicesAfter'] and report['profileBeforeSha256'] == report['profileAfterSha256']
        success = success and report['protectedBeforeSha256'] == report['protectedAfterSha256'] and report['remainingContainers'] == [protected]
    except Exception as error:
        report['postflightFailureType'] = type(error).__name__
        success = False
    report['success'] = bool(success and not report['sourceChangesAfter'])
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (logs / 'completion-gvisor-acceptance.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, separators=(',', ':')), flush=True)
sys.exit(0 if report['success'] else 1)
