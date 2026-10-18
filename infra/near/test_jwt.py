"""Offline regression of the actual NVIDIA token boundary; no GPU/network needed."""
import json
import unittest
import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from verifier import decode_nvidia, NRAS_ORIGIN, VerificationError


class NvidiaJwtTests(unittest.TestCase):
    def setUp(self):
        self.key = ec.generate_private_key(ec.SECP384R1())
        self.nonce = bytes(range(32))
        self.now = 1_800_000_000
        self.claims = {'iss': NRAS_ORIGIN, 'iat': self.now, 'nbf': self.now, 'exp': self.now + 60,
                       'eat_nonce': self.nonce.hex()}
        public = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(self.key.public_key()))
        self.jwks = {'keys': [{**public, 'kid': 'offline-fixture', 'alg': 'ES384', 'use': 'sig'}]}

    def token(self, claims=None, headers=None, key=None):
        return jwt.encode(claims or self.claims, key or self.key, algorithm='ES384',
                          headers={'kid': 'offline-fixture', **(headers or {})})

    def verify(self, token=None, jwks=None):
        return decode_nvidia(token or self.token(), jwks or self.jwks, self.nonce, self.now)

    def test_valid_p384_signature(self):
        self.assertEqual(self.verify(), self.claims)

    def test_wrong_signing_key(self):
        with self.assertRaises(VerificationError):
            self.verify(self.token(key=ec.generate_private_key(ec.SECP384R1())))

    def test_payload_substitution(self):
        parts = self.token().split('.')
        parts[1] = jwt.utils.base64url_encode(json.dumps({**self.claims, 'iat': 0}).encode()).decode()
        with self.assertRaises(VerificationError):
            self.verify('.'.join(parts))

    def test_issuer_nonce_and_time(self):
        for changes in ({'iss': 'https://example.invalid'}, {'eat_nonce': '00' * 32}, {'exp': self.now},
                        {'iat': self.now - 301}, {'nbf': self.now + 6}, {'iat': True}, {'exp': 'later'},
                        {'aud': 'unexpected-audience'}):
            with self.subTest(changes=changes), self.assertRaises(VerificationError):
                self.verify(self.token({**self.claims, **changes}))

    def test_missing_required_claims(self):
        for name in self.claims:
            with self.subTest(name=name), self.assertRaises(VerificationError):
                self.verify(self.token({key: value for key, value in self.claims.items() if key != name}))

    def test_untrusted_header_key_sources(self):
        for name in ('jku', 'x5u', 'jwk', 'crit'):
            with self.subTest(name=name), self.assertRaises(VerificationError):
                self.verify(self.token(headers={name: 'https://example.invalid'}))

    def test_duplicate_or_incompatible_trusted_key(self):
        for keys in (self.jwks['keys'] * 2, [{**self.jwks['keys'][0], 'kty': 'OKP'}],
                     [{**self.jwks['keys'][0], 'use': 'enc'}], []):
            with self.subTest(keys=len(keys)), self.assertRaises(VerificationError):
                self.verify(jwks={'keys': keys})

    def test_size_and_malformed_tokens(self):
        for token in ('x' * 65537, 'bad.token.parts', '..'):
            with self.subTest(size=len(token)), self.assertRaises(VerificationError):
                self.verify(token)


if __name__ == '__main__':
    unittest.main()
