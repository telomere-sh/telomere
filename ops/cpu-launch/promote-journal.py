"""Promote an accepted additive backend release; preserve database and contract review."""
from pathlib import Path
import argparse,fcntl,hashlib,json,os,re,subprocess,time,urllib.request,uuid
BASE=Path('/opt/telomere-mainnet-pilot');PRIVATE=BASE/'private';NODE='/opt/node-v22.23.3-linux-x64/bin/node'
def run(args,**kwargs):return subprocess.run(args,capture_output=True,check=True,timeout=180,**kwargs)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def atomic(path,value):
    temporary=path.with_name(path.name+'.journal-next');temporary.write_text(json.dumps(value,indent=2)+'\n');temporary.chmod(0o600);os.replace(temporary,path)
def alias(target):
    temporary=BASE/('.app-journal-'+uuid.uuid4().hex);temporary.symlink_to(target);os.replace(temporary,BASE/'app')
def ready():
    for attempt in range(60):
        try:
            with urllib.request.urlopen('http://127.0.0.1:3282/health/ready',timeout=2) as response:
                if json.load(response).get('status')=='ready':return
        except Exception:pass
        time.sleep(1)
    raise RuntimeError('New controller readiness deadline')
def main():
    parser=argparse.ArgumentParser();parser.add_argument('candidate');parser.add_argument('release');args=parser.parse_args()
    assert os.geteuid()==0 and re.fullmatch('[0-9a-f]{40}',args.release)
    assert re.fullmatch(r'/opt/telomere-mainnet-pilot/rehearsals/journal-[0-9a-f]{16}',args.candidate)
    candidate=Path(args.candidate);assert candidate.resolve()==candidate and candidate.stat().st_uid==0
    assert json.loads(run([NODE,str(BASE/'operator/preflight-public.mjs'),'--configuration-only']).stdout)['configurationValid']
    expected=json.loads((PRIVATE/'expected.json').read_text());activation=json.loads((PRIVATE/'activation.json').read_text())
    old_release=(BASE/'app').resolve();assert old_release==Path(expected['releaseDirectory'])
    manifest=json.loads((candidate/'journal-candidate.json').read_text());assert manifest['baselineRelease']==expected['releaseId']
    pins={entry['path']:entry['sha256'] for entry in expected['runtimePins']}
    overlay={entry['path']:entry['sha256'] for entry in manifest['candidateOverlayPins']}
    required={prefix+name+extension for prefix,extension in [('src/','.ts'),('dist/src/','.js')]
              for name in ['bridge','store','main','chain/journal-archive','chain/journal-schema']}
    assert set(overlay)==required;pins.update(overlay)
    for name,checksum in pins.items():
        path=candidate/name;assert path.resolve()==path and path.stat().st_uid==0 and not path.stat().st_mode&0o022 and digest(path)==checksum
    # Bind promotion to a successful run from this exact root-owned candidate.
    proof=PRIVATE/('journal-acceptance-'+candidate.name.removeprefix('journal-')+'.json')
    assert proof.resolve()==proof and proof.is_file() and proof.stat().st_uid==0 and proof.stat().st_nlink==1 and proof.stat().st_mode&0o777==0o600
    accepted=json.loads(proof.read_text());assert accepted['candidateDirectory']==str(candidate) and accepted['passed'] is True
    assert accepted['candidateManifestSha256']==digest(candidate/'journal-candidate.json')
    assert accepted['report']['passed'] is True and accepted['report']['archive']['archivedRows']>=2105 and accepted['report']['paidCpuRecovery']['passed'] is True
    target=BASE/'releases'/args.release;assert not target.exists()
    run(['cp','-a',str(candidate),str(target)])
    original_snapshot=target/'source-snapshot.json';baseline=target/'baseline-source-snapshot.json';baseline.write_bytes(original_snapshot.read_bytes())
    snapshot={'schemaVersion':2,'releaseId':args.release,'sourceCommit':args.release,'deploymentSourceCommit':expected['sourceCommit'],
        'baselineReleaseId':expected['releaseId'],'baselineSourceSnapshotSha256':expected['sourceSnapshotSha256'],
        'candidateOverlay':manifest,'contractAndWebsiteUnchanged':True}
    original_snapshot.write_text(json.dumps(snapshot,indent=2)+'\n');original_snapshot.chmod(0o644);baseline.chmod(0o644)
    for name in ['source-snapshot.json','baseline-source-snapshot.json','journal-candidate.json']:pins[name]=digest(target/name)
    reviewed={**expected,'releaseId':args.release,'releaseDirectory':str(target),'sourceSnapshotSha256':digest(original_snapshot),
        'runtimePins':[{'path':name,'sha256':checksum} for name,checksum in sorted(pins.items())]}
    activated={**activation,'releaseId':args.release}
    checkpoint=PRIVATE/('journal-promotion-'+args.release);checkpoint.mkdir(mode=0o700)
    atomic(checkpoint/'expected-before.json',expected);atomic(checkpoint/'activation-before.json',activation)
    changed=False;timers=[];stopped=False
    try:
        for timer in ['telomere-mainnet-backup.timer','telomere-mainnet-monitor.timer']:
            if subprocess.run(['systemctl','is-active','--quiet',timer]).returncode==0:
                run(['systemctl','stop',timer]);timers.append(timer)
        assert subprocess.run(['systemctl','is-active','--quiet','telomere-mainnet-backup.service']).returncode!=0,'Wait for current backup to finish'
        run(['systemctl','stop','telomere-mainnet-pilot.service']);stopped=True
        before=json.loads(run([NODE,str(BASE/'operator/cpu-launch/audit-journal.mjs')]).stdout)
        assert all(row['status'] in ['prepared','completed','failed','cancelled','timed_out','refunded'] for row in before['states'])
        atomic(checkpoint/'financial-before.json',before)
        alias(target);changed=True;atomic(PRIVATE/'expected.json',reviewed);atomic(PRIVATE/'activation.json',activated)
        guard=json.loads(run([NODE,str(BASE/'operator/preflight-public.mjs'),'--configuration-only']).stdout);assert guard['configurationValid']
        archive=json.loads(run([NODE,str(BASE/'operator/cpu-launch/archive-journal.mjs'),'--archive-finalized']).stdout)
        after=json.loads(run([NODE,str(BASE/'operator/cpu-launch/audit-journal.mjs')]).stdout)
        for field in ['journalRows','originalJournalSha256','states','signerNonce','operatorEthWei','ownerUsdcAtomic','escrowUsdcAtomic','ownerAvailableUsdcAtomic']:
            assert before[field]==after[field],field+' changed during archive promotion'
        run(['systemctl','start','telomere-mainnet-pilot.service']);ready()
        result={'passed':True,'releaseId':args.release,'previousReleaseId':expected['releaseId'],'runtimePinsVerified':guard['verifiedRuntimePins'],
            'databasePreserved':True,'originalContractReviewPreserved':True,'websiteUnchanged':True,'financialBefore':before,'financialAfter':after,
            'archive':archive,'controllerReady':True,'mainnetTransactions':0}
        atomic(checkpoint/'result.json',result);print(json.dumps(result))
    except Exception:
        if changed:
            run(['systemctl','stop','telomere-mainnet-pilot.service']);alias(old_release);atomic(PRIVATE/'expected.json',expected);atomic(PRIVATE/'activation.json',activation)
        if stopped:run(['systemctl','start','telomere-mainnet-pilot.service']);ready()
        raise
    finally:
        for timer in timers:run(['systemctl','start',timer])
if __name__=='__main__':
    try:
        with (PRIVATE/'journal-promotion.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);main()
    except Exception as error:print(json.dumps({'passed':False,'operation':'journal-promotion','errorType':type(error).__name__}));raise SystemExit(1)
