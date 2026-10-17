"""ExecStopPost cleanup of one disposable namespace, including forced termination."""
import json, os, re, subprocess, sys, time
from pathlib import Path

BASE = Path('/opt/telomere-mainnet-pilot')
DOCKER = ['/usr/bin/docker', '--host', 'unix:///run/telomere-mainnet-docker/docker.sock']

def run(args):
    return subprocess.run(DOCKER + args, check=True, capture_output=True, timeout=20).stdout.decode().strip()

if __name__ == '__main__':
    namespace = sys.argv[1]
    assert os.geteuid() == 0 and re.fullmatch('[0-9a-f]{16}', namespace)
    removed = []
    for label, value in (('telomere.load.acceptance', namespace), ('telomere.load.database', 'telomere-load-postgres-' + namespace)):
        names = run(['ps', '-aq', '--filter', 'label=' + label + '=' + value]).splitlines()
        for name in names:
            assert re.fullmatch('[0-9a-f]{12,64}', name)
            assert run(['inspect', '--format', '{{index .Config.Labels "' + label + '"}}', name]) == value
            run(['rm', '-f', name]); removed.append(name)
    volume = 'telomere-load-postgres-' + namespace + '-data'
    check = subprocess.run(DOCKER + ['volume', 'inspect', '--format', '{{index .Labels "telomere.load.database"}}', volume], capture_output=True, timeout=10)
    if check.returncode == 0:
        assert check.stdout.decode().strip() == 'telomere-load-postgres-' + namespace
        run(['volume', 'rm', volume])
    record = {'namespace': namespace, 'serviceResult': os.environ.get('SERVICE_RESULT', 'unknown'),
              'observedAtUnix': time.time(), 'removedContainers': len(removed), 'cleanupPassed': True}
    target = BASE / 'private' / ('cpu-soak-cleanup-' + namespace + '.json')
    temporary = target.with_suffix('.next')
    with temporary.open('x') as output: json.dump(record, output)
    temporary.chmod(0o600); os.replace(temporary, target)
    print(json.dumps(record))
