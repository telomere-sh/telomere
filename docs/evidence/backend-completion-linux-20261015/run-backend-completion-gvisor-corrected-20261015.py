import datetime, hashlib, json, os, pathlib, signal, stat, subprocess, sys, time, urllib.request

source, revision, archive_sha = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
work = pathlib.Path('/opt/telomere-host-runtime/declared-state-gvisor-20261015')
assert source.is_absolute() and source.resolve() == source and source.parent == work.parent and source != work
manifest = json.loads((source / '.local/source-manifest.json').read_bytes())
assert manifest['gitRevision'] == revision and manifest['archiveSha256'] == archive_sha
assert manifest['source'] == 'committed_git_blobs_only' and manifest['workingTreeIncluded'] is False
image_report = json.loads((work / 'image-verification.json').read_bytes())
assert revision == '36d8a7f877038e4a15e91d03c6f5ae71283a1263'
assert archive_sha == '9d9a5993f9d8b617ce8759a56f21c8172c3ecf0429abf596cd077db4bdf6a7c2'
assert source.name == 'backend-completion-corrected-20261015-' + archive_sha[:12]
assert image_report['status'] == 'accepted'
assert image_report['gitRevision'] == 'd4481aec92179df44a533699897db2f523fbd0a2'
assert image_report['archiveSha256'] == '090932a350a522ddfe2c056775edf194176060c3cca79a06d286e5d3f1989bd6'
original = pathlib.Path(image_report['sourceDirectory'])
assert original.is_absolute() and original.resolve() == original and original.parent == source.parent
old_manifest_raw = (original / '.local/source-manifest.json').read_bytes()
assert hashlib.sha256(old_manifest_raw).hexdigest() == image_report['sourceManifestSha256']
old_manifest = json.loads(old_manifest_raw)
assert old_manifest['gitRevision'] == image_report['gitRevision'] and old_manifest['archiveSha256'] == image_report['archiveSha256']
continuity_path = source / '.local/final-test-only-source-continuity.json'
continuity_raw = continuity_path.read_bytes()
continuity = json.loads(continuity_raw)
assert continuity['status'] == 'accepted'
assert continuity['imageGitRevision'] == image_report['gitRevision'] and continuity['finalGitRevision'] == revision
assert continuity['imageArchiveSha256'] == image_report['archiveSha256'] and continuity['finalArchiveSha256'] == archive_sha
old_files = {item['path']: item for item in old_manifest['files']}
new_files = {item['path']: item for item in manifest['files']}
assert len(old_files) == len(new_files) == len(old_manifest['files']) == len(manifest['files']) == 708
assert sorted(old_files) == sorted(new_files)
changed_paths = sorted(name for name in old_files if old_files[name] != new_files[name])
assert changed_paths == continuity['changedPaths'] == ['python/tests/test_vault_income_journal.py', 'tests/declared-state-restore.test.ts', 'tests/paid-cpu-jobs.test.ts']
assert continuity['addedPaths'] == continuity['deletedPaths'] == continuity['runtimeChangedPaths'] == []
assert continuity['filesBefore'] == continuity['filesAfter'] == 708 and continuity['unchangedFiles'] == 705
assert continuity['imageManifestSha256'] == hashlib.sha256(old_manifest_raw).hexdigest()
assert continuity['finalManifestSha256'] == hashlib.sha256((source / '.local/source-manifest.json').read_bytes()).hexdigest()
assert [row['path'] for row in continuity['files']] == sorted(old_files)
for row in continuity['files']:
    name = row['path']
    assert row['before'] == {key: old_files[name][key] for key in ['sha256', 'bytes', 'gitBlob']}
    assert row['after'] == {key: new_files[name][key] for key in ['sha256', 'bytes', 'gitBlob']}
    assert row['changed'] is (name in changed_paths)
for item in old_manifest['files']:
    path = original / item['path']
    assert path.is_file() and not path.is_symlink()
    assert path.stat().st_size == item['bytes'] and hashlib.sha256(path.read_bytes()).hexdigest() == item['sha256']
