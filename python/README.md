# Telomere Python SDK

Python 3.11+ clients for the bounded CPU pilot and full financial CPU platform. The core has no runtime dependencies. It reads API state and prepares validated, unsigned intents for an external wallet. It never holds signing keys, signs or broadcasts EVM transactions, invokes the demo transaction endpoint, or enables provider inference. The optional native Vault-income client sends an explicitly supplied external EIP-3009 authorization through the reviewed facilitator after caller authorization.

Supported deployment scopes are local demo `31337`, Base Sepolia testnet `84532` with Circle native USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, and Base mainnet `8453` with Circle native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. The SDK rejects former Robinhood `46630`/`4663` and USDG payment profiles before preparing a signature or wallet plan. Public Base use requires independently reviewed deployment hashes and proxy implementation pins. Native Vault-income additionally requires an independent canonical evidence reader and a reviewed historical archive anchor.

From the repository root:

```powershell
python -m pip install -e ./python
python -m unittest discover -s python/tests -v
```

To use the explicit cryptographic verification adapter and run all signature tests:

```powershell
python -m venv python/.venv
python/.venv/Scripts/python.exe -m pip install -r python/requirements-crypto.txt
python/.venv/Scripts/python.exe -m pip install -e ./python
python/.venv/Scripts/python.exe -m unittest discover -s python/tests -v
```

The `crypto` extra also installs the reviewed `eth-account==0.13.7` adapter: `python -m pip install -e "./python[crypto]"`. The requirements file records the exact dependency versions used in validation; it is not a wheel hash lock or a claim of cross-platform validation.

See [usage and trust boundaries](../docs/python-sdk.md). The checked-in viem fixtures contain only deterministic public test identities, with no funds or relationship to operator identities. Regenerating them needs the existing Node build: `node python/tests/generate-vectors.mjs`.

## Native Vault-income payments

`VaultIncomeClient` supports the exact EIP-3009 inbound Vault protocol with a mandatory independent reader and a caller-owned durable journal. `RpcVaultIncomeReader` verifies the original signed transaction, pinned native deployments, canonical historical receipt, original-payer classification and transfer conservation through read-only RPC. `FileVaultIncomeJournal` provides explicit private filesystem storage with atomic replacement, flushed writes and one process owner on Windows/POSIX. The client preserves the original signed payment across uncertain replies and process reopen, rejects candidate substitutions, and rechecks canonical evidence on every terminal result. HTTP success alone remains pending. See [native payer usage, operating constraints and direct Python/Anvil acceptance](../docs/python-vault-income.md).

## Full financial CPU platform and Vaults

`PlatformRuntimeClient` uses `/api/platform` for EOA payers. `PlatformVaultRuntimeClient` uses `/api/platform/vaults/{vault}` for a reviewed Selection Vault. These are separate from the original `TelomereClient` pilot API. Both validate every reviewed platform contract/address/code pin, strict response fields, CPU host scope, task digest, EIP-712 operator signature, complete rounded 9% fee ceiling, deadline and byte-exact unsigned wallet calldata. The Vault client additionally checks its factory/implementation pins, binding and current session role. Both image and region proof arrays are included in the independent Python ABI encoding; the chain enforces their allowlist roots.

```python
from telomere_sdk import (
    ApiTransport, EthAccountVerifier, TelomereClient,
    PlatformRuntimeClient, PlatformVaultRuntimeClient,
)

origin = "https://your-controller.example"
transport = ApiTransport(origin)
verifier = EthAccountVerifier()

# Reuse the existing sign-in flow and the same in-memory, scoped cookie transport.
# agent_wallet, reviewed_* pins/binding and sign_message come from your application.
# Public Base pilot pins include the USDC proxy code hash and implementation address/code hash.
login = TelomereClient(origin, pins=reviewed_pilot_pins, verifier=verifier, transport=transport)
login.authenticate(agent_wallet, chain_id=84532, sign_message=sign_message)

sdk = PlatformVaultRuntimeClient(
    origin, pins=reviewed_platform_pins, vault_pins=reviewed_vault_pins,
    vault=reviewed_binding["vault"], binding=reviewed_binding,
    verifier=verifier, transport=transport,
)
prepared = sdk.quote({
    "leashId": reviewed_binding["leashId"],
    "task": {"kind": "sha256", "text": "hello"},
    "maxSeconds": 3, "deadline": unix_deadline, "maxSpend": "331",
    "regions": ["approved-region"],
}, idempotency_key="agent-request-0001")
unsigned_transaction = sdk.open_plan(prepared)
# Your external wallet explicitly reviews, signs and sends unsigned_transaction.
# Only after confirmation:
run = sdk.admit({"runId": prepared["quote"]["runId"],
                 "transactionHash": confirmed_transaction_hash},
                idempotency_key="agent-admission-0001")
```

