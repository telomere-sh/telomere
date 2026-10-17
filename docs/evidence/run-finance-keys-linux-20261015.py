import datetime, hashlib, json, os, pathlib, signal, subprocess, sys, tarfile, time, urllib.request

archive, manifest_path, expected = map(str, sys.argv[1:])
assert len(expected) == 64 and all(c in '0123456789abcdef' for c in expected)
archive = pathlib.Path(archive)
manifest_path = pathlib.Path(manifest_path)
assert archive.parent == manifest_path.parent == pathlib.Path('/tmp')
assert archive.name == 'telomere-finance-keys-20261015.tar.gz' and manifest_path.name == archive.name + '.manifest.json'
assert archive.is_file() and not archive.is_symlink() and not manifest_path.is_symlink()
manifest = json.loads(manifest_path.read_bytes())
assert expected == manifest['archiveSha256'] == hashlib.sha256(archive.read_bytes()).hexdigest()
target = pathlib.Path('/opt/telomere-host-runtime') / ('finance-keys-20261015-' + expected[:12])
assert not target.exists()
os.umask(0o077)
target.mkdir(mode=0o700)
inventory = {item['path']: item for item in manifest['files']}
assert len(inventory) == len(manifest['files']) == 685
assert manifest['gitRevision'] == '8d848f20c8dc4a2b3d672013777e1c630ecd233e' and manifest['source'] == 'committed_git_blobs_only'
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
(logs / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
report = {'archiveSha256': expected, 'directory': str(target), 'sourceFiles': len(inventory), 'gitRevision': manifest['gitRevision'],
          'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'serviceMutations': False, 'publicTransactions': 0, 'paidProviderRequests': 0,
          'dockerOptIn': False, 'capacityOptIn': False, 'langgraphOptIn': False}

def health():
    result = {}
    for name in ('live', 'ready'):
        with urllib.request.urlopen('http://127.0.0.1:13280/health/' + name, timeout=10) as response:
            result[name] = {'statusCode': response.status, 'body': json.load(response)}
    return result

def services():
    return {name: subprocess.run(['systemctl', 'show', name, '--property=ActiveState',
            '--property=SubState', '--property=NRestarts', '--no-pager'], capture_output=True,
            text=True, timeout=10, check=True).stdout.strip()
            for name in ('telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service')}

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
    report['nodeVersion'] = subprocess.check_output(['node', '--version'], env=environment, text=True).strip()
    assert report['nodeVersion'] == 'v22.23.3'
    assert all('ActiveState=active' in value for value in report['servicesBefore'].values())
    assert run('npm-ci', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], 600)
    assert run('build', ['npm', 'run', 'build'], 600)
    success = run('finance-keys', ['node', 'node_modules/vitest/vitest.mjs', 'run',
        'tests/sealed-handoff-v3.test.ts', 'tests/sealed-keys-release.test.ts',
        'tests/sealed-keys-signed-appraiser.test.ts', 'tests/golem-finance.test.ts', '--reporter=json',
        '--outputFile=.local/finance-keys.json'], 900)
    raw = json.loads((logs / 'finance-keys.json').read_bytes())
    success = success and raw['success'] and raw['numPassedTests'] == 71 and raw['numFailedTests'] == raw['numPendingTests'] == 0
    report['nodeTests'] = {key: raw[key] for key in ('numTotalTests', 'numPassedTests', 'numFailedTests',
                           'numPendingTests', 'numTotalTestSuites', 'success')}
    report['nodeFailures'] = [{'file': pathlib.Path(item['name']).name,
        'tests': [test['fullName'] for test in item['assertionResults'] if test['status'] == 'failed']}
        for item in raw['testResults'] if item['status'] == 'failed']
except Exception as error:
    report['failureType'] = type(error).__name__
finally:
    changed = [name for name, item in inventory.items() if not (target / name).is_file()
               or (target / name).is_symlink()
               or hashlib.sha256((target / name).read_bytes()).hexdigest() != item['sha256']]
    report['sourceAfter'] = {'unchanged': not changed, 'changed': changed}
    try:
        report['healthAfter'] = health()
        report['servicesAfter'] = services()
        success = success and report['servicesAfter'] == report['servicesBefore']
    except Exception as error:
        report['postflightFailureType'] = type(error).__name__
        success = False
    report['success'] = success and not changed
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (logs / 'acceptance.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, separators=(',', ':')), flush=True)
sys.exit(0 if report['success'] else 1)
