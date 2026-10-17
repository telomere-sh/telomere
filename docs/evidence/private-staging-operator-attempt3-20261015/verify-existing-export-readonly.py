"""Authorized read-only validation of the retained attempt02 CPU export. No profiles/writes remotely."""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
source = HERE / 'rollout.py'
tree = ast.parse(source.read_text())
names = {'Refusal', 'require', 'digest', 'image_archive_stamp', 'image_archive_identity'}
selected = [node for node in tree.body if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in names]
assert len(selected) == len(names)
code = 'import gzip,hashlib,json,re,stat,subprocess,tarfile,zlib\nfrom pathlib import Path\n'
code += ast.unparse(ast.Module(body=selected, type_ignores=[])) + '\n'
code += """
reference='sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402'
template='{"Id":{{json .Id}},"Architecture":{{json .Architecture}},"Os":{{json .Os}},"RootFS":{{json .RootFS}}}'
path=Path('/opt/telomere-pilot/rollout/staging-354fe7af62ea-launch02/clone/cpu-image.tar')
try:
    result=subprocess.run(['/usr/bin/docker','--host','unix:///var/run/docker.sock','image','inspect','--format',template,reference],capture_output=True,text=True,timeout=15,check=True)
    before=json.loads(result.stdout)
    proof=image_archive_identity(path,before,reference)
    result=subprocess.run(['/usr/bin/docker','--host','unix:///var/run/docker.sock','image','inspect','--format',template,reference],capture_output=True,text=True,timeout=15,check=True)
    require(before==json.loads(result.stdout),'image_source_changed')
    print(json.dumps({'result':'verified','remoteReadOnly':True,'sourceIdentity':before,'proof':proof},sort_keys=True))
except BaseException as error:
    reason=str(error) if isinstance(error,Refusal) and re.fullmatch('[a-z_]{1,96}',str(error)) else type(error).__name__
    print(json.dumps({'result':'refused','reason':reason,'remoteReadOnly':True},sort_keys=True))
    raise SystemExit(1)
"""
(HERE / 'existing-export-probe.stdin.py').write_bytes(code.encode('utf-8'))
result = subprocess.run(['ssh', '-i', 'C:/Users/Administrator/.ssh/enclave_pilot_ed25519',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    'root@2.27.12.39', 'python3', '-'], input=code.encode('utf-8'), capture_output=True, timeout=90, check=False)
if result.returncode != 0:
    try:
        report=json.loads(result.stdout)
        print(json.dumps(report,sort_keys=True))
    except Exception:
        print('existing_export_readonly_refused')
    raise SystemExit(1)
report=json.loads(result.stdout)
assert report['result']=='verified' and report['remoteReadOnly'] is True
report['validatorSourceSha256']=hashlib.sha256(source.read_bytes()).hexdigest()
report['probeSha256']=hashlib.sha256(code.encode('utf-8')).hexdigest()
(HERE / 'existing-export-readonly-proof.json').write_bytes((json.dumps(report,indent=2,sort_keys=True)+'\n').encode('utf-8'))
print(json.dumps({'result':report['result'],'archiveBytes':report['proof']['archiveStat']['bytes'],
    'members':report['proof']['archiveMembers'],'presentBlobs':report['proof']['presentBlobs'],
    'missingNonselected':len(report['proof']['missingNonselectedDescriptors']),
    'configDigest':report['proof']['configDigest'],'expandedBytes':report['proof']['expandedBytes']},sort_keys=True))
