import hashlib, importlib.util, json, os, pathlib, sys, time, uuid

helper = pathlib.Path('/tmp/build-declared-state-cell-image-20261015.py')
assert hashlib.sha256(helper.read_bytes()).hexdigest() == 'b3a560ce165f6b1078389d7c6b210336c3d398bba773509c8759f902419a322c'
spec = importlib.util.spec_from_file_location('owned_builder', helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
work = module.WORK
prepare = json.loads((work / 'prepare.json').read_bytes())
os.umask(0o077)
token = uuid.uuid4().hex
name = 'telomere-declared-registry-probe-' + token
directory = work / ('registry-probe-' + token)
directory.mkdir(mode=0o700)
data, config = directory / 'data', directory / 'docker-config'
data.mkdir(mode=0o700); config.mkdir(mode=0o700); os.chown(data, 10001, 10001)
env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(directory), 'LANG': 'C.UTF-8', 'DOCKER_CONFIG': str(config)}
labels = {'telomere.acceptance.owner': 'declared-state-registry-probe-20261015', 'telomere.acceptance.token': token}
report = {'directory': str(directory), 'servicesBefore': module.services(env), 'profileBeforeSha256': module.profile_hash(),
    'protectedBeforeSha256': module.protected_hash(env), 'daemonBefore': module.daemon_identity(env),
    'globalBefore': module.container_ids(env, module.GLOBAL_DOCKER), 'ownedBefore': module.container_ids(env),
    'publicTransactions': 0, 'paidProviderRequests': 0}
assert report['ownedBefore'] == [module.PROTECTED]
assert report['servicesBefore'] == prepare['servicesAfter'] and report['profileBeforeSha256'] == prepare['profileAfterSha256']
identifier = None
try:
    args = module.DOCKER + ['run', '--detach', '--name', name, '--pull=never', '--network=host', '--read-only',
        '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=10001:10001', '--memory=128m', '--memory-swap=128m',
        '--pids-limit=64', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=8m',
        '--mount=type=bind,src=' + str(data) + ',dst=/var/lib/registry', '--env=REGISTRY_HTTP_ADDR=127.0.0.1:15004']
    for key, value in labels.items(): args.append('--label=' + key + '=' + value)
    identifier = module.command(args + [prepare['registryImage']], env)
    report['registryId'] = identifier
    time.sleep(1)
    value = module.inspect_owned_registry(identifier, name, labels, prepare['registryImageId'], env)
    (directory / 'inspect.private.json').write_text(json.dumps(value, indent=2) + '\n')
    report['state'] = {key: value['State'][key] for key in ['Status', 'Running', 'Pid', 'ExitCode', 'OOMKilled']}
    if value['State']['Pid']:
        actual = os.stat('/proc/' + str(value['State']['Pid']) + '/ns/net')
        expected = os.stat('/run/netns/' + module.NAMESPACE)
        report['registryNamespaceMatches'] = (actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino)
        report['namespaceInodes'] = {'registry': actual.st_ino, 'expected': expected.st_ino}
    module.command(module.DOCKER + ['logs', identifier], env, log=directory / 'logs.private.txt', strip=False)
    report['privateLogsSha256'] = hashlib.sha256((directory / 'logs.private.txt').read_bytes()).hexdigest()
except BaseException as error:
    report['failureType'] = type(error).__name__
finally:
    try:
        value = module.inspect_owned_registry(identifier or name, name, labels, prepare['registryImageId'], env)
        if value['State']['Running']: module.command(module.DOCKER + ['stop', '--time=5', value['Id']], env, 15)
        module.command(module.DOCKER + ['rm', value['Id']], env)
        report['cleanupConfirmed'] = value['Id'] not in module.container_ids(env)
    except BaseException as error:
        report['cleanupFailureType'] = type(error).__name__
    report['servicesAfter'], report['profileAfterSha256'] = module.services(env), module.profile_hash()
    report['protectedAfterSha256'], report['globalAfter'] = module.protected_hash(env), module.container_ids(env, module.GLOBAL_DOCKER)
    report['ownedAfter'] = module.container_ids(env)
    report['unchanged'] = report['servicesAfter'] == report['servicesBefore'] and report['profileAfterSha256'] == report['profileBeforeSha256']
    report['unchanged'] = report['unchanged'] and report['protectedBeforeSha256'] == report['protectedAfterSha256']
    report['unchanged'] = report['unchanged'] and report['globalAfter'] == report['globalBefore'] and report['ownedAfter'] == report['ownedBefore']
    (directory / 'probe.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, separators=(',', ':')))
