"""Checked native Vault EIP-3009 payer with caller-owned durable storage.

An independent reader is mandatory. This module does not implement Ethereum RPC,
store signing keys, submit EVM transactions, or infer settlement from HTTP.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import http.client
import json
import math
import re
import socket
import ssl
import threading
import time
import uuid
from typing import Any, Callable, Protocol, TypeVar
from urllib.parse import urlsplit

from .chains import LOCAL_CHAIN_ID, PUBLIC_BASE_TOKENS, PUBLIC_BASE_USDC_DOMAINS, SUPPORTED_CHAIN_IDS
from .client import _address, _bytes32, _canonical, _integer, _object, _signature, _typed
from .crypto import CryptoVerifier
from .transport import strict_json

T = TypeVar("T")
FIELDS = (("from", "address"), ("to", "address"), ("value", "uint256"),
          ("validAfter", "uint256"), ("validBefore", "uint256"), ("nonce", "bytes32"))


class VaultIncomeError(RuntimeError):
    """Bounded error code without remote response bodies or bearer signatures."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class VaultIncomeJournalTransaction(Protocol):
    def load(self) -> Any: ...
    def save(self, state: dict[str, Any]) -> None: ...


class VaultIncomeJournal(Protocol):
    """Serialize every owner of a scope; atomically flush save before returning.

    A successful save MUST survive a later callback exception. The caller owns
    privacy, process ownership, cross-process exclusion and crash recovery.
    There is intentionally no default memory or production file implementation.
    """

    def exclusive(self, scope: str, callback: Callable[[VaultIncomeJournalTransaction], T]) -> T: ...


class VaultIncomeReader(Protocol):
    """Trusted independent canonical evidence boundary; never use the intake API.

    check verifies current and confirmed native token/proxy/facet/domain/code,
    Selection implementation/clone/agent bindings and canonical block depth.
    inspect rechecks exact original signed transaction bytes, recovered pinned
    facilitator, chain/destination/calldata/value, historical deployment pins,
    canonical receipt/depth, original authorization/ref consumption and exact
    Income/Subsidy events plus token transfer conservation. Original-payer
    exclusions must be applied at the classification log's position, using
    canonical parent state and ordered changes when the block changes a mapping.
    Reverts require canonical depth and unused authorization/ref markers.
    Terminal evidence is fresh on every call, including after freeze or Death.
    """

    profile: dict[str, Any]

    def check(self) -> dict[str, Any]: ...
    def inspect(self, *, transaction_hash: str, payment: dict[str, Any]) -> dict[str, Any]: ...


class VaultIncomeTransport(Protocol):
    resource_url: str

    def send(self, signed_header: str | None = None) -> dict[str, Any]: ...


def _fail(code: str) -> None:
    raise VaultIncomeError(code)


def _uint(value: Any, *, bits: int = 256, positive: bool = False) -> str:
    if (not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,77}", value)
            or int(value) >= 2 ** bits or positive and value == "0"):
        _fail("vault_income_integer_invalid")
    return value


def _id(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,64}", value):
        _fail("vault_income_operation_invalid")
    return value


def _text(value: Any, minimum: int, maximum: int) -> str:
    if not isinstance(value, str) or not minimum <= len(value) <= maximum or "\0" in value:
        _fail("vault_income_text_invalid")
    try:
        value.encode("utf-8", "strict")
    except UnicodeError:
        _fail("vault_income_text_invalid")
    return value


def _exact_object(raw: Any, required: set[str], optional: set[str] | None = None) -> dict[str, Any]:
    value = _object(raw)
    if not required <= set(value) or set(value) - required - (optional or set()):
        _fail("vault_income_fields_invalid")
    return copy.deepcopy(value)


def _digest(value: Any) -> str:
    return "0x" + hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _url(value: Any, chain_id: int) -> str:
    _text(value, 1, 2048)
    try:
        parsed = urlsplit(value)
        origin = parsed.scheme + "://" + parsed.netloc
        if (parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment
                or "?" in value or "#" in value or parsed.path != "/x402/vault-income"
                or any(ord(char) <= 32 or ord(char) >= 127 for char in value) or "\\" in value
                or parsed.hostname is None or parsed.hostname != parsed.hostname.lower()
                or parsed.netloc != parsed.netloc.lower() or parsed.port in (80 if parsed.scheme == "http" else 443,)
                or parsed.scheme != "https" and not (chain_id == 31337 and parsed.scheme == "http"
                                                     and parsed.hostname in ("127.0.0.1", "::1"))
                or origin + parsed.path != value):
            raise ValueError("url")
    except (ValueError, TypeError):
        _fail("vault_income_url_invalid")
    return value


