"""Read exact allowlisted safe JSON proofs. Never read profiles/options/logs/dumps/keys/raw chain."""
from pathlib import Path
import base64
import datetime
import hashlib
import json
import subprocess

HERE = Path(__file__).resolve().parent
REMOTE = r'''
from pathlib import Path
import base64,hashlib,json,re,stat
ROOT=Path('/opt/telomere-pilot/rollout')
PARENT='staging-354fe7af62ea-launch04'
CHILD='staging-354fe7af62ea-final04'
REV='354fe7af62ea6701faafc3b04522abb1b4524d2d'
ARCHIVE='86b5dc9f36dcf841963f0ffa8161023c126f1fae473c94909f5dddae3040fdce'
RUNNER='f9d9b264e9b5b447894ff982239b96c4be2973fe4d94daa23a14d4ed63943d32'
HELPER='43d37c51c7d50a1a9971b444367045a2c7e73b91239418d679460d1fb06176e5'
TABLES={'auth_nonces','auth_sessions','cyst_owners','cysts','jobs','leash_refs','transaction_journal'}
def need(value):
 if not value:raise ValueError('runtime_proof_refused')
def sha(raw):return hashlib.sha256(raw).hexdigest()
def read(path):
 info=path.lstat();need(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and 0<info.st_size<=1048576)
 raw=path.read_bytes();return raw,json.loads(raw)
def hashvalue(value):return isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value)
def hashes(value):need(isinstance(value,dict) and set(value)==TABLES and all(hashvalue(v) for v in value.values()))
def columns(value):
 need(isinstance(value,dict) and set(value)==TABLES)
 for rows in value.values():
  need(isinstance(rows,list) and 0<len(rows)<=64)
  for row in rows:need(set(row)=={'name','type'} and all(isinstance(v,str) and re.fullmatch('[a-z_][a-z0-9_]{0,63}',v) for v in row.values()))
def cyst(value):
 need(set(value)=={'count','bytes','blobSha256','metadataSha256','counterMismatches'})
 need(value['count']==1 and value['bytes']==93 and value['counterMismatches']==0 and hashvalue(value['blobSha256']) and hashvalue(value['metadataSha256']))
def anchor(value):
 need(set(value)=={'number','hash','stateRoot','stateSha256'} and value['number']=='23')
 need(all(isinstance(value[key],str) and re.fullmatch('0x[a-f0-9]{64}',value[key]) for key in ['hash','stateRoot']) and hashvalue(value['stateSha256']))
def acceptance(value,source):
 need(set(value)=={'schemaVersion','status','source','fiveReceiptsVerified','cysts','originalTableHashes','migratedTables',
  'canonicalAnchor','columns','originalColumns','originalCanonicalAnchor','controllerStarted','controllerClosed','isolatedDocker',
  'cpuExecutorOnly','noNewPaidRun','transactionsSent','publicProviderCalls'})
 need(value['schemaVersion']==1 and value['status']=='passed' and value['source']==source and value['fiveReceiptsVerified']==5)
 need(all(value[key] is True for key in ['controllerStarted','controllerClosed','isolatedDocker','noNewPaidRun']))
 need(value['cpuExecutorOnly'] is (source=='latest') and value['transactionsSent']==value['publicProviderCalls']==0)
 need(isinstance(value['migratedTables'],list) and 7<=len(value['migratedTables'])<=128
  and len(set(value['migratedTables']))==len(value['migratedTables']) and TABLES<=set(value['migratedTables'])
  and all(isinstance(v,str) and re.fullmatch('[a-z_][a-z0-9_]{0,63}',v) for v in value['migratedTables']))
 hashes(value['originalTableHashes']);columns(value['columns']);columns(value['originalColumns']);cyst(value['cysts'])
 anchor(value['canonicalAnchor']);need(value['canonicalAnchor']==value['originalCanonicalAnchor'])
def fingerprint(value):
 need(set(value)=={'schemaVersion','status','profileSha256','rawChainSha256','tableHashes','counts','originalColumns','cysts','transactionsSent'})
 need(value['schemaVersion']==1 and value['status']=='stopped_snapshot_fingerprint' and value['transactionsSent']==0)
 need(hashvalue(value['profileSha256']) and hashvalue(value['rawChainSha256']))
 hashes(value['tableHashes']);columns(value['originalColumns']);cyst(value['cysts'])
 need(set(value['counts'])==TABLES and all(type(v)is int and 0<=v<=10000 for v in value['counts'].values()))
 need(value['counts']['jobs']==value['counts']['transaction_journal']==5 and value['counts']['cysts']==1)
def image(value):
 need(set(value)=={'schemaVersion','kind','sourceIndexDigest','selectedManifestDigest','configDigest','platform','orderedDiffIds',
  'orderedLayerDigests','expandedLayerBytes','expandedBytes','archiveSha256','archiveStat','archiveMembers','presentBlobs',
  'allPresentBlobHashesVerified','selectedLayerDiffIdsIndependentlyVerified','missingNonselectedDescriptors',
  'missingDescriptorsFetched','auxiliaryProvenanceClaimsVerified','sourceBefore','sourceAfter','loadedIdentity','result'})
 need(value['schemaVersion']==1 and value['kind']=='bounded_installed_oci_index_to_classic_config_identity'
  and value['result']=='verified_same_installed_cpu_image')
 need(value['sourceIndexDigest']=='sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402')
 need(value['configDigest']=='sha256:7c3b093add7c43400ee83b815ab2cda98794a10045bcf76ce9bb2f89b97cbc5c')
 need(value['platform']=={'os':'linux','architecture':'amd64'} and value['sourceBefore']==value['sourceAfter'])
 for item in [value['sourceBefore'],value['sourceAfter'],value['loadedIdentity']]:
  need(set(item)=={'Id','Architecture','Os','RootFS'} and item['Architecture']=='amd64' and item['Os']=='linux')
  need(set(item['RootFS'])=={'Type','Layers'} and item['RootFS']['Type']=='layers' and item['RootFS']['Layers']==value['orderedDiffIds'])
 need(value['sourceBefore']['Id']==value['sourceIndexDigest'] and value['loadedIdentity']['Id']==value['configDigest'])
 for key in ['sourceIndexDigest','selectedManifestDigest','configDigest']:
  need(isinstance(value[key],str) and re.fullmatch('sha256:[a-f0-9]{64}',value[key]))
 for key,count in [('orderedDiffIds',4),('orderedLayerDigests',4),('missingNonselectedDescriptors',8)]:
  need(isinstance(value[key],list) and len(value[key])==count and all(isinstance(v,str) and re.fullmatch('sha256:[a-f0-9]{64}',v) for v in value[key]))
 need(value['allPresentBlobHashesVerified'] is True and value['selectedLayerDiffIdsIndependentlyVerified'] is True)
 need(value['missingDescriptorsFetched'] is False and value['auxiliaryProvenanceClaimsVerified'] is False)
 need(value['expandedBytes']==169914880 and sum(value['expandedLayerBytes'])==value['expandedBytes'] and len(value['expandedLayerBytes'])==4)
 need(value['archiveMembers']==16 and value['presentBlobs']==11 and hashvalue(value['archiveSha256']))
 need(set(value['archiveStat'])=={'device','inode','bytes','mtimeNs'} and value['archiveStat']['bytes']==61116416)
 need(all(type(v)is int and v>=0 for v in value['archiveStat'].values()))

parent_raw,parent=read(ROOT/PARENT/'state.json');child_raw,child=read(ROOT/CHILD/'state.json')
need(parent['stage']=='activated' and parent['heldStop']['active'] is False and parent['heldStop']['phase']=='activated')
need(child['stage']=='clone_accepted' and child['heldStop']['active'] is True and child['heldStop']['phase']=='fresh_snapshot')
need(parent['finalStateSha256']==sha(child_raw) and parent['finalWork']==str(ROOT/CHILD))
need(child['parentRun']==PARENT and parent['heldStop']['finalRun']==CHILD and parent['heldStop']['intentId']==child['heldStop']['intentId'])
release='/opt/telomere-pilot/releases/'+REV+'-launch04'
proofs=[];parsed={};state_summaries={}
for role,run,raw,state in [('rehearsal',PARENT,parent_raw,parent),('fresh-final',CHILD,child_raw,child)]:
 work=ROOT/run
 need(state['run']==run and state['revision']==REV and state['archiveSha256']==ARCHIVE and state['release']==release)
 need(state['runnerSha256']==RUNNER and state['nodeHelperSha256']==HELPER)
 need(sha((work/'clone-smoke.mjs').read_bytes())==HELPER)
 manifest_raw,manifest=read(work/'source-manifest.json');pins_raw,pins=read(work/'release-pins.json')
 need(sha(manifest_raw)==state['sourceManifestSha256'] and sha(pins_raw)==state['releasePinsSha256'])
 need(manifest['gitRevision']==REV and manifest['archiveSha256']==ARCHIVE and len(manifest['files'])==685)
 need(set(pins)=={'source','runtime'} and len(pins['source'])==685 and len(pins['runtime'])==564)
 selected=['clone/latest-acceptance.json','clone/old-acceptance.json','clone-cleanup.json','image-equivalence.json','snapshot-fingerprint.json']
 if role=='fresh-final':selected.append('preactivation-fingerprint.json')
 for name in selected:
  content,value=read(work/name)
  if name.startswith('clone/'):
   source='latest' if 'latest-'in name else'old';acceptance(value,source)
   need(sha(content)==state['latestReportSha256' if source=='latest' else 'oldReportSha256'])
  elif name=='clone-cleanup.json':
   need(set(value)=={'ownedHelpersStopped','ownedAnvilStopped','ownedDaemonStopped','ownedNamespaceRemoved','ownedPostgresRemoved'} and all(v is True for v in value.values()))
   need(sha(content)==state['cleanupSha256'])
  elif name=='image-equivalence.json':image(value)
  else:fingerprint(value)
  parsed[(role,name)]=value
  proofs.append({'alias':role+'/'+name,'source':str(work/name),'sha256':sha(content),'bytes':len(content),'dataBase64':base64.b64encode(content).decode()})
 latest=parsed[(role,'clone/latest-acceptance.json')];old=parsed[(role,'clone/old-acceptance.json')];snapshot=parsed[(role,'snapshot-fingerprint.json')]
 need(latest['canonicalAnchor']==old['canonicalAnchor'] and latest['originalTableHashes']==old['originalTableHashes']==snapshot['tableHashes'])
 need(latest['cysts']==old['cysts']==snapshot['cysts'])
 state_summaries[role]={'run':run,'rawStateSha256':sha(raw),'rawStateBytes':len(raw),'stage':state['stage'],
  'recordedHeldStopActive':state['heldStop']['active'],'recordedHeldPhase':state['heldStop']['phase'],
  'effectiveHeldStopActive':False,'authoritativeParentStage':parent['stage'],'revision':REV,'archiveSha256':ARCHIVE,
  'release':release,'runnerSha256':RUNNER,'nodeHelperSha256':HELPER,'sourceManifestSha256':state['sourceManifestSha256'],
  'releasePinsSha256':state['releasePinsSha256'],'sourceInputs':685,'compiledRuntimeInputs':564,
  'protectedIdentityCanonicalSha256':sha(json.dumps(state['protectedIdentity'],sort_keys=True,separators=(',',':')).encode()),
  'latestReportSha256':state['latestReportSha256'],'oldReportSha256':state['oldReportSha256'],'cleanupSha256':state['cleanupSha256']}
need(parent['sourceManifestSha256']==child['sourceManifestSha256'] and parent['releasePinsSha256']==child['releasePinsSha256'])
fresh=parsed[('fresh-final','snapshot-fingerprint.json')];pre=parsed[('fresh-final','preactivation-fingerprint.json')]
need(fresh==pre)
pre_bytes=next(item for item in proofs if item['alias']=='fresh-final/preactivation-fingerprint.json')
need(parent['finalFreshFingerprintSha256']==pre_bytes['sha256'])
need(parent['controllerDropin']=='/etc/systemd/system/telomere-staging.service.d/90-telomere-reviewed-release.conf')
need(parent['controllerDropinSha256']==parent['heldStop']['expectedDropinSha256']==sha(Path(parent['controllerDropin']).read_bytes()))
need(sha(Path('/opt/telomere-host-runtime/private-staging-operator-20261015-354fe7af62ea-attempt04/rollout.py').read_bytes())==RUNNER)
need((ROOT/PARENT/'state.json').read_bytes()==parent_raw and (ROOT/CHILD/'state.json').read_bytes()==child_raw)
state_summaries['rehearsal'].update(finalWork=str(ROOT/CHILD),acceptedFinalStateSha256=parent['finalStateSha256'],
 finalFreshFingerprintSha256=parent['finalFreshFingerprintSha256'],controllerDropinSha256=parent['controllerDropinSha256'],
 activatedAt=parent['activatedAt'],maintenanceSeconds=parent['maintenanceSeconds'])
print(json.dumps({'result':'verified_safe_runtime_proofs','proofs':proofs,'stateStatus':state_summaries,
 'freshFullFingerprintExact':True,'allFourActualAcceptanceReportsPassed':True,'originalReceiptCount':5,
 'originalTableCount':7,'cystCount':1,'cystCiphertextBytes':93,'allTenCleanupFlagsTrue':True,
 'childMarkerBoundary':'Child held=true is the exact historical preactivation clone record accepted by parent hash; parent activated/held=false is authoritative.'},sort_keys=True))
'''

