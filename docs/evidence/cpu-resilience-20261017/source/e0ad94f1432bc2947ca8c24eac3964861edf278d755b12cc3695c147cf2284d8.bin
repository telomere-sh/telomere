"""Bounded public HTTP checks. No valid login, payment or compute request is sent."""
import json, ssl, urllib.error, urllib.request

ORIGIN = 'https://telomere.sh'

def request(path, expected, method='GET', body=None, headers=None):
    req = urllib.request.Request(ORIGIN + path, method=method, data=body, headers=headers or {})
    try:
        response = urllib.request.urlopen(req, timeout=20, context=ssl.create_default_context())
    except urllib.error.HTTPError as error:
        response = error
    with response:
        content = response.read(262144)
        if response.status != expected:
            raise RuntimeError('Unexpected HTTP status at ' + path + ': ' + str(response.status))
        if any(word in content.lower() for word in (b'postgresql://', b'age-secret-key-', b'signer_private_key=')):
            raise RuntimeError('Private material in public response')
        return {'path': path, 'method': method, 'status': response.status,
                'noStore': response.headers.get('cache-control') == 'no-store',
                'nosniff': response.headers.get('x-content-type-options') == 'nosniff',
                'hasCsp': bool(response.headers.get('content-security-policy'))}

if __name__ == '__main__':
    checks = []
    for path in ('/api/me', '/api/workspace', '/api/runs', '/api/balance', '/api/leashes', '/api/operations'):
        result = request(path, 401)
        assert result['noStore'] and result['nosniff'] and result['hasCsp']
        checks.append(result)
    for path in ('/.env', '/.git/config', '/src/main.ts', '/scripts/deploy-contracts.ts', '/node_modules/pg/package.json', '/dist/src/main.js'):
        checks.append(request(path, 404))
    for site in ('https://attacker.invalid', 'https://telomere.sh.attacker.invalid', 'null', ''):
        checks.append(request('/api/auth/challenge', 403, 'POST', b'{}', {'Origin': site, 'Content-Type': 'application/json'}))
    checks.append(request('/api/auth/challenge', 400, 'POST', b'{}', {'Origin': ORIGIN, 'Content-Type': 'text/plain'}))
    checks.append(request('/api/auth/challenge', 422, 'POST', b'{broken', {'Origin': ORIGIN, 'Content-Type': 'application/json'}))
    checks.append(request('/api/auth/demo', 404, 'POST', b'{}', {'Origin': ORIGIN, 'Content-Type': 'application/json'}))
    print(json.dumps({'passed': True, 'checks': checks, 'mainnetTransactions': 0, 'validLoginChallengesCreated': 0}, indent=2))
