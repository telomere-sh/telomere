"""Build a full-quota synthetic archive with the real producer, never publish its receipt as production."""
import datetime,hashlib,importlib.util,json,os,re,shutil,socket,subprocess,tempfile,time,uuid
from pathlib import Path
spec=importlib.util.spec_from_file_location('capacity_ops',Path(__file__).with_name('mainnet-ops.py'))
ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)

def main():
    assert os.geteuid()==0
    identifier='backup-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]
    namespace=uuid.uuid4().hex[:16];folder=ops.PRIVATE/('capacity-fixture-'+namespace)
    name='telomere-capacity-'+namespace;volume=name+'-data';owned=False;volume_created=False
    assert shutil.disk_usage(ops.BASE).free>16*1024**3
    folder.mkdir(mode=0o700)
    began=time.monotonic()
    try:
        image=ops.run(ops.DOCKER+['inspect','--format','{{.Image}}','telomere-mainnet-postgres']).stdout.decode().strip()
        assert re.fullmatch('sha256:[0-9a-f]{64}',image)
        selected=socket.socket();selected.bind(('127.0.0.1',0));port=selected.getsockname()[1];selected.close()
        ops.run(ops.DOCKER+['volume','create','--label','telomere.capacity='+name,volume]);volume_created=True
        ops.run(ops.DOCKER+['run','-d','--name',name,'--label','telomere.capacity='+name,'--runtime','runc','--cpus','0.5','--memory','512m','--pids-limit','128',
            '-p','127.0.0.1:'+str(port)+':5432','--mount','type=volume,source='+volume+',target=/var/lib/postgresql/data',
            '-e','POSTGRES_USER=fixture','-e','POSTGRES_DB=fixture','-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);owned=True
        for _ in range(60):
            ready=subprocess.run(ops.DOCKER+['exec',name,'sh','-c','test "$(cat /proc/1/comm)" = postgres && pg_isready -U fixture -d fixture'],capture_output=True,timeout=5)
            if ready.returncode==0:break
            time.sleep(.5)
        else:raise RuntimeError('Capacity PostgreSQL readiness')
        subprocess.run([ops.NODE,str(Path(__file__).with_name('backup-capacity-fixture.mjs')),str(folder),'postgresql://fixture@127.0.0.1:'+str(port)+'/fixture'],check=True,timeout=1800)
        with (folder/'database.dump').open('wb') as output:
            subprocess.run(ops.DOCKER+['exec',name,'pg_dump','-U','fixture','-d','fixture','-Fc'],check=True,stdout=output,stderr=subprocess.PIPE,timeout=600)
        dump_bytes=(folder/'database.dump').stat().st_size
        print(json.dumps({'phase':'dump','dumpBytes':dump_bytes,'limitBytes':ops.policy.MAX_DUMP_BYTES}),flush=True)
        assert 224*1024**2<=dump_bytes<=ops.policy.MAX_DUMP_BYTES
        snapshot=json.loads((folder/'snapshot.json').read_text())
        with tempfile.TemporaryDirectory(prefix='capacity-seal-',dir=ops.PRIVATE) as stage_name:
            stage=Path(stage_name);(stage/'cysts').mkdir(mode=0o700)
            ops.copy_cysts(folder/'source-cysts',stage/'cysts',snapshot['references'])
            shutil.copyfile(folder/'database.dump',stage/'database.dump');shutil.copyfile(folder/'snapshot.json',stage/'snapshot.json')
            restored=ops.restore(stage,snapshot)
            target=ops.BACKUPS/(identifier+'.tar.age')
            capacity=ops.seal_data_archive(stage,identifier,ops.PRIVATE/'backup-recipient.txt',target,{'kind':'synthetic-full-quota-acceptance','mainnetTransactions':0,'restoreRehearsal':restored})
            assert target.stat().st_size>1024**3
            report={'scope':'full Cyst backup capacity acceptance','passed':True,'id':identifier,'sha256':ops.digest(target),'bytes':target.stat().st_size,
                'capacity':capacity,'serverRestore':restored,'fixture':json.loads((folder/'fixture.json').read_text()),'elapsedSeconds':round(time.monotonic()-began,3),
                'releaseTag':'capacity-'+namespace,'productionReceiptChanged':False,'mainnetTransactions':0}
            ops.atomic(ops.PRIVATE/'cpu-capacity-acceptance.json',report)
            print(json.dumps(report),flush=True)
    finally:
        if owned:
            label=ops.run(ops.DOCKER+['inspect','--format','{{index .Config.Labels "telomere.capacity"}}',name]).stdout.decode().strip();assert label==name
            ops.run(ops.DOCKER+['rm','-f',name])
        if volume_created:
            label=ops.run(ops.DOCKER+['volume','inspect','--format','{{index .Labels "telomere.capacity"}}',volume]).stdout.decode().strip();assert label==name
            ops.run(ops.DOCKER+['volume','rm',volume])
        assert folder.parent==ops.PRIVATE and folder.name=='capacity-fixture-'+namespace and not folder.is_symlink()
        shutil.rmtree(folder)

if __name__=='__main__':
    os.umask(0o077);main()
