import datetime, hashlib, json, os, pathlib, re, signal, subprocess, sys, tarfile, time, urllib.request

archive_arg, manifest_arg, expected, revision = sys.argv[1:]
assert re.fullmatch('[a-f0-9]{64}', expected) and re.fullmatch('[a-f0-9]{40}', revision)
archive, manifest_path = pathlib.Path(archive_arg), pathlib.Path(manifest_arg)
assert archive.parent == manifest_path.parent == pathlib.Path('/tmp')
assert archive.name == 'telomere-golem-protocol-20261015.tar.gz'
assert manifest_path.name == archive.name + '.manifest.json'
assert archive.is_file() and not archive.is_symlink() and not manifest_path.is_symlink()
manifest = json.loads(manifest_path.read_bytes())
assert manifest['gitRevision'] == revision and manifest['source'] == 'committed_git_blobs_only'
assert manifest['workingTreeIncluded'] is False
assert expected == manifest['archiveSha256'] == hashlib.sha256(archive.read_bytes()).hexdigest()
inventory = {item['path']: item for item in manifest['files']}
assert 685 <= len(inventory) == len(manifest['files']) <= 1000
target = pathlib.Path('/opt/telomere-host-runtime') / ('golem-protocol-20261015-' + expected[:12])
assert not target.exists()
os.umask(0o077)
target.mkdir(mode=0o700)
with tarfile.open(archive, 'r:gz') as packed:
    members = packed.getmembers()
    assert len(members) == len(inventory)
    for item in members:
        name = pathlib.PurePosixPath(item.name)
        assert item.isfile() and not name.is_absolute() and '..' not in name.parts
        assert not any(part in {'.git', '.local', 'node_modules', '.env'} for part in name.parts)
        raw = packed.extractfile(item).read()
        assert len(raw) == inventory[item.name]['bytes']
        assert hashlib.sha256(raw).hexdigest() == inventory[item.name]['sha256']
        destination = target / item.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open('xb') as output:
            output.write(raw)
logs = target / '.local'
logs.mkdir(mode=0o700)
(logs / 'source-manifest.json').write_bytes(manifest_path.read_bytes())
environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
units = ['telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service']
report = {'schemaVersion': 1, 'gitRevision': revision, 'archiveSha256': expected, 'sourceFiles': len(inventory),
          'directory': str(target), 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'serviceMutations': False, 'publicTransactions': 0, 'paidProviderRequests': 0,
          'actualDisposableAnvil': True, 'productionYagna': False, 'hardwareAttestation': False}
cohort_files = sorted(name for name in inventory if re.fullmatch(r'tests/(?:golem-|supplier-)[^/]+\.test\.ts', name))
assert len(cohort_files) >= 5
report['testFiles'] = cohort_files

def health():
    result = {}
    for name in ('live', 'ready'):
        with urllib.request.urlopen('http://127.0.0.1:13280/health/' + name, timeout=10) as response:
            result[name] = {'statusCode': response.status, 'body': json.load(response)}
            assert response.status == 200
            assert result[name]['body']['status'] == ('ok' if name == 'live' else 'ready')
    return result

def services():
    return {name: subprocess.check_output(['systemctl', 'show', name, '--property=ActiveState',
        '--property=SubState', '--property=NRestarts', '--property=MainPID', '--property=WorkingDirectory',
        '--no-pager'], text=True, timeout=10).strip() for name in units}

def protected_profile_hash():
    return hashlib.sha256(pathlib.Path('/opt/telomere-pilot/config/staging.env').read_bytes()).hexdigest()

def run(name, command, timeout):
    started = time.monotonic()
    with (logs / (name + '.log')).open('wb') as output:
        child = subprocess.Popen(command, cwd=target, env=environment, stdout=output,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            report[name + 'TimedOut'] = True
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=10)
    report[name] = {'exitCode': child.returncode, 'seconds': round(time.monotonic() - started, 3)}
    print(json.dumps({'completed': name, **report[name]}), flush=True)
    return child.returncode == 0

success = False
try:
    report['healthBefore'] = health()
    report['servicesBefore'] = services()
    report['protectedProfileBeforeSha256'] = protected_profile_hash()
    report['nodeVersion'] = subprocess.check_output(['node', '--version'], env=environment, text=True).strip()
    assert report['nodeVersion'] == 'v22.23.3'
    assert all('ActiveState=active' in value for value in report['servicesBefore'].values())
    assert run('npm-ci', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], 600)
    assert run('build', ['npm', 'run', 'build'], 600)
    assert run('golem-protocol', ['node', 'node_modules/vitest/vitest.mjs', 'run', *cohort_files,
        '--reporter=json', '--outputFile=.local/golem-protocol.json'], 900)
    raw = json.loads((logs / 'golem-protocol.json').read_bytes())
    executed_files = sorted(pathlib.Path(row['name']).relative_to(target).as_posix() for row in raw['testResults'])
    all_cases = [case for row in raw['testResults'] for case in row['assertionResults']]
    success = raw['success'] and raw['numFailedTests'] == raw['numPendingTests'] == 0 and executed_files == cohort_files
    success = success and raw['numPassedTests'] == raw['numTotalTests'] == len(all_cases) == 181
    success = success and all(case['status'] == 'passed' for case in all_cases)
    report['nodeTests'] = {key: raw[key] for key in ('numTotalTests', 'numPassedTests', 'numFailedTests',
        'numPendingTests', 'numTotalTestSuites', 'success')}
    report['breakdown'] = {pathlib.Path(row['name']).name: len(row['assertionResults']) for row in raw['testResults']}
except Exception as error:
    report['failureType'] = type(error).__name__
    success = False
finally:
    changed = [name for name, item in inventory.items() if not (target / name).is_file()
        or (target / name).is_symlink() or hashlib.sha256((target / name).read_bytes()).hexdigest() != item['sha256']]
    report['sourceAfter'] = {'unchanged': not changed, 'changed': changed}
    try:
        report['healthAfter'] = health()
        report['servicesAfter'] = services()
        report['protectedProfileAfterSha256'] = protected_profile_hash()
        success = success and report['servicesAfter'] == report['servicesBefore']
        success = success and report['protectedProfileAfterSha256'] == report['protectedProfileBeforeSha256']
    except Exception as error:
        report['postflightFailureType'] = type(error).__name__
        success = False
    remaining = []
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            argv = (entry / 'cmdline').read_bytes()
            if b'anvil' in argv and str(target).encode() in argv:
                remaining.append(int(entry.name))
        except (FileNotFoundError, PermissionError):
            pass
    report['ownedAnvilProcessesRemaining'] = remaining
    report['success'] = bool(success and not changed and not remaining)
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (logs / 'acceptance.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, separators=(',', ':')), flush=True)
sys.exit(0 if report['success'] else 1)
