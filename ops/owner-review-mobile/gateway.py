"""Same-credential session gate for the isolated, read-only deployment helper.

No wallet keys, signing, arbitrary proxy targets or financial endpoints. Nginx
terminates TLS; this process binds loopback and consumes a systemd credential.
"""
import argparse
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import secrets
import threading
import time
import warnings
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

with warnings.catch_warnings():
    warnings.simplefilter('ignore', DeprecationWarning)
    import crypt

ORIGIN = 'https://review.telomere.sh'
COOKIE = '__Host-telomere-review'
LOGIN = '''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telomere review sign in</title><style>
body{max-width:440px;margin:8vh auto;padding:24px;font:16px/1.5 system-ui;color:#191919;background:#f0eee9}
label{display:block;margin:20px 0}input,button{box-sizing:border-box;width:100%;font:inherit;padding:12px}
button{background:#fc5d24;border:0;border-radius:8px;cursor:pointer}.error{color:#a32110}
</style><h1>Telomere review</h1><p>Sign in with your existing review username and password.</p>
{message}<form method="post" action="/login">
<label>Username<input name="username" autocomplete="username" maxlength="128" required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" maxlength="256" required></label>
<button type="submit">Sign in</button></form>
<p>This is the private page password. Never enter a wallet seed phrase or private key.</p></html>'''


class Gate:
    def __init__(self, username, password_hash, bundle, *, clock=time.monotonic):
        self.username, self.password_hash, self.bundle = username, password_hash, bundle
        self.clock, self.lock = clock, threading.Lock()
        self.sessions, self.attempts = {}, {}

    def verify(self, username, password):
        result = crypt.crypt(password, self.password_hash)
        return (hmac.compare_digest(username.encode(), self.username.encode())
                and result is not None and hmac.compare_digest(result, self.password_hash))

    def allow_attempt(self, ip):
        now = self.clock()
        with self.lock:
            self.attempts = {key: value for key, value in self.attempts.items() if value[0] > now - 60}
            start, count = self.attempts.get(ip, (now, 0))
            if count >= 5 or ip not in self.attempts and len(self.attempts) >= 1024:
                return False
            self.attempts[ip] = (start, count + 1)
            return True

    def create_session(self):
        token, now = secrets.token_urlsafe(32), self.clock()
        with self.lock:
            self.sessions = {key: expiry for key, expiry in self.sessions.items() if expiry > now}
            if len(self.sessions) >= 128:
                raise ValueError('Session limit')
            self.sessions[token] = now + 1800
        return token

    def authenticated(self, cookie):
        try:
            parsed = SimpleCookie(); parsed.load(cookie)
            token = parsed[COOKIE].value if COOKIE in parsed else ''
        except CookieError:
            return False
        with self.lock:
            return self.sessions.get(token, 0) > self.clock()


