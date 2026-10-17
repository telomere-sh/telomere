import http.client
import importlib.util
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

spec = importlib.util.spec_from_file_location('review_gate', Path(__file__).with_name('gateway.py'))
gate_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate_module)


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000
        password_hash = gate_module.crypt.crypt('fixture-only-password', gate_module.crypt.mksalt(gate_module.crypt.METHOD_SHA512))
        self.gate = gate_module.Gate('fixture', password_hash, b'fixture browser bundle', clock=lambda: self.now)
        self.server = gate_module.ThreadingHTTPServer(('127.0.0.1', 0), gate_module.handler_for(self.gate))
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True); self.worker.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.worker.join()

    def request(self, method='GET', path='/', body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.request(method, path, body=body, headers={'Host': 'review.telomere.sh', **(headers or {})})
        r = conn.getresponse(); data = r.read(); result = (r.status, dict(r.getheaders()), data)
        conn.close(); return result

    def login(self, password='fixture-only-password', origin=gate_module.ORIGIN):
        return self.request('POST', '/login', urlencode({'username': 'fixture', 'password': password}),
                            {'Origin': origin, 'Content-Type': 'application/x-www-form-urlencoded'})

    def test_login_is_a_real_form_without_basic_auth_prompt(self):
        status, headers, _ = self.request()
        self.assertEqual((status, headers['Location']), (303, '/login'))
        status, headers, body = self.request(path='/login')
        self.assertEqual(status, 200); self.assertIn(b'<form method="post"', body)
        self.assertNotIn('WWW-Authenticate', headers)
        self.assertEqual(headers['Referrer-Policy'], 'same-origin')

    def test_existing_credentials_and_secure_bounded_session(self):
        status, headers, _ = self.login()
        self.assertEqual(status, 303)
        cookie = headers['Set-Cookie']
        for flag in ['Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=1800', 'Path=/']:
            self.assertIn(flag, cookie)
        status, _, body = self.request(path='/deployment.js', headers={'Cookie': cookie.split(';')[0]})
        self.assertEqual((status, body), (200, b'fixture browser bundle'))
        self.now += 1801
        self.assertEqual(self.request(path='/deployment.js', headers={'Cookie': cookie.split(';')[0]})[0], 401)

    def test_wrong_password_does_not_create_session(self):
        self.assertEqual(self.login('wrong')[0], 401); self.assertEqual(len(self.gate.sessions), 0)

    def test_cross_origin_login_refused(self):
        self.assertEqual(self.login(origin='https://other.example')[0], 403)
        self.assertEqual(len(self.gate.sessions), 0)

    def test_no_unauthenticated_plan_or_javascript(self):
        for path in ['/deployment.js', '/api/plan', '/api/review']:
            self.assertEqual(self.request(path=path)[0], 401)

    def test_forged_cookie_refused(self):
        self.assertEqual(self.request(path='/api/plan', headers={'Cookie': gate_module.COOKIE + '=forged'})[0], 401)

    def test_rate_limit_and_expiry(self):
        for _ in range(5): self.assertEqual(self.login('wrong')[0], 401)
        self.assertEqual(self.login()[0], 429)
        self.now += 61; self.assertEqual(self.login()[0], 303)

    def test_fixed_host_no_query_and_no_financial_endpoint(self):
        self.assertEqual(self.request(headers={'Host': 'other.example'})[0], 400)
        self.assertEqual(self.request(path='/login?password=no')[0], 400)
        cookie = self.login()[1]['Set-Cookie'].split(';')[0]
        self.assertEqual(self.request('POST', '/api/send-transaction', '{}', {'Cookie': cookie})[0], 404)

    def test_proxy_strips_credentials_and_preserves_readonly_csrf(self):
        cookie = self.login()[1]['Set-Cookie'].split(';')[0]
        class Upstream:
            status = 200
            def read(self, _): return b'{"ok":true}'
            def getheader(self, _name, _default): return 'application/json'
        # Use the original client for the request into our actual local server.
        original = http.client.HTTPConnection
        conn = original('127.0.0.1', self.server.server_port, timeout=5)
        with patch.object(gate_module.http.client, 'HTTPConnection') as client:
            client.return_value.getresponse.return_value = Upstream()
            conn.request('POST', '/api/review', '{}', headers={'Host': 'review.telomere.sh', 'Cookie': cookie,
                'Authorization': 'Basic private', 'Origin': gate_module.ORIGIN,
                'Content-Type': 'application/json', 'X-Deployment-Review': 'a' * 64})
            response = conn.getresponse(); self.assertEqual(response.status, 200); response.read()
            forwarded = client.return_value.request.call_args.kwargs['headers']
            self.assertNotIn('Cookie', forwarded); self.assertNotIn('Authorization', forwarded)
            self.assertEqual(forwarded['Origin'], gate_module.ORIGIN)
            self.assertEqual(forwarded['X-Deployment-Review'], 'a' * 64)
            client.assert_called_once_with('127.0.0.1', 3284, timeout=60)
        conn.close()


if __name__ == '__main__': unittest.main()