for name in ['node_modules', 'dist']:
    assert (source / name).is_symlink() and (source / name).resolve() == original / name
    assert (original / name).is_dir() and not (original / name).is_symlink()

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
def tree_inventory(root):
    assert root.is_dir() and not root.is_symlink()
    rows = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs.sort(); files.sort()
        base = pathlib.Path(directory)
        for name in list(dirs):
            path = base / name
            if path.is_symlink():
                assert path.resolve().is_relative_to(root)
                rows.append({'path': path.relative_to(root).as_posix(), 'type': 'symlink', 'target': os.readlink(path)})
                dirs.remove(name)
        for name in files:
            path = base / name
            if path.is_symlink():
                assert path.resolve().is_relative_to(root)
                rows.append({'path': path.relative_to(root).as_posix(), 'type': 'symlink', 'target': os.readlink(path)})
            else:
                info = path.lstat()
                assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                digest = hashlib.sha256()
                with path.open('rb') as stream:
                    while chunk := stream.read(1024 * 1024): digest.update(chunk)
                after = path.lstat()
                assert (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                rows.append({'path': path.relative_to(root).as_posix(), 'type': 'file', 'bytes': info.st_size, 'sha256': digest.hexdigest()})
    return sorted(rows, key=lambda row: row['path'])

def dependency_inventory(): return {name: tree_inventory(original / name) for name in ['node_modules', 'dist']}

def inventory_sha(value): return hashlib.sha256((json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()).hexdigest()

def original_source_changes():
    return [item['path'] for item in old_manifest['files'] if not (original / item['path']).is_file()
        or (original / item['path']).is_symlink() or hashlib.sha256((original / item['path']).read_bytes()).hexdigest() != item['sha256']]

def global_containers(): return sorted(cmd(['docker', '--host', 'unix:///var/run/docker.sock', 'ps', '--all', '--quiet', '--no-trunc']).splitlines())

def daemon():
    state = dict(line.split('=', 1) for line in cmd(['systemctl', 'show', 'telomere-declared-accept-20261015.service', '--property=ActiveState', '--property=SubState', '--property=MainPID']).splitlines())
    assert state['ActiveState'] == 'active' and state['SubState'] == 'running'
    pid = int(state['MainPID']); assert pid > 1
    return {'pid': pid, 'argvSha256': hashlib.sha256(pathlib.Path('/proc', str(pid), 'cmdline').read_bytes()).hexdigest(),
            'namespaceInode': str(pathlib.Path('/proc', str(pid), 'ns/net').stat().st_ino)}

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
assert source_changes() == [] and original_source_changes() == []
assert services() == image_report['servicesAfter']
assert profile() == image_report['profileAfterSha256']
assert protected_hash() == image_report['protectedAfterSha256']
assert daemon() == image_report['daemonAfter']
assert global_containers() == sorted(image_report['globalContainersAfter'])
dependencies_before = dependency_inventory()
assert len(dependencies_before['node_modules']) > 10000 and len(dependencies_before['dist']) > 50
dependency_raw = (json.dumps(dependencies_before, indent=2) + '\n').encode()
with (logs / 'reused-dependencies-before.json').open('xb') as output:
    output.write(dependency_raw); output.flush(); os.fsync(output.fileno())
original_config = (source / 'vitest.config.ts').read_text()
assert original_config.count('defineConfig({ test:') == 1
private_config = original_config.replace('defineConfig({ test:', 'defineConfig({ cacheDir: ' + json.dumps(str(logs / 'vite-cache')) + ', test:')
with (logs / 'corrected-vitest.config.ts').open('x') as output:
    output.write(private_config); output.flush(); os.fsync(output.fileno())
assert cmd(docker + ['image', 'inspect', image, '--format', '{{.Id}}']) == image_report['imageId']
assert cmd(docker + ['ps', '--all', '--quiet', '--no-trunc']).splitlines() == [protected]
report = {'schemaVersion': 1, 'gitRevision': revision, 'archiveSha256': archive_sha, 'directory': str(source),
    'sourceFiles': len(manifest['files']), 'imageRepoDigest': image, 'derivedImageId': image_report['imageId'],
    'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'servicesBefore': services(),
    'profileBeforeSha256': profile(), 'healthBefore': health(), 'protectedBeforeSha256': protected_hash(),
    'sourceChangesBefore': [], 'publicTransactions': 0, 'paidProviderRequests': 0, 'serviceMutations': False,
    'imageGitRevision': image_report['gitRevision'], 'imageArchiveSha256': image_report['archiveSha256'],
    'sourceContinuitySha256': hashlib.sha256(continuity_raw).hexdigest(),
    'sourceContinuityFile': 'final-test-only-source-continuity.json',
    'imageVerificationSha256': hashlib.sha256((work / 'image-verification.json').read_bytes()).hexdigest(),
    'globalContainersBefore': global_containers(), 'daemonBefore': daemon(),
    'originalSourceChangesBefore': [], 'dependencyInventoryBeforeSha256': inventory_sha(dependencies_before),
    'dependencyInventoryRawSha256': hashlib.sha256(dependency_raw).hexdigest(),
    'dependencyEntries': {key: len(value) for key, value in dependencies_before.items()},
    'reinstallPerformed': False, 'rebuildPerformed': False,
    'testRunnerConfig': {'cacheEnabled': False, 'configLoader': 'runner', 'cacheDir': str(logs / 'vite-cache'),
                         'sourceConfigSha256': hashlib.sha256((source / 'vitest.config.ts').read_bytes()).hexdigest(),
                         'derivedConfigSha256': hashlib.sha256((logs / 'corrected-vitest.config.ts').read_bytes()).hexdigest()}}

success = False
try:
    started = time.monotonic()
    with (logs / 'completion-gvisor.log').open('xb') as output:
        child = subprocess.Popen(['node', 'node_modules/vitest/vitest.mjs', 'run', 'tests/chunk-aead.test.ts', 'tests/large-cyst-checkpoints.test.ts', 'tests/large-cyst-agent-manifest.test.ts', 'tests/large-cyst-current-resolver.test.ts', 'tests/large-cyst-publication.test.ts', 'tests/large-cyst-s3.test.ts', 'tests/large-cyst-replication.test.ts', 'tests/cyst-key-wrap.test.ts', 'tests/paid-cyst-file-restore.test.ts', 'tests/paid-cyst-file-cache-expiry.test.ts', 'tests/declared-state-bundle.test.ts', 'tests/declared-state-restore.test.ts', 'tests/declared-state-session-checkpoint.test.ts', 'tests/paid-cpu-jobs.test.ts', 'tests/platform-cpu-offers.test.ts', '--reporter=json',
            '--outputFile=.local/completion-gvisor.json', '--no-cache', '--configLoader=runner', '--config=.local/corrected-vitest.config.ts'], cwd=source, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
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
    assert len(report['cases']) == raw['numTotalTests'] == raw['numPassedTests'] == 167
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
        report['globalContainersAfter'] = global_containers()
        report['daemonAfter'] = daemon()
        report['originalSourceChangesAfter'] = original_source_changes()
        dependencies_after = dependency_inventory()
        report['dependencyInventoryAfterSha256'] = inventory_sha(dependencies_after)
        report['dependencyEntriesAfter'] = {key: len(value) for key, value in dependencies_after.items()}
        success = success and dependencies_after == dependencies_before
        success = success and report['globalContainersBefore'] == report['globalContainersAfter']
        success = success and report['daemonBefore'] == report['daemonAfter'] and not report['originalSourceChangesAfter']
        success = success and hashlib.sha256(continuity_path.read_bytes()).hexdigest() == report['sourceContinuitySha256']

        success = success and report['servicesBefore'] == report['servicesAfter'] and report['profileBeforeSha256'] == report['profileAfterSha256']
        success = success and report['protectedBeforeSha256'] == report['protectedAfterSha256'] and report['remainingContainers'] == [protected]
    except Exception as error:
        report['postflightFailureType'] = type(error).__name__
        success = False
    report['success'] = bool(success and not report['sourceChangesAfter'])
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with (logs / 'completion-gvisor-acceptance.json').open('xb') as output:
        output.write((json.dumps(report, indent=2) + '\n').encode()); output.flush(); os.fsync(output.fileno())
    print(json.dumps(report, separators=(',', ':')), flush=True)
sys.exit(0 if report['success'] else 1)
