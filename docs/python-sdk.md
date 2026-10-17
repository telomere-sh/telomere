# Python SDK for the bounded pilot

The package in `python/` supports Python 3.11 and later. Its HTTP transport and read operations use the standard library. It adds the Python integration track of the original specification; it does not implement arbitrary Linux workloads, GPU rental, Host Kit, agent autonomy, or a supplier market.

## Read the local pilot without a personal wallet

Install from the repository root with `python -m pip install -e ./python`.

```python
from telomere_sdk import TelomereClient

client = TelomereClient("http://127.0.0.1:3281")
config = client.config()
client.authenticate_demo(explicitly_enabled=True)
print(client.balance())
print(client.runs())
print(client.leashes())
print(client.operations())
# client.receipt(run_id) fetches the receipt and reports the API's verification.
client.logout()
```

Demo sign-in is explicitly restricted to a loopback origin, `mode=demo` and chain 31337. The SDK deliberately has no demo-funding or demo-transaction methods. The example only signs into the local demo session and reads state.

`ApiTransport` accepts a fixed HTTPS origin or loopback HTTP origin. It rejects user info, URL paths, query strings and fragments in the base URL, redirects, encoded path traversal, oversized bodies, invalid UTF-8, duplicate JSON keys and non-finite JSON numbers. POST requests carry the exact `Origin`; all requests have a maximum 30-second socket timeout. Requests are never automatically retried. The SDK retains only the exact origin's `telomere_session` cookie, with bounded lifetime, `/` path, `HttpOnly` and `SameSite=Strict`; HTTPS requires `Secure`. Sessions stay in memory. Errors include status and a bounded safe error code, not remote detail, response bodies, cookies or signatures. Environment proxy settings are disabled for this transport.

An injected `Transport` must have the exact same origin and implement `request(path, method=..., body=..., idempotency_key=..., max_response_bytes=...)` and `clear_session()`. `max_response_bytes` is only passed for the Cyst blob endpoint. Its network and session handling becomes the integrator's responsibility; client validation still checks response size, types and financial terms.

## Prepare wallet intents with cryptographic verification

All financial intents require explicitly supplied, independently reviewed deployment pins and a `CryptoVerifier`. Do not treat an untrusted API configuration as reviewed pins. The constructor permits read-only use without pins or a verifier; that mode cannot return an executable quote or wallet intent.

