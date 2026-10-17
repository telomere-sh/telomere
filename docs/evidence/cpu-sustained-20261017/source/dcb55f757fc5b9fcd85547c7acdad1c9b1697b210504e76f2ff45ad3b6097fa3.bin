"""Start bounded disposable acceptance; passes no production key or database URL."""
from pathlib import Path
import argparse,json,os,shutil,subprocess,uuid
BASE=Path('/opt/telomere-mainnet-pilot')
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['load','recovery','soak']);parser.add_argument('--soak-seconds',type=int,default=180,choices=range(301));parser.add_argument('--duration-seconds',type=int,default=43200);parser.add_argument('--session-refresh-seconds',type=int,default=14400);args=parser.parse_args();assert os.geteuid()==0
    if not 60<=args.duration_seconds<=86400:parser.error('duration must be between 60 and 86400 seconds')
    if not 30<=args.session_refresh_seconds<=14400:parser.error('session refresh must be between 30 and 14400 seconds')
    guard=subprocess.run(['/opt/node-v22.23.3-linux-x64/bin/node',str(BASE/'operator/preflight-public.mjs'),'--configuration-only'],capture_output=True,check=True)
    assert json.loads(guard.stdout)['configurationValid']
    source="import {parseProfile} from './dist/src/operator/profile.js';import {readFile} from 'node:fs/promises';const e=parseProfile(await readFile('/opt/telomere-mainnet-pilot/private/mainnet.env','utf8'));process.stdout.write(JSON.stringify({image:e.CPU_IMAGE,host:e.DOCKER_HOST}));"
    selected=json.loads(subprocess.check_output(['/opt/node-v22.23.3-linux-x64/bin/node','--input-type=module','-e',source],cwd=BASE/'app'))
    work=BASE/'data/cpu-launch-acceptance-20261017';assert work.stat().st_uid==995
    namespace=uuid.uuid4().hex[:16];name='telomere-cpu-'+args.mode+'-'+namespace
    env={'PATH':'/opt/node-v22.23.3-linux-x64/bin:/usr/bin:/bin','CPU_IMAGE':selected['image'],'DOCKER_HOST':selected['host']}
    if args.mode in ('load','soak'):
        folder=BASE/'operator/cpu-launch/bin';folder.mkdir(exist_ok=True,mode=0o755)
        shutil.copy2(BASE/'operator/cpu-launch/docker-load.py',folder/'docker');(folder/'docker').chmod(0o755)
        image=subprocess.check_output(['/usr/bin/docker','--host',selected['host'],'inspect','--format','{{.Image}}','telomere-mainnet-postgres']).decode().strip()
        env.update(PATH=str(folder)+':'+env['PATH'],TELOMERE_ACCEPTANCE_NAMESPACE=namespace,ACCEPTANCE_POSTGRES_IMAGE=image,ACCEPTANCE_SOAK_SECONDS=str(args.soak_seconds))
        env.update(ACCEPTANCE_DURATION_SECONDS=str(args.duration_seconds),ACCEPTANCE_SESSION_REFRESH_SECONDS=str(args.session_refresh_seconds),ACCEPTANCE_NAMESPACE=namespace)
        entry=str(BASE/('operator/cpu-launch/soak.mjs' if args.mode=='soak' else 'operator/cpu-launch/load.mjs'))
    else:
        env.update(ACCEPTANCE_ANVIL_BINARY=str(BASE/'operator/acceptance-tools/anvil'),ACCEPTANCE_ARTIFACT_DIR=str(BASE/'app/contracts/artifacts'),ACCEPTANCE_WORK_DIR=str(work),ACCEPTANCE_REPORT_PATH=str(work/('recovery-'+namespace+'.json')))
        entry='dist/scripts/recovery-acceptance.js'
    cmd=['systemd-run','--unit='+name,'--uid=telomere-mainnet','--gid=telomere-mainnet','--property=MemoryMax='+('3G' if args.mode=='recovery' else '2G'),
        '--property=CPUQuota=100%','--property=CPUWeight=10','--property=IOWeight=10','--property=TasksMax=256',
        '--property=RuntimeMaxSec='+str(args.duration_seconds+300 if args.mode=='soak' else 600),'--working-directory='+str(BASE/'app')]
    cmd+=['--setenv='+key+'='+value for key,value in env.items()]
    if args.mode=='soak':cmd+=['--property=ExecStopPost=+/usr/bin/python3 '+str(BASE/'operator/cpu-launch/soak-cleanup.py')+' '+namespace]
    cmd+=['/opt/node-v22.23.3-linux-x64/bin/node',entry]
    subprocess.run(cmd,check=True,capture_output=True)
    print(json.dumps({'started':True,'unit':name,'mode':args.mode,'productionRuntimePinsVerified':True,'productionKeysPassed':False}))
