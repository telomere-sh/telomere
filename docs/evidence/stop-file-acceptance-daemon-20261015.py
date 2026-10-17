import hashlib, json, pathlib, subprocess
unit = 'telomere-file-accept-20261015.service'
namespace = 'tlmr-file-accept-20261015'
socket = 'unix:///run/telomere-file-accept-20261015/docker.sock'
def command(args): return subprocess.check_output(args, text=True, timeout=40).strip()
report = {'schemaVersion': 1, 'unit': unit, 'namespace': namespace, 'dataAndImagesDeleted': False,
    'originalStagingUnitsChanged': False, 'protectedRegistryPreserved': True}
start = command(['systemctl', 'show', unit, '--property=ExecStart', '--value'])
assert namespace in start and 'dockerd' in start and '/opt/telomere-host-runtime/docker-data' in start
assert command(['docker', '--host', socket, 'info', '--format', '{{.DockerRootDir}}']) == '/opt/telomere-host-runtime/docker-data'
assert command(['docker', '--host', socket, 'ps', '--all', '--filter', 'label=telomere.session', '--format', '{{.ID}}']) == ''
registry = json.loads(command(['docker', '--host', socket, 'inspect', '1d7ecc9b94866b9617df656ad7e2251916a9b7ceafef9a488ef6e85540076c5e']))[0]
assert registry['State']['Status'] == 'exited' and registry['Config']['Labels'] == {}
subprocess.run(['systemctl', 'stop', unit], check=True, timeout=40)
assert command(['systemctl', 'show', unit, '--property=ActiveState', '--value']) == 'inactive'
assert command(['systemctl', 'show', unit, '--property=MainPID', '--value']) == '0'
assert command(['ip', 'netns', 'pids', namespace]) == ''
subprocess.run(['ip', 'netns', 'delete', namespace], check=True, timeout=10)
assert not pathlib.Path('/run/netns', namespace).exists()
report.update(status='passed', ownedDaemonStopped=True, ownedNamespaceRemoved=True, ownedContainersRemaining=0)
path = pathlib.Path('/opt/telomere-host-runtime/backend-current-20261015-3e901e235bb9/.local/acceptance-daemon-cleanup.json')
with path.open('x') as out: json.dump(report, out, indent=2); out.write('\n')
print(json.dumps(report))
