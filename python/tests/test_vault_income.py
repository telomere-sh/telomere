from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import pathlib
import socket
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
from telomere_sdk import EthAccountVerifier, VaultIncomeClient, VaultIncomeError, VaultIncomePublicHttp, vault_income_authorization_ref
from telomere_sdk.chains import PUBLIC_BASE_TOKENS, PUBLIC_BASE_USDC_DOMAINS
from telomere_sdk.vault_income import _digest, _header

try:
    CRYPTO = EthAccountVerifier()
    from eth_account import Account
    from eth_account.messages import encode_typed_data
except (RuntimeError, ImportError):
    CRYPTO = None

PAYER_KEY = "0x" + "11" * 32  # Public deterministic local test fixture only.
PAYER = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A"
OTHER = "0x" + "2" * 40
HASH = "0x" + "a" * 64
NOW = 1_791_800_000


def profile(url="http://127.0.0.1:3280/x402/vault-income"):
    return {"resourceUrl": url, "grossAmount": "101", "pins": {"chainId": 31337,
            "asset": "0x" + "3" * 40, "tokenCodeHash": "0x" + "b" * 64, "payTo": "0x" + "4" * 40,
            "facilitator": "0x" + "5" * 40, "reviewedTokenKind": "immutable", "confirmations": 1,
            "exact": {"reviewedEip3009": True, "name": "Local EIP3009 Fixture", "version": "1"},
            "selection": {"chainId": 31337, "confirmations": 1, "selectionRegistryAddress": "0x" + "6" * 40,
                          "selectionRegistryCodeHash": "0x" + "c" * 64, "vaultImplementationAddress": "0x" + "7" * 40,
                          "vaultImplementationCodeHash": "0x" + "d" * 64},
            "agentId": "0x" + "8" * 64, "treasury": "0x" + "9" * 40}}


def base_profile(chain_id):
    value = profile("https://controller.example/x402/vault-income")
    pins = value["pins"]
    pins["chainId"] = pins["selection"]["chainId"] = chain_id
    pins["asset"] = PUBLIC_BASE_TOKENS[chain_id]
    pins["reviewedTokenKind"] = "circle_proxy"
    pins["assetImplementation"] = {"address": "0x" + "a" * 40, "codeHash": "0x" + "b" * 64}
    pins["archiveAnchor"] = {"number": "9", "hash": "0x" + "9" * 64, "timestamp": str(NOW - 30_000)}
    pins["exact"].update(name=PUBLIC_BASE_USDC_DOMAINS[chain_id]["name"], version="2")
    return value


class Journal:
    """Test-only adapter; writes survive callback failure, all reads are copies."""

    def __init__(self):
        self.state, self.fail, self.saves = None, False, 0
        self.lock = threading.RLock()

    def load(self):
        return copy.deepcopy(self.state)

    def save(self, state):
        if self.fail:
            self.fail = False
            raise OSError("Disposable failed durable commit")
        self.state = copy.deepcopy(state)
        self.saves += 1

    def exclusive(self, scope, callback):
        self.scope = scope
        with self.lock:
            return callback(self)


class DiskJournal(Journal):
    """Acceptance-only single-owner fixture: flush then replace, orderly reopen."""

    def __init__(self, path):
        super().__init__()
        self.path = pathlib.Path(path)
        self.owner = os.open(str(path) + ".lock", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)

    def load(self):
        return json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else None

    def save(self, state):
        temporary = str(self.path) + ".tmp"
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as target:
                json.dump(state, target, separators=(",", ":"))
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def close(self):
        os.close(self.owner)
        os.unlink(str(self.path) + ".lock")


