"""Read-only final check. Run on the VPS only after actual attempt04 activation."""
import datetime, grp, hashlib, json, pathlib, stat, subprocess, urllib.request

REV = '354fe7af62ea6701faafc3b04522abb1b4524d2d'
SHA = '86b5dc9f36dcf841963f0ffa8161023c126f1fae473c94909f5dddae3040fdce'
RUN = 'staging-354fe7af62ea-launch04'
BASE = pathlib.Path('/opt/telomere-pilot')
work = BASE / 'rollout' / RUN
operator = pathlib.Path('/opt/telomere-host-runtime/private-staging-operator-20261015-354fe7af62ea-attempt04')
NODE = '/opt/node-v22.23.3-linux-x64/bin/node'
units = ['telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service']

def checksum(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def obj(path): return json.loads(path.read_bytes())
def command(args): return subprocess.check_output(args, text=True, timeout=20).strip()
def unit(name):
    raw = command(['systemctl', 'show', name, '--property=ActiveState', '--property=SubState',
        '--property=LoadState', '--property=MainPID', '--property=NRestarts', '--property=WorkingDirectory'])
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)

state = obj(work / 'state.json')
assert state['stage'] == 'activated' and state['run'] == RUN
assert state['heldStop']['active'] is False and state['heldStop']['phase'] == 'activated'
assert state['revision'] == REV and state['archiveSha256'] == SHA
release = pathlib.Path(state['release'])
assert release == BASE / 'releases' / (REV + '-launch04') and release.resolve() == release
manifest = obj(operator / 'telomere-selection-composed-20261015.tar.gz.manifest.json')
assert manifest['gitRevision'] == REV and manifest['archiveSha256'] == SHA and len(manifest['files']) == 685
assert checksum(work / 'clone-smoke.mjs') == state['nodeHelperSha256']
assert checksum(operator / 'rollout.py') == state['runnerSha256']
assert checksum(work / 'source-manifest.json') == state['sourceManifestSha256']
assert checksum(work / 'release-pins.json') == state['releasePinsSha256']
pins = obj(work / 'release-pins.json')
assert pins['source'] == {row['path']: {'bytes': row['bytes'], 'sha256': row['sha256']} for row in manifest['files']}
group = grp.getgrnam('telomere').gr_gid
bad = []
for row in manifest['files']:
    name = pathlib.PurePosixPath(row['path'])
    assert not name.is_absolute() and '..' not in name.parts
    path = release / str(name)
    meta = path.lstat()
    if not (stat.S_ISREG(meta.st_mode) and meta.st_uid == 0 and meta.st_gid == group
        and stat.S_IMODE(meta.st_mode) in (0o640, 0o750)
        and meta.st_size == row['bytes'] and checksum(path) == row['sha256']): bad.append(row['path'])
assert not bad
runtime_paths = {path.relative_to(release).as_posix() for path in (release / 'dist').rglob('*') if path.is_file()}
assert runtime_paths == set(pins['runtime']) and 'dist/src/main.js' in runtime_paths
for name, value in pins['runtime'].items():
    path = release / name
    assert pathlib.PurePosixPath(name).parts[0] == 'dist' and '..' not in pathlib.PurePosixPath(name).parts
    meta = path.lstat()
    assert stat.S_ISREG(meta.st_mode) and meta.st_uid == 0 and meta.st_gid == group
    assert stat.S_IMODE(meta.st_mode) in (0o640, 0o750)
    assert meta.st_size == value['bytes'] and checksum(path) == value['sha256']
assert all((release / parent).stat().st_uid == 0 for parent in ['', 'dist', 'node_modules'])
before = {name: unit(name) for name in units}
assert all(value['ActiveState'] == 'active' and value['SubState'] == 'running'
    and value['NRestarts'] == state['originalUnitStates'][name]['NRestarts']
    and int(value['MainPID']) > 0 for name, value in before.items())
assert before[units[0]]['WorkingDirectory'] == str(release)
assert before[units[1]]['WorkingDirectory'] == str(BASE / 'app')
assert before[units[2]]['WorkingDirectory'] == str(BASE / 'watchdog-app')
pid = before[units[0]]['MainPID']
proc = pathlib.Path('/proc') / pid
cmdline = proc.joinpath('cmdline').read_bytes().rstrip(b'\0').split(b'\0')
identity = {'executableMatches': str(proc.joinpath('exe').resolve()) == NODE,
    'cwdMatches': proc.joinpath('cwd').resolve() == release,
    'argvMatches': cmdline == [NODE.encode(), str(release / 'dist/src/main.js').encode()]}
assert all(identity.values())
dropin = pathlib.Path(state['controllerDropin'])
assert dropin == pathlib.Path('/etc/systemd/system/telomere-staging.service.d/90-telomere-reviewed-release.conf')
assert not dropin.is_symlink() and checksum(dropin) == state['controllerDropinSha256']
health = {}
for name in ['live', 'ready']:
    with urllib.request.urlopen('http://127.0.0.1:13280/health/' + name, timeout=5) as response:
        value = json.load(response)
        assert response.status == 200 and value['status'] == ('ok' if name == 'live' else 'ready')
        health[name] = {'code': response.status, 'status': value['status']}
after = {name: unit(name) for name in units}
assert before == after
for name in [RUN, 'staging-354fe7af62ea-final04']:
    namespace = 'tlmr-roll-' + hashlib.sha256(name.encode()).hexdigest()[:12]
    assert not pathlib.Path('/run/netns', namespace).exists()
    assert not command(['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', 'ps', '--all',
        '--filter', 'label=telomere.rollout.owner=' + name, '--quiet'])
    for service in ['telomere-' + namespace + '.service',
        'telomere-' + name + '-latest.service', 'telomere-' + name + '-old.service']:
        value = unit(service)
        assert value['ActiveState'] in ['inactive', 'failed'] and value['MainPID'] in ['0', '']
result = {'schemaVersion': 1, 'kind': 'readonly_actual_private_staging_runtime_identity',
    'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'status': 'passed',
    'run': RUN, 'revision': REV, 'archiveSha256': SHA, 'sourceFilesVerified': len(manifest['files']),
    'allSourceBytesAndRootOwnershipVerified': True, 'runtimeFilesVerified': len(runtime_paths),
    'allGeneratedRuntimeBytesAndRootOwnershipVerified': True, 'controllerProcess': identity,
    'controllerDropinHashVerified': True, 'threeUnitsActiveAndStable': True,
    'unitRestartsUnchanged': True, 'source': str(release), 'health': health,
    'ownedRehearsalAndFinalCloneContainersNamespacesUnitsRemaining': 0,
    'resourceObservationScope': 'exact owner-labelled global containers, netns and helper/daemon units; no independent Anvil process scan',
    'profileOrEnvironmentRead': False,
    'transactionsSent': 0, 'paidRequests': 0}
print(json.dumps(result, separators=(',', ':')))
