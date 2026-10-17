#!/usr/bin/env python3
"""Reviewed operator runner, LOCAL PREPARATION ONLY until root explicitly runs it on Linux.

No SSH, remote invocation, public transaction, provider POST, automatic data restore,
old-tree overlay, or deletion is implemented. Every mutation is a named phase.
"""
import argparse
import datetime
import grp
import gzip
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
import zlib

BASE = Path('/opt/telomere-pilot')
OLD = BASE / 'app'
PROFILE = BASE / 'config/staging.env'
NODE = '/opt/node-v22.23.3-linux-x64/bin/node'
NPM = '/opt/node-v22.23.3-linux-x64/bin/npm'
GLOBAL = 'unix:///var/run/docker.sock'
UNITS = ['telomere-staging-watchdog.service', 'telomere-staging.service', 'telomere-staging-chain.service']
NODE_HELPER = Path(__file__).with_name('clone-smoke.mjs').resolve()
PHASE = 'arguments'
COMMAND_DEADLINE = None

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

def image_archive_stamp(path):
    meta = Path(path).lstat()
    require(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1 and 0 < meta.st_size <= 268435456, 'image_archive_file')
    return {'device': meta.st_dev, 'inode': meta.st_ino, 'bytes': meta.st_size, 'mtimeNs': meta.st_mtime_ns}