class Reader:
    def __init__(self, value):
        self.profile, self.status = copy.deepcopy(value), "pending"
        self.inspections, self.checks, self.fail = 0, 0, False
        self.timestamp, self.classification, self.mutate = NOW, "income", lambda result: result

    def check(self):
        self.checks += 1
        if self.fail:
            raise ConnectionError("Disposable independent evidence failure")
        return {"block": {"number": "20", "hash": "0x" + "c" * 64, "timestamp": str(self.timestamp)},
                "binding": {"agentId": self.profile["pins"]["agentId"], "owner": OTHER,
                            "agentWallet": "0x" + "1" * 40, "vault": self.profile["pins"]["payTo"], "status": 1, "frozen": False}}

    def inspect(self, *, transaction_hash, payment):
        self.inspections += 1
        if self.fail:
            raise ConnectionError("Disposable independent receipt failure")
        result = {"status": self.status, "transactionHash": transaction_hash}
        if self.status != "pending":
            result["block"] = self.check()["block"]
        if self.status == "settled":
            auth = payment["payload"]["authorization"]
            fee = "2" if self.classification == "income" else "0"
            result.update({"classification": self.classification, "grossAmount": "101", "incomeFee": fee,
                           "netAmount": str(101 - int(fee)), "payer": auth["from"],
                           "paymentRef": vault_income_authorization_ref(self.profile, auth["from"], auth["nonce"], CRYPTO)})
        return self.mutate(result)


class PaymentTransport:
    def __init__(self, value):
        self.profile, self.resource_url = copy.deepcopy(value), value["resourceUrl"]
        self.calls, self.drop, self.candidate, self.counter = [], False, HASH, 0
        self.mutate = lambda response: response

    def send(self, signed_header=None):
        self.calls.append(signed_header)
        pins = self.profile["pins"]
        if signed_header is None:
            self.counter += 1
            request_hash = _digest({"method": "POST", "url": self.resource_url, "body": hashlib.sha256(b"{}").hexdigest()})
            terms = {"scheme": "exact", "network": "eip155:" + str(pins["chainId"]), "asset": pins["asset"], "amount": "101", "payTo": pins["payTo"],
                     "maxTimeoutSeconds": 300, "extra": {"name": pins["exact"]["name"], "version": pins["exact"]["version"],
                     "assetTransferMethod": "eip3009", "facilitatorAddress": pins["facilitator"],
                     "telomere": {"challengeId": "00000000-0000-4000-8000-" + format(self.counter, "012x"),
                                  "nonce": "0x" + format(self.counter, "064x"), "requestHash": request_hash}}}
            return self.mutate({"status": 402, "body": {}, "required": {"x402Version": 2,
                         "resource": {"url": self.resource_url}, "accepts": [terms],
                         "extensions": {"telomere-request-binding": {"version": 1, "requestHash": request_hash}}}})
        if self.drop:
            self.drop = False
            raise ConnectionError("Disposable lost paid HTTP response")
        payer = json.loads(base64.b64decode(signed_header))["payload"]["authorization"]["from"]
        return self.mutate({"status": 200, "payment": {"success": True, "transaction": self.candidate,
                             "network": "eip155:31337", "payer": payer, "amount": "101"},
                           "body": {"kind": "vault-payment-receipt", "agentId": pins["agentId"],
                                    "vault": pins["payTo"], "asset": pins["asset"], "grossAmount": "101"}})


def sign(typed):
    return "0x" + Account.sign_message(encode_typed_data(full_message=typed), PAYER_KEY).signature.hex()


