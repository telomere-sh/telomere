"""Retain only a completed frozen regression's fixed, safe diagnostic leaves."""
import hashlib, json, pathlib, subprocess

root = pathlib.Path(__file__).resolve().parent.parent
destination = root / 'docs/evidence/backend-completion-linux-20261015'
remote = '/opt/telomere-host-runtime/backend-completion-20261015-d10f22b3259a/.local/'
ssh = ['ssh', '-i', 'C:/Users/Administrator/.ssh/enclave_pilot_ed25519', '-o', 'BatchMode=yes',
       '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', 'root@2.27.12.39']
names = ['full-acceptance.json', 'full-node.json', 'full-node.log', 'full-python.log', 'source-manifest.json']
program = """import hashlib,json,pathlib,stat
p=pathlib.Path('/opt/telomere-host-runtime/backend-completion-20261015-d10f22b3259a/.local')
r=json.loads((p/'full-acceptance.json').read_bytes())
assert r['status']!='running' and r.get('finishedAt') and r['gitRevision']=='7bb69e5e73199ab372ca6c263297792634648aaf'
rows=[]
for n in ['full-acceptance.json','full-node.json','full-node.log','full-python.log','source-manifest.json']:
 f=p/n;s=f.lstat();assert stat.S_ISREG(s.st_mode) and not f.is_symlink() and s.st_nlink==1 and s.st_size<=33554432
 b=f.read_bytes();assert len(b)==s.st_size
 rows.append({'name':n,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
print(json.dumps({'status':r['status'],'finishedAt':r['finishedAt'],'files':rows}))
"""
before = json.loads(subprocess.check_output([*ssh, 'python3', '-'], input=program.encode(), timeout=30))
assert [row['name'] for row in before['files']] == names
for row in before['files']:
    local_name = 'full-source-manifest.json' if row['name'] == 'source-manifest.json' else row['name']
    path = destination / local_name
    assert not path.exists()
    subprocess.run(['scp', '-i', 'C:/Users/Administrator/.ssh/enclave_pilot_ed25519', '-o', 'BatchMode=yes',
                    '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
                    'root@2.27.12.39:' + remote + row['name'], str(path)], check=True, timeout=60)
    value = path.read_bytes()
    assert len(value) == row['bytes'] and hashlib.sha256(value).hexdigest() == row['sha256']
after = json.loads(subprocess.check_output([*ssh, 'python3', '-'], input=program.encode(), timeout=30))
assert before == after
with (destination / 'full-retention.json').open('x', encoding='utf-8', newline='\n') as output:
    json.dump({'schemaVersion': 1, 'remoteAndLocalHashesMatch': True, **before}, output, indent=2)
    output.write('\n')
print(json.dumps({'status': before['status'], 'finishedAt': before['finishedAt'], 'retainedFiles': len(names)}))
