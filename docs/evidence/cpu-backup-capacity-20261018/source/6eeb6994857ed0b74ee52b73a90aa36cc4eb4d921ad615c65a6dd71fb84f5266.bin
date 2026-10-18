"""Shared, bounded capacity contract for backup producers and consumers."""
import hashlib,json,re,tarfile
from pathlib import PurePosixPath
MIB=1024**2
MAX_DATA_ARCHIVE=1536*MIB
MAX_RUNTIME_ARCHIVE=512*MIB
MAX_CYST_BYTES=1024*MIB
MAX_DUMP_BYTES=256*MIB
MAX_METADATA_BYTES=16*MIB
MAX_DATA_PAYLOAD=1408*MIB
MAX_RUNTIME_PAYLOAD=2048*MIB
MAX_MEMBERS=50000
TRANSFER_SECONDS=600
CRYPTO_SECONDS=600
RESTORE_SECONDS=600
MIN_FREE_BYTES=8*1024**3
BACKUP_ID=re.compile(r'backup-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}')
RUNTIME_ID=re.compile(r'runtime-[0-9a-f]{40}-[0-9a-f]{16}')
def archive_limit(identifier):
    name=identifier.removesuffix('.tar.age')
    if BACKUP_ID.fullmatch(name):return MAX_DATA_ARCHIVE
    if RUNTIME_ID.fullmatch(name):return MAX_RUNTIME_ARCHIVE
    raise ValueError('Unknown archive scope')
def asset_limit(name):
    try:return archive_limit(name)
    except ValueError:return MIB # small owner-recovery envelopes, never data/runtime
def validate_files(files,runtime=False):
    if not isinstance(files,list) or not 1<=len(files)<MAX_MEMBERS:raise ValueError('Archive file-count budget')
    names=set();totals={'cysts':0,'dump':0,'snapshot':0,'configuration':0,'other':0};size=0
    for item in files:
        name=item.get('path');number=item.get('bytes');checksum=item.get('sha256')
        if not isinstance(name,str) or not name or '\\' in name or PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts or str(PurePosixPath(name))!=name or name in names:
            raise ValueError('Unsafe or duplicate manifest path')
        if type(number) is not int or number<0 or not isinstance(checksum,str) or not re.fullmatch('[0-9a-f]{64}',checksum):raise ValueError('Invalid manifest file metadata')
        names.add(name);size+=number
        category='cysts' if name.startswith('cysts/') else 'dump' if name=='database.dump' else 'snapshot' if name=='snapshot.json' else 'configuration' if name.startswith('configuration/') else 'other'
        totals[category]+=number
        if not runtime and category=='cysts' and (not re.fullmatch(r'cysts/[0-9a-f]{64}\.blob',name) or not 17<=number<=2*MIB+16):raise ValueError('Cyst member budget')
    if size>(MAX_RUNTIME_PAYLOAD if runtime else MAX_DATA_PAYLOAD):raise ValueError('Expanded archive budget')
    if not runtime:
        for category,limit in [('cysts',MAX_CYST_BYTES),('dump',MAX_DUMP_BYTES),('snapshot',MAX_METADATA_BYTES),('configuration',MAX_METADATA_BYTES),('other',MAX_METADATA_BYTES)]:
            if totals[category]>limit:raise ValueError('Data member budget: '+category)
    return {'files':len(files),'payloadBytes':size,'cystBytes':totals['cysts'],'dumpBytes':totals['dump'],
        'snapshotBytes':totals['snapshot'],'configurationBytes':totals['configuration']}
def restore_cysts(source,snapshot,directory):
    """Recreate every retained ciphertext; pending uploads may have no blob."""
    references=snapshot.get('references',[])
    if not isinstance(references,list) or len(references)>=MAX_MEMBERS:raise ValueError('Cyst reference count')
    directory.mkdir(mode=0o700)
    members={m.name:m for m in source.getmembers()};seen=set();total=0;pending=0
    for item in references:
        owner=item.get('owner','');checksum=item.get('sha256','');number=item.get('ciphertext_bytes')
        if not re.fullmatch('0x[0-9a-f]{40}',owner) or not re.fullmatch('[0-9a-f]{64}',checksum) or type(number) is not int or not 17<=number<=2*MIB+16 or item.get('state') not in ('ready','pending'):raise ValueError('Invalid Cyst reference')
        name=hashlib.sha256(('telomere-cyst-blob:'+owner+':'+checksum).encode()).hexdigest()+'.blob'
        member=members.get('cysts/'+name)
        if member is None:
            if item['state']!='pending':raise ValueError('Ready Cyst missing from backup')
            pending+=1;continue
        if name in seen:continue
        if not member.isfile() or member.size!=number:raise ValueError('Restored Cyst size')
        total+=number
        if total>MAX_CYST_BYTES:raise ValueError('Restored Cyst budget')
        incoming=source.extractfile(member);digest=hashlib.sha256()
        with (directory/name).open('xb') as outgoing:
            (directory/name).chmod(0o600)
            for part in iter(lambda:incoming.read(1024*1024),b''):digest.update(part);outgoing.write(part)
        if digest.hexdigest()!=checksum:raise ValueError('Restored Cyst checksum')
        seen.add(name)
    actual={m.name for m in source.getmembers() if m.name.startswith('cysts/')}
    if actual!={'cysts/'+name for name in seen}:raise ValueError('Unreferenced Cyst in backup')
    return {'files':len(seen),'bytes':total,'pendingWithoutBlob':pending,'checksumsValid':True}
