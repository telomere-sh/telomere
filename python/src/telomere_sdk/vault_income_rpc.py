"""Independent, read-only native Vault EIP-3009 canonical RPC verification."""
from __future__ import annotations

import copy
import http.client
import json
import math
import re
import socket
import ssl
import threading
import time
from typing import Any
from urllib.parse import urlsplit

from .chains import CIRCLE_IMPLEMENTATION_SLOT, PUBLIC_BASE_USDC_DOMAINS
from .crypto import CryptoVerifier, EthAccountVerifier
from .client import _address, _bytes32, _signature
from .transport import strict_json
from .vault_income import VaultIncomeError, _checksum, _digest, _exact_object, _fail, _plan, _profile, _typed_data, vault_income_authorization_ref

ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
READ_METHODS = frozenset({"eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_call",
                          "eth_getStorageAt", "eth_getRawTransactionByHash", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getLogs"})


class _RpcUnsupported(Exception):
    pass


def _quantity(value: Any, *, bits: int = 256) -> int:
    if not isinstance(value, str) or not re.fullmatch(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})", value) or int(value, 16) >= 2 ** bits:
        _fail("vault_income_rpc_invalid")
    return int(value, 16)


def _hex(value: Any, *, size: int | None = None, maximum: int = 131_072) -> bytes:
    if (not isinstance(value, str) or len(value) > 2 + 2 * maximum or not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})*", value)
            or size is not None and len(value) != 2 + 2 * size):
        _fail("vault_income_rpc_invalid")
    return bytes.fromhex(value[2:])


def _word(value: int) -> bytes:
    if type(value) is not int or not 0 <= value < 2 ** 256:
        _fail("vault_income_rpc_invalid")
    return value.to_bytes(32, "big")


def _address_word(value: str) -> bytes:
    return bytes.fromhex(_address(value)[2:]).rjust(32, b"\0")


def _decoded_address(value: bytes) -> str:
    if len(value) != 32 or value[:12] != b"\0" * 12:
        _fail("income_deployment_pin_mismatch")
    return "0x" + value[12:].hex()


class _RpcHttp:
    """One bounded public read-only JSON-RPC request; no retries or credentials."""

    def __init__(self, url: str, chain_id: int, timeout: float):
        try:
            target = urlsplit(url)
            if (not isinstance(url, str) or len(url) > 4096 or any(ord(char) <= 32 or ord(char) >= 127 for char in url)
                    or "\\" in url or target.username is not None or target.password is not None or target.fragment
                    or not target.hostname or target.scheme != "https" and not (chain_id == 31337 and target.scheme == "http"
                                                                               and target.hostname in ("127.0.0.1", "::1"))):
                raise ValueError("rpc")
            _ = target.port
        except (TypeError, ValueError):
            _fail("vault_income_rpc_required")
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 10:
            _fail("vault_income_rpc_required")
        self._url, self._timeout, self._active, self._sequence = url, timeout, threading.Lock(), 0

    def request(self, method: str, params: list[Any]) -> Any:
        if method not in READ_METHODS or not isinstance(params, list):
            _fail("vault_income_rpc_read_only")
        if not self._active.acquire(blocking=False):
            _fail("vault_income_rpc_busy")
        self._sequence += 1
        identifier = self._sequence
        try:
            data = json.dumps({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params}, allow_nan=False, separators=(",", ":")).encode()
        except (TypeError, ValueError, UnicodeError, RecursionError):
            self._active.release(); _fail("vault_income_rpc_invalid")
        if len(data) > 32_768:
            self._active.release(); _fail("vault_income_rpc_invalid")
        done, expired, result = threading.Event(), threading.Event(), []
        deadline = time.monotonic() + self._timeout

        def worker() -> None:
            try:
                result.append(self._send(data, deadline, expired))
            except Exception as error:
                result.append(error)
            finally:
                self._active.release(); done.set()

        try:
            threading.Thread(target=worker, daemon=True).start()
        except Exception:
            self._active.release(); _fail("vault_income_chain_unavailable")
        if not done.wait(max(0, deadline - time.monotonic())):
            expired.set(); _fail("vault_income_chain_unavailable")
        if isinstance(result[0], Exception):
            raise result[0]
        response = result[0]
        if (not isinstance(response, dict) or set(response) not in ({"jsonrpc", "id", "result"}, {"jsonrpc", "id", "error"})
                or response["jsonrpc"] != "2.0" or type(response["id"]) is not int or response["id"] != identifier):
            _fail("vault_income_chain_unavailable")
        if "error" in response:
            error = response["error"]
            if isinstance(error, dict) and type(error.get("code")) is int and error["code"] == -32601:
                raise _RpcUnsupported()
            _fail("vault_income_chain_unavailable")
        return response["result"]

    def _send(self, data: bytes, deadline: float, expired: threading.Event) -> Any:
        target = urlsplit(self._url)
        connection = (http.client.HTTPSConnection(target.hostname, target.port, timeout=self._timeout, context=ssl.create_default_context())
                      if target.scheme == "https" else http.client.HTTPConnection(target.hostname, target.port, timeout=self._timeout))
        timer, response = None, None
        try:
            connection.connect()
            sock = connection.sock
            if sock is None or expired.is_set() or time.monotonic() >= deadline:
                _fail("vault_income_chain_unavailable")

            def abort() -> None:
                expired.set()
                try:
                    socket.socket.shutdown(sock, socket.SHUT_RDWR)
                except OSError:
                    pass
            timer = threading.Timer(max(0.001, deadline - time.monotonic()), abort)
            timer.daemon = True; timer.start()
            path = (target.path or "/") + ("?" + target.query if target.query else "")
            connection.request("POST", path, body=data, headers={"Content-Type": "application/json", "Cache-Control": "no-store"})
            response = connection.getresponse()
            fields = response.getheaders()
            if (response.status != 200 or len(fields) > 40
                    or sum(len(name.encode()) + len(value.encode()) for name, value in fields) > 8192):
                _fail("vault_income_chain_unavailable")
            names = [name.lower() for name, _ in fields]
            if any(names.count(name) > 1 for name in ("content-type", "content-length", "transfer-encoding")):
                _fail("vault_income_chain_unavailable")
            length = response.getheader("Content-Length")
            if length is not None and (not re.fullmatch(r"0|[1-9][0-9]*", length) or len(length) > 6 or int(length) > 262_144):
                _fail("vault_income_chain_unavailable")
            if length is not None and response.getheader("Transfer-Encoding") is not None:
                _fail("vault_income_chain_unavailable")
            raw = response.read(262_145)
            if (len(raw) > 262_144 or raw.startswith(b"\xef\xbb\xbf") or expired.is_set() or time.monotonic() >= deadline
                    or length is not None and len(raw) != int(length)):
                _fail("vault_income_chain_unavailable")
            parsed = strict_json(raw)

            def strings(value: Any) -> None:
                if isinstance(value, str):
                    if "\0" in value:
                        _fail("vault_income_chain_unavailable")
                    value.encode("utf-8", "strict")
                elif isinstance(value, dict):
                    for key, item in value.items():
                        strings(key); strings(item)
                elif isinstance(value, list):
                    for item in value:
                        strings(item)
            strings(parsed)
            return parsed
        except Exception:
            _fail("vault_income_chain_unavailable")
        finally:
            if timer is not None:
                timer.cancel()
            if response is not None:
                response.close()
            connection.close()


