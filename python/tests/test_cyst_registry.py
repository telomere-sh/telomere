from __future__ import annotations

import base64
import copy
import hashlib
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
from telomere_sdk import ApiError, ApiTransport, CystRegistryClient, EthAccountVerifier, PyCryptodomeCipher
from telomere_sdk.cysts import HEADER_FIELDS, MAX_CIPHERTEXT_BYTES, MAX_PLAINTEXT_BYTES
from telomere_sdk.transport import MAX_CYST_BODY_BYTES, response_bound
from test_sdk import FixtureServer

OWNER, AGENT, VAULT, OTHER = ("0x" + digit * 40 for digit in ("1", "2", "3", "6"))
AGENT_ID = "0xb86c2e219450935bf021f647f09534620996fe15e8cf774b8b3e720bf46a1839"
PINS = {"chainId": 31337, "confirmations": 0, "registryAddress": "0x" + "4" * 40,
        "registryCodeHash": "0x" + "a" * 64, "selectionRegistryAddress": "0x" + "5" * 40,
        "selectionRegistryCodeHash": "0x" + "b" * 64}
# Real @noble/ciphers XChaCha20-Poly1305 and literal-ABI viem vectors, generated
# with a deterministic public test key bytes([7]) * 32; never an operator key.
CHECKPOINT = {"version": 1, "algorithm": "xchacha20-poly1305", "id": "0x" + "7" * 64,
              "owner": OWNER, "agent": AGENT, "applicationSchema": "python-registry/v1", "plaintextBytes": 31,
              "nonce": "88" * 24, "sha256": "b5086edc235b55f75d090c1ba19ad2f3defab857481e83bc8956ca9cbc893a37",
              "ciphertextBytes": 47, "state": "ready", "createdAt": "2026-10-12T10:00:00.000Z"}
CIPHERTEXT = "UdVjB7Yu4WbCU6eEzjh4Kw0oH2yER8ASwYgM+vKXty0MiRcE1QmQ7jIOz8IlC7c="
STORAGE_REF = "0x4a84ab80c855d1ebe981da6434f8dd2f6f259c00f444225f750d8998646f4a2d"
COMMIT_DATA = ("0x5c527c13" + AGENT_ID[2:] + CHECKPOINT["sha256"] + format(47, "064x")
               + STORAGE_REF[2:] + format(7, "064x"))
RETIRE_DATA = "0x4f934aa8" + AGENT_ID[2:] + format(7, "064x")
SNAPSHOT = {"binding": {"agentId": AGENT_ID, "owner": OWNER, "agentWallet": AGENT, "vault": VAULT, "status": 1, "frozen": False},
            "current": {"agentId": AGENT_ID, "cystHash": "0x" + CHECKPOINT["sha256"], "sizeBytes": "47",
                        "storageRef": STORAGE_REF, "revision": "7", "committedAt": "1791799200", "retired": False,
                        "block": {"number": "31", "hash": "0x" + "c" * 64}}}
CONFIG = {"protocol": "telomere-cyst-registry-v1", "pins": PINS, "storageRefVersion": 1,
          "maxCheckpointBytes": MAX_CIPHERTEXT_BYTES, "maxRegistryBytes": 2_147_483_648}
BASE = "/api/cyst-registry/agents/" + AGENT_ID
BLOB = BASE + "/checkpoints/" + CHECKPOINT["id"] + "/blob"
try:
    CRYPTO = EthAccountVerifier()
except RuntimeError:
    CRYPTO = None
try:
    CIPHER = PyCryptodomeCipher()
except RuntimeError:
    CIPHER = None


def vector_ref(checkpoint):
    fields = ["telomere.cyst.locator", 1] + [checkpoint[key] for key in (
        "version", "algorithm", "id", "owner", "agent", "applicationSchema", "plaintextBytes", "nonce", "sha256", "ciphertextBytes")]
    return "0x" + CRYPTO.keccak256(json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()).hex()


class IndependentReader:
    def __init__(self):
        self.pins, self.value = copy.deepcopy(PINS), copy.deepcopy(SNAPSHOT)
        self.checked, self.reads, self.check_failure, self.snapshot_failure = 0, [], False, False

    def check(self):
        self.checked += 1
        if self.check_failure:
            raise ConnectionError("Independent deployment evidence unavailable")

    def snapshot(self, agent_id):
        self.reads.append(agent_id)
        if self.snapshot_failure:
            raise ConnectionError("Independent canonical evidence unavailable")
        return copy.deepcopy(self.value)


