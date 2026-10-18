# CPU release profile and trust boundaries

## Read the deployment you are using

`GET /api/config` describes the selected service. Source availability, a successful local build, a hosted CI run and an installed release are separate facts. Match the exact commit and manifest before accepting an update.

| Area | Base CPU service |
| --- | --- |
| Settlement | Base, chain 8453, native USDC with 6 decimals |
| Escrow | `0x27c1e35F563Aa4f57a68B192d88a76c25e68e0db` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Tasks | `sha256`, `hash_chain`, `sort`, `primes` |
| Duration | At most 120 seconds per approved reservation |
| Execution | One worker, operator-reviewed Linux executor image/container policy |
| Admission | Up to 8 outstanding runs per owner, 64 globally and 500 quote creations per owner/day |
| Receipts | Operator-signed usage, checked against canonical escrow settlement |
| ReceiptRoot | Read `platform.receiptRootAddress`; a configured address alone is not proof of actual hourly publication |
| Checkpoint | Client-encrypted application state; separate client recovery key |
| Session | Wallet-bound challenge and owner-scoped, server-backed Workspace |

The read-only audit of 18 October 2026 matched escrow bytecode and all immutable parameters to the reviewed Solidity build. Roles were read together at finalized block 52777710. These observations do not replace fresh checks when deploying a different release.

## What a receipt proves

The quote binds the original payer, workload hash, price, duration and ceiling. Settlement verifies the receipt authority, replay guards, run terms, timing and accepted ceiling. It does not execute the workload on-chain or prove that the operator computed a correct output.

The existing escrow has immutable authorities and no upgrade or signer-rotation function. Quote and receipt signing currently resolve to `0x87599dBF6f720DE7751E8CB2d36d4Ea96A4A1d38`. Protecting or losing that authority affects settlement and availability. It cannot arbitrarily withdraw an owner's unreserved available balance, but a compromised authority can attest false usage within an already approved ceiling.

Changing the authority model requires a separately reviewed contract/interface design and migration. A conventional multisig address is not a drop-in replacement for this contract's `ECDSA.recover` check. Existing addresses, old signatures, reserved balances and historical receipts must remain reconcilable.

## Returning money

Settlement returns an unused ceiling to `availableBalance` **inside escrow**. An expired unsettled run becomes eligible for full release after `openedAt + maxSeconds + 6 hours`; a transaction must call `refundRun`. Time passing alone sends no transaction. An owner-approved `withdraw` separately transfers available USDC to the wallet.

## Plaintext and isolation

The gateway and compute operator can read CPU task input and output. gVisor/container isolation constrains the workload; it does not make the gateway a confidential enclave. A provider's remote attestation describes that provider's measured environment and does not attest another host.

Cyst encryption happens in the client. The backend stores ciphertext and public metadata. It does not receive the client recovery key. Restoring application bytes differs from restoring all process memory or a GPU process.

## Source and operational rollout

The candidate source contains the 1 GiB ciphertext budget, 49,000 global checkpoint admission ceiling, 50,000-file archive envelope and complete gVisor recovery packaging. The audit observed the existing server release and older installed backup producer separately. Updating this source does not update the running application, scheduled producer or private hosted verifier.

Promotion requires the reviewed app/operator/cloud hashes to match, a fresh authenticated data/runtime backup pair and an isolated restore using only that pair. Python operator entry points reject `-O`, `-OO` and `PYTHONOPTIMIZE` before integrity checks can be disabled. Retain historical backups and never replace a live financial database merely to roll back application code.

## Broader protocol profiles

The repository also contains HostKit discovery/admission, Platform receipts and roots, provider verification, scheduling, agent lifecycle, income and storage modules. Their configuration and acceptance records determine which profile exposes them. The public CPU acceptance scope does not require arbitrary GPU Cells. A module's presence in source is distinct from its activation at a particular URL.