result = subprocess.run(['ssh', '-i', 'C:/Users/Administrator/.ssh/enclave_pilot_ed25519',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    'root@2.27.12.39', 'python3', '-'], input=REMOTE.encode(), capture_output=True, timeout=40)
if result.returncode != 0:
    raise SystemExit('safe_runtime_collection_refused')
payload = json.loads(result.stdout)
assert payload['result'] == 'verified_safe_runtime_proofs' and len(payload['proofs']) == 11
entries = []
for item in payload.pop('proofs'):
    path = Path(item['alias'])
    assert not path.is_absolute() and '..' not in path.parts and path.parts[0] in ['rehearsal', 'fresh-final']
    content = base64.b64decode(item.pop('dataBase64'), validate=True)
    assert hashlib.sha256(content).hexdigest() == item['sha256'] and len(content) == item['bytes']
    target = HERE / path
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('xb') as output:
        output.write(content)
    assert target.read_bytes() == content
    item['path'] = target.relative_to(HERE).as_posix()
    entries.append(item)
status_bytes = (json.dumps(payload, indent=2, sort_keys=True) + '\n').encode()
with (HERE / 'sanitized-state-status.json').open('xb') as output:
    output.write(status_bytes)
helper_bytes = Path(__file__).read_bytes()
record = {'schemaVersion': 1, 'kind': 'exact_safe_runtime_proof_retention',
    'collectedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'collector': {'path': Path(__file__).name, 'sha256': hashlib.sha256(helper_bytes).hexdigest(), 'bytes': len(helper_bytes)},
    'files': entries, 'sanitizedStateStatus': {'path': 'sanitized-state-status.json', 'sha256': hashlib.sha256(status_bytes).hexdigest(), 'bytes': len(status_bytes)},
    'verification': {key: payload[key] for key in ['freshFullFingerprintExact', 'allFourActualAcceptanceReportsPassed', 'originalReceiptCount',
        'originalTableCount', 'cystCount', 'cystCiphertextBytes', 'allTenCleanupFlagsTrue', 'childMarkerBoundary']},
    'boundary': {'serverWritesOrPhases': 0, 'rawStateFilesRetained': False, 'privateProfilesOptionsLogsKeysDumpsRawChainOrInventoryNamesRetained': False,
        'exactProofBytesPreserved': True, 'stateStatusIsExplicitlySanitized': True, 'receiptReportsCollectedNotNewReceiptExecution': True,
        'masterOperationReportCreated': False}}
with (HERE / 'source-record.json').open('xb') as output:
    output.write((json.dumps(record, indent=2, sort_keys=True) + '\n').encode())
print(json.dumps({'result': 'retained_verified', 'exactSafeProofs': len(entries), 'freshFingerprintExact': True,
    'authoritativeParentActivatedHeldFalse': True, 'childHistoricalMarkerPreserved': True, 'serverWritesOrPhases': 0}, sort_keys=True))
