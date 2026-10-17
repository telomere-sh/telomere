"""Explicit owned-daemon image build only. Never deploy or restart a service.

Arguments: SOURCE_DIRECTORY BUILD_CONTEXT REVISION ARCHIVE_SHA256 CJS_SHA256
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
    require(len(argv) == 5)
    source, context = pathlib.Path(argv[0]), pathlib.Path(argv[1])
    revision, archive_sha, cjs_sha = argv[2:]
    require(re.fullmatch('[a-f0-9]{40}', revision) and re.fullmatch('[a-f0-9]{64}', archive_sha)
            and re.fullmatch('[a-f0-9]{64}', cjs_sha))
    private_directory(WORK)
    private_directory(source)
    private_directory(context)
    private_directory(source / '.local')
    require(source.is_relative_to(pathlib.Path('/opt/telomere-host-runtime')) and source != WORK
            and context.parent == WORK and context.name == 'image-context')
    prepare_bytes = private_file(WORK / 'prepare.json', 65_536)
    prepare = json.loads(prepare_bytes)
    require(prepare['status'] == 'prepared' and prepare['socket'] == str(SOCKET)
            and prepare['namespace'] == NAMESPACE and prepare['unit'] == UNIT and prepare['dataRoot'] == str(DATA)
            and prepare['protectedContainerId'] == PROTECTED and prepare['baseImage'] == BASE_IMAGE
            and prepare['baseImageId'] == BASE_ID and re.fullmatch(r'(?:docker\.io/library/)?registry@sha256:[a-f0-9]{64}', prepare['registryImage'])
            and re.fullmatch('sha256:[a-f0-9]{64}', prepare['registryImageId']))
    manifest_bytes = private_file(source / '.local/source-manifest.json', 1_048_576)
    manifest = json.loads(manifest_bytes)
    require(manifest['source'] == 'committed_git_blobs_only' and manifest['workingTreeIncluded'] is False
            and manifest['gitRevision'] == revision and manifest['archiveSha256'] == archive_sha)
    entries = {item['path']: item for item in manifest['files']}
    require(685 <= len(entries) == len(manifest['files']) <= 1000)
    for name, item in entries.items():
        parts = pathlib.PurePosixPath(name)
        require(not parts.is_absolute() and '..' not in parts.parts and not any(part in ('.git', '.local', 'node_modules', '.env') for part in parts.parts))
        path = source / name
        require(path.is_file() and not path.is_symlink())
        data = path.read_bytes()
        require(len(data) == item['bytes'] and digest(data) == item['sha256'])
    require(sorted(value.name for value in context.iterdir()) == ['Dockerfile', 'declared-state-cell.cjs'])
    cjs = private_file(context / 'declared-state-cell.cjs', 2 * 1024 * 1024)
    dockerfile = private_file(context / 'Dockerfile', 4096)
    dockerfile_name = 'infra/host-kit/Dockerfile.declared-state'
    require(dockerfile_name in entries and dockerfile == (source / dockerfile_name).read_bytes()
            and digest(dockerfile) == entries[dockerfile_name]['sha256'] and digest(cjs) == cjs_sha)
    report_path = WORK / 'image-build.json'
    require(not report_path.exists() and not report_path.is_symlink())
    registry_data, docker_config = WORK / 'image-registry-data', WORK / 'image-docker-config'
    require(not registry_data.exists() and not docker_config.exists())
    os.umask(0o077)
    docker_config.mkdir(mode=0o700)
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(WORK), 'LANG': 'C.UTF-8',
                   'DOCKER_CONFIG': str(docker_config), 'DOCKER_BUILDKIT': '0'}
    report = {'schemaVersion': 1, 'status': 'preflight', 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'gitRevision': revision, 'archiveSha256': archive_sha, 'sourceDirectory': str(source),
              'sourceManifestSha256': digest(manifest_bytes), 'sourceFilesVerified': len(entries),
              'cjsSha256': cjs_sha, 'cjsBytes': len(cjs), 'dockerfileSha256': digest(dockerfile),
              'prepareSha256': digest(prepare_bytes), 'baseImage': BASE_IMAGE, 'baseImageId': BASE_ID,
              'registryImage': prepare['registryImage'], 'registryImageId': prepare['registryImageId'],
              'servicesBefore': services(environment), 'profileBeforeSha256': profile_hash(),
              'protectedBeforeSha256': protected_hash(environment), 'ownedContainersBefore': container_ids(environment),
              'globalContainersBefore': container_ids(environment, GLOBAL_DOCKER), 'daemonBefore': daemon_identity(environment),
              'serviceMutations': False, 'publicNetworkRequests': 0, 'publicTransactions': 0, 'paidProviderRequests': 0,
              'productionProfileEnabled': False, 'acceptanceImageOnly': True}
    require(report['servicesBefore'] == prepare['servicesAfter'] and report['profileBeforeSha256'] == prepare['profileAfterSha256']
            and report['protectedBeforeSha256'] == prepare['protectedContainerBeforeSha256']
            and report['ownedContainersBefore'] == [PROTECTED])
    require(command(DOCKER + ['image', 'inspect', BASE_IMAGE, '--format', '{{.Id}}'], environment) == BASE_ID)
    require(command(DOCKER + ['image', 'inspect', prepare['registryImage'], '--format', '{{.Id}}'], environment) == prepare['registryImageId'])
    report['healthBefore'] = health()
    token = uuid.uuid4().hex
    registry_name = 'telomere-declared-build-20261015-' + revision[:12] + '-' + token[:8]
    labels = {'telomere.acceptance.owner': 'declared-state-20261015', 'telomere.acceptance.token': token,
              'telomere.acceptance.revision': revision}
    report['registryName'], report['registryLabels'] = registry_name, labels
    registry_id, mutation_requested, success = None, False, False
    persist(report_path, report)
    def interrupted(_signum, _frame):
        raise Refusal('Owned image build interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        # COPY preserves context file permissions in the explicitly selected
        # classic builder. Seal only this new, validated CJS inode; --chmod on
        # COPY would require BuildKit and is intentionally not used here.
        report['status'] = 'context_seal_requested'
        persist(report_path, report)
        cjs_path = context / 'declared-state-cell.cjs'
        before_cjs = cjs_path.lstat()
        require(private_file(cjs_path, 2 * 1024 * 1024) == cjs)
        cjs_fd = os.open(cjs_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            opened_cjs = os.fstat(cjs_fd)
            require((opened_cjs.st_dev, opened_cjs.st_ino, opened_cjs.st_size, opened_cjs.st_mtime_ns, opened_cjs.st_ctime_ns)
                    == (before_cjs.st_dev, before_cjs.st_ino, before_cjs.st_size, before_cjs.st_mtime_ns, before_cjs.st_ctime_ns)
                    and opened_cjs.st_nlink == 1 and opened_cjs.st_uid == os.getuid())
            os.fchmod(cjs_fd, 0o444)
            os.fsync(cjs_fd)
            sealed_cjs = os.fstat(cjs_fd)
            require((sealed_cjs.st_dev, sealed_cjs.st_ino, sealed_cjs.st_size, sealed_cjs.st_mtime_ns)
                    == (before_cjs.st_dev, before_cjs.st_ino, before_cjs.st_size, before_cjs.st_mtime_ns)
                    and stat.S_IMODE(sealed_cjs.st_mode) == 0o444)
        finally:
            os.close(cjs_fd)
        require(private_file(cjs_path, 2 * 1024 * 1024, (0o444,)) == cjs)
        report['contextCjsMode'] = '0444'
        registry_data.mkdir(mode=0o700)
        os.chown(registry_data, 10001, 10001)  # Fresh owned directory only; never an existing registry volume.
        report['status'] = 'registry_create_requested'
        persist(report_path, report)
        mutation_requested = True
        args = DOCKER + ['run', '--detach', '--name', registry_name, '--pull=never', '--network=host', '--read-only',
                         '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=10001:10001',
                         '--memory=128m', '--memory-swap=128m', '--pids-limit=64',
                         '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=8m',
                         '--mount=type=bind,src=' + str(registry_data) + ',dst=/var/lib/registry',
                         '--env=REGISTRY_HTTP_ADDR=127.0.0.1:15004']
        for key, value in labels.items():
            args.append('--label=' + key + '=' + value)
        registry_id = command(args + [prepare['registryImage']], environment)
        require(re.fullmatch('[a-f0-9]{64}', registry_id))
        registry = inspect_owned_registry(registry_id, registry_name, labels, prepare['registryImageId'], environment)
        report['registryId'] = registry_id
        require(registry['State']['Running'] and registry['HostConfig']['NetworkMode'] == 'host')
        registry_namespace = os.stat('/proc/' + str(registry['State']['Pid']) + '/ns/net')
        expected_namespace = os.stat('/run/netns/' + NAMESPACE)
        require((registry_namespace.st_dev, registry_namespace.st_ino) == (expected_namespace.st_dev, expected_namespace.st_ino))
        ready = False
        for _ in range(30):
            try:
                value = command(['nsenter', '--net=/run/netns/' + NAMESPACE, 'curl', '--noproxy', '*', '--max-time', '2',
                                 '--fail', '--silent', '--show-error', 'http://127.0.0.1:15004/v2/'], environment, 3)
                require(json.loads(value) == {})
                ready = True
                break
            except (subprocess.SubprocessError, OSError, ValueError, Refusal):
                time.sleep(0.2)
        require(ready)
        report['status'] = 'build_requested'
        persist(report_path, report)
        require(private_file(context / 'declared-state-cell.cjs', 2 * 1024 * 1024, (0o444,)) == cjs
                and private_file(context / 'Dockerfile', 4096) == dockerfile)
        command(DOCKER + ['build', '--network=none', '--pull=false', '--rm=true', '--force-rm=true',
                         '--build-arg=BASE_IMAGE=' + BASE_IMAGE, '--tag=' + REPOSITORY + ':acceptance', str(context)],
                environment, 180, WORK / 'image-build.private.log')
        image_id = command(DOCKER + ['image', 'inspect', REPOSITORY + ':acceptance', '--format', '{{.Id}}'], environment)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image_id) and image_id != BASE_ID)
        report['imageId'], report['status'] = image_id, 'push_requested'
        persist(report_path, report)
        command(DOCKER + ['push', REPOSITORY + ':acceptance'], environment, 180, WORK / 'image-push.private.log')
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
        require(private_file(context / 'declared-state-cell.cjs', 2 * 1024 * 1024, (0o444,)) == cjs
                and private_file(context / 'Dockerfile', 4096) == dockerfile)
        success = True
    except BaseException as error:
        report['failureType'] = type(error).__name__
        success = False
    finally:
        # Signals must not re-enter cleanup. SIGKILL cannot run finally; the
        # durable exact name/token marker is retained for explicit reconciliation.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        cleanup_ok = not mutation_requested
        if mutation_requested:
            try:
                registry = inspect_owned_registry(registry_id or registry_name, registry_name, labels, prepare['registryImageId'], environment)
                registry_id = registry['Id']
                if registry['State']['Running']:
                    command(DOCKER + ['stop', '--time=5', registry_id], environment, 15)
                registry = inspect_owned_registry(registry_id, registry_name, labels, prepare['registryImageId'], environment)
                require(not registry['State']['Running'])
                command(DOCKER + ['rm', registry_id], environment)
                cleanup_ok = registry_id not in container_ids(environment)
            except BaseException:
                cleanup_ok = False
        report['registryCleanupConfirmed'] = cleanup_ok
        try:
            report['servicesAfter'], report['profileAfterSha256'] = services(environment), profile_hash()
            report['protectedAfterSha256'], report['ownedContainersAfter'] = protected_hash(environment), container_ids(environment)
            report['globalContainersAfter'], report['daemonAfter'] = container_ids(environment, GLOBAL_DOCKER), daemon_identity(environment)
            report['healthAfter'] = health()
            success = success and cleanup_ok and report['servicesAfter'] == report['servicesBefore']
            success = success and report['profileAfterSha256'] == report['profileBeforeSha256'] and report['protectedAfterSha256'] == report['protectedBeforeSha256']
            success = success and report['ownedContainersAfter'] == report['ownedContainersBefore'] and report['globalContainersAfter'] == report['globalContainersBefore']
            success = success and report['daemonAfter'] == report['daemonBefore'] and digest(private_file(WORK / 'prepare.json', 65_536)) == report['prepareSha256']
            success = success and private_file(context / 'declared-state-cell.cjs', 2 * 1024 * 1024, (0o444,)) == cjs and private_file(context / 'Dockerfile', 4096) == dockerfile
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
