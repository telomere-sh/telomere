import collections,hashlib,json,stat
from pathlib import Path
work=Path('/opt/telomere-pilot/rollout/staging-354fe7af62ea-launch03')
def read(path):
    x=path.lstat()
    if not stat.S_ISREG(x.st_mode) or x.st_nlink!=1 or x.st_size>33_554_432: raise RuntimeError('shape')
    data=path.read_bytes();y=path.lstat()
    if (x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns)!=(y.st_dev,y.st_ino,y.st_size,y.st_mtime_ns):raise RuntimeError('changed')
    return json.loads(data),{'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'stableDuringRead':True}
def h(v):return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
state,_=read(work/'state.json');fingerprint,fpmeta=read(work/'snapshot-fingerprint.json');backup=Path(state['backup'])
if not str(backup).startswith(str(work)+'/') or backup.is_symlink():raise RuntimeError('scope')
a,am=read(backup/'chain.json');b,bm=read(Path('/opt/telomere-pilot/data/chain.json'))
known={'accounts','best_block_number','block','blocks','historical_states','transactions'}
if set(a)!=known or set(b)!=known:raise RuntimeError('unreviewed_top_level_fields')
transactionsA=collections.Counter(h(v) for v in a['transactions']);transactionsB=collections.Counter(h(v) for v in b['transactions'])
blocksA=collections.Counter(h(v) for v in a['blocks']);blocksB=collections.Counter(h(v) for v in b['blocks']);added=list((blocksB-blocksA).elements());removed=list((blocksA-blocksB).elements())
extra=next(v for v in b['blocks'] if h(v) in added) if len(added)==1 else None
sameHeight=[v for v in a['blocks'] if extra and v.get('header',{}).get('number')==extra['header']['number']]
def without_timestamp(v):
    copy={**v,'header':dict(v['header'])};del copy['header']['timestamp'];return copy
summary={'readOnly':True,'snapshotFingerprint':fpmeta,'stoppedSnapshotRawChainSha256':fingerprint['rawChainSha256'],'snapshotChain':am,'currentChain':bm,'backupMatchesStoppedFingerprint':am['sha256']==fingerprint['rawChainSha256'],'rawEqual':am['sha256']==bm['sha256'],'topLevelFieldSetExact':True,'topLevelFieldCount':len(known),'completeExactObjects':{key:{'equal':a[key]==b[key],'snapshotValueSha256':h(a[key]),'currentValueSha256':h(b[key])} for key in ['accounts','best_block_number','block','historical_states']},'completeTransactions':{'snapshotEntries':len(a['transactions']),'currentEntries':len(b['transactions']),'duplicatePreservingMultisetEqual':transactionsA==transactionsB,'multisetSha256':h(sorted(transactionsA.elements()))},'completeBlocks':{'snapshotEntries':len(a['blocks']),'currentEntries':len(b['blocks']),'removedEntrySha256':removed,'addedEntrySha256':added,'allOriginalEntriesRetained':not removed},'extraBlockClassification':{'fullBlockEntrySha256':h(extra) if extra else None,'sameHeightOriginalEntries':len(sameHeight),'allFullObjectsMatchExceptHeaderTimestamp':bool(sameHeight) and all(without_timestamp(v)==without_timestamp(extra) for v in sameHeight),'nonTimestampTemplateSha256':h(without_timestamp(extra)) if extra else None,'headerFields':len(extra['header']) if extra else None,'snapshotTimestampValueSha256':sorted(h(v['header']['timestamp']) for v in sameHeight),'currentTimestampValueSha256':h(extra['header']['timestamp']) if extra else None},'equivalenceApproved':False,'recommendedAuthority':'fresh stopped snapshot; validate clone while original remains stopped; activate without intervening old-chain restart; preserve all records and strict preactivation bytes'}
print(json.dumps(summary,sort_keys=True,indent=2))