class RegistryTransport:
    origin = "http://127.0.0.1:3280"

    def __init__(self, reader):
        self.reader, self.principal = reader, AGENT
        self.checkpoint, self.ciphertext = copy.deepcopy(CHECKPOINT), CIPHERTEXT
        self.calls, self.mutate, self.after = [], lambda path, value: value, lambda path: None

    def request(self, path, *, method="GET", body=None, idempotency_key=None, max_response_bytes=None):
        self.calls.append((path, method, copy.deepcopy(body), idempotency_key, max_response_bytes))
        if path == "/api/cyst-registry/config":
            value = copy.deepcopy(CONFIG)
        elif path == "/api/me":
            value = {"address": self.principal, "demo": False}
        elif path == BASE + "/latest":
            value = copy.deepcopy(self.reader.value)
        elif path == BASE + "/commit-plan":
            value = {**copy.deepcopy(self.reader.value), "checkpoint": self.checkpoint,
                     "transaction": {"chainId": 31337, "from": AGENT, "to": PINS["registryAddress"], "value": "0", "data": COMMIT_DATA}}
        elif path == BASE + "/retire-plan":
            value = {**copy.deepcopy(self.reader.value),
                     "transaction": {"chainId": 31337, "from": AGENT, "to": PINS["registryAddress"], "value": "0", "data": RETIRE_DATA}}
        elif path == BASE + "/verify":
            current = self.reader.value["current"]
            matches = (current["revision"] != "0" and not current["retired"] and current["cystHash"] == "0x" + self.checkpoint["sha256"]
                       and current["storageRef"] == vector_ref(self.checkpoint) and current["sizeBytes"] == str(self.checkpoint["ciphertextBytes"]))
            value = {**copy.deepcopy(self.reader.value), "checkpoint": self.checkpoint, "matches": matches}
        elif path == BASE + "/checkpoints/" + self.checkpoint["id"] + "/blob":
            value = {**copy.deepcopy(self.reader.value), "checkpoint": self.checkpoint, "ciphertext": self.ciphertext}
        else:
            raise AssertionError("Unexpected registry request " + path)
        result = self.mutate(path, copy.deepcopy(value))
        self.after(path)
        return result

    def clear_session(self):
        pass


