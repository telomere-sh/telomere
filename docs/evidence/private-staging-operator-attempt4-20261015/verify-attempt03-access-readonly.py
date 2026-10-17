"""Remote stdin probe: reads only exact owned attempt03 metadata/log classification. No writes."""
from pathlib import Path
import json
import pwd
import subprocess

base = Path('/opt/telomere-pilot/rollout/staging-354fe7af62ea-launch03')
account = pwd.getpwnam('telomere')
text = (base / 'latest.private.log').read_text(errors='replace')
probe = "import json,os; p='/opt/telomere-pilot/rollout/staging-354fe7af62ea-launch03'; print(json.dumps({'workTraverse':os.access(p,os.X_OK),'helperRead':os.access(p+'/clone-smoke.mjs',os.R_OK),'optionsRead':os.access(p+'/latest-options.json',os.R_OK),'dockerRunTraverse':os.access(p+'/clone/run',os.X_OK),'dockerSocketWrite':os.access(p+'/clone/run/docker.sock',os.W_OK)}))"
result = subprocess.run(['setpriv', '--reuid=' + str(account.pw_uid), '--regid=' + str(account.pw_gid),
    '--init-groups', 'python3', '-c', probe], capture_output=True, text=True, check=True, timeout=10)
run = base / 'clone/run'
print(json.dumps({'schemaVersion': 1, 'kind': 'attempt03_exact_owned_access_readonly', 'probeReadOnly': True,
    'workMode': oct(base.stat().st_mode & 0o777), 'workRootOwned': base.stat().st_uid == 0,
    'workGroupMatchesService': base.stat().st_gid == account.pw_gid,
    'cloneRunMode': oct(run.stat().st_mode & 0o777), 'cloneRunRootOwned': run.stat().st_uid == 0,
    'nodeMissingExactOwnedHelper': ('Cannot find module ' + repr(str(base / 'clone-smoke.mjs'))) in text,
    'nodeModuleNotFoundCode': 'MODULE_NOT_FOUND' in text,
    'serviceUserAccess': json.loads(result.stdout), 'rawChildLogReturned': False,
    'profileOrKeyRead': False, 'serviceOrResourceMutation': False}, sort_keys=True))