def _checksum(value: Any, verifier: CryptoVerifier) -> str:
    checked = verifier.checksum_address(_address(value))
    if _address(checked) != _address(value):
        _fail("vault_income_verifier_invalid")
    return checked


def _profile(raw: Any, verifier: CryptoVerifier) -> dict[str, Any]:
    value = _exact_object(raw, {"resourceUrl", "grossAmount", "pins"})
    value["grossAmount"] = _uint(value["grossAmount"], bits=96, positive=True)
    pins = _exact_object(value["pins"], {"chainId", "asset", "tokenCodeHash", "payTo", "facilitator",
                          "reviewedTokenKind", "confirmations", "exact", "selection", "agentId", "treasury"},
                         {"assetImplementation", "assetFacet", "archiveAnchor"})
    if type(pins["chainId"]) is not int or pins["chainId"] not in SUPPORTED_CHAIN_IDS:
        _fail("vault_income_chain_invalid")
    value["resourceUrl"] = _url(value["resourceUrl"], pins["chainId"])
    for name in ("asset", "payTo", "facilitator", "treasury"):
        pins[name] = _checksum(pins[name], verifier)
    for name in ("tokenCodeHash", "agentId"):
        pins[name] = _bytes32(pins[name])
    _integer(pins["confirmations"], 1, 64)
    exact = _exact_object(pins["exact"], {"reviewedEip3009", "name", "version"})
    if exact["reviewedEip3009"] is not True:
        _fail("vault_income_pins_invalid")
    _text(exact["name"], 1, 100); _text(exact["version"], 1, 30)
    selection = _exact_object(pins["selection"], {"chainId", "confirmations", "selectionRegistryAddress",
                             "selectionRegistryCodeHash", "vaultImplementationAddress", "vaultImplementationCodeHash"})
    if (type(selection["chainId"]) is not int or type(selection["confirmations"]) is not int
            or selection["chainId"] != pins["chainId"] or selection["confirmations"] != pins["confirmations"]):
        _fail("vault_income_pins_invalid")
    for name in ("selectionRegistryAddress", "vaultImplementationAddress"):
        selection[name] = _checksum(selection[name], verifier)
    for name in ("selectionRegistryCodeHash", "vaultImplementationCodeHash"):
        selection[name] = _bytes32(selection[name])
    if (pins["reviewedTokenKind"] not in ("immutable", "eip1967", "circle_proxy")
            or (pins["reviewedTokenKind"] in ("eip1967", "circle_proxy")) != ("assetImplementation" in pins)
            or pins["reviewedTokenKind"] == "circle_proxy" and "assetFacet" in pins):
        _fail("vault_income_pins_invalid")
    for name in ("assetImplementation", "assetFacet"):
        if name in pins:
            sub = _exact_object(pins[name], {"address", "codeHash"})
            sub["address"], sub["codeHash"] = _checksum(sub["address"], verifier), _bytes32(sub["codeHash"])
            pins[name] = sub
    if "archiveAnchor" in pins:
        anchor = _exact_object(pins["archiveAnchor"], {"number", "hash", "timestamp"})
        anchor["number"] = _uint(anchor["number"], bits=64, positive=True)
        anchor["timestamp"] = _uint(anchor["timestamp"], bits=64, positive=True)
        anchor["hash"] = _bytes32(anchor["hash"])
        pins["archiveAnchor"] = anchor
    if (pins["chainId"] == LOCAL_CHAIN_ID and "archiveAnchor" in pins
            or pins["chainId"] != LOCAL_CHAIN_ID and "archiveAnchor" not in pins):
        _fail("vault_income_pins_invalid")
    if pins["chainId"] != LOCAL_CHAIN_ID and (_address(pins["asset"]) != PUBLIC_BASE_TOKENS[pins["chainId"]]
            or pins["reviewedTokenKind"] != "circle_proxy"
            or exact["name"] != PUBLIC_BASE_USDC_DOMAINS[pins["chainId"]]["name"]
            or exact["version"] != PUBLIC_BASE_USDC_DOMAINS[pins["chainId"]]["version"]):
        _fail("vault_income_pins_invalid")
    pins["exact"], pins["selection"] = exact, selection
    value["pins"] = pins
    return value


