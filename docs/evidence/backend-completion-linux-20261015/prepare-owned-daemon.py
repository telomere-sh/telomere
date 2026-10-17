import datetime, hashlib, json, os, pathlib, re, stat, subprocess, time, urllib.request

work = pathlib.Path('/opt/telomere-host-runtime/declared-state-gvisor-20261015')
run = pathlib.Path('/run/telomere-declared-accept-20261015')
namespace = 'tlmr-declared-accept-20261015'
unit = 'telomere-declared-accept-20261015.service'
data = pathlib.Path('/opt/telomere-host-runtime/docker-data')
socket = run / 'docker.sock'
base_image = '127.0.0.1:15002/telomere-cpu@sha256:6839949540d11906cbdbc614867ac3a825fa0e6f8cbed90c79773979517b4bbe'
base_id = 'sha256:680cc0ec7dfa626d4105c3c26834289687e0abed785240e5bb814bac7cd55355'
protected = '1d7ecc9b94866b9617df656ad7e2251916a9b7ceafef9a488ef6e85540076c5e'
services = ['telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service']

def command(args, timeout=30):
    return subprocess.check_output(args, text=True, timeout=timeout, stderr=subprocess.DEVNULL).strip()

def service_state():
    return {name: command(['systemctl', 'show', name, '--property=ActiveState', '--property=SubState',
        '--property=NRestarts', '--property=MainPID', '--property=WorkingDirectory']) for name in services}

def profile_hash():
    return hashlib.sha256(pathlib.Path('/opt/telomere-pilot/config/staging.env').read_bytes()).hexdigest()

before = service_state()
assert all('ActiveState=active' in value for value in before.values())
assert data.resolve() == data and data.is_dir() and not data.is_symlink()
assert pathlib.Path('/opt/telomere-host-runtime/gvisor/runsc').is_file()
assert not work.exists() and not run.exists() and not pathlib.Path('/run/netns', namespace).exists()
active_data_roots = {}
for entry in pathlib.Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue
    try:
        argv = (entry / 'cmdline').read_bytes().split(b'\0')
    except (FileNotFoundError, PermissionError):
        continue
    if argv and argv[0].endswith(b'dockerd'):
        roots = []
        for index, argument in enumerate(argv):
            if argument.startswith(b'--data-root='):
                roots.append(argument.split(b'=', 1)[1].decode())
            elif argument == b'--data-root':
                assert index + 1 < len(argv)
                roots.append(argv[index + 1].decode())
        if roots:
            assert len(roots) == 1 and pathlib.Path(roots[0]).is_absolute(), 'Ambiguous active Docker data root'
            active_root = pathlib.Path(roots[0]).resolve()
        else:
            # Resolve the actual live daemon, never mutable configuration text.
            pidfile = pathlib.Path('/run/docker.pid')
            pid_stat = pidfile.lstat()
            assert stat.S_ISREG(pid_stat.st_mode) and not pidfile.is_symlink() and pid_stat.st_uid == 0 and pid_stat.st_size <= 32
            assert pidfile.read_text().strip() == entry.name, 'Unresolved active Docker data-root owner'
            actual = command(['docker', '--host', 'unix:///var/run/docker.sock', 'info', '--format', '{{.DockerRootDir}}'])
            assert pathlib.Path(actual).is_absolute()
            active_root = pathlib.Path(actual).resolve()
        assert active_root != data, 'Owned acceptance data root already has a daemon'
        active_data_roots[entry.name] = str(active_root)
assert command(['systemctl', 'show', unit, '--property=LoadState', '--value']) == 'not-found'
os.umask(0o077)
work.mkdir(mode=0o700)
run.mkdir(mode=0o700)
config = work / 'daemon.json'
config.write_text(json.dumps({'insecure-registries': ['127.0.0.1:15004']}) + '\n')
report = {'schemaVersion': 1, 'status': 'preparing', 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'work': str(work), 'run': str(run), 'socket': str(socket), 'namespace': namespace, 'unit': unit,
    'dataRoot': str(data), 'protectedContainerId': protected, 'servicesBefore': before,
    'profileBeforeSha256': profile_hash(), 'publicTransactions': 0, 'paidProviderRequests': 0,
    'stagingServiceMutations': False, 'newOwnedAcceptanceDaemon': True, 'otherActiveDockerDataRoots': active_data_roots}