def image_archive_identity(path, source, source_digest):
    """Pure bounded Docker29 OCI-index -> classic config-ID proof. No extraction or Docker calls.

    Only the unique linux/amd64 graph is a runnable claim. Missing nonselected index
    siblings are reported, never fetched. Present auxiliary blobs are hash checked;
    their provenance/attestation claims are not interpreted or accepted.
    """
    sha_pattern = r'sha256:[a-f0-9]{64}'
    require(set(source) == {'Id', 'Architecture', 'Os', 'RootFS'}, 'image_source_fields')
    require(source['Id'] == source_digest and re.fullmatch(sha_pattern, source_digest), 'image_source_pin')
    require(source['Os'] == 'linux' and source['Architecture'] == 'amd64', 'image_source_platform')
    require(isinstance(source['RootFS'], dict) and source['RootFS'].get('Type') == 'layers'
            and isinstance(source['RootFS'].get('Layers'), list) and 0 < len(source['RootFS']['Layers']) <= 64
            and all(isinstance(item, str) and re.fullmatch(sha_pattern, item) for item in source['RootFS']['Layers']), 'image_source_rootfs')
    before = image_archive_stamp(path)
    checksum = digest(path)
    index_type = 'application/vnd.oci.image.index.v1+json'
    manifest_type = 'application/vnd.oci.image.manifest.v1+json'
    config_type = 'application/vnd.oci.image.config.v1+json'
    plain_layer = 'application/vnd.oci.image.layer.v1.tar'
    gzip_layer = plain_layer + '+gzip'
    with tarfile.open(path, 'r:') as packed:
        members, blobs, total = {}, {}, 0
        for item in packed:
            require(len(members) < 512 and item.name not in members, 'image_tar_members')
            require(item.name in ['blobs', 'blobs/', 'blobs/sha256', 'blobs/sha256/'] or item.isfile(), 'image_tar_type')
            if item.isdir():
                require(item.name in ['blobs', 'blobs/', 'blobs/sha256', 'blobs/sha256/'], 'image_tar_directory')
            else:
                require(item.isfile() and (item.name in ['index.json', 'manifest.json', 'oci-layout']
                    or re.fullmatch(r'blobs/sha256/[a-f0-9]{64}', item.name)), 'image_tar_path')
                require(0 < item.size <= 134217728, 'image_blob_bound')
                total += item.size
                require(total <= 268435456, 'image_total_bound')
                if item.name.startswith('blobs/'):
                    hasher, length = hashlib.sha256(), 0
                    with packed.extractfile(item) as raw:
                        for block in iter(lambda: raw.read(1048576), b''):
                            length += len(block)
                            require(length <= item.size, 'image_blob_length')
                            hasher.update(block)
                    require(length == item.size and hasher.hexdigest() == item.name.rsplit('/', 1)[1], 'image_blob_digest')
                    blobs['sha256:' + hasher.hexdigest()] = item
            members[item.name] = item

        def unique_json(pairs):
            result = {}
            for key, value in pairs:
                require(key not in result, 'image_json_duplicate')
                result[key] = value
            return result

        def invalid_constant(_value):
            raise Refusal('image_json_constant')

        def json_member(name):
            require(name in members and members[name].isfile() and members[name].size <= 1048576, 'image_json_bound')
            with packed.extractfile(members[name]) as raw:
                data = raw.read(1048577)
            require(len(data) == members[name].size and len(data) <= 1048576, 'image_json_length')
            try:
                return json.loads(data, object_pairs_hook=unique_json, parse_constant=invalid_constant)
            except (UnicodeError, ValueError):
                raise Refusal('image_json_invalid') from None

        reached, absent = set(), []

        def descriptor(value, required=True):
            require(isinstance(value, dict) and 'urls' not in value and 'data' not in value, 'image_descriptor_external')
            require(isinstance(value.get('digest'), str) and re.fullmatch(sha_pattern, value['digest'])
                and type(value.get('size')) is int and 0 < value['size'] <= 134217728
                and isinstance(value.get('mediaType'), str), 'image_descriptor')
            identity = value['digest']
            if identity not in blobs:
                require(not required, 'image_selected_blob_missing')
                absent.append(identity)
                return None
            require(blobs[identity].size == value['size'], 'image_descriptor_size')
            reached.add(identity)
            return 'blobs/sha256/' + identity.split(':', 1)[1]

        require(json_member('oci-layout') == {'imageLayoutVersion': '1.0.0'}, 'image_layout_version')
        wrapper = json_member('index.json')
        require(isinstance(wrapper, dict) and type(wrapper.get('schemaVersion')) is int and wrapper['schemaVersion'] == 2
            and wrapper.get('mediaType') == index_type and isinstance(wrapper.get('manifests'), list)
            and len(wrapper['manifests']) == 1, 'image_index_wrapper')
        root_descriptor = wrapper['manifests'][0]
        root_name = descriptor(root_descriptor)
        require(root_descriptor['digest'] == source_digest and root_descriptor['mediaType'] == index_type, 'image_root_pin')
        root = json_member(root_name)
        require(isinstance(root, dict) and type(root.get('schemaVersion')) is int and root['schemaVersion'] == 2
            and root.get('mediaType') == index_type and isinstance(root.get('manifests'), list)
            and 0 < len(root['manifests']) <= 64, 'image_root_index')
        candidates, references = [], set()
        for child in root['manifests']:
            require(isinstance(child, dict) and child.get('mediaType') == manifest_type, 'image_nested_or_unknown_manifest')
            require(child.get('digest') not in references, 'image_duplicate_descriptor')
            references.add(child.get('digest'))
            platform = child.get('platform')
            require(isinstance(platform, dict) and isinstance(platform.get('os'), str)
                and isinstance(platform.get('architecture'), str), 'image_platform_descriptor')
            selected = platform['os'] == 'linux' and platform['architecture'] == 'amd64'
            if selected:
                require(platform.get('variant') in [None, ''], 'image_platform_variant')
                candidates.append(child)
        require(len(candidates) == 1, 'image_ambiguous_platform')
        selected_digest = candidates[0]['digest']
        selected_config, selected_layers, selected_value = None, None, None
        for child in root['manifests']:
            selected = child['digest'] == selected_digest
            name = descriptor(child, required=selected)
            if name is None:
                continue  # Partial multi-platform export: nonselected siblings are not fetched.
            manifest = json_member(name)
            require(isinstance(manifest, dict) and type(manifest.get('schemaVersion')) is int and manifest['schemaVersion'] == 2
                and manifest.get('mediaType') == manifest_type and isinstance(manifest.get('layers'), list)
                and 0 < len(manifest['layers']) <= 64, 'image_manifest')
            config_descriptor = manifest.get('config')
            config_name = descriptor(config_descriptor)
            require(config_descriptor['mediaType'] == config_type, 'image_config_media')
            config = json_member(config_name)
            require(isinstance(config, dict), 'image_config_object')
            for layer in manifest['layers']:
                descriptor(layer)
            if selected:
                selected_config, selected_layers, selected_value = config_descriptor, manifest['layers'], config
        require(set(blobs) == reached, 'image_unreferenced_blob')
        require(selected_value.get('os') == 'linux' and selected_value.get('architecture') == 'amd64'
            and selected_value.get('variant') in [None, ''], 'image_config_platform')
        rootfs = selected_value.get('rootfs')
        require(isinstance(rootfs, dict) and rootfs.get('type') == 'layers'
            and rootfs.get('diff_ids') == source['RootFS']['Layers'] and len(selected_layers) == len(rootfs['diff_ids']), 'image_config_rootfs')
        compatibility = json_member('manifest.json')
        require(isinstance(compatibility, list) and len(compatibility) == 1 and isinstance(compatibility[0], dict), 'image_compatibility_count')
        legacy = compatibility[0]
        require(set(legacy) == {'Config', 'RepoTags', 'Layers'} and legacy['RepoTags'] in [None, []]
            and legacy['Config'] == 'blobs/sha256/' + selected_config['digest'].split(':', 1)[1]
            and legacy['Layers'] == ['blobs/sha256/' + layer['digest'].split(':', 1)[1] for layer in selected_layers], 'image_compatibility_binding')
        expanded_total, expanded_sizes = 0, []
        for layer, expected_diff in zip(selected_layers, rootfs['diff_ids']):
            require(layer['mediaType'] in [plain_layer, gzip_layer], 'image_layer_media')
            count, hasher = 0, hashlib.sha256()
            with packed.extractfile(blobs[layer['digest']]) as raw:
                stream = gzip.GzipFile(fileobj=raw, mode='rb') if layer['mediaType'] == gzip_layer else raw
                try:
                    for block in iter(lambda: stream.read(1048576), b''):
                        require(count + len(block) <= 268435456 and expanded_total + len(block) <= 536870912, 'image_expanded_bound')
                        count += len(block)
                        expanded_total += len(block)
                        hasher.update(block)
                except (OSError, EOFError, zlib.error):
                    raise Refusal('image_layer_stream_invalid') from None
                finally:
                    if stream is not raw:
                        stream.close()
            require('sha256:' + hasher.hexdigest() == expected_diff, 'image_layer_diff_id')
            expanded_sizes.append(count)
    require(image_archive_stamp(path) == before and digest(path) == checksum, 'image_archive_changed')
    return {'schemaVersion': 1, 'kind': 'bounded_installed_oci_index_to_classic_config_identity',
        'sourceIndexDigest': source_digest, 'selectedManifestDigest': selected_digest, 'configDigest': selected_config['digest'],
        'platform': {'os': 'linux', 'architecture': 'amd64'}, 'orderedDiffIds': source['RootFS']['Layers'],
        'orderedLayerDigests': [layer['digest'] for layer in selected_layers],
        'expandedLayerBytes': expanded_sizes, 'expandedBytes': expanded_total, 'archiveSha256': checksum, 'archiveStat': before,
        'archiveMembers': len(members), 'presentBlobs': len(blobs), 'allPresentBlobHashesVerified': True,
        'selectedLayerDiffIdsIndependentlyVerified': True, 'missingNonselectedDescriptors': absent,
        'missingDescriptorsFetched': False, 'auxiliaryProvenanceClaimsVerified': False}

def assert_image_archive_stable(path, proof):
    require(image_archive_stamp(path) == proof['archiveStat'] and digest(path) == proof['archiveSha256'], 'image_archive_changed')

