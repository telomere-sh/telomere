"""Guarded configuration-only move of the existing Base/USDC deployment.

Run prepare, issue the certificate using the existing ACME account, then activate.
Application release, contracts, signer, balances and deferred features stay pinned.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path

BASE = Path('/opt/telomere-mainnet-pilot')
PRIVATE = BASE / 'private'
SITES = Path('/etc/nginx/sites-available')
ENABLED = Path('/etc/nginx/sites-enabled')
OLD = 'telomere.sh'
NEW = 'my-telomere.com'
NODE = '/opt/node-v22.23.3-linux-x64/bin/node'
SERVICE = 'telomere-mainnet-pilot.service'
DOMAIN_HOME = BASE / 'operator/domain-migration'
DROPIN = Path('/etc/systemd/system/telomere-mainnet-monitor.service.d/primary-domain.conf')


def run(arguments, **kwargs):
    result = subprocess.run(arguments, capture_output=True, timeout=180, **kwargs)
    if result.returncode:
        # Subcommands may handle private configuration: never print their output.
        raise RuntimeError('Command failed: ' + Path(arguments[0]).name + ' (private output suppressed)')
    return result.stdout


def atomic(path, data, mode=0o600):
    temporary = path.with_name(path.name + '.migration-' + uuid.uuid4().hex)
    try:
        temporary.write_bytes(data)
        temporary.chmod(mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def encode(value):
    return (json.dumps(value, indent=2) + '\n').encode()


def origin_profile(profile, expected, activation):
    assert profile.count(('PUBLIC_ORIGIN=https://' + OLD).encode()) == 1
    updated, count = re.subn(rb'(?m)^PUBLIC_ORIGIN=https://telomere\.sh\r?$', b'PUBLIC_ORIGIN=https://my-telomere.com', profile)
    assert count == 1 and expected['publicOrigin'] == 'https://' + OLD
    assert hashlib.sha256(profile).hexdigest() == expected['profileSha256'] == activation['profileSha256']
    new_expected, new_activation = dict(expected), dict(activation)
    digest = hashlib.sha256(updated).hexdigest()
    new_expected.update(publicOrigin='https://' + NEW, profileSha256=digest)
    new_activation['profileSha256'] = digest
    return updated, new_expected, new_activation


def http_server():
    return '''server {
    listen 80;
    listen [::]:80;
    server_name my-telomere.com www.my-telomere.com;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/telomere-acme;
        default_type text/plain;
        try_files $uri =404;
    }
    location / { return 308 https://my-telomere.com$request_uri; }
}
'''


def https_server(original):
    assert original.count('server_name telomere.sh;') == 1
    assert original.count('/etc/letsencrypt/live/review.telomere.sh/') == 2
    updated = original.replace('server_name telomere.sh;', 'server_name my-telomere.com;').replace(
        '/etc/letsencrypt/live/review.telomere.sh/', '/etc/letsencrypt/live/my-telomere.com/')
    return updated + '''
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name www.my-telomere.com;
    ssl_certificate /etc/letsencrypt/live/my-telomere.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/my-telomere.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    return 308 https://my-telomere.com$request_uri;
}
'''


def legacy_redirect():
    # No unsafe-method redirect: stale tabs must sign in on the new origin.
    return '''server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name telomere.sh;
    ssl_certificate /etc/letsencrypt/live/review.telomere.sh/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/review.telomere.sh/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Cache-Control no-store always;
    add_header Referrer-Policy no-referrer always;
    if ($request_method !~ ^(GET|HEAD)$) { return 409; }
    return 308 https://my-telomere.com$request_uri;
}
'''


def json_get(origin, path):
    with urllib.request.urlopen(origin + path, timeout=20) as response:
        assert response.geturl() == origin + path
        return json.load(response)


def ready():
    for _ in range(60):
        try:
            if json_get('http://127.0.0.1:3282', '/health/ready')['status'] == 'ready':
                return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('Controller readiness timeout')


def https_ready(expected_version):
    # nginx reload is asynchronous. New workers must present the new certificate
    # before the old domain is redirected. Every attempt verifies trusted TLS.
    for _ in range(30):
        try:
            assert json_get('https://' + NEW, '/health/ready')['status'] == 'ready'
            assert json_get('https://' + NEW, '/api/version') == expected_version
            return
        except Exception:
            time.sleep(1)
    raise RuntimeError('New primary HTTPS origin did not become ready')


def prepare():
    path = SITES / 'telomere-primary-domain'
    assert not path.exists() and not (ENABLED / path.name).exists()
    atomic(path, http_server().encode(), 0o644)
    (ENABLED / path.name).symlink_to(path)
    try:
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])
    except Exception:
        (ENABLED / path.name).unlink()
        path.unlink()
        raise
    print(json.dumps({'prepared': True, 'origin': 'https://' + NEW, 'applicationChanged': False}))


def audit():
    return json.loads(run([NODE, str(BASE / 'operator/cpu-launch/audit-journal.mjs')]))


def activate():
    assert Path('/etc/letsencrypt/live/my-telomere.com/fullchain.pem').exists()
    assert not DROPIN.exists() and not DOMAIN_HOME.exists()
    assert json_get('http://127.0.0.1:3282', '/health/ready')['worker'] == 'idle'
    before_version = json_get('http://127.0.0.1:3282', '/api/version')
    assert json.loads(run([NODE, str(BASE / 'operator/preflight-public.mjs'), '--configuration-only']))['configurationValid']
    profile_path, expected_path, activation_path = [PRIVATE / name for name in ['mainnet.env', 'expected.json', 'activation.json']]
    profile, expected, activation = origin_profile(profile_path.read_bytes(), json.loads(expected_path.read_bytes()), json.loads(activation_path.read_bytes()))
    site_path = SITES / 'telomere-primary-domain'
    old_path = SITES / 'telomere-apex-static'
    acme_path = SITES / 'telomere-http-acme'
    original_app, original_acme = old_path.read_text(), acme_path.read_text()
    site = http_server() + https_server(original_app)
    checkpoint = PRIVATE / ('before-domain-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8])
    checkpoint.mkdir(mode=0o700)
    files = [profile_path, expected_path, activation_path, old_path, site_path, acme_path]
    for index, path in enumerate(files):
        atomic(checkpoint / str(index), path.read_bytes())
    atomic(checkpoint / 'files.json', encode([str(path) for path in files]))
    timers, success, stopped = [], False, False
    try:
        for name in ['backup', 'monitor', 'pager']:
            timer = 'telomere-mainnet-' + name + '.timer'
            if subprocess.run(['systemctl', 'is-active', '--quiet', timer]).returncode == 0:
                run(['systemctl', 'stop', timer])
                timers.append(timer)
        for name in ['backup', 'monitor', 'pager']:
            assert subprocess.run(['systemctl', 'is-active', '--quiet', 'telomere-mainnet-' + name + '.service']).returncode != 0, 'Active operational job; retry later'
        assert json_get('http://127.0.0.1:3282', '/health/ready')['worker'] == 'idle'
        run(['systemctl', 'stop', SERVICE]); stopped = True
        financial = audit()
        atomic(checkpoint / 'financial-before.json', encode(financial))
        with (checkpoint / 'database.dump').open('xb') as output:
            result = subprocess.run(['/usr/bin/docker', '--host', 'unix:///run/telomere-mainnet-docker/docker.sock', 'exec',
                'telomere-mainnet-postgres', 'sh', '-c', 'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -h 127.0.0.1 -p 15435 -U "$POSTGRES_USER" -d telomere_mainnet -Fc'],
                stdout=output, stderr=subprocess.PIPE, timeout=120)
            assert result.returncode == 0 and output.tell() > 0
        atomic(profile_path, profile)
        atomic(expected_path, encode(expected))
        atomic(activation_path, encode(activation))
        assert json.loads(run([NODE, str(BASE / 'operator/preflight-public.mjs'), '--configuration-only']))['configurationValid']
        run(['systemctl', 'start', SERVICE]); ready()
        assert json_get('http://127.0.0.1:3282', '/api/version') == before_version
        after = audit()
        for field in ['journalRows', 'originalJournalSha256', 'states', 'signerNonce', 'operatorEthWei', 'ownerUsdcAtomic', 'escrowUsdcAtomic', 'ownerAvailableUsdcAtomic']:
            assert financial[field] == after[field], 'Financial checkpoint changed: ' + field
        atomic(checkpoint / 'financial-after.json', encode(after))
        atomic(site_path, site.encode(), 0o644)
        # Verify new HTTPS before sending existing users there.
        run(['nginx', '-t']); run(['systemctl', 'reload', 'nginx'])
        https_ready(before_version)
        # Keep the filenames consumed by existing backup and recovery tools.
        atomic(old_path, (https_server(original_app) + legacy_redirect()).encode(), 0o644)
        atomic(acme_path, (original_acme + '\n' + http_server()).encode(), 0o644)
        atomic(site_path, b'# Primary domain is in telomere-apex-static and telomere-http-acme.\n', 0o644)
        DOMAIN_HOME.mkdir(mode=0o755)
        atomic(DOMAIN_HOME / 'domain_health.py', Path(__file__).with_name('domain_health.py').read_bytes(), 0o644)
        DROPIN.parent.mkdir(exist_ok=True)
        atomic(DROPIN, ('[Service]\nExecStartPost=/usr/bin/python3 -B ' + str(DOMAIN_HOME / 'domain_health.py') + '\n').encode(), 0o644)
        run(['systemctl', 'daemon-reload'])
        run(['nginx', '-t']); run(['systemctl', 'reload', 'nginx'])
        run(['/usr/bin/python3', '-B', str(DOMAIN_HOME / 'domain_health.py')])
        success = True
        result = {'completed': True, 'origin': 'https://' + NEW, 'sourceCommit': before_version['sourceCommit'],
            'applicationReleaseUnchanged': True, 'financialCheckpointUnchanged': True, 'transactionsSent': 0,
            'checkpoint': str(checkpoint), 'monitorHook': str(DROPIN)}
        atomic(checkpoint / 'result.json', encode(result))
        print(json.dumps(result))
    finally:
        try:
            if not success:
                if stopped:
                    run(['systemctl', 'stop', SERVICE])
                for index, path in enumerate(files):
                    atomic(path, (checkpoint / str(index)).read_bytes(), 0o644 if path.parent == SITES else 0o600)
                DROPIN.unlink(missing_ok=True)
                # Own directory was absent at entry and contains only this public checker.
                if DOMAIN_HOME.exists():
                    (DOMAIN_HOME / 'domain_health.py').unlink(missing_ok=True)
                    DOMAIN_HOME.rmdir()
                run(['systemctl', 'daemon-reload'])
                if stopped:
                    run(['systemctl', 'start', SERVICE]); ready()
                run(['nginx', '-t']); run(['systemctl', 'reload', 'nginx'])
        finally:
            for timer in timers:
                run(['systemctl', 'start', timer])


def main():
    import fcntl
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['prepare', 'activate'])
    arguments = parser.parse_args()
    assert os.geteuid() == 0
    with (PRIVATE / 'audited-rollout.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        (prepare if arguments.command == 'prepare' else activate)()


if __name__ == '__main__':
    main()
