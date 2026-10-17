import datetime, hashlib, json, os, pathlib, signal, subprocess, sys, tarfile, time, urllib.request

archive, manifest_path = map(pathlib.Path, sys.argv[1:])
assert archive.parent == manifest_path.parent == pathlib.Path('/tmp')
assert archive.name == 'telomere-backend-current-20261015.tar.gz' and manifest_path.name == archive.name + '.manifest.json'
manifest = json.loads(manifest_path.read_bytes())
expected = '3e901e235bb9e50ff4c8dea8312aa05da7364f4865aa3c46014cb5a806122a49'
revision = 'b042c1bc3119754e06f6b662f2e46c108a63db36'
assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected == manifest['archiveSha256']
assert manifest['gitRevision'] == revision and manifest['source'] == 'committed_git_blobs_only'
target = pathlib.Path('/opt/telomere-host-runtime/backend-current-20261015-' + expected[:12])
assert not target.exists()
os.umask(0o077); target.mkdir(mode=0o700)
inventory = {item['path']: item for item in manifest['files']}
assert len(inventory) == len(manifest['files']) == 677
with tarfile.open(archive, 'r:gz') as packed:
    members = packed.getmembers(); assert len(members) == len(inventory)
    for item in members:
        name = pathlib.PurePosixPath(item.name)
        assert item.isfile() and not name.is_absolute() and '..' not in name.parts
        assert not any(part in {'.git', '.local', 'node_modules', '.env'} for part in name.parts)
        raw = packed.extractfile(item).read()
        assert len(raw) == inventory[item.name]['bytes'] and hashlib.sha256(raw).hexdigest() == inventory[item.name]['sha256']
        destination = target / item.name; destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open('xb') as output: output.write(raw)
