"""Root-owned mainnet backup and read-only restore rehearsal. Never starts a restored controller."""
import argparse,datetime,fcntl,hashlib,json,os,re,select,shutil,socket,ssl,stat,subprocess,tarfile,tempfile,time,uuid,urllib.request
from pathlib import Path
BASE=Path('/opt/telomere-mainnet-pilot');PRIVATE=BASE/'private';BACKUPS=BASE/'backups'
DOCKER=['/usr/bin/docker','--host','unix:///run/telomere-mainnet-docker/docker.sock']
NODE='/opt/node-v22.23.3-linux-x64/bin/node'
PHASE='arguments'
IDENTIFIER=re.compile(r'backup-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}')
def run(args,**kwargs):return subprocess.run(args,check=True,capture_output=True,timeout=120,**kwargs)
def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()
def fingerprint_file(source):
    """psql emits one newline-terminated JSON record per row; bound verifier memory."""
    checksum=hashlib.sha256();rows=0
    for chunk in iter(lambda:source.read(1024*1024),b''):
        checksum.update(chunk);rows+=chunk.count(b'\n')
    return checksum.hexdigest(),rows
def atomic(path,value):
    temp=path.with_name(path.name+'.next');temp.write_text(json.dumps(value,indent=2)+'\n');temp.chmod(0o600);os.replace(temp,path)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()

def validate_recipients(text):
    recipients=text.splitlines()
    assert 1<=len(recipients)<=4 and len(set(recipients))==len(recipients)
    assert all(re.fullmatch(r'age1[0-9a-z]{58}',recipient) for recipient in recipients)
def copy_cysts(directory,target,references):
    assert directory.is_dir() and not directory.is_symlink() and directory.resolve()==directory
    for entry in references:
        assert re.fullmatch('0x[0-9a-f]{40}',entry['owner']) and re.fullmatch('[0-9a-f]{64}',entry['sha256'])
        assert entry['state'] in ('pending','ready') and 17<=entry['ciphertext_bytes']<=2097168
        name=hashlib.sha256(('telomere-cyst-blob:'+entry['owner']+':'+entry['sha256']).encode()).hexdigest()+'.blob'
        source=directory/name;destination=target/name
        try:fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
        except FileNotFoundError:assert entry['state']=='pending';continue
        with os.fdopen(fd,'rb') as incoming:
            metadata=os.fstat(incoming.fileno());assert stat.S_ISREG(metadata.st_mode) and metadata.st_nlink==1 and metadata.st_size==entry['ciphertext_bytes']
            if not destination.exists():
                remaining=entry['ciphertext_bytes'];h=hashlib.sha256()
                with destination.open('xb') as out:
                    while remaining:
                        chunk=incoming.read(min(1024*1024,remaining));assert chunk
                        remaining-=len(chunk);h.update(chunk);out.write(chunk)
                    assert not incoming.read(1) and h.hexdigest()==entry['sha256']
            assert destination.stat().st_size==entry['ciphertext_bytes'] and digest(destination)==entry['sha256']
