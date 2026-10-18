"""Retain the complete gVisor distribution, including STRICT sidecars."""
import sys as _runtime_sys
if _runtime_sys.flags.optimize:
    raise RuntimeError('Telomere recovery tooling requires checked Python; remove -O/-OO and PYTHONOPTIMIZE.')

import hashlib,json,shutil
from pathlib import Path,PurePosixPath

RUNTIME=Path('/opt/telomere-host-runtime/gvisor')

def digest(path):
    checksum=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024**2),b''):checksum.update(chunk)
    return checksum.hexdigest()

def entries(root=RUNTIME):
    assert root.is_dir() and not root.is_symlink()
    result=[]
    for path in sorted(root.rglob('*')):
        assert not path.is_symlink(),'gVisor distribution contains a link'
        if path.is_file():
            assert path.stat().st_mode&0o022==0,'Writable gVisor executable'
            name=path.relative_to(root).as_posix()
            result.append((path,'binaries/runsc' if name=='runsc' else 'binaries/gvisor/'+name))
    names={name for _,name in result}
    assert {'binaries/runsc','binaries/gvisor/gvisor-bin/gvisor_sentry'}<=names,'Incomplete gVisor distribution'
    return result

def install(archive,target=RUNTIME):
    """The caller must authenticate the archive manifest before invoking this."""
    source=archive/'binaries';runsc=source/'runsc';extras=source/'gvisor'
    assert runsc.is_file() and not runsc.is_symlink()
    assert (extras/'gvisor-bin/gvisor_sentry').is_file(),'Required STRICT gVisor sidecar missing'
    candidates=[(runsc,Path('runsc'))]
    for path in sorted(extras.rglob('*')):
        assert not path.is_symlink()
        if path.is_file():candidates.append((path,path.relative_to(extras)))
    for path,name in candidates:
        assert not name.is_absolute() and '..' not in name.parts and name!=Path('manifest.json')
        output=target/name;output.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
        for parent in (output.parent,*output.parent.parents):
            if parent==target.parent:break
            assert not parent.is_symlink();parent.chmod(0o755)
        assert not output.is_symlink();shutil.copyfile(path,output);output.chmod(0o755)
    return len(candidates)

def capture_supplement(target,root=RUNTIME):
    """Public executable repair medium for older backups missing sidecars."""
    assert not target.exists();target.mkdir(mode=0o700)
    files=[]
    for source,name in entries(root):
        output=target/name;output.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        shutil.copyfile(source,output);output.chmod(0o600)
        files.append({'path':name,'bytes':output.stat().st_size,'sha256':digest(output)})
    manifest={'kind':'legacy-gvisor-runtime-supplement','files':files}
    (target/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    return {'manifestSha256':digest(target/'manifest.json'),'files':len(files),'runscSha256':digest(root/'runsc')}

def verify_supplement(target,descriptor,archived_runsc):
    assert digest(target/'manifest.json')==descriptor['manifestSha256']
    manifest=json.loads((target/'manifest.json').read_text());assert manifest['kind']=='legacy-gvisor-runtime-supplement'
    found=set()
    for row in manifest['files']:
        name=PurePosixPath(row['path'])
        assert not name.is_absolute() and '..' not in name.parts and '\\' not in row['path']
        assert row['path'].startswith('binaries/') and row['path'] not in found
        path=target/row['path'];assert path.is_file() and not path.is_symlink()
        assert path.stat().st_size==row['bytes'] and digest(path)==row['sha256'];found.add(row['path'])
    assert len(found)==descriptor['files']
    assert digest(archived_runsc)==descriptor['runscSha256']==digest(target/'binaries/runsc'),'Supplement does not match retained runsc'
    assert {p.relative_to(target).as_posix() for p in target.rglob('*') if p.is_file()}==found|{'manifest.json'}
    assert not any(p.is_symlink() for p in target.rglob('*'))
    return manifest