@unittest.skipIf(CRYPTO is None, "Install the explicitly pinned optional Ethereum verifier")
class VaultIncomeTests(unittest.TestCase):
    def setUp(self):
        self.profile = profile()
        self.reader, self.journal, self.transport = Reader(self.profile), Journal(), PaymentTransport(self.profile)
        self.client = self.reopen()

    def reopen(self):
        return VaultIncomeClient(profile=self.profile, verifier=CRYPTO, reader=self.reader,
                                 journal=self.journal, transport=self.transport, now=lambda: NOW)

    def authorize(self, name="first"):
        prepared = self.client.prepare(name, payer=PAYER)
        self.client.authorize(name, sign(prepared["typedData"]))
        return prepared

    def test_prepare_is_durable_original_and_never_refreshes_across_reopen(self):
        original = self.client.prepare("first", payer=PAYER)
        self.assertEqual(self.journal.state["attempts"][0]["plan"], original["plan"])
        original["plan"]["authorization"]["value"] = "999"
        self.client = self.reopen()
        same = self.client.prepare("first", payer=PAYER)
        self.assertEqual(same["plan"]["authorization"]["value"], "101")
        self.assertEqual(len(self.transport.calls), 1)
        self.assertEqual(self.client.check("first")["status"], "planned")
        with self.assertRaises(VaultIncomeError):
            self.client.prepare("first", payer=OTHER)

    def test_external_signature_exact_header_and_local_reference(self):
        plan = self.authorize()
        self.assertEqual(self.client.check("first")["status"], "authorized")
        attempt = self.journal.state["attempts"][0]
        header = json.loads(base64.b64decode(attempt["signedHeader"]))
        self.assertEqual(header["payload"]["authorization"], plan["plan"]["authorization"])
        from eth_abi import encode
        pins = self.profile["pins"]
        expected = CRYPTO.keccak256(encode(["bytes32", "uint256", "address", "address", "address", "bytes32"],
                    [CRYPTO.keccak256(b"TelomerePlatformVaultIncomeEip3009V1"), 31337, pins["asset"], pins["payTo"], PAYER,
                     bytes.fromhex(plan["plan"]["authorization"]["nonce"][2:])]))
        self.assertEqual(vault_income_authorization_ref(self.profile, PAYER, plan["plan"]["authorization"]["nonce"], CRYPTO), "0x" + expected.hex())

    def test_http_success_remains_pending_until_fresh_independent_income_and_subsidy(self):
        self.authorize()
        self.assertEqual(self.client.submit("first")["status"], "pending")
        self.reader.status = "settled"
        result = self.reopen().check("first")
        self.assertEqual(result["evidence"]["incomeFee"], "2")
        self.reader.classification = "subsidy"
        self.assertEqual(self.client.check("first")["evidence"]["incomeFee"], "0")

    def test_lost_response_preserves_bearer_and_blocks_replacement_until_exact_retry(self):
        self.authorize()
        self.transport.drop = True
        with self.assertRaises(ConnectionError):
            self.client.submit("first")
        self.assertTrue(self.journal.state["attempts"][0]["submitted"])
        with self.assertRaisesRegex(VaultIncomeError, "reconciliation_required"):
            self.reopen().prepare("replacement", payer=PAYER)
        self.reader.status = "settled"
        self.assertEqual(self.reopen().retry("first")["status"], "settled")
        self.assertEqual(self.transport.calls[-1], self.transport.calls[-2])

    def test_candidate_saved_before_rpc_failure_and_previous_success_withdrawn(self):
        self.authorize()
        self.reader.fail = True
        # check() is called before HTTP, so fail only inspection for this case.
        original = self.reader.inspect
        self.reader.fail = False
        self.reader.inspect = lambda **kwargs: (_ for _ in ()).throw(ConnectionError("lost independent receipt"))
        with self.assertRaises(ConnectionError):
            self.client.submit("first")
        attempt = self.journal.state["attempts"][0]
        self.assertEqual(attempt["candidateHash"], HASH)
        self.assertEqual(attempt["observation"]["status"], "pending")
        self.reader.inspect, self.reader.status = original, "settled"
        self.assertEqual(self.reopen().check("first")["status"], "settled")
        self.reader.fail = True
        with self.assertRaises(ConnectionError):
            self.reopen().check("first")
        self.assertEqual(self.journal.state["attempts"][0]["observation"]["status"], "pending")

    def test_immutable_candidate_rejects_changed_http_hash_after_reorg(self):
        self.authorize()
        self.client.submit("first")
        self.transport.candidate = "0x" + "b" * 64
        with self.assertRaisesRegex(VaultIncomeError, "hash_substitution"):
            self.reopen().retry("first")
        self.assertEqual(self.journal.state["attempts"][0]["candidateHash"], HASH)

    def test_durable_save_failure_cannot_expose_plan_or_success(self):
        self.journal.fail = True
        with self.assertRaises(OSError):
            self.client.prepare("first", payer=PAYER)
        self.assertIsNone(self.journal.state)
        self.authorize()
        self.journal.fail = True
        with self.assertRaises(OSError):
            self.client.submit("first")
        self.assertEqual(len(self.transport.calls), 2)
        self.assertFalse(self.journal.state["attempts"][0]["submitted"])

    def test_payer_guard_retains_reverted_bearer_until_confirmed_expiry(self):
        self.authorize()
        self.reader.status = "reverted"
        self.assertEqual(self.client.submit("first")["status"], "reverted")
        with self.assertRaisesRegex(VaultIncomeError, "reconciliation_required"):
            self.client.prepare("replacement", payer=PAYER)
        self.reader.timestamp = NOW + 120
        new = VaultIncomeClient(profile=self.profile, verifier=CRYPTO, reader=self.reader, journal=self.journal,
                                transport=self.transport, now=lambda: NOW + 120)
        self.assertEqual(new.prepare("replacement", payer=PAYER)["plan"]["operationId"], "replacement")

    def test_reorg_multiple_exact_retries_do_not_deadlock(self):
        self.authorize("first"); self.reader.status = "settled"; self.client.submit("first")
        self.authorize("second"); self.transport.candidate = "0x" + "b" * 64; self.client.submit("second")
        self.reader.status = "pending"
        self.transport.candidate = HASH
        self.assertEqual(self.reopen().retry("first")["status"], "pending")
        self.transport.candidate = "0x" + "b" * 64
        self.assertEqual(self.reopen().retry("second")["status"], "pending")
        with self.assertRaisesRegex(VaultIncomeError, "reconciliation_required"):
            self.reopen().prepare("third", payer=PAYER)

    def test_wrong_signer_tampered_journal_and_evidence_are_rejected(self):
        prepared = self.client.prepare("first", payer=OTHER)
        with self.assertRaisesRegex(VaultIncomeError, "signature_mismatch"):
            self.client.authorize("first", sign(prepared["typedData"]))
        self.journal.state["attempts"][0]["plan"]["authorization"]["value"] = "102"
        with self.assertRaises(VaultIncomeError):
            self.reopen().check("first")

    def test_nonboolean_signature_verdict_fails_closed_before_authorization(self):
        prepared = self.client.prepare("first", payer=PAYER)
        signature = sign(prepared["typedData"])
        with patch.object(CRYPTO, "verify_typed_data", return_value=1):
            with self.assertRaisesRegex(VaultIncomeError, "signature_mismatch"):
                self.client.authorize("first", signature)
        self.assertNotIn("signature", self.journal.state["attempts"][0])

    def test_wrong_original_payer_ref_or_fee_never_returns_settled(self):
        self.authorize(); self.client.submit("first"); self.reader.status = "settled"
        for key, value in (("payer", OTHER), ("paymentRef", "0x" + "0" * 64), ("incomeFee", "1"), ("netAmount", "101")):
            with self.subTest(key=key):
                self.reader.mutate = lambda result: {**result, key: value}
                with self.assertRaises(VaultIncomeError):
                    self.reopen().check("first")
                self.assertEqual(self.journal.state["attempts"][0]["observation"]["status"], "pending")

    def test_profile_pins_reader_and_clock_are_mandatory(self):
        for update in ({"reader": None}, {"journal": None}, {"verifier": None}):
            args = dict(profile=self.profile, verifier=CRYPTO, reader=self.reader, journal=self.journal)
            with self.assertRaises(VaultIncomeError):
                VaultIncomeClient(**{**args, **update})
        changed = profile(); changed["pins"]["facilitator"] = OTHER
        with self.assertRaises(VaultIncomeError):
            VaultIncomeClient(profile=changed, verifier=CRYPTO, reader=self.reader, journal=self.journal)
        self.reader.timestamp = NOW - 300
        with self.assertRaisesRegex(VaultIncomeError, "clock_skew"):
            self.client.prepare("first", payer=PAYER)
        self.assertEqual(self.transport.calls, [])

    def test_changed_reader_profile_withdraws_prior_success(self):
        self.authorize(); self.reader.status = "settled"; self.client.submit("first")
        self.reader.profile["pins"]["facilitator"] = OTHER
        with self.assertRaisesRegex(VaultIncomeError, "client_configuration"):
            self.client.check("first")
        self.assertEqual(self.journal.state["attempts"][0]["observation"]["status"], "pending")

    def test_mainnet_private_profile_fields_and_unreviewed_usdg_facet_fail_closed(self):
        variants = []
        for chain in (4663, 31338):
            value = profile(); value["pins"]["chainId"] = chain; variants.append(value)
        value = profile(); value["facilitatorKeyFile"] = "never-import-an-operator-private-profile"; variants.append(value)
        value = profile("https://controller.example/x402/vault-income")
        value["pins"]["chainId"] = value["pins"]["selection"]["chainId"] = 46630
        value["pins"]["asset"] = "0x7E955252E15c84f5768B83c41a71F9eba181802F"
        variants.append(value)
        for value in variants:
            with self.subTest(chain=value["pins"]["chainId"]), self.assertRaises((VaultIncomeError, ValueError)):
                VaultIncomeClient(profile=value, verifier=CRYPTO, reader=Reader(value), journal=self.journal)

    def test_base_usdc_eip3009_domains_and_old_signed_journal_cannot_be_rewritten(self):
        self.authorize()
        original_state = copy.deepcopy(self.journal.state)
        for chain_id in (8453, 84532):
            value = base_profile(chain_id)
            with self.subTest(chain_id=chain_id):
                base_journal = Journal()
                fresh = VaultIncomeClient(profile=value, verifier=CRYPTO, reader=Reader(value),
                                          journal=base_journal, transport=PaymentTransport(value), now=lambda: NOW)
                prepared = fresh.prepare("base-usdc", payer=PAYER)
                self.assertEqual(prepared["typedData"]["domain"], {
                    "name": PUBLIC_BASE_USDC_DOMAINS[chain_id]["name"], "version": "2", "chainId": chain_id,
                    "verifyingContract": CRYPTO.checksum_address(PUBLIC_BASE_TOKENS[chain_id])})
                fresh.authorize("base-usdc", sign(prepared["typedData"]))
                self.assertEqual(fresh.check("base-usdc")["status"], "authorized")
                altered_anchor = copy.deepcopy(value)
                altered_anchor["pins"]["archiveAnchor"]["timestamp"] = str(NOW - 29_999)
                with self.assertRaisesRegex(VaultIncomeError, "journal_invalid"):
                    VaultIncomeClient(profile=altered_anchor, verifier=CRYPTO, reader=Reader(altered_anchor),
                                      journal=base_journal, transport=PaymentTransport(altered_anchor),
                                      now=lambda: NOW).prepare("reuse-old-signature", payer=PAYER)
                for change in (lambda p: p["pins"].update(asset="0x7e955252e15c84f5768b83c41a71f9eba181802f"),
                               lambda p: p["pins"].update(reviewedTokenKind="eip1967"),
                               lambda p: p["pins"].update(assetFacet={"address": OTHER, "codeHash": HASH}),
                               lambda p: p["pins"].pop("assetImplementation"),
                               lambda p: p["pins"].pop("archiveAnchor"),
                               lambda p: p["pins"]["archiveAnchor"].update(number="0"),
                               lambda p: p["pins"]["exact"].update(name="USD Coin" if chain_id == 84532 else "USDC"),
                               lambda p: p["pins"]["exact"].update(version="1")):
                    changed = copy.deepcopy(value); change(changed)
                    with self.assertRaises((VaultIncomeError, ValueError)):
                        VaultIncomeClient(profile=changed, verifier=CRYPTO, reader=Reader(changed), journal=Journal())
                old_journal = VaultIncomeClient(profile=value, verifier=CRYPTO, reader=Reader(value),
                                                journal=self.journal, transport=PaymentTransport(value), now=lambda: NOW)
                with self.assertRaisesRegex(VaultIncomeError, "journal_invalid"):
                    old_journal.prepare("different-chain", payer=PAYER)
                self.assertEqual(self.journal.state, original_state)
        local_anchor = profile()
        local_anchor["pins"]["archiveAnchor"] = {"number": "9", "hash": HASH, "timestamp": str(NOW - 30_000)}
        with self.assertRaises(VaultIncomeError):
            VaultIncomeClient(profile=local_anchor, verifier=CRYPTO, reader=Reader(local_anchor), journal=Journal())

    def test_corrupted_signed_journal_duplicate_attempts_and_capacity_fail_closed(self):
        self.authorize()
        original = copy.deepcopy(self.journal.state)
        variants = []
        value = copy.deepcopy(original); value["attempts"][0]["signedHeader"] = "e30="; variants.append(value)
        value = copy.deepcopy(original); value["attempts"].append(copy.deepcopy(value["attempts"][0])); variants.append(value)
        value = copy.deepcopy(original); value["attempts"] *= 129; variants.append(value)
        value = copy.deepcopy(original); value["profileHash"] = "0x" + "0" * 64; variants.append(value)
        for value in variants:
            with self.subTest(attempts=len(value["attempts"])):
                self.journal.state = value
                with self.assertRaises(VaultIncomeError):
                    self.reopen().check("first")
        self.assertEqual(len(self.transport.calls), 1)

    def test_untrusted_offer_cannot_substitute_payment_terms(self):
        for field, value in (("amount", "102"), ("payTo", OTHER), ("scheme", "upto"), ("network", "eip155:46630")):
            with self.subTest(field=field):
                self.transport.mutate = lambda result: (result["required"]["accepts"][0].update({field: value}) or result)
                with self.assertRaises(VaultIncomeError):
                    self.client.prepare("first", payer=PAYER)
                self.assertIsNone(self.journal.state)

    def test_concurrent_same_instance_rejects_without_unbounded_queue(self):
        entered, release = threading.Event(), threading.Event()
        original = self.reader.check
        self.reader.check = lambda: (entered.set(), release.wait(3), original())[-1]
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(self.client.prepare, "first", payer=PAYER)
            self.assertTrue(entered.wait(2))
            try:
                with self.assertRaisesRegex(VaultIncomeError, "client_busy"):
                    self.client.prepare("second", payer=PAYER)
            finally:
                release.set()
            self.assertEqual(first.result()["plan"]["operationId"], "first")

    def test_caller_disk_journal_reopen_keeps_exact_signed_authorization(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "caller.json"
            self.journal = DiskJournal(path)
            try:
                self.client = self.reopen()
                self.authorize()
                signed = self.journal.load()["attempts"][0]["signedHeader"]
                self.journal.close(); self.journal = DiskJournal(path)
                self.reader.status = "settled"
                self.assertEqual(self.reopen().submit("first")["status"], "settled")
                self.assertEqual(self.transport.calls[-1], signed)
            finally:
                self.journal.close()


class PublicHttpTests(unittest.TestCase):
    def server(self, callback):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                try:
                    callback(self)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass

            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return "http://127.0.0.1:" + str(server.server_port) + "/x402/vault-income"

    @staticmethod
    def respond(handler, body=b"{}", headers=(), status=200):
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        for name, value in headers:
            handler.send_header(name, value)
        handler.end_headers(); handler.wfile.write(body)

    def test_actual_http_fixed_post_body_has_no_credentials_and_never_retries(self):
        requests = []
        def reply(handler):
            requests.append((handler.path, handler.rfile.read(int(handler.headers["Content-Length"])), dict(handler.headers)))
            self.respond(handler, headers=(("PAYMENT-RESPONSE", _header({"transaction": HASH})), ("Set-Cookie", "secret=never-retained")))
        http = VaultIncomePublicHttp(self.server(reply), chain_id=31337)
        self.assertEqual(http.send("c2lnbmVk")["payment"]["transaction"], HASH)
        http.send()
        self.assertEqual(len(requests), 2)
        for path, body, headers in requests:
            self.assertEqual(path, "/x402/vault-income"); self.assertEqual(body, b"{}")
            self.assertFalse({name.lower() for name in headers} & {"cookie", "authorization", "origin"})

    def test_strict_body_headers_and_credential_free_redirect_refusal(self):
        cases = [(b'{"a":1,"a":2}', ()), (b'{"a":"\\ud800"}', ()), (b'\xef\xbb\xbf{}', ()),
                 (b'\xff', ()), (b'{"a":"\\u0000"}', ()), (b'{}', (("PAYMENT-RESPONSE", "e30"),)),
                 (b'{}', (("PAYMENT-RESPONSE", _header({"x": 1})), ("PAYMENT-RESPONSE", _header({"x": 2})))),
                 (b'{}', (("Content-Length", "16385"),)), (b'{}', (("Content-Length", "01"),)),
                 (b'{}', (("Content-Length", "2"), ("Transfer-Encoding", "chunked"))), (b'x' * 16385, ())]
        for body, headers in cases:
            with self.subTest(body=body[:12], headers=[item[0] for item in headers]):
                http = VaultIncomePublicHttp(self.server(lambda handler: self.respond(handler, body, headers)), chain_id=31337)
                with self.assertRaises(VaultIncomeError):
                    http.send()
        calls = []
        def redirect(handler):
            calls.append(handler.path)
            self.respond(handler, headers=(("Location", "http://127.0.0.1:1/stolen"),), status=307)
        with self.assertRaisesRegex(VaultIncomeError, "http_invalid"):
            VaultIncomePublicHttp(self.server(redirect), chain_id=31337).send("c2lnbmVk")
        self.assertEqual(len(calls), 1)

    def test_retained_deadline_interrupts_trickling_headers_and_body(self):
        def trickle(handler):
            handler.send_response(200); handler.send_header("Content-Type", "application/json"); handler.end_headers()
            handler.wfile.write(b'{"a":"'); handler.wfile.flush()
            for _ in range(50):
                time.sleep(0.03); handler.wfile.write(b"a"); handler.wfile.flush()
        started = time.monotonic()
        with self.assertRaisesRegex(VaultIncomeError, "http_timeout"):
            VaultIncomePublicHttp(self.server(trickle), chain_id=31337, timeout=0.2).send()
        self.assertLess(time.monotonic() - started, 1)

    def test_noncanonical_resource_and_oversized_signed_header_never_connect(self):
        for url in ("http://localhost:3280/x402/vault-income", "https://EXAMPLE.com/x402/vault-income",
                    "https://example.com:443/x402/vault-income", "https://example.com/x402/vault-income?x=1",
                    "https://user:secret@example.com/x402/vault-income", "https://example.com\\bad/x402/vault-income"):
            with self.subTest(url=url), self.assertRaises(VaultIncomeError):
                VaultIncomePublicHttp(url, chain_id=31337)
        with self.assertRaisesRegex(VaultIncomeError, "request_limit"):
            VaultIncomePublicHttp("http://127.0.0.1:1/x402/vault-income", chain_id=31337).send("a" * 8193)

    def test_stalled_dns_or_connect_has_bounded_caller_and_one_worker(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        requests = []
        url = self.server(lambda handler: (requests.append(handler.path), self.respond(handler)))
        import http.client
        connect = http.client.HTTPConnection.connect
        def stalled(connection):
            entered.set()
            release.wait(2)
            try:
                connect(connection)
            finally:
                finished.set()
        http = VaultIncomePublicHttp(url, chain_id=31337, timeout=0.1)
        started = time.monotonic()
        with patch("http.client.HTTPConnection.connect", stalled):
            try:
                with self.assertRaisesRegex(VaultIncomeError, "http_timeout"):
                    http.send()
                self.assertTrue(entered.is_set())
                self.assertLess(time.monotonic() - started, 0.5)
                with self.assertRaisesRegex(VaultIncomeError, "http_busy"):
                    http.send()
            finally:
                release.set()
                self.assertTrue(finished.wait(2))
        self.assertEqual(requests, [])


if __name__ == "__main__":
    unittest.main()
