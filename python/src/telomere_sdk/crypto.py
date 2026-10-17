"""Pluggable verification only. No private keys, signing or transaction submission."""

from __future__ import annotations

from typing import Any, Protocol


class CryptoVerifier(Protocol):
    def keccak256(self, value: bytes) -> bytes: ...
    def checksum_address(self, address: str) -> str: ...
    def verify_message(self, address: str, message: str, signature: str) -> bool: ...
    def verify_typed_data(self, address: str, typed_data: dict[str, Any], signature: str) -> bool: ...


class EthAccountVerifier:
    """Optional adapter for the explicitly installed ``crypto`` extra."""

    def __init__(self) -> None:
        try:
            from eth_account import Account
            from eth_account.messages import encode_defunct, encode_typed_data
            from eth_utils import keccak, to_checksum_address
        except ImportError:
            raise RuntimeError("Install telomere-pilot-sdk[crypto] or provide a reviewed CryptoVerifier") from None
        self._account, self._defunct, self._typed = Account, encode_defunct, encode_typed_data
        self._keccak, self._checksum = keccak, to_checksum_address

    def keccak256(self, value: bytes) -> bytes:
        return self._keccak(value)

    def checksum_address(self, address: str) -> str:
        return self._checksum(address)

    def verify_message(self, address: str, message: str, signature: str) -> bool:
        try:
            recovered = self._account.recover_message(self._defunct(text=message), signature=signature)
            return recovered.lower() == address.lower()
        except (ValueError, TypeError):
            return False

    def verify_typed_data(self, address: str, typed_data: dict[str, Any], signature: str) -> bool:
        try:
            recovered = self._account.recover_message(self._typed(full_message=typed_data), signature=signature)
            return recovered.lower() == address.lower()
        except (ValueError, TypeError):
            return False
