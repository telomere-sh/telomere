from __future__ import annotations

import copy
import json
import pathlib
import sys
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
from telomere_sdk import ApiError, ApiTransport, DeploymentPins, EthAccountVerifier, TelomereClient
from telomere_sdk.client import QUOTE_FIELDS, _typed
from telomere_sdk.chains import PUBLIC_BASE_EXPLORERS, PUBLIC_BASE_RPCS, PUBLIC_BASE_TOKENS
from telomere_sdk.transport import MAX_CYST_BODY_BYTES, normalize_origin

FIXTURE = json.loads((pathlib.Path(__file__).parent / "fixtures" / "viem.json").read_text(encoding="utf-8"))
OWNER = FIXTURE["owner"].lower()
RUN_ID, LEASH_ID = FIXTURE["quote"]["quote"]["runId"], FIXTURE["leash"]["id"]
PINS = DeploymentPins(31337, FIXTURE["config"]["escrowAddress"], FIXTURE["config"]["token"]["address"], FIXTURE["config"]["receiptSigner"])
try:
    CRYPTO = EthAccountVerifier()
except RuntimeError:
    CRYPTO = None


def run_view(status="queued"):
    return {"id": RUN_ID, "owner": OWNER, "status": status, "ceiling": "500", "charged": None,
            "refund": None, "billableSeconds": 0}


class FakeTransport:
    origin = "http://127.0.0.1:3280"

    def __init__(self):
        self.responses = {"/api/config": FIXTURE["config"], "/api/me": {"address": OWNER, "demo": False},
                          "/api/balance": {"available": "10000", "reserved": "500"},
                          "/api/leashes": {"leashes": [FIXTURE["leash"]]}, "/api/runs": {"runs": [run_view()]},
                          f"/api/runs/{RUN_ID}": run_view(), "/api/operations": {"worker": {"state": "idle"}},
                          "/api/quotes": FIXTURE["quote"], "/api/receipts/verify": {"valid": True, "anchored": True},
                          f"/api/runs/{RUN_ID}/stop": {"transaction": FIXTURE["actions"]["stop"]},
                          f"/api/runs/{RUN_ID}/refund": {"transaction": FIXTURE["actions"]["refund"]},
                          f"/api/leashes/{LEASH_ID}/kill": {"transaction": FIXTURE["actions"]["kill"]},
                          f"/api/leashes/{LEASH_ID}/update": FIXTURE["actions"]["update"],
                          "/api/transactions/deposit?amount=500": FIXTURE["actions"]["deposit"],
                          "/api/transactions/withdraw?amount=500": FIXTURE["actions"]["withdraw"],
                          "/api/auth/demo": {"address": OWNER, "demo": True}, "/api/auth/logout": {"ok": True}}
        self.calls = []
        self.cleared = False
        self.override = None

    def request(self, path, *, method="GET", body=None, idempotency_key=None):
        self.calls.append((path, method, copy.deepcopy(body), idempotency_key))
        if self.override is not None:
            result = self.override(path, method, body)
            if result is not None:
                return copy.deepcopy(result)
        if path == "/api/leashes" and method == "POST":
            return copy.deepcopy(FIXTURE["actions"]["create"])
        if path == "/api/runs" and method == "POST":
            return run_view()
        return copy.deepcopy(self.responses[path])

    def clear_session(self):
        self.cleared = True