The EOA variant takes `origin`, `pins`, `verifier` and the same authenticated `transport`, without Vault options. Both expose `config()`, `balance()`, `quote()`, `open_plan()`, `admit()`, `list()`, `get()`, `command()`, `session_events()`, `stop_plan()` and `refund_plan()`. They return defensive copies of the corresponding JSON values. No client signs or broadcasts a wallet transaction. `quote`, `open_plan`, `admit`, `stop_plan` and `refund_plan` fail closed without an explicitly supplied Ethereum `CryptoVerifier`. Metadata, balance, validated run reads and already-admitted session commands/events work without the optional crypto extra. Vault quote/admit and paid session commands require the agent session; stop requires the human owner; reads, events and refund plans permit either. Sign in again through the shared transport to change roles; cached quotes recheck the current principal and expiry.

Paid CPU sessions require `task={"kind":"session","imageDigest":"sha256:...","maxCommands":4}` and a host whose fresh platform config explicitly sets `sessionEnabled: true` for that image. The quoted task and 9% ceiling are checked against the operator signature and unsigned wallet calldata before use. After wallet admission, `command(run_id, {"commandId":"write","argv":["/usr/local/bin/node","-e","..."]})` sends the exact command ID as its HTTP idempotency key; retry with the same ID and body after a transport failure. `session_events(run_id, after_sequence=-1, limit=8)` validates bounded, contiguous event pages. The client does not create a lease or authorize spending by itself.

When the reviewed config explicitly exposes `near` and `nearInferenceTask: "near_inference"`, a standalone managed model request uses `task={"kind":"near_inference"}` and `near={"model": reviewed_model, "maxTokens": reviewed_limit, "policySha256": reviewed_policy_hash, "prompt": bounded_prompt}` in the same paid quote flow. The Python client checks the exact policy, model, prompt-bound workload hash, fixed inference price, full fee ceiling, operator signature and unsigned wallet transaction. This task does not execute a CPU command or arbitrary GPU code. The current escrow reserves the CPU host's maximum price ceiling as well and returns unused CPU funds after zero-second settlement. A provider outcome with uncertain delivery is never automatically resent by the backend. Live NEAR admission and funded Base USDC acceptance remain separate gates.

The platform clients retain the existing transport's 30-second maximum HTTP timeout for ordinary requests, exact origin, strict JSON, scoped cookie and redirect protections. A paid session command uses a 130-second request deadline because its admitted runtime may last 120 seconds; only that exact HTTP endpoint permits the override. Custom injected transports must provide an equivalent command deadline. The clients additionally enforce 32 KiB request bodies, 1 MiB responses, 1..16 configured CPU hosts, at most 64 proof siblings, 128 returned runs and 128 distinct attempted quote keys per client. Wallet-plan idempotency keys use the existing Python transport subset of 8..128 ASCII letters, digits, underscores or hyphens. The exact paid session command endpoint permits 1..64 character command IDs and requires the matching request body. A failed or lost quote response retains the key's original input, so it can be retried safely; use a new client after exhausting the bounded history while retaining outstanding reservation records.

The financial clients additionally support one-shot CPU commands inside an operator-reviewed image. Select its exact `sha256:` digest from a host advertising `execEnabled: true`, then use this task in the existing quote flow:

```python
task = {
    "kind": "exec", "imageDigest": reviewed_exec_image_digest,
    "argv": ["/usr/local/bin/node", "-e", "process.stdout.write('hello')"],
    "stdin": "optional UTF-8 input",
}
```

Both the checked quote and a later `open_plan` require the selected host's explicit capability and exact requested image digest. Removing capability after quoting rejects a cached wallet plan. `argv` has 1..32 nonempty strings, each at most 4096 JavaScript UTF-16 code units, at most 8192 UTF-8 bytes altogether, and no NUL. HostKit's exact case-sensitive POSIX entrypoint policy rejects `sh`, `bash`, `dash`, `zsh`, `ksh`, `fish` and `busybox`, including path-prefixed forms. Optional `stdin` is at most 8192 UTF-16 code units and 8192 UTF-8 bytes, with no NUL. Invalid Unicode and extra task fields fail closed. Execution remains at most 120 seconds; this task does not introduce persistent cells, interactive streams or GPU execution. The original `TelomereClient` pilot keeps its existing task boundary and does not accept `exec`.