class RegistryReadTests(unittest.TestCase):
    def setUp(self):
        self.reader = IndependentReader()
        self.transport = RegistryTransport(self.reader)
        self.client = CystRegistryClient(self.transport.origin, pins=PINS, reader=self.reader, transport=self.transport)

    def test_dependency_free_pins_and_latest_return_defensive_canonical_reader_copy(self):
        self.assertEqual(self.client.config(), CONFIG)
        self.assertEqual(self.client.latest(AGENT_ID), SNAPSHOT)
        result = self.client.latest(AGENT_ID)
        result["binding"]["owner"] = OTHER
        self.assertEqual(self.client.latest(AGENT_ID)["binding"]["owner"], OWNER)
        self.assertEqual(self.reader.reads, [AGENT_ID] * 6)
        self.assertEqual(self.reader.checked, 7)

    def test_owner_reads_but_owner_labels_do_not_authorize_an_outsider(self):
        self.transport.principal = OWNER
        self.assertEqual(self.client.latest(AGENT_ID)["binding"]["agentWallet"], AGENT)
        self.transport.principal = OTHER
        with self.assertRaisesRegex(ValueError, "not authorized"):
            self.client.latest(AGENT_ID)
        self.assertNotIn(BASE + "/latest", [call[0] for call in self.transport.calls[-2:]])

    def test_independent_reader_and_each_reviewed_pin_are_required(self):
        for field, value in (("chainId", 46630), ("confirmations", 1), ("registryAddress", OTHER),
                             ("selectionRegistryAddress", OTHER), ("registryCodeHash", "0x" + "d" * 64),
                             ("selectionRegistryCodeHash", "0x" + "d" * 64)):
            with self.subTest(field=field), self.assertRaises(ValueError):
                CystRegistryClient(self.transport.origin, pins={**PINS, field: value}, reader=self.reader, transport=self.transport)
        for reader in (None, object()):
            with self.subTest(reader=type(reader).__name__), self.assertRaises(ValueError):
                CystRegistryClient(self.transport.origin, pins=PINS, reader=reader, transport=self.transport)
        with self.assertRaises(ValueError):
            CystRegistryClient("http://127.0.0.1:3281", pins=PINS, reader=self.reader, transport=self.transport)

    def test_fresh_configuration_and_reader_pins_cannot_be_cached(self):
        self.client.config()
        self.transport.mutate = lambda path, value: {**value, "pins": {**PINS, "confirmations": 1}} if path.endswith("/config") else value
        with self.assertRaisesRegex(ValueError, "reviewed pins"):
            self.client.config()
        self.reader.pins["registryCodeHash"] = "0x" + "d" * 64
        with self.assertRaisesRegex(ValueError, "reviewed pins"):
            self.client.config()
        self.assertEqual(self.reader.checked, 2)

    def test_config_protocol_limits_and_strict_unknown_fields_fail_closed(self):
        for field, value in (("protocol", "other"), ("storageRefVersion", True), ("maxCheckpointBytes", MAX_CIPHERTEXT_BYTES + 1),
                             ("maxRegistryBytes", 2_147_483_649), ("unexpected", True)):
            self.transport.mutate = lambda path, raw, f=field, v=value: {**raw, f: v} if path.endswith("/config") else raw
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.client.config()

    def test_same_substantive_state_accepts_different_api_head(self):
        def old_head(path, value):
            if path.endswith("/latest"):
                value["current"]["block"] = {"number": "30", "hash": "0x" + "d" * 64}
            return value
        self.transport.mutate = old_head
        self.assertEqual(self.client.latest(AGENT_ID)["current"]["block"], SNAPSHOT["current"]["block"])

    def test_every_substantive_api_binding_and_state_field_must_match_reader(self):
        for section, fields in (("binding", {"agentId": "0x" + "d" * 64, "owner": OTHER, "agentWallet": OTHER,
                                            "vault": OTHER, "status": 2, "frozen": True}),
                               ("current", {"agentId": "0x" + "d" * 64, "cystHash": "0x" + "d" * 64, "sizeBytes": "1",
                                            "storageRef": "0x" + "d" * 64, "revision": "6", "committedAt": "1", "retired": True})):
            for field, changed in fields.items():
                def change(path, value, s=section, f=field, v=changed):
                    if path.endswith("/latest"):
                        value[s][f] = v
                    return value
                self.transport.mutate = change
                with self.subTest(section=section, field=field), self.assertRaises(ValueError):
                    self.client.latest(AGENT_ID)

    def test_unavailable_and_changed_independent_evidence_fails_closed(self):
        self.reader.check_failure = True
        with self.assertRaises(ConnectionError):
            self.client.latest(AGENT_ID)
        self.assertEqual(self.transport.calls, [])
        self.reader.check_failure, self.reader.snapshot_failure = False, True
        with self.assertRaises(ConnectionError):
            self.client.latest(AGENT_ID)
        self.reader.snapshot_failure = False
        self.reader.value["binding"]["agentId"] = self.reader.value["current"]["agentId"] = "0x" + "d" * 64
        with self.assertRaisesRegex(ValueError, "requested agent identity"):
            self.client.latest(AGENT_ID)

    def test_no_verifier_or_cipher_never_prepares_or_downloads(self):
        operations = [lambda: self.client.commit_plan(AGENT_ID, CHECKPOINT, idempotency_key="cyst-commit-01"),
                      lambda: self.client.retire_plan(AGENT_ID, "7", idempotency_key="cyst-retire-01"),
                      lambda: self.client.verify(AGENT_ID, CHECKPOINT), lambda: self.client.download(AGENT_ID, CHECKPOINT),
                      lambda: self.client.restore(AGENT_ID, CHECKPOINT, bytes(32))]
        for operation in operations:
            with self.assertRaises(ValueError):
                operation()
        self.assertEqual(self.transport.calls, [])

    def test_sha3_is_not_ethereum_keccak(self):
        class WrongVerifier:
            def keccak256(self, value):
                return hashlib.sha3_256(value).digest()
        client = CystRegistryClient(self.transport.origin, pins=PINS, reader=self.reader, verifier=WrongVerifier(), transport=self.transport)
        with self.assertRaisesRegex(ValueError, "Ethereum Keccak"):
            client.commit_plan(AGENT_ID, CHECKPOINT, idempotency_key="wrong-keccak-01")
        self.assertEqual(self.transport.calls, [])

    def test_only_exact_private_blob_get_can_raise_response_bound(self):
        self.assertEqual(response_bound(BLOB, "GET", MAX_CYST_BODY_BYTES), MAX_CYST_BODY_BYTES)
        for path, method in ((BLOB, "POST"), (BLOB + "?x=1", "GET"), (BLOB + "/", "GET"),
                             (BLOB.replace(AGENT_ID, AGENT), "GET"), (BLOB.replace("/checkpoints/", "/checkpoint/"), "GET"),
                             (BASE + "/latest", "GET"), ("/api/cyst-registry/config", "GET")):
            with self.subTest(path=path, method=method), self.assertRaises(ValueError):
                response_bound(path, method, MAX_CYST_BODY_BYTES)
        for bound in (True, 0, MAX_CYST_BODY_BYTES + 1):
            with self.subTest(bound=bound), self.assertRaises(ValueError):
                response_bound(BLOB, "GET", bound)


