#!/usr/bin/env python3
"""Reviewed operator runner, LOCAL PREPARATION ONLY until root explicitly runs it on Linux.

No SSH, remote invocation, public transaction, provider POST, automatic data restore,
old-tree overlay, or deletion is implemented. Every mutation is a named phase.
"""
import argparse
import datetime
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import signal
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request

BASE = Path('/opt/telomere-pilot')
OLD = BASE / 'app'
PROFILE = BASE / 'config/staging.env'
NODE = '/opt/node-v22.23.3-linux-x64/bin/node'
NPM = '/opt/node-v22.23.3-linux-x64/bin/npm'
GLOBAL = 'unix:///var/run/docker.sock'
UNITS = ['telomere-staging-watchdog.service', 'telomere-staging.service', 'telomere-staging-chain.service']
NODE_HELPER = Path(__file__).with_name('clone-smoke.mjs').resolve()
PHASE = 'arguments'

class Refusal(Exception):
    pass

def require(condition, code):
    if not condition:
        raise Refusal(code)

def digest(path):
    result = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1048576), b''):
            result.update(block)
    return result.hexdigest()

def private_json(path, value, *, exclusive=True):
    path = Path(path)
    with open(path, 'x' if exclusive else 'w', opener=lambda name, flags: os.open(name, flags, 0o600)) as output:
        json.dump(value, output, sort_keys=True, separators=(',', ':'))
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())

def read_private(path):
    path = Path(path)
    meta = path.lstat()
    require(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1 and not meta.st_mode & 0o077 and meta.st_size <= 1048576, 'private_input')
    return json.loads(path.read_text())

def within(path, root):
    path, root = Path(path), Path(root)
    require(path.is_absolute() and '..' not in path.parts and root.is_absolute(), 'path_scope')
    require(path != root and root.resolve() in path.resolve().parents, 'resolved_path_scope')
    for candidate in [path, *path.parents]:
        if candidate.exists() or candidate.is_symlink():
            require(not candidate.is_symlink(), 'symlink_ancestor')
        if candidate == root:
            break
    require(not path.is_symlink(), 'symlink_target')
    return path

def safe_member_name(name):
    name = name.rstrip('/')
    require(name and not name.startswith('/') and '..' not in name.split('/') and '\\' not in name and ':' not in name
            and all(part not in ['', '.'] for part in name.split('/')), 'unsafe_tar_member')
    return name

def command(args, *, timeout=30, env=None, log=None, cwd=None):
    # Child output stays private. Exception messages and argv are never echoed.
    environment = {'PATH': '/opt/node-v22.23.3-linux-x64/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
    if env:
        environment.update(env)
    output = open(log, 'xb', opener=lambda name, flags: os.open(name, flags, 0o600)) if log else None
    child = None
    try:
        child = subprocess.Popen(args, cwd=cwd, env=environment, stdin=subprocess.DEVNULL, start_new_session=True,
            stdout=output if output else subprocess.PIPE, stderr=subprocess.STDOUT if output else subprocess.DEVNULL)
        try:
            captured, _ = child.communicate(timeout=timeout)
        except BaseException:
            # npm/tsx/pg_dump descendants inherit this NEW process group. Do not leave them running after a timeout.
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=5)
            raise
        require(child.returncode == 0, 'private_child_failed')
        if output:
            return ''
        require(len(captured) <= 1048576, 'command_output_bound')
        return captured.decode().strip()
    finally:
        if output:
            output.close()

def docker(*args, host=GLOBAL, **kwargs):
    return command(['/usr/bin/docker', '--host', host, *args], **kwargs)

def service_state():
    output = {}
    for unit in UNITS:
        text = command(['systemctl', 'show', unit, '--no-pager', '--property=ActiveState', '--property=SubState', '--property=NRestarts'])
        output[unit] = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
    return output

def old_running():
    for item in service_state().values():
        require(item.get('ActiveState') == 'active' and item.get('SubState') == 'running', 'old_units_not_running')

def no_managed_cells():
    require(not docker('ps', '--all', '--filter', 'label=telomere.managed=true', '--format', '{{.ID}}'), 'managed_cells_present')