Regenerate the offline platform vectors after the existing Node build with `node python/tests/generate-platform-vectors.mjs`. They include real viem signatures and calldata for EOA `openRun`, Vault `payRun`, empty proofs, distinct nonempty image/region proofs, Unicode command input and both wallet action plans. The Python crypto suite checks the EIP-712 digest/signature and independently compares its ABI encoder against both those vectors and `eth_abi`.

## Checked CystRegistry and registered-agent restore

`CystRegistryClient` binds the real Selection `bytes32` agent identity to its current owner, agent wallet and Vault. The checkpoint's `agent` address is the agent wallet; the Vault address and local owner-labelled agent entries do not authorize registry writes. `commit_plan()` and `retire_plan()` require the current agent session and prepare exact unsigned `commitChecked`/`retireChecked` calldata with an explicit compare-and-swap revision. They never sign or broadcast. Frozen/dormant agents can preserve state; dead agents cannot commit a new checkpoint, but can retire an existing one.

```python
from telomere_sdk import CystRegistryClient, EthAccountVerifier, PyCryptodomeCipher

registry = CystRegistryClient(
    origin, pins=reviewed_registry_pins, reader=independent_registry_reader,
    verifier=EthAccountVerifier(), transport=transport,
)
# Preserve the complete original ready upload metadata in your application.
prepared = registry.commit_plan(
    selection_agent_id, original_checkpoint, idempotency_key="checkpoint-commit-0001",
)
unsigned_transaction = prepared["transaction"]
# An external wallet explicitly reviews and submits the unsigned transaction.
# After its confirmed publication, either the owner or the registered agent can:
envelope = registry.download(selection_agent_id, original_checkpoint)
plaintext = registry.restore(
    selection_agent_id, original_checkpoint, recovery_key, cipher=PyCryptodomeCipher(),
)
```

The reader is a mandatory, independently supplied trusted boundary. Its `pins` must exactly match the reviewed chain ID, registry and Selection addresses/code hashes, and confirmation policy (`0..10000`; zero is only appropriate for reviewed local fixtures). `check()` verifies those deployments and the immutable registry-to-Selection relationship, raises on failure and returns `None`. `snapshot(agent_id)` returns the strict `{binding,current}` structure from the TypeScript registry types: binding contains `agentId`, `owner`, `agentWallet`, `vault`, `status`, `frozen`; current contains `agentId`, `cystHash`, decimal-string `sizeBytes`, `storageRef`, `revision`, `committedAt`, boolean `retired`, and `block` with decimal-string `number` and bytes32 `hash`. All fields must be independently read at one confirmed canonical block, with its hash rechecked; unavailable or reorganized evidence must raise. An adapter that echoes controller API responses does not satisfy this boundary. The package does not bundle a Python RPC reader.

`config()` and `latest(agent_id)` work with the dependency-free core. Plans, `verify(agent_id, original_checkpoint)`, and `download()` require an explicitly supplied Ethereum `CryptoVerifier` for the full-header storage reference. Each operation rechecks configuration, session and independent state without caching. API and independent block heights may differ only when every substantive binding/state field agrees; the returned block comes from the independent reader. A changed revision, wallet, owner, retirement state, original metadata, or unsigned calldata fails closed. `retire_plan(agent_id, expected_revision, idempotency_key=...)` requires the exact canonical decimal revision of a live entry.

Registered-agent download permits only the current published live checkpoint with the original full metadata. It checks canonical base64, SHA-256 and ciphertext length before returning an encrypted envelope; `restore()` additionally authenticates XChaCha20-Poly1305 locally through an explicit cipher. Recovery keys and plaintext never enter API requests. The pilot remains bounded to 2 MiB application plaintext plus a 16-byte authentication tag, with at most 2,800,320 response bytes on the exact blob GET path; other registry responses remain at 1 MiB and requests at 32 KiB. This does not introduce a 2 GiB storage service, filesystem/container snapshots, key delivery, replication, or migration.

`python/tests/test_cyst_registry.py` contains independently generated viem selectors/calldata, real TypeScript ciphertext and actual authenticated HTTP checks, including maximum-size download, metadata/ciphertext substitution, stale revisions, role changes and retired/unpublished entries. Restore tests need the optional reviewed checkpoint cipher; crypto-dependent cases skip when their explicit adapter is absent.
