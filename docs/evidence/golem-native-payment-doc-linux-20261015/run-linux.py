import datetime, hashlib, json, os, pathlib, re, shutil, signal, stat, subprocess, sys, tarfile, time, urllib.request

archive_arg, expected, fixture_arg, fixture_expected, revision, cases_arg, cases_expected = sys.argv[1:]
assert re.fullmatch('[a-f0-9]{40}', revision)
assert all(re.fullmatch('[a-f0-9]{64}', value) for value in (expected, fixture_expected, cases_expected))
archive, fixtures, cases_path = map(pathlib.Path, (archive_arg, fixture_arg, cases_arg))
assert archive.parent == fixtures.parent == cases_path.parent == pathlib.Path('/tmp')
assert archive.name == 'telomere-yagna-native-doc-20261015.tar.gz'
assert fixtures.name == 'telomere-yagna-native-doc-fixtures-20261015.tar.gz'
assert cases_path.name == 'yagna-native-doc-expected-cases-20261015.json'
assert all(path.is_file() and not path.is_symlink() for path in (archive, fixtures, cases_path))
assert hashlib.sha256(cases_path.read_bytes()).hexdigest() == cases_expected
cases = json.loads(cases_path.read_bytes())
assert cases['gitRevision'] == revision and cases['expectedTotal'] == 27 and cases['expectedSkipped'] == 0
assert len(cases['cases']) == len(set(cases['cases'])) == 27

def manifest_for(path, digest):
    manifest_path = path.with_suffix(path.suffix + '.manifest.json')
    assert manifest_path.is_file() and not manifest_path.is_symlink()
    value = json.loads(manifest_path.read_bytes())
    assert value['gitRevision'] == revision and value['source'] == 'committed_git_blobs_only' and value['workingTreeIncluded'] is False
    assert value['archiveSha256'] == digest == hashlib.sha256(path.read_bytes()).hexdigest()
    assert len({row['path'] for row in value['files']}) == len(value['files'])
    return value

runtime_manifest = manifest_for(archive, expected)
fixture_manifest = manifest_for(fixtures, fixture_expected)
assert len(runtime_manifest['files']) == 708 and len(fixture_manifest['files']) == 12
assert fixture_manifest['upstreamRevision'] == 'c256fce68c50c141a51d4bd2ca18292e4b006f15'
inventory = {row['path']: row for row in runtime_manifest['files']}
supplement = {row['path']: row for row in fixture_manifest['files']}
prefix = 'docs/evidence/golem-allocation-upstream-20261015/'
assert all(name.startswith(prefix) for name in supplement)
assert cases['sourceTestSha256'] == inventory['tests/golem-allocation-attribution.test.ts']['sha256']

parent = pathlib.Path('/opt/telomere-host-runtime')
assert parent.is_dir() and not parent.is_symlink()
target = parent / ('yagna-native-doc-20261015-' + expected[:12])
assert not target.exists()
os.umask(0o077); target.mkdir(mode=0o700)

def extract(path, expected_rows):
    with tarfile.open(path, 'r:gz') as packed:
        members = packed.getmembers()
        assert sorted(row.name for row in members) == sorted(expected_rows)
        for row in members:
            name = pathlib.PurePosixPath(row.name)
            assert row.isfile() and not name.is_absolute() and '..' not in name.parts
            assert not any(part in {'.git', '.local', 'node_modules', '.env'} for part in name.parts)
            raw = packed.extractfile(row).read()
            pin = expected_rows[row.name]
            assert len(raw) == pin['bytes'] and hashlib.sha256(raw).hexdigest() == pin['sha256']
            destination = target / row.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open('xb') as output: output.write(raw)

extract(archive, inventory); extract(fixtures, supplement)
logs = target / '.local'; logs.mkdir(mode=0o700)
for name in ('tmp', 'home', 'cache'): (logs / name).mkdir(mode=0o700)
for filename, source in [('source-manifest.json', archive.with_suffix(archive.suffix + '.manifest.json')),
                         ('upstream-fixture-manifest.json', fixtures.with_suffix(fixtures.suffix + '.manifest.json')),
                         ('expected-cases.json', cases_path)]:
    with (logs / filename).open('xb') as output: output.write(source.read_bytes())

def json_bytes(value): return (json.dumps(value, indent=2) + '\n').encode()
def save(name, value):
    with (logs / name).open('xb') as output: output.write(json_bytes(value))
    return hashlib.sha256((logs / name).read_bytes()).hexdigest()