def health():
    deadline = time.monotonic() + 25
    while True:
        try:
            for path in ['/health/live', '/health/ready']:
                with urllib.request.urlopen('http://127.0.0.1:13280' + path, timeout=2) as response:
                    require(response.status == 200, 'health_failed')
                    body = response.read(65537)
                    require(len(body) <= 65536, 'health_body_bound')
                    payload = json.loads(body)
                    require(isinstance(payload, dict), 'health_body')
                    if path.endswith('ready'):
                        require(payload.get('ready') is True or payload.get('status') == 'ready', 'not_ready')
            return
        except (OSError, ValueError, Refusal):
            require(time.monotonic() < deadline, 'health_deadline')
            time.sleep(0.25)

def protected_identity(owned_dropin=None, active_release=None):
    identity = {'units': {}, 'oldFiles': {}}
    for unit in UNITS:
        fields = command(['systemctl', 'show', unit, '--no-pager', '--property=FragmentPath', '--property=DropInPaths',
            '--property=WorkingDirectory', '--property=User', '--property=Group', '--property=EnvironmentFiles',
            '--property=ReadWritePaths', '--property=ProtectSystem', '--property=ProtectHome', '--property=NoNewPrivileges',
            '--property=PrivateTmp', '--property=MemoryMax', '--property=TasksMax'])
        values = dict(line.split('=', 1) for line in fields.splitlines() if '=' in line)
        if unit == 'telomere-staging.service' and owned_dropin:
            require(values.get('WorkingDirectory') in [str(OLD), active_release], 'unexpected_controller_directory')
            values['WorkingDirectory'] = str(OLD)
            values['DropInPaths'] = ' '.join(path for path in values.get('DropInPaths', '').split() if path != str(owned_dropin))
        paths = [values['FragmentPath'], *values.get('DropInPaths', '').split()]
        files = {}
        for path in paths:
            require(path.startswith(('/etc/systemd/system/', '/usr/lib/systemd/system/', '/lib/systemd/system/')), 'unit_file_scope')
            require(Path(path).is_file() and not Path(path).is_symlink(), 'unit_file_identity')
            files[path] = digest(path)
        identity['units'][unit] = {'staticPropertiesSha256': hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest(), 'files': files}
    files = [OLD / 'package.json', OLD / 'package-lock.json', Path(NODE),
             OLD / 'node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil', *sorted((OLD / 'dist').rglob('*'))]
    require(len(files) <= 10000, 'old_source_bound')
    for path in files:
        if path.is_file():
            require(not path.is_symlink(), 'old_source_symlink')
            identity['oldFiles'][str(path)] = digest(path)
    require(str(OLD / 'dist/src/main.js') in identity['oldFiles'], 'old_main_missing')
    return identity

def assert_protected(state):
    require(protected_identity() == state['protectedIdentity'], 'protected_unit_or_old_code_changed')

def global_inventory():
    containers = docker('ps', '--all', '--no-trunc', '--format', '{{.ID}} {{.Names}}').splitlines()
    images = docker('image', 'ls', '--no-trunc', '--quiet').splitlines()
    return {'containerIdentities': sorted(containers), 'imageIdentities': sorted(set(images))}

def restart_old_units():
    # No DB/chain/Cyst restore. Old original executable paths remain in their units.
    command(['systemctl', 'start', 'telomere-staging-chain.service'], timeout=20)
    command(['systemctl', 'start', 'telomere-staging.service'], timeout=40)
    command(['systemctl', 'start', 'telomere-staging-watchdog.service'], timeout=15)
    old_running()
    health()

def stop_snapshot_units():
    old_running()
    no_managed_cells()
    command(['systemctl', 'stop', 'telomere-staging-watchdog.service'], timeout=15)
    command(['systemctl', 'stop', 'telomere-staging.service'], timeout=40)
    no_managed_cells()
    command(['systemctl', 'stop', 'telomere-staging-chain.service'], timeout=20)
    for unit in UNITS:
        require(command(['systemctl', 'show', unit, '--property=ActiveState', '--value']) == 'inactive', 'unit_not_inactive')

def new_port(used):
    for _ in range(20):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        if port not in used and port > 1023:
            used.add(port)
            return port
    raise Refusal('port_allocation')

def state_path(args):
    require(re.fullmatch(r'staging-[a-f0-9]{12}-[a-z0-9]{6,16}', args.run), 'run_id')
    return BASE / 'rollout' / args.run

