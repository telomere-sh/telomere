"""Root-only rehearsal clone; never edits the active alias, profile or database."""
import sys as _runtime_sys
if _runtime_sys.flags.optimize:
    raise RuntimeError('Telomere recovery tooling requires checked Python; remove -O/-OO and PYTHONOPTIMIZE.')

from pathlib import Path
import hashlib,json,os,subprocess,sys,tarfile
BASE=Path('/opt/telomere-mainnet-pilot')
FILES={prefix+name+extension for prefix,extension in [('src/','.ts'),('dist/src/','.js')]
       for name in ['bridge','store','main','chain/journal-archive','chain/journal-schema']}
assert os.geteuid()==0 and len(sys.argv)==2
archive=Path(sys.argv[1]);assert archive.parent==Path('/root') and archive.is_file() and not archive.is_symlink() and archive.stat().st_uid==0
guard=json.loads(subprocess.check_output(['/opt/node-v22.23.3-linux-x64/bin/node',str(BASE/'operator/preflight-public.mjs'),'--configuration-only']))
assert guard['configurationValid']
payload={}
with tarfile.open(archive,'r:gz') as bundle:
    for member in bundle:
        assert member.isfile() and member.name in FILES and member.name not in payload and 0<member.size<1000000
        payload[member.name]=bundle.extractfile(member).read()
assert set(payload)==FILES
pins=[{'path':path,'sha256':hashlib.sha256(data).hexdigest()} for path,data in sorted(payload.items())]
identifier=hashlib.sha256(b'v2'+json.dumps(pins,sort_keys=True).encode()).hexdigest()[:16]
target=BASE/'rehearsals'/('journal-'+identifier)
target.parent.mkdir(exist_ok=True,mode=0o755)
assert target.parent.resolve()==target.parent and target.parent.stat().st_uid==0
assert not target.exists()
source=(BASE/'app').resolve();assert source.parent==BASE/'releases'
subprocess.run(['cp','-a',str(source),str(target)],check=True)
for path,data in payload.items():
    destination=target/path;assert destination.resolve()==destination and destination.is_relative_to(target)
    destination.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
    destination.write_bytes(data);destination.chmod(0o644)
manifest={'baselineRelease':source.name,'candidateOverlayPins':pins,'productionAliasUnchanged':True,'productionDatabaseOpened':False}
(target/'journal-candidate.json').write_text(json.dumps(manifest,indent=2)+'\n')
(target/'journal-candidate.json').chmod(0o644)
for pin in pins:assert hashlib.sha256((target/pin['path']).read_bytes()).hexdigest()==pin['sha256']
print(json.dumps({'candidateDirectory':str(target),**manifest}))
