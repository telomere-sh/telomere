"""Read-only primary-domain check, run after the existing financial monitor."""
import datetime
import json
import os
import socket
import ssl
import tempfile
import time
import urllib.request
from pathlib import Path

HOST = 'my-telomere.com'
ORIGIN = 'https://' + HOST
PRIVATE = Path('/opt/telomere-mainnet-pilot/private')


def observe():
    result = {'origin': ORIGIN, 'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'alerts': []}
    try:
        with socket.create_connection((HOST, 443), timeout=8) as raw:
            with ssl.create_default_context().wrap_socket(raw, server_hostname=HOST) as connection:
                result['tlsRemainingDays'] = (ssl.cert_time_to_seconds(connection.getpeercert()['notAfter']) - time.time()) / 86400
        if result['tlsRemainingDays'] < 14:
            result['alerts'].append('PRIMARY_DOMAIN_TLS_EXPIRING')
        for path in ['/health/ready', '/api/config']:
            with urllib.request.urlopen(ORIGIN + path, timeout=10) as response:
                if response.geturl() != ORIGIN + path:
                    raise ValueError('Unexpected domain redirect')
                body = json.loads(response.read(131072))
            if path == '/health/ready':
                assert body['status'] == 'ready'
            else:
                assert body['chain']['id'] == 8453
                assert body['token']['address'].lower() == '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
                assert body['escrowAddress'].lower() == '0x27c1e35f563aa4f57a68b192d88a76c25e68e0db'
    except Exception:
        result['alerts'].append('PRIMARY_DOMAIN_UNAVAILABLE')
    result['status'] = 'attention' if result['alerts'] else 'ok'
    return result


def atomic(path, value):
    descriptor, name = tempfile.mkstemp(prefix='.domain-health-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output)
            output.write('\n')
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    os.umask(0o077)
    result = observe()
    atomic(PRIVATE / 'primary-domain-status.json', result)
    if result['alerts']:
        # Preserve financial/backups observations for the existing Telegram pager.
        path = PRIVATE / 'cpu-monitor-status.json'
        current = json.loads(path.read_text())
        current['alerts'] = sorted(set(current.get('alerts', []) + result['alerts']))
        current['status'] = 'attention'
        current['primaryDomain'] = result
        atomic(path, current)
    print(json.dumps(result))
    return 2 if result['alerts'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
