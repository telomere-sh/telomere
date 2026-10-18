"""Start bounded disposable acceptance; passes no production key or database URL."""
from pathlib import Path
import argparse,hashlib,json,os,re,shutil,stat,subprocess,uuid
BASE=Path('/opt/telomere-mainnet-pilot')
def read_https_report(path):
    descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(descriptor,'rb') as source:
        info=os.fstat(source.fileno())
        assert stat.S_ISREG(info.st_mode) and info.st_uid in (0,995) and info.st_nlink==1 and 0<info.st_size<32768
        raw=source.read(32769);assert len(raw)<32768
        return json.loads(raw)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['load','recovery','soak','resilience','journal','journal-soak','journal-stress','infrastructure']);parser.add_argument('--candidate-directory');parser.add_argument('--reuse-https-report');parser.add_argument('--soak-seconds',type=int,default=180,choices=range(301));parser.add_argument('--duration-seconds',type=int,default=43200);parser.add_argument('--session-refresh-seconds',type=int,default=14400);args=parser.parse_args();assert os.geteuid()==0
    candidate=None
    if args.reuse_https_report:
        assert args.mode=='infrastructure' and re.fullmatch(r'/opt/telomere-mainnet-pilot/data/cpu-launch-acceptance-20261017/http-load-[A-Za-z0-9]{6}/https-client-result.json',args.reuse_https_report)
        report=Path(args.reuse_https_report);assert report.resolve()==report
        observed=read_https_report(report);assert observed['passed'] and observed['publicTls'] and re.fullmatch('[0-9a-f]{16}',observed['namespace'])
    # The short fixture follows the identical fault/queue path before the large run.
    # Its size is passed only by the root launcher.
    if args.mode=='journal':
        assert re.fullmatch(r'/opt/telomere-mainnet-pilot/rehearsals/journal-[0-9a-f]{16}',args.candidate_directory or '')
        candidate=Path(args.candidate_directory);assert candidate.resolve()==candidate and candidate.stat().st_uid==0 and not candidate.stat().st_mode&0o022
    else:assert args.candidate_directory is None
    if not 60<=args.duration_seconds<=86400:parser.error('duration must be between 60 and 86400 seconds')
    if not 30<=args.session_refresh_seconds<=14400:parser.error('session refresh must be between 30 and 14400 seconds')
    guard=subprocess.run(['/opt/node-v22.23.3-linux-x64/bin/node',str(BASE/'operator/preflight-public.mjs'),'--configuration-only'],capture_output=True,check=True)
    assert json.loads(guard.stdout)['configurationValid']
    if candidate:
        expected=json.loads((BASE/'private/expected.json').read_text())
        manifest=json.loads((candidate/'journal-candidate.json').read_text());assert manifest['baselineRelease']==expected['releaseId']
        overlays={entry['path']:entry['sha256'] for entry in manifest['candidateOverlayPins']}
        required={prefix+name+extension for prefix,extension in [('src/','.ts'),('dist/src/','.js')]
                  for name in ['bridge','store','main','chain/journal-archive','chain/journal-schema']}
        assert set(overlays)==required
        pins={entry['path']:entry['sha256'] for entry in expected['runtimePins']};pins.update(overlays)
        for name,digest in pins.items():
            path=candidate/name;assert path.resolve()==path and path.is_file() and path.stat().st_uid==0 and not path.stat().st_mode&0o022
            assert hashlib.sha256(path.read_bytes()).hexdigest()==digest
    source="import {parseProfile} from './dist/src/operator/profile.js';import {readFile} from 'node:fs/promises';const e=parseProfile(await readFile('/opt/telomere-mainnet-pilot/private/mainnet.env','utf8'));process.stdout.write(JSON.stringify({image:e.CPU_IMAGE,host:e.DOCKER_HOST}));"
    selected=json.loads(subprocess.check_output(['/opt/node-v22.23.3-linux-x64/bin/node','--input-type=module','-e',source],cwd=BASE/'app'))
    work=BASE/'data/cpu-launch-acceptance-20261017';assert work.stat().st_uid==995
    namespace=uuid.uuid4().hex[:16];name='telomere-cpu-'+args.mode+'-'+namespace
    env={'PATH':'/opt/node-v22.23.3-linux-x64/bin:/usr/bin:/bin','CPU_IMAGE':selected['image'],'DOCKER_HOST':selected['host']}
    if args.reuse_https_report:env['ACCEPTANCE_RETAINED_HTTPS_REPORT']=args.reuse_https_report
    if args.mode in ('load','soak','resilience','journal','journal-soak','journal-stress','infrastructure'):
        folder=BASE/'operator/cpu-launch/bin';folder.mkdir(exist_ok=True,mode=0o755)
        wrapper=folder/('.docker-'+uuid.uuid4().hex)
        shutil.copy2(BASE/'operator/cpu-launch/docker-load.py',wrapper);wrapper.chmod(0o755);os.replace(wrapper,folder/'docker')
        image=subprocess.check_output(['/usr/bin/docker','--host',selected['host'],'inspect','--format','{{.Image}}','telomere-mainnet-postgres']).decode().strip()
        env.update(PATH=str(folder)+':'+env['PATH'],TELOMERE_ACCEPTANCE_NAMESPACE=namespace,ACCEPTANCE_POSTGRES_IMAGE=image,ACCEPTANCE_SOAK_SECONDS=str(args.soak_seconds))
        env.update(ACCEPTANCE_DURATION_SECONDS=str(args.duration_seconds),ACCEPTANCE_SESSION_REFRESH_SECONDS=str(args.session_refresh_seconds),ACCEPTANCE_NAMESPACE=namespace)
        entry=str(BASE/('operator/cpu-launch/'+args.mode+'.mjs'))
        if candidate:env['CANDIDATE_APPLICATION_DIR']=str(candidate);entry=str(BASE/'operator/cpu-launch/journal-acceptance.mjs')
        if args.mode in ('journal-soak','journal-stress','infrastructure'):
            expected=json.loads((BASE/'private/expected.json').read_text());env['ACCEPTANCE_RELEASE_DIR']=expected['releaseDirectory']
            env['ACCEPTANCE_STRESS_HISTORY']='256' if args.mode=='journal-stress' and args.soak_seconds==0 else '10000'
    else:
        env.update(ACCEPTANCE_ANVIL_BINARY=str(BASE/'operator/acceptance-tools/anvil'),ACCEPTANCE_ARTIFACT_DIR=str(BASE/'app/contracts/artifacts'),ACCEPTANCE_WORK_DIR=str(work),ACCEPTANCE_REPORT_PATH=str(work/('recovery-'+namespace+'.json')))
        entry='dist/scripts/recovery-acceptance.js'
    cmd=['systemd-run','--unit='+name,'--uid=telomere-mainnet','--gid=telomere-mainnet','--property=MemoryMax='+('3G' if args.mode=='recovery' else '2G'),
        '--property=CPUQuota=100%','--property=CPUWeight=10','--property=IOWeight=10','--property=TasksMax=256',
        '--property=RuntimeMaxSec='+str(args.duration_seconds+300 if args.mode in ('soak','journal-soak') else 1800 if args.mode in ('resilience','journal','journal-stress','infrastructure') else 600),'--working-directory='+str(candidate or BASE/'app')]
    cmd+=['--setenv='+key+'='+value for key,value in env.items()]
    if args.mode=='infrastructure':
        subprocess.run(['/usr/bin/python3',str(BASE/'operator/cpu-launch/infrastructure-control.py'),'create',namespace],check=True,capture_output=True)
        cmd+=['--property=ExecStopPost=+/usr/bin/python3 '+str(BASE/'operator/cpu-launch/infrastructure-control.py')+' cleanup '+namespace]
    elif args.mode in ('soak','resilience','journal','journal-soak','journal-stress'):cmd+=['--property=ExecStopPost=+/usr/bin/python3 '+str(BASE/'operator/cpu-launch/soak-cleanup.py')+' '+namespace]
    cmd+=['/opt/node-v22.23.3-linux-x64/bin/node',entry]
    try:subprocess.run(cmd,check=True,capture_output=True)
    except BaseException:
        if args.mode=='infrastructure':subprocess.run(['/usr/bin/python3',str(BASE/'operator/cpu-launch/infrastructure-control.py'),'cleanup',namespace],check=True,capture_output=True)
        raise
    print(json.dumps({'started':True,'unit':name,'mode':args.mode,'productionRuntimePinsVerified':True,'productionKeysPassed':False}))
