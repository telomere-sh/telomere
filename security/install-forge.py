"""Checksum-pinned standalone Forge; no npm lifecycle script or global install."""
from pathlib import Path
import hashlib,io,json,os,platform,tarfile,urllib.parse,urllib.request
ROOT=Path(__file__).resolve().parents[1]

def extract_binary(archive,pin):
    if len(archive)>64*1024*1024 or hashlib.sha256(archive).hexdigest()!=pin['sha256']:
        raise ValueError('Forge archive checksum or size')
    with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz')as source:
        members=source.getmembers()
        if sorted(m.name for m in members)!=['package/bin/forge','package/package.json']:
            raise ValueError('Unexpected Forge archive inventory')
        member=source.getmember(pin['member'])
        if not member.isfile()or member.size!=pin['binaryBytes']or member.size>128*1024*1024:
            raise ValueError('Invalid Forge executable')
        with source.extractfile(member)as stream:binary=stream.read(128*1024*1024+1)
    if len(binary)!=pin['binaryBytes']or hashlib.sha256(binary).hexdigest()!=pin['binarySha256']:
        raise ValueError('Forge binary checksum')
    return binary
def install():
    if os.name!='posix'or platform.system()!='Linux'or platform.machine().lower()not in('amd64','x86_64'):
        raise RuntimeError('Pinned Forge acceptance uses Linux x86_64')
    pin=json.loads((ROOT/'security/forge-tools.json').read_text(encoding='utf8'));u=urllib.parse.urlparse(pin['url'])
    if u.scheme!='https'or u.hostname!='registry.npmjs.org'or not u.path.startswith('/@foundry-rs/forge-linux-amd64/'):
        raise ValueError('Unreviewed Forge origin')
    with urllib.request.urlopen(pin['url'],timeout=60)as response:archive=response.read(64*1024*1024+1)
    binary=extract_binary(archive,pin);target=ROOT/'.local/security-bin';target.mkdir(parents=True,exist_ok=True,mode=0o700)
    if target.is_symlink():raise ValueError('Linked Forge destination')
    output=target/'forge';temporary=target/'forge.new'
    if output.is_symlink()or temporary.exists()or temporary.is_symlink():raise ValueError('Unexpected Forge staging destination')
    with temporary.open('xb')as stream:stream.write(binary)
    temporary.chmod(0o755);temporary.replace(output)
    print(json.dumps({'tool':'forge','version':pin['version'],'binarySha256':pin['binarySha256'],'installed':True}))
if __name__=='__main__':install()