def helper(work, label, options, *, service_user=False):
    config = work / (label + '-options.json')
    private_json(config, options)
    if service_user:
        account = pwd.getpwnam('telomere')
        os.chown(config, account.pw_uid, account.pw_gid)
        owned_unit = 'telomere-' + work.name + '-' + label + '.service'
        require(command(['systemctl', 'show', owned_unit, '--property=LoadState', '--value']) == 'not-found', 'helper_unit_exists')
        invocation = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--unit=' + owned_unit,
            '--property=User=telomere', '--property=Group=telomere', '--property=SupplementaryGroups=docker',
            '--property=NoNewPrivileges=yes', '--property=PrivateTmp=yes', '--property=ProtectHome=yes',
            '--property=ProtectSystem=strict', '--property=UMask=0077', '--property=MemoryMax=768M',
            '--property=TimeoutStopSec=20', '--property=KillMode=control-group',
            '--property=CPUQuota=100%', '--property=TasksMax=128', '--property=ReadWritePaths=' + str(work / 'clone'),
            '--setenv=DOCKER_HOST=' + options['dockerHost'], '--working-directory=' + options['release'],
            NODE, str(work / 'clone-smoke.mjs'), 'clone', str(config)]
    else:
        action = 'fingerprint' if label.startswith('fingerprint-') else label
        invocation = [NODE, str(work / 'clone-smoke.mjs'), action, str(config)]
    try:
        command(invocation, timeout=100, log=work / (label + '.private.log'))
    finally:
        if service_user:
            # Killing systemd-run alone would leave the real controller process alive.
            load = command(['systemctl', 'show', owned_unit, '--property=LoadState', '--value'])
            if load != 'not-found':
                try:
                    command(['systemctl', 'stop', owned_unit], timeout=25)
                except BaseException:
                    command(['systemctl', 'kill', '--kill-whom=all', '--signal=KILL', owned_unit], timeout=5)
                status = command(['systemctl', 'show', owned_unit, '--property=ActiveState', '--value'])
                require(status in ['inactive', 'failed'], 'helper_unit_not_stopped')
                require(command(['systemctl', 'show', owned_unit, '--property=MainPID', '--value']) in ['0', ''], 'helper_pid_remaining')

def check_gates(args):
    gates = read_private(args.gates)
    require(gates == {'schemaVersion': 2, 'revision': args.revision, 'archiveSha256': args.sha256,
        'initialFullFailureClassifiedGasOnly': True, 'exactSourceContinuity': True,
        'correctedSelectionCohortPassed': True, 'additive71Passed': True,
        'paidFileGvisor16Passed': True}, 'composed_acceptance_gates_not_satisfied')