class FixtureServer:
    def __init__(self):
        self.requests = []
        self.response = lambda path: (200, {}, json.dumps({"ok": True}).encode())
        instance = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.handle_request()

            def do_POST(self):
                self.handle_request()

            def handle_request(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                instance.requests.append((self.path, self.command, dict(self.headers), body))
                status, headers, output = instance.response(self.path)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                try:
                    self.wfile.write(output)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server, cls.other = FixtureServer(), FixtureServer()

    @classmethod
    def tearDownClass(cls):
        cls.server.close(); cls.other.close()

    def setUp(self):
        self.server.requests.clear(); self.other.requests.clear()
        self.server.response = lambda path: (200, {}, b'{"ok":true}')
        self.transport = ApiTransport(self.server.origin, timeout=2)

    def test_real_http_cookie_and_origin_header(self):
        token = "ab" * 32
        self.server.response = lambda path: (200, {"Set-Cookie": f"telomere_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800"}, b'{"ok":true}')
        self.transport.request("/api/auth/demo", method="POST", body={})
        self.transport.request("/api/me")
        self.assertEqual(self.server.requests[0][2]["Origin"], self.server.origin)
        self.assertNotIn("Cookie", self.server.requests[0][2])
        self.assertEqual(self.server.requests[1][2]["Cookie"], f"telomere_session={token}")
        self.transport.clear_session()
        self.transport.request("/api/me")
        self.assertNotIn("Cookie", self.server.requests[-1][2])

    def test_session_cookie_requires_exact_scope(self):
        for attributes in ("Domain=evil.example; Path=/; HttpOnly; SameSite=Strict; Max-Age=100", "Path=/other; HttpOnly; SameSite=Strict; Max-Age=100",
                           "Path=/; SameSite=Strict; Max-Age=100", "Path=/; HttpOnly; SameSite=Lax; Max-Age=100", "Path=/; HttpOnly; SameSite=Strict; Max-Age=999999"):
            with self.subTest(attributes=attributes):
                self.server.response = lambda path, attrs=attributes: (200, {"Set-Cookie": f"telomere_session={'ab' * 32}; {attrs}"}, b'{}')
                self.transport.request("/api/auth/demo", method="POST", body={})
                self.transport.request("/api/me")
                self.assertNotIn("Cookie", self.server.requests[-1][2])

    def test_redirect_never_reaches_other_origin(self):
        self.server.response = lambda path: (302, {"Location": self.other.origin + "/api/me", "Set-Cookie": f"telomere_session={'ab' * 32}; Path=/; HttpOnly; SameSite=Strict; Max-Age=100"}, b'{}')
        with self.assertRaisesRegex(ApiError, "redirect_rejected"):
            self.transport.request("/api/auth/verify", method="POST", body={"signature": "sensitive-fixture"})
        self.assertEqual(len(self.other.requests), 0)

    def test_header_and_stream_size_limits(self):
        for headers, body in (({"Content-Length": "1048577"}, b'{}'), ({}, b' ' * 1048577)):
            with self.subTest(headers=headers):
                self.server.response = lambda path, h=headers, b=body: (200, h, b)
                with self.assertRaisesRegex(ApiError, "response_limit"):
                    self.transport.request("/api/me")

    def test_rejects_invalid_utf8_duplicate_keys_and_nonfinite_json(self):
        for body in (b'"\xff"', b'{"valid":true,"valid":false}', b'{"fee":NaN}', b'{"fee":Infinity}', b'not-json'):
            with self.subTest(body=body):
                self.server.response = lambda path, b=body: (200, {}, b)
                with self.assertRaisesRegex(ApiError, "invalid_response"):
                    self.transport.request("/api/me")

    def test_error_redaction_and_no_post_retry(self):
        self.server.response = lambda path: (503, {}, b'{"title":"provider_failed","detail":"private-api-token"}')
        with self.assertRaises(ApiError) as caught:
            self.transport.request("/api/quotes", method="POST", body={}, idempotency_key="same_key_123")
        self.assertNotIn("private", str(caught.exception))
        self.assertEqual(caught.exception.code, "provider_failed")
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.server.requests[0][2]["Idempotency-Key"], "same_key_123")

    def test_untrusted_error_code_is_redacted(self):
        self.server.response = lambda path: (401, {}, b'{"title":"private-token=abcdef"}')
        with self.assertRaises(ApiError) as caught:
            self.transport.request("/api/me")
        self.assertEqual(caught.exception.code, "request_failed")

    def test_invalid_paths_headers_and_bodies_never_dispatch(self):
        for path in ("https://evil.example/api/me", "//evil/api/me", "/api/../me", "/api/%2e%2e/me", "/api/%2f/evil", "/api/me\nCookie:secret"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.transport.request(path)
        for body in ({"text": "a" * 196609}, {"fee": float("nan")}):
            with self.subTest(body_type=type(body)), self.assertRaises(ValueError):
                self.transport.request("/api/quotes", method="POST", body=body)
        with self.assertRaises(ValueError):
            self.transport.request("/api/quotes", method="POST", idempotency_key="key\nCookie:secret")
        self.assertEqual(len(self.server.requests), 0)

    def test_timeout_is_bounded_and_redacted(self):
        def slow(path):
            time.sleep(0.15)
            return 200, {}, b'{}'
        self.server.response = slow
        started = time.monotonic()
        with self.assertRaisesRegex(ApiError, "transport_unavailable"):
            ApiTransport(self.server.origin, timeout=0.05).request("/api/me")
        self.assertLess(time.monotonic() - started, 1)

    def test_slow_trickle_body_and_chunk_headers_obey_total_deadline_then_release_session_and_lock(self):
        token, rejected_token = "ab" * 32, "cd" * 32
        blob_path = "/api/cyst-registry/agents/0x" + "1" * 64 + "/checkpoints/0x" + "2" * 64 + "/blob"
        for framing in ("content-length", "chunked"):
            with self.subTest(framing=framing):
                requests = []

                class Handler(BaseHTTPRequestHandler):
                    def do_POST(self):
                        self.rfile.read(int(self.headers.get("Content-Length", "0")))
                        self.respond()

                    def do_GET(self):
                        self.respond()

                    def respond(self):
                        requests.append((self.path, self.headers.get("Cookie")))
                        body = b'{"ok":true}'
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        if self.path == "/api/auth/demo":
                            self.send_header("Set-Cookie", f"telomere_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600")
                        elif self.path == blob_path:
                            self.send_header("Set-Cookie", f"telomere_session={rejected_token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600")
                        if self.path == blob_path and framing == "chunked":
                            self.send_header("Transfer-Encoding", "chunked")
                            # read1() alone cannot enforce a deadline inside a trickled chunk-header line.
                            remainder = body[1:]
                            output = b"1;slow=" + b"a" * 50 + b"\r\n" + body[:1] + b"\r\n" + format(len(remainder), "x").encode("ascii") + b"\r\n" + remainder + b"\r\n0\r\n\r\n"
                        else:
                            self.send_header("Content-Length", str(len(body)))
                            output = body
                        self.end_headers()
                        try:
                            if self.path == blob_path:
                                for byte in output:
                                    self.wfile.write(bytes([byte])); self.wfile.flush(); time.sleep(0.01)
                            else:
                                self.wfile.write(output)
                        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                            pass

                    def log_message(self, *args):
                        pass

                server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
                server.daemon_threads = True
                thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
                try:
                    transport = ApiTransport(f"http://127.0.0.1:{server.server_port}", timeout=0.05)
                    transport.request("/api/auth/demo", method="POST", body={})
                    started = time.monotonic()
                    with self.assertRaisesRegex(ApiError, "transport_unavailable") as caught:
                        transport.request(blob_path, max_response_bytes=MAX_CYST_BODY_BYTES)
                    self.assertLess(time.monotonic() - started, 0.5)
                    self.assertEqual(str(caught.exception), "Telomere request failed (503: transport_unavailable)")
                    result, completed = [], threading.Event()

                    def following_request():
                        try:
                            result.append(transport.request("/api/me"))
                        except Exception as error:
                            result.append(error)
                        finally:
                            completed.set()

                    following = threading.Thread(target=following_request, daemon=True); following.start()
                    self.assertTrue(completed.wait(1), "A different caller could not reacquire the transport lock")
                    following.join(timeout=0.1)
                    self.assertEqual(result, [{"ok": True}])
                    self.assertEqual(requests, [("/api/auth/demo", None), (blob_path, f"telomere_session={token}"),
                                                ("/api/me", f"telomere_session={token}")])
                finally:
                    server.shutdown(); server.server_close(); thread.join()

    def test_origin_scope_and_production_https(self):
        for origin in ("http://evil.example", "https://user:secret@example.com", "https://example.com/path", "https://example.com?q=1", "https://example.com/#secret", "http://127.0.0.1\n", "https://example.com:wrong"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                normalize_origin(origin)
        self.assertEqual(normalize_origin("https://EXAMPLE.com:443/"), "https://example.com")
        self.assertEqual(normalize_origin("http://[::1]:3280/"), "http://[::1]:3280")


class ReadClientTests(unittest.TestCase):
    def setUp(self):
        self.transport = FakeTransport()
        self.client = TelomereClient(self.transport.origin, transport=self.transport, clock=lambda: FIXTURE["epoch"])

    def test_standard_library_reads_and_config_copy(self):
        config = self.client.config()
        config["token"]["address"] = "changed"
        self.assertEqual(self.client.config()["token"]["address"], FIXTURE["config"]["token"]["address"])
        self.assertEqual(self.client.me()["address"], OWNER)
        self.assertEqual(self.client.balance()["reserved"], "500")
        self.assertEqual(len(self.client.leashes()["leashes"]), 1)
        self.assertEqual(self.client.runs()["runs"][0]["id"], RUN_ID)
        self.assertEqual(self.client.run(RUN_ID)["status"], "queued")
        self.assertEqual(self.client.operations()["worker"]["state"], "idle")

    def test_demo_requires_explicit_opt_in(self):
        with self.assertRaises(ValueError):
            self.client.authenticate_demo()
        self.assertFalse(any(call[0] == "/api/auth/demo" for call in self.transport.calls))
        self.assertTrue(self.client.authenticate_demo(explicitly_enabled=True)["demo"])

    def test_foreign_injected_transport_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "exact client origin"):
            TelomereClient("https://other.example", transport=self.transport)

    def test_base_modes_pin_native_usdc_and_old_rails_fail_before_wallet_work(self):
        for chain_id in (4663, 46630, 1, True):
            with self.subTest(chain_id=chain_id):
                self.transport.responses["/api/config"] = copy.deepcopy(FIXTURE["config"])
                self.transport.responses["/api/config"]["chain"]["id"] = chain_id
                with self.assertRaises(ValueError):
                    self.client.config()
                with self.assertRaises(ValueError):
                    DeploymentPins(chain_id, PINS.escrow_address, PINS.token_address, PINS.receipt_signer)
        obsolete = copy.deepcopy(FIXTURE["config"])
        obsolete["mode"], obsolete["chain"]["id"] = "testnet", 46630
        self.transport.responses["/api/config"] = obsolete
        self.transport.calls.clear()
        signatures = []
        with self.assertRaises(ValueError):
            TelomereClient(self.transport.origin, transport=self.transport).authenticate(
                OWNER, chain_id=46630, sign_message=lambda message: signatures.append(message) or "0x")
        self.assertEqual(signatures, [])
        self.assertEqual([method for _, method, *_ in self.transport.calls if method == "POST"], [])
        self.transport.origin = "https://pilot.example"
        for mode, chain_id in (("testnet", 84532), ("mainnet", 8453)):
            config = copy.deepcopy(FIXTURE["config"])
            config["mode"], config["chain"]["id"] = mode, chain_id
            config["chain"]["rpcUrl"] = PUBLIC_BASE_RPCS[chain_id]
            config["chain"]["explorerUrl"] = PUBLIC_BASE_EXPLORERS[chain_id]
            implementation = {"address": "0x" + "a" * 40, "codeHash": "0x" + "b" * 64}
            config["token"].update(address=PUBLIC_BASE_TOKENS[chain_id], symbol="USDC",
                                   codeHash="0x" + "c" * 64, implementation=implementation)
            self.transport.responses["/api/config"] = config
            with self.subTest(mode=mode):
                pins = DeploymentPins(chain_id, PINS.escrow_address, PUBLIC_BASE_TOKENS[chain_id], PINS.receipt_signer,
                                      config["token"]["codeHash"], implementation)
                self.assertEqual(TelomereClient(self.transport.origin, pins=pins, transport=self.transport).config()["chain"]["id"], chain_id)
                self.transport.origin = "http://127.0.0.1:3280"
                self.assertEqual(TelomereClient(self.transport.origin, pins=pins, transport=self.transport).config()["chain"]["id"], chain_id)
                self.transport.origin = "https://pilot.example"
                with self.assertRaises(ValueError):
                    TelomereClient(self.transport.origin, transport=self.transport).config()
                with self.assertRaises(ValueError):
                    DeploymentPins(chain_id, PINS.escrow_address, PUBLIC_BASE_TOKENS[chain_id], PINS.receipt_signer)
                for change in (lambda c: c["token"].update(address="0x7e955252e15c84f5768b83c41a71f9eba181802f"),
                               lambda c: c["token"].update(symbol="USDG"),
                               lambda c: c["chain"].update(rpcUrl="https://rpc.testnet.chain.robinhood.com"),
                               lambda c: c["chain"].update(explorerUrl="https://wrong.example"),
                               lambda c: c["token"].update(codeHash="0x" + "d" * 64),
                               lambda c: c["token"]["implementation"].update(address="0x" + "e" * 40),
                               lambda c: c.update(mode="mainnet" if mode == "testnet" else "testnet")):
                    changed = copy.deepcopy(config); change(changed)
                    self.transport.responses["/api/config"] = changed
                    with self.assertRaises(ValueError):
                        TelomereClient(self.transport.origin, pins=pins, transport=self.transport).config()

    def test_wallet_intents_require_pins_and_crypto_before_dispatch(self):
        for client in (self.client, TelomereClient(self.transport.origin, pins=PINS, transport=self.transport)):
            with self.subTest(client=client), self.assertRaises(ValueError):
                client.prepare_stop(RUN_ID)
        self.assertEqual(len(self.transport.calls), 0)

    def test_no_crypto_means_only_server_reported_receipt_claims(self):
        checked = self.client.verify_receipt(FIXTURE["receipt"])
        self.assertIsNone(checked.signature_verified)
        self.assertTrue(checked.server_anchored)
        self.assertFalse(checked.onchain_verified)

    def test_bad_bounds_and_unknown_run_status_fail_closed(self):
        for value in ("01", "-1", str(2 ** 96), True):
            with self.subTest(value=value):
                self.transport.responses["/api/balance"] = {"available": value, "reserved": "0"}
                with self.assertRaises(ValueError):
                    self.client.balance()
        self.transport.responses[f"/api/runs/{RUN_ID}"]["status"] = "execute_arbitrary_code"
        with self.assertRaisesRegex(ValueError, "Unknown run status"):
            self.client.run(RUN_ID)

    def test_oversized_injected_response_is_rejected(self):
        self.transport.responses["/api/operations"] = {"output": "a" * 1048577}
        with self.assertRaisesRegex(ValueError, "body limit"):
            self.client.operations()

    def test_logout_clears_local_session_even_if_request_fails(self):
        self.transport.override = lambda path, method, body: (_ for _ in ()).throw(ApiError(503, "offline"))
        with self.assertRaises(ApiError):
            self.client.logout()
        self.assertTrue(self.transport.cleared)


@unittest.skipIf(CRYPTO is None, "Install the explicit crypto extra to verify real cross-language signatures")
class CryptographicClientTests(unittest.TestCase):
    def setUp(self):
        self.transport = FakeTransport()
        self.now = FIXTURE["epoch"]
        self.client = TelomereClient(self.transport.origin, pins=PINS, verifier=CRYPTO, transport=self.transport, clock=lambda: self.now)

    def test_cross_language_quote_signature_workload_hash_and_exact_abi(self):
        quoted = self.client.quote(FIXTURE["input"], idempotency_key="python_quote_001")
        self.assertEqual(quoted.wallet_action.intents[0].data, FIXTURE["quote"]["transaction"]["data"])
        self.assertEqual(quoted.quote["workloadHash"], FIXTURE["quote"]["quote"]["workloadHash"])
        self.assertEqual(quoted.ceiling, "500")
        from eth_account import Account
        from eth_account.messages import encode_typed_data
        domain = FIXTURE["receipt"]["domain"]
        signed = Account.sign_message(encode_typed_data(full_message=_typed(domain, "Quote", QUOTE_FIELDS, quoted.quote)), bytes.fromhex("11" * 32))
        self.assertEqual("0x" + bytes(signed.message_hash).hex(), FIXTURE["quoteDigest"])

    def test_all_wallet_intents_match_existing_solidity_abi(self):
        self.assertEqual(self.client.prepare_stop(RUN_ID).intents[0].data, FIXTURE["actions"]["stop"]["data"])
        self.assertEqual(self.client.prepare_refund(RUN_ID).intents[0].data, FIXTURE["actions"]["refund"]["data"])
        self.assertEqual(self.client.prepare_kill(LEASH_ID).intents[0].data, FIXTURE["actions"]["kill"]["data"])
        self.assertEqual(self.client.prepare_deposit("500").intents[0].data, FIXTURE["actions"]["deposit"]["transactions"][0]["data"])
        self.assertEqual(self.client.prepare_withdraw("500").intents[0].data, FIXTURE["actions"]["withdraw"]["transaction"]["data"])
        created = self.client.prepare_leash(max_per_hour="1000", max_per_day="2000", expiry=FIXTURE["expiry"], agent=FIXTURE["agent"])
        self.assertEqual(created.intents[0].data, FIXTURE["actions"]["create"]["transaction"]["data"])
        updated = self.client.prepare_update_leash(LEASH_ID, max_per_hour="1500", max_per_day="2500", expiry=FIXTURE["expiry"])
        self.assertEqual(updated.intents[0].data, FIXTURE["actions"]["update"]["transaction"]["data"])

    def test_update_preserves_agent_and_refuses_replacement(self):
        self.transport.responses[f"/api/leashes/{LEASH_ID}/update"] = copy.deepcopy(FIXTURE["actions"]["update"])
        self.transport.responses[f"/api/leashes/{LEASH_ID}/update"]["agent"] = OWNER
        with self.assertRaisesRegex(ValueError, "delegated agent"):
            self.client.prepare_update_leash(LEASH_ID, max_per_hour="1500", max_per_day="2500", expiry=FIXTURE["expiry"])

    def test_rejects_calldata_target_value_and_extra_fields(self):
        for field, value in (("data", FIXTURE["actions"]["refund"]["data"]), ("to", OWNER), ("value", "0x1"), ("gas", "0xffff")):
            with self.subTest(field=field):
                self.transport.responses[f"/api/runs/{RUN_ID}/stop"] = {"transaction": copy.deepcopy(FIXTURE["actions"]["stop"])}
                self.transport.responses[f"/api/runs/{RUN_ID}/stop"]["transaction"][field] = value
                with self.assertRaises(ValueError):
                    self.client.prepare_stop(RUN_ID)

    def test_concurrent_quote_calls_have_one_post_and_immutable_quote_copy(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.client.quote(FIXTURE["input"], idempotency_key="python_quote_same"), range(2)))
        self.assertIs(results[0], results[1])
        self.assertEqual(sum(call[0] == "/api/quotes" for call in self.transport.calls), 1)
        modified = results[0].quote
        modified["payer"] = FIXTURE["agent"]
        self.assertEqual(results[0].quote["payer"], OWNER)

    def test_idempotency_key_cannot_change_input_even_after_failed_post(self):
        failed_once = [True]
        def failure(path, method, body):
            if path == "/api/quotes" and failed_once[0]:
                failed_once[0] = False
                raise ApiError(503, "offline")
        self.transport.override = failure
        with self.assertRaises(ApiError):
            self.client.quote(FIXTURE["input"], idempotency_key="python_uncertain")
        modified = copy.deepcopy(FIXTURE["input"]); modified["maxSeconds"] = 6
        with self.assertRaisesRegex(ValueError, "original request"):
            self.client.quote(modified, idempotency_key="python_uncertain")
        self.assertEqual(self.client.quote(FIXTURE["input"], idempotency_key="python_uncertain").ceiling, "500")

    def test_rejects_expired_quote_and_reused_cached_expiry(self):
        quoted = self.client.quote(FIXTURE["input"], idempotency_key="python_expiry_001")
        self.now = quoted.quote["quoteExpiry"]
        with self.assertRaisesRegex(ValueError, "expired"):
            self.client.quote(FIXTURE["input"], idempotency_key="python_expiry_001")
        with self.assertRaisesRegex(ValueError, "published tariff"):
            self.client.quote(FIXTURE["input"], idempotency_key="python_expiry_002")

    def test_bad_signature_and_changed_quote_terms_fail_closed(self):
        for field, value in (("workloadHash", "0x" + "aa" * 32), ("payer", FIXTURE["agent"]), ("pricePerSecond", "101"), ("maxSeconds", 6)):
            with self.subTest(field=field):
                self.transport.responses["/api/quotes"] = copy.deepcopy(FIXTURE["quote"])
                self.transport.responses["/api/quotes"]["quote"][field] = value
                with self.assertRaises(ValueError):
                    self.client.quote(FIXTURE["input"], idempotency_key=f"python_bad_{field}")
        self.transport.responses["/api/quotes"] = copy.deepcopy(FIXTURE["quote"])
        self.transport.responses["/api/quotes"]["signature"] = "0x" + "01" * 64 + "1b"
        with self.assertRaises(ValueError):
            self.client.quote(FIXTURE["input"], idempotency_key="python_bad_signature")

    def test_unknown_task_utf8_bound_and_boolean_numbers_never_dispatch(self):
        for task in ({"kind": "shell", "command": "rm -rf /"}, {"kind": "sha256", "text": "🧬" * 2049}, {"kind": "sort", "numbers": [True]}, {"kind": "sha256", "text": "ok", "execute": True}):
            with self.subTest(task_kind=task["kind"]):
                value = {**FIXTURE["input"], "task": task}
                with self.assertRaises(ValueError):
                    self.client.quote(value, idempotency_key="python_unknown_task")
        self.assertFalse(any(call[0] == "/api/quotes" for call in self.transport.calls))

    def test_admission_requires_original_checked_quote_and_original_transaction(self):
        quoted = self.client.quote(FIXTURE["input"], idempotency_key="python_admit_001")
        tx_hash = "0x" + "aa" * 32
        self.assertEqual(self.client.admit(quoted, tx_hash)["id"], RUN_ID)
        with self.assertRaisesRegex(ValueError, "original admission"):
            self.client.admit(quoted, "0x" + "bb" * 32)
        with self.assertRaisesRegex(ValueError, "original quote"):
            self.client.admit(replace(quoted, ceiling="999"), tx_hash)

    def test_local_receipt_signature_billing_and_server_anchor_are_separate(self):
        result = self.client.verify_receipt(FIXTURE["receipt"])
        self.assertTrue(result.signature_verified)
        self.assertTrue(result.body_consistent)
        self.assertTrue(result.server_anchored)
        self.assertFalse(result.onchain_verified)
        changed = copy.deepcopy(FIXTURE["receipt"])
        changed["body"]["billing"]["charged"] = "201"
        checked = self.client.verify_receipt(changed)
        self.assertFalse(checked.signature_verified)
        self.assertFalse(checked.body_consistent)
        self.assertTrue(checked.server_valid)  # A lying server cannot manufacture local verification.

    def test_owner_authentication_verifies_exact_challenge_before_signer(self):
        from eth_account import Account
        from eth_account.messages import encode_defunct
        issued = datetime.fromtimestamp(self.now, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        expires = datetime.fromtimestamp(self.now + 300, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        nonce = "ab" * 24
        message = (f"127.0.0.1:3280 wants you to sign in to Telomere:\n{FIXTURE['owner']}\n\nAuthorize this browser session. No token transfer.\n\n"
                   f"URI: {self.transport.origin}\nVersion: 1\nChain ID: 31337\nNonce: {nonce}\nIssued At: {issued}\nExpiration Time: {expires}")
        self.transport.responses["/api/auth/challenge"] = {"nonce": nonce, "message": message}
        self.transport.responses["/api/auth/verify"] = {"address": OWNER, "demo": False}
        calls = []
        def signer(text):
            calls.append(text)
            return "0x" + bytes(Account.sign_message(encode_defunct(text=text), bytes.fromhex("22" * 32)).signature).hex()
        self.assertEqual(self.client.authenticate(OWNER, chain_id=31337, sign_message=signer)["address"], OWNER)
        self.assertEqual(calls, [message])
        for changed in (message.replace("No token transfer.", "Approve token transfer."), message.replace("Chain ID: 31337", "Chain ID: 4663"), message.replace("URI: http://127.0.0.1:3280", "URI: https://evil.example")):
            self.transport.responses["/api/auth/challenge"]["message"] = changed
            with self.assertRaisesRegex(ValueError, "changed scope"):
                self.client.authenticate(OWNER, chain_id=31337, sign_message=signer)
        self.assertEqual(len(calls), 1)

    def test_reviewed_pins_and_budget_bounds(self):
        wrong_pins = replace(PINS, receipt_signer=OWNER)
        with self.assertRaisesRegex(ValueError, "reviewed pins"):
            TelomereClient(self.transport.origin, pins=wrong_pins, verifier=CRYPTO, transport=self.transport).config()
        for hour, day, expiry in (("0", "1", FIXTURE["expiry"]), ("2", "1", FIXTURE["expiry"]), ("1", "2", self.now), ("1", "2", self.now + 30 * 86400 + 1)):
            with self.subTest(hour=hour, expiry=expiry), self.assertRaises(ValueError):
                self.client.prepare_leash(max_per_hour=hour, max_per_day=day, expiry=expiry)
        self.assertFalse(any(call[0] == "/api/leashes" and call[1] == "POST" for call in self.transport.calls))


if __name__ == "__main__":
    unittest.main()