def runtime_bundle():
    expected=json.loads((PRIVATE/'expected.json').read_text());release=Path(expected['releaseDirectory']).resolve()
    assert release.parent==BASE/'releases' and (BASE/'app').resolve()==release
    entries=[]
    for path in sorted(release.rglob('*')):
        if path.is_symlink():continue # npm .bin aliases are build-time conveniences.
        if path.is_file():entries.append((path,'release/'+path.relative_to(release).as_posix()))
    roots=re.findall(r'^\s*root\s+(/var/www/telomere-public/[A-Za-z0-9_-]+);',Path('/etc/nginx/sites-available/telomere-apex-static').read_text(),re.M)
    assert len(roots)==1
    website=Path(roots[0]);assert website.is_dir() and not website.is_symlink() and website.resolve()==website
    for path in sorted(website.rglob('*')):
        assert not path.is_symlink()
        if path.is_file():entries.append((path,'website/'+path.relative_to(website).as_posix()))
    for path in sorted((BASE/'operator').rglob('*')):
        if path.is_symlink() or '__pycache__' in path.parts:continue
        if path.is_file():entries.append((path,'operator/'+path.relative_to(BASE/'operator').as_posix()))
    for path in sorted(Path('/etc/systemd/system').glob('telomere-mainnet*')):
        if path.is_symlink():continue
        if path.is_file():entries.append((path,'systemd/'+path.name))
        elif path.is_dir():
            for child in sorted(path.iterdir()):
                if child.is_file() and not child.is_symlink():entries.append((child,'systemd/'+path.name+'/'+child.name))
    entries.extend([(Path(NODE),'binaries/node'),(Path('/opt/telomere-host-runtime/gvisor/runsc'),'binaries/runsc')])
    files=[{'path':name,'bytes':path.stat().st_size,'sha256':digest(path),'mode':path.stat().st_mode&0o777} for path,name in entries]
    for pin in expected['runtimePins']:
        found=next((f for f in files if f['path']=='release/'+pin['path']),None)
        assert found and found['sha256']==pin['sha256'],'Runtime pin differs during backup'
    recipient_hash=digest(PRIVATE/'backup-recipient.txt')
    identity=hashlib.sha256(json.dumps({'files':files,'recipientSha256':recipient_hash},sort_keys=True).encode()).hexdigest()
    identifier='runtime-'+expected['releaseId']+'-'+identity[:16];target=BACKUPS/(identifier+'.tar.age')
    manifest={'schemaVersion':1,'id':identifier,'kind':'exact-reviewed-runtime','runtimePinsVerified':len(expected['runtimePins']),'recipientSha256':recipient_hash,
        'layout':{'releaseDirectory':str(release),'publicWebroot':str(website),'nodeBinary':NODE,'runscBinary':'/opt/telomere-host-runtime/gvisor/runsc'},'files':files}
    status_file=PRIVATE/'cpu-runtime-backup-status.json'
    if target.exists():
        # A rollback may select a previously archived bundle. Its private receipt
        # is keyed by identity, rather than assuming it was the latest bundle.
        receipt=PRIVATE/(identifier+'.json')
        old=json.loads(receipt.read_text());assert old['id']==identifier and old['sha256']==digest(target)
        atomic(status_file,old);return old
    with tempfile.TemporaryDirectory(prefix='runtime-snapshot-',dir=PRIVATE) as temp:
        stage=Path(temp).resolve();assert stage.parent==PRIVATE
        metadata=stage/'manifest.json';metadata.write_text(json.dumps(manifest,indent=2)+'\n')
        archive=stage/'runtime.tar.gz'
        with tarfile.open(archive,'w:gz',compresslevel=1) as tar:
            for path,name in entries:assert path.is_file() and not path.is_symlink();tar.add(path,arcname=name,recursive=False)
            tar.add(metadata,arcname='manifest.json')
        temporary=BACKUPS/(identifier+'.partial')
        run(['/usr/bin/age','-R',str(PRIVATE/'backup-recipient.txt'),'-o',str(temporary),str(archive)]);temporary.chmod(0o600);os.replace(temporary,target)
    result={'id':identifier,'sha256':digest(target),'bytes':target.stat().st_size,'runtimePinsVerified':len(expected['runtimePins']),'files':len(files)}
    atomic(PRIVATE/(identifier+'.json'),result);atomic(status_file,result);return result
