"""Stop only the verified, idle declared-state acceptance daemon and namespace.

Usage: python3 HELPER /absolute/fixed-work/private-image-build-report.json
The image report may be a retained failed attempt if its postflight proved the
exact idle daemon/container inventory. No image, data or ordinary file removal.
Unknown/partial cleanup is retained for explicit operator review, never retried.
"""
import datetime
import hashlib
import http.client
import json
import os
import pathlib
import re
import signal
import socket as sockets
import stat
import subprocess
import sys
import time
import uuid

WORK = pathlib.Path('/opt/telomere-host-runtime/declared-state-gvisor-20261015')
RUN = pathlib.Path('/run/telomere-declared-accept-20261015')
NAMESPACE = 'tlmr-declared-accept-20261015'
NAMESPACE_PATH = pathlib.Path('/run/netns') / NAMESPACE
UNIT = 'telomere-declared-accept-20261015.service'
DATA = pathlib.Path('/opt/telomere-host-runtime/docker-data')
SOCKET = RUN / 'docker.sock'
PROTECTED = '1d7ecc9b94866b9617df656ad7e2251916a9b7ceafef9a488ef6e85540076c5e'
CGROUP = pathlib.Path('/sys/fs/cgroup/system.slice') / UNIT
SERVICES = ['telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service']
DOCKER = ['docker', '--host', 'unix://' + str(SOCKET)]
GLOBAL_DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']
ENV = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(WORK), 'LANG': 'C.UTF-8'}


class Refusal(Exception):
    pass


def require(value):
    if not value:
        raise Refusal('Owned acceptance cleanup precondition refused')


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def private_directory(path):
    require(path.is_absolute() and path.resolve() == path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700)
    for parent in [path, *path.parents]:
        require(stat.S_ISDIR(parent.lstat().st_mode) and not parent.is_symlink())


def private_bytes(path, maximum):
    info = path.lstat()
    require(path.is_absolute() and path.parent == WORK and stat.S_ISREG(info.st_mode)
            and info.st_uid == 0 and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600
            and 0 < info.st_size <= maximum)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        signature = lambda row: (row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns, row.st_ctime_ns)
        require(signature(info) == signature(opened))
        with os.fdopen(fd, 'rb', closefd=False) as source:
            value = source.read(maximum + 1)
        require(len(value) == info.st_size and signature(info) == signature(path.lstat()))
        return value
    finally:
        os.close(fd)


def command(args, timeout=15):
    # Only fixed read-only queries, systemctl stop of UNIT, and ip netns del of
    # NAMESPACE are permitted by the call sites below. No shell or PID signals.
    value = subprocess.check_output(args, env=ENV, stdin=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=timeout)
    require(len(value) <= 1_048_576)
    return value.decode('utf-8', errors='strict').strip()


def services():
    return {name: command(['systemctl', 'show', name, '--property=ActiveState', '--property=SubState',
                          '--property=NRestarts', '--property=MainPID', '--property=WorkingDirectory']) for name in SERVICES}


def profile_hash():
    return sha(pathlib.Path('/opt/telomere-pilot/config/staging.env').read_bytes())


def health():
    result = {}
    # A literal HTTPConnection neither follows redirects nor consults proxies.
    for name, expected in [('live', 'ok'), ('ready', 'ready')]:
        connection = http.client.HTTPConnection('127.0.0.1', 13280, timeout=5)
        try:
            connection.request('GET', '/health/' + name)
            response = connection.getresponse()
            body = response.read(4097)
            require(response.status == 200 and len(body) <= 4096 and json.loads(body)['status'] == expected)
            result[name] = {'statusCode': 200, 'status': expected}
        finally:
            connection.close()
    return result


def containers(prefix):
    result = command(prefix + ['ps', '--all', '--quiet', '--no-trunc']).splitlines()
    require(all(re.fullmatch('[a-f0-9]{64}', value) for value in result) and len(result) == len(set(result)))
    return sorted(result)


def protected_hash():
    raw = command(DOCKER + ['inspect', PROTECTED])
    values = json.loads(raw)
    require(len(values) == 1 and values[0]['Id'] == PROTECTED
            and values[0]['State']['Status'] == 'exited' and values[0]['State']['Running'] is False
            and values[0]['Config']['Labels'] == {})
    return sha(raw.encode())


