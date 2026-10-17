"""Validated pilot API operations and checked, unsigned external wallet intents."""

from __future__ import annotations

import copy
import json
import re
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from types import MappingProxyType
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from .chains import MODE_CHAIN_IDS, PUBLIC_BASE_EXPLORERS, PUBLIC_BASE_RPCS, PUBLIC_BASE_TOKENS, SUPPORTED_CHAIN_IDS
from .crypto import CryptoVerifier
from .transport import ApiTransport, Transport, is_loopback, normalize_origin, request_bound, response_bound

QUOTE_FIELDS = (("runId", "bytes32"), ("leashId", "bytes32"), ("payer", "address"), ("workloadHash", "bytes32"),
                ("maxSeconds", "uint64"), ("pricePerSecond", "uint96"), ("inferencePrice", "uint96"), ("quoteExpiry", "uint64"))
SETTLEMENT_FIELDS = (("runId", "bytes32"), ("billableSeconds", "uint64"), ("inferenceCharge", "uint96"), ("receiptHash", "bytes32"))


def _object(value: Any, keys: set[str] | None = None) -> dict[str, Any]:
    if not isinstance(value, dict) or (keys is not None and set(value) != keys):
        raise ValueError("Unexpected Telomere response fields")
    return value


def _address(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", value):
        raise ValueError("Invalid EVM address")
    if int(value[2:], 16) == 0:
        raise ValueError("Zero EVM address is not supported")
    return value.lower()


def _bytes32(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", value):
        raise ValueError("Invalid bytes32 identifier")
    return value.lower()


def _integer(value: Any, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("Integer is outside the pilot bounds")
    return value


def _money(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,27}", value) or int(value) >= 2 ** 96:
        raise ValueError("Amount must be canonical uint96 decimal token units")
    return value


def _signature(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{130}", value):
        raise ValueError("Invalid 65-byte signature")
    # Match OpenZeppelin's canonical EOA signature encoding.
    raw = bytes.fromhex(value[2:])
    if (raw[-1] not in (27, 28) or int.from_bytes(raw[32:64], "big") == 0
            or int.from_bytes(raw[32:64], "big") > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0):
        raise ValueError("Noncanonical EOA signature")
    return value.lower()


def _text(value: Any, *, allow_empty: bool = True) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        raise ValueError("Invalid task text")
    try:
        if len(value.encode("utf-8")) > 8192:
            raise ValueError("Task text exceeds 8192 UTF-8 bytes")
    except UnicodeError:
        raise ValueError("Invalid UTF-8 task text") from None
    return value


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))


def _typed(domain: dict[str, Any], primary: str, fields: tuple[tuple[str, str], ...], message: dict[str, Any]) -> dict[str, Any]:
    return {"domain": domain, "primaryType": primary, "types": {"EIP712Domain": [
        {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}],
        primary: [{"name": name, "type": kind} for name, kind in fields]}, "message": message}


@dataclass(frozen=True)
class DeploymentPins:
    chain_id: int
    escrow_address: str
    token_address: str
    receipt_signer: str
    token_code_hash: str | None = None
    asset_implementation: Mapping[str, str] | None = None

    def __post_init__(self) -> None:
        if type(self.chain_id) is not int or self.chain_id not in SUPPORTED_CHAIN_IDS:
            raise ValueError("Only the reviewed pilot chains are supported")
        for field in ("escrow_address", "token_address", "receipt_signer"):
            object.__setattr__(self, field, _address(getattr(self, field)))
        if self.token_code_hash is not None:
            object.__setattr__(self, "token_code_hash", _bytes32(self.token_code_hash))
        if self.asset_implementation is not None:
            implementation = self.asset_implementation
            if not isinstance(implementation, Mapping) or set(implementation) != {"address", "codeHash"}:
                raise ValueError("Reviewed token implementation pins are invalid")
            object.__setattr__(self, "asset_implementation", MappingProxyType({
                "address": _address(implementation["address"]), "codeHash": _bytes32(implementation["codeHash"])}))
        if self.chain_id in PUBLIC_BASE_TOKENS and self.token_address != PUBLIC_BASE_TOKENS[self.chain_id]:
            raise ValueError("Base deployment must use Circle native USDC")
        if self.chain_id in PUBLIC_BASE_TOKENS and (self.token_code_hash is None or self.asset_implementation is None):
            raise ValueError("Base deployment requires independently reviewed USDC proxy and implementation pins")


@dataclass(frozen=True)
class WalletIntent:
    chain_id: int
    to: str
    data: str
    summary: str
    value: str = "0x0"


@dataclass(frozen=True)
class WalletPlan:
    plan_id: str
    purpose: str
    intents: tuple[WalletIntent, ...]
    next_step: str
    requires_wallet: bool = True
    run_id: str | None = None
    leash_id: str | None = None
    expires_at: int | None = None


@dataclass(frozen=True)
class QuotedRun:
    _quote_json: str
    signature: str
    ceiling: str
    wallet_action: WalletPlan
    idempotency_key: str

    @property
    def quote(self) -> dict[str, Any]:
        return json.loads(self._quote_json)


@dataclass(frozen=True)
class ReceiptVerification:
    signature_verified: bool | None
    body_consistent: bool | None
    server_valid: bool
    server_anchored: bool
    onchain_verified: bool = False


class TelomereClient:
    def __init__(self, base_url: str, *, pins: DeploymentPins | None = None,
                 verifier: CryptoVerifier | None = None, transport: Transport | None = None,
                 clock: Callable[[], float] = time.time, cyst_quota_version: int | None = None):
        self.origin = normalize_origin(base_url)
        self._transport = transport or ApiTransport(self.origin)
        if normalize_origin(self._transport.origin) != self.origin:
            raise ValueError("Injected transport must use the exact client origin")
        self._pins, self._verifier, self._clock = pins, verifier, clock
        self._crypto_checked = False
        self._config: dict[str, Any] | None = None
        self._quote_inputs: dict[str, str] = {}
        self._quotes: dict[str, QuotedRun] = {}
        self._admissions: dict[str, str] = {}
        self._lock = threading.RLock()
        from .cysts import CystClient
        self.cysts = CystClient(self._request, lambda: self.me()["address"], quota_version=cyst_quota_version)

    def _request(self, path: str, *, method: str = "GET", body: Any = None,
                 idempotency_key: str | None = None, max_response_bytes: int | None = None,
                 cyst_quota_version: int | None = None) -> Any:
        limit = response_bound(path, method, max_response_bytes)
        if body is not None and len(_canonical(body).encode("utf-8")) > request_bound(path, method):
            raise ValueError("Telomere request exceeds the body limit")
        options = {"method": method, "body": body, "idempotency_key": idempotency_key}
        if max_response_bytes is not None:
            options["max_response_bytes"] = max_response_bytes
        if cyst_quota_version is not None:
            if type(cyst_quota_version) is not int or cyst_quota_version != 2 or not re.match(r"^/api/cysts(?:$|[/?])", path):
                raise ValueError("Checkpoint quota profile is restricted to Cyst requests")
            options["cyst_quota_version"] = cyst_quota_version
        result = self._transport.request(path, **options)
        try:
            if len(_canonical(result).encode("utf-8")) > limit:
                raise ValueError("Telomere response exceeds the body limit")
        except (TypeError, UnicodeError, RecursionError):
            raise ValueError("Invalid Telomere response") from None
        return copy.deepcopy(result)

    def config(self) -> dict[str, Any]:
        if self._config is not None:
            return copy.deepcopy(self._config)
        value = _object(self._request("/api/config"))
        chain, token, prices, workload = (_object(value.get(key)) for key in ("chain", "token", "prices", "workload"))
        chain_id = _integer(chain.get("id"), 1, 2 ** 32 - 1)
        mode = value.get("mode")
        if (not isinstance(mode, str) or mode not in MODE_CHAIN_IDS or chain_id != MODE_CHAIN_IDS[mode]
                or token.get("decimals") != 6
                or type(token.get("decimals")) is not int or prices.get("maxSeconds") != 120
                or type(prices.get("maxSeconds")) is not int or value.get("cpuMode") not in ("demo", "docker", "hostkit")
                or type(value.get("nearAvailable")) is not bool):
            raise ValueError("Unsupported Telomere pilot deployment")
        for owner, key in ((token, "address"), (value, "escrowAddress"), (value, "receiptSigner")):
            owner[key] = _address(owner.get(key))
        _money(prices.get("cpuPerSecond")); _money(prices.get("inferenceFixed"))
        _integer(prices.get("maxTokens"), 1, 512)
        model = workload.get("nearModel")
        if model is not None and (not isinstance(model, str) or not 1 <= len(model) <= 512):
            raise ValueError("Invalid configured NEAR model")
        if mode == "demo" and not is_loopback(self.origin):
            raise ValueError("Demo mode requires a loopback origin")
        if mode in ("testnet", "mainnet"):
            token["codeHash"] = _bytes32(token.get("codeHash"))
            implementation = _object(token.get("implementation"), {"address", "codeHash"})
            token["implementation"] = {"address": _address(implementation["address"]),
                                       "codeHash": _bytes32(implementation["codeHash"])}
        if mode in ("testnet", "mainnet") and (not self.origin.startswith("https:") and not is_loopback(self.origin)
                or token["address"] != PUBLIC_BASE_TOKENS[chain_id]
                or chain.get("rpcUrl") != PUBLIC_BASE_RPCS[chain_id]
                or chain.get("explorerUrl") != PUBLIC_BASE_EXPLORERS[chain_id]
                or token.get("symbol") != "USDC" or self._pins is None
                or token.get("codeHash") != self._pins.token_code_hash
                or self._pins.asset_implementation is None
                or token["implementation"]["address"] != self._pins.asset_implementation["address"]
                or token["implementation"]["codeHash"] != self._pins.asset_implementation["codeHash"]):
            raise ValueError("Unsupported Base USDC deployment")
        if self._pins is not None and (chain_id != self._pins.chain_id or token["address"] != self._pins.token_address
                or value["escrowAddress"] != self._pins.escrow_address or value["receiptSigner"] != self._pins.receipt_signer):
            raise ValueError("Deployment differs from the reviewed pins")
        self._config = value
        return copy.deepcopy(value)

    def _financial(self) -> tuple[dict[str, Any], CryptoVerifier]:
        if self._pins is None:
            raise ValueError("Supply reviewed deployment pins before preparing wallet intents")
        if self._verifier is None:
            raise ValueError("A reviewed CryptoVerifier is required for wallet intents")
        if not self._crypto_checked:
            empty = self._verifier.keccak256(b"")
            if empty != bytes.fromhex("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"):
                raise ValueError("CryptoVerifier must implement Ethereum Keccak-256, not SHA3-256")
            self._crypto_checked = True
        return self.config(), self._verifier

    def _hash(self, value: Any) -> str:
        if self._verifier is None:
            raise ValueError("A reviewed CryptoVerifier is required")
        digest = self._verifier.keccak256(_canonical(value).encode("utf-8"))
        if not isinstance(digest, bytes) or len(digest) != 32:
            raise ValueError("CryptoVerifier returned an invalid Keccak digest")
        return "0x" + digest.hex()

    def authenticate(self, address: str, *, chain_id: int, sign_message: Callable[[str], str]) -> dict[str, Any]:
        config = self.config()
        owner = _address(address)
        if self._verifier is None:
            raise ValueError("Authentication requires a reviewed CryptoVerifier")
        if type(chain_id) is not int or chain_id != config["chain"]["id"]:
            raise ValueError("Select the configured pilot chain in the owner wallet")
        canonical_owner = self._verifier.checksum_address(owner)
        if _address(canonical_owner) != owner:
            raise ValueError("CryptoVerifier changed the owner address")
        challenge = _object(self._request("/api/auth/challenge", method="POST", body={"address": canonical_owner}), {"nonce", "message"})
        nonce, message = challenge["nonce"], challenge["message"]
        if (not isinstance(nonce, str) or not re.fullmatch(r"[a-f0-9]{48}", nonce)
                or not isinstance(message, str) or len(message) > 4096):
            raise ValueError("Invalid wallet sign-in challenge")
        dates = re.search(r"\nIssued At: ([^\n]+)\nExpiration Time: ([^\n]+)$", message)
        if dates is None:
            raise ValueError("Sign-in challenge changed scope or expired")
        issued, expiry = dates.groups()
        try:
            parsed = [datetime.fromisoformat(value.replace("Z", "+00:00")) for value in (issued, expiry)]
            if any(value.tzinfo is None for value in parsed):
                raise ValueError("Missing timezone")
            started, expires = [value.timestamp() for value in parsed]
        except ValueError:
            raise ValueError("Sign-in challenge changed scope or expired") from None
        expected = (f"{urlsplit(self.origin).netloc} wants you to sign in to Telomere:\n{canonical_owner}\n\n"
                    f"Authorize this browser session. No token transfer.\n\nURI: {self.origin}\nVersion: 1\n"
                    f"Chain ID: {chain_id}\nNonce: {nonce}\nIssued At: {issued}\nExpiration Time: {expiry}")
        now = self._clock()
        if message != expected or started > now + 30 or expires <= now or expires - started != 300:
            raise ValueError("Sign-in challenge changed scope or expired")
        signed = _signature(sign_message(message))
        if self._verifier.verify_message(owner, message, signed) is not True:
            raise ValueError("Owner signature did not verify locally")
        response = self._session(self._request("/api/auth/verify", method="POST",
                                              body={"address": canonical_owner, "nonce": nonce, "signature": signed}))
        if response["address"] != owner or response["demo"]:
            self._transport.clear_session()
            raise ValueError("Owner session changed")
        return response

    def authenticate_demo(self, *, explicitly_enabled: bool = False) -> dict[str, Any]:
        config = self.config()
        if explicitly_enabled is not True or not is_loopback(self.origin) or config["mode"] != "demo" or config["chain"]["id"] != 31337:
            raise ValueError("Demo authentication requires explicit loopback demo opt-in")
        value = self._session(self._request("/api/auth/demo", method="POST", body={}))
        if not value["demo"]:
            self._transport.clear_session()
            raise ValueError("Expected a demo owner session")
        return value

    def logout(self) -> None:
        try:
            self._request("/api/auth/logout", method="POST", body={})
        finally:
            self._transport.clear_session()
            with self._lock:
                self._quote_inputs.clear(); self._quotes.clear(); self._admissions.clear()

    @staticmethod
    def _session(value: Any) -> dict[str, Any]:
        session = _object(value)
        session["address"] = _address(session.get("address"))
        if type(session.get("demo")) is not bool:
            raise ValueError("Invalid owner session")
        return session

    def me(self) -> dict[str, Any]:
        return self._session(self._request("/api/me"))

    def balance(self) -> dict[str, Any]:
        value = _object(self._request("/api/balance"))
        _money(value.get("available")); _money(value.get("reserved"))
        return value

    def operations(self) -> dict[str, Any]:
        return _object(self._request("/api/operations"))

    def leashes(self) -> dict[str, Any]:
        value = _object(self._request("/api/leashes"))
        rows = value.get("leashes")
        if not isinstance(rows, list) or len(rows) > 100:
            raise ValueError("Invalid leash list")
        for row in rows:
            row = _object(row)
            row["id"] = _bytes32(row.get("id")); row["owner"] = _address(row.get("owner")); row["agent"] = _address(row.get("agent"))
            for key in ("maxPerHour", "maxPerDay", "spentHour", "spentDay", "pending"):
                _money(row.get(key))
            if (not isinstance(row.get("expiry"), str) or not re.fullmatch(r"0|[1-9][0-9]{0,19}", row["expiry"])
                    or int(row["expiry"]) >= 2 ** 64 or type(row.get("killed")) is not bool):
                raise ValueError("Invalid leash state")
        return value

    @staticmethod
    def _run(value: Any) -> dict[str, Any]:
        row = _object(value)
        row["id"] = _bytes32(row.get("id")); row["owner"] = _address(row.get("owner"))
        if row.get("status") not in ("prepared", "queued", "running", "near_dispatching", "receipt_pending", "settling", "reconciliation", "completed", "failed", "cancelled", "timed_out", "refunded"):
            raise ValueError("Unknown run status")
        _money(row.get("ceiling")); _integer(row.get("billableSeconds"), 0, 120)
        for key in ("charged", "refund"):
            if row.get(key) is not None:
                _money(row[key])
        if row.get("charged") is not None and row.get("refund") is not None and int(row["charged"]) + int(row["refund"]) != int(row["ceiling"]):
            raise ValueError("Run billing does not conserve its ceiling")
        return row

    def runs(self) -> dict[str, Any]:
        value = _object(self._request("/api/runs"))
        rows = value.get("runs")
        if not isinstance(rows, list) or len(rows) > 100:
            raise ValueError("Invalid run list")
        value["runs"] = [self._run(row) for row in rows]
        return value

    def run(self, run_id: str) -> dict[str, Any]:
        run_id = _bytes32(run_id)
        value = self._run(self._request(f"/api/runs/{run_id}"))
        if value["id"] != run_id:
            raise ValueError("Run response changed its identifier")
        return value

    def _encode(self, function: str, kinds: tuple[str, ...], values: tuple[Any, ...], *, signature: str | None = None) -> str:
        _, verifier = self._financial()
        selector = verifier.keccak256(function.encode("ascii"))
        if not isinstance(selector, bytes) or len(selector) != 32 or len(kinds) != len(values):
            raise ValueError("Invalid ABI encoding parameters")
        words = []
        for kind, value in zip(kinds, values):
            if kind == "bytes32":
                words.append(bytes.fromhex(_bytes32(value)[2:]))
            elif kind == "address":
                words.append(bytes.fromhex(_address(value)[2:]).rjust(32, b"\0"))
            elif kind.startswith("uint"):
                words.append(_integer(value, 0, 2 ** int(kind[4:]) - 1).to_bytes(32, "big"))
            else:
                raise ValueError("Unsupported wallet ABI type")
        tail = b""
        if signature is not None:
            raw = bytes.fromhex(_signature(signature)[2:])
            words.append(((len(words) + 1) * 32).to_bytes(32, "big"))
            tail = len(raw).to_bytes(32, "big") + raw + b"\0" * ((-len(raw)) % 32)
        return "0x" + (selector[:4] + b"".join(words) + tail).hex()

    @staticmethod
    def _transaction(value: Any, to: str, data: str) -> dict[str, str]:
        transaction = _object(value, {"to", "data", "value"})
        if (_address(transaction["to"]) != to or not isinstance(transaction["data"], str)
                or transaction["data"].lower() != data or transaction["value"] != "0x0"):
            raise ValueError("Wallet transaction differs from the exact requested action")
        return {"to": to, "data": data, "value": "0x0"}

    def _plan(self, purpose: str, transactions: tuple[tuple[dict[str, str], str], ...], next_step: str,
              *, run_id: str | None = None, leash_id: str | None = None, expires_at: int | None = None) -> WalletPlan:
        config, _ = self._financial()
        return WalletPlan(str(uuid.uuid4()), purpose, tuple(WalletIntent(config["chain"]["id"], tx["to"], tx["data"], summary) for tx, summary in transactions),
                          next_step, run_id=run_id, leash_id=leash_id, expires_at=expires_at)

    def prepare_deposit(self, amount: str) -> WalletPlan:
        amount = _money(amount)
        if amount == "0":
            raise ValueError("Deposit amount must be positive")
        config, _ = self._financial()
        response = _object(self._request(f"/api/transactions/deposit?amount={amount}"), {"transactions"})
        rows = response["transactions"]
        if not isinstance(rows, list) or len(rows) != 2:
            raise ValueError("Deposit requires exactly two intents")
        approve = self._transaction(rows[0], config["token"]["address"], self._encode("approve(address,uint256)", ("address", "uint256"), (config["escrowAddress"], int(amount))))
        deposit = self._transaction(rows[1], config["escrowAddress"], self._encode("deposit(uint96)", ("uint96",), (int(amount),)))
        return self._plan("deposit", ((approve, f"Approve exactly {amount} token units."), (deposit, f"Deposit {amount} token units.")), "Use the external owner wallet; confirm both transactions before reading balance.")

    def prepare_withdraw(self, amount: str) -> WalletPlan:
        amount = _money(amount)
        if amount == "0":
            raise ValueError("Withdrawal amount must be positive")
        config, _ = self._financial()
        response = _object(self._request(f"/api/transactions/withdraw?amount={amount}"), {"transaction"})
        tx = self._transaction(response["transaction"], config["escrowAddress"], self._encode("withdraw(uint96)", ("uint96",), (int(amount),)))
        return self._plan("withdraw", ((tx, f"Withdraw {amount} available token units."),), "Use the external owner wallet; check the confirmed balance.")

    def _budget(self, max_per_hour: str, max_per_day: str, expiry: int) -> dict[str, Any]:
        hour, day = _money(max_per_hour), _money(max_per_day)
        now = int(self._clock())
        _integer(expiry, now + 1, min(now + 30 * 86400, 2 ** 64 - 1))
        if hour == "0" or int(day) < int(hour):
            raise ValueError("Set positive hourly limits and a daily limit at least as large")
        return {"maxPerHour": hour, "maxPerDay": day, "expiry": expiry}

    def prepare_leash(self, *, max_per_hour: str, max_per_day: str, expiry: int, agent: str | None = None) -> WalletPlan:
        config, _ = self._financial()
        owner = self.me()["address"]
        body = self._budget(max_per_hour, max_per_day, expiry)
        body["agent"] = _address(agent) if agent is not None else owner
        response = _object(self._request("/api/leashes", method="POST", body=body), {"leashId", "transaction"})
        leash_id = _bytes32(response["leashId"])
        data = self._encode("createLeash(bytes32,address,uint96,uint96,uint64)", ("bytes32", "address", "uint96", "uint96", "uint64"),
                            (leash_id, body["agent"], int(body["maxPerHour"]), int(body["maxPerDay"]), expiry))
        tx = self._transaction(response["transaction"], config["escrowAddress"], data)
        return self._plan("leash", ((tx, f"Create budget {leash_id} with agent {body['agent']}."),), "Use the external owner wallet; confirm creation before requesting a quote.", leash_id=leash_id, expires_at=expiry)

    def prepare_update_leash(self, leash_id: str, *, max_per_hour: str, max_per_day: str, expiry: int) -> WalletPlan:
        config, _ = self._financial()
        leash_id = _bytes32(leash_id)
        owner = self.me()["address"]
        current = next((row for row in self.leashes()["leashes"] if row["id"] == leash_id and row["owner"] == owner), None)
        if current is None or current["killed"]:
            raise ValueError("An active owned leash is required")
        body = self._budget(max_per_hour, max_per_day, expiry)
        response = _object(self._request(f"/api/leashes/{leash_id}/update", method="POST", body=body), {"leashId", "agent", "transaction"})
        if _bytes32(response["leashId"]) != leash_id or _address(response["agent"]) != current["agent"]:
            raise ValueError("Leash update changed its identifier or delegated agent")
        data = self._encode("updateLeash(bytes32,address,uint96,uint96,uint64)", ("bytes32", "address", "uint96", "uint96", "uint64"),
                            (leash_id, current["agent"], int(body["maxPerHour"]), int(body["maxPerDay"]), expiry))
        tx = self._transaction(response["transaction"], config["escrowAddress"], data)
        return self._plan("update_leash", ((tx, f"Update budget {leash_id}; preserve agent {current['agent']}."),), "Use the external owner wallet; pending reservations remain governed by the contract.", leash_id=leash_id, expires_at=expiry)

    @staticmethod
    def _quote_input(value: Any) -> dict[str, Any]:
        value = copy.deepcopy(_object(value))
        if set(value) not in ({"leashId", "task", "maxSeconds"}, {"leashId", "task", "maxSeconds", "nearPrompt"}):
            raise ValueError("Unknown quote input fields")
        value["leashId"] = _bytes32(value["leashId"])
        _integer(value["maxSeconds"], 1, 120)
        task = _object(value["task"])
        kind = task.get("kind")
        if kind == "sha256":
            _object(task, {"kind", "text"}); _text(task["text"])
        elif kind == "hash_chain":
            _object(task, {"kind", "text", "iterations"}); _text(task["text"]); _integer(task["iterations"], 1, 2_000_000)
        elif kind == "primes":
            _object(task, {"kind", "limit"}); _integer(task["limit"], 2, 2_000_000)
        elif kind == "sort":
            _object(task, {"kind", "numbers"})
            if not isinstance(task["numbers"], list) or len(task["numbers"]) > 10_000:
                raise ValueError("Sort input exceeds the pilot bounds")
            for number in task["numbers"]:
                _integer(number, -1_000_000_000, 1_000_000_000)
        else:
            raise ValueError("Unknown pilot task; arbitrary executable code is unsupported")
        if "nearPrompt" in value:
            _text(value["nearPrompt"], allow_empty=False)
        return value

    def quote(self, value: dict[str, Any], *, idempotency_key: str) -> QuotedRun:
        config, verifier = self._financial()
        if not isinstance(idempotency_key, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{8,128}", idempotency_key):
            raise ValueError("Invalid idempotency key")
        body = self._quote_input(value)
        fingerprint = _canonical(body)
        with self._lock:
            previous = self._quote_inputs.get(idempotency_key)
            if previous is not None and previous != fingerprint:
                raise ValueError("Reuse an idempotency key only with its original request")
            self._quote_inputs[idempotency_key] = fingerprint
            known = self._quotes.get(idempotency_key)
            if known is not None:
                if known.quote["quoteExpiry"] <= self._clock():
                    raise ValueError("The original quote expired; use a new request key after reconciliation")
                if known.quote["payer"] != self.me()["address"]:
                    raise ValueError("Owner session changed since the original quote")
                return known
            owner = self.me()["address"]
            response = _object(self._request("/api/quotes", method="POST", body=body, idempotency_key=idempotency_key), {"quote", "signature", "ceiling", "transaction"})
            q = _object(response["quote"], {name for name, _ in QUOTE_FIELDS})
            for key in ("runId", "leashId", "workloadHash"):
                q[key] = _bytes32(q[key])
            q["payer"] = _address(q["payer"])
            _integer(q["maxSeconds"], 1, 120); _integer(q["quoteExpiry"], 1, 2 ** 64 - 1)
            _money(q["pricePerSecond"]); _money(q["inferencePrice"]); _money(response["ceiling"])
            workload_hash = self._hash({"input": body, "maxTokens": config["prices"]["maxTokens"], "model": config["workload"]["nearModel"]})
            if (q["payer"] != owner or q["leashId"] != body["leashId"] or q["maxSeconds"] != body["maxSeconds"]
                    or q["workloadHash"] != workload_hash or q["pricePerSecond"] != config["prices"]["cpuPerSecond"]
                    or q["inferencePrice"] != (config["prices"]["inferenceFixed"] if "nearPrompt" in body else "0")
                    or q["quoteExpiry"] <= self._clock() or q["quoteExpiry"] > self._clock() + 330
                    or int(response["ceiling"]) != q["maxSeconds"] * int(q["pricePerSecond"]) + int(q["inferencePrice"])):
                raise ValueError("Quote changed the requested workload, owner or published tariff")
            signature = _signature(response["signature"])
            domain = {"name": "TelomereRunEscrow", "version": "1", "chainId": config["chain"]["id"], "verifyingContract": config["escrowAddress"]}
            if verifier.verify_typed_data(config["receiptSigner"], _typed(domain, "Quote", QUOTE_FIELDS, q), signature) is not True:
                raise ValueError("Operator quote signature did not verify locally")
            kinds = tuple(kind for _, kind in QUOTE_FIELDS)
            values = tuple(int(q[name]) if kind.startswith("uint") else q[name] for name, kind in QUOTE_FIELDS)
            data = self._encode("openRun((bytes32,bytes32,address,bytes32,uint64,uint96,uint96,uint64),bytes)", kinds, values, signature=signature)
            tx = self._transaction(response["transaction"], config["escrowAddress"], data)
            plan = self._plan("open", ((tx, f"Reserve at most {response['ceiling']} token units for {q['maxSeconds']} CPU seconds."),),
                              "Confirm this exact openRun intent in the external wallet; admit only its original transaction hash.",
                              run_id=q["runId"], leash_id=q["leashId"], expires_at=q["quoteExpiry"])
            quoted = QuotedRun(_canonical(q), signature, response["ceiling"], plan, idempotency_key)
            self._quotes[idempotency_key] = quoted
            return quoted

    def admit(self, quoted: QuotedRun, tx_hash: str) -> dict[str, Any]:
        self._financial()
        if not isinstance(quoted, QuotedRun) or self._quotes.get(quoted.idempotency_key) is not quoted:
            raise ValueError("Admission requires the original quote verified by this client")
        q, tx_hash = quoted.quote, _bytes32(tx_hash)
        with self._lock:
            previous = self._admissions.get(q["runId"])
            if previous is not None and previous != tx_hash:
                raise ValueError("Reconcile the original admission transaction before substituting another")
            if self.me()["address"] != q["payer"]:
                raise ValueError("Owner session changed since the quote")
            self._admissions[q["runId"]] = tx_hash
            result = self._run(self._request("/api/runs", method="POST", body={"runId": q["runId"], "txHash": tx_hash}))
            if result["id"] != q["runId"] or result["owner"] != q["payer"] or result["ceiling"] != quoted.ceiling:
                raise ValueError("Admission changed the original run or billing terms")
            return result

    def _identifier_action(self, purpose: str, identifier: str) -> WalletPlan:
        config, _ = self._financial()
        identifier = _bytes32(identifier)
        methods = {"stop": ("runs", "requestStop(bytes32)"), "refund": ("runs", "refundRun(bytes32)"), "kill": ("leashes", "killLeash(bytes32)")}
        if purpose not in methods:
            raise ValueError("Unknown wallet intent")
        group, function = methods[purpose]
        response = _object(self._request(f"/api/{group}/{identifier}/{purpose}", method="POST", body={}), {"transaction"})
        tx = self._transaction(response["transaction"], config["escrowAddress"], self._encode(function, ("bytes32",), (identifier,)))
        return self._plan(purpose, ((tx, f"Request {purpose} for {identifier}; contract rules apply."),), "Confirm in the external owner wallet, then read the updated state.",
                          run_id=identifier if group == "runs" else None, leash_id=identifier if group == "leashes" else None)

    def prepare_stop(self, run_id: str) -> WalletPlan:
        return self._identifier_action("stop", run_id)

    def prepare_refund(self, run_id: str) -> WalletPlan:
        return self._identifier_action("refund", run_id)

    def prepare_kill(self, leash_id: str) -> WalletPlan:
        return self._identifier_action("kill", leash_id)

    def verify_receipt(self, receipt: dict[str, Any]) -> ReceiptVerification:
        response = _object(self._request("/api/receipts/verify", method="POST", body={"receipt": receipt}))
        if type(response.get("valid")) is not bool or ("anchored" in response and type(response["anchored"]) is not bool):
            raise ValueError("Invalid server receipt verification")
        if self._verifier is None or self._pins is None:
            return ReceiptVerification(None, None, response["valid"], response.get("anchored", False))
        config, verifier = self._financial()
        valid = consistent = False
        try:
            _object(receipt, {"body", "receiptHash", "settlement", "signature", "signer", "domain"})
            body = _object(receipt["body"])
            settlement = _object(receipt["settlement"], {name for name, _ in SETTLEMENT_FIELDS})
            digest = _bytes32(receipt["receiptHash"])
            domain = {"name": "TelomereRunEscrow", "version": "1", "chainId": config["chain"]["id"], "verifyingContract": config["escrowAddress"]}
            actual_domain = _object(receipt["domain"], set(domain))
            _integer(actual_domain["chainId"], 1, 2 ** 32 - 1)
            actual_domain = {**actual_domain, "verifyingContract": _address(actual_domain["verifyingContract"])}
            valid = (actual_domain == domain and _address(receipt["signer"]) == config["receiptSigner"] and digest == self._hash(body)
                     and _bytes32(settlement["receiptHash"]) == digest and verifier.verify_typed_data(config["receiptSigner"],
                         _typed(domain, "Settlement", SETTLEMENT_FIELDS, settlement), _signature(receipt["signature"])) is True)
            cpu, billing = _object(body["cpu"]), _object(body["billing"])
            seconds = _integer(cpu["billableSeconds"], 0, 120)
            measured = _integer(cpu["measuredSeconds"], seconds, 120)
            fee = _money(body["near"]["inferenceCharge"]) if body.get("near") is not None else "0"
            charged = seconds * int(_money(cpu["pricePerSecond"])) + int(fee)
            _money(billing["ceiling"]); _money(billing["charged"]); _money(billing["refund"])
            consistent = (_bytes32(body["runId"]) == _bytes32(settlement["runId"]) and _address(body["payer"]) == self.me()["address"]
                          and _bytes32(body["leashId"]) and _bytes32(body["workloadHash"]) and measured >= seconds
                          and isinstance(settlement["billableSeconds"], str) and settlement["billableSeconds"] == str(seconds)
                          and _money(settlement["inferenceCharge"]) == fee and charged == int(billing["charged"])
                          and charged + int(billing["refund"]) == int(billing["ceiling"])
                          and _address(billing["token"]) == config["token"]["address"])
        except (KeyError, TypeError, ValueError):
            valid = consistent = False
        return ReceiptVerification(bool(valid), bool(consistent), response["valid"], response.get("anchored", False))

    def receipt(self, run_id: str) -> dict[str, Any]:
        value = self.run(run_id)
        if not value.get("receipt"):
            return {"available": False, "runId": value["id"], "status": value["status"]}
        return {"available": True, "runId": value["id"], "receipt": value["receipt"], "verification": self.verify_receipt(value["receipt"])}
