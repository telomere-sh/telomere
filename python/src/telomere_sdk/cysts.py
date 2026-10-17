"""Opaque Cyst API access and explicit client-side application checkpoint AEAD."""

from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import json
import re
import secrets
import threading
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Protocol
from urllib.parse import urlencode

from .transport import MAX_CYST_BODY_BYTES

MAX_PLAINTEXT_BYTES = 2 * 1024 * 1024
MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + 16
MAX_OWNER_BYTES = 32 * 1024 * 1024
HEADER_FIELDS = {"version", "algorithm", "id", "owner", "agent", "applicationSchema", "plaintextBytes", "nonce"}
CAPABILITIES = {"version": 1, "algorithm": "xchacha20-poly1305", "maxPlaintextBytes": MAX_PLAINTEXT_BYTES,
                "maxCiphertextBytes": MAX_CIPHERTEXT_BYTES, "maxUploadBodyBytes": MAX_CYST_BODY_BYTES,
                "maxOwnerBytes": MAX_OWNER_BYTES, "maxOwnerCheckpoints": 512, "listLimit": 100,
                "storage": "local-private-ciphertext", "checkpoint": "application-state", "keyManagement": "client-recovery-key"}
QUOTA_POLICY_V2 = {"version": 2, "kind": "telomere-cyst-quota-v2", "maxOwnerCheckpoints": 4096, "maxOwnerBytes": MAX_OWNER_BYTES}