def prepare(args):
    global PHASE
    PHASE = 'prepare'
    check_gates(args)
    require(re.fullmatch(r'[a-f0-9]{40}', args.revision) and re.fullmatch(r'[a-f0-9]{64}', args.sha256), 'source_identity')
    require(args.run.startswith('staging-' + args.revision[:12] + '-'), 'run_revision_mismatch')
    work = state_path(args)
    require(not work.exists(), 'work_already_exists')
    release = BASE / 'releases' / (args.revision + '-' + args.run.rsplit('-', 1)[1])
    require(not release.exists(), 'release_already_exists')
    manifest = json.loads(Path(args.manifest).read_text())
    require(manifest['gitRevision'] == args.revision and manifest['archiveSha256'] == args.sha256
            and manifest['source'] == 'committed_git_blobs_only' and manifest['workingTreeIncluded'] is False
            and len(manifest['files']) == 685 and digest(args.archive) == args.sha256, 'archive_identity')
    entries = {row['path']: row for row in manifest['files']}
    require(len(entries) == 685, 'manifest_duplicates')
    require(sum(row['bytes'] for row in entries.values()) <= 536870912, 'archive_total_bound')
    for path, row in entries.items():
        require(not Path(path).is_absolute() and '..' not in Path(path).parts and '\\' not in path
                and re.fullmatch(r'[a-f0-9]{64}', row['sha256']) and 0 <= row['bytes'] <= 67108864, 'manifest_entry')
    account = pwd.getpwnam('telomere')
    for parent in [BASE / 'rollout', BASE / 'releases']:
        require(not parent.is_symlink(), 'unsafe_parent')
        parent.mkdir(mode=0o750, exist_ok=True)
        os.chown(parent, 0, account.pw_gid)
        os.chmod(parent, 0o750)
    work.mkdir(mode=0o750)
    os.chown(work, 0, account.pw_gid)
    release.mkdir(mode=0o750)
    with tarfile.open(args.archive, 'r:gz') as archive:
        members = archive.getmembers()
        require(len(members) <= 10000, 'archive_count')
        regular = [member for member in members if member.isfile()]
        require({member.name for member in regular} == set(entries) and len(regular) == len(entries), 'archive_file_set')
        require(all(member.isfile() or member.isdir() for member in members), 'archive_links_forbidden')
        for member in members:
            safe_member_name(member.name)
            path = within(release / member.name, release)
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True, mode=0o750)
                continue
            row = entries[member.name]
            require(member.size == row['bytes'], 'archive_length')
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
            data = archive.extractfile(member).read()
            require(hashlib.sha256(data).hexdigest() == row['sha256'], 'archive_content')
            with open(path, 'xb', opener=lambda name, flags: os.open(name, flags, 0o640)) as output:
                output.write(data)
    shutil.copyfile(NODE_HELPER, work / 'clone-smoke.mjs')
    os.chmod(work / 'clone-smoke.mjs', 0o640)
    os.chown(work / 'clone-smoke.mjs', 0, account.pw_gid)
    # Offline only: a missing npm cache is a preparation failure, never a reason to pull code during maintenance.
    command([NPM, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], timeout=600, cwd=release, log=work / 'npm-ci.private.log')
    command([NPM, 'run', 'build'], timeout=180, cwd=release, log=work / 'build.private.log')
    for path in sorted(release.rglob('*')):
        if path.is_symlink():
            require(release in path.resolve().parents, 'dependency_symlink_escape')
            continue
        os.chown(path, 0, account.pw_gid)
        os.chmod(path, 0o750 if path.is_dir() or path.stat().st_mode & 0o111 else 0o640)
    os.chown(release, 0, account.pw_gid)
    os.chmod(release, 0o750)
    for path, row in entries.items():
        require(digest(release / path) == row['sha256'], 'build_changed_source')
    private_json(work / 'state.json', {'schemaVersion': 1, 'run': args.run, 'revision': args.revision,
        'archiveSha256': args.sha256, 'release': str(release), 'stage': 'prepared', 'preparedAt': time.time(),
        'sourceManifestSha256': digest(args.manifest), 'nodeHelperSha256': digest(work / 'clone-smoke.mjs'),
        'runnerSha256': digest(Path(__file__).resolve()),
        'protectedIdentity': protected_identity(), 'originalUnitStates': service_state()})
    old_running()
    health()

def load_state(args):
    work = state_path(args)
    require(work.exists() and not work.is_symlink(), 'work_missing')
    state = read_private(work / 'state.json')
    require(state['run'] == args.run and digest(work / 'clone-smoke.mjs') == state['nodeHelperSha256'], 'state_identity')
    require(digest(Path(__file__).resolve()) == state['runnerSha256'], 'runner_changed_after_prepare')
    return work, state

def update(work, state):
    # State replaces only this run's private marker, never any application state.
    private_json(work / 'state.json.next', state)
    os.replace(work / 'state.json.next', work / 'state.json')
    descriptor = os.open(work, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def stopped_capture(work, state, label):
    backup = work / '.local' / label
    stop_snapshot_units()
    started = time.monotonic()
    try:
        command([NPM, 'run', 'backup:staging', '--', '--output', str(backup)], timeout=65,
                cwd=state['release'], env={'DOCKER_HOST': GLOBAL}, log=work / (label + '.private.log'))
        command([NPM, 'run', 'backup:verify', '--', '--directory', str(backup)], timeout=15,
                cwd=state['release'], log=work / (label + '-verify.private.log'))
        manifest = read_private(backup / 'manifest.json')
        require(manifest['schemaVersion'] == 2, 'backup_v2_required')
        helper(work, 'fingerprint-' + label, {'release': state['release'], 'work': str(work), 'profile': str(PROFILE),
            'output': str(work / (label + '-fingerprint.json'))})
        require(time.monotonic() - started <= 100, 'maintenance_deadline')
        return backup
    except BaseException:
        # Only restart existing units, never auto-restore partial data or activate a new release.
        restart_old_units()
        raise

def snapshot(args):
    global PHASE
    PHASE = 'snapshot'
    work, state = load_state(args)
    require(state['stage'] == 'prepared', 'wrong_phase')
    assert_protected(state)
    started = time.monotonic()
    try:
        backup = stopped_capture(work, state, 'snapshot')
    finally:
        restart_old_units()
    state.update(stage='snapshotted', backup=str(backup), snapshotMaintenanceSeconds=round(time.monotonic()-started, 3))
    update(work, state)

def owned_container(name, run):
    raw = docker('container', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "telomere.rollout.owner"}}', name)
    parts = raw.split()
    require(len(parts) == 2 and re.fullmatch(r'[a-f0-9]{64}', parts[0]) and parts[1] == run, 'owned_container_identity')
    return parts[0]

