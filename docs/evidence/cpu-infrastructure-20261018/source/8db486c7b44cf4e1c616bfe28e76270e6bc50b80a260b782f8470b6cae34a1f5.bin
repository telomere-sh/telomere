"""Authenticate a recovery pair and generate an explicit fresh-host install plan.

The only writes are to a new private staging directory. No restored executable,
controller, systemd unit, TLS configuration or DNS change is activated here.
"""
import argparse,hashlib,importlib.util,json,os,platform,re,shutil,subprocess,sys
from pathlib import Path

BASE=Path('/opt/telomere-mainnet-pilot')
def require(condition,message):
    if not condition:raise ValueError(message)
def digest(path):
    value=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):value.update(chunk)
    return value.hexdigest()
def save(path,value):
    with path.open('x',encoding='utf-8') as target:json.dump(value,target,indent=2);target.write('\n')
    path.chmod(0o600)
def host_report(root=Path('/')):
    release={}
    for line in (root/'etc/os-release').read_text().splitlines():
        if '=' in line:
            k,v=line.split('=',1);release[k]=v.strip('"')
    tools={name:shutil.which(name) is not None for name in ('age','docker','dockerd','nginx','certbot','iptables','ip','systemctl','python3')}
    return {'os':release.get('ID'),'version':release.get('VERSION_ID'),'architecture':platform.machine(),
        'freshTelomereTarget':not (root/'opt/telomere-mainnet-pilot').exists(),'cgroupV2':(root/'sys/fs/cgroup/cgroup.controllers').is_file(),
        'freeDiskBytes':shutil.disk_usage(root).free,'requiredTools':tools,'controllerStarted':False}
def validate_pair(data,runtime,receipt,data_dir,runtime_dir):
    require(data.get('kind')=='mainnet-cpu-encrypted-backup' and data.get('chainId')==8453,'Base backup scope')
    require(data.get('id')==receipt['id'],'Snapshot identity')
    bundle=receipt['runtimeBundle']
    require(runtime.get('id')==bundle['id'] and runtime.get('kind')=='exact-reviewed-runtime','Runtime identity')
    require(data.get('runtimeBundle',{}).get('id')==bundle['id'] and data['runtimeBundle']['sha256']==bundle['sha256'],'Snapshot/runtime binding')
    expected=json.loads((data_dir/'configuration/expected.json').read_text())
    release=expected['releaseId'];require(re.fullmatch('[0-9a-f]{40}',release),'Release identity')
    require(expected['releaseDirectory']==(BASE/'releases'/release).as_posix(),'Physical release directory')
    files={entry['path']:entry for entry in runtime['files']}
    require(len(expected['runtimePins'])==bundle['runtimePinsVerified'],'Runtime pin count')
    for pin in expected['runtimePins']:
        name=pin['path'];require(not Path(name).is_absolute() and '..' not in Path(name).parts and '\\' not in name,'Runtime pin path')
        item=files.get('release/'+name);require(item is not None and item['sha256']==pin['sha256'],'Reviewed runtime pin')
        require(digest(runtime_dir/'release'/name)==pin['sha256'],'Runtime bytes')
    snapshot=json.loads((data_dir/'snapshot.json').read_text())
    require(bool(snapshot.get('fingerprints')),'Database fingerprints')
    for table in snapshot['fingerprints']:
        require(re.fullmatch('[a-z][a-z0-9_]*',table['table']) and re.fullmatch('[0-9a-f]{64}',table['sha256']) and type(table['rows']) is int and table['rows']>=0,'Table fingerprint')
    image=data['restoreRehearsal']['databaseImage'];require(re.fullmatch('postgres@sha256:[0-9a-f]{64}',image),'PostgreSQL image digest')
    # Read one public image reference, without evaluating or logging the profile.
    profile=(data_dir/'configuration/mainnet.env').read_text()
    match=re.search(r'^CPU_IMAGE=[\'\"]?([^\s\'\"]+)[\'\"]?$',profile,re.M)
    require(match is not None and re.fullmatch(r'[a-zA-Z0-9_./:-]+@sha256:[0-9a-f]{64}',match[1]),'Pinned CPU image')
    return expected,snapshot,image,match[1]
