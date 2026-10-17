import datetime, hashlib, json, os, pathlib, signal, subprocess, sys, tarfile, time, urllib.request

expected = 'c1412023c81538ddbab00b92f7d074d97e42f9239e6dc9ca51f6080f27944582'
commit = 'c2ed573f700ce2313a405395e2b94443afb3c79f'
archive = pathlib.Path('/tmp/telomere-supplier-journals-20261015.tar.gz')
manifest_path = pathlib.Path(str(archive) + '.manifest.json')
target = pathlib.Path('/opt/telomere-host-runtime/supplier-journals-20261015-c1412023c815')
assert archive.is_file() and not archive.is_symlink() and not manifest_path.is_symlink()
manifest = json.loads(manifest_path.read_bytes())
assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected == manifest['archiveSha256']
assert manifest['gitRevision'] == commit and manifest['source'] == 'committed_git_blobs_only'
assert manifest['workingTreeIncluded'] is False and not target.exists()
inventory = {item['path']: item for item in manifest['files']}
assert len(inventory) == len(manifest['files']) == 671
os.umask(0o077)
target.mkdir(mode=0o700)
with tarfile.open(archive, 'r:gz') as packed:
    members = packed.getmembers()
    assert len(members) == len(inventory)
    for member in members:
        name = pathlib.PurePosixPath(member.name)
        assert member.isfile() and not name.is_absolute() and '..' not in name.parts
        assert not any(part in {'.git', '.local', 'node_modules', '.env'} for part in name.parts)
        original = inventory[member.name]
        raw = packed.extractfile(member).read()
        assert len(raw) == original['bytes'] and hashlib.sha256(raw).hexdigest() == original['sha256']
        destination = target / member.name
        assert target in destination.resolve().parents
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open('xb') as output:
            output.write(raw)
logs = target / '.local'
logs.mkdir(mode=0o700)
(logs / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
report = {'schemaVersion': 1, 'gitRevision': commit, 'archiveSha256': expected,
          'manifestSha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
          'directory': str(target), 'sourceFiles': len(inventory),
          'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'serviceMutations': False, 'publicTransactions': 0, 'paidProviderRequests': 0,
          'dockerOptIn': False, 'scope': 'Local supplier journal filesystem and protocol-fixture acceptance only'}

def source_snapshot():
    result = {}
    for name in inventory:
        path = target / name
        assert path.is_file() and not path.is_symlink()
        raw = path.read_bytes()
        result[name] = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
    return result

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
    report[name] = {'command': command, 'exitCode': child.returncode, 'seconds': round(time.monotonic() - started, 3)}
    (logs / 'progress.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'completed': name, 'exitCode': child.returncode, 'seconds': report[name]['seconds']}), flush=True)
    return child.returncode == 0

success = False
try:
    before = source_snapshot()
    assert all(item['sha256'] == inventory[name]['sha256'] and item['bytes'] == inventory[name]['bytes'] for name, item in before.items())
    (logs / 'source-before.json').write_text(json.dumps(before, indent=2) + '\n')
    report['sourceBefore'] = {'files': len(before), 'allMatchArchive': True,
                              'sha256': hashlib.sha256((logs / 'source-before.json').read_bytes()).hexdigest()}
    report['healthBefore'] = health()
    report['servicesBefore'] = services()
    report['nodeVersion'] = subprocess.check_output(['node', '--version'], env=environment, text=True).strip()
    report['npmVersion'] = subprocess.check_output(['npm', '--version'], env=environment, text=True).strip()
    report['platform'] = subprocess.check_output(['uname', '-srm'], env=environment, text=True).strip()
    assert all('ActiveState=active' in value for value in report['servicesBefore'].values())
    assert run('npm-ci', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], 600)
    assert run('build', ['npm', 'run', 'build'], 600)
    cohort = ['tests/supplier-private-journal.test.ts', 'tests/supplier-akash.test.ts',
              'tests/supplier-akash-lease.test.ts', 'tests/supplier-akash-close.test.ts',
              'tests/supplier-akash-signed-binding.test.ts', 'tests/supplier-nosana.test.ts',
              'tests/supplier-shared-reserve.test.ts', 'tests/supplier-akash-exact-bid.test.ts',
              'tests/supplier-akash-escrow-observation.test.ts', 'tests/supplier-golem-stats.test.ts']
    success = run('supplier-focused', ['node', 'node_modules/vitest/vitest.mjs', 'run', *cohort,
                                     '--reporter=json', '--outputFile=.local/supplier-focused.json'], 900)
    raw = json.loads((logs / 'supplier-focused.json').read_bytes())
    report['tests'] = {key: raw[key] for key in ('numTotalTests', 'numPassedTests', 'numFailedTests',
                      'numPendingTests', 'numTotalTestSuites', 'success')}
    report['failures'] = [{'file': pathlib.Path(item['name']).name,
        'tests': [{'name': test['fullName'], 'failureMessages': test['failureMessages']} for test in item['assertionResults'] if test['status'] == 'failed'],
        'message': item.get('message', '')} for item in raw['testResults'] if item['status'] == 'failed']
    success = success and raw['success'] and raw['numPassedTests'] == 106 and raw['numPendingTests'] == 0
except Exception as error:
    report['failureType'] = type(error).__name__
finally:
    try:
        after = source_snapshot()
        (logs / 'source-after.json').write_text(json.dumps(after, indent=2) + '\n')
        changed = [name for name, item in after.items() if item['sha256'] != inventory[name]['sha256'] or item['bytes'] != inventory[name]['bytes']]
        report['sourceAfter'] = {'files': len(after), 'unchanged': not changed, 'changed': changed,
                                'sha256': hashlib.sha256((logs / 'source-after.json').read_bytes()).hexdigest()}
        success = success and not changed
    except Exception as error:
        report['sourceAfterFailureType'] = type(error).__name__
        success = False
    try:
        report['healthAfter'] = health()
        report['servicesAfter'] = services()
        report['stagingServicesUnchanged'] = report['servicesAfter'] == report['servicesBefore']
        success = success and report['stagingServicesUnchanged']
    except Exception as error:
        report['postflightFailureType'] = type(error).__name__
        success = False
    report['success'] = success
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (logs / 'acceptance.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'success': success, 'tests': report.get('tests'), 'sourceAfter': report.get('sourceAfter'),
                      'stagingServicesUnchanged': report.get('stagingServicesUnchanged'),
                      'failureType': report.get('failureType')}), flush=True)
sys.exit(0 if success else 1)