def handler_for(gate):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_args):
            pass  # Never log credentials, session cookies, queries or request bodies.

        def setup(self):
            super().setup(); self.connection.settimeout(10)

        def send(self, code, body=b'', content_type='text/html; charset=utf-8', extra=None):
            self.send_response(code)
            for name, value in {
                'Content-Type': content_type, 'Cache-Control': 'no-store',
                'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
                'X-Frame-Options': 'DENY',
                'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
                'Content-Length': str(len(body)), 'Connection': 'close', **(extra or {}),
            }.items():
                self.send_header(name, value)
            self.end_headers()
            if self.command != 'HEAD': self.wfile.write(body)
            self.close_connection = True

        def login_page(self, code=200, message=''):
            self.send(code, LOGIN.replace('{message}', message).encode())

        def refused(self, code=403):
            self.send(code, b'{"status":"refused"}', 'application/json')

        def do_HEAD(self):
            self.handle_request()

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

        def handle_request(self):
            try: self.route()
            except (ValueError, UnicodeError, http.client.HTTPException, OSError):
                self.refused(502)

        def route(self):
            if self.headers.get('Host') != 'review.telomere.sh' or '?' in self.path or '#' in self.path:
                self.refused(400); return
            if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) > 1:
                self.refused(400); return
            if self.path == '/login' and self.command in ('GET', 'HEAD'):
                self.login_page(); return
            if self.path == '/login' and self.command == 'POST':
                if self.headers.get('Origin') != ORIGIN:
                    self.refused(); return
                if not gate.allow_attempt(self.headers.get('X-Real-IP', self.client_address[0])):
                    self.login_page(429, '<p class="error">Too many attempts. Wait one minute.</p>'); return
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 1024 or self.headers.get('Content-Type', '').split(';')[0] != 'application/x-www-form-urlencoded':
                    self.refused(400); return
                fields = parse_qs(self.rfile.read(length).decode('utf8'), strict_parsing=True, max_num_fields=2)
                if set(fields) != {'username', 'password'} or any(len(value) != 1 for value in fields.values()):
                    self.refused(400); return
                username, password = fields['username'][0], fields['password'][0]
                if len(username) > 128 or len(password) > 256 or '\0' in username + password or not gate.verify(username, password):
                    self.login_page(401, '<p class="error">Username or password is incorrect.</p>'); return
                token = gate.create_session()
                self.send(303, extra={'Location': '/', 'Set-Cookie': COOKIE + '=' + token + '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800'})
                return
            if not gate.authenticated(self.headers.get('Cookie', '')):
                if self.path == '/' and self.command in ('GET', 'HEAD'):
                    self.send(303, extra={'Location': '/login'})
                else: self.refused(401)
                return
            if self.path == '/deployment.js' and self.command in ('GET', 'HEAD'):
                self.send(200, gate.bundle, 'text/javascript; charset=utf-8'); return
            if (self.path, self.command) not in {('/', 'GET'), ('/', 'HEAD'), ('/api/plan', 'GET'), ('/api/review', 'POST')}:
                self.refused(404); return
            body, headers = None, {'Host': 'review.telomere.sh'}
            if self.command == 'POST':
                if self.headers.get('Origin') != ORIGIN or self.headers.get('Content-Type') != 'application/json' or self.headers.get('Content-Length') != '2':
                    self.refused(); return
                body = self.rfile.read(2)
                if body != b'{}': self.refused(400); return
                headers.update({'Origin': ORIGIN, 'Content-Type': 'application/json', 'X-Deployment-Review': self.headers.get('X-Deployment-Review', '')})
            # Fixed loopback target. No auth/cookie forwarding and no arbitrary RPC.
            conn = http.client.HTTPConnection('127.0.0.1', 3284, timeout=60)
            try:
                conn.request(self.command, self.path, body=body, headers=headers)
                upstream = conn.getresponse(); response_body = upstream.read(2_097_153)
                if len(response_body) > 2_097_152: raise ValueError('Response limit')
                if self.path == '/' and self.command == 'GET' and upstream.status == 200:
                    # Keep diagnostics next to the controls on narrow wallet screens.
                    old_status = b'<p id="status" role="status">No wallet request or financial transaction has been made.</p>'
                    marker = b'<h2>Owner wallet</h2>'
                    if response_body.count(old_status) != 1 or response_body.count(marker) != 1:
                        raise ValueError('Unexpected frozen page layout')
                    response_body = response_body.replace(old_status, b'').replace(marker, marker + old_status)
                    refresh_marker = b'<button id="refresh" type="button">'
                    if b'id="switch-base"' not in response_body:
                        if response_body.count(refresh_marker) != 1: raise ValueError('Unexpected wallet controls')
                        response_body = response_body.replace(refresh_marker, b'<button id="switch-base" type="button" disabled>Switch to Base</button>' + refresh_marker)
                self.send(upstream.status, response_body, upstream.getheader('Content-Type', 'application/octet-stream'))
            finally: conn.close()
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', required=True); parser.add_argument('--bundle-sha256', required=True)
    args = parser.parse_args()
    bundle = Path(args.bundle).read_bytes()
    if hashlib.sha256(bundle).hexdigest() != args.bundle_sha256 or not 0 < len(bundle) <= 2_097_152:
        raise ValueError('Bundle identity mismatch')
    credentials = (Path(os.environ['CREDENTIALS_DIRECTORY']) / 'auth').read_text().strip().splitlines()
    if len(credentials) != 1: raise ValueError('Expected one existing review account')
    username, password_hash = credentials[0].split(':', 1)
    if not password_hash.startswith('$6$'): raise ValueError('Unsupported existing credential hash')
    server = ThreadingHTTPServer(('127.0.0.1', 3285), handler_for(Gate(username, password_hash, bundle)))
    server.daemon_threads = True
    server.serve_forever()


if __name__ == '__main__':
    main()
