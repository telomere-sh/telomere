from __future__ import annotations

import base64
import copy
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
from telomere_sdk import ApiError, ApiTransport, PyCryptodomeCipher, TelomereClient, decrypt_checkpoint, encrypt_checkpoint, export_checkpoint_key, import_checkpoint_key
from telomere_sdk.cysts import CAPABILITIES, HEADER_FIELDS, MAX_CIPHERTEXT_BYTES, MAX_OWNER_BYTES, MAX_PLAINTEXT_BYTES
from telomere_sdk.transport import MAX_CYST_BODY_BYTES
from test_sdk import FixtureServer

FIXTURE = json.loads((pathlib.Path(__file__).parent / "fixtures" / "cyst-typescript.json").read_text(encoding="utf-8"))
ENVELOPE = FIXTURE["envelope"]
OWNER, AGENT, CHECKPOINT_ID = ENVELOPE["owner"], ENVELOPE["agent"], ENVELOPE["id"]
OTHER = "0x" + "33" * 20
try:
    CIPHER = PyCryptodomeCipher()
except RuntimeError:
    CIPHER = None


def metadata(envelope=ENVELOPE, *, state="ready"):
    return {**{key: envelope[key] for key in HEADER_FIELDS}, "sha256": envelope["sha256"],
            "ciphertextBytes": envelope["plaintextBytes"] + 16, "state": state, "createdAt": "2026-10-08T00:00:00.000Z"}


class CystTransport:
    origin = "http://127.0.0.1:3280"

    def __init__(self):
        self.owner = OWNER
        self.calls = []
        self.envelope = copy.deepcopy(ENVELOPE)
        self.meta = metadata()
        self.responses = {
            "/api/cysts/capabilities": CAPABILITIES,
            "/api/cysts": {"checkpoints": [self.meta], "usage": {"bytes": self.meta["ciphertextBytes"], "checkpoints": 1}, "capabilities": CAPABILITIES},
            "/api/cysts/" + CHECKPOINT_ID: self.meta,
            "/api/cysts/" + CHECKPOINT_ID + "/blob": {"metadata": self.meta, "ciphertext": self.envelope["ciphertext"]}}
        self.override = None

    def request(self, path, *, method="GET", body=None, idempotency_key=None, max_response_bytes=None):
        self.calls.append((path, method, copy.deepcopy(body), idempotency_key, max_response_bytes))
        if self.override is not None:
            result = self.override(path, method, body)
            if result is not None:
                return copy.deepcopy(result)
        if path == "/api/me":
            return {"address": self.owner, "demo": True}
        if path == "/api/cysts" and method == "POST":
            return {"checkpoint": metadata(body), "replayed": False}
        return copy.deepcopy(self.responses[path])

    def clear_session(self):
        pass