def protected_disk():
    # These files are never copied to a report or changed. Their hashes permit
    # an after-stop comparison when the deliberately stopped API is unavailable.
    parent = DATA / 'containers' / PROTECTED
    require(parent.resolve() == parent and parent.is_dir() and not parent.is_symlink())
    result = {}
    for name in ('config.v2.json', 'hostconfig.json'):
        path = parent / name
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and not path.is_symlink() and 0 < info.st_size <= 2 * 1024 * 1024)
        raw = path.read_bytes()
        require(len(raw) == info.st_size)
        result[name] = {'bytes': len(raw), 'sha256': sha(raw)}
    return result


def unit_state():
    # A successfully stopped transient unit may already be garbage-collected.
    # systemctl can return1 for that explicit not-found/inactive projection.
    row = subprocess.run(['systemctl', 'show', UNIT, '--property=LoadState', '--property=ActiveState',
                          '--property=SubState', '--property=MainPID', '--property=ControlGroup', '--property=NRestarts'],
                         env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         timeout=15, check=False)
    require(row.returncode in (0, 1) and len(row.stdout) <= 4096)
    text = row.stdout.decode('utf-8', errors='strict').strip()
    values = dict(line.split('=', 1) for line in text.splitlines())
    require(set(values) == {'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup', 'NRestarts'})
    require(row.returncode == 0 or (values['LoadState'] == 'not-found' and values['ActiveState'] == 'inactive'
                                  and values['MainPID'] == '0' and values['ControlGroup'] == ''))
    return values


def namespace_identity():
    info = NAMESPACE_PATH.lstat()
    require(not NAMESPACE_PATH.is_symlink() and stat.S_ISREG(info.st_mode))
    return {'device': str(info.st_dev), 'inode': str(info.st_ino)}


def process_identity(pid):
    root = pathlib.Path('/proc', str(pid))
    argv_raw = (root / 'cmdline').read_bytes()
    argv = argv_raw.split(b'\0')
    require(argv[0] == b'/usr/bin/dockerd')
    expected = ['--config-file=' + str(WORK / 'daemon.json'), '--host=unix://' + str(SOCKET),
                '--data-root=' + str(DATA), '--exec-root=' + str(RUN / 'exec'),
                '--pidfile=' + str(RUN / 'docker.pid'), '--containerd-namespace=' + NAMESPACE,
                '--containerd-plugins-namespace=' + NAMESPACE + '-plugins', '--bridge=none',
                '--iptables=false', '--ip6tables=false', '--ip-masq=false', '--storage-driver=vfs',
                '--add-runtime=runsc=/opt/telomere-host-runtime/gvisor/runsc']
    require(argv == [b'/usr/bin/dockerd', *(value.encode() for value in expected), b''])
    current = os.stat(root / 'ns/net')
    require(namespace_identity() == {'device': str(current.st_dev), 'inode': str(current.st_ino)})
    process_stat = (root / 'stat').read_text()
    require(')' in process_stat)
    start_ticks = process_stat.rsplit(')', 1)[1].split()[19]
    require(start_ticks.isdigit())
    require((RUN / 'docker.pid').read_text().strip() == str(pid))
    return {'pid': pid, 'startTicks': start_ticks, 'argvSha256': sha(argv_raw),
            'namespaceInode': str(current.st_ino), 'namespaceDevice': str(current.st_dev)}


def daemon_identity(image):
    require(stat.S_ISSOCK(SOCKET.lstat().st_mode) and not SOCKET.is_symlink())
    state = unit_state()
    require(state['LoadState'] == 'loaded' and state['ActiveState'] == 'active' and state['MainPID'].isdigit()
            and state['ControlGroup'] == '/system.slice/' + UNIT and state['NRestarts'] == '0')
    pid = int(state['MainPID'])
    require(pid > 1 and image['daemonBefore'] == image['daemonAfter'])
    actual = process_identity(pid)
    require({key: actual[key] for key in ('pid', 'argvSha256', 'namespaceInode')} == image['daemonAfter'])
    require(command(DOCKER + ['info', '--format', '{{.DockerRootDir}}']) == str(DATA)
            and command(DOCKER + ['info', '--format', '{{.Driver}}']) == 'vfs'
            and command(DOCKER + ['info', '--format', '{{.Runtimes.runsc.Path}}']) == '/opt/telomere-host-runtime/gvisor/runsc')
    return actual