logs = target / '.local'; logs.mkdir(mode=0o700)
(logs / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
socket = '/run/telomere-file-accept-20261015/docker.sock'
image = '127.0.0.1:15002/telomere-cpu@sha256:6839949540d11906cbdbc614867ac3a825fa0e6f8cbed90c79773979517b4bbe'
protected = '1d7ecc9b94866b9617df656ad7e2251916a9b7ceafef9a488ef6e85540076c5e'
docker = ['docker', '--host', 'unix://' + socket]
report = {'archiveSha256': expected, 'gitRevision': revision, 'directory': str(target), 'sourceFiles': len(inventory),
    'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'publicTransactions': 0, 'paidProviderRequests': 0,
    'stagingServiceMutations': False, 'dedicatedAcceptanceDaemonAlreadyProvisioned': True, 'gvisorSocket': socket, 'image': image}
def cmd(args): return subprocess.check_output(args, env=environment, text=True, timeout=30).strip()
def protected_container():
    raw = cmd(docker + ['inspect', protected]); data = json.loads(raw)[0]
    return {'id': data['Id'], 'name': data['Name'], 'imageId': data['Image'], 'status': data['State']['Status'],
        'labels': data['Config']['Labels'], 'metadataSha256': hashlib.sha256(raw.encode()).hexdigest()}
def services():
    return {name: cmd(['systemctl', 'show', name, '--property=ActiveState', '--property=SubState', '--property=NRestarts', '--no-pager'])
        for name in ['telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service']}
def health():
    result = {}
    for name in ['live', 'ready']:
        with urllib.request.urlopen('http://127.0.0.1:13280/health/' + name, timeout=10) as response:
            result[name] = {'statusCode': response.status, 'body': json.load(response)}
    return result
def run(name, args, timeout, extra=None):
    started = time.monotonic()
    with (logs / (name + '.log')).open('wb') as output:
        child = subprocess.Popen(args, cwd=target, env={**environment, **(extra or {})}, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try: child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            report[name + 'TimedOut'] = True; os.killpg(child.pid, signal.SIGTERM)
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=10)
    report[name] = {'exitCode': child.returncode, 'seconds': round(time.monotonic() - started, 3)}
    print(json.dumps({'completed': name, **report[name]}), flush=True)
    return child.returncode == 0
success = False
try:
    report['servicesBefore'] = services(); report['healthBefore'] = health()
    assert all('ActiveState=active' in value for value in report['servicesBefore'].values())
    assert cmd(['systemctl', 'is-active', 'telomere-file-accept-20261015.service']) == 'active'
    report['protectedContainerBefore'] = protected_container()
    assert report['protectedContainerBefore']['status'] == 'exited' and report['protectedContainerBefore']['labels'] == {}
    report['imageId'] = cmd(docker + ['image', 'inspect', image, '--format', '{{.Id}}'])
    assert report['imageId'] == 'sha256:680cc0ec7dfa626d4105c3c26834289687e0abed785240e5bb814bac7cd55355'
    assert run('npm-ci', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], 600)
    assert run('build', ['npm', 'run', 'build'], 600)
    success = run('paid-file-gvisor', ['node', 'node_modules/vitest/vitest.mjs', 'run',
        'tests/cyst-input-spool.test.ts', 'tests/paid-cyst-input-recovery.test.ts', 'tests/paid-cyst-file-restore.test.ts',
        'tests/paid-cyst-input-app.test.ts', 'tests/paid-cyst-input-config.test.ts', 'tests/paid-cyst-file-cache-expiry.test.ts', '--reporter=json', '--outputFile=.local/paid-file-gvisor.json'],
        900, {'TELOMERE_ACCEPTANCE_GVISOR_SOCKET': socket, 'TELOMERE_ACCEPTANCE_GVISOR_IMAGE': image})
    raw = json.loads((logs / 'paid-file-gvisor.json').read_bytes())
    report['tests'] = {key: raw[key] for key in ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'success']}
    success = success and raw['numPassedTests'] == 16 and raw['numFailedTests'] == raw['numPendingTests'] == 0 and raw['success']
    gvisor_success = success
    node_success = run('node-full', ['node', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=json',
        '--outputFile=.local/node-full.json'], 5400)
    node_raw = json.loads((logs / 'node-full.json').read_bytes())
    report['nodeTests'] = {key: node_raw[key] for key in ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTotalTestSuites', 'success']}
    report['nodeFailures'] = [{'file': pathlib.Path(item['name']).name,
        'tests': [test['fullName'] for test in item['assertionResults'] if test['status'] == 'failed'], 'message': item.get('message', '')[:2000]}
        for item in node_raw['testResults'] if item['status'] == 'failed']
    success = gvisor_success and node_success and node_raw['success'] and node_raw['numFailedTests'] == 0 and node_raw['numTotalTests'] >= 2184
except Exception as error: report['failureType'] = type(error).__name__
finally:
    report['sourceChangedAfter'] = [name for name, item in inventory.items() if not (target / name).is_file()
        or (target / name).is_symlink() or hashlib.sha256((target / name).read_bytes()).hexdigest() != item['sha256']]
    try:
        report['healthAfter'] = health(); report['servicesAfter'] = services()
        report['protectedContainerAfter'] = protected_container()
        report['ownedSessionContainersAfter'] = cmd(docker + ['ps', '--all', '--filter', 'label=telomere.session', '--format', '{{.ID}}'])
        success = success and report['servicesAfter'] == report['servicesBefore'] and report['protectedContainerAfter'] == report['protectedContainerBefore']
        success = success and report['ownedSessionContainersAfter'] == ''
    except Exception as error: report['postflightFailureType'] = type(error).__name__; success = False
    report['success'] = bool(success and not report['sourceChangedAfter'])
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (logs / 'acceptance.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ['archiveSha256', 'gitRevision', 'sourceFiles', 'sourceChangedAfter', 'success', 'finishedAt']}
        | {key: report[key] for key in ['tests', 'nodeTests', 'nodeFailures', 'failureType', 'postflightFailureType'] if key in report}), flush=True)
sys.exit(0 if report['success'] else 1)