def clone_validate(args):
    global PHASE
    PHASE = 'clone_validate'
    work, state = load_state(args)
    require(state['stage'] == 'snapshotted', 'wrong_phase')
    assert_protected(state)
    clone = work / 'clone'
    require(not clone.exists(), 'clone_exists')
    clone.mkdir(mode=0o750)
    account = pwd.getpwnam('telomere')
    os.chown(clone, account.pw_uid, account.pw_gid)
    backup = Path(state['backup'])
    # The owned clone below replaces the older independently randomized one-run restore CLI.
    # It restores the same bundle and checks all five receipts without untracked child resources.
    shutil.copyfile(backup / 'chain.json', clone / 'chain.json')
    shutil.copyfile(backup / 'profile.env', clone / 'profile.env')
    shutil.copyfile(work / 'snapshot-fingerprint.json', clone / 'baseline.json')
    helper(work, 'restore-cysts', {'release': state['release'], 'work': str(work), 'profile': str(PROFILE),
        'backup': str(backup), 'cloneRoot': str(clone), 'output': str(work / 'cyst-restore.json')})
    for path in [clone, *clone.rglob('*')]:
        require(not path.is_symlink(), 'clone_symlink')
        os.chown(path, account.pw_uid, account.pw_gid)
        os.chmod(path, 0o700 if path.is_dir() else 0o600)
    (clone / 'controller-data').mkdir(mode=0o700)
    os.chown(clone / 'controller-data', account.pw_uid, account.pw_gid)
    ports = {13280, 15434, 18547}
    pg_port, chain_port, http_port = [new_port(ports) for _ in range(3)]
    password = secrets.token_hex(32)
    envfile = work / 'postgres.private.env'
    with open(envfile, 'x', opener=lambda name, flags: os.open(name, flags, 0o600)) as output:
        output.write('POSTGRES_PASSWORD=' + password + '\nPOSTGRES_USER=telomere_rollout\nPOSTGRES_DB=telomere_rollout\n')
    name = 'telomere-rollout-' + hashlib.sha256(args.run.encode()).hexdigest()[:24]
    namespace = 'tlmr-roll-' + hashlib.sha256(args.run.encode()).hexdigest()[:12]
    unit = 'telomere-' + namespace + '.service'
    host = 'unix://' + str(clone / 'run/docker.sock')
    anvil = None
    cid = None
    container_requested = False
    daemon_requested = False
    namespace_requested = False
    success = False
    cleanup = {}
    inventory = global_inventory()
    try:
        require(not Path('/run/netns', namespace).exists(), 'namespace_exists')
        image = docker('container', 'inspect', '--format', '{{.Image}}', 'telomere-staging-postgres')
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', image), 'installed_postgres_image')
        container_requested = True
        cid = docker('run', '--detach', '--pull=never', '--name', name, '--label', 'telomere.rollout.owner=' + args.run,
            '--cpus', '0.5', '--memory', '512m', '--pids-limit', '128', '--security-opt', 'no-new-privileges',
            '--publish', '127.0.0.1:' + str(pg_port) + ':5432', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=268435456',
            '--env-file', str(envfile), image)
        require(cid == owned_container(name, args.run), 'created_container_mismatch')
        deadline = time.monotonic() + 30
        while True:
            try:
                docker('exec', cid, 'pg_isready', '--host=127.0.0.1', '--username=telomere_rollout', '--dbname=telomere_rollout')
                break
            except Refusal:
                require(time.monotonic() < deadline, 'postgres_start_timeout')
                time.sleep(0.25)
        with open(backup / 'database.dump', 'rb') as source, open(work / 'pg-restore.private.log', 'xb') as log:
            result = subprocess.run(['/usr/bin/docker', '--host', GLOBAL, 'exec', '-i', cid, 'pg_restore', '--username=telomere_rollout',
                '--dbname=telomere_rollout', '--exit-on-error', '--no-owner', '--no-acl'], stdin=source, stdout=log,
                stderr=log, timeout=60, check=False)
        require(result.returncode == 0, 'pg_restore_failed')
        # New daemon has its OWN netns, data-root, exec-root and containerd namespace. Never old acceptance data roots.
        (clone / 'run').mkdir(mode=0o750)
        os.chown(clone / 'run', 0, grp.getgrnam('docker').gr_gid)
        private_json(clone / 'daemon.json', {})
        namespace_requested = True
        command(['ip', 'netns', 'add', namespace])
        command(['ip', '-n', namespace, 'link', 'set', 'lo', 'up'])
        require(command(['systemctl', 'show', unit, '--property=LoadState', '--value']) == 'not-found', 'daemon_unit_exists')
        daemon_requested = True
        command(['systemd-run', '--quiet', '--unit=' + unit, '--property=Delegate=yes', '--property=Restart=no',
            '--property=TimeoutStopSec=20', '--property=KillMode=control-group',
            '/usr/bin/nsenter', '--net=/run/netns/' + namespace, '/usr/bin/dockerd', '--config-file=' + str(clone / 'daemon.json'),
            '--host=' + host, '--data-root=' + str(clone / 'docker-data'), '--exec-root=' + str(clone / 'run/exec'),
            '--pidfile=' + str(clone / 'run/docker.pid'), '--containerd-namespace=' + namespace,
            '--containerd-plugins-namespace=' + namespace + '-plugins', '--bridge=none', '--iptables=false', '--ip6tables=false',
            '--ip-masq=false', '--storage-driver=vfs'])
        deadline = time.monotonic() + 30
        while True:
            try:
                docker('info', '--format', '{{.DockerRootDir}}', host=host)
                break
            except Refusal:
                require(time.monotonic() < deadline, 'daemon_start_timeout')
                time.sleep(0.25)
        require(docker('info', '--format', '{{.DockerRootDir}}', host=host) == str(clone / 'docker-data'), 'daemon_identity')
        socket_meta = (clone / 'run/docker.sock').stat()
        require(stat.S_ISSOCK(socket_meta.st_mode) and socket_meta.st_gid == grp.getgrnam('docker').gr_gid
                and not socket_meta.st_mode & 0o007, 'private_docker_socket')
        require(not docker('ps', '--all', '--quiet', host=host), 'new_daemon_not_empty')
        # The exact original digest is resolved in memory; export installed content only, never pull/registry actions.
        # Profile parsing/validation is delegated to Node; Python extracts only the already reviewed CPU_IMAGE line.
        cpu_lines = [line.split('=', 1)[1].strip().strip('"\'') for line in PROFILE.read_text().splitlines() if line.startswith('CPU_IMAGE=')]
        require(len(cpu_lines) == 1 and re.fullmatch(r'[A-Za-z0-9._/:@-]+@sha256:[a-f0-9]{64}', cpu_lines[0]), 'cpu_image_pin')
        cpu_id = docker('image', 'inspect', cpu_lines[0], '--format', '{{.Id}}')
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', cpu_id), 'cpu_image_id')
        docker('image', 'save', '--output', str(clone / 'cpu-image.tar'), cpu_id, timeout=120)
        docker('image', 'load', '--input', str(clone / 'cpu-image.tar'), host=host, timeout=120)
        require(docker('image', 'inspect', cpu_id, '--format', '{{.Id}}', host=host) == cpu_id, 'loaded_cpu_image')
        anvil_binary = OLD / 'node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil'
        anvil_log = open(work / 'anvil.private.log', 'xb')
        anvil = subprocess.Popen([str(anvil_binary), '--host', '127.0.0.1', '--port', str(chain_port), '--chain-id', '31337',
            '--accounts', '0', '--silent', '--load-state', str(clone / 'chain.json')], stdout=anvil_log, stderr=anvil_log)
        time.sleep(1)
        require(anvil.poll() is None, 'anvil_start')
        for source in ['latest', 'old']:
            helper(work, source, {'release': state['release'], 'work': str(work), 'profile': str(clone / 'profile.env'),
                'backup': str(backup), 'cloneRoot': str(clone), 'databaseUrl': 'postgresql://telomere_rollout:' + password + '@127.0.0.1:' + str(pg_port) + '/telomere_rollout',
                'rpcUrl': 'http://127.0.0.1:' + str(chain_port), 'port': http_port, 'dockerHost': host, 'cpuImage': cpu_id,
                'source': source, 'baseline': str(clone / 'baseline.json'), 'output': str(clone / (source + '-acceptance.json'))}, service_user=True)
        latest, old = [read_private(clone / (source + '-acceptance.json')) for source in ['latest', 'old']]
        require(latest['status'] == old['status'] == 'passed' and latest['canonicalAnchor'] == old['canonicalAnchor'], 'clone_chain_changed')
        require(not docker('ps', '--all', '--quiet', host=host), 'clone_containers_remaining')
        success = True
    finally:
        try:
            if anvil and anvil.poll() is None:
                anvil.terminate()
                anvil.wait(timeout=5)
            cleanup['ownedAnvilStopped'] = not anvil or anvil.poll() is not None
        except subprocess.TimeoutExpired:
            try:
                anvil.kill()
                anvil.wait(timeout=5)
                cleanup['ownedAnvilStopped'] = True
            except BaseException:
                cleanup['ownedAnvilStopped'] = False
        except BaseException:
            cleanup['ownedAnvilStopped'] = False
        if daemon_requested:
            try:
                load = command(['systemctl', 'show', unit, '--property=LoadState', '--value'])
                if load != 'not-found':
                    command(['systemctl', 'stop', unit], timeout=20)
                    require(command(['systemctl', 'show', unit, '--property=ActiveState', '--value']) in ['inactive', 'failed'], 'owned_daemon_active')
                    require(command(['systemctl', 'show', unit, '--property=MainPID', '--value']) in ['0', ''], 'owned_daemon_pid')
                cleanup['ownedDaemonStopped'] = True
            except BaseException:
                cleanup['ownedDaemonStopped'] = False
        if namespace_requested:
            try:
                if Path('/run/netns', namespace).exists():
                    require(not command(['ip', 'netns', 'pids', namespace]), 'namespace_still_owned_by_process')
                    command(['ip', 'netns', 'delete', namespace])
                cleanup['ownedNamespaceRemoved'] = not Path('/run/netns', namespace).exists()
            except BaseException:
                cleanup['ownedNamespaceRemoved'] = False
        if container_requested:
            try:
                present = docker('ps', '--all', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}')
                if present:
                    actual = owned_container(name, args.run)
                    require(cid is None or actual == cid, 'cleanup_container_identity')
                    docker('container', 'rm', '--force', actual)
                cleanup['ownedPostgresRemoved'] = True
            except BaseException:
                cleanup['ownedPostgresRemoved'] = False
        private_json(work / 'clone-cleanup.json', cleanup)
        old_running()
        health()
        after_inventory = global_inventory()
        private_json(work / 'global-docker-inventory.json', {'before': inventory, 'after': after_inventory, 'unchanged': inventory == after_inventory})
        require(inventory == after_inventory, 'global_inventory_changed_no_activation')
    require(success and all(cleanup.values()), 'clone_incomplete')
    state.update(stage='clone_accepted', cloneAcceptedAt=time.time(), latestReportSha256=digest(clone / 'latest-acceptance.json'),
        oldReportSha256=digest(clone / 'old-acceptance.json'), cleanupSha256=digest(work / 'clone-cleanup.json'))
    update(work, state)

