"""Root-only, bounded rollout of a tested snapshot. Run with archive and its SHA-256.

Preserves the reviewed contract, signer, deployment transaction and infrastructure.
Refuses non-idle rollout. Backups are root-only and a failed rollout restores all
application/profile/proxy/activation pins, leaving additive database tables intact.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

BASE = Path('/opt/telomere-mainnet-pilot')
PRIVATE = BASE / 'private'
NODE = '/opt/node-v22.23.3-linux-x64/bin/node'
UNIT = Path('/etc/systemd/system/telomere-mainnet-pilot.service')
VHOST = Path('/etc/nginx/sites-available/telomere-apex-static')
SERVICE = 'telomere-mainnet-pilot.service'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs)

def atomic(path, data, mode=0o600):
    temporary = path.with_name(path.name + '.public-next')
    assert not temporary.exists()
    temporary.write_bytes(data)
    temporary.chmod(mode)
    os.replace(temporary, path)

def ready(url):
    with urllib.request.urlopen(url, timeout=15) as response:
        return json.load(response)

def main():
    assert os.geteuid() == 0 and len(sys.argv) == 3
    archive = Path(sys.argv[1]).resolve()
    assert archive.is_file() and not archive.is_symlink() and digest(archive) == sys.argv[2]
    old_expected = json.loads((PRIVATE / 'expected.json').read_bytes())
    assert old_expected['schemaVersion'] == 1, 'Use a newly reviewed update for an already public installation'
    assert digest(PRIVATE / 'mainnet.env') == 'f53cec74742e3ca7eb8eda806ffb00468d992e1b4d6dd421010782ea63fa5f0e'
    assert digest(VHOST) == '50749e33b4219e260fa28c99376b4168cc31ddf99ec03d742628af0e1d0cbb2c'
    assert ready('http://127.0.0.1:3282/health/ready').get('worker') == 'idle', 'Wait until worker is idle'
    assert shutil.disk_usage(BASE).free > 2 * 1024**3
    destination = Path(tempfile.mkdtemp(prefix='public-wallet-20261017-', dir=BASE/'work'))
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        assert 0 < len(members) < 4096 and sum(m.size for m in members) < 256 * 1024**2
        for member in members:
            path = Path(member.name)
            assert not path.is_absolute() and '..' not in path.parts and not member.issym() and not member.islnk()
            assert member.isfile() or member.isdir()
        # Every member and the empty root were checked above; no links or devices.
        tar.extractall(destination)
    payload = destination / 'payload'
    snapshot_digest = digest(payload / 'source-snapshot.json')
    release_id = snapshot_digest[:40]
    release = BASE / 'releases' / release_id
    assert not release.exists()
    expected_files = json.loads((payload / 'runtime-files.json').read_bytes())
    assert len(expected_files) < 4096
    for item in expected_files:
        path = (payload / item['path']).resolve()
        assert path.is_relative_to(payload) and digest(path) == item['sha256']
    assert digest(payload / 'ops/preflight-public.mjs') == json.loads((payload / 'release.json').read_bytes())['guardSha256']
    release.mkdir(mode=0o755)
    for name in ['dist', 'contracts']:
        shutil.copytree(payload / name, release / name)
    for name in ['package.json', 'package-lock.json', 'source-snapshot.json']:
        shutil.copyfile(payload / name, release / name)
    shutil.copytree(BASE / 'app/node_modules', release / 'node_modules', symlinks=True)
    # Runtime pin validation rejects dependency links escaping this release. npm's
    # executable .bin links are not imported by the production Node entry point.
    pins = []
    for path in sorted(release.rglob('*')):
        if path.is_file() and not path.is_symlink():
            relative = path.relative_to(release).as_posix()
            if relative.startswith('node_modules/') and relative not in {p['path'] for p in old_expected['runtimePins'] if p['path'].startswith('node_modules/')}:
                continue
            pins.append({'path':relative,'sha256':digest(path)})
    assert len(pins) < 4096
    for path in release.rglob('*'):
        if not path.is_symlink():
            path.chmod(0o755 if path.is_dir() else 0o644)
    webroot = Path('/var/www/telomere-public') / ('public-wallet-' + release_id)
    assert not webroot.exists()
    shutil.copytree(release / 'dist/website', webroot)
    webroot.chmod(0o755)
    for path in webroot.rglob('*'):
        assert not path.is_symlink()
        path.chmod(0o755 if path.is_dir() else 0o644)
    profile = (PRIVATE / 'mainnet.env').read_text()
    assert not any(line.startswith(('WALLET_ACCESS=', 'TRUST_LOOPBACK_PROXY=', 'CYSTS_GLOBAL_BYTES=')) for line in profile.splitlines())
    profile += '\nWALLET_ACCESS=public\nTRUST_LOOPBACK_PROXY=true\nCYSTS_GLOBAL_BYTES=1073741824\n'
    expected = dict(old_expected, schemaVersion=2, releaseId=release_id, releaseDirectory=str(release),
                    sourceSnapshotSha256=snapshot_digest, walletAccess='public',
                    runtimePins=pins, profileSha256=hashlib.sha256(profile.encode()).hexdigest())
    activation = json.loads((PRIVATE / 'activation.json').read_bytes())
    activation.update(releaseId=release_id, publicWalletAccessAuthorized=True, profileSha256=expected['profileSha256'])
    backup = PRIVATE / ('before-public-wallet-' + time.strftime('%Y%m%dT%H%M%SZ',time.gmtime()))
    backup.mkdir(mode=0o700)
    originals = [PRIVATE/'expected.json', PRIVATE/'mainnet.env', PRIVATE/'activation.json', UNIT, VHOST]
    for path in originals:
        shutil.copy2(path, backup / path.name)
        (backup / path.name).chmod(0o600)
    (backup / 'old-release.txt').write_text(os.readlink(BASE / 'app'))
    with (backup / 'database.dump').open('wb') as output:
        result = subprocess.run(['/usr/bin/docker','--host','unix:///run/telomere-mainnet-docker/docker.sock','exec',
            'telomere-mainnet-postgres','sh','-c','PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -p 15435 -U "$POSTGRES_USER" -d telomere_mainnet -Fc'],stdout=output,stderr=subprocess.PIPE)
        assert result.returncode == 0 and output.tell() > 0, 'Database backup failed'
    (backup / 'database.dump').chmod(0o600)
    guard = BASE / 'operator/preflight-public.mjs'
    assert not guard.exists()
    shutil.copyfile(payload / 'ops/preflight-public.mjs', guard)
    guard.chmod(0o644)
    unit = UNIT.read_text().replace('closed Base mainnet pilot, owner activation required','public Base USDC controller, verified activation required')
    unit = unit.replace('operator/preflight.mjs','operator/preflight-public.mjs').replace('Restart=no','Restart=on-failure\nRestartSec=10')
    unit += '\n[Install]\nWantedBy=multi-user.target\n'
    vhost = VHOST.read_text().replace('root /var/www/telomere-public/20261015-social-859669b4;', 'root ' + str(webroot) + ';')
    old_target = os.readlink(BASE/'app')
    changed = False
    try:
        run('systemctl','stop',SERVICE)
        changed = True
        ddl = (payload/'ops/migration.sql').read_bytes()
        run('/usr/bin/docker','--host','unix:///run/telomere-mainnet-docker/docker.sock','exec','-i',
            'telomere-mainnet-postgres','sh','-c',
            'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -p 15435 -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d telomere_mainnet',input=ddl)
        for path,data in [(PRIVATE/'mainnet.env',profile.encode()),(PRIVATE/'expected.json',(json.dumps(expected,indent=2)+'\n').encode()),(PRIVATE/'activation.json',(json.dumps(activation,indent=2)+'\n').encode())]:
            atomic(path,data)
        alias = BASE/'app-public-next';alias.symlink_to(release);os.replace(alias,BASE/'app')
        atomic(UNIT,unit.encode(),0o644)
        run('systemctl','daemon-reload')
        run(NODE,str(guard),'--configuration-only')
        run('systemctl','start',SERVICE)
        for attempt in range(30):
            try:
                if ready('http://127.0.0.1:3282/health/ready').get('status') == 'ready': break
            except Exception: pass
            time.sleep(1)
        else: raise RuntimeError('Updated controller not ready')
        assert ready('http://127.0.0.1:3282/api/config')['walletAccess'] == 'public'
        atomic(VHOST,vhost.encode(),0o644);run('nginx','-t');run('systemctl','reload','nginx')
        for attempt in range(20):
            try:
                body=urllib.request.urlopen('https://telomere.sh/dashboard.js',timeout=15).read()
                if hashlib.sha256(body).hexdigest() == digest(release/'dist/website/dashboard.js'):break
            except Exception:pass
            time.sleep(1)
        else:raise RuntimeError('Public static release did not become ready')
        assert ready('https://telomere.sh/health/ready')['status'] == 'ready'
        run('systemctl','enable',SERVICE)
        result={'releaseId':release_id,'sourceSnapshotSha256':snapshot_digest,'runtimePins':len(pins),
            'publicWalletAccess':True,'ready':True,'backup':str(backup),'transactionsSignedByInstaller':0}
        atomic(destination/'result.json',(json.dumps(result,indent=2)+'\n').encode())
        print(json.dumps(result))
    except Exception:
        if changed:
            subprocess.run(['systemctl','stop',SERVICE],capture_output=True)
            for path in originals: atomic(path,(backup/path.name).read_bytes(),0o644 if path in [UNIT,VHOST] else 0o600)
            alias=BASE/'app-public-rollback';alias.symlink_to(old_target);os.replace(alias,BASE/'app')
            subprocess.run(['systemctl','daemon-reload'],capture_output=True)
            subprocess.run(['nginx','-t'],check=True,capture_output=True)
            subprocess.run(['systemctl','reload','nginx'],check=True,capture_output=True)
            subprocess.run(['systemctl','start',SERVICE],check=True,capture_output=True)
        raise

if __name__ == '__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'status':'rollout_refused_or_rolled_back','errorType':type(error).__name__}),file=sys.stderr)
        sys.exit(1)