def install_plan(expected,snapshot,pg_image,cpu_image,stage):
    release=expected['releaseId']
    return {'schemaVersion':1,'kind':'fresh-host-reviewed-install-plan','releaseId':release,'chainId':8453,'asset':'native Base USDC',
        'requiredHost':{'os':'Debian','version':'12','architecture':'x86_64','dockerClient':'29.8.1','uid':995,'gid':993,'minimumFreeDiskBytes':8*1024**3},
        'verifiedStage':str(stage),'imageReferences':[pg_image,cpu_image],
        'placements':[
            {'from':'runtime/release','to':str(BASE/'releases'/release),'owner':'root:root'},
            {'from':'runtime/operator','to':str(BASE/'operator'),'owner':'root:root'},
            {'from':'runtime/binaries/node','to':'/opt/node-v22.23.3-linux-x64/bin/node','mode':'0755'},
            {'from':'runtime/binaries/runsc','to':'/opt/telomere-host-runtime/gvisor/runsc','mode':'0755'},
            {'from':'runtime/website','to':'retained nginx root from verified runtime manifest','owner':'root:root'},
            {'from':'data/configuration','to':str(BASE/'private'),'mode':'0600; directory 0700'},
            {'from':'data/cysts','to':str(BASE/'data/cysts'),'owner':'995:993','mode':'0600; directory 0700'},
            {'from':'runtime/systemd','to':'/etc/systemd/system','state':'keep controller and timers disabled/masked until acceptance'}],
        'database':{'dump':'data/database.dump','tables':len(snapshot['fingerprints']),'rows':sum(x['rows'] for x in snapshot['fingerprints']),
            'firstRestore':'network-none scratch PostgreSQL, compare every table fingerprint; no worker','chainCursorRetained':snapshot.get('chainCursor') is not None},
        'orderedCutoverGates':[
            'Fence the old worker and its signer before any replacement worker can start; record old VPS state.',
            'Prepare host dependencies using bootstrap-clean-host.sh; verify UID/GID availability before creating the account.',
            'Load verified offline image exports or pull both pinned references; compare loaded references and image IDs before use.',
            'Place verified files, recreate app alias, private modes and writable data ownership; restore exact network/daemon configuration.',
            'Install retained units disabled; inspect dependency graph and EnvironmentFile paths; prepare dedicated Docker and gVisor.',
            'Restore database offline and compare all table fingerprints, Cyst ciphertext, original journals and archive checkpoints.',
            'Start read-only recovery audit; reconcile chain cursor, missing reservations, roles, native USDC, balances and signer nonce.',
            'Verify new SSH host key out of band and update restricted export authorized key, hosted known-host pin and server address.',
            'Obtain public TLS certificate for the replacement host, validate nginx configuration and authenticated HTTPS before DNS cutover.',
            'Verify independent backup/decryption/restore and Telegram delivery from the replacement host.',
            'Enable exactly one controller after chain reconciliation; perform owner-approved financial acceptance; then enable timers and switch DNS.'],
        'activationExecuted':False,'dnsChanged':False,'mainnetTransactions':0}
def stage_pair(receipt_file,data_cipher,runtime_cipher,target,identity):
    require(os.name=='posix' and os.geteuid()==0,'Root-only private recovery staging')
    require(target.is_absolute() and not target.exists(),'New absolute staging directory')
    parent=target.parent.resolve();require(parent==target.parent and parent.is_dir(),'Regular staging parent')
    require(parent.stat().st_uid==0 and parent.stat().st_mode&0o022==0,'Root-owned staging parent')
    require(shutil.disk_usage(parent).free>8*1024**3,'Recovery disk reserve')
    require(0<len(identity)<=16384 and b'AGE-SECRET-KEY-' in identity,'Age identity on stdin')
    receipt=json.loads(receipt_file.read_text())
    require(re.fullmatch('backup-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}',receipt['id']),'Snapshot name')
    spec=importlib.util.spec_from_file_location('verified_recovery_unpack',Path(__file__).with_name('restore-rehearsal.py'))
    unpacker=importlib.util.module_from_spec(spec);spec.loader.exec_module(unpacker)
    target.mkdir(mode=0o700)
    try:
        data=unpacker.unpack(data_cipher,receipt['sha256'],identity,target/'data')
        runtime=unpacker.unpack(runtime_cipher,receipt['runtimeBundle']['sha256'],identity,target/'runtime')
        expected,snapshot,pg_image,cpu_image=validate_pair(data,runtime,receipt,target/'data',target/'runtime')
        plan=install_plan(expected,snapshot,pg_image,cpu_image,target);save(target/'install-plan.json',plan)
        result={'passed':True,'releaseId':expected['releaseId'],'verifiedRuntimePins':len(expected['runtimePins']),
            'tables':len(snapshot['fingerprints']),'rows':sum(x['rows'] for x in snapshot['fingerprints']),
            'authenticatedDecryption':True,'fileHashesVerified':True,'installPlanPrepared':True,
            'restoredExecutableRun':False,'controllerStarted':False,'mainnetTransactions':0,'stage':str(target)}
        save(target/'verified-stage.json',result);return result
    except BaseException:
        # Retain only the private failed staging directory for diagnosis. The
        # active application and external paths have never been written.
        save(target/'stage-failed.json',{'passed':False,'controllerStarted':False});raise
def main():
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='mode',required=True)
    pre=sub.add_parser('check-host');pre.add_argument('--require-fresh',action='store_true')
    stage=sub.add_parser('stage');stage.add_argument('--receipt',type=Path,required=True);stage.add_argument('--data',type=Path,required=True)
    stage.add_argument('--runtime',type=Path,required=True);stage.add_argument('--target',type=Path,required=True)
    a=parser.parse_args()
    if a.mode=='check-host':
        result=host_report();result['passed']=result['os']=='debian' and result['version']=='12' and result['architecture']=='x86_64' and result['cgroupV2'] and result['freeDiskBytes']>8*1024**3 and all(result['requiredTools'].values())
        if a.require_fresh:result['passed']=result['passed'] and result['freshTelomereTarget']
        print(json.dumps(result));return 0 if result['passed'] else 2
    identity=sys.stdin.buffer.read(16385)
    try:print(json.dumps(stage_pair(a.receipt,a.data,a.runtime,a.target,identity)));return 0
    finally:identity=b''
if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:print(json.dumps({'passed':False,'operation':'clean-server-recovery','errorType':type(error).__name__}));raise SystemExit(1)