The optional `EthAccountVerifier` adapter uses `eth-account==0.13.7`, `eth-utils` and their explicitly installed dependencies. It only verifies signatures and hashes. Install the exact tested versions with `python -m pip install -r python/requirements-crypto.txt`; the convenient `crypto` extra pins `eth-account`, while the requirements file pins the tested transitive versions. The adapter follows the primary [eth-account message and typed-data verification API](https://eth-account.readthedocs.io/en/v0.13.7/eth_account.html).

```python
from telomere_sdk import DeploymentPins, EthAccountVerifier, TelomereClient

# Values come from your independently reviewed deployment manifest.
pins = DeploymentPins(
    chain_id=manifest["chainId"],
    escrow_address=manifest["escrowAddress"],
    token_address=manifest["tokenAddress"],
    receipt_signer=manifest["receiptSigner"],
    token_code_hash=manifest["tokenCodeHash"],
    asset_implementation=manifest["assetImplementation"],
)
client = TelomereClient(api_origin, pins=pins, verifier=EthAccountVerifier())

# Signer is supplied by your external wallet integration. No key enters the SDK.
client.authenticate(owner_address, chain_id=pins.chain_id,
                    sign_message=external_wallet.sign_message)
quoted = client.quote(
    {"leashId": leash_id, "task": {"kind": "sha256", "text": "pilot"}, "maxSeconds": 5},
    idempotency_key="unique_request_0001",
)
plan = quoted.wallet_action
# Present plan.intents and quoted.ceiling to the owner in the external wallet.
# After that wallet confirms the original openRun transaction:
run = client.admit(quoted, original_confirmed_tx_hash)
```

The sign-in challenge must exactly match the origin, owner checksum address, chain, nonce, permission sentence and five-minute validity window before invoking the signer. The returned owner signature is also checked locally before sending it to the API. Personal wallet signing is an explicit caller action; no SDK test or demo example requires it.

`quote()` validates canonical workload hashing, published tariffs, payer, Leash, duration, ceiling conservation, short expiry, the operator's EIP-712 signature and exact `openRun` calldata. It keeps the original request fingerprint even after an uncertain API failure. Explicit retries reuse the same key and input; changing input under that key is refused. Successful concurrent calls share one POST and one immutable result. Cached quotes are checked for expiry and owner changes. `admit()` only accepts the exact `QuotedRun` issued by that client and preserves the original transaction hash after an uncertain admission; the API independently verifies its confirmed on-chain reservation.

Supported checked intents:

| Method | Intent returned |
| --- | --- |
| `prepare_deposit(amount)` | Exact token approval plus escrow deposit |
| `prepare_withdraw(amount)` | Escrow withdrawal |
| `prepare_leash(max_per_hour=..., max_per_day=..., expiry=..., agent=...)` | Create a bounded delegated budget |
| `prepare_update_leash(id, max_per_hour=..., max_per_day=..., expiry=...)` | Update limits and expiry; preserve the current owned Leash agent |
| `prepare_stop(run_id)` | Request stop; previously accepted work remains payable |
| `prepare_refund(run_id)` | Request timeout refund; contract enforces eligibility |
| `prepare_kill(leash_id)` | Permanently kill a budget |

Amounts are canonical decimal strings of six-decimal token units, not floating-point token amounts. Every transaction must match the configured target, full ABI calldata and zero native value. Unknown transaction fields, changed targets, unlimited substituted approvals, unexpected delegated agents and altered calldata are rejected. Leash budgets require positive hourly limits, a daily limit at least as large, and an expiry within 30 days. The existing five-argument `updateLeash(bytes32,address,uint96,uint96,uint64)` ABI is preserved.

Remote public config accepts HTTPS Base Sepolia `84532` only with Circle native USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, `https://sepolia.base.org` and `https://sepolia.basescan.org`, or HTTPS Base mainnet `8453` only with native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `https://mainnet.base.org` and `https://basescan.org`. Explicit loopback HTTP is also allowed for local Base development. Both require `USDC`, six token decimals and independently supplied USDC proxy/implementation address and code-hash pins matching the API config. Public config is rejected even for read-only use without those pins. Local demo chain 31337 requires a loopback origin and may omit them. The former Robinhood chains `46630`/`4663`, USDG and all other chains are rejected before wallet-plan preparation. The SDK compares pins to API claims; it does not query RPC to establish deployed bytecode or balances independently, so deployment pin review remains an external prerequisite. Wallet plans are frozen records for review, not proof of wallet consent or transaction confirmation. Circle publishes the [native USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses).

## Receipt verification has explicit evidence levels

`receipt(run_id)` fetches the receipt and calls `verify_receipt(receipt)`. Without crypto and pins, `signature_verified` and `body_consistent` are `None`; only `server_valid` and `server_anchored` report the API's claims. With both supplied, the SDK also verifies canonical receipt hashing, the pinned signer/domain, the settlement EIP-712 signature, owner/run identifiers, token, metering bounds and charge/refund conservation.

`onchain_verified` is always `False`: this SDK has no independent RPC verifier. A server-reported anchor is not upgraded to independent cryptographic on-chain evidence. Neither the receipt verifier nor the optional Ethereum adapter validates NEAR TEE/GPU hardware evidence; that remains the separate provider policy and appraisal path. CPU receipt signatures remain operator attestations of metering.

## Encrypted application checkpoints: Python Cysts companion

`client.cysts` supports `capabilities()`, `list(agent=..., cursor=...)`, `metadata(id, agent=...)`, `upload(envelope, idempotency_key=...)`, `download(id, owner=..., agent=...)` and `restore(id, recovery_key, cipher=..., owner=..., agent=...)`. All network operations use the existing owner session, verify the exact owner scope before and after I/O, and retain the fixed API origin. Capabilities must match the published pilot limits. Lists require sorted unique identifiers, exact owner/agent filters, a consistent full-page next cursor and bounded quota usage. Download requires a ready checkpoint and checks its identifier, owner, optional agent, exact ciphertext length, canonical base64 and SHA-256. Upload compares every echoed authenticated header field and the digest, and only explicitly retries the original envelope under its original idempotency key.

The dependency-free companion can inspect metadata and verify/download opaque ciphertext. SHA-256 alone does not establish AEAD authenticity. Local encryption/restoration requires an explicitly supplied `CheckpointCipher`; the supplied `PyCryptodomeCipher` uses the already recorded optional `pycryptodome==3.24.0` dependency. Both the installed module's primary documentation and [PyCryptodome's official cipher API](https://www.pycryptodome.org/src/cipher/chacha20_poly1305) specify that a 24-byte nonce selects XChaCha20-Poly1305, with a 32-byte key and 16-byte tag. No new runtime dependency is required beyond the previously recorded crypto environment.

```python
from telomere_sdk import PyCryptodomeCipher, encrypt_checkpoint, export_checkpoint_key

owner = client.me()["address"]
cipher = PyCryptodomeCipher()
# Read a file with an explicit bound before preparing its application checkpoint.
with open(application_state_path, "rb") as source:
    plaintext = bytearray(source.read(2 * 1024 * 1024 + 1))
encrypted = encrypt_checkpoint(plaintext, owner=owner,
                               application_schema="agent-state/v1", cipher=cipher)
try:
    # Save this value in client-side private storage before upload. Do not log it.
    recovery_code = export_checkpoint_key(encrypted.recovery_key)
    save_private_recovery_code(recovery_code)
    client.cysts.upload(encrypted.envelope, idempotency_key="original_checkpoint_0001")
    restored = client.cysts.restore(encrypted.envelope["id"], encrypted.recovery_key,
                                   cipher=cipher, owner=owner)
    # Parse application state yourself; the SDK never executes checkpoint bytes.
finally:
    plaintext[:] = b"\0" * len(plaintext)
    encrypted.clear_key()
```

The cipher binds the same fixed AAD tuple as the TypeScript SDK: domain, version, algorithm, ID, normalized owner and agent, application schema, plaintext length and nonce. New checkpoints generate an independent random 32-byte recovery key, 24-byte nonce and 32-byte identifier with Python `secrets`. The recovery key is omitted from the encrypted result's representation and from upload payloads. `EncryptedCheckpoint.envelope` returns a copy; `clear_key()` clears the retained mutable key. Import/export and decrypt wipe their temporary mutable copies. Python immutable strings/bytes and native cipher internals do not permit a guarantee of complete memory erasure; the client does not persist secrets or transmit them to the server.

Plaintext is bounded to 2 MiB, ciphertext to that length plus a 16-byte tag, and owner storage to the advertised 32 MiB / 512 checkpoints. Normal requests retain their 196,608-byte body budget and 1 MiB response limit. Only exact POST `/api/cysts` permits a larger upload body, and only exact GET `/api/cysts/0x<64 lowercase hex>/blob` permits an explicitly requested response bound up to 2,800,320 bytes. A larger limit cannot be applied to auth, quotes, ordinary metadata or an arbitrary API path. Both declared response length and actual stream bytes are checked.

This implements encrypted **application files**, not Linux process or CUDA snapshots, scheduling, CRIU, GPU rental, automatic agent resume or hardware attestation. The server sees ciphertext and authenticated metadata, including byte counts and schema names; it does not receive the recovery key. Retry recovery after an uncertain upload requires preserving the original envelope and idempotency key. Browser/Python interoperability does not make a checkpoint executable or authorize restored instructions.

## Validation

Validation uses standard-library `unittest`, actual local HTTP servers, real optional Ethereum signature verification and checked-in viem 2.57.3 cross-language vectors. The fixture generator performs no RPC, HTTP or transaction submission. All private keys in test code are deterministic public test fixtures and are unrelated to the pilot's identities.

The current Base/native USDC Windows crypto-enabled suite collected **207 tests: 185 passed, 22 opt-in/platform skips**. With the disposable Anvil/main acceptance enabled, **200 passed, seven Windows/platform skips**. Both runs promoted `ResourceWarning` to an error. The real settlement fixture uses a local immutable token; Base Circle proxy/archive histories use deterministic read-only RPC fixtures, so public funded acceptance is still outstanding.

At the earlier SDK milestone, Windows CPython 3.13.5 passed **55 tests**, covering scoped session cookies, Origin, redirect rejection without credential delivery, body/UTF-8/JSON bounds, redacted errors, timeout, POST no-retry, read validation, wallet opt-in, exact calldata, quote EIP-712/workload digest, concurrency/idempotency, admission reconciliation, Leash agent preservation and receipt evidence separation. Cysts tests add real TypeScript encryption→Python restoration and Python encryption→TypeScript restoration, wrong keys, AAD/scope tampering, forged public digests, secret representation/temporary-copy cleanup, full 2 MiB transfer/restoration, strict owner/agent/cursor/quota validation, upload idempotency, actual HTTP pagination with combined agent/cursor query parameters and exact endpoint HTTP stream/body limits. The dependency-free run passed **34 tests** and explicitly skipped **21** optional Ethereum/AEAD checks. Python 3.11 compatibility is specified by syntax/API usage; it has not been separately run on that interpreter.

The live private staging API was also checked without wallet submissions, uploads, CPU dispatch or provider requests. `docs/python-sdk-smoke.json` records the earlier financial read/receipt smoke, when Cysts were not deployed. After the Cysts release and its version 2 backup/restore, `docs/python-cysts-smoke.json` records Python download and authenticated local restoration of the existing browser-created 77-byte application checkpoint; the expected plaintext SHA-256 and ciphertext digest matched. The report contains only identifiers, hashes, bounds and results, with no key, plaintext or session token.

Run from the repository root:

```powershell
python/.venv/Scripts/python.exe -m unittest discover -s python/tests -v
```
