"""Real SIGKILL / PID-namespace restart of backup(), using only synthetic data.

Run from a root-only backup-crash-candidate-<16 hex> directory on the VPS.
The container restart is an isolated environment restart, not a host/kernel reboot.
No mainnet profile, signer, database URL or private backup is supplied to a worker.
"""
import hashlib,importlib.util,json,os,re,shutil,signal,subprocess,sys,time,uuid
from pathlib import Path
from unittest.mock import patch

ROOT=Path(sys.argv[2]).resolve()
assert ROOT.parent==Path('/opt/telomere-mainnet-pilot/private') and re.fullmatch('backup-crash-candidate-[0-9a-f]{16}',ROOT.name)
spec=importlib.util.spec_from_file_location('crash_acceptance_ops',Path(__file__).with_name('mainnet-ops.py'))
ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)
REAL_RUN=subprocess.run;REAL_POPEN=subprocess.Popen

def wait_for(predicate,seconds=60):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        value=predicate()
        if value:return value
        time.sleep(.05)
    raise TimeoutError('Isolated backup fixture deadline')

def snapshot():
    config=json.loads((ROOT/'fixture.json').read_text())
    process=REAL_POPEN(ops.DOCKER+['exec','-i',config['database'],'psql','-X','-q','-A','-t','-U','fixture','-d','fixture','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    process.stdin.write(b'BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT pg_export_snapshot();\n');process.stdin.flush()
    identifier=process.stdout.readline().decode().strip();assert re.fullmatch('[0-9a-fA-F-]+',identifier)
    value={**config['snapshot'],'snapshot':identifier};print(json.dumps(value),flush=True)
    sys.stdin.readline();process.communicate(b'ROLLBACK;\n',timeout=10);assert process.returncode==0

def worker():
    os.umask(0o077)
    ops.BASE=ROOT;ops.PRIVATE=ROOT/'private';ops.BACKUPS=ROOT/'backups'
    control=json.loads((ROOT/'control.json').read_text());config=json.loads((ROOT/'fixture.json').read_text())
    boot=uuid.uuid4().hex;ops.atomic(ROOT/'worker-boot.json',{'instance':boot,'pid':os.getpid(),'phase':control['phase']})
    def gate(phase,**extra):
        if control['phase']==phase:
            ops.atomic(ROOT/'barrier.json',{'phase':phase,'instance':boot,**extra})
            while True:signal.pause()
    def popen(args,**kwargs):
        if args[:1]==[ops.NODE]:args=['/usr/bin/python3',str(Path(__file__)), 'snapshot',str(ROOT)]
        return REAL_POPEN(args,**kwargs)
    def run(args,**kwargs):
        if args[:len(ops.DOCKER)+3]==ops.DOCKER+['exec','telomere-mainnet-postgres','sh']:
            args=ops.DOCKER+['exec',config['database'],'pg_dump','-U','fixture','-d','fixture','-Fc','--snapshot',args[-1]]
        phase='runtime-encrypt' if args[:1]==['/usr/bin/age'] and str(args[-1]).endswith('runtime.tar.gz') else 'data-encrypt'
        if args[:2]==['/usr/bin/age','-R'] and control['phase']==phase:
            # Feed a real age process a bounded prefix, then interrupt while its
            # stdin is open. Ciphertext is incomplete and never reaches rename.
            child=REAL_POPEN(args[:-1]+['-'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            with Path(args[-1]).open('rb') as incoming:child.stdin.write(incoming.read(1024*1024));child.stdin.flush()
            partial=Path(args[args.index('-o')+1]);wait_for(lambda:partial.exists() and partial.stat().st_size>100)
            gate(phase,partialBytes=partial.stat().st_size,ageAlive=child.poll() is None)
            raise AssertionError('Unreachable barrier')
        result=REAL_RUN(args,**kwargs)
        if len(args)>len(ops.DOCKER) and args[:len(ops.DOCKER)]==ops.DOCKER and args[len(ops.DOCKER)]=='run' and '--label' in args and any(str(v).startswith('telomere.backup.attempt=') for v in args):
            gate('restore-created',restoreContainer=result.stdout.decode().strip())
        return result
    def copy(directory,target,references):
        original_copy(directory,target,references[:1]);gate('cyst-copy',filesCopied=1)
        original_copy(directory,target,references[1:])
    def configuration(stage):
        (stage/'configuration').mkdir(mode=0o700);(stage/'configuration/fixture.json').write_text('{"synthetic":true}')
    def runtime(workspace):
        folder=workspace/'runtime';folder.mkdir(mode=0o700)
        archive=folder/'runtime.tar.gz';archive.write_bytes(b'synthetic runtime fixture\n'*100000)
        identifier='runtime-'+'1'*40+'-'+'2'*16;target=ops.BACKUPS/(identifier+'.tar.age')
        ops.encrypt_archive(archive,ops.PRIVATE/'backup-recipient.txt',target,identifier)
        return {'id':identifier,'sha256':ops.digest(target),'bytes':target.stat().st_size,'synthetic':True}
    original_copy=ops.copy_cysts
    original_encrypt=ops.encrypt_archive
    def encrypt(archive,recipient,output,identifier):
        original_encrypt(archive,recipient,output,identifier)
        if identifier.startswith('backup-'):gate('data-published',publishedArchive=output.name,publishedSha256=ops.digest(output))
    with patch.object(ops.subprocess,'Popen',side_effect=popen),patch.object(ops.subprocess,'run',side_effect=run),patch.object(ops,'copy_cysts',side_effect=copy),patch.object(ops,'copy_configuration',side_effect=configuration),patch.object(ops,'runtime_bundle',side_effect=runtime),patch.object(ops,'encrypt_archive',side_effect=encrypt):
        ops.backup()
    ops.atomic(ROOT/'worker-success.json',{'instance':boot,'workspacesRemaining':len(list((ops.PRIVATE/'cpu-backup-work').iterdir()))})

def controller():
    os.umask(0o077);assert os.geteuid()==0
    namespace=ROOT.name.rsplit('-',1)[1];database='telomere-backup-crash-'+namespace;volume=database+'-data';worker_name=database+'-worker'
    image=ops.run(ops.DOCKER+['inspect','--format','{{.Image}}','telomere-mainnet-postgres']).stdout.decode().strip();assert re.fullmatch('sha256:[0-9a-f]{64}',image)
    (ROOT/'private').mkdir(mode=0o700);(ROOT/'backups').mkdir(mode=0o700);(ROOT/'data/cysts').mkdir(mode=0o700,parents=True)
    (ROOT/'app').mkdir(mode=0o700);key=ROOT/'identity';recipient=ROOT/'private/backup-recipient.txt'
    results=[];began=time.monotonic();created=False;volume_created=False;worker_created=False
    try:
        ops.run(ops.DOCKER+['volume','create','--label','telomere.backup.crash='+namespace,volume]);volume_created=True
        ops.run(ops.DOCKER+['run','-d','--name',database,'--label','telomere.backup.crash='+namespace,'--runtime','runc','--network','none','--cpus','0.5','--memory','512m','--pids-limit','128','--mount','type=volume,source='+volume+',target=/var/lib/postgresql/data','-e','POSTGRES_USER=fixture','-e','POSTGRES_DB=fixture','-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);created=True
        wait_for(lambda:REAL_RUN(ops.DOCKER+['exec',database,'sh','-c','test "$(cat /proc/1/comm)" = postgres && pg_isready -U fixture -d fixture'],capture_output=True,timeout=5).returncode==0)
        sql=b'CREATE TABLE fixture_records(id integer PRIMARY KEY, message text NOT NULL); INSERT INTO fixture_records SELECT n, repeat(md5(n::text),100) FROM generate_series(1,100) n;'
        ops.run(ops.DOCKER+['exec','-i',database,'psql','-X','-U','fixture','-d','fixture','-v','ON_ERROR_STOP=1'],input=sql)
        rows=ops.run(ops.DOCKER+['exec',database,'psql','-X','-q','-A','-t','-U','fixture','-d','fixture','-c','SELECT to_jsonb(t)::text FROM fixture_records t ORDER BY to_jsonb(t)::text;']).stdout
        refs=[]
        for index in range(64):
            payload=os.urandom(256*1024);checksum=hashlib.sha256(payload).hexdigest();owner='0x'+'11'*20
            name=hashlib.sha256(('telomere-cyst-blob:'+owner+':'+checksum).encode()).hexdigest()+'.blob'
            (ROOT/'data/cysts'/name).write_bytes(payload);refs.append({'owner':owner,'sha256':checksum,'ciphertext_bytes':len(payload),'state':'ready'})
        ops.atomic(ROOT/'fixture.json',{'database':database,'snapshot':{'references':refs,'fingerprints':[{'table':'fixture_records','rows':100,'sha256':hashlib.sha256(rows).hexdigest()}]}})
        ops.run(['age-keygen','-o',str(key)]);recipient.write_bytes(ops.run(['age-keygen','-y',str(key)]).stdout);recipient.chmod(0o600)
        args=ops.DOCKER+['create','--name',worker_name,'--label','telomere.backup.crash='+namespace,'--runtime','runc','--network','none','--cpus','0.5','--memory','512m','--pids-limit','128',
            '--mount','type=bind,source='+str(ROOT)+',target='+str(ROOT)]
        for path in ('/usr','/lib','/lib64'):args+=['--mount','type=bind,source='+path+',target='+path+',readonly']
        socket='/run/telomere-mainnet-docker/docker.sock';args+=['--mount','type=bind,source='+socket+',target='+socket]
        args+=['--entrypoint','/usr/bin/python3',image,str(Path(__file__)), 'worker',str(ROOT)]
        ops.run(args);worker_created=True
        def start(phase):
            (ROOT/'barrier.json').unlink(missing_ok=True);(ROOT/'worker-success.json').unlink(missing_ok=True)
            ops.atomic(ROOT/'control.json',{'phase':phase});ops.run(ops.DOCKER+['start',worker_name])
        def completed():
            value=json.loads(ops.run(ops.DOCKER+['inspect',worker_name]).stdout)[0]['State']
            return value if not value['Running'] else None
        def success():
            state=wait_for(completed,120)
            if state['ExitCode']!=0:
                log=ops.run(ops.DOCKER+['logs',worker_name]).stdout.decode();raise RuntimeError('Worker failed; inspect private worker.log')
            proof=json.loads((ROOT/'worker-success.json').read_text());assert proof['workspacesRemaining']==0
            receipt=json.loads((ROOT/'private/cpu-backup-status.json').read_text());assert receipt['restore']['passed'] and receipt['restore']['rows']==100
            spec=importlib.util.spec_from_file_location('fixture_unpack',Path(__file__).with_name('restore-rehearsal.py'));unpack=importlib.util.module_from_spec(spec);spec.loader.exec_module(unpack)
            recovered=ROOT/'readback';manifest=unpack.unpack(ROOT/'backups'/(receipt['id']+'.tar.age'),receipt['sha256'],key.read_bytes(),recovered)
            assert len([x for x in manifest['files'] if x['path'].startswith('cysts/')])==64
            assert all(ops.digest(recovered/'cysts'/p.name)==ops.digest(p) for p in (ROOT/'data/cysts').iterdir())
            restored=ops.restore(recovered,json.loads((recovered/'snapshot.json').read_text()));assert restored['passed'] and restored['rows']==100
            shutil.rmtree(recovered)
            return {'id':receipt['id'],'sha256':receipt['sha256'],'bytes':receipt['bytes'],'restoredRows':100,'restoredCystFiles':64,'instance':proof['instance']}
        start('normal');baseline=success()
        for phase,method in [('cyst-copy','SIGKILL'),('restore-created','SIGKILL'),('runtime-encrypt','SIGKILL'),('data-published','SIGKILL'),('data-encrypt','isolated-container-restart')]:
            previous=(ROOT/'private/cpu-backup-status.json').read_bytes();prior=json.loads(previous)
            previous_hash=ops.digest(ROOT/'backups'/(prior['id']+'.tar.age'))
            start(phase);barrier=wait_for(lambda:json.loads((ROOT/'barrier.json').read_text()) if (ROOT/'barrier.json').exists() else None)
            stale=list((ROOT/'private/cpu-backup-work').iterdir());assert len(stale)==1
            stale_name=stale[0].name;partial_files=list(stale[0].rglob('*.partial'))
            assert (ROOT/'private/cpu-backup-status.json').read_bytes()==previous
            if 'encrypt' in phase:assert len(partial_files)==1 and barrier['ageAlive'] and barrier['partialBytes']>100
            if phase=='restore-created':assert REAL_RUN(ops.DOCKER+['inspect',barrier['restoreContainer']],capture_output=True).returncode==0
            ops.atomic(ROOT/'control.json',{'phase':'normal'});(ROOT/'worker-success.json').unlink(missing_ok=True)
            if method=='SIGKILL':
                ops.run(ops.DOCKER+['kill','--signal','KILL',worker_name]);killed=wait_for(completed);assert killed['ExitCode']==137
                assert (ROOT/'private/cpu-backup-status.json').read_bytes()==previous
                ops.run(ops.DOCKER+['start',worker_name])
            else:ops.run(ops.DOCKER+['restart','--time','0',worker_name])
            recovered=success();assert recovered['instance']!=barrier['instance']
            assert not (ROOT/'private/cpu-backup-work'/stale_name).exists()
            assert not list((ROOT/'private/cpu-backup-work').rglob('*.partial'))
            assert ops.digest(ROOT/'backups'/(prior['id']+'.tar.age'))==previous_hash
            if phase=='data-published':assert ops.digest(ROOT/'backups'/barrier['publishedArchive'])==barrier['publishedSha256']
            labels=ops.attempt_labels(stale[0]) if ops.PRIVATE==ROOT/'private' else {'telomere.backup.root':hashlib.sha256(str(ROOT/'private').encode()).hexdigest(),'telomere.backup.attempt':stale_name}
            filters=[v for k,value in labels.items() for v in ('--filter','label='+k+'='+value)]
            assert not ops.run(ops.DOCKER+['container','ls','-aq']+filters).stdout.strip() and not ops.run(ops.DOCKER+['volume','ls','-q']+filters).stdout.strip()
            idle=ops.run(ops.DOCKER+['exec',database,'psql','-X','-q','-A','-t','-U','fixture','-d','fixture','-c',"SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction';"]).stdout.strip()
            assert idle==b'0'
            results.append({'phase':phase,'interruption':method,'barrier':barrier,'previousSuccessfulArchiveUnchanged':True,'previousReceiptUnchangedBeforeRestart':True,'staleAttemptRemoved':True,'ownedDockerResourcesRemoved':True,'partialCiphertextsRemoved':True,'abandonedSnapshotTransactions':0,'nextBackup':recovered})
        result={'passed':True,'mainnetTransactions':0,'mainnetSignerLoaded':False,'productionApplicationChanged':False,'productionBackupStatusChanged':False,'hostRebooted':False,
            'restartScope':'disposable Docker PID namespace with persistent bind-mounted fixture storage; host kernel and production services remain running',
            'fixtureAdapters':['synthetic exported PostgreSQL snapshot and pg_dump target','synthetic private configuration','synthetic runtime payload','age stdin prefix barrier only for fault injection'],
            'realImplementation':['backup lock and stale recovery','Cyst copying','PostgreSQL dump and isolated restore','age encryption and atomic publication','archive authentication and restored file hashes'],
            'baseline':baseline,'cases':results,'elapsedSeconds':round(time.monotonic()-began,3)}
    finally:
        if worker_created:
            REAL_RUN(ops.DOCKER+['logs',worker_name],stdout=(ROOT/'worker.log').open('wb'),stderr=subprocess.STDOUT,timeout=10)
            assert ops.run(ops.DOCKER+['inspect','--format','{{index .Config.Labels "telomere.backup.crash"}}',worker_name]).stdout.decode().strip()==namespace
            ops.run(ops.DOCKER+['rm','-f',worker_name])
        # On a failed fixture keep the private attempt for diagnosis; remove only
        # resources carrying its exact root/attempt labels, never global prune.
        work=ROOT/'private/cpu-backup-work'
        if work.exists():
            with patch.object(ops,'PRIVATE',ROOT/'private'):
                for stage in work.iterdir():ops.remove_attempt(stage)
        if created:
            assert ops.run(ops.DOCKER+['inspect','--format','{{index .Config.Labels "telomere.backup.crash"}}',database]).stdout.decode().strip()==namespace
            ops.run(ops.DOCKER+['rm','-f',database])
        if volume_created:
            assert ops.run(ops.DOCKER+['volume','inspect','--format','{{index .Labels "telomere.backup.crash"}}',volume]).stdout.decode().strip()==namespace
            ops.run(ops.DOCKER+['volume','rm',volume])
        key.unlink(missing_ok=True);recipient.unlink(missing_ok=True)
        for path in (ROOT/'data',ROOT/'readback',ROOT/'private'):
            if path.exists():assert path.parent==ROOT and not path.is_symlink();shutil.rmtree(path)
    result.update(scratchResourcesRemoved=True,fixtureKeysAndPlaintextRemoved=True)
    ops.atomic(ROOT/'result.json',result);print(json.dumps(result),flush=True)

if __name__=='__main__':
    {'controller':controller,'worker':worker,'snapshot':snapshot}[sys.argv[1]]()
