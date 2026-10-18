"""Private Windows recovery copy. Identity is protected by the current user's DPAPI.

Uses the official age executable, strict SSH host checking and private local ACLs.
Never prints, uploads or writes an unprotected age identity.
"""
import argparse,ctypes,hashlib,importlib.util,json,os,re,shutil,subprocess,tarfile,tempfile,datetime,time
from pathlib import Path
_policy_path=Path(__file__).parent.parent/'cpu-cloud/archive_policy.py'
if not _policy_path.is_file():_policy_path=Path(__file__).with_name('archive_policy.py')
_spec=importlib.util.spec_from_file_location('offhost_capacity_policy',_policy_path)
policy=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(policy)

SSH=['ssh','-i',str(Path.home()/'.ssh/enclave_pilot_ed25519'),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=12','root@2.27.12.39']
ROOT=Path.home()/'Documents/Telomere-private-backups/mainnet-cpu'
class Blob(ctypes.Structure):
    _fields_=[('size',ctypes.c_ulong),('data',ctypes.POINTER(ctypes.c_ubyte))]
def dpapi(data,decrypt=False):
    assert os.name=='nt'
    raw=ctypes.create_string_buffer(data);source=Blob(len(data),ctypes.cast(raw,ctypes.POINTER(ctypes.c_ubyte)));out=Blob()
    function=ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    if not function(ctypes.byref(source),None,None,None,None,1,ctypes.byref(out)):raise RuntimeError('DPAPI operation failed')
    try:return ctypes.string_at(out.data,out.size)
    finally:
        ctypes.windll.kernel32.LocalFree.argtypes=[ctypes.c_void_p]
        ctypes.windll.kernel32.LocalFree(out.data)
def run(args,**kwargs):
    if os.name=='nt':kwargs.setdefault('creationflags',subprocess.CREATE_NO_WINDOW)
    return subprocess.run(args,check=True,capture_output=True,timeout=600,**kwargs)
def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for part in iter(lambda:f.read(1024*1024),b''):h.update(part)
    return h.hexdigest()
def init():
    assert ROOT.is_dir() and (ROOT/'age-keygen.exe').is_file()
    if (ROOT/'identity.dpapi').exists():return
    key=run([str(ROOT/'age-keygen.exe')]).stdout
    match=re.search(rb'age1[0-9a-z]+',key);assert match
    (ROOT/'identity.dpapi').write_bytes(dpapi(key))
    (ROOT/'recipient.txt').write_text(match[0].decode()+'\n',encoding='ascii')
    print(json.dumps({'initialized':True,'identityProtectedWith':'Windows current-user DPAPI'}))
def verify(archive):
    assert shutil.disk_usage(ROOT).free>policy.MIN_FREE_BYTES
    identity=dpapi((ROOT/'identity.dpapi').read_bytes(),True)
    with tempfile.TemporaryDirectory(prefix='verify-',dir=ROOT) as temp:
        folder=Path(temp).resolve();assert folder.is_relative_to(ROOT.resolve())
        plain=folder/'snapshot.tar'
        run([str(ROOT/'age.exe'),'--decrypt','-i','-','-o',str(plain),str(archive)],input=identity)
        with tarfile.open(plain) as tar:
            members=tar.getmembers();assert len(members)<50000
            assert all(m.isfile() and not Path(m.name).is_absolute() and '..' not in Path(m.name).parts and '\\' not in m.name for m in members)
            assert tar.getmember('manifest.json').size<=policy.MAX_METADATA_BYTES
            manifest=json.load(tar.extractfile('manifest.json'))
            capacity=policy.validate_files(manifest['files'],runtime=bool(policy.RUNTIME_ID.fullmatch(manifest['id'])))
            assert archive.stat().st_size<=policy.archive_limit(manifest['id'])
            indexed={m.name:m for m in members};assert len(indexed)==len(members)
            assert set(indexed)=={'manifest.json'}|{e['path'] for e in manifest['files']}
            for e in manifest['files']:
                member=indexed[e['path']];assert member.size==e['bytes']
                h=hashlib.sha256();f=tar.extractfile(member)
                for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
                assert h.hexdigest()==e['sha256']
    return {'id':manifest['id'],'verifiedFiles':len(manifest['files']),'authenticatedAgeDecryption':True,'manifestChecksumsValid':True,'capacity':capacity}
def pull_unlocked():
    status=json.loads(run(SSH+['python3 /opt/telomere-mainnet-pilot/operator/cpu-launch/mainnet-ops.py status']).stdout)
    name=status['id'];assert re.fullmatch(r'backup-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}',name)
    archive=ROOT/(name+'.tar.age')
    assert shutil.disk_usage(ROOT).free>policy.MIN_FREE_BYTES
    if not archive.exists():
        temporary=archive.with_suffix('.partial')
        run(['scp','-i',str(Path.home()/'.ssh/enclave_pilot_ed25519'),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
            'root@2.27.12.39:/opt/telomere-mainnet-pilot/backups/'+archive.name,str(temporary)])
        assert digest(temporary)==status['sha256'];temporary.replace(archive)
    assert digest(archive)==status['sha256']
    result=verify(archive);assert result['id']==name
    result.update(ciphertextSha256=status['sha256'])
    runtime=status.get('runtimeBundle')
    if runtime:
        assert re.fullmatch(r'runtime-[0-9a-f]{40}-[0-9a-f]{16}',runtime['id'])
        runtime_archive=ROOT/(runtime['id']+'.tar.age');receipt=ROOT/(runtime['id']+'.verified.json')
        if not runtime_archive.exists():
            assert shutil.disk_usage(ROOT).free>max(4*runtime['bytes'],2*1024**3)
            temporary=runtime_archive.with_suffix('.partial')
            run(['scp','-i',str(Path.home()/'.ssh/enclave_pilot_ed25519'),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
                'root@2.27.12.39:/opt/telomere-mainnet-pilot/backups/'+runtime_archive.name,str(temporary)])
            assert digest(temporary)==runtime['sha256'];temporary.replace(runtime_archive)
        assert digest(runtime_archive)==runtime['sha256']
        if not receipt.exists():
            proof=verify(runtime_archive);assert proof['id']==runtime['id']
            receipt.write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
        result['runtimeBundleVerified']=True;result['runtimeFiles']=json.loads(receipt.read_text())['verifiedFiles']
        result['runtimeBundle']={'id':runtime['id'],'sha256':runtime['sha256']}
    run(SSH+['python3 /opt/telomere-mainnet-pilot/operator/cpu-launch/mainnet-ops.py ack '+name+' '+status['sha256']+
        (' '+runtime['id']+' '+runtime['sha256'] if runtime else '')])
    result['verifiedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    (ROOT/'last-verified.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    snapshots=sorted([p for p in ROOT.glob('backup-*.tar.age') if re.fullmatch(r'backup-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.tar\.age',p.name)],reverse=True)
    keep=set(snapshots[:24]);days=set()
    for path in snapshots[24:]:
        day=path.name[7:15]
        if day not in days and len(days)<7:keep.add(path);days.add(day)
    for path in snapshots:
        if path not in keep:assert path.resolve().parent==ROOT.resolve();path.unlink()
    print(json.dumps(result))
def pull():
    kernel=ctypes.windll.kernel32;kernel.CreateMutexW.restype=ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes=[ctypes.c_void_p,ctypes.c_ulong]
    kernel.ReleaseMutex.argtypes=[ctypes.c_void_p];kernel.CloseHandle.argtypes=[ctypes.c_void_p]
    mutex=kernel.CreateMutexW(None,False,'Local\\TelomereMainnetOffhostPull')
    assert mutex
    acquired=False
    try:
        acquired=kernel.WaitForSingleObject(mutex,10000) in (0,128)
        if not acquired:raise TimeoutError('Another backup verification is still active')
        pull_unlocked()
    finally:
        if acquired:kernel.ReleaseMutex(mutex)
        kernel.CloseHandle(mutex)
def watch():
    ctypes.windll.kernel32.CreateMutexW.restype=ctypes.c_void_p
    mutex=ctypes.windll.kernel32.CreateMutexW(None,False,'Local\\TelomereMainnetOffhostBackup')
    if not mutex or ctypes.windll.kernel32.GetLastError()==183:return
    while True:
        try:pull()
        except Exception as error:
            (ROOT/'last-error.json').write_text(json.dumps({'errorType':type(error).__name__,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})+'\n',encoding='utf-8')
        time.sleep(1800)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('command',choices=['init','pull','verify','watch']);parser.add_argument('archive',nargs='?');args=parser.parse_args()
    try:
        if args.command=='init':init()
        elif args.command=='pull':pull()
        elif args.command=='watch':watch()
        else:
            path=Path(args.archive).resolve();assert path.parent==ROOT.resolve();print(json.dumps(verify(path)))
    except Exception as error:
        (ROOT/'last-error.json').write_text(json.dumps({'errorType':type(error).__name__,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})+'\n',encoding='utf-8')
        raise SystemExit(1)