def assert_loaded_cpu_identity(proof, source_before, loaded, source_after):
    require(source_before == source_after, 'image_source_changed')
    require(loaded['Id'] == proof['configDigest'], 'image_loaded_config_id')
    require(loaded['Os'] == source_before['Os'] == proof['platform']['os']
        and loaded['Architecture'] == source_before['Architecture'] == proof['platform']['architecture']
        and loaded['RootFS'] == source_before['RootFS']
        and loaded['RootFS']['Layers'] == proof['orderedDiffIds'], 'image_loaded_rootfs')

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
    if COMMAND_DEADLINE is not None:
        require(time.monotonic() < COMMAND_DEADLINE, 'bounded_operation_deadline')
        timeout = min(timeout, max(0.05, COMMAND_DEADLINE - time.monotonic()))
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

def cpu_image_identity(reference, host=GLOBAL):
    template = '{"Id":{{json .Id}},"Architecture":{{json .Architecture}},"Os":{{json .Os}},"RootFS":{{json .RootFS}}}'
    value = json.loads(docker('image', 'inspect', reference, '--format', template, host=host))
    require(isinstance(value, dict) and set(value) == {'Id', 'Architecture', 'Os', 'RootFS'}, 'image_inspect_fields')
    return value

def service_state():
    output = {}
    for unit in UNITS:
        text = command(['systemctl', 'show', unit, '--no-pager', '--property=ActiveState', '--property=SubState', '--property=NRestarts'])
        output[unit] = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
    return output

def old_running():
    for item in service_state().values():
        require(item.get('ActiveState') == 'active' and item.get('SubState') == 'running', 'old_units_not_running')

def originals_inactive():
    require(all(item.get('ActiveState') == 'inactive' for item in service_state().values()), 'held_original_units_not_inactive')

def no_managed_cells():
    require(not docker('ps', '--all', '--filter', 'label=telomere.managed=true', '--format', '{{.ID}}'), 'managed_cells_present')

def health():
    deadline = time.monotonic() + 25
    while True:
        if COMMAND_DEADLINE is not None:
            require(time.monotonic() < COMMAND_DEADLINE, 'bounded_operation_deadline')
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

def release_pins(release, manifest):
    require(len(manifest['files']) == 685, 'release_source_count')
    source = {}
    for row in manifest['files']:
        path = within(release / safe_member_name(row['path']), release)
        require(path.is_file() and not path.is_symlink() and path.stat().st_size == row['bytes'], 'release_source_file')
        require(digest(path) == row['sha256'], 'release_source_changed')
        source[row['path']] = {'bytes': row['bytes'], 'sha256': row['sha256']}
    runtime, total = {}, 0
    for path in sorted((release / 'dist').rglob('*')):
        require(not path.is_symlink(), 'release_runtime_symlink')
        if path.is_file():
            size = path.stat().st_size
            total += size
            require(len(runtime) < 5000 and size <= 67108864 and total <= 268435456, 'release_runtime_bound')
            runtime[path.relative_to(release).as_posix()] = {'bytes': size, 'sha256': digest(path)}
    require('dist/src/main.js' in runtime, 'release_runtime_missing')
    return {'source': source, 'runtime': runtime}

