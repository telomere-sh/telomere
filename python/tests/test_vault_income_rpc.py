from __future__ import annotations

import base64
import copy
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import ProxyHandler, Request, build_opener

import test_vault_income as fixtures
from test_vault_income import CRYPTO, Journal, PAYER_KEY
from test_vault_income_acceptance import FixtureControl, NativeVaultFixture
from telomere_sdk import RpcVaultIncomeReader, VaultIncomeClient, VaultIncomeError
from telomere_sdk.chains import CIRCLE_IMPLEMENTATION_SLOT, PUBLIC_BASE_USDC_DOMAINS
from telomere_sdk.vault_income_rpc import _RpcHttp


class RpcProxy:
    def __init__(self, remote):
        self.remote, self.calls, self.override = remote, [], lambda call, result: None
        self.opener = build_opener(ProxyHandler({}))
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= 32768:
                        raise ValueError("fixture input")
                    call = json.loads(self.rfile.read(length))
                    owner.calls.append(copy.deepcopy(call))
                    request = Request(owner.remote, data=json.dumps(call).encode(), headers={"Content-Type": "application/json"})
                    with owner.opener.open(request, timeout=10) as response:
                        result = json.loads(response.read(262145))
                    changed = owner.override(call, copy.deepcopy(result))
                    raw = json.dumps(changed if changed is not None else result, separators=(",", ":")).encode()
                    self.send_response(200); self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *_args):
                pass
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(2)


