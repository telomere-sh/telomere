"""Explicit owned-daemon image build; never deploy or restart staging services.

One scoped temporary registry service exposes only disposable public image data.

Arguments: SOURCE_DIRECTORY BUILD_CONTEXT REVISION ARCHIVE_SHA256 RESTORE_CJS_SHA256 CAPTURE_CJS_SHA256
SOURCE_DIRECTORY/.local/source-manifest.json is the verified pure-Git manifest.
The caller builds the standalone CJS before invoking this helper. No image build
or remote action happens on import; failed/unknown attempts require review.
"""
import datetime
import hashlib
import json
import os
import pathlib
import re
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

WORK = pathlib.Path('/opt/telomere-host-runtime/declared-state-gvisor-20261015')
RUN = pathlib.Path('/run/telomere-declared-accept-20261015')
NAMESPACE = 'tlmr-declared-accept-20261015'
UNIT = 'telomere-declared-accept-20261015.service'
DATA = pathlib.Path('/opt/telomere-host-runtime/docker-data')
SOCKET = RUN / 'docker.sock'
PROTECTED = '1d7ecc9b94866b9617df656ad7e2251916a9b7ceafef9a488ef6e85540076c5e'
BASE_IMAGE = '127.0.0.1:15002/telomere-cpu@sha256:6839949540d11906cbdbc614867ac3a825fa0e6f8cbed90c79773979517b4bbe'
BASE_ID = 'sha256:680cc0ec7dfa626d4105c3c26834289687e0abed785240e5bb814bac7cd55355'
REPOSITORY = '127.0.0.1:15004/telomere-declared-state'
ATTEMPT = WORK / 'image-extract-attempt03'
REGISTRY_ROOT = pathlib.Path('/opt/telomere-host-runtime/declared-state-registry-attempt03-20261015')
REGISTRY_UNIT = 'telomere-declared-registry-attempt03-20261015.service'
INITIAL_BUILDER_SHA256 = 'b3a560ce165f6b1078389d7c6b210336c3d398bba773509c8759f902419a322c'
REGISTRY_BINARY_SHA256 = '7f9e0df42bd028efb1a11eb7f92ef494156bf308770303a256d3acdcadb378cd'
REGISTRY_IMAGE_CONFIG_SHA256 = '6b1f91acca97fdfb8e3d74df04cc154bc973fc920ab0782599e4321a53460ab0'
PROBE = WORK / 'registry-probe-265228598df643f6af835c4c51fdadf8' / 'probe.json'
SERVICES = ['telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service']
DOCKER = ['docker', '--host', 'unix://' + str(SOCKET)]
GLOBAL_DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']
LIMIT_OUTPUT = 4 * 1024 * 1024


class Refusal(Exception):
    pass


def require(value):
    if not value:
        raise Refusal('Owned image-build precondition refused')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def private_directory(path):
    require(path.is_absolute() and path.resolve() == path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700)
    for parent in [path, *path.parents]:
        require(stat.S_ISDIR(parent.lstat().st_mode) and not parent.is_symlink())
    return info


