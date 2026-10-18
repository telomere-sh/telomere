"""Run the actual backup restore verifier on a bounded synthetic acceptance dump."""
import sys as _runtime_sys
if _runtime_sys.flags.optimize:
    raise RuntimeError('Telomere recovery tooling requires checked Python; remove -O/-OO and PYTHONOPTIMIZE.')

import hashlib,importlib.util,json,os,re,shutil,stat,subprocess,sys,tarfile,tempfile,time
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('mainnet_ops',Path(__file__).with_name('mainnet-ops.py'))
ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)

def copy_checked(source,target,limit):
    descriptor=os.open(source,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(descriptor,'rb') as incoming:
        metadata=os.fstat(incoming.fileno())
        assert stat.S_ISREG(metadata.st_mode) and metadata.st_nlink==1 and metadata.st_uid==995 and metadata.st_size<=limit
        with target.open('xb') as outgoing:
            remaining=metadata.st_size
            while remaining:
                chunk=incoming.read(min(1024*1024,remaining));assert chunk
                outgoing.write(chunk);remaining-=len(chunk)
            assert not incoming.read(1)

if __name__=='__main__':
    assert os.geteuid()==0 and len(sys.argv)==2 and re.fullmatch('http-load-[A-Za-z0-9]{6}',sys.argv[1])
    source=ops.BASE/'data/cpu-launch-acceptance-20261017'/sys.argv[1]
    assert source.resolve()==source and source.is_dir() and source.stat().st_uid==995
    with tempfile.TemporaryDirectory(prefix='scale-restore-',dir=ops.PRIVATE) as directory:
        stage=Path(directory)
        copy_checked(source/'large.dump',stage/'database.dump',256*1024**2)
        copy_checked(source/'large-fingerprints.json',stage/'snapshot.json',2*1024**2)
        snapshot=json.loads((stage/'snapshot.json').read_text())
        assert 1<=len(snapshot['fingerprints'])<=100 and sum(t['rows'] for t in snapshot['fingerprints'])<=1000000
        result=ops.restore(stage,snapshot)
        result.update(scope='actual backup restore implementation; synthetic scaled database',mainnetTransactions=0)
        # Exercise the hosted restore implementation with a local, one-use encrypted
        # fixture. GitHub transport and the dedicated Docker socket are the only adapters.
        sys.path.insert(0,str(Path(__file__).parent.parent/'cpu-cloud'))
        import cloud
        identity=stage/'fixture-identity';ops.run(['age-keygen','-o',str(identity)])
        recipient=ops.run(['age-keygen','-y',str(identity)]).stdout.decode().strip()
        archive=stage/'fixture.tar';encrypted=stage/'fixture.tar.age'
        with tarfile.open(archive,'w') as output:
            output.add(stage/'database.dump',arcname='database.dump');output.add(stage/'snapshot.json',arcname='snapshot.json')
        ops.run(['age','-r',recipient,'-o',str(encrypted),str(archive)])
        identifier='backup-20261017T000000Z-1234abcd';checksum=ops.digest(encrypted)
        class FixtureStore:
            def release(self,*_):return {'id':identifier}
            def assets(self,*_):return [{'name':identifier+'.tar.age'}]
            def download(self,asset,destination,expected):
                assert expected==checksum;shutil.copyfile(encrypted,destination);assert ops.digest(destination)==expected
        original=subprocess.run
        def fixture_run(arguments,**kwargs):
            if arguments[:3]==['docker','--host','unix:///var/run/docker.sock']:
                arguments=ops.DOCKER+arguments[3:]
            return original(arguments,**kwargs)
        with patch.dict(os.environ,{'GITHUB_RUN_ID':str(time.time_ns()//1000)}),patch.object(cloud.subprocess,'run',side_effect=fixture_run):
            hosted=cloud.rehearse_restore(FixtureStore(),{'id':identifier,'sha256':checksum,'restore':{'databaseImage':result['databaseImage']}},identity,stage)
        print(json.dumps({'passed':True,'serverRestore':result,'cloudImplementationRestore':hosted,
            'cloudScaleExecutionLocation':'VPS disposable fixture; dedicated Docker socket and local encrypted store adapters',
            'fixtureAgeIdentityDestroyedOnExit':True,'mainnetTransactions':0}))