class NativeRpcAcceptance(NativeVaultFixture):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.control = FixtureControl(cls.config)
        cls.profile = cls.config["profile"]
        cls.reader = RpcVaultIncomeReader(cls.config["rpcUrl"], profile=cls.profile)
        cls.journal = Journal()
        client = VaultIncomeClient(profile=cls.profile, verifier=CRYPTO, reader=cls.reader, journal=cls.journal)
        prepared = client.prepare("rpc-acceptance", payer=cls.config["payer"])
        client.authorize("rpc-acceptance", cls.control.call("sign", typedData=prepared["typedData"], payer="external")["signature"])
        result = client.submit("rpc-acceptance")
        if result["status"] != "settled":
            raise RuntimeError("Direct Python fixture did not independently settle")
        cls.transaction_hash = result["transactionHash"]
        cls.payment = json.loads(base64.b64decode(cls.journal.state["attempts"][0]["signedHeader"]))
        cls.receipt = cls.reader._rpc.request("eth_getTransactionReceipt", [cls.transaction_hash])
        cls.control.call("mine", blocks=4)

    def proxy(self):
        proxy = RpcProxy(self.config["rpcUrl"])
        self.addCleanup(proxy.close)
        return proxy

    def inspect(self, proxy, *, profile=None, transaction_hash=None, payment=None):
        reader = RpcVaultIncomeReader(proxy.url, profile=profile or self.profile)
        return reader.inspect(transaction_hash=transaction_hash or self.transaction_hash, payment=payment or self.payment)

    def test_direct_python_reader_rechecks_exact_historical_receipt_and_all_hash_state_calls(self):
        proxy = self.proxy()
        result = self.inspect(proxy)
        self.assertEqual(result["status"], "settled")
        self.assertEqual(result["block"]["hash"], self.receipt["blockHash"])
        self.assertEqual((result["classification"], result["incomeFee"], result["netAmount"]), ("income", "2", "99"))
        for call in proxy.calls:
            if call["method"] in ("eth_call", "eth_getCode", "eth_getStorageAt"):
                state = call["params"][-1]
                self.assertEqual(set(state), {"blockHash", "requireCanonical"})
                self.assertIs(state["requireCanonical"], True)

    def test_wrong_chain_token_domain_decimals_and_current_deployment_pins_fail_closed(self):
        proxy = self.proxy()
        domain_selector = "0x" + CRYPTO.keccak256(b"DOMAIN_SEPARATOR()")[:4].hex()
        decimal_selector = "0x" + CRYPTO.keccak256(b"decimals()")[:4].hex()
        for reason in ("chain", "domain", "decimals", "asset", "registry", "implementation", "clone", "facilitator"):
            with self.subTest(reason=reason):
                def changed(call, response):
                    method, params = call["method"], call["params"]
                    if reason == "chain" and method == "eth_chainId":
                        return {**response, "result": "0x1"}
                    if method == "eth_call" and ((reason == "domain" and params[0]["data"] == domain_selector)
                                                or (reason == "decimals" and params[0]["data"] == decimal_selector)):
                        return {**response, "result": "0x" + "0" * 64}
                    addresses = {"asset": self.profile["pins"]["asset"], "registry": self.profile["pins"]["selection"]["selectionRegistryAddress"],
                                 "implementation": self.profile["pins"]["selection"]["vaultImplementationAddress"],
                                 "clone": self.profile["pins"]["payTo"], "facilitator": self.profile["pins"]["facilitator"]}
                    if reason in addresses and method == "eth_getCode" and params[0].lower() == addresses[reason].lower():
                        return {**response, "result": "0x00"}
                    return None
                proxy.override = changed
                with self.assertRaises(VaultIncomeError):
                    self.inspect(proxy)

    def test_historical_asset_registry_implementation_and_clone_code_cannot_be_substituted(self):
        proxy = self.proxy()
        addresses = [self.profile["pins"]["asset"], self.profile["pins"]["selection"]["selectionRegistryAddress"],
                     self.profile["pins"]["selection"]["vaultImplementationAddress"], self.profile["pins"]["payTo"]]
        for address in addresses:
            observed = []
            def changed(call, response):
                if (call["method"] == "eth_getCode" and call["params"][0].lower() == address.lower()
                        and call["params"][1]["blockHash"] == self.receipt["blockHash"]):
                    observed.append(True)
                    return {**response, "result": "0x00"}
                return None
            proxy.override = changed
            with self.subTest(address=address), self.assertRaises(VaultIncomeError):
                self.inspect(proxy)
            self.assertTrue(observed)

    def test_type2_fallback_requires_explicit_method_code_and_complete_signed_fields(self):
        proxy = self.proxy()
        def unsupported(call, response):
            if call["method"] == "eth_getRawTransactionByHash":
                return {"jsonrpc": "2.0", "id": call["id"], "error": {"code": -32601, "message": "unsupported"}}
            return None
        proxy.override = unsupported
        self.assertEqual(self.inspect(proxy)["status"], "settled")
        self.assertEqual(sum(call["method"] == "eth_getTransactionByHash" for call in proxy.calls), 1)
        for code in (-32602, -32000, -32004, -32603, 4200):
            proxy.calls.clear()
            proxy.override = lambda call, response: ({"jsonrpc": "2.0", "id": call["id"], "error": {"code": code, "message": "method not found -32601 private-key"}}
                                                    if call["method"] == "eth_getRawTransactionByHash" else None)
            with self.subTest(code=code), self.assertRaisesRegex(VaultIncomeError, "^vault_income_chain_unavailable$"):
                self.inspect(proxy)
            self.assertFalse(any(call["method"] == "eth_getTransactionByHash" for call in proxy.calls))
        for field in ("chainId", "type", "nonce", "gas", "to", "value", "input", "accessList", "maxFeePerGas", "maxPriorityFeePerGas", "yParity", "r", "s", "hash", "from"):
            def missing(call, response):
                original = unsupported(call, response)
                if original:
                    return original
                if call["method"] == "eth_getTransactionByHash":
                    del response["result"][field]
                    return response
                return None
            proxy.override = missing
            with self.subTest(field=field), self.assertRaises(VaultIncomeError):
                self.inspect(proxy)

    def test_signed_type2_reconstruction_detects_every_altered_signed_field(self):
        proxy = self.proxy()
        cases = {"chainId": "0x1", "nonce": "0x20000000000000", "gas": "0x10000000000000000", "type": "0x0",
                 "to": self.config["payer"], "from": self.config["payer"], "value": "0x1", "input": "0x1234",
                 "accessList": [{"address": self.profile["pins"]["asset"], "storageKeys": ["0x" + "0" * 64]}],
                 "maxFeePerGas": "0x1", "maxPriorityFeePerGas": "0xffffffffffffffffff", "yParity": "0x2",
                 "r": "0x0", "s": "0x" + "f" * 64, "hash": "0x" + "0" * 64}
        for field, value in cases.items():
            def changed(call, response):
                if call["method"] == "eth_getRawTransactionByHash":
                    return {"jsonrpc": "2.0", "id": call["id"], "error": {"code": -32601, "message": "unsupported"}}
                if call["method"] == "eth_getTransactionByHash":
                    response["result"][field] = value
                    return response
                return None
            proxy.override = changed
            with self.subTest(field=field), self.assertRaises(VaultIncomeError):
                self.inspect(proxy)

    def test_raw_transaction_hash_and_recovered_facilitator_are_independent(self):
        from eth_account import Account
        proxy = self.proxy()
        proxy.override = lambda call, response: {**response, "result": "0x02c0"} if call["method"] == "eth_getRawTransactionByHash" else None
        with self.assertRaisesRegex(VaultIncomeError, "transaction_mismatch"):
            self.inspect(proxy)
        raw = Account.sign_transaction({"type": 2, "chainId": 31337, "nonce": 0, "maxFeePerGas": 2_000_000_000,
                                       "maxPriorityFeePerGas": 1_000_000, "gas": 1_000_000, "to": self.profile["pins"]["payTo"],
                                       "value": 0, "data": self.reader._calldata(self.payment)}, PAYER_KEY).raw_transaction
        candidate = "0x" + CRYPTO.keccak256(raw).hex()
        proxy.override = lambda call, response: {**response, "result": "0x" + raw.hex()} if call["method"] == "eth_getRawTransactionByHash" else None
        with self.assertRaisesRegex(VaultIncomeError, "transaction_mismatch"):
            self.inspect(proxy, transaction_hash=candidate)

    def test_contradictory_markers_events_transfers_and_payer_never_return_success(self):
        proxy = self.proxy()
        marker_selectors = {"nonce": "0x" + CRYPTO.keccak256(b"authorizationState(address,bytes32)")[:4].hex(),
                            "reference": "0x" + CRYPTO.keccak256(b"usedIncomeAuthorization(bytes32)")[:4].hex()}
        for reason in ("nonce", "reference", "funds-fee", "transfer", "payer", "removed", "duplicate-log", "receipt-from", "receipt-to"):
            def changed(call, response):
                if (reason in marker_selectors and call["method"] == "eth_call" and call["params"][0]["data"].startswith(marker_selectors[reason])
                        and call["params"][1]["blockHash"] == self.receipt["blockHash"]):
                    return {**response, "result": "0x" + "0" * 64}
                if call["method"] != "eth_getTransactionReceipt":
                    return None
                receipt = response["result"]
                if reason in ("receipt-from", "receipt-to"):
                    receipt["from" if reason == "receipt-from" else "to"] = self.config["payer"]
                elif reason == "duplicate-log":
                    receipt["logs"].append(copy.deepcopy(receipt["logs"][0]))
                elif reason == "removed":
                    receipt["logs"][0]["removed"] = True
                else:
                    address = self.profile["pins"]["payTo"] if reason == "funds-fee" else self.profile["pins"]["asset"]
                    transfer_topic = "0x" + CRYPTO.keccak256(b"Transfer(address,address,uint256)").hex()
                    log = next(log for log in receipt["logs"] if log["address"].lower() == address.lower()
                               and (reason == "funds-fee" or log["topics"][0] == transfer_topic))
                    if reason == "payer":
                        log["topics"][1] = "0x" + "0" * 24 + self.config["owner"][2:].lower()
                    elif reason in ("funds-fee", "transfer"):
                        log["data"] = "0x" + "0" * (len(log["data"]) - 2)
                return response
            proxy.override = changed
            with self.subTest(reason=reason), self.assertRaises(VaultIncomeError):
                self.inspect(proxy)

    def test_lost_confirmation_depth_and_final_canonicality_withdraw_success(self):
        proxy = self.proxy()
        changed_profile = copy.deepcopy(self.profile)
        changed_profile["pins"]["confirmations"] = changed_profile["pins"]["selection"]["confirmations"] = 2
        proxy.override = lambda call, response: {**response, "result": self.receipt["blockNumber"]} if call["method"] == "eth_blockNumber" else None
        self.assertEqual(self.inspect(proxy, profile=changed_profile)["status"], "pending")
        count = []
        def final_reorg(call, response):
            if call["method"] == "eth_getBlockByNumber" and call["params"][0] == self.receipt["blockNumber"]:
                count.append(True)
                if len(count) >= 3:
                    response["result"]["hash"] = "0x" + "0" * 64
                    return response
            return None
        proxy.override = final_reorg
        self.assertEqual(self.inspect(proxy)["status"], "pending")
        self.assertGreaterEqual(len(count), 3)

    def test_missing_candidate_with_consumed_authorization_requires_reconciliation(self):
        proxy = self.proxy()
        proxy.override = lambda call, response: {**response, "result": None} if call["method"] == "eth_getRawTransactionByHash" else None
        with self.assertRaisesRegex(VaultIncomeError, "reconciliation_required"):
            self.inspect(proxy)
        self.assertFalse(any(call["method"] == "eth_getTransactionByHash" for call in proxy.calls))

    def test_original_payer_related_vault_or_wallet_cannot_be_credited_as_income(self):
        proxy = self.proxy()
        for function in ("vaultAgent(address)", "agentWalletAgent(address)"):
            selector = "0x" + CRYPTO.keccak256(function.encode())[:4].hex()
            calldata = selector + "0" * 24 + self.config["payer"][2:].lower()
            observed = []
            parent = self.reader._get_block(int(self.receipt["blockNumber"], 16) - 1)
            def changed(call, response):
                if (call["method"] == "eth_call" and call["params"][0]["data"].lower() == calldata.lower()
                        and call["params"][1]["blockHash"] == parent["hash"]):
                    observed.append(True)
                    return {**response, "result": self.profile["pins"]["agentId"]}
                return None
            proxy.override = changed
            with self.subTest(function=function), self.assertRaisesRegex(VaultIncomeError, "original_payer_classification_mismatch"):
                self.inspect(proxy)
            self.assertTrue(observed)

    def test_nonzero_related_mapping_cannot_return_unknown_or_wrong_agent_tuple(self):
        proxy = self.proxy()
        parent = self.reader._get_block(int(self.receipt["blockNumber"], 16) - 1)
        registry = self.profile["pins"]["selection"]["selectionRegistryAddress"]
        foreign_id = "0x" + "f" * 64
        lookup = "0x" + CRYPTO.keccak256(b"vaultAgent(address)")[:4].hex() + "0" * 24 + self.config["payer"][2:].lower()
        foreign_call = "0x" + CRYPTO.keccak256(b"getAgent(bytes32)")[:4].hex() + foreign_id[2:]
        correct_tuple = "0x" + b"".join(self.reader._call(registry, "getAgent(bytes32)", parent,
                                      bytes.fromhex(self.profile["pins"]["agentId"][2:]), words=21)).hex()
        for reason in ("unknown", "wrong-identity"):
            def changed(call, response):
                if call["method"] == "eth_call" and call["params"][1]["blockHash"] == parent["hash"]:
                    if call["params"][0]["data"].lower() == lookup.lower():
                        return {**response, "result": foreign_id}
                    if reason == "wrong-identity" and call["params"][0]["data"].lower() == foreign_call.lower():
                        return {**response, "result": correct_tuple}
                return None
            proxy.override = changed
            expected = "classification_history_unavailable" if reason == "unknown" else "agent_identity_mismatch"
            with self.subTest(reason=reason), self.assertRaisesRegex(VaultIncomeError, expected):
                self.inspect(proxy)

    def test_z_same_block_later_family_registration_preserves_original_income(self):
        journal = Journal()
        client = VaultIncomeClient(profile=self.profile, verifier=CRYPTO, reader=self.reader, journal=journal)
        prepared = client.prepare("before-family-birth", payer=self.config["payer"])
        client.authorize("before-family-birth", self.control.call("sign", typedData=prepared["typedData"], payer="external")["signature"])
        payment = json.loads(base64.b64decode(journal.state["attempts"][0]["signedHeader"]))
        ordered = self.control.call("payment-before-family-birth", payment=payment)
        self.assertLess(ordered["paymentIndex"], ordered["birthIndex"])
        result = self.reader.inspect(transaction_hash=ordered["paymentHash"], payment=payment)
        self.assertEqual(result["status"], "settled")
        self.assertEqual((result["classification"], result["incomeFee"], result["netAmount"]), ("income", "2", "99"))
        self.assertEqual(result["block"]["hash"], ordered["blockHash"])

    def test_wrong_payer_signature_or_request_binding_is_rejected_before_rpc(self):
        proxy = self.proxy()
        payment = copy.deepcopy(self.payment)
        payment["payload"]["authorization"]["from"] = self.config["owner"]
        with self.assertRaisesRegex(VaultIncomeError, "signature_mismatch"):
            self.inspect(proxy, payment=payment)
        payment = copy.deepcopy(self.payment)
        payment["accepted"]["extra"]["telomere"]["requestHash"] = "0x" + "0" * 64
        with self.assertRaises(VaultIncomeError):
            self.inspect(proxy, payment=payment)
        self.assertEqual(proxy.calls, [])

    def test_actual_rpc_failure_clears_client_terminal_observation_and_redacts_provider(self):
        proxy = self.proxy()
        proxy.override = lambda call, response: {"jsonrpc": "2.0", "id": call["id"], "error": {"code": -32000, "message": "private-provider-secret-path"}}
        reader = RpcVaultIncomeReader(proxy.url, profile=self.profile)
        client = VaultIncomeClient(profile=self.profile, verifier=CRYPTO, reader=reader, journal=self.journal)
        with self.assertRaisesRegex(VaultIncomeError, "^vault_income_chain_unavailable$"):
            client.check("rpc-acceptance")
        self.assertEqual(self.journal.state["attempts"][0]["observation"]["status"], "pending")