def cutover(args):
    global PHASE
    PHASE = 'cutover'
    work, state = load_state(args)
    require(state['stage'] == 'clone_accepted', 'clone_gate')
    assert_protected(state)
    require(digest(work / 'clone/latest-acceptance.json') == state['latestReportSha256']
            and digest(work / 'clone/old-acceptance.json') == state['oldReportSha256']
            and digest(work / 'clone-cleanup.json') == state['cleanupSha256'], 'clone_evidence_changed')
    dropdir = Path('/etc/systemd/system/telomere-staging.service.d')
    dropin = dropdir / '90-telomere-reviewed-release.conf'
    require(not dropdir.is_symlink() and not dropin.is_symlink(), 'dropin_symlink')
    require(not dropin.exists(), 'dropin_already_exists')
    # Other drop-ins must be reviewed rather than overwritten or silently reordered.
    require(not dropdir.exists() or not list(dropdir.glob('*.conf')), 'unreviewed_controller_dropin')
    installed = False
    text = '[Service]\nWorkingDirectory=' + state['release'] + '\nExecStart=\nExecStart=' + NODE + ' ' + state['release'] + '/dist/src/main.js\n'
    expected_dropin = hashlib.sha256(text.encode()).hexdigest()
    started = time.monotonic()
    try:
        stopped_capture(work, state, 'cutover-snapshot')
        baseline = read_private(work / 'snapshot-fingerprint.json')
        current = read_private(work / 'cutover-snapshot-fingerprint.json')
        require(baseline == current, 'snapshot_drift_no_activation')
        require(time.monotonic() - started < 100, 'maintenance_deadline')
        dropdir.mkdir(mode=0o755, exist_ok=True)
        with open(dropin, 'x', opener=lambda name, flags: os.open(name, flags, 0o644)) as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        installed = True
        command(['systemd-analyze', 'verify', 'telomere-staging.service'], timeout=15, log=work / 'unit-verify.private.log')
        command(['systemctl', 'daemon-reload'])
        restart_old_units()  # Same units; only the controller's owned drop-in selects the new code.
        require(command(['systemctl', 'show', 'telomere-staging.service', '--property=WorkingDirectory', '--value']) == state['release'], 'new_release_not_selected')
        require(protected_identity(dropin, state['release']) == state['protectedIdentity'], 'inherited_unit_or_old_code_changed')
        current_units = service_state()
        require(all(current_units[unit]['NRestarts'] == state['originalUnitStates'][unit]['NRestarts'] for unit in UNITS), 'unexpected_auto_restart')
        require(time.monotonic() - started <= 120, 'maintenance_deadline')
        state.update(stage='activated', activatedAt=time.time(), maintenanceSeconds=round(time.monotonic()-started, 3),
                     controllerDropin=str(dropin), controllerDropinSha256=digest(dropin))
        update(work, state)
    except BaseException:
        if installed:
            command(['systemctl', 'stop', 'telomere-staging-watchdog.service'], timeout=15)
            command(['systemctl', 'stop', 'telomere-staging.service'], timeout=40)
            require(dropin.is_file() and digest(dropin) == expected_dropin, 'owned_dropin_changed')
            require(protected_identity(dropin, state['release']) == state['protectedIdentity'], 'old_rollback_identity_changed')
            shutil.copyfile(dropin, work / 'failed-controller-dropin.conf')
            dropin.rename(dropin.with_name(dropin.name + '.disabled-' + args.run))
            command(['systemctl', 'daemon-reload'])
        assert_protected(state)
        restart_old_units()
        raise