def _block(raw: Any) -> dict[str, str]:
    value = _exact_object(raw, {"number", "hash", "timestamp"})
    for name in ("number", "timestamp"):
        _uint(value[name], bits=64)
    value["hash"] = _bytes32(value["hash"])
    return value


def _snapshot(raw: Any, profile: dict[str, Any]) -> dict[str, Any]:
    value = _exact_object(raw, {"block", "binding"})
    value["block"] = _block(value["block"])
    binding = _exact_object(value["binding"], {"agentId", "owner", "agentWallet", "vault", "status", "frozen"})
    if (_bytes32(binding["agentId"]) != profile["pins"]["agentId"]
            or _address(binding["vault"]) != _address(profile["pins"]["payTo"])):
        _fail("vault_income_reader_binding_mismatch")
    _address(binding["owner"]); _address(binding["agentWallet"])
    _integer(binding["status"], 1, 3)
    if type(binding["frozen"]) is not bool:
        _fail("vault_income_reader_binding_mismatch")
    return value


def _resource(raw: Any) -> dict[str, Any]:
    value = _exact_object(raw, {"url"}, {"description", "mimeType"})
    _text(value["url"], 1, 2048)
    for name, maximum in (("description", 512), ("mimeType", 128)):
        if name in value:
            _text(value[name], 0, maximum)
    return value


def _requirements(raw: Any, verifier: CryptoVerifier) -> dict[str, Any]:
    value = _exact_object(raw, {"scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds", "extra"})
    if value["scheme"] != "exact" or not isinstance(value["network"], str) or not re.fullmatch(r"eip155:[1-9][0-9]{0,15}", value["network"]):
        _fail("vault_income_plan_mismatch")
    value["asset"], value["payTo"] = _checksum(value["asset"], verifier), _checksum(value["payTo"], verifier)
    _uint(value["amount"]); _integer(value["maxTimeoutSeconds"], 1, 3600)
    extra = _exact_object(value["extra"], {"name", "version", "assetTransferMethod", "facilitatorAddress", "telomere"})
    _text(extra["name"], 1, 100); _text(extra["version"], 1, 30)
    extra["facilitatorAddress"] = _checksum(extra["facilitatorAddress"], verifier)
    binding = _exact_object(extra["telomere"], {"challengeId", "nonce", "requestHash"})
    if not isinstance(binding["challengeId"], str):
        _fail("vault_income_challenge_invalid")
    try:
        if str(uuid.UUID(binding["challengeId"])) != binding["challengeId"].lower():
            raise ValueError("uuid")
    except ValueError:
        _fail("vault_income_challenge_invalid")
    binding["nonce"], binding["requestHash"] = _bytes32(binding["nonce"]), _bytes32(binding["requestHash"])
    extra["telomere"], value["extra"] = binding, extra
    return value


def _plan(raw: Any, profile: dict[str, Any], verifier: CryptoVerifier) -> dict[str, Any]:
    value = _exact_object(raw, {"operationId", "profileHash", "resource", "accepted", "authorization"})
    _id(value["operationId"])
    value["resource"], value["accepted"] = _resource(value["resource"]), _requirements(value["accepted"], verifier)
    auth = _exact_object(value["authorization"], {"from", "to", "value", "validAfter", "validBefore", "nonce"})
    auth["from"], auth["to"] = _checksum(auth["from"], verifier), _checksum(auth["to"], verifier)
    for name in ("value", "validAfter", "validBefore"):
        _uint(auth[name])
    auth["nonce"] = _bytes32(auth["nonce"])
    pins, terms, extra = profile["pins"], value["accepted"], value["accepted"]["extra"]
    request_hash = _digest({"method": "POST", "url": profile["resourceUrl"], "body": hashlib.sha256(b"{}").hexdigest()})
    if (value["profileHash"] != _digest(profile) or value["resource"]["url"] != profile["resourceUrl"]
            or terms["network"] != "eip155:" + str(pins["chainId"]) or terms["asset"] != pins["asset"]
            or terms["payTo"] != pins["payTo"] or terms["amount"] != profile["grossAmount"]
            or extra["assetTransferMethod"] != "eip3009" or extra["facilitatorAddress"] != pins["facilitator"]
            or extra["name"] != pins["exact"]["name"] or extra["version"] != pins["exact"]["version"]
            or extra["telomere"]["requestHash"] != request_hash or auth["to"] != pins["payTo"]
            or auth["value"] != profile["grossAmount"] or auth["nonce"] != extra["telomere"]["nonce"]
            or not 0 < int(auth["validBefore"]) - int(auth["validAfter"]) <= 420):
        _fail("vault_income_plan_mismatch")
    value["authorization"] = auth
    return value