state = work / 'prepare.json'
state.write_text(json.dumps(report, indent=2) + '\n')
try:
    command(['ip', 'netns', 'add', namespace])
    command(['ip', '-n', namespace, 'link', 'set', 'lo', 'up'])
    command(['systemd-run', '--unit=' + unit, '--property=Delegate=yes', '--property=Restart=no',
        '/usr/bin/nsenter', '--net=/run/netns/' + namespace, '/usr/bin/dockerd', '--config-file=' + str(config),
        '--host=unix://' + str(socket), '--data-root=' + str(data), '--exec-root=' + str(run / 'exec'),
        '--pidfile=' + str(run / 'docker.pid'), '--containerd-namespace=' + namespace,
        '--containerd-plugins-namespace=' + namespace + '-plugins', '--bridge=none', '--iptables=false',
        '--ip6tables=false', '--ip-masq=false', '--storage-driver=vfs',
        '--add-runtime=runsc=/opt/telomere-host-runtime/gvisor/runsc'])
    docker = ['docker', '--host', 'unix://' + str(socket)]
    ready = False
    for _ in range(30):
        try:
            command(docker + ['info', '--format', '{{.Driver}}'], timeout=5)
            ready = True
            break
        except (subprocess.SubprocessError, OSError):
            time.sleep(1)
    assert ready and command(docker + ['info', '--format', '{{.Driver}}']) == 'vfs'
    assert command(docker + ['image', 'inspect', base_image, '--format', '{{.Id}}']) == base_id
    containers = command(docker + ['ps', '--all', '--quiet', '--no-trunc']).splitlines()
    assert containers == [protected]
    protected_raw = command(docker + ['inspect', protected])
    protected_value = json.loads(protected_raw)[0]
    assert protected_value['State']['Status'] == 'exited' and protected_value['Config']['Labels'] == {}
    registry = json.loads(command(docker + ['image', 'inspect', 'registry:3', '--format', '{{json .RepoDigests}}']))
    assert len(registry) == 1 and re.fullmatch(r'(?:docker\.io/library/)?registry@sha256:[a-f0-9]{64}', registry[0])
    report.update({'status': 'prepared', 'baseImage': base_image, 'baseImageId': base_id,
        'registryImage': registry[0], 'registryImageId': command(docker + ['image', 'inspect', registry[0], '--format', '{{.Id}}']),
        'protectedContainerBeforeSha256': hashlib.sha256(protected_raw.encode()).hexdigest(),
        'runtime': command(docker + ['info', '--format', '{{.Runtimes.runsc.Path}}'])})
    assert report['runtime'] == '/opt/telomere-host-runtime/gvisor/runsc'
    report['servicesAfter'] = service_state()
    report['profileAfterSha256'] = profile_hash()
    assert report['servicesAfter'] == before and report['profileAfterSha256'] == report['profileBeforeSha256']
    report['health'] = {}
    for name in ['live', 'ready']:
        with urllib.request.urlopen('http://127.0.0.1:13280/health/' + name, timeout=10) as response:
            value = json.load(response)
            assert response.status == 200 and value['status'] == ('ok' if name == 'live' else 'ready')
            report['health'][name] = {'code': response.status, 'body': value}
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    state.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, separators=(',', ':')))
except Exception as error:
    report['status'] = 'failed'
    report['failureType'] = type(error).__name__
    state.write_text(json.dumps(report, indent=2) + '\n')
    raise RuntimeError('Owned acceptance preparation failed; reconcile its retained state') from None