def rollback(args):
    global PHASE
    PHASE = 'rollback_code_only'
    work, state = load_state(args)
    require(state['stage'] == 'activated', 'not_activated')
    dropin = Path(state['controllerDropin'])
    require(not dropin.is_symlink() and not dropin.parent.is_symlink(), 'dropin_symlink')
    require(digest(dropin) == state['controllerDropinSha256'], 'owned_dropin_changed')
    require(protected_identity(dropin, state['release']) == state['protectedIdentity'], 'old_rollback_identity_changed')
    command(['systemctl', 'stop', 'telomere-staging-watchdog.service'], timeout=15)
    command(['systemctl', 'stop', 'telomere-staging.service'], timeout=40)
    no_managed_cells()
    shutil.copyfile(dropin, work / 'rolled-back-controller-dropin.conf')
    dropin.rename(dropin.with_name(dropin.name + '.disabled-' + args.run))
    command(['systemctl', 'daemon-reload'])
    assert_protected(state)
    restart_old_units()
    state.update(stage='code_rolled_back', rollbackAt=time.time(), dataRestored=False)
    update(work, state)

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['prepare', 'snapshot', 'validate-clone', 'cutover', 'rollback-code'])
    parser.add_argument('--run', required=True)
    parser.add_argument('--archive')
    parser.add_argument('--manifest')
    parser.add_argument('--revision')
    parser.add_argument('--sha256')
    parser.add_argument('--gates')
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() == 0, 'linux_root_required')
    require(BASE.resolve() == BASE and OLD.resolve() == OLD and PROFILE.resolve() == PROFILE, 'protected_layout_symlink')
    require(Path('/opt/node-v22.23.3-linux-x64/bin/node').is_file(), 'node_unavailable')
    if args.phase == 'prepare':
        require(all([args.archive, args.manifest, args.revision, args.sha256, args.gates]), 'prepare_arguments')
        prepare(args)
    else:
        {'snapshot': snapshot, 'validate-clone': clone_validate, 'cutover': cutover, 'rollback-code': rollback}[args.phase](args)
    print(json.dumps({'status': 'passed', 'phase': args.phase, 'remoteActionsOnlyOnExplicitInvocation': True}))

if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print(json.dumps({'status': 'failed', 'phase': PHASE, 'detail': 'Fail-closed. Preserve owned private artifacts. No automatic data restore was attempted.'}), file=sys.stderr)
        sys.exit(1)
