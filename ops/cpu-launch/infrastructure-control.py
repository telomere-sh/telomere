"""Bounded tmpfs and temporary authenticated review-domain fixture routing."""
import argparse,hashlib,json,os,re,stat,subprocess,uuid
from pathlib import Path
B=Path('/opt/telomere-mainnet-pilot');P=B/'private'
SITE=Path('/etc/nginx/sites-available/telomere-owner-review')
def run(args):return subprocess.run(args,check=True,capture_output=True,timeout=30)
def atomic(path,raw,mode=0o600):
    temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.next');temporary.write_bytes(raw);temporary.chmod(mode);os.replace(temporary,path)
def digest(raw):return hashlib.sha256(raw).hexdigest()
def read_progress(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as source:
        info=os.fstat(source.fileno());assert stat.S_ISREG(info.st_mode) and info.st_uid==995 and info.st_nlink==1 and info.st_size<2048
        return json.load(source)
def create(namespace):
    directory=B/'rehearsals'/('disk-'+namespace);assert not directory.exists();directory.mkdir(mode=0o700)
    try:run(['mount','-t','tmpfs','-o','size=16m,mode=0700,uid=995,gid=993','tmpfs',str(directory)])
    except BaseException:directory.rmdir();raise
    return {'diskCreated':True,'limitBytes':16777216}
def expose(namespace,work):
    assert re.fullmatch('http-load-[A-Za-z0-9]{6}',work or '')
    progress=read_progress(B/'data/cpu-launch-acceptance-20261017'/work/'https-ready.json')
    assert progress['namespace']==namespace and type(progress['port']) is int and 1024<=progress['port']<=65535
    unit='telomere-cpu-infrastructure-'+namespace+'.service'
    assert run(['systemctl','is-active',unit]).stdout.strip()==b'active'
    original=SITE.read_bytes();assert b'server_name review.telomere.sh;' in original and original.count(b'server {')==1
    assert b'_acceptance/' not in original
    token=uuid.uuid4().hex+uuid.uuid4().hex;prefix='/_acceptance/'+namespace+'/'
    route=f'''\n    location ^~ {prefix} {{
        if ($http_x_telomere_acceptance != "{token}") {{ return 404; }}
        client_max_body_size 192k;
        proxy_pass http://127.0.0.1:{progress['port']}/;
        proxy_http_version 1.1;
        proxy_set_header Host review.telomere.sh;
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For "";
        proxy_set_header Connection "";
        proxy_set_header Authorization "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 20s;
        proxy_cache off;
        access_log off;
        limit_except GET HEAD POST PUT {{ deny all; }}
    }}\n'''.encode()
    updated=original.replace(b'server {',b'server {'+route,1)
    original_file=P/('https-fixture-'+namespace+'.original');atomic(original_file,original)
    access={'namespace':namespace,'baseUrl':'https://review.telomere.sh'+prefix,'origin':'https://review.telomere.sh','token':token,
        'work':work,'siteSha256':digest(updated),'originalSha256':digest(original),'mainnet':False}
    atomic(P/('https-fixture-'+namespace+'.json'),(json.dumps(access)+'\n').encode())
    atomic(SITE,updated,0o644)
    try:run(['/usr/sbin/nginx','-t']);run(['systemctl','reload','nginx'])
    except BaseException:atomic(SITE,original,0o644);run(['/usr/sbin/nginx','-t']);run(['systemctl','reload','nginx']);raise
    # Removing the fixture is independent of this PC and the fixture worker.
    run(['systemd-run','--unit=telomere-https-fixture-expiry-'+namespace,'--on-active=25m',
        '/usr/bin/python3',str(B/'operator/cpu-launch/infrastructure-control.py'),'hide',namespace])
    return {'exposed':True,'namespace':namespace,'baseUrl':access['baseUrl'],'credentialPrinted':False}
def hide(namespace):
    metadata=P/('https-fixture-'+namespace+'.json')
    if not metadata.exists():return {'routePresent':False}
    value=json.loads(metadata.read_text());original_file=P/('https-fixture-'+namespace+'.original');original=original_file.read_bytes()
    assert digest(original)==value['originalSha256']
    current=SITE.read_bytes()
    if digest(current)!=value['originalSha256']:
        assert digest(current)==value['siteSha256'],'Review configuration changed: preserve for reconciliation'
        atomic(SITE,original,0o644);run(['/usr/sbin/nginx','-t']);run(['systemctl','reload','nginx'])
    metadata.unlink();original_file.unlink()
    return {'routeRemoved':True,'originalConfigurationRestored':True}
def cleanup(namespace):
    failure=None
    try:result=hide(namespace)
    except Exception as error:failure=error;result={'routeRequiresReconciliation':True}
    run(['/usr/bin/python3',str(B/'operator/cpu-launch/soak-cleanup.py'),namespace])
    directory=B/'rehearsals'/('disk-'+namespace)
    if directory.exists():
        assert directory.resolve()==directory and not directory.is_symlink()
        check=subprocess.run(['findmnt','-n','-o','FSTYPE','--mountpoint',str(directory)],capture_output=True,timeout=10)
        if check.returncode==0:
            assert check.stdout.strip()==b'tmpfs';run(['umount',str(directory)])
        directory.rmdir()
    if failure:raise failure
    return {**result,'limitedDiskRemoved':True}
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['create','expose','hide','cleanup']);parser.add_argument('namespace');parser.add_argument('work',nargs='?');a=parser.parse_args()
    assert os.geteuid()==0 and re.fullmatch('[0-9a-f]{16}',a.namespace)
    result=expose(a.namespace,a.work) if a.mode=='expose' else globals()[a.mode](a.namespace)
    print(json.dumps(result))