@unittest.skipIf(CRYPTO is None, "Optional reviewed Ethereum crypto adapter is not installed")
class RegistryCryptoTests(unittest.TestCase):
    def setUp(self):
        self.reader = IndependentReader()
        self.transport = RegistryTransport(self.reader)
        self.client = CystRegistryClient(self.transport.origin, pins=PINS, reader=self.reader, verifier=CRYPTO, transport=self.transport)

    def test_exact_viem_commit_and_retire_vectors_and_independent_eth_abi(self):
        from eth_abi import encode
        prepared = self.client.commit_plan(AGENT_ID, CHECKPOINT, idempotency_key="checkpoint-commit")
        self.assertEqual(prepared["transaction"]["data"], COMMIT_DATA)
        self.assertEqual(CRYPTO.keccak256(b"commitChecked(bytes32,bytes32,uint64,bytes32,uint64)")[:4].hex(), "5c527c13")
        self.assertEqual(bytes.fromhex(COMMIT_DATA[10:]), encode(["bytes32", "bytes32", "uint64", "bytes32", "uint64"],
                         [bytes.fromhex(AGENT_ID[2:]), bytes.fromhex(CHECKPOINT["sha256"]), 47, bytes.fromhex(STORAGE_REF[2:]), 7]))
        self.assertEqual(self.client.retire_plan(AGENT_ID, "7", idempotency_key="checkpoint-retire")["transaction"]["data"], RETIRE_DATA)
        self.assertNotEqual(prepared["binding"]["agentId"], prepared["checkpoint"]["agent"])
        self.assertEqual(prepared["transaction"]["from"], AGENT)
        self.assertEqual([call[2:4] for call in self.transport.calls if call[1] == "POST"],
                         [({"checkpointId": CHECKPOINT["id"]}, "checkpoint-commit"), ({"expectedRevision": "7"}, "checkpoint-retire")])

    def test_every_original_metadata_field_is_bound(self):
        changes = {"id": "0x" + "d" * 64, "owner": OTHER, "agent": OTHER, "applicationSchema": "changed/v1",
                   "plaintextBytes": 30, "nonce": "99" * 24, "sha256": "d" * 64, "ciphertextBytes": 48,
                   "state": "pending", "createdAt": "2026-10-12T10:00:01.000Z", "version": 2, "algorithm": "other"}
        for field, changed in changes.items():
            def change(path, value, f=field, v=changed):
                if path.endswith("/commit-plan"):
                    value["checkpoint"][f] = v
                return value
            self.transport.mutate = change
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.client.commit_plan(AGENT_ID, CHECKPOINT, idempotency_key="metadata-tamper")

    def test_exact_unsigned_commit_and_retire_transaction_cannot_be_substituted(self):
        changes = {"chainId": 46630, "from": OWNER, "to": OTHER, "value": "1", "data": COMMIT_DATA + "00"}
        for endpoint in ("/commit-plan", "/retire-plan"):
            for field, changed in changes.items():
                def change(path, value, f=field, v=changed, e=endpoint):
                    if path.endswith(e):
                        value["transaction"][f] = v
                    return value
                self.transport.mutate = change
                with self.subTest(endpoint=endpoint, field=field), self.assertRaises(ValueError):
                    if endpoint == "/commit-plan":
                        self.client.commit_plan(AGENT_ID, CHECKPOINT, idempotency_key="transaction-tamper")
                    else:
                        self.client.retire_plan(AGENT_ID, "7", idempotency_key="transaction-tamper")

    def test_owner_and_vault_cannot_replace_agent_wallet_authority(self):
        for principal in (OWNER, VAULT, OTHER):
            self.transport.principal = principal
            for operation in (lambda: self.client.commit_plan(AGENT_ID, CHECKPOINT, idempotency_key="owner-commit"),
                              lambda: self.client.retire_plan(AGENT_ID, "7", idempotency_key="owner-retire")):
                with self.subTest(principal=principal), self.assertRaisesRegex(ValueError, "not authorized"):
                    operation()
        self.assertFalse(any(call[1] == "POST" for call in self.transport.calls))

    def test_checkpoint_owner_and_agent_labels_must_match_selection_binding(self):
        for field in ("owner", "agent"):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "authoritative Selection"):
                self.client.commit_plan(AGENT_ID, {**CHECKPOINT, field: OTHER}, idempotency_key="foreign-label")
        self.assertFalse(any(call[1] == "POST" for call in self.transport.calls))

    def test_dormant_frozen_preservation_and_dead_retire_remain_available(self):
        self.reader.value["binding"].update({"status": 2, "frozen": True})
        self.assertEqual(self.client.commit_plan(AGENT_ID, CHECKPOINT, idempotency_key="dormant-commit")["binding"]["status"], 2)
        self.reader.value["binding"]["status"] = 3
        with self.assertRaisesRegex(ValueError, "dead agent"):
            self.client.commit_plan(AGENT_ID, CHECKPOINT, idempotency_key="dead-commit")
        self.assertEqual(self.client.retire_plan(AGENT_ID, "7", idempotency_key="dead-retire")["transaction"]["data"], RETIRE_DATA)

    def test_cas_revision_and_session_rechecked_after_server_response(self):
        for operation in (lambda: self.client.commit_plan(AGENT_ID, CHECKPOINT, idempotency_key="revision-race"),
                          lambda: self.client.retire_plan(AGENT_ID, "7", idempotency_key="revision-race")):
            self.reader.value = copy.deepcopy(SNAPSHOT)
            self.transport.after = lambda path: self.reader.value["current"].update({"revision": "8"}) if path.endswith("-plan") else None
            with self.assertRaisesRegex(ValueError, "independent current state"):
                operation()
        self.reader.value = copy.deepcopy(SNAPSHOT)
        self.transport.after = lambda path: setattr(self.transport, "principal", OWNER) if path.endswith("-plan") else None
        with self.assertRaisesRegex(ValueError, "not authorized"):
            self.client.commit_plan(AGENT_ID, CHECKPOINT, idempotency_key="session-race")

    def test_bad_inputs_and_retired_or_absent_entry_fail_before_post(self):
        for revision in ("0", "6", "07", "18446744073709551616", 7):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                self.client.retire_plan(AGENT_ID, revision, idempotency_key="invalid-retire")
        for checkpoint in ({**CHECKPOINT, "state": "pending"}, {**CHECKPOINT, "ciphertextBytes": 48}):
            with self.assertRaises(ValueError):
                self.client.commit_plan(AGENT_ID, checkpoint, idempotency_key="invalid-checkpoint")
        for agent_id, key in (("0x" + "0" * 64, "invalid-agent"), (AGENT_ID, "bad key")):
            with self.assertRaises(ValueError):
                self.client.commit_plan(agent_id, CHECKPOINT, idempotency_key=key)
        self.reader.value["current"]["retired"] = True
        with self.assertRaises(ValueError):
            self.client.retire_plan(AGENT_ID, "7", idempotency_key="retired-checkpoint")
        self.assertFalse(any(call[1] == "POST" for call in self.transport.calls))

    def test_verify_does_not_trust_api_matches_bit(self):
        self.assertTrue(self.client.verify(AGENT_ID, CHECKPOINT)["matches"])
        self.reader.value["current"]["retired"] = True
        self.assertFalse(self.client.verify(AGENT_ID, CHECKPOINT)["matches"])
        self.transport.mutate = lambda path, value: {**value, "matches": True} if path.endswith("/verify") else value
        with self.assertRaisesRegex(ValueError, "independent result"):
            self.client.verify(AGENT_ID, CHECKPOINT)

    def test_download_returns_original_envelope_for_owner_and_agent_without_plaintext(self):
        for principal in (OWNER, AGENT):
            self.transport.principal = principal
            value = self.client.download(AGENT_ID, CHECKPOINT)
            self.assertEqual(value, {**{key: CHECKPOINT[key] for key in HEADER_FIELDS}, "sha256": CHECKPOINT["sha256"], "ciphertext": CIPHERTEXT})
            self.assertEqual([call[4] for call in self.transport.calls if call[0] == BLOB][-1], MAX_CYST_BODY_BYTES)
        self.assertFalse(any(call[1] == "POST" for call in self.transport.calls))

    def test_download_rejects_retired_unpublished_and_foreign_labels_before_blob(self):
        for field, changed in (("revision", "0"), ("retired", True), ("storageRef", "0x" + "d" * 64), ("cystHash", "0x" + "d" * 64)):
            self.reader.value = copy.deepcopy(SNAPSHOT)
            self.reader.value["current"][field] = changed
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "current published live"):
                self.client.download(AGENT_ID, CHECKPOINT)
        self.reader.value = copy.deepcopy(SNAPSHOT)
        for field in ("owner", "agent"):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "authoritative Selection"):
                self.client.download(AGENT_ID, {**CHECKPOINT, field: OTHER})
        self.assertFalse(any(call[0].endswith("/blob") for call in self.transport.calls))

    def test_download_rejects_every_metadata_substitution(self):
        for field, changed in (("id", "0x" + "d" * 64), ("owner", OTHER), ("agent", OTHER), ("applicationSchema", "changed/v1"),
                               ("nonce", "99" * 24), ("sha256", "d" * 64), ("createdAt", "2026-10-12T10:00:01.000Z")):
            def change(path, value, f=field, v=changed):
                if path.endswith("/blob"):
                    value["checkpoint"][f] = v
                return value
            self.transport.mutate = change
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.client.download(AGENT_ID, CHECKPOINT)

    def test_download_rejects_invalid_noncanonical_truncated_and_wrong_digest_ciphertext(self):
        changes = ["!" + CIPHERTEXT[1:], CIPHERTEXT[:-1], CIPHERTEXT[:-2] + "d=", base64.b64encode(bytes(47)).decode(),
                   base64.b64encode(bytes(48)).decode(), "A" * (((MAX_CIPHERTEXT_BYTES + 2) // 3) * 4 + 4)]
        for ciphertext in changes:
            self.transport.ciphertext = ciphertext
            with self.subTest(length=len(ciphertext)), self.assertRaises(ValueError):
                self.client.download(AGENT_ID, CHECKPOINT)

    def test_download_rejects_revision_binding_and_session_races(self):
        changes = [lambda: self.reader.value["current"].update({"revision": "8"}),
                   lambda: self.reader.value["current"].update({"retired": True}),
                   lambda: self.reader.value["binding"].update({"owner": OTHER}),
                   lambda: self.reader.value["binding"].update({"agentWallet": OTHER}),
                   lambda: setattr(self.transport, "principal", OTHER)]
        for changed in changes:
            self.reader.value, self.transport.principal = copy.deepcopy(SNAPSHOT), AGENT
            self.transport.after = lambda path, action=changed: action() if path.endswith("/blob") else None
            with self.assertRaises(ValueError):
                self.client.download(AGENT_ID, CHECKPOINT)

    @unittest.skipIf(CIPHER is None, "Optional reviewed checkpoint cipher is not installed")
    def test_restore_authenticates_real_typescript_ciphertext_locally_and_never_sends_key(self):
        key = bytearray([7] * 32)
        self.assertEqual(self.client.restore(AGENT_ID, CHECKPOINT, key, cipher=CIPHER), "Telomere Python checkpoint 🧬".encode())
        self.assertEqual(key, bytearray([7] * 32))
        with self.assertRaisesRegex(ValueError, "authentication failed"):
            self.client.restore(AGENT_ID, CHECKPOINT, bytearray(32), cipher=CIPHER)
        self.assertFalse(any(call[1] == "POST" or call[2] is not None for call in self.transport.calls))


@unittest.skipIf(CRYPTO is None, "Optional reviewed Ethereum crypto adapter is not installed")
class RegistryHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = FixtureServer()

    @classmethod
    def tearDownClass(cls):
        cls.server.close()

    def setUp(self):
        self.reader = IndependentReader()
        self.fixture = RegistryTransport(self.reader)
        self.transport = ApiTransport(self.server.origin, timeout=2)
        self.server.requests.clear()
        self.server.response = self.response
        self.transport.request("/api/auth/demo", method="POST", body={"address": AGENT})
        self.server.requests.clear()
        self.client = CystRegistryClient(self.server.origin, pins=PINS, reader=self.reader, verifier=CRYPTO, transport=self.transport)

    def response(self, path):
        _, method, raw_headers, body = self.server.requests[-1]
        headers = {key.lower(): value for key, value in raw_headers.items()}
        if path == "/api/auth/demo":
            return 200, {"Set-Cookie": "telomere_session=" + "a" * 64 + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600"}, b"{}"
        if headers.get("cookie") != "telomere_session=" + "a" * 64:
            return 401, {}, b'{"title":"fixture_denied"}'
        if method == "POST" and (headers.get("origin") != self.server.origin or headers.get("content-type") != "application/json"):
            return 403, {}, b'{"title":"fixture_denied"}'
        value = self.fixture.request(path, method=method, body=json.loads(body) if body else None,
                                     idempotency_key=headers.get("idempotency-key"))
        return 200, {}, json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()

    def test_actual_authenticated_http_exact_plans_and_independent_reads(self):
        self.assertEqual(self.client.commit_plan(AGENT_ID, CHECKPOINT, idempotency_key="http-cyst-commit")["transaction"]["data"], COMMIT_DATA)
        self.assertEqual(self.client.retire_plan(AGENT_ID, "7", idempotency_key="http-cyst-retire")["transaction"]["data"], RETIRE_DATA)
        self.assertTrue(self.client.verify(AGENT_ID, CHECKPOINT)["matches"])
        self.assertEqual(self.client.download(AGENT_ID, CHECKPOINT)["ciphertext"], CIPHERTEXT)
        self.assertEqual(self.client.latest(AGENT_ID), SNAPSHOT)
        posts = [request for request in self.server.requests if request[1] == "POST"]
        self.assertEqual([json.loads(request[3]) for request in posts],
                         [{"checkpointId": CHECKPOINT["id"]}, {"expectedRevision": "7"}, {"checkpointId": CHECKPOINT["id"]}])
        self.assertTrue(all(request[0] == "/api/me" or request[0].startswith("/api/cyst-registry/") for request in self.server.requests))

    def test_actual_http_maximum_checkpoint_payload_is_bounded_and_verified(self):
        raw = bytes([42]) * MAX_CIPHERTEXT_BYTES
        checkpoint = {**CHECKPOINT, "plaintextBytes": MAX_PLAINTEXT_BYTES, "ciphertextBytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
        self.fixture.checkpoint, self.fixture.ciphertext = checkpoint, base64.b64encode(raw).decode()
        self.reader.value["current"].update({"cystHash": "0x" + checkpoint["sha256"], "sizeBytes": str(len(raw)), "storageRef": vector_ref(checkpoint)})
        result = self.client.download(AGENT_ID, checkpoint)
        self.assertEqual(len(base64.b64decode(result["ciphertext"])), MAX_CIPHERTEXT_BYTES)
        self.assertEqual([request[0] for request in self.server.requests if request[0].endswith("/blob")], [BLOB])
        self.server.response = lambda path: (200, {}, b" " * (MAX_CYST_BODY_BYTES + 1))
        with self.assertRaisesRegex(ApiError, "response_limit"):
            self.transport.request(BLOB, max_response_bytes=MAX_CYST_BODY_BYTES)

    def test_actual_http_transport_does_not_relax_other_paths_or_methods(self):
        before = len(self.server.requests)
        for path, method in ((BLOB, "POST"), (BLOB + "?extra=1", "GET"), (BASE + "/latest", "GET")):
            with self.subTest(path=path, method=method), self.assertRaises(ValueError):
                self.transport.request(path, method=method, max_response_bytes=MAX_CYST_BODY_BYTES)
        self.assertEqual(len(self.server.requests), before)


if __name__ == "__main__":
    unittest.main()