class RpcVaultIncomeReader:
    """Concrete read-only reader. No intake API or current-balance inference.

    The supplied RPC remains a trusted canonical-chain source, rather than a
    light client. Every state call uses EIP-1898 blockHash/requireCanonical.
    Signed raw EIP-155 legacy, EIP-2930 and EIP-1559 envelopes are supported;
    only explicit -32601 permits complete signed type-2 reconstruction.
    """

    def __init__(self, rpc_url: str, *, profile: dict[str, Any], verifier: CryptoVerifier | None = None, timeout: float = 10):
        self._verifier = verifier or EthAccountVerifier()
        self._profile = _profile(profile, self._verifier)
        self._rpc = _RpcHttp(rpc_url, self._profile["pins"]["chainId"], timeout)
        try:
            from eth_account import Account
            import rlp
        except ImportError:
            _fail("vault_income_crypto_required")
        self._account, self._rlp = Account, rlp

    @property
    def profile(self) -> dict[str, Any]:
        return copy.deepcopy(self._profile)

    def _hash(self, raw: bytes) -> str:
        return "0x" + self._verifier.keccak256(raw).hex()

    def _call(self, address: str, signature: str, block: dict[str, str], arguments: bytes = b"", *, words: int = 1) -> list[bytes]:
        data = self._verifier.keccak256(signature.encode())[:4] + arguments
        raw = _hex(self._rpc.request("eth_call", [{"to": address, "data": "0x" + data.hex()}, {"blockHash": block["hash"], "requireCanonical": True}]),
                   size=32 * words)
        return [raw[index:index + 32] for index in range(0, len(raw), 32)]

    def _address_call(self, address: str, signature: str, block: dict[str, str], arguments: bytes = b"") -> str:
        return _decoded_address(self._call(address, signature, block, arguments)[0])

    def _string_call(self, address: str, signature: str, block: dict[str, str]) -> str:
        selector = self._verifier.keccak256(signature.encode())[:4]
        raw = _hex(self._rpc.request("eth_call", [{"to": address, "data": "0x" + selector.hex()},
                            {"blockHash": block["hash"], "requireCanonical": True}]), maximum=256)
        if len(raw) < 64 or len(raw) % 32 or int.from_bytes(raw[:32], "big") != 32:
            _fail("asset_pin_mismatch")
        length = int.from_bytes(raw[32:64], "big")
        padded = ((length + 31) // 32) * 32
        if length > 100 or len(raw) != 64 + padded or any(raw[64 + length:]):
            _fail("asset_pin_mismatch")
        try:
            return raw[64:64 + length].decode("utf-8", "strict")
        except UnicodeError:
            _fail("asset_pin_mismatch")

    def _code(self, address: str, block: dict[str, str]) -> bytes:
        return _hex(self._rpc.request("eth_getCode", [address, {"blockHash": block["hash"], "requireCanonical": True}]))

    def _get_block(self, height: int | str = "latest") -> dict[str, str]:
        tag = hex(height) if type(height) is int else height
        value = self._rpc.request("eth_getBlockByNumber", [tag, False])
        if not isinstance(value, dict):
            _fail("vault_income_chain_unavailable")
        number, timestamp = _quantity(value.get("number"), bits=64), _quantity(value.get("timestamp"), bits=64)
        if type(height) is int and number != height:
            _fail("chain_canonical_history_changed")
        return {"number": str(number), "hash": _bytes32(value.get("hash")), "timestamp": str(timestamp)}

    def _canonical(self, block: dict[str, str], confirmations: int = 0) -> bool:
        chain = _quantity(self._rpc.request("eth_chainId", []))
        if chain != self._profile["pins"]["chainId"]:
            _fail("chain_pin_mismatch")
        current = self._get_block(int(block["number"]))
        head = _quantity(self._rpc.request("eth_blockNumber", []), bits=64)
        return current == block and head >= int(block["number"]) and (confirmations == 0 or head - int(block["number"]) + 1 >= confirmations)

    def _archive(self, head: dict[str, str]) -> None:
        pins = self._profile["pins"]
        if pins["chainId"] == 31337:
            return
        anchor = pins["archiveAnchor"]
        if (int(head["number"]) <= int(anchor["number"])
                or int(head["timestamp"]) < int(anchor["timestamp"]) + 21_600):
            _fail("archive_history_unavailable")
        historical = self._get_block(int(anchor["number"]))
        if historical != anchor:
            _fail("archive_history_unavailable")
        self._asset(historical)
        if not self._canonical(historical):
            _fail("archive_history_unavailable")

    def _agent(self, block: dict[str, str], agent_id: str | None = None) -> dict[str, Any]:
        pins = self._profile["pins"]
        requested = agent_id or pins["agentId"]
        values = self._call(pins["selection"]["selectionRegistryAddress"], "getAgent(bytes32)", block,
                            bytes.fromhex(requested[2:]), words=21)
        for index in range(8, 14):
            if int.from_bytes(values[index], "big") >= 2 ** 64:
                _fail("income_vault_binding_mismatch")
        living, status, frozen = (int.from_bytes(values[index], "big") for index in (18, 19, 20))
        if living > 255 or status > 3 or frozen not in (0, 1):
            _fail("income_vault_binding_mismatch")
        if status != 0:
            registry = pins["selection"]["selectionRegistryAddress"]
            identity_registry = self._address_call(registry, "identityRegistry()", block)
            derived = self._hash(_word(pins["chainId"]) + _address_word(registry) + _address_word(identity_registry) + values[0])
            if derived != requested:
                _fail("income_agent_identity_mismatch")
        return {"owner": _decoded_address(values[1]), "agentWallet": _decoded_address(values[2]), "vault": _decoded_address(values[3]),
                "family": "0x" + values[6].hex(), "status": status, "frozen": bool(frozen)}

    def _facet(self, block: dict[str, str]) -> None:
        pins = self._profile["pins"]
        facet = pins["assetFacet"]
        code = self._code(facet["address"], block)
        if not code or self._hash(code) != facet["codeHash"]:
            _fail("asset_pin_mismatch")
        for selector in ("e3ee160e", "ef55bec6", "e94a0102"):
            route = self._address_call(pins["asset"], "getFacet(bytes4)", block, bytes.fromhex(selector).ljust(32, b"\0"))
            if route != _address(facet["address"]):
                _fail("asset_pin_mismatch")

    def _asset(self, block: dict[str, str]) -> None:
        pins = self._profile["pins"]
        code = self._code(pins["asset"], block)
        decimals = int.from_bytes(self._call(pins["asset"], "decimals()", block)[0], "big")
        separator = self._call(pins["asset"], "DOMAIN_SEPARATOR()", block)[0]
        expected_domain = self._verifier.keccak256(b"".join([
            self._verifier.keccak256(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            self._verifier.keccak256(pins["exact"]["name"].encode()), self._verifier.keccak256(pins["exact"]["version"].encode()),
            _word(pins["chainId"]), _address_word(pins["asset"])]))
        if not code or self._hash(code) != pins["tokenCodeHash"] or decimals != 6 or separator != expected_domain:
            _fail("asset_pin_mismatch")
        if pins["chainId"] in PUBLIC_BASE_USDC_DOMAINS:
            metadata = PUBLIC_BASE_USDC_DOMAINS[pins["chainId"]]
            if any(self._string_call(pins["asset"], field + "()", block) != expected
                   for field, expected in metadata.items()):
                _fail("asset_pin_mismatch")
        if pins["reviewedTokenKind"] in ("eip1967", "circle_proxy"):
            implementation = pins["assetImplementation"]
            slot_name = CIRCLE_IMPLEMENTATION_SLOT if pins["reviewedTokenKind"] == "circle_proxy" else IMPLEMENTATION_SLOT
            slot = _hex(self._rpc.request("eth_getStorageAt", [pins["asset"], slot_name,
                           {"blockHash": block["hash"], "requireCanonical": True}]), size=32)
            implementation_code = self._code(implementation["address"], block)
            if (_decoded_address(slot) != _address(implementation["address"]) or not implementation_code
                    or self._hash(implementation_code) != implementation["codeHash"]):
                _fail("asset_pin_mismatch")
        if "assetFacet" in pins:
            self._facet(block)

    def _deployment(self, block: dict[str, str]) -> dict[str, Any]:
        pins, selection = self._profile["pins"], self._profile["pins"]["selection"]
        registry, implementation = selection["selectionRegistryAddress"], selection["vaultImplementationAddress"]
        agent = self._agent(block)
        if agent["status"] == 0 or agent["vault"] != _address(pins["payTo"]):
            _fail("income_vault_binding_mismatch")
        registry_code, implementation_code = self._code(registry, block), self._code(implementation, block)
        clone, signer_code = self._code(pins["payTo"], block), self._code(pins["facilitator"], block)
        expected_clone = bytes.fromhex("363d3d373d3d3d363d73" + implementation[2:] + "5af43d82803e903d91602b57fd5bf3")
        if (not registry_code or self._hash(registry_code) != selection["selectionRegistryCodeHash"]
                or not implementation_code or self._hash(implementation_code) != selection["vaultImplementationCodeHash"]
                or clone != expected_clone or signer_code):
            _fail("income_deployment_pin_mismatch")
        actual = {name: self._address_call(registry, name + "()", block)
                  for name in ("token", "escrow", "controller", "treasury", "vaultImplementation")}
        implemented = {name: self._address_call(implementation, name + "()", block)
                       for name in ("token", "escrow", "controller", "treasury", "registry")}
        owner, wallet = (self._address_call(pins["payTo"], name + "()", block) for name in ("owner", "agentWallet"))
        clone_id = "0x" + self._call(pins["payTo"], "agentId()", block)[0].hex()
        wallet_id = "0x" + self._call(registry, "agentWalletAgent(address)", block, _address_word(agent["agentWallet"]))[0].hex()
        vault_id = "0x" + self._call(registry, "vaultAgent(address)", block, _address_word(pins["payTo"]))[0].hex()
        if (actual["token"] != _address(pins["asset"]) or actual["treasury"] != _address(pins["treasury"])
                or actual["vaultImplementation"] != _address(implementation) or implemented["registry"] != _address(registry)
                or any(implemented[name] != actual[name] for name in ("token", "escrow", "controller", "treasury"))
                or wallet_id != pins["agentId"] or vault_id != pins["agentId"] or clone_id != pins["agentId"]
                or owner != agent["owner"] or wallet != agent["agentWallet"]
                or _address(pins["facilitator"]) in (actual["controller"], actual["treasury"], owner, wallet)):
            _fail("income_deployment_pin_mismatch")
        return {"agentId": pins["agentId"], "owner": _checksum(owner, self._verifier), "agentWallet": _checksum(wallet, self._verifier),
                "vault": pins["payTo"], "status": agent["status"], "frozen": agent["frozen"]}

    def check(self) -> dict[str, Any]:
        try:
            pins = self._profile["pins"]
            head = _quantity(self._rpc.request("eth_blockNumber", []), bits=64)
            if head < pins["confirmations"]:
                _fail("chain_confirmation_depth")
            confirmed, latest = self._get_block(head - pins["confirmations"]), self._get_block(head)
            self._archive(latest)
            self._asset(confirmed); binding = self._deployment(confirmed)
            self._asset(latest); self._deployment(latest)
            if not self._canonical(confirmed, pins["confirmations"] + 1) or not self._canonical(latest):
                _fail("chain_canonical_history_changed")
            return {"binding": binding, "block": confirmed}
        except VaultIncomeError:
            raise
        except Exception:
            _fail("vault_income_chain_unavailable")

    def _checked_payment(self, raw: Any) -> dict[str, Any]:
        payment = _exact_object(raw, {"x402Version", "resource", "accepted", "payload"}, {"extensions"})
        if type(payment["x402Version"]) is not int or payment["x402Version"] != 2:
            _fail("payment_terms_mismatch")
        payload = _exact_object(payment["payload"], {"authorization", "signature"})
        plan = _plan({"operationId": "reader", "profileHash": _digest(self._profile), "resource": payment["resource"],
                      "accepted": payment["accepted"], "authorization": payload["authorization"]}, self._profile, self._verifier)
        if "extensions" in payment:
            extension = _exact_object(_exact_object(payment["extensions"], {"telomere-request-binding"})["telomere-request-binding"], {"version", "requestHash"})
            if type(extension["version"]) is not int or extension["version"] != 1 or extension["requestHash"] != plan["accepted"]["extra"]["telomere"]["requestHash"]:
                _fail("payment_terms_mismatch")
        signature = _signature(payload["signature"])
        if self._verifier.verify_typed_data(plan["authorization"]["from"], _typed_data(plan, self._profile), signature) is not True:
            _fail("vault_income_signature_mismatch")
        return {**payment, "resource": plan["resource"], "accepted": plan["accepted"],
                "payload": {"authorization": plan["authorization"], "signature": signature}}

    def _calldata(self, payment: dict[str, Any]) -> bytes:
        auth, signature = payment["payload"]["authorization"], bytes.fromhex(payment["payload"]["signature"][2:])
        selector = self._verifier.keccak256(b"receiveFundsWithAuthorization(address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)")[:4]
        return selector + b"".join([_address_word(auth["from"]), _word(int(auth["value"])), _word(int(auth["validAfter"])),
                                   _word(int(auth["validBefore"])), bytes.fromhex(auth["nonce"][2:]), _word(signature[64]), signature[:32], signature[32:64]])

    def _type2(self, raw: Any, transaction_hash: str) -> bytes:
        if not isinstance(raw, dict):
            _fail("income_transaction_mismatch")
        fields = {"type", "hash", "from", "chainId", "nonce", "gas", "to", "value", "input", "accessList", "maxFeePerGas", "maxPriorityFeePerGas", "yParity", "r", "s"}
        if not fields <= set(raw) or raw["type"] != "0x2":
            _fail("income_transaction_mismatch")
        if _bytes32(raw["hash"]) != transaction_hash or _address(raw["from"]) != _address(self._profile["pins"]["facilitator"]):
            _fail("income_transaction_mismatch")
        integers = {name: _quantity(raw[name]) for name in ("chainId", "nonce", "gas", "value", "maxFeePerGas", "maxPriorityFeePerGas", "yParity")}
        scalars = {name: int.from_bytes(_hex(raw[name], size=32), "big") if isinstance(raw[name], str) and len(raw[name]) == 66 else _quantity(raw[name]) for name in ("r", "s")}
        if (integers["chainId"] != self._profile["pins"]["chainId"] or integers["nonce"] > 2 ** 53 - 1
                or not 0 < integers["gas"] < 2 ** 64 or integers["maxPriorityFeePerGas"] > integers["maxFeePerGas"]
                or integers["yParity"] not in (0, 1) or "v" in raw and raw["v"] != raw["yParity"]
                or not 0 < scalars["r"] < ORDER or not 0 < scalars["s"] <= ORDER // 2):
            _fail("income_transaction_mismatch")
        access = raw["accessList"]
        if not isinstance(access, list) or len(access) > 64:
            _fail("income_transaction_mismatch")
        entries = []
        for entry in access:
            entry = _exact_object(entry, {"address", "storageKeys"})
            keys = entry["storageKeys"]
            if not isinstance(keys, list) or len(keys) > 64:
                _fail("income_transaction_mismatch")
            entries.append([bytes.fromhex(_address(entry["address"])[2:]), [_hex(key, size=32) for key in keys]])
        return b"\x02" + self._rlp.encode([integers["chainId"], integers["nonce"], integers["maxPriorityFeePerGas"], integers["maxFeePerGas"],
                   integers["gas"], bytes.fromhex(_address(raw["to"])[2:]), integers["value"], _hex(raw["input"], maximum=8191), entries,
                   integers["yParity"], scalars["r"], scalars["s"]])

    @staticmethod
    def _rlp_int(value: Any) -> int:
        if not isinstance(value, bytes) or len(value) > 32 or value[:1] == b"\0":
            _fail("income_transaction_mismatch")
        return int.from_bytes(value, "big")

    def _transaction(self, raw: bytes, transaction_hash: str, payment: dict[str, Any]) -> None:
        pins = self._profile["pins"]
        if not raw or len(raw) > 8191 or self._hash(raw) != transaction_hash:
            _fail("income_transaction_mismatch")
        kind = raw[0] if raw[0] < 0x80 else 0
        values = self._rlp.decode(raw[1:] if kind else raw, strict=True)
        if not isinstance(values, list):
            _fail("income_transaction_mismatch")
        if kind == 2 and len(values) == 12:
            chain, nonce, priority, fee, gas = (self._rlp_int(values[index]) for index in range(5))
            destination, value, data, access = values[5:9]
            parity, r, s = (self._rlp_int(values[index]) for index in range(9, 12))
            if priority > fee:
                _fail("income_transaction_mismatch")
        elif kind == 1 and len(values) == 11:
            chain, nonce, _fee, gas = (self._rlp_int(values[index]) for index in range(4))
            destination, value, data, access = values[4:8]
            parity, r, s = (self._rlp_int(values[index]) for index in range(8, 11))
        elif kind == 0 and len(values) == 9:
            nonce, _fee, gas = (self._rlp_int(values[index]) for index in range(3))
            destination, value, data = values[3:6]
            v, r, s = (self._rlp_int(values[index]) for index in range(6, 9))
            if v < 35:
                _fail("income_transaction_mismatch")
            chain, parity, access = (v - 35) // 2, (v - 35) % 2, []
        else:
            _fail("income_transaction_mismatch")
        if (chain != pins["chainId"] or nonce > 2 ** 53 - 1 or not 0 < gas < 2 ** 64 or parity not in (0, 1)
                or not 0 < r < ORDER or not 0 < s <= ORDER // 2 or not isinstance(destination, bytes) or len(destination) != 20
                or destination.hex() != pins["payTo"][2:].lower() or self._rlp_int(value) != 0
                or data != self._calldata(payment) or not isinstance(access, list) or len(access) > 64):
            _fail("income_transaction_mismatch")
        for entry in access:
            if (not isinstance(entry, list) or len(entry) != 2 or not isinstance(entry[0], bytes) or len(entry[0]) != 20
                    or not isinstance(entry[1], list) or len(entry[1]) > 64
                    or any(not isinstance(key, bytes) or len(key) != 32 for key in entry[1])):
                _fail("income_transaction_mismatch")
        if _address(self._account.recover_transaction(raw)) != _address(pins["facilitator"]):
            _fail("income_transaction_mismatch")

    def _consumption(self, payment: dict[str, Any], block: dict[str, str]) -> tuple[bool, bool]:
        pins, auth = self._profile["pins"], payment["payload"]["authorization"]
        reference = vault_income_authorization_ref(self._profile, auth["from"], auth["nonce"], self._verifier)
        used = int.from_bytes(self._call(pins["asset"], "authorizationState(address,bytes32)", block,
                                _address_word(auth["from"]) + bytes.fromhex(auth["nonce"][2:]))[0], "big")
        consumed = int.from_bytes(self._call(pins["payTo"], "usedIncomeAuthorization(bytes32)", block, bytes.fromhex(reference[2:]))[0], "big")
        if used not in (0, 1) or consumed not in (0, 1):
            _fail("income_receipt_mismatch")
        return bool(used), bool(consumed)

    def _latest_consumption(self, payment: dict[str, Any]) -> bool:
        block = self._get_block()
        self._asset(block); self._deployment(block)
        used, consumed = self._consumption(payment, block)
        if not self._canonical(block):
            _fail("chain_canonical_history_changed")
        return used or consumed

    def _missing(self, transaction_hash: str, payment: dict[str, Any]) -> dict[str, Any]:
        if self._latest_consumption(payment):
            _fail("income_authorization_reconciliation_required")
        return {"status": "pending", "transactionHash": transaction_hash}

    def _stable_facet(self, block: dict[str, str]) -> None:
        if "assetFacet" not in self._profile["pins"]:
            return
        if int(block["number"]) == 0:
            _fail("asset_pin_mismatch")
        self._facet(self._get_block(int(block["number"]) - 1))
        topics = [self._hash(b"FacetUpdate(bytes4,address)"), self._hash(b"Upgraded(address)")]
        updates = self._rpc.request("eth_getLogs", [{"address": self._profile["pins"]["asset"], "blockHash": block["hash"], "topics": [topics]}])
        if not isinstance(updates, list) or updates or not self._canonical(block):
            _fail("asset_pin_mismatch")

    def _stable_circle(self, block: dict[str, str]) -> None:
        if self._profile["pins"]["reviewedTokenKind"] != "circle_proxy":
            return
        if int(block["number"]) == 0:
            _fail("asset_pin_mismatch")
        parent = self._get_block(int(block["number"]) - 1)
        self._asset(parent)
        upgrade_topic = self._hash(b"Upgraded(address)")
        updates = self._rpc.request("eth_getLogs", [{"address": self._profile["pins"]["asset"],
                         "blockHash": block["hash"], "topics": [upgrade_topic]}])
        if not isinstance(updates, list) or updates or not self._canonical(parent) or not self._canonical(block):
            _fail("asset_pin_mismatch")

    def _classification(self, payment: dict[str, Any], block: dict[str, str], classification_index: int) -> str:
        # Match _excluded at the classification log, not end-of-block state.
        # Reviewed Selection code only adds these immutable maps at Birth.
        pins = self._profile["pins"]
        registry, source = pins["selection"]["selectionRegistryAddress"], _address(payment["payload"]["authorization"]["from"])
        agent = self._agent(block)
        excluded = (agent["owner"], agent["agentWallet"], _address(registry),
                    self._address_call(registry, "controller()", block), self._address_call(registry, "treasury()", block))
        if source in excluded:
            return "subsidy"
        if int(block["number"]) == 0:
            _fail("income_classification_history_unavailable")
        parent = self._get_block(int(block["number"]) - 1)
        code = self._code(registry, parent)
        if not code or self._hash(code) != pins["selection"]["selectionRegistryCodeHash"]:
            _fail("income_classification_history_unavailable")
        vault_id = self._call(registry, "vaultAgent(address)", parent, _address_word(source))[0]
        wallet_id = self._call(registry, "agentWalletAgent(address)", parent, _address_word(source))[0]
        birth_topic = self._hash(b"Birth(bytes32,bytes32,address,uint256,address,bytes32,uint96,bytes32)")
        births = self._rpc.request("eth_getLogs", [{"address": registry, "blockHash": block["hash"], "topics": [birth_topic]}])
        if not isinstance(births, list) or len(births) > 1024:
            _fail("income_classification_history_unavailable")
        previous, identities = -1, set()
        born_by_id = {}
        for birth in births:
            if (not isinstance(birth, dict) or birth.get("removed", False) is not False or _address(birth.get("address")) != _address(registry)
                    or _bytes32(birth.get("blockHash")) != block["hash"] or _quantity(birth.get("blockNumber"), bits=64) != int(block["number"])):
                _fail("income_classification_history_unavailable")
            _bytes32(birth.get("transactionHash")); _quantity(birth.get("transactionIndex"), bits=64)
            index = _quantity(birth.get("logIndex"), bits=64)
            topics = birth.get("topics")
            if not isinstance(topics, list) or len(topics) != 4 or index <= previous:
                _fail("income_classification_history_unavailable")
            topics = [_bytes32(topic) for topic in topics]
            data = _hex(birth.get("data"), size=160)
            if topics[0] != birth_topic or topics[1] in identities:
                _fail("income_classification_history_unavailable")
            previous = index; identities.add(topics[1])
            if index >= classification_index:
                continue
            born = self._agent(block, topics[1])
            if (born["status"] == 0 or born["owner"] != _decoded_address(bytes.fromhex(topics[3][2:]))
                    or born["vault"] != _decoded_address(data[32:64])):
                _fail("income_classification_history_unavailable")
            born_by_id[topics[1]] = born
            if born["vault"] == source:
                if vault_id != b"\0" * 32:
                    _fail("income_classification_history_unavailable")
                vault_id = bytes.fromhex(topics[1][2:])
            if born["agentWallet"] == source:
                if wallet_id != b"\0" * 32:
                    _fail("income_classification_history_unavailable")
                wallet_id = bytes.fromhex(topics[1][2:])
        related = vault_id if vault_id != b"\0" * 32 else wallet_id
        classification = "income"
        if related != b"\0" * 32:
            related_id = "0x" + related.hex()
            relative = born_by_id.get(related_id) or self._agent(parent, related_id)
            if relative["status"] == 0:
                _fail("income_classification_history_unavailable")
            if relative["family"] == agent["family"]:
                classification = "subsidy"
        if not self._canonical(parent):
            _fail("income_classification_history_unavailable")
        return classification

    def _receipt(self, receipt: dict[str, Any], transaction_hash: str, payment: dict[str, Any], block: dict[str, str]) -> tuple[str, int]:
        pins, auth = self._profile["pins"], payment["payload"]["authorization"]
        payer, gross_amount = _address(auth["from"]), int(auth["value"])
        reference = vault_income_authorization_ref(self._profile, auth["from"], auth["nonce"], self._verifier)
        events = {name: self._hash(signature.encode()) for name, signature in {
            "transfer": "Transfer(address,address,uint256)", "funds": "FundsReceived(address,uint96,uint96,bytes32)",
            "income": "Income(bytes32,uint96,uint96,address,bytes32)", "subsidy": "Subsidy(bytes32,uint96,address,bytes32)"}.items()}
        logs = receipt.get("logs")
        if not isinstance(logs, list) or len(logs) > 1024:
            _fail("income_receipt_mismatch")
        funds, classified, gross, incoming, outgoing, fee_transfer, fee, expected_fee = 0, 0, 0, 0, 0, 0, 0, 0
        classification, classification_index, seen = None, None, set()
        transaction_index = _quantity(receipt.get("transactionIndex"), bits=64)
        for log in logs:
            if not isinstance(log, dict) or log.get("removed", False) is not False:
                _fail("income_receipt_mismatch")
            index = _quantity(log.get("logIndex"), bits=64)
            if (index in seen or _bytes32(log.get("transactionHash")) != transaction_hash or _bytes32(log.get("blockHash")) != block["hash"]
                    or _quantity(log.get("blockNumber"), bits=64) != int(block["number"])
                    or _quantity(log.get("transactionIndex"), bits=64) != transaction_index):
                _fail("income_receipt_mismatch")
            seen.add(index)
            address, topics = _address(log.get("address")), log.get("topics")
            if not isinstance(topics, list) or not 0 <= len(topics) <= 4:
                _fail("income_receipt_mismatch")
            topics = [_bytes32(topic) for topic in topics]
            data = _hex(log.get("data"))
            event = topics[0] if topics else ""
            if address == _address(pins["asset"]) and event == events["transfer"]:
                if len(topics) != 3 or len(data) != 32:
                    _fail("income_receipt_mismatch")
                source, destination = (_decoded_address(bytes.fromhex(topic[2:])) for topic in topics[1:])
                amount = int.from_bytes(data, "big")
                if destination == _address(pins["payTo"]):
                    incoming += amount
                if source == _address(pins["payTo"]):
                    outgoing += amount
                if source == payer and destination == _address(pins["payTo"]):
                    gross += amount
                if source == _address(pins["payTo"]) and destination == _address(pins["treasury"]):
                    fee_transfer += amount
            elif address == _address(pins["payTo"]) and event == events["funds"]:
                if len(topics) != 2 or len(data) != 96:
                    _fail("income_receipt_mismatch")
                funds += 1
                source, amount, fee = _decoded_address(bytes.fromhex(topics[1][2:])), int.from_bytes(data[:32], "big"), int.from_bytes(data[32:64], "big")
                if source != payer or amount != gross_amount or "0x" + data[64:].hex() != reference or fee >= 2 ** 96:
                    _fail("income_receipt_mismatch")
            elif address == _address(pins["selection"]["selectionRegistryAddress"]) and event in (events["income"], events["subsidy"]):
                if len(topics) != 3 or len(data) != (96 if event == events["income"] else 64):
                    _fail("income_receipt_mismatch")
                classified += 1
                classification = "income" if event == events["income"] else "subsidy"
                classification_index = index
                amount = int.from_bytes(data[:32], "big")
                expected_fee = (gross_amount * 100 + 9999) // 10000 if classification == "income" else 0
                if (topics[1] != pins["agentId"] or _decoded_address(bytes.fromhex(topics[2][2:])) != payer
                        or amount != gross_amount or "0x" + data[-32:].hex() != reference
                        or classification == "income" and int.from_bytes(data[32:64], "big") != expected_fee):
                    _fail("income_receipt_mismatch")
        if (funds != 1 or classified != 1 or gross != gross_amount or incoming != gross_amount
                or fee != expected_fee or fee_transfer != fee or outgoing != fee or classification is None or classification_index is None):
            _fail("income_receipt_mismatch")
        return classification, classification_index

    def inspect(self, *, transaction_hash: str, payment: dict[str, Any]) -> dict[str, Any]:
        try:
            transaction_hash = _bytes32(transaction_hash)
            payment = self._checked_payment(payment)
            pins = self._profile["pins"]
            self.check()
            try:
                raw = self._rpc.request("eth_getRawTransactionByHash", [transaction_hash])
                if raw is None:
                    return self._missing(transaction_hash, payment)
                raw = _hex(raw, maximum=8191)
            except _RpcUnsupported:
                value = self._rpc.request("eth_getTransactionByHash", [transaction_hash])
                if value is None:
                    return self._missing(transaction_hash, payment)
                raw = self._type2(value, transaction_hash)
            self._transaction(raw, transaction_hash, payment)
            receipt = self._rpc.request("eth_getTransactionReceipt", [transaction_hash])
            if receipt is None:
                return self._missing(transaction_hash, payment)
            if (not isinstance(receipt, dict) or _bytes32(receipt.get("transactionHash")) != transaction_hash
                    or _address(receipt.get("from")) != _address(pins["facilitator"]) or _address(receipt.get("to")) != _address(pins["payTo"])
                    or receipt.get("status") not in ("0x0", "0x1")):
                _fail("income_receipt_mismatch")
            block = self._get_block(_quantity(receipt.get("blockNumber"), bits=64))
            if block["hash"] != _bytes32(receipt.get("blockHash")):
                return self._missing(transaction_hash, payment)
            if not self._canonical(block, pins["confirmations"]):
                return {"status": "pending", "transactionHash": transaction_hash}
            self._asset(block); self._deployment(block); self._stable_facet(block); self._stable_circle(block)
            used, consumed = self._consumption(payment, block)
            if receipt["status"] == "0x0":
                if used or consumed:
                    _fail("income_authorization_reconciliation_required")
                self.check()
                if self._latest_consumption(payment):
                    _fail("income_authorization_reconciliation_required")
                if not self._canonical(block, pins["confirmations"]):
                    return {"status": "pending", "transactionHash": transaction_hash}
                return {"status": "reverted", "transactionHash": transaction_hash, "block": block}
            classification, classification_index = self._receipt(receipt, transaction_hash, payment, block)
            if classification != self._classification(payment, block, classification_index):
                _fail("income_original_payer_classification_mismatch")
            if not used or not consumed:
                _fail("income_receipt_mismatch")
            auth = payment["payload"]["authorization"]
            gross = int(auth["value"])
            fee = (gross * 100 + 9999) // 10000 if classification == "income" else 0
            self.check()
            if not self._canonical(block, pins["confirmations"]):
                return {"status": "pending", "transactionHash": transaction_hash}
            return {"status": "settled", "transactionHash": transaction_hash, "block": block, "classification": classification,
                    "grossAmount": str(gross), "incomeFee": str(fee), "netAmount": str(gross - fee), "payer": auth["from"],
                    "paymentRef": vault_income_authorization_ref(self._profile, auth["from"], auth["nonce"], self._verifier)}
        except VaultIncomeError:
            raise
        except Exception:
            _fail("vault_income_chain_unavailable")
