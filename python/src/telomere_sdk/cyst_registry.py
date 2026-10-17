"""Checked CystRegistry reads and unsigned CAS plans with an independent reader."""

from __future__ import annotations

import copy
import json
import re
from typing import Any, Protocol

from .client import _address, _bytes32, _canonical, _integer, _object
from .crypto import CryptoVerifier
from .cysts import CheckpointCipher, HEADER_FIELDS, MAX_CIPHERTEXT_BYTES, _envelope, _metadata, decrypt_checkpoint
from .transport import ApiTransport, MAX_CYST_BODY_BYTES, Transport, normalize_origin, response_bound

MAX_REGISTRY_BYTES = 2_147_483_648
# Reviewed viem selectors; wallet plans also independently verify their Keccak derivation.
COMMIT_SELECTOR = bytes.fromhex("5c527c13")
RETIRE_SELECTOR = bytes.fromhex("4f934aa8")


class CystRegistryReader(Protocol):
    """Caller-owned trusted boundary, separate from the controller API.

    check() verifies chain, code hashes and the immutable Selection relationship.
    snapshot() reads binding/state at one confirmed canonical block and rechecks
    its block hash. It raises on unavailable, mismatched or reorganized evidence.
    """

    pins: dict[str, Any]

    def check(self) -> None: ...

    def snapshot(self, agent_id: str) -> dict[str, Any]: ...


def _id(value: Any) -> str:
    value = _bytes32(value)
    if int(value[2:], 16) == 0:
        raise ValueError("CystRegistry agent identity must be nonzero bytes32")
    return value


def _u64(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,19}", value) or int(value) >= 2 ** 64:
        raise ValueError("CystRegistry values require canonical uint64 decimal strings")
    return value


def _pins(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw, {"chainId", "registryAddress", "registryCodeHash",
                                       "selectionRegistryAddress", "selectionRegistryCodeHash", "confirmations"}))
    _integer(value["chainId"], 1, 2 ** 53 - 1)
    _integer(value["confirmations"], 0, 10_000)
    for key in ("registryAddress", "selectionRegistryAddress"):
        value[key] = _address(value[key])
    for key in ("registryCodeHash", "selectionRegistryCodeHash"):
        value[key] = _id(value[key])
    if value["registryAddress"] == value["selectionRegistryAddress"]:
        raise ValueError("CystRegistry and Selection pins must be distinct")
    return value


def _binding(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw, {"agentId", "owner", "agentWallet", "vault", "status", "frozen"}))
    value["agentId"] = _id(value["agentId"])
    for key in ("owner", "agentWallet", "vault"):
        value[key] = _address(value[key])
    _integer(value["status"], 1, 3)
    if type(value["frozen"]) is not bool:
        raise ValueError("Invalid Selection freeze state")
    return value


def _state(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw, {"agentId", "cystHash", "sizeBytes", "storageRef", "revision",
                                       "committedAt", "retired", "block"}))
    value["agentId"] = _id(value["agentId"])
    value["cystHash"], value["storageRef"] = _bytes32(value["cystHash"]), _bytes32(value["storageRef"])
    for key in ("sizeBytes", "revision", "committedAt"):
        _u64(value[key])
    if int(value["sizeBytes"]) > MAX_REGISTRY_BYTES or type(value["retired"]) is not bool:
        raise ValueError("Invalid CystRegistry size or retirement state")
    block = _object(value["block"], {"number", "hash"})
    _u64(block["number"])
    block["hash"] = _bytes32(block["hash"])
    return value


def _snapshot(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw, {"binding", "current"}))
    value["binding"], value["current"] = _binding(value["binding"]), _state(value["current"])
    if value["binding"]["agentId"] != value["current"]["agentId"]:
        raise ValueError("CystRegistry snapshot changed its agent identity")
    return value


def _checkpoint(raw: Any) -> dict[str, Any]:
    value = _metadata(raw)
    if value["state"] != "ready":
        raise ValueError("Use the original ready encrypted checkpoint")
    return value