class CystApiTests(unittest.TestCase):
    def setUp(self):
        self.transport = CystTransport()
        self.client = TelomereClient(self.transport.origin, transport=self.transport)

    def test_stdlib_capabilities_list_metadata_and_opaque_download(self):
        self.assertEqual(self.client.cysts.capabilities(), CAPABILITIES)
        self.assertEqual(self.client.cysts.list()["checkpoints"][0]["id"], CHECKPOINT_ID)
        self.assertEqual(self.client.cysts.metadata(CHECKPOINT_ID, agent=AGENT)["owner"], OWNER)
        value = self.client.cysts.download(CHECKPOINT_ID, owner=OWNER, agent=AGENT)
        self.assertEqual(value, ENVELOPE)
        self.assertEqual(self.transport.calls[-2][4], MAX_CYST_BODY_BYTES)
        self.assertEqual(hashlib.sha256(base64.b64decode(value["ciphertext"])).hexdigest(), ENVELOPE["sha256"])

    def test_restore_without_explicit_cipher_fails_before_network(self):
        with self.assertRaisesRegex(ValueError, "explicit reviewed CheckpointCipher"):
            self.client.cysts.restore(CHECKPOINT_ID, bytearray(32))
        self.assertEqual(self.transport.calls, [])

    def test_upload_sends_only_strict_ciphertext_envelope(self):
        result = self.client.cysts.upload(ENVELOPE, idempotency_key="original_cyst_001")
        self.assertEqual(result["checkpoint"]["id"], CHECKPOINT_ID)
        posts = [call for call in self.transport.calls if call[1] == "POST"]
        self.assertEqual(len(posts), 1)
        encoded = json.dumps(posts[0][2])
        self.assertNotIn("recovery_key", encoded)
        self.assertNotIn(FIXTURE["testOnlyRecoveryKey"], encoded)
        self.assertNotIn(base64.b64decode(FIXTURE["plaintextBase64"]).decode(), encoded)
        self.assertEqual(posts[0][3], "original_cyst_001")

    def test_unknown_key_plaintext_and_filename_fields_never_upload(self):
        for field in ("recoveryKey", "recovery_key", "plaintext", "filename", "path"):
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.client.cysts.upload({**ENVELOPE, field: "must-stay-client-side"}, idempotency_key="original_cyst_001")
        self.assertFalse(any(call[1] == "POST" for call in self.transport.calls))

    def test_upload_checks_exact_echoed_header_and_ready_state(self):
        for field, changed in (("id", "0x" + "bb" * 32), ("owner", OTHER), ("agent", OTHER), ("applicationSchema", "changed/v1"), ("state", "pending"), ("sha256", "aa" * 32)):
            with self.subTest(field=field):
                self.transport.override = lambda path, method, body, f=field, v=changed: {"checkpoint": {**metadata(body), f: v}, "replayed": False} if method == "POST" else None
                with self.assertRaises(ValueError):
                    self.client.cysts.upload(ENVELOPE, idempotency_key="original_cyst_001")

    def test_uncertain_upload_reuses_only_original_envelope_and_key(self):
        self.transport.override = lambda path, method, body: (_ for _ in ()).throw(ApiError(503, "offline")) if method == "POST" else None
        with self.assertRaises(ApiError):
            self.client.cysts.upload(ENVELOPE, idempotency_key="original_cyst_001")
        changed = {**ENVELOPE, "id": "0x" + "bb" * 32}
        with self.assertRaisesRegex(ValueError, "original encrypted checkpoint"):
            self.client.cysts.upload(changed, idempotency_key="original_cyst_001")
        self.transport.override = None
        self.assertEqual(self.client.cysts.upload(ENVELOPE, idempotency_key="original_cyst_001")["checkpoint"]["state"], "ready")

    def test_download_scope_digest_and_pending_state_rejected(self):
        path = "/api/cysts/" + CHECKPOINT_ID + "/blob"
        for field, changed in (("id", "0x" + "bb" * 32), ("owner", OTHER), ("agent", OTHER), ("state", "pending"), ("sha256", "aa" * 32), ("ciphertextBytes", 17)):
            with self.subTest(field=field):
                self.transport.responses[path] = {"metadata": {**metadata(), field: changed}, "ciphertext": ENVELOPE["ciphertext"]}
                with self.assertRaises(ValueError):
                    self.client.cysts.download(CHECKPOINT_ID, owner=OWNER, agent=AGENT)
        self.transport.responses[path] = {"metadata": metadata(), "ciphertext": ENVELOPE["ciphertext"][:-4] + "AAAA"}
        with self.assertRaises(ValueError):
            self.client.cysts.download(CHECKPOINT_ID)

    def test_scope_changed_during_download_is_rejected(self):
        def changed(path, method, body):
            if path.endswith("/blob"):
                self.transport.owner = OTHER
        self.transport.override = changed
        with self.assertRaisesRegex(ValueError, "signed-in checkpoint owner changed"):
            self.client.cysts.download(CHECKPOINT_ID)

    def test_full_sorted_page_cursor_and_filters(self):
        rows = [{**metadata(), "id": "0x" + format(index, "064x")} for index in range(1, 101)]
        value = {"checkpoints": rows, "usage": {"bytes": len(rows) * metadata()["ciphertextBytes"], "checkpoints": 100},
                 "capabilities": CAPABILITIES, "nextCursor": rows[-1]["id"]}
        self.transport.responses["/api/cysts?agent=" + AGENT] = value
        result = self.client.cysts.list(agent=AGENT)
        self.assertEqual(result["nextCursor"], rows[-1]["id"])
        for changed in (list(reversed(rows)), [rows[0], rows[0]], [{**rows[0], "owner": OTHER}], [{**rows[0], "agent": OTHER}]):
            with self.subTest(rows=len(changed)):
                self.transport.responses["/api/cysts?agent=" + AGENT] = {**value, "checkpoints": changed}
                with self.assertRaises(ValueError):
                    self.client.cysts.list(agent=AGENT)

    def test_cursor_and_quota_bounds_fail_closed(self):
        for usage in ({"bytes": MAX_OWNER_BYTES + 1, "checkpoints": 1}, {"bytes": 0, "checkpoints": 1}, {"bytes": 100, "checkpoints": 513}, {"bytes": 100, "checkpoints": True}):
            with self.subTest(usage=usage):
                self.transport.responses["/api/cysts"] = {"checkpoints": [metadata()], "usage": usage, "capabilities": CAPABILITIES}
                with self.assertRaises(ValueError):
                    self.client.cysts.list()
        self.transport.responses["/api/cysts?cursor=" + CHECKPOINT_ID] = {"checkpoints": [metadata()], "usage": {"bytes": 100, "checkpoints": 1}, "capabilities": CAPABILITIES}
        with self.assertRaisesRegex(ValueError, "cursor scope changed"):
            self.client.cysts.list(cursor=CHECKPOINT_ID)

    def test_capabilities_cannot_widen_limits(self):
        self.transport.responses["/api/cysts/capabilities"] = {**CAPABILITIES, "maxPlaintextBytes": MAX_PLAINTEXT_BYTES + 1}
        with self.assertRaises(ValueError):
            self.client.cysts.capabilities()


class CystTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = FixtureServer()

    @classmethod
    def tearDownClass(cls):
        cls.server.close()

    def setUp(self):
        self.server.requests.clear()
        self.transport = ApiTransport(self.server.origin, timeout=2)

    def test_only_exact_blob_get_can_raise_response_limit(self):
        for path, method, limit in (("/api/me", "GET", MAX_CYST_BODY_BYTES), ("/api/cysts/" + CHECKPOINT_ID, "GET", MAX_CYST_BODY_BYTES),
                                    ("/api/cysts/" + CHECKPOINT_ID + "/blob?agent=" + AGENT + "&cursor=" + CHECKPOINT_ID, "GET", MAX_CYST_BODY_BYTES),
                                    ("/api/cysts/" + CHECKPOINT_ID + "/blob", "POST", MAX_CYST_BODY_BYTES),
                                    ("/api/cysts/" + CHECKPOINT_ID + "/blob", "GET", MAX_CYST_BODY_BYTES + 1),
                                    ("/api/cysts/" + CHECKPOINT_ID + "/blob", "GET", True)):
            with self.subTest(path=path, limit=limit), self.assertRaises(ValueError):
                self.transport.request(path, method=method, max_response_bytes=limit)
        self.assertEqual(self.server.requests, [])

    def test_real_http_filtered_pagination_accepts_agent_and_cursor_together(self):
        next_id = "0x" + format(int(CHECKPOINT_ID[2:], 16) + 1, "064x")
        row = {**metadata(), "id": next_id}
        expected_path = "/api/cysts?agent=" + AGENT + "&cursor=" + CHECKPOINT_ID
        page = {"checkpoints": [row], "usage": {"bytes": row["ciphertextBytes"], "checkpoints": 1}, "capabilities": CAPABILITIES}

        def response(path):
            if path == "/api/me":
                return 200, {}, json.dumps({"address": OWNER, "demo": True}).encode()
            if path == expected_path:
                return 200, {}, json.dumps(page).encode()
            return 404, {}, b'{"title":"not_found"}'

        self.server.response = response
        client = TelomereClient(self.server.origin)
        result = client.cysts.list(agent=AGENT, cursor=CHECKPOINT_ID)
        self.assertEqual(result["checkpoints"][0]["id"], next_id)
        self.assertEqual([request[0] for request in self.server.requests].count(expected_path), 1)

    def test_blob_http_stream_larger_than_normal_limit_and_bounded_overflow(self):
        path = "/api/cysts/" + CHECKPOINT_ID + "/blob"
        raw = json.dumps({"ciphertext": "a" * (1048576 + 1)}).encode()
        self.server.response = lambda requested: (200, {}, raw)
        self.assertEqual(len(self.transport.request(path, max_response_bytes=MAX_CYST_BODY_BYTES)["ciphertext"]), 1048577)
        with self.assertRaisesRegex(ApiError, "response_limit"):
            self.transport.request(path)
        for headers, body in (({"Content-Length": str(MAX_CYST_BODY_BYTES + 1)}, b'{}'), ({}, b' ' * (MAX_CYST_BODY_BYTES + 1))):
            with self.subTest(headers=headers):
                self.server.response = lambda requested, h=headers, b=body: (200, h, b)
                with self.assertRaisesRegex(ApiError, "response_limit"):
                    self.transport.request(path, max_response_bytes=MAX_CYST_BODY_BYTES)

    def test_cyst_upload_budget_does_not_expand_other_post_endpoints(self):
        self.server.response = lambda path: (200, {}, b'{}')
        body = {"ciphertext": "a" * 200000}
        self.transport.request("/api/cysts", method="POST", body=body)
        for path in ("/api/quotes", "/api/cysts/" + CHECKPOINT_ID, "/api/cysts?upload=1"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.transport.request(path, method="POST", body=body)
        with self.assertRaises(ValueError):
            self.transport.request("/api/cysts", method="POST", body={"ciphertext": "a" * MAX_CYST_BODY_BYTES})
        self.assertEqual(len(self.server.requests), 1)


@unittest.skipIf(CIPHER is None, "Install the recorded optional PyCryptodome requirements for real AEAD checks")
class CystCipherTests(unittest.TestCase):
    def test_real_typescript_ciphertext_decrypts_in_python(self):
        restored = decrypt_checkpoint(ENVELOPE, import_checkpoint_key(FIXTURE["testOnlyRecoveryKey"]), cipher=CIPHER, owner=OWNER, agent=AGENT)
        self.assertEqual(restored, base64.b64decode(FIXTURE["plaintextBase64"]))

    @unittest.skipUnless(shutil.which("node"), "Node is needed for the real TypeScript cross-runtime verifier")
    def test_real_python_ciphertext_decrypts_in_typescript(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        if not (root / "dist" / "src" / "sdk" / "cysts.js").exists():
            self.skipTest("Build the existing TypeScript SDK before its cross-runtime verifier")
        plaintext = b'{"memory":"Python-to-TypeScript public fixture"}'
        encrypted = encrypt_checkpoint(plaintext, owner=OWNER, agent=AGENT, application_schema="agent-state/v1", cipher=CIPHER)
        try:
            with tempfile.TemporaryDirectory(prefix="telomere-python-cyst-") as directory:
                path = pathlib.Path(directory) / "test-fixture.json"
                path.write_text(json.dumps({"envelope": encrypted.envelope, "testOnlyRecoveryKey": export_checkpoint_key(encrypted.recovery_key),
                                            "plaintextBase64": base64.b64encode(plaintext).decode()}), encoding="utf-8")
                result = subprocess.run(["node", str(pathlib.Path(__file__).parent / "generate-cyst-vectors.mjs"), "--verify-python", str(path)],
                                        cwd=root, capture_output=True, text=True, check=False, timeout=15)
                self.assertEqual(result.returncode, 0, "TypeScript checkpoint verification failed")
                self.assertTrue(json.loads(result.stdout)["matched"])
        finally:
            encrypted.clear_key()

    def test_fresh_default_keys_nonces_ids_and_secret_repr(self):
        first = encrypt_checkpoint(b"state", owner=OWNER, application_schema="state/v1", cipher=CIPHER)
        second = encrypt_checkpoint(b"state", owner=OWNER, application_schema="state/v1", cipher=CIPHER)
        self.assertNotEqual(first.recovery_key, second.recovery_key)
        self.assertNotEqual(first.envelope["nonce"], second.envelope["nonce"])
        self.assertNotEqual(first.envelope["id"], second.envelope["id"])
        self.assertNotIn(export_checkpoint_key(first.recovery_key), repr(first))
        first.clear_key(); second.clear_key()
        self.assertEqual(first.recovery_key, bytearray(32))

    def test_wrong_key_aad_metadata_and_scope_rejected(self):
        key = import_checkpoint_key(FIXTURE["testOnlyRecoveryKey"])
        with self.assertRaisesRegex(ValueError, "authentication failed"):
            decrypt_checkpoint(ENVELOPE, bytearray(32), cipher=CIPHER, owner=OWNER)
        for field, changed in (("id", "0x" + "bb" * 32), ("owner", OTHER), ("agent", OTHER), ("applicationSchema", "changed/v1"), ("nonce", "aa" * 24)):
            with self.subTest(field=field), self.assertRaises(ValueError):
                decrypt_checkpoint({**ENVELOPE, field: changed}, key, cipher=CIPHER, owner=OTHER if field == "owner" else OWNER)
        with self.assertRaisesRegex(ValueError, "scope changed"):
            decrypt_checkpoint(ENVELOPE, key, cipher=CIPHER, owner=OTHER)
        with self.assertRaisesRegex(ValueError, "scope changed"):
            decrypt_checkpoint(ENVELOPE, key, cipher=CIPHER, owner=OWNER, agent=OTHER)

    def test_recomputed_public_digest_cannot_forge_aead(self):
        raw = bytearray(base64.b64decode(ENVELOPE["ciphertext"]))
        raw[0] ^= 1
        changed = {**ENVELOPE, "ciphertext": base64.b64encode(raw).decode(), "sha256": hashlib.sha256(raw).hexdigest()}
        with self.assertRaisesRegex(ValueError, "authentication failed"):
            decrypt_checkpoint(changed, import_checkpoint_key(FIXTURE["testOnlyRecoveryKey"]), cipher=CIPHER, owner=OWNER)

    def test_maximum_two_mib_checkpoint_roundtrip_and_sdk_transfer(self):
        plaintext = b"x" * MAX_PLAINTEXT_BYTES
        encrypted = encrypt_checkpoint(plaintext, owner=OWNER, application_schema="bytes/v1", cipher=CIPHER)
        self.assertEqual(len(base64.b64decode(encrypted.envelope["ciphertext"])), MAX_CIPHERTEXT_BYTES)
        self.assertEqual(decrypt_checkpoint(encrypted.envelope, encrypted.recovery_key, cipher=CIPHER, owner=OWNER), plaintext)
        transport = CystTransport(); value = encrypted.envelope
        transport.responses["/api/cysts/" + value["id"] + "/blob"] = {"metadata": metadata(value), "ciphertext": value["ciphertext"]}
        client = TelomereClient(transport.origin, transport=transport)
        self.assertEqual(client.cysts.upload(value, idempotency_key="max_size_cyst_001")["checkpoint"]["plaintextBytes"], MAX_PLAINTEXT_BYTES)
        self.assertEqual(client.cysts.restore(value["id"], encrypted.recovery_key, cipher=CIPHER), plaintext)
        encrypted.clear_key()

    def test_plaintext_size_and_explicit_cipher_bounds(self):
        for plaintext in (b"", b"a" * (MAX_PLAINTEXT_BYTES + 1), "plaintext"):
            with self.subTest(kind=type(plaintext)), self.assertRaises(ValueError):
                encrypt_checkpoint(plaintext, owner=OWNER, application_schema="state/v1", cipher=CIPHER)
        with self.assertRaisesRegex(ValueError, "explicit reviewed"):
            encrypt_checkpoint(b"state", owner=OWNER, application_schema="state/v1")

    def test_failed_decrypt_clears_internal_key_copy(self):
        class FailingCipher:
            observed = None

            def decrypt(self, key, nonce, ciphertext, aad):
                self.observed = key
                raise ValueError("Injected failure")

        cipher = FailingCipher()
        original = import_checkpoint_key(FIXTURE["testOnlyRecoveryKey"])
        with self.assertRaises(ValueError):
            decrypt_checkpoint(ENVELOPE, original, cipher=cipher, owner=OWNER)
        self.assertEqual(cipher.observed, bytearray(32))
        self.assertEqual(original.hex(), FIXTURE["testOnlyRecoveryKey"])


if __name__ == "__main__":
    unittest.main()
