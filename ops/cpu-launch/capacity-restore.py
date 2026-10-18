"""Full Cyst fixture restore using the hosted implementation and a local ciphertext-store adapter."""
import sys as _runtime_sys
if _runtime_sys.flags.optimize:
    raise RuntimeError('Telomere recovery tooling requires checked Python; remove -O/-OO and PYTHONOPTIMIZE.')

import importlib.util,json,os,re,shutil,subprocess,sys,tempfile,time
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parent.parent/'cpu-cloud'))
import cloud
spec=importlib.util.spec_from_file_location('capacity_ops',Path(__file__).with_name('mainnet-ops.py'))
ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)

def main():
    assert os.geteuid()==0
    identity=sys.stdin.buffer.read(4097);assert len(identity)<=4096 and b'AGE-SECRET-KEY-' in identity
    report=json.loads((ops.PRIVATE/'cpu-capacity-acceptance.json').read_text())
    cloud.validate_archive_metadata(report)
    cipher=ops.BACKUPS/(report['id']+'.tar.age');assert ops.digest(cipher)==report['sha256']
    with tempfile.TemporaryDirectory(prefix='capacity-recover-',dir=ops.PRIVATE) as directory:
        folder=Path(directory);key=folder/'identity';key.write_bytes(identity);key.chmod(0o600)
        proof=cloud.verify_archive(cipher,key,folder)
        class FixtureStore:
            def release(self,identifier,*_):assert identifier==report['id'];return {'id':identifier}
            def assets(self,*_):return [{'name':cipher.name}]
            def download(self,asset,target,checksum):assert checksum==report['sha256'];shutil.copyfile(cipher,target);assert ops.digest(target)==checksum
        original=subprocess.run
        def fixture_run(arguments,**kwargs):
            if arguments[:3]==['docker','--host','unix:///var/run/docker.sock']:
                arguments=ops.DOCKER+arguments[3:]
                if arguments[len(ops.DOCKER)]=='run':arguments=arguments[:len(ops.DOCKER)+1]+['--runtime','runc']+arguments[len(ops.DOCKER)+1:]
            return original(arguments,**kwargs)
        with patch.dict(os.environ,{'GITHUB_RUN_ID':str(time.time_ns()//1000)}),patch.object(cloud.subprocess,'run',side_effect=fixture_run):
            restored=cloud.rehearse_restore(FixtureStore(),{**report,'restore':report['serverRestore']},key,folder)
        assert restored['cysts']['files']==512 and restored['cysts']['bytes']==1024**3
        result={'scope':'full quota restore through hosted implementation on VPS','passed':True,'id':report['id'],'sha256':report['sha256'],'bytes':report['bytes'],
            'verification':proof,'restore':restored,'transportAdapter':'local immutable encrypted fixture; dedicated Docker socket',
            'cloudRunnerExecuted':False,'identityRetained':False,'mainnetTransactions':0}
        ops.atomic(ops.PRIVATE/'cpu-capacity-restore.json',result);print(json.dumps(result),flush=True)

if __name__=='__main__':os.umask(0o077);main()
