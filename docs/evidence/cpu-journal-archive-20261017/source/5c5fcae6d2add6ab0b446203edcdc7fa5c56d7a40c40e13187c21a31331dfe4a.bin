"""Root operator seals a completed exact-candidate acceptance from its unit journal."""
from pathlib import Path
import hashlib,json,os,re,stat,subprocess,sys
BASE=Path('/opt/telomere-mainnet-pilot');assert os.geteuid()==0 and len(sys.argv)==3
unit,candidate=sys.argv[1:]
assert re.fullmatch(r'telomere-cpu-journal-[0-9a-f]{16}',unit)
assert re.fullmatch(r'/opt/telomere-mainnet-pilot/rehearsals/journal-[0-9a-f]{16}',candidate)
root=Path(candidate);assert root.resolve()==root and root.stat().st_uid==0
raw=subprocess.check_output(['journalctl','-u',unit+'.service','--no-pager','-o','json']);assert len(raw)<1024*1024
messages=[]
for line in raw.splitlines():
    entry=json.loads(line)
    try:messages.append(json.loads(entry['MESSAGE']))
    except (ValueError,KeyError,TypeError):pass
result=next(value for value in reversed(messages) if value.get('passed') is True and 'report' in value)
assert any(value.get('serviceResult')=='success' and value.get('cleanupPassed') is True for value in messages)
assert result['mainnetTransactions']==0 and result['mainnetSignerLoaded'] is False and result['history']['settlements']==2105
assert result['archive']['archivedRows']==2105 and result['crashAtomicity']['passed'] is True
assert result['paidCpuRecovery']['passed'] is True and result['paidCpuRecovery']['executions']==1
assert result['reorg']['passed'] is True and result['reorg']['broadcasts']==0 and result['archivedRpcOutage']['broadcasts']==0
path=Path(result['report']);assert re.fullmatch(r'/opt/telomere-mainnet-pilot/data/cpu-launch-acceptance-20261017/journal-[A-Za-z0-9]+/result.json',str(path))
fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
with os.fdopen(fd,'rb') as source:
    metadata=os.fstat(source.fileno());assert stat.S_ISREG(metadata.st_mode) and metadata.st_uid==995 and metadata.st_nlink==1 and 0<metadata.st_size<16384
    data=source.read(16385);assert len(data)<16384
report=json.loads(data);assert report=={key:value for key,value in result.items() if key!='report'}
proof={'passed':True,'candidateDirectory':candidate,'candidateManifestSha256':hashlib.sha256((root/'journal-candidate.json').read_bytes()).hexdigest(),
       'acceptanceSourceSha256':hashlib.sha256((BASE/'operator/cpu-launch/journal-acceptance.mjs').read_bytes()).hexdigest(),
       'unit':unit,'reportSha256':hashlib.sha256(data).hexdigest(),'report':report}
target=BASE/'private'/('journal-acceptance-'+root.name.removeprefix('journal-')+'.json')
fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as output:output.write(json.dumps(proof,indent=2)+'\n')
print(json.dumps({'accepted':True,'candidateDirectory':candidate,'reportSha256':proof['reportSha256'],'rootProof':str(target)}))