class RpcTransportTests(unittest.TestCase):
    server = fixtures.PublicHttpTests.server
    respond = staticmethod(fixtures.PublicHttpTests.respond)

    def test_rpc_is_strict_bounded_read_only_and_no_proxy_or_redirect(self):
        requests = []
        def reply(handler):
            call = json.loads(handler.rfile.read(int(handler.headers["Content-Length"])))
            requests.append((call, dict(handler.headers)))
            self.respond(handler, json.dumps({"jsonrpc": "2.0", "id": call["id"], "result": "0x7a69"}).encode())
        rpc = _RpcHttp(self.server(reply), 31337, 1)
        self.assertEqual(rpc.request("eth_chainId", []), "0x7a69")
        with self.assertRaisesRegex(VaultIncomeError, "read_only"):
            rpc.request("eth_sendRawTransaction", ["never-transmitted"])
        self.assertEqual(len(requests), 1)
        self.assertFalse({key.lower() for key in requests[0][1]} & {"cookie", "authorization"})
        for body in (b'{"jsonrpc":"2.0","id":1,"result":1,"result":2}', b'\xef\xbb\xbf{}', b'\xff', b'{"secret":"\\ud800"}', b'x' * 262145):
            with self.subTest(body=body[:10]):
                rpc = _RpcHttp(self.server(lambda handler: self.respond(handler, body)), 31337, 1)
                with self.assertRaisesRegex(VaultIncomeError, "^vault_income_chain_unavailable$"):
                    rpc.request("eth_chainId", [])

    def test_rpc_total_body_deadline_and_error_codes_are_not_remote_text(self):
        def trickle(handler):
            handler.send_response(200); handler.send_header("Content-Type", "application/json"); handler.end_headers()
            handler.wfile.write(b'{"x":"'); handler.wfile.flush()
            for _ in range(50):
                time.sleep(0.03); handler.wfile.write(b"a"); handler.wfile.flush()
        rpc = _RpcHttp(self.server(trickle), 31337, 0.2)
        started = time.monotonic()
        with self.assertRaisesRegex(VaultIncomeError, "^vault_income_chain_unavailable$"):
            rpc.request("eth_chainId", [])
        self.assertLess(time.monotonic() - started, 1)