def private_file(path, maximum, modes=(0o400, 0o600)):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) in modes and 0 <= info.st_size <= maximum)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        current = os.fstat(fd)
        require((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                == (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns, current.st_ctime_ns))
        with os.fdopen(fd, 'rb', closefd=False) as source:
            data = source.read(maximum + 1)
        after = path.lstat()
        require(len(data) == info.st_size and len(data) <= maximum
                and (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                and not path.is_symlink())
        return data
    finally:
        os.close(fd)


def command(args, environment, timeout=30, log=None, strip=True):
    # Private finite logs keep Docker diagnostics out of the safe report. Child
    # process groups are owned by this invocation; no unrelated PID is signalled.
    with tempfile.TemporaryFile(dir=WORK) as stdout, tempfile.TemporaryFile(dir=WORK) as stderr:
        child = subprocess.Popen(args, env=environment, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=True)
        deadline = time.monotonic() + timeout
        try:
            while child.poll() is None:
                require(os.fstat(stdout.fileno()).st_size <= LIMIT_OUTPUT and os.fstat(stderr.fileno()).st_size <= LIMIT_OUTPUT)
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(args, timeout)
                time.sleep(0.1)
        except BaseException:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
            raise
        stdout.seek(0)
        stderr.seek(0)
        out, err = stdout.read(LIMIT_OUTPUT + 1), stderr.read(LIMIT_OUTPUT + 1)
    require(len(out) <= LIMIT_OUTPUT and len(err) <= LIMIT_OUTPUT)
    if log is not None:
        with log.open('xb') as output:
            output.write(out)
            output.write(err)
    require(child.returncode == 0)
    value = out.decode('utf-8', errors='strict')
    return value.strip() if strip else value


def json_command(args, environment, timeout=30):
    return json.loads(command(args, environment, timeout))


def services(environment):
    return {name: command(['systemctl', 'show', name, '--property=ActiveState', '--property=SubState',
                          '--property=NRestarts', '--property=MainPID', '--property=WorkingDirectory'], environment) for name in SERVICES}


def profile_hash():
    # Contents are never retained or printed.
    return digest(pathlib.Path('/opt/telomere-pilot/config/staging.env').read_bytes())


def health():
    result = {}
    for name, expected in [('live', 'ok'), ('ready', 'ready')]:
        with urllib.request.urlopen('http://127.0.0.1:13280/health/' + name, timeout=10) as response:
            body = json.load(response)
            require(response.status == 200 and body['status'] == expected)
            result[name] = {'statusCode': response.status, 'body': body}
    return result


def protected_hash(environment):
    raw = command(DOCKER + ['inspect', PROTECTED], environment)
    values = json.loads(raw)
    require(len(values) == 1 and values[0]['Id'] == PROTECTED and values[0]['State']['Status'] == 'exited'
            and values[0]['Config']['Labels'] == {})
    return digest(raw.encode())


def container_ids(environment, prefix=DOCKER):
    values = command(prefix + ['ps', '--all', '--quiet', '--no-trunc'], environment).splitlines()
    require(all(re.fullmatch('[a-f0-9]{64}', value) for value in values))
    return sorted(values)


def daemon_identity(environment):
    require(stat.S_ISSOCK(SOCKET.lstat().st_mode) and not SOCKET.is_symlink())
    require(command(DOCKER + ['info', '--format', '{{.DockerRootDir}}'], environment) == str(DATA))
    require(command(DOCKER + ['info', '--format', '{{.Driver}}'], environment) == 'vfs')
    require(command(DOCKER + ['info', '--format', '{{.Runtimes.runsc.Path}}'], environment)
            == '/opt/telomere-host-runtime/gvisor/runsc')
    require(command(['systemctl', 'show', UNIT, '--property=ActiveState', '--value'], environment) == 'active')
    pid = int(command(['systemctl', 'show', UNIT, '--property=MainPID', '--value'], environment))
    require(pid > 1)
    argv = pathlib.Path('/proc', str(pid), 'cmdline').read_bytes().split(b'\0')
    require(argv[0].endswith(b'/dockerd'))
    for value in ['--host=unix://' + str(SOCKET), '--data-root=' + str(DATA),
                  '--exec-root=' + str(RUN / 'exec'), '--containerd-namespace=' + NAMESPACE]:
        require(value.encode() in argv)
    namespace = os.stat('/run/netns/' + NAMESPACE)
    process_namespace = os.stat('/proc/' + str(pid) + '/ns/net')
    require((namespace.st_dev, namespace.st_ino) == (process_namespace.st_dev, process_namespace.st_ino))
    interfaces = json_command(['ip', '-n', NAMESPACE, '-json', 'link', 'show'], environment)
    require(len(interfaces) == 1 and interfaces[0]['ifname'] == 'lo' and 'UP' in interfaces[0]['flags'])
    routes = json_command(['ip', '-n', NAMESPACE, '-json', 'route', 'show', 'table', 'all'], environment)
    require(all(value.get('dev') == 'lo' and value.get('dst') != 'default' for value in routes))
    return {'pid': pid, 'argvSha256': digest(b'\0'.join(argv)), 'namespaceInode': str(namespace.st_ino)}


def inspect_owned_registry(identifier, name, labels, image_id, environment):
    values = json_command(DOCKER + ['inspect', identifier], environment)
    require(len(values) == 1)
    value = values[0]
    require(re.fullmatch('[a-f0-9]{64}', value['Id']) and value['Id'] != PROTECTED
            and value['Name'] == '/' + name and value['Image'] == image_id
            and all(value['Config']['Labels'].get(key) == expected for key, expected in labels.items()))
    return value


def image_context(context, restore_sha256, capture_sha256, expected_dockerfile):
    require(context.parent == WORK and context.name == 'image-context-final'
            and sorted(value.name for value in context.iterdir())
            == ['Dockerfile', 'declared-state-cell-capture.cjs', 'declared-state-cell.cjs'])
    restored = private_file(context / 'declared-state-cell.cjs', 2 * 1024 * 1024, (0o444,))
    captured = private_file(context / 'declared-state-cell-capture.cjs', 2 * 1024 * 1024, (0o444,))
    dockerfile = private_file(context / 'Dockerfile', 4096)
    require(digest(restored) == restore_sha256 and digest(captured) == capture_sha256
            and dockerfile == expected_dockerfile and restored and captured)
    return restored, captured, dockerfile


def registry_account_identity(environment):
    passwd = command(['getent', 'passwd', 'nobody'], environment, 5)
    group = command(['getent', 'group', 'nogroup'], environment, 5)
    require(len(passwd) <= 1024 and len(group) <= 1024 and '\n' not in passwd and '\n' not in group)
    user_fields, group_fields = passwd.split(':'), group.split(':')
    require(len(user_fields) == 7 and user_fields[0] == 'nobody' and user_fields[2:4] == ['65534', '65534']
            and len(group_fields) == 4 and group_fields[0] == 'nogroup' and group_fields[2] == '65534')
    return {'user': 'nobody', 'group': 'nogroup', 'uid': 65534, 'gid': 65534}


def registry_uid_idle():
    examined = 0
    for path in pathlib.Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        examined += 1
        require(examined <= 4096)
        try:
            lines = path.joinpath('status').read_text().splitlines()
        except FileNotFoundError:
            continue
        uids = [line.split()[1:] for line in lines if line.startswith('Uid:')]
        require(len(uids) == 1 and len(uids[0]) == 4 and all(value.isdigit() for value in uids[0])
                and '65534' not in uids[0])
    return {'matchingProcesses': 0, 'unreadableStatuses': 0}


def validate_static_registry(data):
    # Narrow Linux/amd64 ELF64 image binary, never an entrypoint shell script.
    require(64 <= len(data) <= 64 * 1024 * 1024 and data[:7] == b'\x7fELF\x02\x01\x01')
    kind, machine, version = struct.unpack_from('<HHI', data, 16)
    offset = struct.unpack_from('<Q', data, 32)[0]
    header_size, entry_size, count = struct.unpack_from('<HHH', data, 52)
    require(kind in (2, 3) and machine == 62 and version == 1 and header_size == 64
            and entry_size == 56 and 1 <= count <= 128 and offset >= 64
            and offset + entry_size * count <= len(data))
    for index in range(count):
        position = offset + entry_size * index
        program_kind = struct.unpack_from('<I', data, position)[0]
        file_offset, file_size = struct.unpack_from('<Q', data, position + 8)[0], struct.unpack_from('<Q', data, position + 32)[0]
        require(program_kind not in (2, 3) and file_offset + file_size <= len(data))


def write_registry_file(path, data, mode):
    require(path.parent == REGISTRY_ROOT and not path.exists() and not path.is_symlink())
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as output:
            output.write(data)
            output.flush()
        os.fchown(fd, 0, 65534)
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)
    require(private_file(path, max(len(data), 1), (mode,)) == data and path.stat().st_gid == 65534)


def registry_unit_properties(environment):
    fields = ['LoadState', 'ActiveState', 'SubState', 'MainPID', 'Description', 'User', 'Group',
              'NetworkNamespacePath', 'FragmentPath', 'ExecStart', 'ControlGroup', 'NoNewPrivileges', 'KillMode']
    result = subprocess.run(['systemctl', 'show', REGISTRY_UNIT, '--property=' + ','.join(fields)],
                            env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=5, check=False)
    require(result.returncode in (0, 1) and len(result.stdout) <= 16_384)
    lines = result.stdout.decode('utf-8', errors='strict').strip().splitlines()
    require(1 <= len(lines) <= len(fields) and all('=' in line for line in lines))
    values = dict(line.split('=', 1) for line in lines)
    require(len(values) == len(lines) and set(values) <= set(fields))
    absent = (values.get('LoadState') == 'not-found' and values.get('ActiveState') == 'inactive'
              and values.get('SubState') == 'dead' and values.get('MainPID') == '0' and values.get('ControlGroup') == ''
              and all(values.get(field) == '' for field in ['User', 'Group', 'NetworkNamespacePath', 'FragmentPath'])
              and values.get('Description') in ('', REGISTRY_UNIT) and values.get('ExecStart', '') == '')
    # A never-loaded service omits ExecStart even when explicitly requested.
    # No other missing/duplicate field or loaded-unit omission is accepted.
    require(set(values) == set(fields) or set(fields) - set(values) == {'ExecStart'} and absent)
    require(result.returncode == 0 or absent)
    require(values.get('LoadState') != 'not-found' or absent)
    if 'ExecStart' not in values:
        values['ExecStart'] = ''
    return values


def registry_service_identity(environment, description, binary_sha256, config_sha256, allow_absent=False, verify_live_namespace=True):
    values = registry_unit_properties(environment)
    if values.get('LoadState') == 'not-found' and allow_absent:
        return None
    expected_exec = '/usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 ' + str(REGISTRY_ROOT / 'registry') + ' serve ' + str(REGISTRY_ROOT / 'config.yml')
    require(values.get('LoadState') == 'loaded' and values['Description'] == description
            and values['User'] == 'nobody' and values['Group'] == 'nogroup'
            and values['NetworkNamespacePath'] == '/run/netns/' + NAMESPACE
            and values['FragmentPath'] == '/run/systemd/transient/' + REGISTRY_UNIT
            and values['ExecStart'].count('path=') == 1
            and 'path=/usr/bin/env ; argv[]=' + expected_exec + ' ;' in values['ExecStart']
            and values['NoNewPrivileges'] == 'yes' and values['KillMode'] == 'control-group'
            and re.fullmatch('[0-9]+', values['MainPID']))
    require(values['ControlGroup'] == '/system.slice/' + REGISTRY_UNIT
            or values['ControlGroup'] == '' and values['MainPID'] == '0' and values['ActiveState'] in ('inactive', 'failed'))
    require(digest(private_file(REGISTRY_ROOT / 'registry', 64 * 1024 * 1024, (0o550,))) == binary_sha256
            and digest(private_file(REGISTRY_ROOT / 'config.yml', 4096, (0o440,))) == config_sha256)
    pid = int(values['MainPID'])
    if verify_live_namespace:
        require(values['ActiveState'] == 'active' and pid > 1)
    if pid:
        require(pid > 1)
        expected = os.stat('/run/netns/' + NAMESPACE)
        actual = os.stat('/proc/' + str(pid) + '/ns/net')
        if verify_live_namespace:
            require((actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino))
        require(pathlib.Path('/proc', str(pid), 'cmdline').read_bytes().split(b'\0')
                == [str(REGISTRY_ROOT / 'registry').encode(), b'serve', str(REGISTRY_ROOT / 'config.yml').encode(), b''])
        if verify_live_namespace:
            lines = pathlib.Path('/proc', str(pid), 'status').read_text().splitlines()
            require([line.split()[1:] for line in lines if line.startswith('Uid:')] == [['65534'] * 4]
                    and [line.split()[1:] for line in lines if line.startswith('Gid:')] == [['65534'] * 4])
    return values


def stop_registry_service(environment, description, binary_sha256, config_sha256):
    def inspect():
        return registry_service_identity(environment, description, binary_sha256, config_sha256,
                                         allow_absent=True, verify_live_namespace=False)
    service = inspect()
    if service is None:
        return
    try:
        command(['systemctl', 'stop', REGISTRY_UNIT], environment, 20)
    except BaseException:
        if inspect() is not None:
            command(['systemctl', 'kill', '--kill-whom=all', '--signal=KILL', REGISTRY_UNIT], environment, 10)
    deadline = time.monotonic() + 10
    while True:
        service = inspect()
        if service is None or service['ActiveState'] in ('inactive', 'failed') and service['MainPID'] == '0':
            return
        require(time.monotonic() < deadline)
        time.sleep(0.2)


def persist(path, report):
    # One fixed, owned report; atomic replacement never touches private snapshots.
    temporary = path.with_name(path.name + '.pending-' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w', closefd=False) as output:
            json.dump(report, output, indent=2)
            output.write('\n')
            output.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    if path.exists():
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid()
                and stat.S_IMODE(info.st_mode) == 0o600)
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def main(argv):
    require(len(argv) == 6)
    source, context = pathlib.Path(argv[0]), pathlib.Path(argv[1])
    revision, archive_sha, cjs_sha, capture_cjs_sha = argv[2:]
    require(re.fullmatch('[a-f0-9]{40}', revision) and re.fullmatch('[a-f0-9]{64}', archive_sha)
            and re.fullmatch('[a-f0-9]{64}', cjs_sha) and re.fullmatch('[a-f0-9]{64}', capture_cjs_sha))
    private_directory(WORK)
    private_directory(source)
    private_directory(context)
    private_directory(source / '.local')
    require(source.is_relative_to(pathlib.Path('/opt/telomere-host-runtime')) and source != WORK
            and context.parent == WORK and context.name == 'image-context-final')
    prepare_bytes = private_file(WORK / 'prepare.json', 65_536)
    prepare = json.loads(prepare_bytes)
    require(prepare['status'] == 'prepared' and prepare['socket'] == str(SOCKET)
            and prepare['namespace'] == NAMESPACE and prepare['unit'] == UNIT and prepare['dataRoot'] == str(DATA)
            and prepare['protectedContainerId'] == PROTECTED and prepare['baseImage'] == BASE_IMAGE
            and prepare['baseImageId'] == BASE_ID and re.fullmatch(r'(?:docker\.io/library/)?registry@sha256:[a-f0-9]{64}', prepare['registryImage'])
            and re.fullmatch('sha256:[a-f0-9]{64}', prepare['registryImageId']))
    initial_bytes = private_file(WORK / 'image-build.json', 65_536)
    initial = json.loads(initial_bytes)
    probe_bytes = private_file(PROBE, 65_536)
    probe = json.loads(probe_bytes)
    require(initial['success'] is False and initial['failureType'] == 'Refusal' and initial['registryCleanupConfirmed'] is True
            and probe['state']['Running'] is True and probe['registryNamespaceMatches'] is False
            and probe['cleanupConfirmed'] is True and probe['unchanged'] is True)
    prior_bytes = private_file(WORK / 'image-build-attempt02.json', 65_536)
    prior = json.loads(prior_bytes)
    require(prior['success'] is False and prior['status'] == 'failed'
            and prior['failureStage'] == 'registry_service_start'
            and prior['registryCleanupConfirmed'] is True and prior['registryServiceCleanupConfirmed'] is True
            and prior['extractionContainerCleanupConfirmed'] is True
            and prior['servicesBefore'] == prior['servicesAfter'] and prior['profileBeforeSha256'] == prior['profileAfterSha256']
            and prior['protectedBeforeSha256'] == prior['protectedAfterSha256']
            and prior['globalContainersBefore'] == prior['globalContainersAfter']
            and prior['ownedContainersBefore'] == prior['ownedContainersAfter']
            and prior['sourceFilesVerified'] == prior['sourceFilesVerifiedAfter'])
    account = registry_account_identity({'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    idle = registry_uid_idle()
    absent = registry_unit_properties({'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    require(absent['LoadState'] == 'not-found' and absent['ActiveState'] == 'inactive'
            and absent['MainPID'] == '0' and absent['ControlGroup'] == '')
    manifest_bytes = private_file(source / '.local/source-manifest.json', 1_048_576)
    manifest = json.loads(manifest_bytes)
    require(manifest['source'] == 'committed_git_blobs_only' and manifest['workingTreeIncluded'] is False
            and manifest['gitRevision'] == revision and manifest['archiveSha256'] == archive_sha)
    require(prior['gitRevision'] == revision and prior['archiveSha256'] == archive_sha
            and prior['sourceManifestSha256'] == digest(manifest_bytes))
    entries = {item['path']: item for item in manifest['files']}
    require(685 <= len(entries) == len(manifest['files']) <= 1000)
    for name, item in entries.items():
        parts = pathlib.PurePosixPath(name)
        require(not parts.is_absolute() and '..' not in parts.parts and not any(part in ('.git', '.local', 'node_modules', '.env') for part in parts.parts))
        path = source / name
        require(path.is_file() and not path.is_symlink())
        data = path.read_bytes()
        require(len(data) == item['bytes'] and digest(data) == item['sha256'])
    dockerfile_name = 'infra/host-kit/Dockerfile.declared-state'
    require(dockerfile_name in entries)
    expected_dockerfile = (source / dockerfile_name).read_bytes()
    require(digest(expected_dockerfile) == entries[dockerfile_name]['sha256'])
    cjs, capture_cjs, dockerfile = image_context(context, cjs_sha, capture_cjs_sha, expected_dockerfile)
    report_path = WORK / 'image-build-attempt03.json'
    require(not report_path.exists() and not report_path.is_symlink())
    registry_data, docker_config = REGISTRY_ROOT / 'data', ATTEMPT / 'docker-config'
    require(not ATTEMPT.exists() and not ATTEMPT.is_symlink() and not REGISTRY_ROOT.exists() and not REGISTRY_ROOT.is_symlink())
    require(not pathlib.Path('/run/systemd/transient', REGISTRY_UNIT).exists())
    os.umask(0o077)
    ATTEMPT.mkdir(mode=0o700)
    private_directory(ATTEMPT)
    docker_config.mkdir(mode=0o700)
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(WORK), 'LANG': 'C.UTF-8',
                   'DOCKER_CONFIG': str(docker_config), 'DOCKER_BUILDKIT': '0'}
    report = {'schemaVersion': 1, 'status': 'preflight', 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'gitRevision': revision, 'archiveSha256': archive_sha, 'sourceDirectory': str(source),
              'sourceManifestSha256': digest(manifest_bytes), 'sourceFilesVerified': len(entries),
              'cjsSha256': cjs_sha, 'cjsBytes': len(cjs),
              'captureCjsSha256': capture_cjs_sha, 'captureCjsBytes': len(capture_cjs), 'dockerfileSha256': digest(dockerfile),
              'prepareSha256': digest(prepare_bytes), 'baseImage': BASE_IMAGE, 'baseImageId': BASE_ID,
              'registryImage': prepare['registryImage'], 'registryImageId': prepare['registryImageId'],
              'servicesBefore': services(environment), 'profileBeforeSha256': profile_hash(),
              'protectedBeforeSha256': protected_hash(environment), 'ownedContainersBefore': container_ids(environment),
              'globalContainersBefore': container_ids(environment, GLOBAL_DOCKER), 'daemonBefore': daemon_identity(environment),
              'stagingServiceMutations': False, 'ownedRegistryServiceRequested': False, 'ownedRegistryServiceCreated': False,
              'publicNetworkRequests': 0, 'publicTransactions': 0, 'paidProviderRequests': 0,
              'productionProfileEnabled': False, 'acceptanceImageOnly': True,
              'attempt': 3, 'initialBuilderSha256': INITIAL_BUILDER_SHA256,
              'priorAttempt02ReportSha256': digest(prior_bytes),
              'priorAttempt02BuilderSha256': 'd2c1a7664c20be02ec2c29eb29d68f7da0eabce05de06784c2d9ba3445a2f270',
              'priorAttempt02FailureClassification': 'systemd_USER_217_missing_nss_uid_10001',
              'priorFailureClassificationSource': 'operator_readonly_systemd_diagnostic',
              'registryAccountPin': account, 'registryUidBefore': idle,
              'registryIdentityScope': 'disposable_public_image_service_not_production_user_isolation',
              'initialFailureReportSha256': digest(initial_bytes), 'namespaceProbeSha256': digest(probe_bytes),
              'registryMode': 'pinned_static_binary_owned_network_namespace',
              'registryUnit': REGISTRY_UNIT, 'registryRoot': str(REGISTRY_ROOT)}
    require(report['servicesBefore'] == prepare['servicesAfter'] and report['profileBeforeSha256'] == prepare['profileAfterSha256']
            and report['protectedBeforeSha256'] == prepare['protectedContainerBeforeSha256']
            and report['ownedContainersBefore'] == [PROTECTED])
    require(command(DOCKER + ['image', 'inspect', BASE_IMAGE, '--format', '{{.Id}}'], environment) == BASE_ID)
    require(command(DOCKER + ['image', 'inspect', prepare['registryImage'], '--format', '{{.Id}}'], environment) == prepare['registryImageId'])
    report['healthBefore'] = health()
    token = uuid.uuid4().hex
    registry_name = 'telomere-declared-extract-attempt03-' + revision[:12] + '-' + token[:8]
    labels = {'telomere.acceptance.owner': 'declared-state-20261015', 'telomere.acceptance.token': token,
              'telomere.acceptance.revision': revision}
    report['registryName'], report['registryLabels'] = registry_name, labels
    registry_id, mutation_requested, service_requested, success = None, False, False, False
    persist(report_path, report)
    def interrupted(_signum, _frame):
        raise Refusal('Owned image build interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        report['failureStage'] = 'image_metadata'
        metadata = json_command(DOCKER + ['image', 'inspect', prepare['registryImage']], environment)
        require(len(metadata) == 1 and metadata[0]['Id'] == prepare['registryImageId']
                and metadata[0]['Os'] == 'linux' and metadata[0]['Architecture'] == 'amd64'
                and metadata[0]['Config']['Entrypoint'] == ['/entrypoint.sh']
                and metadata[0]['Config']['Cmd'] == ['/etc/distribution/config.yml']
                and set((metadata[0]['Config'].get('Volumes') or {}).keys()) == {'/var/lib/registry'})
        report['contextCjsMode'] = '0444'
        report['captureContextCjsMode'] = '0444'
        require(image_context(context, cjs_sha, capture_cjs_sha, dockerfile) == (cjs, capture_cjs, dockerfile))
        require(REGISTRY_ROOT.parent.is_dir() and not REGISTRY_ROOT.parent.is_symlink()
                and stat.S_IMODE(REGISTRY_ROOT.parent.stat().st_mode) & 0o005 == 0o005)
        REGISTRY_ROOT.mkdir(mode=0o700)
        os.chown(REGISTRY_ROOT, 0, 65534)
        os.chmod(REGISTRY_ROOT, 0o750)
        registry_data.mkdir(mode=0o700)
        os.chown(registry_data, 65534, 65534)
        report['status'] = 'registry_extract_requested'
        report['failureStage'] = 'stopped_container_create'
        persist(report_path, report)
        mutation_requested = True
        args = DOCKER + ['create', '--name', registry_name, '--pull=never', '--network=none', '--read-only',
                         '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=65534:65534',
                         '--entrypoint=/bin/registry',
                         '--mount=type=bind,src=' + str(registry_data) + ',dst=/var/lib/registry']
        for key, value in labels.items():
            args.append('--label=' + key + '=' + value)
        registry_id = command(args + [prepare['registryImage'], '--version'], environment)
        require(re.fullmatch('[a-f0-9]{64}', registry_id))
        registry = inspect_owned_registry(registry_id, registry_name, labels, prepare['registryImageId'], environment)
        report['registryId'] = registry_id
        require(registry['State']['Status'] == 'created' and not registry['State']['Running']
                and registry['State']['Pid'] == 0 and registry['HostConfig']['NetworkMode'] == 'none')
        mounts = registry['Mounts']
        require(len(mounts) == 1 and mounts[0]['Type'] == 'bind' and mounts[0]['Source'] == str(registry_data)
                and mounts[0]['Destination'] == '/var/lib/registry')
        report['failureStage'] = 'fixed_file_copy'
        for source_path, output_name, maximum in [('/bin/registry', 'registry', 64 * 1024 * 1024),
                                                  ('/etc/distribution/config.yml', 'image-config.yml', 65_536)]:
            destination = ATTEMPT / output_name
            require(not destination.exists() and not destination.is_symlink())
            command(DOCKER + ['cp', registry_id + ':' + source_path, str(destination)], environment)
            copied = destination.lstat()
            require(stat.S_ISREG(copied.st_mode) and copied.st_nlink == 1 and copied.st_uid == 0
                    and 0 < copied.st_size <= maximum and not destination.is_symlink())
            os.chmod(destination, 0o600)
        binary = private_file(ATTEMPT / 'registry', 64 * 1024 * 1024)
        validate_static_registry(binary)
        image_config = private_file(ATTEMPT / 'image-config.yml', 65_536)
        require(digest(binary) == REGISTRY_BINARY_SHA256 and len(binary) == 55_808_162
                and digest(image_config) == REGISTRY_IMAGE_CONFIG_SHA256 and len(image_config) == 475
                and b'\0' not in image_config)
        report['registryBinarySha256'] = digest(binary)
        report['registryBinaryBytes'] = len(binary)
        report['registryImageConfigSha256'] = digest(image_config)
        report['registryImageConfigBytes'] = len(image_config)
        registry = inspect_owned_registry(registry_id, registry_name, labels, prepare['registryImageId'], environment)
        require(not registry['State']['Running'] and registry['State']['Pid'] == 0)
        command(DOCKER + ['rm', registry_id], environment)
        require(registry_id not in container_ids(environment))
        report['extractionContainerCleanupConfirmed'] = True
        write_registry_file(REGISTRY_ROOT / 'registry', binary, 0o550)
        config = ('version: 0.1\nlog:\n  level: error\nstorage:\n  filesystem:\n    rootdirectory: '
                  + str(registry_data) + '\nhttp:\n  addr: 127.0.0.1:15004\n').encode()
        write_registry_file(REGISTRY_ROOT / 'config.yml', config, 0o440)
        report['registryConfigSha256'] = digest(config)
        require(registry_account_identity(environment) == account)
        registry_uid_idle()
        report['failureStage'] = 'registry_service_start'
        report['status'] = 'registry_service_start_requested'
        service_description = 'Telomere declared registry attempt03 ' + token
        report['registryServiceDescription'] = service_description
        report['ownedRegistryServiceRequested'] = True
        persist(report_path, report)
        service_requested = True
        command(['systemd-run', '--unit=' + REGISTRY_UNIT, '--description=' + service_description,
                 '--property=User=nobody', '--property=Group=nogroup', '--property=Restart=no',
                 '--property=Type=exec', '--property=NetworkNamespacePath=/run/netns/' + NAMESPACE,
                 '--property=NoNewPrivileges=yes', '--property=CapabilityBoundingSet=',
                 '--property=AmbientCapabilities=', '--property=ProtectSystem=strict',
                 '--property=ProtectHome=yes', '--property=PrivateTmp=yes', '--property=PrivateDevices=yes',
                 '--property=ReadWritePaths=' + str(registry_data), '--property=WorkingDirectory=' + str(REGISTRY_ROOT),
                 '--property=MemoryMax=128M', '--property=TasksMax=64', '--property=RuntimeMaxSec=600',
                 '--property=TimeoutStopSec=10', '--property=KillMode=control-group',
                 '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8',
                 str(REGISTRY_ROOT / 'registry'), 'serve', str(REGISTRY_ROOT / 'config.yml')], environment, 30, ATTEMPT / 'registry-service-start.private.log')
        report['ownedRegistryServiceCreated'] = True
        service = registry_service_identity(environment, service_description, report['registryBinarySha256'], report['registryConfigSha256'])
        require(service['ActiveState'] == 'active' and int(service['MainPID']) > 1)
        report['registryServicePid'] = int(service['MainPID'])
        report['registryNamespaceMatches'] = True
        report['failureStage'] = 'registry_readiness'
        ready = False
        for _ in range(30):
            try:
                registry_service_identity(environment, service_description, report['registryBinarySha256'], report['registryConfigSha256'])
                value = command(['nsenter', '--net=/run/netns/' + NAMESPACE, 'curl', '--noproxy', '*', '--max-time', '2',
                                 '--fail', '--silent', '--show-error', 'http://127.0.0.1:15004/v2/'], environment, 3)
                require(json.loads(value) == {})
                ready = True
                break
            except (subprocess.SubprocessError, OSError, ValueError, Refusal):
                time.sleep(0.2)
        require(ready)
        registry_service_identity(environment, service_description, report['registryBinarySha256'], report['registryConfigSha256'])
        report['failureStage'] = 'image_build'
        report['status'] = 'build_requested'
        persist(report_path, report)
        require(image_context(context, cjs_sha, capture_cjs_sha, dockerfile) == (cjs, capture_cjs, dockerfile))
        command(DOCKER + ['build', '--network=none', '--pull=false', '--rm=true', '--force-rm=true',
                         '--build-arg=BASE_IMAGE=' + BASE_IMAGE, '--tag=' + REPOSITORY + ':acceptance', str(context)],
                environment, 180, ATTEMPT / 'image-build.private.log')
        image_id = command(DOCKER + ['image', 'inspect', REPOSITORY + ':acceptance', '--format', '{{.Id}}'], environment)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image_id) and image_id != BASE_ID)
        report['imageId'], report['status'], report['failureStage'] = image_id, 'push_requested', 'image_push'
        persist(report_path, report)
        registry_service_identity(environment, service_description, report['registryBinarySha256'], report['registryConfigSha256'])
        command(DOCKER + ['push', REPOSITORY + ':acceptance'], environment, 180, ATTEMPT / 'image-push.private.log')
        digests = json_command(DOCKER + ['image', 'inspect', image_id, '--format', '{{json .RepoDigests}}'], environment)
        matched = [value for value in digests if re.fullmatch(re.escape(REPOSITORY) + '@sha256:[a-f0-9]{64}', value)]
        require(len(matched) == 1)
        require(command(DOCKER + ['image', 'inspect', matched[0], '--format', '{{.Id}}'], environment) == image_id)
        report['image'] = matched[0]  # Real pushed manifest RepoDigest, never the image config ID.
        report['manifestDigest'] = matched[0].split('@', 1)[1]
        manifest_raw = command(['nsenter', '--net=/run/netns/' + NAMESPACE, 'curl', '--noproxy', '*', '--max-time', '5',
                                '--fail', '--silent', '--show-error',
                                '--header=Accept: application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
                                'http://127.0.0.1:15004/v2/telomere-declared-state/manifests/' + report['manifestDigest']],
                               environment, 6, strip=False)
        published = json.loads(manifest_raw)
        require(digest(manifest_raw.encode()) == report['manifestDigest'].split(':', 1)[1]
                and published['schemaVersion'] == 2 and published['config']['digest'] == image_id)
        report['registryManifestVerified'] = {'bytes': len(manifest_raw.encode()), 'sha256': digest(manifest_raw.encode()),
                                              'configDigest': published['config']['digest']}
        require(image_context(context, cjs_sha, capture_cjs_sha, dockerfile) == (cjs, capture_cjs, dockerfile))
        report['failureStage'] = 'postflight'
        success = True
    except BaseException as error:
        report['failureType'] = type(error).__name__
        success = False
    finally:
        # Signals must not re-enter cleanup. SIGKILL cannot run finally; the
        # durable exact name/token marker is retained for explicit reconciliation.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        service_cleanup_ok = not service_requested
        if service_requested:
            try:
                stop_registry_service(environment, report['registryServiceDescription'], report['registryBinarySha256'], report['registryConfigSha256'])
                service_cleanup_ok = True
            except BaseException as error:
                report['registryServiceCleanupFailureType'] = type(error).__name__
        report['registryServiceCleanupConfirmed'] = service_cleanup_ok
        extraction_cleanup_ok = not mutation_requested or report.get('extractionContainerCleanupConfirmed') is True
        if mutation_requested and not extraction_cleanup_ok:
            try:
                matches = command(DOCKER + ['ps', '--all', '--quiet', '--no-trunc', '--filter=name=^/' + registry_name + '$'], environment).splitlines()
                require(len(matches) <= 1)
                if matches:
                    registry = inspect_owned_registry(matches[0], registry_name, labels, prepare['registryImageId'], environment)
                    require(not registry['State']['Running'] and registry['State']['Pid'] == 0)
                    command(DOCKER + ['rm', registry['Id']], environment)
                    require(registry['Id'] not in container_ids(environment))
                extraction_cleanup_ok = True
            except BaseException as error:
                report['extractionCleanupFailureType'] = type(error).__name__
        report['extractionContainerCleanupConfirmed'] = extraction_cleanup_ok
        cleanup_ok = service_cleanup_ok and extraction_cleanup_ok
        report['registryCleanupConfirmed'] = cleanup_ok
        if (ATTEMPT / 'registry-service-start.private.log').exists():
            try:
                report['registryServiceStartLogSha256'] = digest(private_file(ATTEMPT / 'registry-service-start.private.log', 2 * LIMIT_OUTPUT))
            except BaseException as error:
                report['registryServiceLogFailureType'] = type(error).__name__
                success = False
        try:
            report['servicesAfter'], report['profileAfterSha256'] = services(environment), profile_hash()
            report['protectedAfterSha256'], report['ownedContainersAfter'] = protected_hash(environment), container_ids(environment)
            report['globalContainersAfter'], report['daemonAfter'] = container_ids(environment, GLOBAL_DOCKER), daemon_identity(environment)
            report['healthAfter'] = health()
            report['registryUidAfter'] = registry_uid_idle()
            success = success and cleanup_ok and report['servicesAfter'] == report['servicesBefore']
            success = success and report['profileAfterSha256'] == report['profileBeforeSha256'] and report['protectedAfterSha256'] == report['protectedBeforeSha256']
            success = success and report['ownedContainersAfter'] == report['ownedContainersBefore'] and report['globalContainersAfter'] == report['globalContainersBefore']
            success = success and report['daemonAfter'] == report['daemonBefore'] and digest(private_file(WORK / 'prepare.json', 65_536)) == report['prepareSha256']
            success = success and image_context(context, cjs_sha, capture_cjs_sha, dockerfile) == (cjs, capture_cjs, dockerfile)
            require(private_file(source / '.local/source-manifest.json', 1_048_576) == manifest_bytes)
            for name, item in entries.items():
                path = source / name
                require(path.is_file() and not path.is_symlink())
                data = path.read_bytes()
                require(len(data) == item['bytes'] and digest(data) == item['sha256'])
            report['sourceFilesVerifiedAfter'] = len(entries)
            report['baseImageAfterId'] = command(DOCKER + ['image', 'inspect', BASE_IMAGE, '--format', '{{.Id}}'], environment)
            report['registryImageAfterId'] = command(DOCKER + ['image', 'inspect', prepare['registryImage'], '--format', '{{.Id}}'], environment)
            require(report['baseImageAfterId'] == BASE_ID and report['registryImageAfterId'] == prepare['registryImageId'])
        except BaseException as error:
            report['postflightFailureType'] = type(error).__name__
            success = False
        report['status'] = 'accepted' if success else 'failed'
        report['success'] = bool(success)
        if success:
            report.pop('failureStage', None)
        report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        persist(report_path, report)
        print(json.dumps(report, separators=(',', ':')), flush=True)
    return 0 if report['success'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        print(json.dumps({'schemaVersion': 1, 'success': False, 'status': 'refused_before_or_during_owned_build',
                          'failureType': type(error).__name__}), flush=True)
        sys.exit(1)
