"""Start or stop only a private, pinned gVisor acceptance daemon.

No package installation, default Docker changes, production socket or registry.
Public runtime binaries have searchable parents for gVisor's unprivileged re-exec.
"""
import argparse,hashlib,json,os,re,shutil,stat,subprocess,tarfile,time,urllib.request
from pathlib import Path,PurePosixPath

PINS=Path(__file__).resolve().parents[2]/'security/gvisor-runtime-pins.json'
def require(value,message):
    if not value:raise ValueError(message)
def digest(path,algorithm='sha256'):
    h=hashlib.new(algorithm)
    with path.open('rb') as stream:
        for data in iter(lambda:stream.read(1024*1024),b''):h.update(data)
    return h.hexdigest()
def locations(identifier):
    require(re.fullmatch(r'[a-z0-9-]{8,48}',identifier),'Fixture identifier')
    prefix='telomere-audit-'+identifier
    return Path('/run')/prefix,Path('/var/tmp')/prefix,Path('/opt')/prefix,'telomere-audit-docker-'+identifier
def execute(args,**options):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=options.pop('timeout',60),**options)
def install_archive(archive,runtime,pins):
    require(digest(archive,'sha512')==pins['archiveSha512'],'Official runtime archive checksum')
    expected={row['path']:row for row in pins['files']};seen=set()
    with tarfile.open(archive,'r:bz2') as tar:
        for member in tar:
            name=member.name.removeprefix('./');p=PurePosixPath(name)
            require(not p.is_absolute() and '..' not in p.parts,'Runtime archive path')
            if member.isdir():continue
            require(member.isfile() and name in expected and name not in seen and member.size==expected[name]['bytes'],'Runtime archive member')
            seen.add(name);out=runtime/name;out.parent.mkdir(parents=True,exist_ok=True);out.parent.chmod(0o755)
            with tar.extractfile(member) as stream,out.open('xb') as target:shutil.copyfileobj(stream,target)
            out.chmod(0o755);require(digest(out)==expected[name]['sha256'],'Runtime member checksum')
    require(seen==set(expected),'Complete runtime required')
def start(identifier,source):
    require(os.geteuid()==0 and os.uname().machine=='x86_64','Linux x86_64 root fixture required')
    pins=json.loads(PINS.read_text());run,root,public,unit=locations(identifier)
    for p in (run,root,public):require(not p.exists() and not p.is_symlink(),'Fixture location already exists')
    os.umask(0o077);run.mkdir(mode=0o700);root.mkdir(mode=0o700);public.mkdir(mode=0o755);public.chmod(0o755)
    runtime=public/'gvisor';runtime.mkdir(mode=0o755);runtime.chmod(0o755)
    if source:
        source=Path(source);require(source.is_absolute() and source.resolve()==source,'Canonical runtime source')
        for row in pins['files']:
            p=source/row['path'];s=p.lstat()
            require(stat.S_ISREG(s.st_mode) and not p.is_symlink() and s.st_uid==0 and s.st_mode&0o022==0
                    and s.st_size==row['bytes'] and digest(p)==row['sha256'],'Source runtime pin mismatch')
            out=runtime/row['path'];out.parent.mkdir(parents=True,exist_ok=True);out.parent.chmod(0o755);shutil.copyfile(p,out);out.chmod(0o755)
    else:
        archive=root/'gvisor.tar.bz2'
        with urllib.request.urlopen(pins['archiveUrl'],timeout=60) as response,archive.open('xb') as out:
            total=0
            while data:=response.read(1024*1024):
                total+=len(data);require(total<=268435456,'Runtime archive bound');out.write(data)
        install_archive(archive,runtime,pins)
    sessions=root/'sessions';sessions.mkdir(mode=0o700)
    config={'hosts':['unix://'+str(run/'docker.sock')],'data-root':str(root/'data'),'exec-root':str(run/'exec'),
            'pidfile':str(run/'dockerd.pid'),'group':'root','iptables':False,'ip6tables':False,'bridge':'none',
            'ip-forward':False,'ip-masq':False,'userland-proxy':False,'storage-driver':'vfs','default-runtime':'runsc',
            'runtimes':{'runsc':{'path':str(runtime/'runsc'),'runtimeArgs':['--platform=systrap']}}}
    config_path=root/'daemon.json';config_path.write_text(json.dumps(config));config_path.chmod(0o600)
    manifest={'version':1,'fixtureId':identifier,'socket':str(run/'docker.sock'),'parent':str(sessions),'dockerRoot':str(root/'data'),
              'image':pins['image'],'runscPath':str(runtime/'runsc'),'runscSha256':next(row['sha256']for row in pins['files']if row['path']=='runsc')}
    path=root/'manifest.json';path.write_text(json.dumps(manifest,indent=2)+'\n');path.chmod(0o600)
    execute(['systemd-run','--unit='+unit,'--property=MemoryMax=3G','--property=CPUQuota=200%',
             shutil.which('dockerd'),'--config-file='+str(config_path)])
    docker=['docker','--host','unix://'+str(run/'docker.sock')];deadline=time.monotonic()+60
    while True:
        try:info=json.loads(execute(docker+['info','--format','{{json .DockerRootDir}}']).stdout);break
        except (subprocess.CalledProcessError,FileNotFoundError):
            require(time.monotonic()<deadline,'Isolated daemon startup deadline');time.sleep(.25)
    require(info==str(root/'data'),'Actual daemon data root');(run/'docker.sock').chmod(0o600)
    try:
        with (root/'image-pull.log').open('w') as log:subprocess.run(docker+['pull',pins['image']],check=True,stdout=log,stderr=subprocess.STDOUT,timeout=600)
    except BaseException:
        execute(['systemctl','stop',unit]);raise
    print(json.dumps({'manifest':str(path),'unit':unit,'productionChanged':False}))
def stop(identifier):
    run,root,public,unit=locations(identifier);manifest=root/'manifest.json'
    require(root.resolve()==root and not root.is_symlink() and manifest.is_file(),'Owned fixture marker required')
    p=json.loads(manifest.read_text());require(p['fixtureId']==identifier and p['socket']==str(run/'docker.sock')and p['dockerRoot']==str(root/'data'),'Owned namespace')
    docker=['docker','--host','unix://'+p['socket']]
    require(json.loads(execute(docker+['info','--format','{{json .DockerRootDir}}']).stdout)==p['dockerRoot'],'Actual owned daemon')
    ids=execute(docker+['ps','-aq','--no-trunc']).stdout.split();require(all(re.fullmatch('[a-f0-9]{64}',x)for x in ids)and len(ids)<1024,'Owned container inventory')
    if ids:execute(docker+['rm','-f',*ids])
    execute(['systemctl','stop',unit]);print(json.dumps({'stopped':unit,'ownedContainersRemoved':len(ids),'dataPreserved':True}))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['start','stop']);parser.add_argument('fixture_id');parser.add_argument('--runtime-source')
    args=parser.parse_args()
    if args.action=='start':start(args.fixture_id,args.runtime_source)
    else:stop(args.fixture_id)