def _key(raw: Any) -> str:
    if not isinstance(raw, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{8,128}", raw):
        raise ValueError("Use an 8..128 character CystRegistry idempotency key")
    return raw


def _transaction(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(_object(raw, {"chainId", "from", "to", "value", "data"}))
    _integer(value["chainId"], 1, 2 ** 53 - 1)
    value["from"], value["to"] = _address(value["from"]), _address(value["to"])
    if (value["value"] != "0" or not isinstance(value["data"], str) or len(value["data"]) > 2050
            or not re.fullmatch(r"0x(?:[a-fA-F0-9]{2})+", value["data"])):
        raise ValueError("Invalid unsigned CystRegistry transaction")
    return value


class CystRegistryClient:
    """Never signs or broadcasts; checkpoint labels do not confer agent authority."""

    def __init__(self, base_url: str, *, pins: dict[str, Any], reader: CystRegistryReader,
                 verifier: CryptoVerifier | None = None, transport: Transport | None = None):
        self.origin = normalize_origin(base_url)
        self._transport = transport or ApiTransport(self.origin)
        if normalize_origin(self._transport.origin) != self.origin:
            raise ValueError("Injected transport must use the exact CystRegistry origin")
        self._pins, self._reader, self._verifier = _pins(pins), reader, verifier
        self._crypto_checked = False
        if (reader is None or not callable(getattr(reader, "check", None)) or not callable(getattr(reader, "snapshot", None))
                or _pins(reader.pins) != self._pins):
            raise ValueError("Supply an independent CystRegistry reader with the exact reviewed pins")

    def _request(self, path: str, *, method: str = "GET", body: Any = None,
                 idempotency_key: str | None = None, max_response_bytes: int | None = None) -> Any:
        try:
            limit = response_bound(path, method, max_response_bytes)
            if body is not None and len(_canonical(body).encode("utf-8")) > 32_768:
                raise ValueError("CystRegistry request exceeds 32 KiB")
            options = {"method": method, "body": body, "idempotency_key": idempotency_key}
            if max_response_bytes is not None:
                options["max_response_bytes"] = limit
            value = self._transport.request(path, **options)
            if len(_canonical(value).encode("utf-8")) > limit:
                raise ValueError("CystRegistry response exceeds its published bound")
            return copy.deepcopy(value)
        except (TypeError, UnicodeError, RecursionError, OverflowError):
            raise ValueError("Invalid CystRegistry JSON data") from None

    def config(self) -> dict[str, Any]:
        if _pins(self._reader.pins) != self._pins:
            raise ValueError("CystRegistry reader differs from the reviewed pins")
        if self._reader.check() is not None:
            raise ValueError("Independent reader check must raise on failure and return None")
        value = _object(self._request("/api/cyst-registry/config"), {"protocol", "pins", "storageRefVersion",
                                                                  "maxCheckpointBytes", "maxRegistryBytes"})
        value["pins"] = _pins(value["pins"])
        if value["pins"] != self._pins:
            raise ValueError("CystRegistry deployment differs from the reviewed pins")
        if (value["protocol"] != "telomere-cyst-registry-v1" or type(value["storageRefVersion"]) is not int
                or value["storageRefVersion"] != 1 or type(value["maxCheckpointBytes"]) is not int
                or value["maxCheckpointBytes"] != MAX_CIPHERTEXT_BYTES or type(value["maxRegistryBytes"]) is not int
                or value["maxRegistryBytes"] != MAX_REGISTRY_BYTES):
            raise ValueError("Unsupported CystRegistry protocol or bounds")
        return copy.deepcopy(value)

    def _context(self, agent_id: str, mode: str) -> dict[str, Any]:
        self.config()
        principal = _object(self._request("/api/me"), {"address", "demo"})
        address = _address(principal["address"])
        if type(principal["demo"]) is not bool:
            raise ValueError("Invalid CystRegistry principal")
        value = _snapshot(self._reader.snapshot(agent_id))
        binding = value["binding"]
        if binding["agentId"] != agent_id:
            raise ValueError("Independent reader changed the requested agent identity")
        if address not in ((binding["owner"], binding["agentWallet"]) if mode == "read" else (binding["agentWallet"],)):
            raise ValueError("CystRegistry principal is not authorized for the requested operation")
        if mode == "commit" and binding["status"] == 3:
            raise ValueError("A dead agent cannot commit a new checkpoint")
        return value

    @staticmethod
    def _scope(checkpoint: dict[str, Any], snapshot: dict[str, Any]) -> None:
        if (checkpoint["owner"] != snapshot["binding"]["owner"]
                or checkpoint["agent"] != snapshot["binding"]["agentWallet"]):
            raise ValueError("Checkpoint labels differ from the authoritative Selection owner and agent wallet")

    @staticmethod
    def _compare(raw: Any, independent: dict[str, Any]) -> None:
        api = _snapshot(raw)
        if (api["binding"] != independent["binding"]
                or {key: value for key, value in api["current"].items() if key != "block"}
                != {key: value for key, value in independent["current"].items() if key != "block"}):
            raise ValueError("CystRegistry response differs from the independent current state")

    def _digest(self, raw: bytes) -> bytes:
        if self._verifier is None:
            raise ValueError("A reviewed CryptoVerifier is required for CystRegistry plans and checkpoint verification")
        if not self._crypto_checked:
            if self._verifier.keccak256(b"") != bytes.fromhex("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"):
                raise ValueError("CryptoVerifier must implement Ethereum Keccak-256")
            self._crypto_checked = True
        result = self._verifier.keccak256(raw)
        if not isinstance(result, bytes) or len(result) != 32:
            raise ValueError("CryptoVerifier returned an invalid Keccak digest")
        return result

    def _selector(self, signature: str, expected: bytes) -> bytes:
        if self._digest(signature.encode("ascii"))[:4] != expected:
            raise ValueError("CystRegistry function selector differs from the reviewed viem vector")
        return expected

    def _storage_ref(self, checkpoint: dict[str, Any]) -> str:
        value = ["telomere.cyst.locator", 1, checkpoint["version"], checkpoint["algorithm"], checkpoint["id"],
                 checkpoint["owner"], checkpoint["agent"], checkpoint["applicationSchema"], checkpoint["plaintextBytes"],
                 checkpoint["nonce"], checkpoint["sha256"], checkpoint["ciphertextBytes"]]
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        return "0x" + self._digest(encoded).hex()

    def _matches(self, current: dict[str, Any], checkpoint: dict[str, Any], storage_ref: str) -> bool:
        return (int(current["revision"]) > 0 and not current["retired"] and current["cystHash"] == "0x" + checkpoint["sha256"]
                and current["sizeBytes"] == str(checkpoint["ciphertextBytes"]) and current["storageRef"] == storage_ref)

    def _plan(self, snapshot: dict[str, Any], data: bytes) -> dict[str, Any]:
        return {"chainId": self._pins["chainId"], "from": snapshot["binding"]["agentWallet"],
                "to": self._pins["registryAddress"], "value": "0", "data": "0x" + data.hex()}

    def latest(self, agent_id: str) -> dict[str, Any]:
        agent_id = _id(agent_id)
        self._context(agent_id, "read")
        raw = self._request("/api/cyst-registry/agents/" + agent_id + "/latest")
        independent = self._context(agent_id, "read")
        self._compare(raw, independent)
        return copy.deepcopy(independent)

    def commit_plan(self, agent_id: str, expected_checkpoint: dict[str, Any], *, idempotency_key: str) -> dict[str, Any]:
        agent_id, checkpoint, key = _id(agent_id), _checkpoint(expected_checkpoint), _key(idempotency_key)
        selector = self._selector("commitChecked(bytes32,bytes32,uint64,bytes32,uint64)", COMMIT_SELECTOR)
        self._scope(checkpoint, self._context(agent_id, "commit"))
        value = _object(self._request("/api/cyst-registry/agents/" + agent_id + "/commit-plan", method="POST",
                                     body={"checkpointId": checkpoint["id"]}, idempotency_key=key),
                        {"binding", "checkpoint", "current", "transaction"})
        independent = self._context(agent_id, "commit")
        self._scope(checkpoint, independent)
        self._compare({"binding": value["binding"], "current": value["current"]}, independent)
        data = (selector + bytes.fromhex(agent_id[2:]) + bytes.fromhex(checkpoint["sha256"])
                + checkpoint["ciphertextBytes"].to_bytes(32, "big") + bytes.fromhex(self._storage_ref(checkpoint)[2:])
                + int(independent["current"]["revision"]).to_bytes(32, "big"))
        transaction = _transaction(value["transaction"])
        if _checkpoint(value["checkpoint"]) != checkpoint or transaction != self._plan(independent, data):
            raise ValueError("CystRegistry commit plan changed the original checkpoint or exact unsigned transaction")
        return copy.deepcopy({**independent, "checkpoint": checkpoint, "transaction": transaction})

    def retire_plan(self, agent_id: str, expected_revision: str, *, idempotency_key: str) -> dict[str, Any]:
        agent_id, revision, key = _id(agent_id), _u64(expected_revision), _key(idempotency_key)
        selector = self._selector("retireChecked(bytes32,uint64)", RETIRE_SELECTOR)
        before = self._context(agent_id, "retire")
        if before["current"]["revision"] != revision or revision == "0" or before["current"]["retired"]:
            raise ValueError("Retire requires the exact current live checkpoint revision")
        value = _object(self._request("/api/cyst-registry/agents/" + agent_id + "/retire-plan", method="POST",
                                     body={"expectedRevision": revision}, idempotency_key=key), {"binding", "current", "transaction"})
        independent = self._context(agent_id, "retire")
        self._compare({"binding": value["binding"], "current": value["current"]}, independent)
        transaction = _transaction(value["transaction"])
        data = selector + bytes.fromhex(agent_id[2:]) + int(revision).to_bytes(32, "big")
        if independent["current"]["revision"] != revision or independent["current"]["retired"] or transaction != self._plan(independent, data):
            raise ValueError("CystRegistry retire plan changed the original revision or exact unsigned transaction")
        return copy.deepcopy({**independent, "transaction": transaction})

    def verify(self, agent_id: str, expected_checkpoint: dict[str, Any]) -> dict[str, Any]:
        agent_id, checkpoint = _id(agent_id), _checkpoint(expected_checkpoint)
        storage_ref = self._storage_ref(checkpoint)
        self._scope(checkpoint, self._context(agent_id, "read"))
        value = _object(self._request("/api/cyst-registry/agents/" + agent_id + "/verify", method="POST",
                                     body={"checkpointId": checkpoint["id"]}), {"binding", "checkpoint", "current", "matches"})
        independent = self._context(agent_id, "read")
        self._scope(checkpoint, independent)
        self._compare({"binding": value["binding"], "current": value["current"]}, independent)
        current = independent["current"]
        matches = self._matches(current, checkpoint, storage_ref)
        if _checkpoint(value["checkpoint"]) != checkpoint or type(value["matches"]) is not bool or value["matches"] != matches:
            raise ValueError("CystRegistry verification changed the original checkpoint or independent result")
        return copy.deepcopy({**independent, "checkpoint": checkpoint, "matches": matches})

    def download(self, agent_id: str, expected_checkpoint: dict[str, Any]) -> dict[str, Any]:
        agent_id, checkpoint = _id(agent_id), _checkpoint(expected_checkpoint)
        storage_ref = self._storage_ref(checkpoint)
        before = self._context(agent_id, "read")
        self._scope(checkpoint, before)
        if not self._matches(before["current"], checkpoint, storage_ref):
            raise ValueError("Checkpoint is not the current published live revision")
        value = _object(self._request("/api/cyst-registry/agents/" + agent_id + "/checkpoints/" + checkpoint["id"] + "/blob",
                                     max_response_bytes=MAX_CYST_BODY_BYTES), {"binding", "current", "checkpoint", "ciphertext"})
        independent = self._context(agent_id, "read")
        self._scope(checkpoint, independent)
        self._compare({"binding": value["binding"], "current": value["current"]}, independent)
        if _checkpoint(value["checkpoint"]) != checkpoint or not self._matches(independent["current"], checkpoint, storage_ref):
            raise ValueError("Checkpoint download differs from the original current published checkpoint")
        envelope, raw = _envelope({**{key: checkpoint[key] for key in HEADER_FIELDS}, "sha256": checkpoint["sha256"],
                                   "ciphertext": value["ciphertext"]})
        if len(raw) != checkpoint["ciphertextBytes"]:
            raise ValueError("Published checkpoint ciphertext length changed")
        return copy.deepcopy(envelope)

    def restore(self, agent_id: str, expected_checkpoint: dict[str, Any], recovery_key: bytes | bytearray, *,
                cipher: CheckpointCipher | None = None) -> bytes:
        if cipher is None:
            raise ValueError("Supply an explicit reviewed CheckpointCipher before restoring state")
        checkpoint = _checkpoint(expected_checkpoint)
        envelope = self.download(agent_id, checkpoint)
        return decrypt_checkpoint(envelope, recovery_key, cipher=cipher, owner=checkpoint["owner"], agent=checkpoint["agent"])