@unittest.skipIf(CRYPTO is None, "Install the explicitly pinned optional Ethereum verifier")
class StaticRpcBoundaries(unittest.TestCase):
    """Proxy/facet branch and signed-envelope vectors, no public network."""

    def setUp(self):
        self.profile = fixtures.profile()
        self.profile["pins"]["reviewedTokenKind"] = "eip1967"
        self.codes = {self.profile["pins"]["asset"].lower(): b"pinned-proxy", "0x" + "a" * 40: b"pinned-implementation",
                      "0x" + "b" * 40: b"pinned-facet"}
        self.profile["pins"]["tokenCodeHash"] = "0x" + CRYPTO.keccak256(b"pinned-proxy").hex()
        self.profile["pins"]["assetImplementation"] = {"address": "0x" + "a" * 40, "codeHash": "0x" + CRYPTO.keccak256(b"pinned-implementation").hex()}
        self.profile["pins"]["assetFacet"] = {"address": "0x" + "b" * 40, "codeHash": "0x" + CRYPTO.keccak256(b"pinned-facet").hex()}
        self.reader = RpcVaultIncomeReader("http://127.0.0.1:1", profile=self.profile)
        self.block = {"number": "9", "hash": "0x" + format(9, "064x"), "timestamp": str(fixtures.NOW + 9)}
        self.calls, self.override = [], lambda method, params, result: result
        self.real_rpc = self.reader._rpc
        owner = self

        class Rpc:
            def request(self, method, params):
                owner.calls.append((method, copy.deepcopy(params)))
                pins = owner.profile["pins"]
                word_address = lambda address: "0x" + "0" * 24 + address[2:].lower()
                if method == "eth_getCode":
                    result = "0x" + owner.codes[params[0].lower()].hex()
                elif method == "eth_getStorageAt":
                    result = word_address(pins["assetImplementation"]["address"])
                elif method == "eth_call":
                    selector = params[0]["data"][:10]
                    if selector == "0x" + CRYPTO.keccak256(b"decimals()")[:4].hex():
                        result = "0x" + format(6, "064x")
                    elif selector == "0x" + CRYPTO.keccak256(b"DOMAIN_SEPARATOR()")[:4].hex():
                        from eth_account.messages import hash_domain
                        result = "0x" + hash_domain({"name": pins["exact"]["name"], "version": pins["exact"]["version"],
                                                    "chainId": 31337, "verifyingContract": pins["asset"]}).hex()
                    elif selector == "0x" + CRYPTO.keccak256(b"getFacet(bytes4)")[:4].hex():
                        result = word_address(pins["assetFacet"]["address"])
                    else:
                        raise AssertionError("Unexpected RPC call")
                elif method == "eth_getBlockByNumber":
                    height = int(params[0], 16)
                    result = {"number": hex(height), "hash": "0x" + format(height, "064x"), "timestamp": hex(fixtures.NOW + height)}
                elif method == "eth_getLogs":
                    result = []
                elif method == "eth_chainId":
                    result = hex(31337)
                elif method == "eth_blockNumber":
                    result = hex(20)
                else:
                    raise AssertionError("Unexpected RPC method")
                return owner.override(method, params, result)
        self.reader._rpc = Rpc()

    def test_proxy_slot_implementation_code_facet_code_and_three_routes_are_pinned(self):
        self.reader._asset(self.block)
        routes = [params[0]["data"] for method, params in self.calls if method == "eth_call" and params[0]["data"].startswith(
                    "0x" + CRYPTO.keccak256(b"getFacet(bytes4)")[:4].hex())]
        self.assertEqual(len(routes), 3)
        self.assertEqual({value[10:18] for value in routes}, {"e3ee160e", "ef55bec6", "e94a0102"})
        for method, params in self.calls:
            if method in ("eth_getCode", "eth_call", "eth_getStorageAt"):
                self.assertEqual(params[-1], {"blockHash": self.block["hash"], "requireCanonical": True})
        for reason in ("slot", "implementation-code", "facet-code", "route"):
            def changed(method, params, result):
                if reason == "slot" and method == "eth_getStorageAt":
                    return "0x" + "0" * 64
                if method == "eth_getCode" and ((reason == "implementation-code" and params[0].lower() == "0x" + "a" * 40)
                                               or (reason == "facet-code" and params[0].lower() == "0x" + "b" * 40)):
                    return "0x00"
                if reason == "route" and method == "eth_call" and params[0]["data"].startswith("0x" + CRYPTO.keccak256(b"getFacet(bytes4)")[:4].hex()):
                    return "0x" + "0" * 24 + "c" * 40
                return result
            self.override = changed
            with self.subTest(reason=reason), self.assertRaisesRegex(VaultIncomeError, "asset_pin_mismatch"):
                self.reader._asset(self.block)

    def test_facet_receipt_parent_routes_and_upgrade_logs_cannot_be_ignored(self):
        self.reader._stable_facet(self.block)
        get_logs = next(params[0] for method, params in self.calls if method == "eth_getLogs")
        self.assertEqual(get_logs["blockHash"], self.block["hash"])
        self.assertEqual(set(get_logs["topics"][0]), {"0x" + CRYPTO.keccak256(b"FacetUpdate(bytes4,address)").hex(),
                                                   "0x" + CRYPTO.keccak256(b"Upgraded(address)").hex()})
        for reason in ("parent-route", "same-block-upgrade", "canonicality"):
            def changed(method, params, result):
                if reason == "parent-route" and method == "eth_call":
                    return "0x" + "0" * 24 + "c" * 40
                if reason == "same-block-upgrade" and method == "eth_getLogs":
                    return [{"address": self.profile["pins"]["asset"]}]
                if reason == "canonicality" and method == "eth_getBlockByNumber" and params[0] == "0x9":
                    return {**result, "hash": "0x" + "f" * 64}
                return result
            self.override = changed
            with self.subTest(reason=reason), self.assertRaisesRegex(VaultIncomeError, "asset_pin_mismatch"):
                self.reader._stable_facet(self.block)

    def test_genuine_legacy_type1_type2_recovery_and_minimal_signature_scalar_reconstruction(self):
        from eth_account import Account
        from eth_account.messages import encode_typed_data
        profile = fixtures.profile(); profile["pins"]["facilitator"] = fixtures.PAYER
        reader = RpcVaultIncomeReader("http://127.0.0.1:1", profile=profile)
        journal, transport = Journal(), fixtures.PaymentTransport(profile)
        client = VaultIncomeClient(profile=profile, verifier=CRYPTO, reader=fixtures.Reader(profile), journal=journal,
                                   transport=transport, now=lambda: fixtures.NOW)
        plan = client.prepare("signed-envelope", payer=fixtures.PAYER)
        signature = "0x" + Account.sign_message(encode_typed_data(full_message=plan["typedData"]), PAYER_KEY).signature.hex()
        client.authorize("signed-envelope", signature)
        payment = json.loads(base64.b64decode(journal.state["attempts"][0]["signedHeader"]))
        data = reader._calldata(payment)
        common = {"chainId": 31337, "nonce": 0, "gas": 1_000_000, "to": reader.profile["pins"]["payTo"], "value": 0, "data": data}
        for kind in ("legacy", 1, 2):
            fields = {"gasPrice": 2_000_000_000} if kind in ("legacy", 1) else {"maxFeePerGas": 2_000_000_000, "maxPriorityFeePerGas": 1_000_000}
            if kind != "legacy":
                fields.update({"type": kind, "accessList": []})
            signed = Account.sign_transaction({**common, **fields}, PAYER_KEY)
            reader._transaction(signed.raw_transaction, "0x" + signed.hash.hex(), payment)
        for nonce in range(128):
            fields = {**common, "nonce": nonce, "type": 2, "accessList": [], "maxFeePerGas": 2_000_000_000, "maxPriorityFeePerGas": 1_000_000}
            signed = Account.sign_transaction(fields, PAYER_KEY)
            if len(hex(signed.r)) < 66 or len(hex(signed.s)) < 66:
                raw = {"type": "0x2", "hash": "0x" + signed.hash.hex(), "from": fixtures.PAYER, "chainId": hex(31337), "nonce": hex(nonce),
                       "gas": hex(common["gas"]), "to": common["to"], "value": "0x0", "input": "0x" + data.hex(), "accessList": [],
                       "maxFeePerGas": hex(2_000_000_000), "maxPriorityFeePerGas": hex(1_000_000), "yParity": hex(signed.v),
                       "r": hex(signed.r), "s": hex(signed.s)}
                reconstructed = reader._type2(raw, raw["hash"])
                self.assertEqual(reconstructed, signed.raw_transaction)
                reader._transaction(reconstructed, raw["hash"], payment)
                raw["nonce"] = "0x00"
                with self.assertRaises(VaultIncomeError):
                    reader._type2(raw, raw["hash"])
                break
        else:
            self.fail("No deterministic leading-zero signature scalar vector found")


