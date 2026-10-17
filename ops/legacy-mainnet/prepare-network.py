#!/usr/bin/python3
"""Owned bridge guard. Only --ensure/--before-daemon may create the fixed absent bridge.

Never deletes links, moves endpoints, changes a pre-existing link, or touches firewall rules.
Imports are inert; pure fixture validation does not execute host commands.
"""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

BASE = Path('/opt/telomere-mainnet-pilot')
PRIVATE = BASE / 'private'
RUNTIME = Path('/run/telomere-mainnet-docker')
BRIDGE = 'tlmr-mainnet0'
ADDRESS = '172.31.254.1'
ALIAS = 'telomere-mainnet-prepare-20261015:f1f1fa857fb34ae9adb708ecf6af7166'
OWNERSHIP = {'operation': 'telomere-mainnet-prepare-20261015',
             'id': 'f1f1fa857fb34ae9adb708ecf6af7166', 'base': str(BASE), 'uid': 995, 'gid': 993,
             'owner': '0xa67c6a174409b9b44e67d24cdd386a31d44edb1d',
             'controllerStarted': False, 'transactionsSent': 0}


def require(condition):
    if not condition:
        raise ValueError('Owned network guard refused')


def protected_json(path, maximum=65536):
    metadata = path.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0 and metadata.st_nlink == 1
            and stat.S_IMODE(metadata.st_mode) in (0o600, 0o640)
            and 0 < metadata.st_size <= maximum and path.resolve() == path)
    return json.loads(path.read_text())


def validate_ownership(value):
    require(value == OWNERSHIP and all(type(value.get(key)) is type(reviewed)
                                      for key, reviewed in OWNERSHIP.items()))


def validate_bridge(value):
    require(isinstance(value, dict) and value.get('ifname') == BRIDGE
            and value.get('linkinfo', {}).get('info_kind') == 'bridge'
            and value.get('ifalias') == ALIAS and value.get('mtu') == 1500
            and value.get('master') is None and 'UP' in value.get('flags', []))
    ipv4 = [(item.get('local'), item.get('prefixlen'), item.get('scope'))
            for item in value.get('addr_info', []) if item.get('family') == 'inet']
    require(ipv4 == [(ADDRESS, 24, 'global')])
    require(not any(item.get('family') == 'inet6' and item.get('scope') != 'link'
                    for item in value.get('addr_info', [])))


def network_snapshot(links):
    require(isinstance(links, list) and 1 <= len(links) <= 256)
    snapshot = {}
    for item in links:
        name = item['ifname']
        if name == BRIDGE:
            continue
        require(name not in snapshot)
        snapshot[name] = {key: item.get(key) for key in ('ifindex', 'mtu', 'address', 'master', 'link_index')}
        snapshot[name]['flags'] = sorted(item.get('flags', []))
        snapshot[name]['addresses'] = sorted((address.get('family'), address.get('local'),
                                             address.get('prefixlen'), address.get('scope'))
                                            for address in item.get('addr_info', []))
    # The existing staging default bridge must exist before and after every new-daemon start.
    require('docker0' in snapshot)
    require(('inet', '172.17.0.1', 16, 'global') in snapshot['docker0']['addresses'])
    return snapshot


def ip(*args):
    result = subprocess.run(['/usr/sbin/ip', *args], check=True, capture_output=True, text=True, timeout=10)
    require(len(result.stdout) <= 524288)
    return result.stdout


def links():
    return json.loads(ip('-j', '-details', 'address', 'show'))


def ensure_bridge(may_create):
    current = links()
    own = [item for item in current if item.get('ifname') == BRIDGE]
    require(len(own) <= 1)
    if own:
        validate_bridge(own[0])
        return current
    require(may_create)
    before = network_snapshot(current)
    # A conflicting route is a refusal, not an invitation to change another network.
    routes = json.loads(ip('-j', 'route', 'show', 'table', 'all'))
    import ipaddress
    proposed = ipaddress.ip_network('172.31.254.0/24')
    for route in routes:
        destination = route.get('dst', 'default')
        if destination == 'default':
            continue
        try:
            candidate = ipaddress.ip_network(destination, strict=False)
        except ValueError:
            continue
        require(candidate.version != 4 or not candidate.overlaps(proposed))
    ip('link', 'add', 'name', BRIDGE, 'type', 'bridge')
    # These changes apply only to the bridge this invocation has just created.
    ip('link', 'set', 'dev', BRIDGE, 'alias', ALIAS, 'mtu', '1500')
    ip('address', 'add', ADDRESS + '/24', 'dev', BRIDGE)
    ip('link', 'set', 'dev', BRIDGE, 'up')
    after = links()
    validate_bridge(next(item for item in after if item.get('ifname') == BRIDGE))
    require(network_snapshot(after) == before)
    return after


def validate_runtime_directory():
    metadata = RUNTIME.lstat()
    require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == 0 and metadata.st_gid == 993
            and stat.S_IMODE(metadata.st_mode) == 0o710 and RUNTIME.resolve() == RUNTIME)


def snapshot_write(value):
    validate_runtime_directory()
    path = RUNTIME / 'legacy-network-before.json'
    if path.exists() or path.is_symlink():
        protected_json(path)
    fd, temporary = tempfile.mkstemp(prefix='.network-guard-', dir=RUNTIME)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump({'operation': OWNERSHIP['operation'], 'id': OWNERSHIP['id'], 'interfaces': value}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    require(os.getuid() == 0 and len(sys.argv) == 2
            and sys.argv[1] in ('--ensure', '--before-daemon', '--after-daemon'))
    for path in (BASE, PRIVATE):
        metadata = path.lstat()
        require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == 0
                and not metadata.st_mode & 0o022 and path.resolve() == path)
    validate_ownership(protected_json(PRIVATE / 'ownership.json'))
    mode = sys.argv[1]
    current = ensure_bridge(mode != '--after-daemon')
    snapshot = network_snapshot(current)
    if mode == '--before-daemon':
        snapshot_write(snapshot)
    elif mode == '--after-daemon':
        validate_runtime_directory()
        before = protected_json(RUNTIME / 'legacy-network-before.json')
        require(before.get('operation') == OWNERSHIP['operation'] and before.get('id') == OWNERSHIP['id'])
        # JSON transports tuples as arrays. Normalize both sides before exact comparison.
        require(before.get('interfaces') == json.loads(json.dumps(snapshot)))
    print(json.dumps({'ownedBridgeVerified': True, 'legacyInterfacesPreserved': True,
                      'bridge': BRIDGE, 'mode': mode}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Do not emit command stderr, private data or an unaudited host inventory.
        print(json.dumps({'status': 'owned_network_guard_refused'}), file=sys.stderr)
        sys.exit(1)