def cgroup_processes():
    if not CGROUP.exists():
        return []
    require(CGROUP.resolve() == CGROUP and not CGROUP.is_symlink())
    files = [CGROUP / 'cgroup.procs', *CGROUP.rglob('*/cgroup.procs')]
    require(len(files) <= 1024)
    pids = set()
    for path in files:
        require(path.is_relative_to(CGROUP) and not path.is_symlink() and path.resolve() == path)
        raw = path.read_text()
        require(len(raw) <= 65536)
        for value in raw.splitlines():
            require(value.isdigit())
            pids.add(int(value))
    return sorted(pids)


def socket_unusable():
    try:
        info = SOCKET.lstat()
    except FileNotFoundError:
        return True
    require(stat.S_ISSOCK(info.st_mode) and not SOCKET.is_symlink())
    with sockets.socket(sockets.AF_UNIX, sockets.SOCK_STREAM) as client:
        client.settimeout(0.5)
        try:
            client.connect(str(SOCKET))
            return False
        except (ConnectionRefusedError, FileNotFoundError):
            return True


def persist(path, report):
    temporary = path.with_name(path.name + '.pending-' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        value = (json.dumps(report, indent=2) + '\n').encode()
        written = 0
        while written < len(value):
            count = os.write(fd, value[written:])
            require(count > 0)
            written += count
        os.fsync(fd)
    finally:
        os.close(fd)
    if path.exists():
        private_bytes(path, 1_048_576)
    require(not path.is_symlink())
    os.replace(temporary, path)
    directory = os.open(WORK, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def main(args):
    require(len(args) == 1 and os.getuid() == 0)
    private_directory(WORK)
    private_directory(RUN)
    image_path = pathlib.Path(args[0])
    require(image_path.parent == WORK and image_path.name.endswith('.json') and image_path.name != 'cleanup.json')
    prepare_raw = private_bytes(WORK / 'prepare.json', 65_536)
    image_raw = private_bytes(image_path, 1_048_576)
    prepare, image = json.loads(prepare_raw), json.loads(image_raw)
    require(prepare['status'] == 'prepared' and prepare['work'] == str(WORK) and prepare['run'] == str(RUN)
            and prepare['socket'] == str(SOCKET) and prepare['namespace'] == NAMESPACE and prepare['unit'] == UNIT
            and prepare['dataRoot'] == str(DATA) and prepare['protectedContainerId'] == PROTECTED)
    require(image['prepareSha256'] == sha(prepare_raw) and image['registryCleanupConfirmed'] is True
            and image['ownedContainersBefore'] == image['ownedContainersAfter'] == [PROTECTED]
            and image['globalContainersBefore'] == image['globalContainersAfter']
            and image['servicesBefore'] == image['servicesAfter'] == prepare['servicesAfter'] == prepare['servicesBefore']
            and image['profileBeforeSha256'] == image['profileAfterSha256'] == prepare['profileBeforeSha256'] == prepare['profileAfterSha256']
            and image['protectedBeforeSha256'] == image['protectedAfterSha256'] == prepare['protectedContainerBeforeSha256'])
    output = WORK / 'cleanup.json'
    require(not output.exists() and not output.is_symlink())
    os.umask(0o077)
    report = {'schemaVersion': 1, 'status': 'preflight', 'startedAt': now(), 'unit': UNIT, 'namespace': NAMESPACE,
              'prepareSha256': sha(prepare_raw), 'imageReportName': image_path.name, 'imageReportSha256': sha(image_raw),
              'stagingServiceMutations': False, 'globalDockerMutations': False, 'dataOrImageDeletion': False,
              'publicTransactions': 0, 'paidProviderRequests': 0, 'automaticRetryAllowed': False}
    persist(output, report)
    def interrupted(_signal, _frame):
        raise Refusal('Owned acceptance cleanup interrupted')
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    success = False
    try:
        report['servicesBefore'], report['profileBeforeSha256'], report['healthBefore'] = services(), profile_hash(), health()
        require(report['servicesBefore'] == prepare['servicesAfter'] and report['profileBeforeSha256'] == prepare['profileAfterSha256'])
        report['globalContainersBefore'], report['ownedContainersBefore'] = containers(GLOBAL_DOCKER), containers(DOCKER)
        report['protectedBeforeSha256'], report['protectedDiskBefore'] = protected_hash(), protected_disk()
        require(report['globalContainersBefore'] == image['globalContainersAfter'] and report['ownedContainersBefore'] == [PROTECTED]
                and report['protectedBeforeSha256'] == prepare['protectedContainerBeforeSha256'])
        report['daemonBefore'], report['namespaceBefore'] = daemon_identity(image), namespace_identity()
        # Re-read every authority file and process identity immediately before
        # persisting the one permitted stop request. Never signal a raw PID.
        require(private_bytes(WORK / 'prepare.json', 65_536) == prepare_raw and private_bytes(image_path, 1_048_576) == image_raw
                and daemon_identity(image) == report['daemonBefore'] and containers(DOCKER) == [PROTECTED])
        report['status'] = 'owned_unit_stop_requested'
        persist(output, report)
        command(['systemctl', 'stop', '--no-block', UNIT], timeout=10)
        deadline = time.monotonic() + 60
        stopped = False
        while time.monotonic() < deadline:
            state = unit_state()
            if state['ActiveState'] in ('inactive', 'failed') and state['MainPID'] == '0' \
                    and not pathlib.Path('/proc', str(report['daemonBefore']['pid'])).exists() \
                    and not cgroup_processes() and socket_unusable():
                report['unitAfterStop'] = state
                stopped = True
                break
            time.sleep(0.25)
        require(stopped and namespace_identity() == report['namespaceBefore'])
        require(command(['ip', 'netns', 'pids', NAMESPACE]) == '')
        report['status'], report['cgroupEmpty'], report['daemonPidGone'], report['socketUnusable'] = 'owned_unit_stopped', True, True, True
        persist(output, report)
        require(namespace_identity() == report['namespaceBefore'] and not cgroup_processes()
                and not pathlib.Path('/proc', str(report['daemonBefore']['pid'])).exists() and socket_unusable()
                and command(['ip', 'netns', 'pids', NAMESPACE]) == '')
        report['status'] = 'owned_namespace_delete_requested'
        persist(output, report)
        command(['ip', 'netns', 'del', NAMESPACE], timeout=10)
        require(not NAMESPACE_PATH.exists() and not NAMESPACE_PATH.is_symlink())
        report['namespaceRemoved'] = True
        success = True
    except BaseException as error:
        report['failureType'] = type(error).__name__
    finally:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        try:
            report['servicesAfter'], report['profileAfterSha256'], report['healthAfter'] = services(), profile_hash(), health()
            report['globalContainersAfter'], report['protectedDiskAfter'] = containers(GLOBAL_DOCKER), protected_disk()
            require(report['servicesAfter'] == prepare['servicesAfter'] and report['profileAfterSha256'] == prepare['profileAfterSha256']
                    and report['globalContainersAfter'] == image['globalContainersAfter']
                    and report['protectedDiskAfter'] == report.get('protectedDiskBefore')
                    and private_bytes(WORK / 'prepare.json', 65_536) == prepare_raw and private_bytes(image_path, 1_048_576) == image_raw)
        except BaseException as error:
            report['postflightFailureType'] = type(error).__name__
            success = False
        report['success'], report['finishedAt'] = bool(success), now()
        if success:
            report['status'] = 'owned_acceptance_stopped'
        else:
            report['lastStage'] = report['status']
            report['status'] = 'failed_requires_explicit_reconciliation'
        persist(output, report)
        print(json.dumps(report, separators=(',', ':')), flush=True)
    return 0 if success else 1


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        print(json.dumps({'schemaVersion': 1, 'success': False, 'status': 'refused_without_unverified_cleanup',
                          'failureType': type(error).__name__}), flush=True)
        sys.exit(1)
