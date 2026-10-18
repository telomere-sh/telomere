"""Isolated candidate admission and exact 50,000-member backup/restore acceptance."""
import sys as _runtime_sys
if _runtime_sys.flags.optimize:
    raise RuntimeError('Telomere recovery tooling requires checked Python; remove -O/-OO and PYTHONOPTIMIZE.')

import datetime,hashlib,importlib.util,json,os,re,shutil,socket,subprocess,sys,tempfile,time,uuid
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
assert ROOT.parent==Path('/opt/telomere-mainnet-pilot/private') and re.fullmatch('cyst-count-candidate-[0-9a-f]{16}',ROOT.name)
spec=importlib.util.spec_from_file_location('count_ops',Path(__file__).with_name('mainnet-ops.py'))
ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)
spec=importlib.util.spec_from_file_location('count_unpack',Path(__file__).with_name('restore-rehearsal.py'))
recovery=importlib.util.module_from_spec(spec);spec.loader.exec_module(recovery)
sys.path.insert(0,str(Path(__file__).parent.parent/'cpu-cloud'))
import cloud

def main():
    assert os.geteuid()==0 and shutil.disk_usage(ROOT).free>ops.policy.MIN_FREE_BYTES
    namespace=uuid.uuid4().hex[:16];name='telomere-cyst-count-'+namespace;volume=name+'-data'
    folder=ROOT/'fixture';folder.mkdir(mode=0o700)
    stage=ROOT/'sealed';stage.mkdir(mode=0o700)
    backups=ROOT/'backups';backups.mkdir(mode=0o700,exist_ok=True)
    key=ROOT/'fixture-age-identity';recipient=ROOT/'fixture-age-recipients'
    owned=False;volume_created=False;result=None;began=time.monotonic()
    try:
        image=ops.run(ops.DOCKER+['inspect','--format','{{.Image}}','telomere-mainnet-postgres']).stdout.decode().strip();assert re.fullmatch('sha256:[0-9a-f]{64}',image)
        selected=socket.socket();selected.bind(('127.0.0.1',0));port=selected.getsockname()[1];selected.close()
        ops.run(ops.DOCKER+['volume','create','--label','telomere.cyst.count='+name,volume]);volume_created=True
        ops.run(ops.DOCKER+['run','-d','--name',name,'--label','telomere.cyst.count='+name,'--runtime','runc','--cpus','0.5','--memory','512m','--pids-limit','128',
            '-p','127.0.0.1:'+str(port)+':5432','--mount','type=volume,source='+volume+',target=/var/lib/postgresql/data',
            '-e','POSTGRES_USER=fixture','-e','POSTGRES_DB=fixture','-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);owned=True
        for _ in range(60):
            ready=subprocess.run(ops.DOCKER+['exec',name,'sh','-c','test "$(cat /proc/1/comm)" = postgres && pg_isready -U fixture -d fixture'],capture_output=True,timeout=5)
            if ready.returncode==0:break
            time.sleep(.5)
        else:raise RuntimeError('Count PostgreSQL readiness')
        arguments=[ops.NODE,str(Path(__file__).with_name('cyst-count-fixture.mjs')),str(ROOT/'app'),str(folder),'postgresql://fixture@127.0.0.1:'+str(port)+'/fixture']
        subprocess.run(arguments+['generate'],check=True,timeout=1800)
        snapshot=json.loads((folder/'snapshot.json').read_text());assert len(snapshot['references'])==49000
        with (stage/'database.dump').open('wb') as output:
            subprocess.run(ops.DOCKER+['exec',name,'pg_dump','-U','fixture','-d','fixture','-Fc'],check=True,stdout=output,stderr=subprocess.PIPE,timeout=600)
        shutil.copyfile(folder/'snapshot.json',stage/'snapshot.json');(stage/'cysts').mkdir(mode=0o700)
        ops.copy_cysts(folder/'source-cysts',stage/'cysts',snapshot['references'])
        (stage/'configuration').mkdir(mode=0o700)
        for index in range(ops.policy.MAX_OTHER_FILES-2):(stage/'configuration'/('fixture-'+str(index)+'.txt')).write_bytes(b'synthetic configuration')
        server_restore=ops.restore(stage,snapshot)
        ops.run(['age-keygen','-o',str(key)]);recipient.write_bytes(ops.run(['age-keygen','-y',str(key)]).stdout);recipient.chmod(0o600)
        identifier='backup-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]
        encrypted=backups/(identifier+'.tar.age')
        capacity=ops.seal_data_archive(stage,identifier,recipient,encrypted,{'kind':'synthetic-small-cyst-count-acceptance','restoreRehearsal':server_restore,'mainnetTransactions':0})
        assert capacity['files']==49999 and capacity['cystFiles']==49000 and capacity['otherFiles']==999
        checksum=ops.digest(encrypted);readback=ROOT/'readback.tar.age';shutil.copyfile(encrypted,readback);assert ops.digest(readback)==checksum
        recovered=ROOT/'recovered-data';manifest=recovery.unpack(readback,checksum,key.read_bytes(),recovered)
        assert len(manifest['files'])+1==50000
        os.rename(recovered/'cysts',ROOT/'recovered-cysts')
        decrypted=subprocess.run(arguments+['verify',str(ROOT/'recovered-cysts')],check=True,capture_output=True,timeout=600)
        authenticated=json.loads(decrypted.stdout);assert authenticated['authenticatedCheckpointDecryptions']==49000
        proof=cloud.verify_archive(readback,key,ROOT)
        class FixtureStore:
            def release(self,identity,*_):assert identity==identifier;return {'id':identity}
            def assets(self,*_):return [{'name':identifier+'.tar.age'}]
            def download(self,asset,target,expected):assert expected==checksum;shutil.copyfile(encrypted,target);assert ops.digest(target)==expected
        original=subprocess.run
        def fixture_run(arguments,**kwargs):
            if arguments[:3]==['docker','--host','unix:///var/run/docker.sock']:
                arguments=ops.DOCKER+arguments[3:]
                if arguments[len(ops.DOCKER)]=='run':arguments=arguments[:len(ops.DOCKER)+1]+['--runtime','runc']+arguments[len(ops.DOCKER)+1:]
            return original(arguments,**kwargs)
        with patch.dict(os.environ,{'GITHUB_RUN_ID':str(time.time_ns()//1000)}),patch.object(cloud.subprocess,'run',side_effect=fixture_run):
            hosted=cloud.rehearse_restore(FixtureStore(),{'id':identifier,'sha256':checksum,'restore':server_restore},key,ROOT)
        assert hosted['cysts']['files']==49000
        (stage/'manifest.json').unlink();(stage/'snapshot.tar').unlink()
        overflow=stage/'configuration/one-extra.txt';overflow.write_bytes(b'over budget')
        try:ops.seal_data_archive(stage,identifier,recipient,encrypted,{});raise RuntimeError('Oversized file count accepted')
        except ValueError:pass
        assert ops.digest(encrypted)==checksum and not encrypted.with_name(identifier+'.partial').exists()
        result={'scope':'candidate small Cyst admission and exact archive member limit','passed':True,'candidateDirectory':str(ROOT),
            'productionApplicationChanged':False,'productionBackupReceiptChanged':False,'published':False,'mainnetTransactions':0,
            'fixture':json.loads((folder/'fixture.json').read_text()),'id':identifier,'sha256':checksum,'bytes':encrypted.stat().st_size,'capacity':capacity,
            'archiveMembers':50000,'serverRestore':server_restore,'cloudImplementationRestore':hosted,'cloudRunnerExecuted':False,
            'archiveCopyAndAuthenticatedReadback':True,'restoredCheckpointDecryptions':authenticated['authenticatedCheckpointDecryptions'],
            'oneAdditionalMemberRejected':True,'acceptedArchiveUnchangedAfterRejectedOverflow':True,'verification':proof,
            'elapsedSeconds':round(time.monotonic()-began,3)}
    finally:
        if owned:
            assert ops.run(ops.DOCKER+['inspect','--format','{{index .Config.Labels "telomere.cyst.count"}}',name]).stdout.decode().strip()==name
            ops.run(ops.DOCKER+['rm','-f',name])
        if volume_created:
            assert ops.run(ops.DOCKER+['volume','inspect','--format','{{index .Labels "telomere.cyst.count"}}',volume]).stdout.decode().strip()==name
            ops.run(ops.DOCKER+['volume','rm',volume])
        for path in (folder,stage,ROOT/'recovered-data',ROOT/'recovered-cysts'):
            if path.exists():assert path.parent==ROOT and not path.is_symlink();shutil.rmtree(path)
        key.unlink(missing_ok=True);recipient.unlink(missing_ok=True);(ROOT/'readback.tar.age').unlink(missing_ok=True)
    assert result is not None;result['scratchResourcesRemoved']=True;result['fixtureRecoveryKeysRemoved']=True
    ops.atomic(ROOT/'result.json',result);print(json.dumps(result),flush=True)

if __name__=='__main__':os.umask(0o077);main()