def _object(value: Any, fields: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("Unexpected checkpoint fields")
    return copy.deepcopy(value)


def _int(value: Any, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("Checkpoint value exceeds its published bounds")
    return value


def _hex(value: Any, size: int, *, prefix: bool = False) -> str:
    expression = ("0x" if prefix else "") + "[a-f0-9]{" + str(size * 2) + "}"
    if not isinstance(value, str) or re.fullmatch(expression, value) is None:
        raise ValueError("Invalid checkpoint identifier, nonce or digest")
    return value


def _address(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", value):
        raise ValueError("Invalid checkpoint owner or agent")
    return value.lower()


def _header(value: Any) -> dict[str, Any]:
    header = _object(value, HEADER_FIELDS)
    if type(header["version"]) is not int or header["version"] != 1 or header["algorithm"] != "xchacha20-poly1305":
        raise ValueError("Unsupported checkpoint format")
    _hex(header["id"], 32, prefix=True); _hex(header["nonce"], 24)
    header["owner"], header["agent"] = _address(header["owner"]), _address(header["agent"])
    schema = header["applicationSchema"]
    if not isinstance(schema, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}", schema):
        raise ValueError("Invalid application checkpoint schema")
    _int(header["plaintextBytes"], 1, MAX_PLAINTEXT_BYTES)
    return header


def _capabilities(value: Any, quota_version: int = 1) -> dict[str, Any]:
    expected_values = CAPABILITIES if quota_version == 1 else {**CAPABILITIES, "maxOwnerCheckpoints": 4096, "quotaPolicy": QUOTA_POLICY_V2}
    capabilities = _object(value, set(expected_values))
    if any(type(capabilities[key]) is not type(expected) or capabilities[key] != expected for key, expected in expected_values.items()):
        raise ValueError("Checkpoint capabilities differ from the supported pilot")
    if quota_version == 2:
        policy = _object(capabilities["quotaPolicy"], set(QUOTA_POLICY_V2))
        if any(type(policy[key]) is not type(expected) or policy[key] != expected for key, expected in QUOTA_POLICY_V2.items()):
            raise ValueError("Checkpoint quota profile changed")
    return capabilities


def _metadata(value: Any) -> dict[str, Any]:
    metadata = _object(value, HEADER_FIELDS | {"sha256", "ciphertextBytes", "state", "createdAt"})
    metadata.update(_header({key: metadata[key] for key in HEADER_FIELDS}))
    _hex(metadata["sha256"], 32)
    _int(metadata["ciphertextBytes"], 17, MAX_CIPHERTEXT_BYTES)
    if metadata["ciphertextBytes"] != metadata["plaintextBytes"] + 16 or metadata["state"] not in ("pending", "ready"):
        raise ValueError("Checkpoint state or ciphertext length changed")
    created = metadata["createdAt"]
    if not isinstance(created, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z", created):
        raise ValueError("Invalid checkpoint creation time")
    try:
        datetime.fromisoformat(created.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("Invalid checkpoint creation time") from None
    return metadata


def _envelope(value: Any) -> tuple[dict[str, Any], bytes]:
    envelope = _object(value, HEADER_FIELDS | {"sha256", "ciphertext"})
    envelope.update(_header({key: envelope[key] for key in HEADER_FIELDS}))
    _hex(envelope["sha256"], 32)
    ciphertext = envelope["ciphertext"]
    if not isinstance(ciphertext, str) or not 24 <= len(ciphertext) <= ((MAX_CIPHERTEXT_BYTES + 2) // 3) * 4:
        raise ValueError("Checkpoint ciphertext exceeds its byte limit")
    try:
        raw = base64.b64decode(ciphertext, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("Invalid checkpoint ciphertext encoding") from None
    if (base64.b64encode(raw).decode("ascii") != ciphertext or len(raw) != envelope["plaintextBytes"] + 16
            or hashlib.sha256(raw).hexdigest() != envelope["sha256"]):
        raise ValueError("Checkpoint ciphertext failed its length or SHA-256 check")
    return envelope, raw


def checkpoint_aad(header: dict[str, Any]) -> bytes:
    header = _header(header)
    return json.dumps(["telomere.application-cyst", header["version"], header["algorithm"], header["id"], header["owner"],
                       header["agent"], header["applicationSchema"], header["plaintextBytes"], header["nonce"]],
                      ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


class CheckpointCipher(Protocol):
    def encrypt(self, key: bytearray, nonce: bytes, plaintext: bytes | bytearray, aad: bytes) -> bytes: ...
    def decrypt(self, key: bytearray, nonce: bytes, ciphertext_and_tag: bytes, aad: bytes) -> bytes: ...


class PyCryptodomeCipher:
    """Explicit optional XChaCha20-Poly1305 adapter. It never makes network calls."""

    def __init__(self) -> None:
        try:
            from Crypto.Cipher import ChaCha20_Poly1305
        except ImportError:
            raise RuntimeError("Install the recorded optional crypto requirements or provide a reviewed CheckpointCipher") from None
        self._cipher = ChaCha20_Poly1305

    def encrypt(self, key: bytearray, nonce: bytes, plaintext: bytes | bytearray, aad: bytes) -> bytes:
        cipher = self._cipher.new(key=key, nonce=nonce)
        cipher.update(aad)
        ciphertext, tag = cipher.encrypt_and_digest(plaintext)
        return ciphertext + tag

    def decrypt(self, key: bytearray, nonce: bytes, ciphertext_and_tag: bytes, aad: bytes) -> bytes:
        cipher = self._cipher.new(key=key, nonce=nonce)
        cipher.update(aad)
        return cipher.decrypt_and_verify(ciphertext_and_tag[:-16], ciphertext_and_tag[-16:])


def _key(value: Any) -> bytearray:
    if not isinstance(value, (bytes, bytearray)) or len(value) != 32:
        raise ValueError("Use a 32-byte checkpoint recovery key")
    return bytearray(value)


def export_checkpoint_key(recovery_key: bytes | bytearray) -> str:
    temporary = _key(recovery_key)
    try:
        return temporary.hex()
    finally:
        temporary[:] = b"\0" * 32


def import_checkpoint_key(value: str) -> bytearray:
    return bytearray.fromhex(_hex(value, 32))


@dataclass(frozen=True)
class EncryptedCheckpoint:
    _envelope_json: str = field(repr=False)
    recovery_key: bytearray = field(repr=False)

    @property
    def envelope(self) -> dict[str, Any]:
        return json.loads(self._envelope_json)

    def clear_key(self) -> None:
        self.recovery_key[:] = b"\0" * len(self.recovery_key)


def encrypt_checkpoint(plaintext: bytes | bytearray, *, owner: str, application_schema: str,
                       agent: str | None = None, cipher: CheckpointCipher | None = None,
                       recovery_key: bytes | bytearray | None = None) -> EncryptedCheckpoint:
    if cipher is None:
        raise ValueError("Supply an explicit reviewed CheckpointCipher before encrypting state")
    if not isinstance(plaintext, (bytes, bytearray)) or not 1 <= len(plaintext) <= MAX_PLAINTEXT_BYTES:
        raise ValueError("Application checkpoint must contain between 1 byte and 2 MiB")
    key = bytearray(secrets.token_bytes(32)) if recovery_key is None else _key(recovery_key)
    returned = False
    try:
        header = _header({"version": 1, "algorithm": "xchacha20-poly1305", "id": "0x" + secrets.token_hex(32),
                          "owner": owner, "agent": owner if agent is None else agent, "applicationSchema": application_schema,
                          "plaintextBytes": len(plaintext), "nonce": secrets.token_hex(24)})
        raw = cipher.encrypt(key, bytes.fromhex(header["nonce"]), plaintext, checkpoint_aad(header))
        if not isinstance(raw, bytes) or len(raw) != len(plaintext) + 16:
            raise ValueError("CheckpointCipher returned an invalid ciphertext length")
        envelope, _ = _envelope({**header, "sha256": hashlib.sha256(raw).hexdigest(), "ciphertext": base64.b64encode(raw).decode("ascii")})
        result = EncryptedCheckpoint(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")), key)
        returned = True
        return result
    finally:
        if not returned:
            key[:] = b"\0" * len(key)


def decrypt_checkpoint(value: dict[str, Any], recovery_key: bytes | bytearray, *, cipher: CheckpointCipher | None = None,
                       owner: str, agent: str | None = None) -> bytes:
    if cipher is None:
        raise ValueError("Supply an explicit reviewed CheckpointCipher before restoring state")
    envelope, raw = _envelope(value)
    if envelope["owner"] != _address(owner) or (agent is not None and envelope["agent"] != _address(agent)):
        raise ValueError("Checkpoint owner or agent scope changed")
    key = _key(recovery_key)
    try:
        try:
            plaintext = cipher.decrypt(key, bytes.fromhex(envelope["nonce"]), raw,
                                       checkpoint_aad({name: envelope[name] for name in HEADER_FIELDS}))
        except (TypeError, ValueError):
            raise ValueError("Checkpoint authentication failed; check the recovery key and original metadata") from None
        if not isinstance(plaintext, bytes) or len(plaintext) != envelope["plaintextBytes"]:
            raise ValueError("CheckpointCipher returned an invalid plaintext length")
        return plaintext
    finally:
        key[:] = b"\0" * len(key)


class CystClient:
    def __init__(self, request: Callable[..., Any], owner: Callable[[], str], *, quota_version: int | None = None):
        if quota_version is not None and (type(quota_version) is not int or quota_version != 2):
            raise ValueError("Explicit checkpoint quota version must be 2")
        self._quota_version = 1 if quota_version is None else 2
        self._request = request if quota_version is None else lambda path, **options: request(path, **options, cyst_quota_version=2)
        self._current_owner = owner
        self._upload_inputs: dict[tuple[str, str], str] = {}
        self._lock = threading.RLock()

    def _owner(self, expected: str | None = None) -> str:
        current = _address(self._current_owner())
        if expected is not None and current != expected:
            raise ValueError("The signed-in checkpoint owner changed")
        return current

    def capabilities(self) -> dict[str, Any]:
        owner = self._owner()
        value = _capabilities(self._request("/api/cysts/capabilities"), self._quota_version)
        self._owner(owner)
        return value

    def list(self, *, agent: str | None = None, cursor: str | None = None) -> dict[str, Any]:
        owner = self._owner()
        agent = None if agent is None else _address(agent)
        cursor = None if cursor is None else _hex(cursor, 32, prefix=True)
        query = {key: value for key, value in (("agent", agent), ("cursor", cursor)) if value is not None}
        path = "/api/cysts" + ("?" + urlencode(query) if query else "")
        response = self._request(path)
        fields = {"checkpoints", "usage", "capabilities"}
        if isinstance(response, dict) and "nextCursor" in response:
            fields.add("nextCursor")
        result = _object(response, fields)
        _capabilities(result["capabilities"], self._quota_version)
        rows = result["checkpoints"]
        if not isinstance(rows, list) or len(rows) > 100:
            raise ValueError("Checkpoint list exceeds its page limit")
        result["checkpoints"] = [_metadata(row) for row in rows]
        previous = cursor or ""
        for row in result["checkpoints"]:
            if row["owner"] != owner or (agent is not None and row["agent"] != agent) or row["id"] <= previous:
                raise ValueError("Checkpoint list owner, agent or cursor scope changed")
            previous = row["id"]
        usage = _object(result["usage"], {"bytes", "checkpoints"})
        _int(usage["bytes"], 0, MAX_OWNER_BYTES); _int(usage["checkpoints"], 0, 4096 if self._quota_version == 2 else 512)
        if usage["bytes"] < sum(row["ciphertextBytes"] for row in result["checkpoints"]) or usage["checkpoints"] < len(rows):
            raise ValueError("Checkpoint quota usage is inconsistent")
        if "nextCursor" in result and (_hex(result["nextCursor"], 32, prefix=True) != previous or len(rows) != 100):
            raise ValueError("Checkpoint next cursor does not match this full page")
        self._owner(owner)
        return result

    def metadata(self, checkpoint_id: str, *, agent: str | None = None) -> dict[str, Any]:
        owner = self._owner()
        checkpoint_id = _hex(checkpoint_id, 32, prefix=True)
        result = _metadata(self._request("/api/cysts/" + checkpoint_id))
        if result["id"] != checkpoint_id or result["owner"] != owner or (agent is not None and result["agent"] != _address(agent)):
            raise ValueError("Checkpoint metadata scope changed")
        self._owner(owner)
        return result

    def upload(self, value: dict[str, Any], *, idempotency_key: str) -> dict[str, Any]:
        envelope, raw = _envelope(value)
        owner = self._owner()
        if envelope["owner"] != owner:
            raise ValueError("Checkpoint owner differs from the signed-in account")
        if not isinstance(idempotency_key, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{8,128}", idempotency_key):
            raise ValueError("Invalid checkpoint idempotency key")
        fingerprint = hashlib.sha256(json.dumps(envelope, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        with self._lock:
            identity = owner, idempotency_key
            if identity in self._upload_inputs and self._upload_inputs[identity] != fingerprint:
                raise ValueError("Retry the original encrypted checkpoint with its original key")
            self._upload_inputs[identity] = fingerprint
            self._owner(owner)
            response = _object(self._request("/api/cysts", method="POST", body=envelope, idempotency_key=idempotency_key), {"checkpoint", "replayed"})
            metadata = _metadata(response["checkpoint"])
            if (type(response["replayed"]) is not bool or metadata["state"] != "ready" or metadata["ciphertextBytes"] != len(raw)
                    or metadata["sha256"] != envelope["sha256"] or any(metadata[key] != envelope[key] for key in HEADER_FIELDS)):
                raise ValueError("Checkpoint upload response changed the original ciphertext or scope")
            self._owner(owner)
            return {"checkpoint": metadata, "replayed": response["replayed"]}

    def download(self, checkpoint_id: str, *, owner: str | None = None, agent: str | None = None) -> dict[str, Any]:
        current = self._owner()
        expected = current if owner is None else _address(owner)
        if current != expected:
            raise ValueError("Checkpoint owner differs from the signed-in account")
        checkpoint_id = _hex(checkpoint_id, 32, prefix=True)
        response = _object(self._request("/api/cysts/" + checkpoint_id + "/blob", max_response_bytes=MAX_CYST_BODY_BYTES), {"metadata", "ciphertext"})
        metadata = _metadata(response["metadata"])
        if (metadata["state"] != "ready" or metadata["id"] != checkpoint_id or metadata["owner"] != expected
                or (agent is not None and metadata["agent"] != _address(agent))):
            raise ValueError("Checkpoint download scope changed")
        envelope, raw = _envelope({**{key: metadata[key] for key in HEADER_FIELDS}, "sha256": metadata["sha256"], "ciphertext": response["ciphertext"]})
        if len(raw) != metadata["ciphertextBytes"]:
            raise ValueError("Checkpoint ciphertext length changed")
        self._owner(current)
        return envelope

    def restore(self, checkpoint_id: str, recovery_key: bytes | bytearray, *, cipher: CheckpointCipher | None = None,
                owner: str | None = None, agent: str | None = None) -> bytes:
        if cipher is None:
            raise ValueError("Supply an explicit reviewed CheckpointCipher before restoring state")
        current = self._owner()
        envelope = self.download(checkpoint_id, owner=current if owner is None else owner, agent=agent)
        self._owner(current)
        plaintext = decrypt_checkpoint(envelope, recovery_key, cipher=cipher, owner=current, agent=agent)
        self._owner(current)
        return plaintext
