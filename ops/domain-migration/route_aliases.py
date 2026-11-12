"""Canonical public redirects for legacy handoff paths, including direct entry."""
import json
import os
import subprocess
import time
import uuid
from pathlib import Path

BASE = Path('/opt/telomere-mainnet-pilot')
VHOST = Path('/etc/nginx/sites-available/telomere-apex-static')
BEGIN = '# BEGIN Telomere canonical page routes\n'
END = '# END Telomere canonical page routes\n'


def aliases():
    values = {'about-us': 'protocol', 'projects': 'compute', 'articles': 'learn', 'jobs': 'hosts', 'contact': 'dashboard',
        'legal/privacy-policy': 'privacy', 'legal/terms-of-service': 'terms', 'legal/cookie-policy': 'terms',
        'projects/tektura': 'compute', 'projects/reelio': 'compute', 'projects/vitalo': 'compute'}
    articles = ['the-power-of-minimalism-why-less-is-more-in-design', 'the-future-of-web-design-trends-you-can-t-ignore',
        'my-web-design-process-from-concept-to-completion', 'why-investing-in-good-design-pays-off-for-your-business']
    for old, current in zip(articles, ['receipts', 'leashes', 'cysts', 'selection']):
        values['articles/' + old] = 'learn/' + current
    return {'/' + old + suffix: '/' + new + '/' for old, new in values.items() for suffix in ['', '/']}


def render(original):
    assert original.count('server_name my-telomere.com;') == 1
    assert original.count('    root /var/www/telomere-public/') == 1
    if BEGIN in original:
        assert original.count(BEGIN) == original.count(END) == 1
        start = original.index(BEGIN)
        finish = original.index(END, start) + len(END)
        original = original[:start] + original[finish:]
    block = BEGIN
    for source, target in aliases().items():
        # Redirect only navigation. Never forward a stale POST to another path.
        block += ('    location = ' + source + ' {\n'
            '        if ($request_method !~ ^(GET|HEAD)$) { return 409; }\n'
            '        return 308 https://my-telomere.com' + target + '$is_args$args;\n    }\n')
    block += END
    index = original.index('    root /var/www/telomere-public/')
    return original[:index] + block + original[index:]


def atomic(path, data):
    temporary = path.with_name(path.name + '.aliases-' + uuid.uuid4().hex)
    try:
        temporary.write_bytes(data)
        temporary.chmod(0o644)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    import fcntl
    assert os.geteuid() == 0
    os.umask(0o077)
    with (BASE / 'private/audited-rollout.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        original = VHOST.read_bytes()
        updated = render(original.decode()).encode()
        checkpoint = BASE / 'private' / ('before-route-aliases-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8])
        checkpoint.mkdir(mode=0o700)
        (checkpoint / 'nginx.conf').write_bytes(original)
        try:
            atomic(VHOST, updated)
            subprocess.run(['nginx', '-t'], check=True, capture_output=True)
            subprocess.run(['systemctl', 'reload', 'nginx'], check=True, capture_output=True)
        except Exception:
            atomic(VHOST, original)
            subprocess.run(['nginx', '-t'], check=True, capture_output=True)
            subprocess.run(['systemctl', 'reload', 'nginx'], check=True, capture_output=True)
            raise
    print(json.dumps({'installed': True, 'aliases': len(aliases()), 'origin': 'https://my-telomere.com',
                      'controllerRestarted': False, 'financialTransactions': 0}))


if __name__ == '__main__':
    main()
