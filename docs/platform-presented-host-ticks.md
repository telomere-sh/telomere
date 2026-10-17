# Presented HostKit tick verification

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`operator:platform-meter` is a read-only standalone CLI for a **completed** paid Platform run. Its `export` mode reads a bounded original `platform_host_leases` record from PostgreSQL in a `REPEATABLE READ READ ONLY` transaction. It prints only the signed HostKit ticks, run ID and settlement transaction hash. The original signed lease, argv, stdin, task, output and controller acknowledgments stay private. The export is at most 100 ticks and 96 KiB. A failed or unconfirmed chain check produces no bundle.

`verify` mode needs no controller database or signing key. It checks a successful canonical `settleRun`/`settleBatch` transaction with the requested run exactly once, its `RunSettled` event and historical settled escrow state. At that transaction block, it checks the reviewed Platform contract code, USDC proxy/implementation/facet pins where applicable, and `HostRegistry.getHost(run.hostId).hostKey`. It then verifies the Ed25519 signature, run ID, payer, host key, common opaque lease-body hash, sequence, previous-tick hash and monotonic counters of **every presented tick**. It rechecks canonical block hash and confirmation depth before returning success. Missing historical RPC state fails closed.

The verifier reports `verification: "presented-host-signatures-only"`, `presentedTickSignaturesVerified: true`, `completeTickHistoryVerified: false`, `billableSecondsVerifiedFromTicks: false`, `outputVerified: false` and `onchainTickCommitment: false`. It does **not** prove that these are all the original HostKit ticks, that the controller accepted the ticks, that the billed duration is supported, or that the work/output is correct. A valid host key can sign a selective or fabricated-looking subset; the verifier does not claim otherwise. The current v1 onchain financial leaf contains `receiptHash`, while that hash's preimage contains ordinary result ticks and the signed lease hash, **not** the full signed HostKit tick/ACK array. Recomputing the v1 receipt hash publicly would also disclose raw result output.

When the Platform runtime is configured, the backend also mounts a read-only `POST /api/platform/public/presented-meter/verify` route for the same bundle. It uses the server's reviewed pins, archive RPC and 12-confirmation default, accepts at most 96 KiB, applies the public route rate limit and returns the same explicitly limited verification result. It stores no submitted bundle and has no signer operation. The shared API middleware requires `Content-Type: application/json` and the configured `Origin` header for POST requests. A caller can submit the exported `meter-bundle.json` body; no owner cookie is needed. This is a hosted verifier for **presented tick signatures only**, not the original complete public receipt verifier or a dashboard.

Use a pins-only JSON object copied from the reviewed Platform runtime profile. Do not put the quote signer private key in that file. On the controller host, set `DATABASE_URL` in the process environment, then export to a file:

```powershell
npm run operator:platform-meter -- --mode export --pins .\platform-pins.json --rpc-url https://archive.example --run-id 0xRUN_ID --transaction-hash 0xSETTLEMENT_HASH > meter-bundle.json
```

Anyone with the resulting bundle and the reviewed pins can rerun the read-only chain/signature check:

```powershell
npm run operator:platform-meter -- --mode verify --pins .\platform-pins.json --rpc-url https://archive.example --bundle .\meter-bundle.json
```

The hexadecimal placeholders above must be replaced with full 32-byte values. A 12-confirmation minimum is the default; `--confirmations 1` is intended only for a disposable local Anvil acceptance. The archive RPC must retain hash-addressed historical contract state. Neither mode signs or submits a transaction.

To close the original public verifier gate, a future receipt protocol must commit a Merkle root of the signed ticks **and** accepted acknowledgments, provide a privacy-preserving output commitment, and publish independently retrievable immutable evidence. A versioned v2 receipt preimage can use the existing `bytes32 receiptHash` field without an escrow ABI change, but v1 receipts do not gain that commitment retroactively. Funded Base acceptance remains separate work.

Local acceptance: `tests/platform-presented-meter.test.ts` uses real disposable Anvil contracts, a HostRegistry registration with an actual Ed25519 HostKit identity, a real paid settlement and signed control-plane meter ticks. It rejects foreign signatures, changed owner or predecessor hash, duplicate ticks, a non-settlement transaction, changed historical registry pin and a reorg. This is local evidence only; no public wallet or provider was used.