def restore(stage,snapshot):
    global PHASE
    PHASE="restore_create"
    name='telomere-backup-restore-'+uuid.uuid4().hex;owned=False;volume=name+'-data';volume_created=False
    image=run(DOCKER+['inspect','--format','{{.Image}}','telomere-mainnet-postgres']).stdout.decode().strip()
    assert re.fullmatch(r'sha256:[0-9a-f]{64}',image)
    digests=json.loads(run(DOCKER+['image','inspect','--format','{{json .RepoDigests}}',image]).stdout)
    pull_image=next(value for value in digests if re.fullmatch(r'postgres@sha256:[0-9a-f]{64}',value))
    began=time.monotonic()
    try:
        assert shutil.disk_usage(BASE).free>4*1024**3,'Insufficient scratch restore disk'
        run(DOCKER+['volume','create','--label','telomere.backup.exercise='+name,volume]);volume_created=True
        run(DOCKER+['run','-d','--name',name,'--label','telomere.backup.exercise='+name,'--runtime','runc','--network','none',
            '--cpus','0.5','--memory','512m','--pids-limit','128','--mount','type=volume,source='+volume+',target=/var/lib/postgresql/data',
            '-e','POSTGRES_USER=restore','-e','POSTGRES_DB=restore','-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);owned=True
        for attempt in range(60):
            ready=subprocess.run(DOCKER+['exec',name,'sh','-c','test "$(cat /proc/1/comm)" = postgres && pg_isready -U restore -d restore'],capture_output=True,timeout=5)
            if ready.returncode==0:break
            time.sleep(.5)
        else:raise RuntimeError('Isolated restore PostgreSQL did not start')
        PHASE='restore_archive'
        with (stage/'database.dump').open('rb') as f:
            p=subprocess.run(DOCKER+['exec','-i',name,'pg_restore','-U','restore','-d','restore','--exit-on-error','--no-owner','--no-acl'],stdin=f,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=120)
        assert p.returncode==0,'Scratch database restore failed'
        tables=0;rows=0
        for entry in snapshot['fingerprints']:
            table=entry['table'];PHASE='restore_table_'+table;assert re.fullmatch('[a-z][a-z0-9_]*',table)
            query='SELECT to_jsonb(t)::text FROM public."'+table+'" t ORDER BY to_jsonb(t)::text;'
            with tempfile.TemporaryFile() as output:
                subprocess.run(DOCKER+['exec',name,'psql','-X','-q','-A','-t','-U','restore','-d','restore','-v','ON_ERROR_STOP=1','-v','FETCH_COUNT=256','-c',query],
                    check=True,stdout=output,stderr=subprocess.PIPE,timeout=120)
                output.seek(0);checksum,count=fingerprint_file(output)
            assert checksum==entry['sha256'],'Restored table fingerprint differs'
            assert count==entry['rows']
            tables+=1;rows+=count
        return {'passed':True,'tables':tables,'rows':rows,'elapsedSeconds':round(time.monotonic()-began,3),'network':'none','mainnetControllerStarted':False,'databaseImage':pull_image}
    finally:
        if owned:
            label=run(DOCKER+['inspect','--format','{{index .Config.Labels "telomere.backup.exercise"}}',name]).stdout.decode().strip()
            assert label==name
            run(DOCKER+['rm','-f',name])
        if volume_created:
            label=run(DOCKER+['volume','inspect','--format','{{index .Labels "telomere.backup.exercise"}}',volume]).stdout.decode().strip()
            assert label==name
            run(DOCKER+['volume','rm',volume])
def backup():
    global PHASE
    PHASE="backup_setup"
    assert os.geteuid()==0
    BACKUPS.mkdir(mode=0o700,exist_ok=True);assert not BACKUPS.is_symlink()
    with (PRIVATE/'cpu-backup.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        started=time.monotonic();identifier='backup-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]
        assert shutil.disk_usage(BASE).free>4*1024**3
        recipient=PRIVATE/'backup-recipient.txt';validate_recipients(recipient.read_text())
        with tempfile.TemporaryDirectory(prefix='cpu-snapshot-',dir=PRIVATE) as temp:
            stage=Path(temp).resolve();assert stage.parent==PRIVATE
            helper=BASE/'operator/cpu-launch/snapshot.mjs'
            PHASE='export_snapshot'
            proc=subprocess.Popen([NODE,str(helper)],cwd=BASE/'app',stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                ready,_,_=select.select([proc.stdout],[],[],30);assert ready,'Snapshot exporter timed out'
                snapshot=json.loads(proc.stdout.readline(16*1024*1024));assert re.fullmatch('[0-9a-fA-F-]+',snapshot['snapshot'])
                PHASE='database_dump'
                with (stage/'database.dump').open('wb') as out:
                    args=DOCKER+['exec','telomere-mainnet-postgres','sh','-c','PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -h 127.0.0.1 -p 15435 -U "$POSTGRES_USER" -d telomere_mainnet -Fc --snapshot "$1"','backup',snapshot['snapshot']]
                    result=subprocess.run(args,stdout=out,stderr=subprocess.PIPE,timeout=120);assert result.returncode==0 and out.tell()>0
                PHASE='cyst_copy'
                (stage/'snapshot.json').write_text(json.dumps(snapshot,indent=2)+'\n')
                (stage/'cysts').mkdir()
                copy_cysts(BASE/'data/cysts',stage/'cysts',snapshot['references'])
            finally:
                if proc.poll() is None:
                    try:proc.communicate(b'done\n',timeout=10)
                    except subprocess.TimeoutExpired:proc.kill();proc.communicate()
                assert proc.returncode==0,'Snapshot transaction failed'
            PHASE='configuration_copy'
            (stage/'configuration').mkdir()
            sources={'mainnet.env':PRIVATE/'mainnet.env','expected.json':PRIVATE/'expected.json','activation.json':PRIVATE/'activation.json',
                'ownership.json':PRIVATE/'ownership.json','docker-daemon.json':PRIVATE/'docker-daemon.json',
                'deployment-plan-base-mainnet.json':PRIVATE/'deployment-plan-base-mainnet.json','backup-recipient.txt':PRIVATE/'backup-recipient.txt',
                'source-snapshot.json':BASE/'app/source-snapshot.json','package-lock.json':BASE/'app/package-lock.json',
                'controller.service':Path('/etc/systemd/system/telomere-mainnet-pilot.service'),
                'rpc.service':Path('/etc/systemd/system/telomere-mainnet-rpc.service'),'nginx.conf':Path('/etc/nginx/sites-available/telomere-apex-static'),
                'nginx-csp.conf':Path('/etc/nginx/snippets/telomere-website-csp.conf'),
                'nginx-http-acme.conf':Path('/etc/nginx/sites-available/telomere-http-acme')}
            for name,source in sources.items():assert source.is_file() and not source.is_symlink();shutil.copyfile(source,stage/'configuration'/name)
            for unit in ('telomere-mainnet-postgres.service','telomere-mainnet-docker.service'):
                for line in Path('/etc/systemd/system',unit).read_text().splitlines():
                    if line.startswith('EnvironmentFile='):
                        location=Path(line.split('=',1)[1]);assert location.parent==PRIVATE and location.is_file() and not location.is_symlink()
                        sources['service-'+location.name]=location
            for name,source in sources.items():
                target=stage/'configuration'/name
                if not target.exists():shutil.copyfile(source,target)
            for name in ('telegram-bot-token','cpu-telegram.json','cpu-cloud-config.json','cpu-cloud-required.json'):
                source=PRIVATE/name
                if source.exists():assert source.is_file() and not source.is_symlink();shutil.copyfile(source,stage/'configuration'/name)
            rehearsal=restore(stage,snapshot)
            PHASE='runtime_bundle';runtime=runtime_bundle()
            files=[]
            for path in sorted(stage.rglob('*')):
                if path.is_file():path.chmod(0o600);files.append({'path':path.relative_to(stage).as_posix(),'bytes':path.stat().st_size,'sha256':digest(path)})
            manifest={'schemaVersion':1,'id':identifier,'createdAt':now(),'kind':'mainnet-cpu-encrypted-backup','chainId':8453,'consistentExportedDatabaseSnapshot':True,'restoreRehearsal':rehearsal,'runtimeBundle':runtime,'files':files}
            (stage/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
            archive=stage/'snapshot.tar'
            with tarfile.open(archive,'w') as tar:
                for entry in files:tar.add(stage/entry['path'],arcname=entry['path'],recursive=False)
                tar.add(stage/'manifest.json',arcname='manifest.json')
            output=BACKUPS/(identifier+'.tar.age');temporary=BACKUPS/(identifier+'.partial')
            run(['/usr/bin/age','-R',str(recipient),'-o',str(temporary),str(archive)]);temporary.chmod(0o600);os.replace(temporary,output)
            result={'id':identifier,'createdAt':now(),'sha256':digest(output),'bytes':output.stat().st_size,'encryption':'age X25519','restore':rehearsal,'runtimeBundle':runtime,'elapsedSeconds':round(time.monotonic()-started,3)}
            atomic(PRIVATE/'cpu-backup-status.json',result)
            # Retain 24 hourly snapshots and one older snapshot per day for seven days.
            snapshots=sorted([p for p in BACKUPS.iterdir() if p.is_file() and re.fullmatch(r'backup-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.tar\.age',p.name)],reverse=True)
            keep=set(snapshots[:24]);days=set()
            for path in snapshots[24:]:
                day=path.name[7:15]
                if day not in days and len(days)<7:keep.add(path);days.add(day)
            for path in snapshots:
                if path not in keep:assert path.resolve().parent==BACKUPS;path.unlink()
            print(json.dumps(result))
def ack(identifier,checksum,*runtime):
    assert IDENTIFIER.fullmatch(identifier) and re.fullmatch('[0-9a-f]{64}',checksum)
    path=BACKUPS/(identifier+'.tar.age');assert path.is_file() and not path.is_symlink() and digest(path)==checksum
    latest=json.loads((PRIVATE/'cpu-backup-status.json').read_text());expected=latest.get('runtimeBundle')
    if expected:assert len(runtime)==2 and runtime[0]==expected['id'] and runtime[1]==expected['sha256']
    atomic(PRIVATE/'cpu-offhost-status.json',{'id':identifier,'sha256':checksum,'verifiedAt':now(),'authenticatedDecryptionVerifiedByClient':True,
        'runtimeBundleId':runtime[0] if runtime else None,'runtimeBundleSha256':runtime[1] if runtime else None})
    print(json.dumps({'acknowledged':True}))
def status():print((PRIVATE/'cpu-backup-status.json').read_text())

def read_soak_progress(folder,namespace,expected_uid=995):
    assert re.fullmatch('[0-9a-f]{16}',namespace) and folder.resolve()==folder
    descriptor=os.open(folder/('soak-'+namespace+'.json'),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(descriptor,'rb') as source:
        info=os.fstat(source.fileno())
        assert stat.S_ISREG(info.st_mode) and info.st_uid==expected_uid and info.st_nlink==1 and 0<info.st_size<=16384
        raw=source.read(16385);assert len(raw)<=16384
    return json.loads(raw)
def evaluate_health(observation):
    alerts=[]
    if not observation.get('ready'):alerts.append('CONTROLLER_NOT_READY')
    if not observation.get('databaseAvailable'):alerts.append('DATABASE_UNAVAILABLE')
    if not observation.get('rpc',{}).get('available'):alerts.append('RPC_OR_ASSET_PINS_UNAVAILABLE')
    elif int(observation['rpc']['operatorGasWei'])<20000000000000:alerts.append('OPERATOR_GAS_LOW')
    if observation.get('invalidFinancialRows',0):alerts.append('FINANCIAL_INVARIANT_FAILED')
    archive=observation.get('journalArchive',{})
    if archive.get('supported'):
        if archive.get('latestCheckpointVerified') is not True:alerts.append('SETTLEMENT_ARCHIVE_VERIFICATION_FAILED')
        elif int(archive.get('activeRows',0))>=1500:alerts.append('SETTLEMENT_ARCHIVE_BACKLOG')
    elif observation.get('settlementJournalRows',0)>=1500:alerts.append('SETTLEMENT_HISTORY_REVIEW_DUE')
    for entry in observation.get('states',[]):
        if entry['status']=='reconciliation' and entry['count']:alerts.append('RUN_REQUIRES_RECONCILIATION')
        if entry['status'] in ('settling','receipt_pending') and entry['oldest_seconds']>120:alerts.append('SETTLEMENT_OR_RECEIPT_STALLED')
        if entry['status']=='queued' and entry['oldest_seconds']>300:alerts.append('QUEUE_DELAY_HIGH')
        if entry['status']=='running' and entry['oldest_seconds']>180:alerts.append('CPU_RUN_STALLED')
    if observation.get('backupAgeSeconds',float('inf'))>7200:alerts.append('BACKUP_STALE')
    if observation.get('offhostAgeSeconds',float('inf'))>10800:alerts.append('OFFHOST_BACKUP_STALE')
    if not observation.get('offhostRuntimeValid',True):alerts.append('OFFHOST_RUNTIME_NOT_VERIFIED')
    if observation.get('diskFreeBytes',0)<5*1024**3:alerts.append('DISK_SPACE_LOW')
    if observation.get('tlsRemainingDays',0)<14:alerts.append('TLS_EXPIRY_NEAR')
    if observation.get('cpuSoakState')=='failed':alerts.append('CPU_SOAK_FAILED')
    if observation.get('cpuSoakState')=='invalid':alerts.append('CPU_SOAK_OBSERVATION_INVALID')
    if observation.get('cpuSoakState')=='running' and observation.get('cpuSoakProgressAgeSeconds',float('inf'))>180:alerts.append('CPU_SOAK_STALE')
    return sorted(set(alerts))
def monitor():
    observed={'observedAt':now(),'diskFreeBytes':shutil.disk_usage(BASE).free}
    try:
        with urllib.request.urlopen('http://127.0.0.1:3282/health/ready',timeout=15) as response:observed['ready']=json.load(response).get('status')=='ready'
    except Exception:observed['ready']=False
    try:observed.update(json.loads(run([NODE,str(BASE/'operator/cpu-launch/health.mjs')],cwd=BASE/'app').stdout))
    except Exception:observed['databaseAvailable']=False
    current=datetime.datetime.now(datetime.timezone.utc)
    watch=PRIVATE/'cpu-soak-watch.json'
    if watch.exists():
        try:
            namespace=json.loads(watch.read_text())['namespace'];assert re.fullmatch('[0-9a-f]{16}',namespace)
            folder=BASE/'data/cpu-launch-acceptance-20261017';assert folder.resolve()==folder
            progress=read_soak_progress(folder,namespace);state=progress['state'];assert state in ('running','failed','completed')
            assert progress['mainnetTransactions']==0 and progress['mainnetSignerLoaded'] is False
            if state=='completed':assert progress['errors']==0 and progress['elapsedSeconds']>=progress['targetSeconds'] and progress['requests']>=progress['targetSeconds']*7
            observed.update(cpuSoakState=state,cpuSoakRequests=progress['requests'],cpuSoakRuns=progress['cpuRuns'],cpuSoakElapsedSeconds=progress['elapsedSeconds'],
                cpuSoakTargetSeconds=progress['targetSeconds'],cpuSoakProgressAgeSeconds=max(0,(current-datetime.datetime.fromisoformat(progress['observedAt'].replace('Z','+00:00'))).total_seconds()))
        except Exception:observed['cpuSoakState']='invalid'
    offhost_file='cpu-cloud-offhost-status.json' if (PRIVATE/'cpu-cloud-required.json').is_file() else 'cpu-offhost-status.json'
    observed['offhostSource']='github-actions' if offhost_file=='cpu-cloud-offhost-status.json' else 'windows-additional-copy'
    for name,key,field in [('cpu-backup-status.json','backupAgeSeconds','createdAt'),(offhost_file,'offhostAgeSeconds','verifiedAt')]:
        try:observed[key]=max(0,(current-datetime.datetime.fromisoformat(json.loads((PRIVATE/name).read_text())[field])).total_seconds())
        except Exception:pass
    try:
        backup=json.loads((PRIVATE/'cpu-backup-status.json').read_text());offhost=json.loads((PRIVATE/offhost_file).read_text())
        expected=backup.get('runtimeBundle');observed['offhostRuntimeValid']=not expected or (offhost.get('runtimeBundleId')==expected['id'] and offhost.get('runtimeBundleSha256')==expected['sha256'])
    except Exception:observed['offhostRuntimeValid']=False
    try:
        context=ssl.create_default_context()
        with socket.create_connection(('telomere.sh',443),timeout=8) as raw:
            with context.wrap_socket(raw,server_hostname='telomere.sh') as conn:expires=conn.getpeercert()['notAfter']
        observed['tlsRemainingDays']=(ssl.cert_time_to_seconds(expires)-time.time())/86400
    except Exception:observed['tlsRemainingDays']=0
    observed['alerts']=evaluate_health(observed);observed['status']='ok' if not observed['alerts'] else 'attention'
    atomic(PRIVATE/'cpu-monitor-status.json',observed)
    print(json.dumps(observed))
    if observed['alerts']:raise SystemExit(2)
if __name__=='__main__':
    os.umask(0o077)
    parser=argparse.ArgumentParser();parser.add_argument('command',choices=['backup','status','ack','monitor']);parser.add_argument('arguments',nargs='*');args=parser.parse_args()
    try:
        assert os.geteuid()==0
        if args.command=='backup':assert not args.arguments;backup()
        elif args.command=='status':assert not args.arguments;status()
        elif args.command=='monitor':assert not args.arguments;monitor()
        else:assert len(args.arguments) in (2,4);ack(*args.arguments)
    except Exception as error:
        # SQL, subprocess stderr and protected configuration never enter the journal.
        print(json.dumps({'status':'failed','operation':args.command,'errorType':type(error).__name__,'phase':PHASE}));raise SystemExit(1)