def assert_release(work, state):
    require(digest(work / 'source-manifest.json') == state['sourceManifestSha256'], 'retained_source_manifest_changed')
    require(digest(work / 'release-pins.json') == state['releasePinsSha256'], 'release_pins_changed')
    require(release_pins(Path(state['release']), read_private(work / 'source-manifest.json'))
        == read_private(work / 'release-pins.json'), 'release_runtime_changed')

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
        socket_path = work / 'clone/run/docker.sock'
        target_release = OLD if options['source'] == 'old' else Path(options['release'])
        access_paths = {'workTraverse': [str(work), os.X_OK], 'helperRead': [str(work / 'clone-smoke.mjs'), os.R_OK],
            'optionsRead': [str(config), os.R_OK], 'profileRead': [options['profile'], os.R_OK],
            'baselineRead': [options['baseline'], os.R_OK], 'cloneWrite': [str(work / 'clone'), os.W_OK | os.X_OK],
            'dockerRunTraverse': [str(socket_path.parent), os.X_OK], 'dockerSocketWrite': [str(socket_path), os.W_OK],
            'releaseTraverse': [str(target_release), os.X_OK], 'mainRead': [str(target_release / 'dist/src/main.js'), os.R_OK],
            'nodeExecute': [NODE, os.X_OK]}
        access_probe = ('import json,os,stat,sys\n'
            'checks={key:os.access(path,mode) for key,(path,mode) in json.loads(sys.argv[1]).items()}\n'
            'try: checks["socketType"]=stat.S_ISSOCK(os.stat(sys.argv[2]).st_mode)\n'
            'except OSError: checks["socketType"]=False\n'
            'print(json.dumps(checks))\n')
        access_groups = sorted(set(os.getgrouplist(account.pw_name, account.pw_gid)) | {grp.getgrnam('docker').gr_gid})
        access = json.loads(command(['setpriv', '--reuid=' + str(account.pw_uid), '--regid=' + str(account.pw_gid),
            '--groups=' + ','.join(map(str, access_groups)), '/usr/bin/python3', '-c', access_probe,
            json.dumps(access_paths), str(socket_path)], timeout=10))
        require(set(access) == {*access_paths, 'socketType'} and all(value is True for value in access.values()), 'service_user_path_access')
        owned_unit = 'telomere-' + work.name + '-' + label + '.service'
        require(command(['systemctl', 'show', owned_unit, '--property=LoadState', '--value']) == 'not-found', 'helper_unit_exists')
        resources = clone_resources(work, work.name)
        require(owned_unit in resource_identity(work, resources['run'])['helperUnits'], 'helper_resource_scope')
        resources['helperUnitsRequested'].append(owned_unit)
        atomic_private(work, 'clone-resources.json', resources)
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
    os.chmod(work, 0o750)
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
    shutil.copyfile(args.manifest, work / 'source-manifest.json')
    os.chmod(work / 'source-manifest.json', 0o600)
    private_json(work / 'release-pins.json', release_pins(release, manifest))
    private_json(work / 'state.json', {'schemaVersion': 1, 'run': args.run, 'revision': args.revision,
        'archiveSha256': args.sha256, 'release': str(release), 'stage': 'prepared', 'preparedAt': time.time(),
        'sourceManifestSha256': digest(args.manifest), 'nodeHelperSha256': digest(work / 'clone-smoke.mjs'),
        'releasePinsSha256': digest(work / 'release-pins.json'),
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
    atomic_private(work, 'state.json', state)

def atomic_private(work, name, value):
    # Unique retained temporary names cannot block recovery after an interrupted write.
    require(name in ['state.json', 'clone-resources.json', 'clone-cleanup.json', 'global-docker-inventory.json'], 'private_marker_name')
    temporary = work / (name + '.next-' + secrets.token_hex(8))
    private_json(temporary, value)
    os.replace(temporary, work / name)
    descriptor = os.open(work, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def stopped_capture(work, state, label, *, recover_on_failure=True):
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
        if recover_on_failure:
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

def resource_identity(work, run):
    require(work == BASE / 'rollout' / run and re.fullmatch(r'staging-[a-f0-9]{12}-[a-z0-9]{6,16}', run), 'clone_resource_scope')
    suffix = hashlib.sha256(run.encode()).hexdigest()
    namespace = 'tlmr-roll-' + suffix[:12]
    return {'container': 'telomere-rollout-' + suffix[:24], 'namespace': namespace,
        'daemonUnit': 'telomere-' + namespace + '.service',
        'helperUnits': ['telomere-' + run + '-' + source + '.service' for source in ['latest', 'old']]}

def process_start(pid):
    try:
        value = Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
        return None if value[0] == 'Z' else value[19]
    except (OSError, IndexError):
        return None

def clone_resources(work, run):
    value = read_private(work / 'clone-resources.json')
    require(set(value) == {'schemaVersion', 'run', 'identity', 'inventory', 'postgresRequested', 'postgresId', 'namespaceRequested',
        'daemonRequested', 'helperUnitsRequested', 'anvilRequested', 'anvilPid', 'anvilStart', 'outerCgroup'}, 'clone_resource_fields')
    require(value['schemaVersion'] == 1 and value['run'] == run and value['identity'] == resource_identity(work, run), 'clone_resource_identity')
    require(isinstance(value['helperUnitsRequested'], list) and len(value['helperUnitsRequested']) <= 2
        and len(set(value['helperUnitsRequested'])) == len(value['helperUnitsRequested'])
        and set(value['helperUnitsRequested']) <= set(value['identity']['helperUnits']), 'clone_helper_scope')
    require(all(type(value[key]) is bool for key in ['postgresRequested', 'namespaceRequested', 'daemonRequested', 'anvilRequested']), 'clone_resource_flags')
    require(value['postgresId'] is None or re.fullmatch(r'[a-f0-9]{64}', value['postgresId']), 'clone_postgres_id')
    require(value['postgresRequested'] or value['postgresId'] is None, 'clone_postgres_request')
    require(type(value['anvilPid']) is int and 0 < value['anvilPid'] <= 2147483647 or value['anvilPid'] is None, 'clone_anvil_pid')
    require(value['anvilStart'] is None or isinstance(value['anvilStart'], str) and re.fullmatch(r'[0-9]{1,32}', value['anvilStart']), 'clone_anvil_start')
    require(value['anvilPid'] is not None or value['anvilStart'] is None, 'clone_anvil_pair')
    require(value['anvilRequested'] or value['anvilPid'] is None, 'clone_anvil_request')
    prefix = '/system.slice/telomere-private-staging-' + run.split('-')[1] + '-launch04-'
    allowed_cgroups = [prefix + phase + '.service' for phase in (['cutover'] if run.endswith('-final04') else ['validate-clone'])]
    require(value['outerCgroup'] in allowed_cgroups, 'clone_outer_cgroup')
    inventory = value['inventory']
    require(isinstance(inventory, dict) and set(inventory) == {'containerIdentities', 'imageIdentities'}, 'clone_inventory_fields')
    for key, pattern in [('containerIdentities', r'[a-f0-9]{64} [A-Za-z0-9_.-]{1,128}'), ('imageIdentities', r'sha256:[a-f0-9]{64}')]:
        require(isinstance(inventory[key], list) and len(inventory[key]) <= 10000
            and all(isinstance(item, str) and re.fullmatch(pattern, item) for item in inventory[key]), 'clone_inventory_bound')
    return value

def resource_request(work, run, **changes):
    require(set(changes) <= {'postgresRequested', 'postgresId', 'namespaceRequested', 'daemonRequested', 'anvilRequested', 'anvilPid', 'anvilStart'}, 'resource_request_fields')
    value = clone_resources(work, run)
    value.update(changes)
    atomic_private(work, 'clone-resources.json', value)

def cleanup_clone_resources(work, run, anvil=None, *, recovery=False):
    """Idempotent cleanup of only durably requested exact owned objects; no data/image deletion."""
    global COMMAND_DEADLINE
    resources = clone_resources(work, run)
    identity, cleanup = resources['identity'], {}
    previous_deadline = COMMAND_DEADLINE
    COMMAND_DEADLINE = min(previous_deadline, time.monotonic() + 45) if recovery and previous_deadline else time.monotonic() + 45
    try:
        cleanup['ownedHelpersStopped'] = True
        for unit in reversed(resources['helperUnitsRequested']):
            try:
                if command(['systemctl', 'show', unit, '--property=LoadState', '--value']) != 'not-found':
                    try:
                        command(['systemctl', 'stop', unit], timeout=15)
                    except BaseException:
                        command(['systemctl', 'kill', '--kill-whom=all', '--signal=KILL', unit], timeout=5)
                    require(command(['systemctl', 'show', unit, '--property=ActiveState', '--value']) in ['inactive', 'failed'], 'cleanup_helper_active')
                    require(command(['systemctl', 'show', unit, '--property=MainPID', '--value']) in ['0', ''], 'cleanup_helper_pid')
            except BaseException:
                cleanup['ownedHelpersStopped'] = False
        try:
            pid, start = resources.get('anvilPid'), resources.get('anvilStart')
            if anvil and anvil.poll() is None:
                anvil.terminate()
                try:
                    anvil.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    anvil.kill()
                    anvil.wait(timeout=5)
            elif pid and start is not None and process_start(pid) == start:
                arguments = Path('/proc', str(pid), 'cmdline').read_bytes().split(b'\0')
                require(arguments[0].decode() == str(OLD / 'node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil')
                    and b'--load-state' in arguments and str(work / 'clone/chain.json').encode() in arguments, 'cleanup_anvil_identity')
                os.kill(pid, signal.SIGTERM)
                stop_by = time.monotonic() + 5
                while process_start(pid) == start and time.monotonic() < stop_by:
                    time.sleep(0.05)
                if process_start(pid) == start:
                    os.kill(pid, signal.SIGKILL)
                    stop_by = time.monotonic() + 5
                    while process_start(pid) == start and time.monotonic() < stop_by:
                        time.sleep(0.05)
            require(not pid or process_start(pid) is None or start is not None and process_start(pid) != start, 'cleanup_anvil_remaining')
            if resources.get('anvilRequested') and not pid:
                # A lost spawn acknowledgement is safe only after its exact outer cgroup has no other processes.
                cgroup = resources['outerCgroup']
                require(re.fullmatch(r'/system.slice/telomere-private-staging-[a-f0-9]{12}-launch04-(?:cutover|validate-clone)\.service', cgroup), 'cleanup_outer_cgroup_scope')
                members = Path('/sys/fs/cgroup' + cgroup, 'cgroup.procs')
                require(not members.exists() or set(members.read_text().split()) <= {str(os.getpid())}, 'cleanup_outer_child_remaining')
            cleanup['ownedAnvilStopped'] = True
        except BaseException:
            cleanup['ownedAnvilStopped'] = False
        try:
            unit = identity['daemonUnit']
            if resources['daemonRequested'] and command(['systemctl', 'show', unit, '--property=LoadState', '--value']) != 'not-found':
                command(['systemctl', 'stop', unit], timeout=20)
                require(command(['systemctl', 'show', unit, '--property=ActiveState', '--value']) in ['inactive', 'failed'], 'owned_daemon_active')
                require(command(['systemctl', 'show', unit, '--property=MainPID', '--value']) in ['0', ''], 'owned_daemon_pid')
            cleanup['ownedDaemonStopped'] = True
        except BaseException:
            cleanup['ownedDaemonStopped'] = False
        try:
            namespace = identity['namespace']
            if resources['namespaceRequested'] and Path('/run/netns', namespace).exists():
                require(not command(['ip', 'netns', 'pids', namespace]), 'namespace_still_owned_by_process')
                command(['ip', 'netns', 'delete', namespace])
            cleanup['ownedNamespaceRemoved'] = not resources['namespaceRequested'] or not Path('/run/netns', namespace).exists()
        except BaseException:
            cleanup['ownedNamespaceRemoved'] = False
        try:
            if resources['postgresRequested'] and docker('ps', '--all', '--filter', 'name=^/' + identity['container'] + '$', '--format', '{{.ID}}'):
                actual = owned_container(identity['container'], run)
                require(resources['postgresId'] is None or resources['postgresId'] == actual, 'cleanup_container_identity')
                docker('container', 'rm', '--force', actual)
            cleanup['ownedPostgresRemoved'] = True
        except BaseException:
            cleanup['ownedPostgresRemoved'] = False
        private_json(work / ('clone-cleanup-attempt-' + secrets.token_hex(8) + '.json'), cleanup)
        atomic_private(work, 'clone-cleanup.json', cleanup)
        after = global_inventory()
        proof = {'before': resources['inventory'], 'after': after, 'unchanged': resources['inventory'] == after}
        private_json(work / ('global-docker-inventory-attempt-' + secrets.token_hex(8) + '.json'), proof)
        atomic_private(work, 'global-docker-inventory.json', proof)
        return all(cleanup.values()) and proof['unchanged']
    finally:
        COMMAND_DEADLINE = previous_deadline

def clone_validate(args, *, original_stopped=False):
    global PHASE
    PHASE = 'clone_validate'
    work, state = load_state(args)
    require(state['stage'] == 'snapshotted', 'wrong_phase')
    assert_protected(state)
    assert_release(work, state)
    if original_stopped:
        originals_inactive()
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
    identity = resource_identity(work, args.run)
    require(name == identity['container'] and namespace == identity['namespace'] and unit == identity['daemonUnit'], 'clone_resource_names')
    outer_cgroup = Path('/proc/self/cgroup').read_text().strip().removeprefix('0::')
    private_json(work / 'clone-resources.json', {'schemaVersion': 1, 'run': args.run, 'identity': identity,
        'inventory': inventory, 'postgresRequested': False, 'postgresId': None, 'namespaceRequested': False,
        'daemonRequested': False, 'helperUnitsRequested': [], 'anvilRequested': False,
        'anvilPid': None, 'anvilStart': None, 'outerCgroup': outer_cgroup})
    try:
        require(not Path('/run/netns', namespace).exists(), 'namespace_exists')
        image = docker('container', 'inspect', '--format', '{{.Image}}', 'telomere-staging-postgres')
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', image), 'installed_postgres_image')
        container_requested = True
        resource_request(work, args.run, postgresRequested=True)
        cid = docker('run', '--detach', '--pull=never', '--name', name, '--label', 'telomere.rollout.owner=' + args.run,
            '--cpus', '0.5', '--memory', '512m', '--pids-limit', '128', '--security-opt', 'no-new-privileges',
            '--publish', '127.0.0.1:' + str(pg_port) + ':5432', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=268435456',
            '--env-file', str(envfile), image)
        require(cid == owned_container(name, args.run), 'created_container_mismatch')
        resource_request(work, args.run, postgresId=cid)
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
        os.chmod(clone / 'run', 0o750)
        private_json(clone / 'daemon.json', {})
        namespace_requested = True
        resource_request(work, args.run, namespaceRequested=True)
        command(['ip', 'netns', 'add', namespace])
        command(['ip', '-n', namespace, 'link', 'set', 'lo', 'up'])
        require(command(['systemctl', 'show', unit, '--property=LoadState', '--value']) == 'not-found', 'daemon_unit_exists')
        daemon_requested = True
        resource_request(work, args.run, daemonRequested=True)
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
        restored_profile = clone / 'profile.env'
        require(digest(restored_profile) == read_private(work / 'snapshot-fingerprint.json')['profileSha256'], 'image_snapshot_profile_changed')
        cpu_lines = [line.split('=', 1)[1].strip().strip('"\'') for line in restored_profile.read_text().splitlines() if line.startswith('CPU_IMAGE=')]
        require(len(cpu_lines) == 1 and re.fullmatch(r'[A-Za-z0-9._/:@-]+@sha256:[a-f0-9]{64}', cpu_lines[0]), 'cpu_image_pin')
        PHASE = 'clone_cpu_export'
        source_identity = cpu_image_identity(cpu_lines[0])
        source_digest = cpu_lines[0].rsplit('@', 1)[1]
        require(source_identity['Id'] == source_digest, 'image_source_pin')
        image_tar = clone / 'cpu-image.tar'
        docker('image', 'save', '--output', str(image_tar), source_identity['Id'], timeout=120)
        PHASE = 'clone_cpu_archive'
        image_proof = image_archive_identity(image_tar, source_identity, source_digest)
        private_json(work / 'image-equivalence-export.json', image_proof)
        PHASE = 'clone_cpu_load'
        assert_image_archive_stable(image_tar, image_proof)
        docker('image', 'load', '--input', str(image_tar), host=host, timeout=120)
        PHASE = 'clone_cpu_loaded_identity'
        cpu_id = image_proof['configDigest']
        loaded_identity = cpu_image_identity(cpu_id, host=host)
        source_after = cpu_image_identity(cpu_lines[0])
        assert_image_archive_stable(image_tar, image_proof)
        assert_loaded_cpu_identity(image_proof, source_identity, loaded_identity, source_after)
        image_proof.update(sourceBefore=source_identity,
            sourceAfter=source_after, loadedIdentity=loaded_identity, result='verified_same_installed_cpu_image')
        private_json(work / 'image-equivalence.json', image_proof)
        PHASE = 'clone_validate'
        anvil_binary = OLD / 'node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil'
        anvil_log = open(work / 'anvil.private.log', 'xb')
        resource_request(work, args.run, anvilRequested=True)
        anvil = subprocess.Popen([str(anvil_binary), '--host', '127.0.0.1', '--port', str(chain_port), '--chain-id', '31337',
            '--accounts', '0', '--silent', '--load-state', str(clone / 'chain.json')], stdout=anvil_log, stderr=anvil_log)
        time.sleep(1)
        require(anvil.poll() is None, 'anvil_start')
        resource_request(work, args.run, anvilPid=anvil.pid, anvilStart=process_start(anvil.pid))
        for source in ['latest', 'old']:
            if original_stopped:
                originals_inactive()
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
            cleanup_complete = cleanup_clone_resources(work, args.run, anvil)
        finally:
            if original_stopped:
                originals_inactive()
            else:
                old_running()
                health()
    require(success and cleanup_complete, 'clone_incomplete')
    state.update(stage='clone_accepted', cloneAcceptedAt=time.time(), latestReportSha256=digest(clone / 'latest-acceptance.json'),
        oldReportSha256=digest(clone / 'old-acceptance.json'), cleanupSha256=digest(work / 'clone-cleanup.json'))
    update(work, state)

def dropin_text(state):
    return '[Service]\nWorkingDirectory=' + state['release'] + '\nExecStart=\nExecStart=' + NODE + ' ' + state['release'] + '/dist/src/main.js\n'

def final_work(parent_work, parent_state):
    require(parent_state['run'].endswith('-launch04'), 'held_parent_run_scope')
    final_run = 'staging-' + parent_state['revision'][:12] + '-final04'
    args = argparse.Namespace(run=final_run)
    work = state_path(args)
    require(not work.exists() and not work.is_symlink(), 'final_work_exists')
    account = pwd.getpwnam('telomere')
    work.mkdir(mode=0o750)
    os.chown(work, 0, account.pw_gid)
    os.chmod(work, 0o750)
    for name in ['clone-smoke.mjs', 'source-manifest.json', 'release-pins.json']:
        shutil.copyfile(parent_work / name, work / name)
        os.chmod(work / name, 0o640 if name == 'clone-smoke.mjs' else 0o600)
        os.chown(work / name, 0, account.pw_gid)
    keys = ['schemaVersion', 'revision', 'archiveSha256', 'release', 'sourceManifestSha256', 'releasePinsSha256',
        'nodeHelperSha256', 'runnerSha256', 'protectedIdentity', 'originalUnitStates']
    state = {key: parent_state[key] for key in keys}
    state.update(run=final_run, parentRun=parent_state['run'], stage='prepared', preparedAt=time.time())
    private_json(work / 'state.json', state)
    assert_release(work, state)
    return args, work, state

def verify_held_link(work, state):
    held = state['heldStop']
    require(type(held['parentPid']) is int and 1 < held['parentPid'] <= 2147483647
        and isinstance(held['parentStart'], str) and re.fullmatch(r'[0-9]{1,32}', held['parentStart']), 'held_parent_process_identity')
    require(isinstance(held['intentId'], str) and re.fullmatch(r'[a-f0-9]{32}', held['intentId'])
        and type(held['activationDeadlineAt']) in [int, float] and 0 < held['activationDeadlineAt'] < 1000000000000, 'held_intent_metadata')
    require(held['schemaVersion'] == 1 and held['parentRun'] == state['run']
        and held['finalRun'] == 'staging-' + state['revision'][:12] + '-final04'
        and held['expectedDropinSha256'] == hashlib.sha256(dropin_text(state).encode()).hexdigest(), 'held_intent_scope')
    final_args = argparse.Namespace(run=held['finalRun'])
    final_path, child = load_state(final_args)
    require(child['parentRun'] == state['run'] and child['release'] == state['release']
        and child['revision'] == state['revision'] and child['archiveSha256'] == state['archiveSha256']
        and child['protectedIdentity'] == state['protectedIdentity'] and child['heldStop']['intentId'] == held['intentId'], 'held_child_identity')
    require(all(child[key] == state[key] for key in ['nodeHelperSha256', 'runnerSha256', 'sourceManifestSha256', 'releasePinsSha256', 'originalUnitStates'])
        and all(child['heldStop'][key] == held[key] for key in ['parentRun', 'finalRun', 'parentPid', 'parentStart', 'activationDeadlineAt', 'expectedDropinSha256']), 'held_child_pins')
    return final_args, final_path, child

def recover_held(args, *, in_process=False):
    """Internal ExecStopPost recovery; never restore data or select unverified code."""
    global PHASE, COMMAND_DEADLINE
    PHASE = 'recover_held'
    previous_deadline = COMMAND_DEADLINE
    COMMAND_DEADLINE = time.monotonic() + 150
    try:
        work, state = load_state(args)
        if state['stage'] in ['activated', 'cutover_recovered']:
            return
        if state['stage'] in ['prepared', 'snapshotted', 'clone_accepted'] and 'heldStop' not in state:
            return  # A refused pre-intent cutover never stopped the originals.
        require(state['stage'] in ['cutover_held', 'cutover_activating', 'cutover_recovery']
            and state.get('heldStop', {}).get('active') is True, 'no_authorized_held_recovery')
        held = state['heldStop']
        require(in_process or process_start(held['parentPid']) != held['parentStart'], 'held_parent_still_alive')
        final_args, child_work, child = verify_held_link(work, state)
        dropdir = Path('/etc/systemd/system/telomere-staging.service.d')
        dropin = dropdir / '90-telomere-reviewed-release.conf'
        require(not dropdir.is_symlink() and not dropin.is_symlink(), 'dropin_symlink')
        if dropin.exists():
            require(dropin.is_file() and digest(dropin) == held['expectedDropinSha256'], 'owned_dropin_changed')
            require(protected_identity(dropin, state['release']) == state['protectedIdentity'], 'old_rollback_identity_changed')
        else:
            assert_protected(state)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.setitimer(signal.ITIMER_REAL, 0)
        state.update(stage='cutover_recovery')
        state['heldStop'].update(phase='recovering', recoveryStartedAt=time.time())
        update(work, state)
        cleanup_ok = True
        if (child_work / 'clone-resources.json').exists():
            try:
                cleanup_ok = cleanup_clone_resources(child_work, final_args.run, recovery=True)
            except BaseException:
                cleanup_ok = False
        require(not dropdir.is_symlink() and not dropin.is_symlink(), 'dropin_symlink')
        if dropin.exists():
            require(dropin.is_file() and digest(dropin) == held['expectedDropinSha256'], 'owned_dropin_changed')
            require(protected_identity(dropin, state['release']) == state['protectedIdentity'], 'old_rollback_identity_changed')
            command(['systemctl', 'stop', 'telomere-staging-watchdog.service'], timeout=15)
            command(['systemctl', 'stop', 'telomere-staging.service'], timeout=40)
            require(not dropdir.is_symlink() and not dropin.is_symlink(), 'dropin_symlink')
            require(protected_identity(dropin, state['release']) == state['protectedIdentity'], 'old_rollback_identity_changed')
            require(dropin.is_file() and digest(dropin) == held['expectedDropinSha256'], 'owned_dropin_changed')
            target = dropin.with_name(dropin.name + '.disabled-' + args.run)
            require(not target.exists() and not target.is_symlink(), 'rollback_archive_exists')
            dropin.rename(target)
            command(['systemctl', 'daemon-reload'])
        assert_protected(state)
        restart_old_units()
        state.update(stage='cutover_recovered' if cleanup_ok else 'cutover_recovery', recoveredAt=time.time(), recoveryCleanupComplete=cleanup_ok, dataRestored=False)
        state['heldStop'].update(active=not cleanup_ok, phase='recovered' if cleanup_ok else 'old_restarted_cleanup_pending')
        update(work, state)
        child['heldStop'].update(active=not cleanup_ok, phase='parent_recovered' if cleanup_ok else 'parent_cleanup_pending')
        update(child_work, child)
        require(cleanup_ok, 'held_recovery_cleanup_incomplete')
    finally:
        COMMAND_DEADLINE = previous_deadline

def cutover(args):
    global PHASE, COMMAND_DEADLINE
    PHASE = 'cutover'
    work, state = load_state(args)
    require(state['stage'] == 'clone_accepted', 'clone_gate')
    assert_protected(state)
    assert_release(work, state)
    require(digest(work / 'clone/latest-acceptance.json') == state['latestReportSha256']
            and digest(work / 'clone/old-acceptance.json') == state['oldReportSha256']
            and digest(work / 'clone-cleanup.json') == state['cleanupSha256'], 'clone_evidence_changed')
    dropdir = Path('/etc/systemd/system/telomere-staging.service.d')
    dropin = dropdir / '90-telomere-reviewed-release.conf'
    require(not dropdir.is_symlink() and not dropin.is_symlink(), 'dropin_symlink')
    require(not dropin.exists(), 'dropin_already_exists')
    require(not dropdir.exists() or not list(dropdir.glob('*.conf')), 'unreviewed_controller_dropin')
    final_args, child_work, child = final_work(work, state)
    started = time.monotonic()
    held = {'schemaVersion': 1, 'intentId': secrets.token_hex(16), 'active': True, 'phase': 'intent',
        'parentRun': args.run, 'finalRun': final_args.run, 'parentPid': os.getpid(), 'parentStart': process_start(os.getpid()),
        'activationDeadlineAt': time.time() + 120, 'expectedDropinSha256': hashlib.sha256(dropin_text(state).encode()).hexdigest()}
    require(isinstance(held['parentStart'], str) and re.fullmatch(r'[0-9]{1,32}', held['parentStart']), 'held_parent_process_identity')
    child['heldStop'] = dict(held)
    update(child_work, child)
    state.update(stage='cutover_held', heldStop=held)
    update(work, state)  # Durable authority BEFORE the first original service stop.
    previous_term, previous_alarm = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGALRM)
    previous_deadline = COMMAND_DEADLINE
    def interrupted(_number, _frame):
        global COMMAND_DEADLINE
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        COMMAND_DEADLINE = None  # Cleanup has its own bounded allowance.
        raise Refusal('held_maintenance_interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.setitimer(signal.ITIMER_REAL, 120)
    COMMAND_DEADLINE = started + 120
    try:
        backup = stopped_capture(child_work, child, 'snapshot', recover_on_failure=False)
        originals_inactive()
        child.update(stage='snapshotted', backup=str(backup))
        child['heldStop']['phase'] = 'fresh_snapshot'
        update(child_work, child)
        # Prior non-chain evidence is an extra refusal guard, never authority to ignore raw chain drift.
        before = read_private(work / 'snapshot-fingerprint.json')
        fresh = read_private(child_work / 'snapshot-fingerprint.json')
        require({key: value for key, value in before.items() if key != 'rawChainSha256'}
            == {key: value for key, value in fresh.items() if key != 'rawChainSha256'}, 'rehearsal_nonchain_state_drift')
        clone_validate(final_args, original_stopped=True)
        PHASE = 'cutover'
        child_work, child = load_state(final_args)
        originals_inactive()
        helper(child_work, 'fingerprint-preactivation', {'release': state['release'], 'work': str(child_work),
            'profile': str(PROFILE), 'output': str(child_work / 'preactivation-fingerprint.json')})
        require(read_private(child_work / 'preactivation-fingerprint.json') == fresh, 'fresh_snapshot_drift_no_activation')
        originals_inactive()
        assert_protected(state)
        assert_release(child_work, child)
        require(time.monotonic() - started < 120, 'maintenance_deadline')
        state.update(stage='cutover_activating')
        state['heldStop']['phase'] = 'activating'
        update(work, state)
        dropdir.mkdir(mode=0o755, exist_ok=True)
        require(not dropdir.is_symlink() and not dropin.exists() and not dropin.is_symlink(), 'dropin_path_changed')
        pending = dropdir / ('.telomere-reviewed-release.pending-' + secrets.token_hex(8))
        with open(pending, 'x', opener=lambda name, flags: os.open(name, flags, 0o644)) as output:
            output.write(dropin_text(state)); output.flush(); os.fsync(output.fileno())
        require(digest(pending) == held['expectedDropinSha256'], 'pending_dropin_changed')
        os.link(pending, dropin)  # Exclusive publication of complete bytes; never overwrite another file.
        pending.unlink()
        command(['systemd-analyze', 'verify', 'telomere-staging.service'], timeout=15, log=child_work / 'unit-verify.private.log')
        command(['systemctl', 'daemon-reload'])
        restart_old_units()  # Same units; only the reviewed controller drop-in selects the new release.
        require(command(['systemctl', 'show', 'telomere-staging.service', '--property=WorkingDirectory', '--value']) == state['release'], 'new_release_not_selected')
        require(protected_identity(dropin, state['release']) == state['protectedIdentity'], 'inherited_unit_or_old_code_changed')
        current_units = service_state()
        require(all(current_units[unit]['NRestarts'] == state['originalUnitStates'][unit]['NRestarts'] for unit in UNITS), 'unexpected_auto_restart')
        require(time.monotonic() - started <= 120, 'maintenance_deadline')
        state.update(stage='activated', activatedAt=time.time(), maintenanceSeconds=round(time.monotonic()-started, 3),
            finalWork=str(child_work), finalStateSha256=digest(child_work / 'state.json'),
            finalFreshFingerprintSha256=digest(child_work / 'preactivation-fingerprint.json'),
            controllerDropin=str(dropin), controllerDropinSha256=digest(dropin))
        state['heldStop'].update(active=False, phase='activated')
        update(work, state)  # Only this parent completion makes ExecStopPost a no-op.
    except BaseException:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        COMMAND_DEADLINE = None
        recover_held(args, in_process=True)
        raise
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGTERM, previous_term)
        signal.signal(signal.SIGALRM, previous_alarm)
        COMMAND_DEADLINE = previous_deadline

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
    parser.add_argument('phase', choices=['prepare', 'snapshot', 'validate-clone', 'cutover', 'rollback-code', 'recover-held'])
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
        {'snapshot': snapshot, 'validate-clone': clone_validate, 'cutover': cutover, 'rollback-code': rollback, 'recover-held': recover_held}[args.phase](args)
    print(json.dumps({'status': 'passed', 'phase': args.phase, 'remoteActionsOnlyOnExplicitInvocation': True}))

if __name__ == '__main__':
    try:
        main()
    except Refusal as error:
        reason = str(error)
        safe_reason = reason if re.fullmatch(r'[a-z_]{1,96}', reason) else 'unspecified_refusal'
        print(json.dumps({'status': 'failed', 'phase': PHASE, 'reason': safe_reason,
            'detail': 'Fail-closed. Preserve owned private artifacts. No automatic data restore was attempted.'}), file=sys.stderr)
        sys.exit(1)
    except BaseException:
        print(json.dumps({'status': 'failed', 'phase': PHASE, 'detail': 'Fail-closed. Preserve owned private artifacts. No automatic data restore was attempted.'}), file=sys.stderr)
        sys.exit(1)