@unittest.skipIf(CRYPTO is None, "Install the explicitly pinned optional Ethereum verifier")
class CircleProxyBoundaries(unittest.TestCase):
    def test_base_proxy_slot_metadata_domain_and_historical_code_are_pinned(self):
        from eth_account.messages import hash_domain

        def encoded_text(value):
            raw = value.encode("utf-8")
            return "0x" + (32).to_bytes(32, "big").hex() + len(raw).to_bytes(32, "big").hex() + raw.hex().ljust(64, "0")

        for chain_id in (8453, 84532):
            profile = fixtures.base_profile(chain_id)
            pins = profile["pins"]
            proxy_code, implementation_code = b"circle-proxy", b"reviewed-circle-implementation"
            pins["tokenCodeHash"] = "0x" + CRYPTO.keccak256(proxy_code).hex()
            pins["assetImplementation"]["codeHash"] = "0x" + CRYPTO.keccak256(implementation_code).hex()
            reader = RpcVaultIncomeReader("https://rpc.example", profile=profile)
            parent = {"number": "8", "hash": "0x" + "8" * 64, "timestamp": str(fixtures.NOW - 30_001)}
            old = {"number": "9", "hash": "0x" + "9" * 64, "timestamp": str(fixtures.NOW - 30_000)}
            current = {"number": "20", "hash": "0x" + "a" * 64, "timestamp": str(fixtures.NOW + 11)}
            calls = []
            tamper = None

            class Rpc:
                def request(self, method, params):
                    calls.append((method, copy.deepcopy(params)))
                    block_hash = params[-1]["blockHash"] if method in ("eth_getCode", "eth_getStorageAt", "eth_call") else None
                    if method == "eth_getCode":
                        address = params[0].lower()
                        code = proxy_code if address == pins["asset"].lower() else implementation_code
                        return "0x" + code.hex()
                    if method == "eth_getStorageAt":
                        if params[1] != CIRCLE_IMPLEMENTATION_SLOT:
                            raise AssertionError("Circle slot substituted with EIP-1967")
                        address = pins["assetImplementation"]["address"]
                        if (tamper == "slot" and block_hash == old["hash"]
                                or tamper == "parent-slot" and block_hash == parent["hash"]):
                            address = pins["payTo"]
                        return "0x" + "00" * 12 + address[2:].lower()
                    if method == "eth_call":
                        selector = params[0]["data"]
                        for field in ("name", "symbol", "version"):
                            if selector == "0x" + CRYPTO.keccak256((field + "()").encode())[:4].hex():
                                value = PUBLIC_BASE_USDC_DOMAINS[chain_id][field]
                                if tamper == field and block_hash == old["hash"]:
                                    value += " changed"
                                return encoded_text(value)
                        if selector == "0x" + CRYPTO.keccak256(b"decimals()")[:4].hex():
                            return "0x" + format(6, "064x")
                        if selector == "0x" + CRYPTO.keccak256(b"DOMAIN_SEPARATOR()")[:4].hex():
                            value = {"name": pins["exact"]["name"], "version": "2", "chainId": chain_id,
                                     "verifyingContract": pins["asset"]}
                            if tamper == "domain" and block_hash == old["hash"]:
                                value["name"] += " changed"
                            return "0x" + hash_domain(value).hex()
                    if method == "eth_getBlockByNumber":
                        number = int(params[0], 16)
                        selected = {8: parent, 9: old, 20: current}[number]
                        if tamper == "anchor-hash" and number == 9:
                            selected = {**selected, "hash": "0x" + "f" * 64}
                        if tamper == "anchor-timestamp" and number == 9:
                            selected = {**selected, "timestamp": str(int(selected["timestamp"]) + 1)}
                        return {"number": hex(number), "hash": selected["hash"], "timestamp": hex(int(selected["timestamp"]))}
                    if method == "eth_chainId":
                        return hex(chain_id)
                    if method == "eth_blockNumber":
                        return hex(30)
                    if method == "eth_getLogs":
                        return [{"changed": True}] if tamper == "upgrade" else []
                    raise AssertionError("Unexpected Circle RPC read")

            reader._rpc = Rpc()
            with self.subTest(chain_id=chain_id):
                reader._asset(current)
                reader._asset(old)
                reader._archive(current)
                self.assertTrue(any(method == "eth_getCode" and params[1] ==
                                    {"blockHash": old["hash"], "requireCanonical": True} for method, params in calls))
                self.assertTrue(all(params[-1] == {"blockHash": block["hash"], "requireCanonical": True}
                                    for method, params in calls if method in ("eth_getCode", "eth_getStorageAt", "eth_call")
                                    for block in (old, current) if params[-1]["blockHash"] == block["hash"]))
                storage_slots = [params[1] for method, params in calls if method == "eth_getStorageAt"]
                self.assertGreaterEqual(len(storage_slots), 3)
                self.assertTrue(all(slot == CIRCLE_IMPLEMENTATION_SLOT for slot in storage_slots))
                for reason in ("slot", "name", "symbol", "version", "domain"):
                    tamper = reason
                    with self.subTest(reason=reason), self.assertRaisesRegex(VaultIncomeError, "asset_pin_mismatch"):
                        reader._asset(old)
                for reason in ("anchor-hash", "anchor-timestamp", "slot", "name", "domain"):
                    tamper = reason
                    with self.subTest(reason=reason), self.assertRaises(VaultIncomeError):
                        reader._archive(current)
                tamper = None
                with self.assertRaisesRegex(VaultIncomeError, "archive_history_unavailable"):
                    reader._archive({**current, "timestamp": str(int(old["timestamp"]) + 21_599)})
                tamper = None
                reader._stable_circle(old)
                self.assertTrue(any(method == "eth_getLogs" and params[0]["blockHash"] == old["hash"]
                                    and params[0]["topics"] == ["0x" + CRYPTO.keccak256(b"Upgraded(address)").hex()]
                                    for method, params in calls))
                for reason in ("parent-slot", "upgrade"):
                    tamper = reason
                    with self.subTest(reason=reason), self.assertRaisesRegex(VaultIncomeError, "asset_pin_mismatch"):
                        reader._stable_circle(old)
                tamper = None


if __name__ == "__main__":
    unittest.main()
