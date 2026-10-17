"""Upload, launch or retain only fixed owned files for the frozen Linux M8 run."""
import hashlib
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOCAL = ROOT / '.local'
REVISION = 'e01b776bd86a9cdc27a3e80f987930ed8116c508'
ARCHIVE_SHA = '9111430f5e2713183e4f7823ca24380cb6afde5c31acff9a4ed751e21bfd4206'
ARCHIVE = LOCAL / 'telomere-paid-cpu-replan-20261015.tar.gz'
MANIFEST = pathlib.Path(str(ARCHIVE) + '.manifest.json')
RUNNER = LOCAL / 'run-paid-cpu-replan-linux-20261015.py'
SOURCE = '/opt/telomere-host-runtime/paid-cpu-replan-20261015-' + ARCHIVE_SHA[:12]
SSH = ['ssh', '-i', 'C:/Users/Administrator/.ssh/enclave_pilot_ed25519', '-o', 'BatchMode=yes',
       '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', 'root@2.27.12.39']
DEST = ROOT / 'docs/evidence/paid-cpu-replan-linux-20261015'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def remote(program, timeout=45):
    return subprocess.check_output([*SSH, 'python3', '-'], input=program.encode(), timeout=timeout)


def store(path, data):
    if path.exists():
        assert path.read_bytes() == data
    else:
        with path.open('xb') as output:
            output.write(data)


def launch():
    manifest = json.loads(MANIFEST.read_bytes())
    assert manifest['gitRevision'] == REVISION and manifest['archiveSha256'] == ARCHIVE_SHA == sha(ARCHIVE.read_bytes())
    assert len(manifest['files']) == 710
    runner_sha = sha(RUNNER.read_bytes())
    uploaded = {ARCHIVE: '/tmp/' + ARCHIVE.name, MANIFEST: '/tmp/' + MANIFEST.name,
                RUNNER: '/tmp/run-paid-cpu-replan-linux-20261015-' + runner_sha[:12] + '.py'}
    for path, destination in uploaded.items():
        expected = sha(path.read_bytes())
        program = """import hashlib,json,pathlib,stat
p=pathlib.Path(PATH)
if p.exists():
 s=p.lstat();assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==0 and not p.is_symlink()
 assert hashlib.sha256(p.read_bytes()).hexdigest()==EXPECTED
 print(json.dumps({'present':True}))
else: print(json.dumps({'present':False}))
""".replace('PATH', repr(destination)).replace('EXPECTED', repr(expected))
        present = json.loads(remote(program))['present']
        if not present:
            subprocess.run(['scp', *SSH[1:-1], str(path), 'root@2.27.12.39:' + destination], check=True, timeout=90)
        assert json.loads(remote(program))['present']
    DEST.mkdir(parents=True, exist_ok=True)
    metadata = {'gitRevision': REVISION, 'archiveSha256': ARCHIVE_SHA, 'sourceFiles': 710,
                'sourceDirectory': SOURCE, 'runnerSha256': runner_sha, 'controllerSha256': sha(pathlib.Path(__file__).read_bytes()),
                'command': ['python3', uploaded[RUNNER], uploaded[ARCHIVE], uploaded[MANIFEST], REVISION, ARCHIVE_SHA]}
    store(DEST / 'launch.json', (json.dumps(metadata, indent=2) + '\n').encode())
    store(DEST / 'executed-runner.py', RUNNER.read_bytes())
    store(DEST / 'executed-controller.py', pathlib.Path(__file__).read_bytes())
    log = LOCAL / 'paid-cpu-replan-linux-runner.log'
    with log.open('xb') as output:
        child = subprocess.Popen([*SSH, *metadata['command']], stdin=subprocess.DEVNULL,
                                 stdout=output, stderr=subprocess.STDOUT)
        code = child.wait(timeout=3300)
    print(json.dumps({'sshExitCode': code, 'runnerLog': str(log), 'source': SOURCE}), flush=True)
    return code


def retain():
    names = ['acceptance.json', 'source-manifest.json', 'vitest.config.ts', 'typecheck.log', 'build.log',
             'crypto-probe.log', 'node.log', 'node.json', 'python.log',
             'cache-node-modules-before.json', 'cache-node-modules-after.json',
             'cache-dist-before.json', 'cache-dist-after.json', 'crypto-venv-before.json', 'crypto-venv-after.json',
             'copied-node-modules-after.json']
    program = """import hashlib,json,pathlib,stat
p=pathlib.Path(SOURCE)/'.local'
r=json.loads((p/'acceptance.json').read_bytes())
assert r['status']!='running' and r['finishedAtUtc'] and r['gitRevision']==REVISION
rows=[]
for n in NAMES:
 f=p/n
 if not f.exists():
  assert r['success'] is False
  rows.append({'name':n,'present':False});continue
 s=f.lstat();assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==0 and not f.is_symlink() and s.st_size<=33554432
 b=f.read_bytes();assert len(b)==s.st_size
 rows.append({'name':n,'present':True,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
print(json.dumps({'status':r['status'],'success':r['success'],'finishedAtUtc':r['finishedAtUtc'],'files':rows}))
""".replace('SOURCE', repr(SOURCE)).replace('REVISION', repr(REVISION)).replace('NAMES', repr(names))
    first = json.loads(remote(program))
    for row in first['files']:
        if not row['present']:
            continue
        destination = DEST / row['name']
        if not destination.exists():
            subprocess.run(['scp', *SSH[1:-1], 'root@2.27.12.39:' + SOURCE + '/.local/' + row['name'], str(destination)],
                           check=True, timeout=120)
        raw = destination.read_bytes()
        assert len(raw) == row['bytes'] and sha(raw) == row['sha256']
    second = json.loads(remote(program))
    assert first == second
    store(DEST / 'runner.log', (LOCAL / 'paid-cpu-replan-linux-runner.log').read_bytes())
    store(DEST / 'retention.json', (json.dumps({'schemaVersion': 1, 'remoteAndLocalHashesMatch': True, **first}, indent=2) + '\n').encode())
    print(json.dumps({'status':first['status'],'success':first['success'],'retained':sum(row['present'] for row in first['files'])}))


if __name__ == '__main__':
    assert len(sys.argv) == 2 and sys.argv[1] in ('launch', 'retain')
    if sys.argv[1] == 'launch':
        raise SystemExit(launch())
    retain()
