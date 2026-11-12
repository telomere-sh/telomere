"""External HTTP/TLS and origin-binding smoke checks. No wallet signature/transaction."""
import concurrent.futures
import hashlib
import json
import urllib.error
import urllib.request
from route_aliases import aliases

ORIGIN = 'https://my-telomere.com'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def request(url, method='GET', origin=None, body=None):
    headers = {'User-Agent': 'Telomere-domain-verification/1'}
    if origin:
        headers['Origin'] = origin
    if body is not None:
        headers['Content-Type'] = 'application/json'
        body = json.dumps(body).encode()
    try:
        response = urllib.request.build_opener(NoRedirect).open(urllib.request.Request(url, data=body, headers=headers, method=method), timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read(16 * 1024 * 1024)


def main():
    paths = ['/', '/dashboard/', '/compute/', '/hosts/', '/protocol/', '/developers/', '/learn/', '/privacy/', '/terms/', '/health/ready', '/api/config']
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda path: (path, request(ORIGIN + path)), paths))
    for path, (status, headers, body) in results:
        assert status == 200, (path, status)
        if path.endswith('/'):
            assert 'text/html' in headers['Content-Type']
        if path == '/health/ready':
            assert json.loads(body)['status'] == 'ready'
    version = json.loads(request(ORIGIN + '/api/version')[2])
    for name, digest in version['assets'].items():
        status, headers, body = request(ORIGIN + '/' + name)
        assert status == 200 and hashlib.sha256(body).hexdigest() == digest, name
    for start in ['https://telomere.sh', 'https://www.my-telomere.com', 'http://my-telomere.com', 'http://www.my-telomere.com']:
        status, headers, _ = request(start + '/dashboard/?view=hosts')
        assert status == 308 and headers['Location'] == ORIGIN + '/dashboard/?view=hosts', start
    assert request('https://telomere.sh/api/auth/challenge', 'POST', 'https://telomere.sh', {})[0] == 409
    for source, target in aliases().items():
        status, headers, _ = request(ORIGIN + source + '?view=hosts')
        assert status == 308 and headers['Location'] == ORIGIN + target + '?view=hosts', source
    for source in ['/contact/', '/projects/tektura']:
        assert request(ORIGIN + source, 'POST', ORIGIN, {})[0] == 409
    challenge = {'address': '0x1111111111111111111111111111111111111111'}
    for untrusted in ['https://telomere.sh', 'https://attacker.invalid', ORIGIN + '.attacker.invalid']:
        assert request(ORIGIN + '/api/auth/challenge', 'POST', untrusted, challenge)[0] == 403
    status, _, raw = request(ORIGIN + '/api/auth/challenge', 'POST', ORIGIN, challenge)
    body = json.loads(raw)
    assert status == 200 and body['message'].startswith('my-telomere.com wants you to sign in to Telomere:')
    assert '\nURI: ' + ORIGIN + '\n' in body['message']
    assert '\nChain ID: 8453\n' in body['message']
    result = {'passed': True, 'origin': ORIGIN, 'pages': len(paths), 'assetHashes': len(version['assets']),
              'redirects': 4, 'canonicalPathRedirects': len(aliases()), 'oldUnsafeMethodBlocked': True, 'rejectedOrigins': 3, 'signInDomainBound': True,
              'sourceCommit': version['sourceCommit'], 'walletSignatures': 0, 'transactionsSent': 0}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