def _typed_data(plan: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    pins = profile["pins"]
    return _typed({"name": pins["exact"]["name"], "version": pins["exact"]["version"],
                   "chainId": pins["chainId"], "verifyingContract": pins["asset"]},
                  "TransferWithAuthorization", FIELDS, copy.deepcopy(plan["authorization"]))


def _payment(plan: dict[str, Any], signature: str) -> dict[str, Any]:
    return {"x402Version": 2, "resource": copy.deepcopy(plan["resource"]), "accepted": copy.deepcopy(plan["accepted"]),
            "payload": {"authorization": copy.deepcopy(plan["authorization"]), "signature": signature},
            "extensions": {"telomere-request-binding": {"version": 1, "requestHash": plan["accepted"]["extra"]["telomere"]["requestHash"]}}}


def _header(value: Any) -> str:
    return base64.b64encode(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()).decode("ascii")


def _inspection(raw: Any) -> dict[str, Any]:
    value = _exact_object(raw, {"status", "transactionHash"}, {"block", "classification", "grossAmount", "incomeFee", "netAmount", "paymentRef", "payer"})
    if value["status"] not in ("pending", "settled", "reverted"):
        _fail("vault_income_evidence_invalid")
    value["transactionHash"] = _bytes32(value["transactionHash"])
    if "block" in value:
        value["block"] = _block(value["block"])
    if "classification" in value and value["classification"] not in ("income", "subsidy"):
        _fail("vault_income_evidence_invalid")
    for name in ("grossAmount", "incomeFee", "netAmount"):
        if name in value:
            _uint(value[name], bits=96)
    if "paymentRef" in value:
        value["paymentRef"] = _bytes32(value["paymentRef"])
    if "payer" in value:
        _address(value["payer"])
    if value["status"] == "reverted" and "block" not in value:
        _fail("vault_income_evidence_invalid")
    return value


def vault_income_authorization_ref(profile: dict[str, Any], payer: str, nonce: str, verifier: CryptoVerifier) -> str:
    """Exact ABI/keccak reference shared with the native Solidity ingress."""
    pins = _profile(profile, verifier)["pins"]
    domain = verifier.keccak256(b"TelomerePlatformVaultIncomeEip3009V1")
    words = [domain, pins["chainId"].to_bytes(32, "big")]
    words += [bytes.fromhex(_address(value)[2:]).rjust(32, b"\0") for value in (pins["asset"], pins["payTo"], payer)]
    words.append(bytes.fromhex(_bytes32(nonce)[2:]))
    return "0x" + verifier.keccak256(b"".join(words)).hex()


def _strict(raw: bytes) -> Any:
    if raw.startswith(b"\xef\xbb\xbf"):
        _fail("vault_income_http_invalid")
    value = strict_json(raw)

    def strings(item: Any) -> None:
        if isinstance(item, str):
            _text(item, 0, 16_384)
        elif isinstance(item, dict):
            for key, child in item.items():
                strings(key); strings(child)
        elif isinstance(item, list):
            for child in item:
                strings(child)
    strings(value)
    return value


def _decode_header(value: str) -> Any:
    if (not value or len(value) > 8192
            or not re.fullmatch(r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?", value)):
        _fail("vault_income_http_invalid")
    try:
        raw = base64.b64decode(value, validate=True)
        if base64.b64encode(raw).decode("ascii") != value:
            _fail("vault_income_http_invalid")
        return _strict(raw)
    except (ValueError, UnicodeError):
        _fail("vault_income_http_invalid")


class VaultIncomePublicHttp:
    """Fixed public POST, no credentials/proxies/redirects, bounded entire I/O."""

    def __init__(self, resource_url: str, *, chain_id: int, timeout: float = 10.0):
        self.resource_url = _url(resource_url, chain_id)
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 10:
            _fail("vault_income_http_configuration")
        self.timeout = timeout
        self._active = threading.Lock()

    def send(self, signed_header: str | None = None) -> dict[str, Any]:
        if signed_header is not None and (not isinstance(signed_header, str) or len(signed_header) > 8192
                                           or not re.fullmatch(r"[A-Za-z0-9+/=]+", signed_header)):
            _fail("vault_income_request_limit")
        if not self._active.acquire(blocking=False):
            _fail("vault_income_http_busy")
        # Python's system DNS resolver cannot be interrupted with a socket
        # timeout. Bound caller latency in one daemon worker, and retain the
        # busy guard until it exits; repeated timeouts cannot grow worker count.
        done, cancelled = threading.Event(), threading.Event()
        result: list[Any] = []
        deadline = time.monotonic() + self.timeout

        def worker() -> None:
            try:
                result.append(self._send(signed_header, deadline, cancelled))
            except Exception as error:
                result.append(error)
            finally:
                self._active.release()
                done.set()

        thread = threading.Thread(target=worker, daemon=True)
        try:
            thread.start()
        except Exception:
            self._active.release()
            _fail("vault_income_http_invalid")
        if not done.wait(max(0, deadline - time.monotonic())):
            cancelled.set()
            _fail("vault_income_http_timeout")
        if isinstance(result[0], Exception):
            raise result[0]
        return result[0]

    def _send(self, signed_header: str | None, deadline: float, expired: threading.Event) -> dict[str, Any]:
        target = urlsplit(self.resource_url)
        connection = (http.client.HTTPSConnection(target.hostname, target.port, timeout=self.timeout, context=ssl.create_default_context())
                      if target.scheme == "https" else http.client.HTTPConnection(target.hostname, target.port, timeout=self.timeout))
        response: http.client.HTTPResponse | None = None
        timer: threading.Timer | None = None
        try:
            connection.connect()
            connection_socket = connection.sock
            if connection_socket is None or expired.is_set() or time.monotonic() >= deadline:
                _fail("vault_income_http_timeout")

            def abort() -> None:
                expired.set()
                try:
                    socket.socket.shutdown(connection_socket, socket.SHUT_RDWR)
                except OSError:
                    pass

            timer = threading.Timer(max(0.001, deadline - time.monotonic()), abort)
            timer.daemon = True; timer.start()
            headers = {"Content-Type": "application/json", "Cache-Control": "no-store"}
            if signed_header is not None:
                headers["PAYMENT-SIGNATURE"] = signed_header
            connection.request("POST", target.path, body=b"{}", headers=headers)
            response = connection.getresponse()
            if 300 <= response.status <= 399:
                _fail("vault_income_http_invalid")
            fields = response.getheaders()
            if len(fields) > 40 or sum(len(name.encode()) + len(value.encode()) for name, value in fields) > 8192:
                _fail("vault_income_http_invalid")
            names = [name.lower() for name, _value in fields]
            if any(names.count(name) > 1 for name in ("content-type", "content-length", "transfer-encoding", "payment-required", "payment-response")):
                _fail("vault_income_http_invalid")
            if not re.fullmatch(r"application/json(?:\s*;\s*charset=utf-8)?", response.getheader("Content-Type", ""), re.I):
                _fail("vault_income_http_invalid")
            length = response.getheader("Content-Length")
            if length is not None and (not re.fullmatch(r"0|[1-9][0-9]*", length) or len(length) > 5 or int(length) > 16_384):
                _fail("vault_income_http_invalid")
            if length is not None and response.getheader("Transfer-Encoding") is not None:
                _fail("vault_income_http_invalid")
            result: dict[str, Any] = {"status": response.status}
            for name, key in (("PAYMENT-REQUIRED", "required"), ("PAYMENT-RESPONSE", "payment")):
                encoded = response.getheader(name)
                if encoded is not None:
                    result[key] = _decode_header(encoded)
            body = response.read(16_385)
            if expired.is_set() or time.monotonic() >= deadline:
                _fail("vault_income_http_timeout")
            if len(body) > 16_384 or length is not None and len(body) != int(length):
                _fail("vault_income_http_invalid")
            result["body"] = _strict(body)
            return result
        except VaultIncomeError:
            raise
        except Exception:
            _fail("vault_income_http_timeout" if expired.is_set() or time.monotonic() >= deadline else "vault_income_http_invalid")
        finally:
            if timer is not None:
                timer.cancel()
            if response is not None:
                response.close()
            connection.close()


class VaultIncomeClient:
    """Explicit external-signature client; every success requires fresh reader evidence."""

    def __init__(self, *, profile: dict[str, Any], verifier: CryptoVerifier, reader: VaultIncomeReader,
                 journal: VaultIncomeJournal, transport: VaultIncomeTransport | None = None,
                 now: Callable[[], float] = time.time):
        if verifier is None or reader is None or journal is None or not callable(getattr(journal, "exclusive", None)):
            _fail("vault_income_client_configuration")
        self._verifier, self._reader, self._journal, self._now = verifier, reader, journal, now
        self._profile = _profile(profile, verifier)
        if _profile(reader.profile, verifier) != self._profile:
            _fail("vault_income_client_configuration")
        self._profile_hash = _digest(self._profile)
        self._http = transport or VaultIncomePublicHttp(self._profile["resourceUrl"], chain_id=self._profile["pins"]["chainId"])
        if self._http.resource_url != self._profile["resourceUrl"]:
            _fail("vault_income_client_configuration")
        self._active = threading.Lock()

    @property
    def profile(self) -> dict[str, Any]:
        return copy.deepcopy(self._profile)

    def _state(self, raw: Any) -> dict[str, Any]:
        if raw is None:
            return {"version": 1, "profileHash": self._profile_hash, "attempts": []}
        if len(_canonical(raw).encode()) > 1_048_576:
            _fail("vault_income_journal_limit")
        state = _exact_object(raw, {"version", "profileHash", "attempts"})
        if type(state["version"]) is not int or state["version"] != 1 or state["profileHash"] != self._profile_hash:
            _fail("vault_income_journal_invalid")
        if not isinstance(state["attempts"], list) or len(state["attempts"]) > 128:
            _fail("vault_income_journal_limit")
        ids, nonces, challenges = set(), set(), set()
        for item in state["attempts"]:
            attempt = _exact_object(item, {"plan", "submitted"}, {"signature", "signedHeader", "candidateHash", "observation"})
            plan = _plan(attempt["plan"], self._profile, self._verifier)
            # A persisted plan must retain the exact normalized original wire fields.
            if plan != attempt["plan"]:
                _fail("vault_income_journal_invalid")
            operation_id, nonce, challenge = plan["operationId"], plan["authorization"]["nonce"], plan["accepted"]["extra"]["telomere"]["challengeId"]
            if operation_id in ids or nonce in nonces or challenge in challenges:
                _fail("vault_income_journal_invalid")
            ids.add(operation_id); nonces.add(nonce); challenges.add(challenge)
            if (type(attempt["submitted"]) is not bool or ("signature" in attempt) != ("signedHeader" in attempt)
                    or attempt["submitted"] and "signature" not in attempt
                    or "candidateHash" in attempt and not attempt["submitted"]):
                _fail("vault_income_journal_invalid")
            if "signature" in attempt:
                signature = _signature(attempt["signature"])
                if (signature != attempt["signature"] or attempt["signedHeader"] != _header(_payment(plan, signature))
                        or self._verifier.verify_typed_data(plan["authorization"]["from"], _typed_data(plan, self._profile), signature) is not True):
                    _fail("vault_income_signature_mismatch")
                if len(attempt["signedHeader"]) > 8192:
                    _fail("vault_income_journal_limit")
            if "candidateHash" in attempt and _bytes32(attempt["candidateHash"]) != attempt["candidateHash"]:
                _fail("vault_income_journal_invalid")
            if "observation" in attempt:
                evidence = _inspection(attempt["observation"])
                if "candidateHash" not in attempt or evidence["transactionHash"] != attempt["candidateHash"]:
                    _fail("vault_income_journal_invalid")
        return state

    def _operation(self, callback: Callable[[dict[str, Any], Callable[[], None]], T]) -> T:
        if not self._active.acquire(blocking=False):
            _fail("vault_income_client_busy")
        try:
            def transaction(tx: VaultIncomeJournalTransaction) -> T:
                state = self._state(tx.load())

                def save() -> None:
                    tx.save(copy.deepcopy(self._state(state)))

                return callback(state, save)
            return self._journal.exclusive(self._profile_hash, transaction)
        finally:
            self._active.release()

    @staticmethod
    def _attempt(state: dict[str, Any], operation_id: str) -> dict[str, Any]:
        _id(operation_id)
        attempt = next((item for item in state["attempts"] if item["plan"]["operationId"] == operation_id), None)
        if attempt is None:
            _fail("vault_income_attempt_missing")
        return attempt

    def _check_reader(self) -> dict[str, Any]:
        if _profile(self._reader.profile, self._verifier) != self._profile:
            _fail("vault_income_client_configuration")
        return _snapshot(self._reader.check(), self._profile)

    def _guard(self, state: dict[str, Any], operation_id: str, payer: str, save: Callable[[], None]) -> None:
        for other in state["attempts"]:
            if other["plan"]["operationId"] == operation_id or not other["submitted"] or _address(other["plan"]["authorization"]["from"]) != _address(payer):
                continue
            result = self._inspect(other, save)
            if result["status"] == "settled":
                continue
            if result["status"] == "reverted":
                snapshot = self._check_reader()
                if (int(snapshot["block"]["timestamp"]) >= int(other["plan"]["authorization"]["validBefore"])
                        and self._inspect(other, save)["status"] == "reverted"):
                    continue
            _fail("vault_income_payer_reconciliation_required")

    def prepare(self, operation_id: str, *, payer: str, ttl_seconds: int = 120) -> dict[str, Any]:
        operation_id, payer = _id(operation_id), _checksum(payer, self._verifier)
        _integer(ttl_seconds, 1, 120)

        def run(state: dict[str, Any], save: Callable[[], None]) -> dict[str, Any]:
            previous = next((item for item in state["attempts"] if item["plan"]["operationId"] == operation_id), None)
            if previous is not None:
                if previous["plan"]["authorization"]["from"] != payer:
                    _fail("vault_income_attempt_conflict")
                return copy.deepcopy({"plan": previous["plan"], "typedData": _typed_data(previous["plan"], self._profile)})
            if len(state["attempts"]) >= 128:
                _fail("vault_income_journal_capacity")
            self._guard(state, operation_id, payer, save)
            snapshot, current = self._check_reader(), self._now()
            if type(current) not in (int, float) or not math.isfinite(current) or not 1 <= current < 2 ** 53:
                _fail("vault_income_clock_skew")
            now, timestamp = math.floor(current), int(snapshot["block"]["timestamp"])
            if now - timestamp > 299 or timestamp > now + 30:
                _fail("vault_income_clock_skew")
            response = _exact_object(self._http.send(), {"status", "body"}, {"required", "payment"})
            if type(response["status"]) is not int or response["status"] != 402 or "required" not in response:
                _fail("vault_income_offer_required")
            offer = _exact_object(response["required"], {"x402Version", "resource", "accepts", "extensions"})
            if type(offer["x402Version"]) is not int or offer["x402Version"] != 2 or not isinstance(offer["accepts"], list) or len(offer["accepts"]) != 1:
                _fail("vault_income_offer_mismatch")
            extension = _exact_object(_exact_object(offer["extensions"], {"telomere-request-binding"})["telomere-request-binding"], {"version", "requestHash"})
            accepted = _requirements(offer["accepts"][0], self._verifier)
            if type(extension["version"]) is not int or extension["version"] != 1 or extension["requestHash"] != accepted["extra"]["telomere"]["requestHash"]:
                _fail("vault_income_offer_mismatch")
            plan = _plan({"operationId": operation_id, "profileHash": self._profile_hash,
                          "resource": offer["resource"], "accepted": accepted,
                          "authorization": {"from": payer, "to": self._profile["pins"]["payTo"], "value": self._profile["grossAmount"],
                                            "nonce": accepted["extra"]["telomere"]["nonce"], "validAfter": str(max(0, timestamp - 1)),
                                            "validBefore": str(now + min(ttl_seconds, accepted["maxTimeoutSeconds"]))}}, self._profile, self._verifier)
            state["attempts"].append({"plan": plan, "submitted": False})
            save()
            return copy.deepcopy({"plan": plan, "typedData": _typed_data(plan, self._profile)})
        return self._operation(run)

    def authorize(self, operation_id: str, external_signature: str) -> None:
        signature = _signature(external_signature)

        def run(state: dict[str, Any], save: Callable[[], None]) -> None:
            attempt = self._attempt(state, operation_id)
            if "signature" in attempt:
                if attempt["signature"] != signature:
                    _fail("vault_income_attempt_conflict")
                return
            self._guard(state, operation_id, attempt["plan"]["authorization"]["from"], save)
            if self._verifier.verify_typed_data(attempt["plan"]["authorization"]["from"], _typed_data(attempt["plan"], self._profile), signature) is not True:
                _fail("vault_income_signature_mismatch")
            attempt["signature"], attempt["signedHeader"] = signature, _header(_payment(attempt["plan"], signature))
            save()
        self._operation(run)

    def _inspect(self, attempt: dict[str, Any], save: Callable[[], None]) -> dict[str, Any]:
        operation_id = attempt["plan"]["operationId"]
        if "candidateHash" not in attempt or "signature" not in attempt:
            return {"operationId": operation_id, "status": "submitted" if attempt["submitted"] else "authorized" if "signature" in attempt else "planned"}
        attempt["observation"] = {"status": "pending", "transactionHash": attempt["candidateHash"]}
        save()
        if _profile(self._reader.profile, self._verifier) != self._profile:
            _fail("vault_income_client_configuration")
        evidence = _inspection(self._reader.inspect(transaction_hash=attempt["candidateHash"],
                                                  payment=_payment(attempt["plan"], attempt["signature"])))
        if evidence["transactionHash"] != attempt["candidateHash"]:
            _fail("vault_income_hash_substitution")
        if evidence["status"] == "settled":
            gross = int(self._profile["grossAmount"])
            fee = (gross * 100 + 9999) // 10000 if evidence.get("classification") == "income" else 0
            ref = vault_income_authorization_ref(self._profile, attempt["plan"]["authorization"]["from"], attempt["plan"]["authorization"]["nonce"], self._verifier)
            if ("block" not in evidence or evidence.get("classification") not in ("income", "subsidy")
                    or evidence.get("grossAmount") != str(gross) or evidence.get("incomeFee") != str(fee)
                    or evidence.get("netAmount") != str(gross - fee) or evidence.get("paymentRef") != ref
                    or _address(evidence.get("payer")) != _address(attempt["plan"]["authorization"]["from"])):
                _fail("vault_income_evidence_invalid")
        attempt["observation"] = evidence
        save()
        return copy.deepcopy({"operationId": operation_id, "status": evidence["status"], "transactionHash": attempt["candidateHash"], "evidence": evidence})

    def check(self, operation_id: str) -> dict[str, Any]:
        return self._operation(lambda state, save: self._inspect(self._attempt(state, operation_id), save))

    def submit(self, operation_id: str) -> dict[str, Any]:
        return self.retry(operation_id)

    def retry(self, operation_id: str) -> dict[str, Any]:
        def run(state: dict[str, Any], save: Callable[[], None]) -> dict[str, Any]:
            attempt = self._attempt(state, operation_id)
            if "signature" not in attempt or "signedHeader" not in attempt:
                _fail("vault_income_signature_required")
            if not attempt["submitted"]:
                self._guard(state, operation_id, attempt["plan"]["authorization"]["from"], save)
            if "candidateHash" in attempt:
                result = self._inspect(attempt, save)
                if result["status"] != "pending":
                    return result
            self._check_reader()
            attempt["submitted"] = True
            save()
            response = _exact_object(self._http.send(attempt["signedHeader"]), {"status", "body"}, {"required", "payment"})
            if type(response["status"]) is not int or "payment" not in response:
                _fail("vault_income_result_ambiguous")
            payment = _exact_object(response["payment"], {"success", "transaction", "network", "payer", "amount"}, {"errorReason"})
            if type(payment["success"]) is not bool:
                _fail("vault_income_result_ambiguous")
            if "errorReason" in payment:
                _text(payment["errorReason"], 0, 128)
            if (payment["network"] != "eip155:" + str(self._profile["pins"]["chainId"])
                    or payment["amount"] != self._profile["grossAmount"]
                    or _address(payment["payer"]) != _address(attempt["plan"]["authorization"]["from"])):
                _fail("vault_income_result_mismatch")
            if payment["transaction"] != "":
                candidate = _bytes32(payment["transaction"])
                if "candidateHash" in attempt and attempt["candidateHash"] != candidate:
                    _fail("vault_income_hash_substitution")
                attempt["candidateHash"] = candidate
                save()
            if response["status"] == 200 and payment["success"]:
                metadata = _exact_object(response["body"], {"kind", "agentId", "vault", "asset", "grossAmount"})
                pins = self._profile["pins"]
                if (metadata["kind"] != "vault-payment-receipt" or metadata["agentId"] != pins["agentId"]
                        or _address(metadata["vault"]) != _address(pins["payTo"])
                        or _address(metadata["asset"]) != _address(pins["asset"]) or metadata["grossAmount"] != self._profile["grossAmount"]):
                    _fail("vault_income_result_mismatch")
            elif response["status"] not in (202, 422) or payment["success"]:
                _fail("vault_income_result_ambiguous")
            return self._inspect(attempt, save)
        return self._operation(run)