def verify(rows, directory=target):
    changed = [name for name, pin in rows.items() if not (directory / name).is_file() or (directory / name).is_symlink()
               or (directory / name).stat().st_size != pin['bytes'] or hashlib.sha256((directory / name).read_bytes()).hexdigest() != pin['sha256']]
    return {'unchanged': not changed, 'verified': len(rows), 'changed': changed}
def dependencies(directory):
    assert directory.is_dir() and not directory.is_symlink()
    result = []
    for path in sorted(directory.rglob('*')):
        relative = path.relative_to(directory).as_posix()
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode): continue
        if path.is_symlink():
            assert path.resolve().is_relative_to(directory.resolve())
            result.append({'path': relative, 'kind': 'symlink', 'target': os.readlink(path)})
        else:
            assert stat.S_ISREG(info.st_mode)
            result.append({'path': relative, 'kind': 'file', 'bytes': info.st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    assert 10000 < len(result) < 50000
    return result

units = ['telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service']
def services():
    result = {}
    for name in units:
        value = dict(row.split('=', 1) for row in subprocess.check_output(['systemctl', 'show', name,
            '--property=ActiveState', '--property=SubState', '--property=NRestarts', '--property=MainPID', '--property=WorkingDirectory', '--no-pager'], text=True, timeout=10).strip().splitlines())
        assert value['ActiveState'] == 'active' and value['SubState'] == 'running' and value['NRestarts'] == '0' and int(value['MainPID']) > 1
        result[name] = value
    return result
def health():
    result = {}
    for name in ('live', 'ready'):
        with urllib.request.urlopen('http://127.0.0.1:13280/health/' + name, timeout=10) as response:
            body = json.load(response); assert response.status == 200 and body['status'] == ('ok' if name == 'live' else 'ready')
            result[name] = {'statusCode': response.status, 'body': body}
    return result
def profile(): return hashlib.sha256(pathlib.Path('/opt/telomere-pilot/config/staging.env').read_bytes()).hexdigest()
environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(logs / 'home'), 'LANG': 'C.UTF-8',
               'TMPDIR': str(logs / 'tmp'), 'XDG_CACHE_HOME': str(logs / 'cache'), 'CI': '1'}
report = {'schemaVersion': 1, 'gitRevision': revision, 'baselineRevision': '2298f3f99c9d0d1e22ac8928f71bff7d06ec0135',
          'archiveSha256': expected, 'sourceFiles': len(inventory), 'directory': str(target),
          'changedRuntimePaths': ['src/suppliers/golem-allocation-attribution.ts', 'tests/golem-allocation-attribution.test.ts'],
          'upstreamFixtures': {'files': len(supplement), 'archiveSha256': fixture_expected, 'upstreamRevision': fixture_manifest['upstreamRevision']},
          'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'serviceMutations': False,
          'publicTransactions': 0, 'paidProviderRequests': 0, 'productionYagna': False, 'hardwareAttestation': False}
source_dependencies = parent / 'backend-completion-final-20261015-090932a350a5/node_modules'
source_package = source_dependencies.parent / 'package-lock.json'
assert hashlib.sha256(source_package.read_bytes()).hexdigest() == inventory['package-lock.json']['sha256']
original_manifest_path = source_dependencies.parent / '.local/source-manifest.json'
assert original_manifest_path.is_file() and not original_manifest_path.is_symlink()
original_manifest = json.loads(original_manifest_path.read_bytes())
assert original_manifest['gitRevision'] == 'd4481aec92179df44a533699897db2f523fbd0a2'
assert original_manifest['archiveSha256'] == '090932a350a522ddfe2c056775edf194176060c3cca79a06d286e5d3f1989bd6'
original_inventory = {row['path']: row for row in original_manifest['files']}
assert len(original_inventory) == len(original_manifest['files']) == 708
with (logs / 'original-source-manifest.json').open('xb') as output: output.write(original_manifest_path.read_bytes())
report['originalGitRevision'] = original_manifest['gitRevision']
report['originalSourceManifestSha256'] = hashlib.sha256(original_manifest_path.read_bytes()).hexdigest()
def run(name, command, timeout):
    started = time.monotonic()
    with (logs / (name + '.log')).open('xb') as output:
        child = subprocess.Popen(command, cwd=target, env=environment, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try: child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            report[name + 'TimedOut'] = True; os.killpg(child.pid, signal.SIGTERM)
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=10)
    report[name] = {'exitCode': child.returncode, 'seconds': round(time.monotonic() - started, 3), 'command': command}
    print(json.dumps({'completed': name, **report[name]}), flush=True)
    return child.returncode == 0

success = False
dependencies_before = None; source_dependencies_before = None
try:
    report['servicesBefore'] = services(); report['healthBefore'] = health(); report['profileBeforeSha256'] = profile()
    assert report['profileBeforeSha256'] == 'a400feb3475b91168a5419d0a98c00ea804ba817c1c0ad34dea65d7d8808df8f'
    report['nodeVersion'] = subprocess.check_output(['node', '--version'], env=environment, text=True).strip()
    assert report['nodeVersion'] == 'v22.23.3'
    report['sourceBefore'] = verify(inventory); report['supplementBefore'] = verify(supplement)
    report['originalSourceBefore'] = verify(original_inventory, source_dependencies.parent)
    assert report['sourceBefore']['unchanged'] and report['supplementBefore']['unchanged'] and report['originalSourceBefore']['unchanged']
    report['supplementBeforeSha256'] = save('upstream-fixture-inventory-before.json', report['supplementBefore'])
    source_dependencies_before = dependencies(source_dependencies)
    report['sourceDependencyInventoryBeforeSha256'] = save('source-dependency-inventory-before.json', source_dependencies_before)
    shutil.copytree(source_dependencies, target / 'node_modules', symlinks=True)
    dependencies_before = dependencies(target / 'node_modules')
    assert dependencies_before == source_dependencies_before
    report['dependencyInventoryBeforeSha256'] = save('dependency-inventory-before.json', dependencies_before)
    assert run('typecheck', ['node', 'node_modules/typescript/bin/tsc', '--noEmit'], 600)
    assert run('reader', ['node', 'node_modules/vitest/vitest.mjs', 'run', 'tests/golem-allocation-attribution.test.ts',
        '--no-cache', '--reporter=json', '--outputFile=.local/vitest.json'], 600)
    raw = json.loads((logs / 'vitest.json').read_bytes())
    rows = raw['testResults']; all_cases = [case for row in rows for case in row['assertionResults']]
    assert len(rows) == 1 and pathlib.Path(rows[0]['name']) == target / 'tests/golem-allocation-attribution.test.ts'
    assert raw['success'] is True and raw['numTotalTests'] == raw['numPassedTests'] == len(all_cases) == 27
    assert raw['numFailedTests'] == raw['numPendingTests'] == raw['numTodoTests'] == 0
    assert all(case['status'] == 'passed' for case in all_cases)
    assert sorted(case['fullName'] for case in all_cases) == cases['cases']
    assert any(case['fullName'] == 'refuses an actual filesystem symlink instead of following a reviewed database name' for case in all_cases)
    report['nodeTests'] = {key: raw[key] for key in ('numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests', 'success')}
    report['caseNames'] = sorted(case['fullName'] for case in all_cases)
    report['posixSymlinkExercised'] = True
    success = True
except Exception as error:
    report['failureType'] = type(error).__name__
finally:
    report['sourceAfter'] = verify(inventory); report['supplementAfter'] = verify(supplement)
    report['originalSourceAfter'] = verify(original_inventory, source_dependencies.parent)
    report['supplementAfterSha256'] = save('upstream-fixture-inventory-after.json', report['supplementAfter'])
    try:
        report['servicesAfter'] = services(); report['healthAfter'] = health(); report['profileAfterSha256'] = profile()
        assert report['servicesAfter'] == report['servicesBefore'] and report['profileAfterSha256'] == report['profileBeforeSha256']
        source_after = dependencies(source_dependencies)
        report['sourceDependencyInventoryAfterSha256'] = save('source-dependency-inventory-after.json', source_after)
        assert source_after == source_dependencies_before
        deps_after = dependencies(target / 'node_modules')
        report['dependencyInventoryAfterSha256'] = save('dependency-inventory-after.json', deps_after)
        assert deps_after == dependencies_before
        report['dependenciesUnchanged'] = True
    except Exception as error:
        report['postflightFailureType'] = type(error).__name__; success = False
    report['success'] = bool(success and report['sourceAfter']['unchanged'] and report['supplementAfter']['unchanged'] and report['originalSourceAfter']['unchanged'])
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save('acceptance.json', report)
    print(json.dumps({'success': report['success'], 'directory': str(target), 'nodeTests': report.get('nodeTests'), 'failureType': report.get('failureType'), 'postflightFailureType': report.get('postflightFailureType')}), flush=True)
sys.exit(0 if report['success'] else 1)
