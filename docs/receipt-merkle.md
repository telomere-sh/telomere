# Hourly receipt commitments

`src/receipts` adds persistent Merkle commitments to the existing signed settlement receipts. It is an operator publication layer over the existing escrow settlement; it does not replace `settleRun`, move customer balances, batch financial transactions, or prove the truth of the metered computation.

The reviewed deployment pins are supplied directly to `HourReceiptService`: chain ID, escrow address, payment token, and receipt signer. A root contract address is additionally required for preparing publication calls and verifying an onchain root. These pins must come from the reviewed deployment, independently of an API response.

## Persistence and publication

Exported `receiptHourMigrationSQL` creates three tables: a singleton row lock, immutable hour metadata, and one receipt snapshot per run. It can run inside the controller's migration transaction. `service.initialize()` also runs this fixed idempotent DDL after the ordinary jobs migration.

`service.seal(hour)` accepts only a closed Unix UTC hour. A PostgreSQL row lock serializes concurrent calls, including separate service instances. A new hour must be later than all existing sealed hours; replaying an existing hour returns its original root. The entire batch and its receipt snapshots commit atomically. Restarting the database or changing a source job afterwards leaves the signed snapshot and proof unchanged.

Eligible jobs have a final status (`completed`, `failed`, `cancelled`, or `timed_out`), a signed receipt, a persisted settlement transaction hash, and a final update strictly before the hour's cutoff. Refunded jobs and unresolved settlement/reconciliation jobs are excluded. Before insertion, the service checks the signed receipt's hash, EIP-712 domain, reviewed signer, token, billable seconds, quoted CPU/inference prices, run identity, owner, ceiling, charged amount, and refund conservation against the durable job.

This eligibility check is based on the controller's durable settlement state. Sealing does not make new RPC requests to independently recheck every escrow event. Existing worker settlement recovery establishes the durable state. Root inclusion is a publisher commitment to that receipt, not a second escrow settlement proof.

Publication hours describe when a finalized receipt becomes eligible for a commitment. A receipt finalized after an earlier hour was sealed enters a later publication hour. An earlier root is never rewritten. A batch contains at most 256 leaves by default, configurable up to 4,096, at most 16 MiB of signed receipt JSON, and at most 192 KiB per signed receipt. Overflow remains unassigned for the next sealed publication hour. Invalid durable receipts fail the seal transaction instead of being silently published or discarded.

An empty sealed hour has zero leaves and a zero root. It remains immutable in the database and produces no publication call. Nonempty batches produce an unsigned `postRoot(uint64 hour, bytes32 root, uint32 count)` call through `preparePublication(hour)`. This service contains no private keys, transaction signer, broadcaster, public deployment, or paid-provider call. The operator integrates publication with its existing reviewed transaction flow. ReceiptRoot's current weekly signer must publish; the contract rejects open hours and a second root for an existing hour.

## Tree encoding

The versioned algorithm is `double-keccak-receipt-v1`:

```text
receiptHash = keccak256(canonical JSON receipt.body)
leaf = keccak256(keccak256(abi.encode(bytes32(receiptHash))))
parent = keccak256(concat(min(left, right), max(left, right)))
```

Leaves follow durable selection order (`jobs.updated_at`, then run ID). Pair hashing sorts its two bytes32 inputs lexicographically. A lone final node at any level is promoted unchanged. The resulting proofs work with OpenZeppelin's sorted-pair `MerkleProof` and the non-upgradeable `ReceiptRoot.verify` contract. This is a defined tree construction; callers should use `receiptTree`, rather than assume another library's default leaf ordering or shape. Double hashing separates leaf data from internal-node encodings. Duplicate leaves and trees above the limit are rejected.

## Owner-scoped API and verification

Mount `createReceiptRoutes(service, authenticateOwner, optionalTrustedRootReader)` under the application's existing bounded JSON, session authentication, Origin, rate, and security-header middleware. Suggested prefix: `/api/receipt-hours`.

| Route | Result |
| --- | --- |
| `GET /` | At most 100 of the authenticated owner's run/hash/hour summaries; optional bytes32 `cursor` |
| `GET /:runId/proof` | That owner's immutable signed receipt, root, leaf count, and sibling hashes |
| `POST /verify` | Independent local verification; optionally a read-only chain root check |

Every route authenticates. Foreign and nonexistent run IDs return the same 404. Clients cannot override the owner in a query or body. A proof contains that owner's receipt and anonymous sibling hashes, never another owner's receipt, address, or run ID. Root and global leaf count are commitment metadata that is public after publication. Database proof retrieval recomputes the tree and checks the frozen receipt before responding.

`verifySignedReceipt` checks the full signed receipt against explicit reviewed pins. `verifyHourlyReceipt` also checks the leaf and sorted-pair proof. Without an explicitly supplied trusted RPC reader and pinned ReceiptRoot address, the result always has `onchain_verified: false` and `evidence: local_only`.

`createReceiptRootReader(rpcUrl)` permits HTTPS and explicit loopback HTTP, rejects embedded credentials, disables retries, and only reads `eth_chainId` and `ReceiptRoot.getRoot`. A matching chain ID, exact root, exact leaf count, and nonzero posting timestamp are required for `evidence: chain_root_verified`. An absent/mismatched root returns `chain_root_mismatch`; RPC errors return `chain_unavailable`. API `anchored`/`onchain_verified` fields are not accepted as evidence. Successful root verification proves inclusion in the actual pinned root contract; it does not independently prove workload execution or a canonical `RunSettled` event.

An independent verifier also runs without the application server:

```powershell
npx tsx scripts/receipt-proof.ts --proof receipt-proof.json --pins reviewed-pins.json
npx tsx scripts/receipt-proof.ts --proof receipt-proof.json --pins reviewed-pins.json --rpc http://127.0.0.1:8547
```

The pins file contains only `chainId`, `escrowAddress`, `tokenAddress`, `receiptSigner`, and optionally `receiptRootAddress`. The command reads bounded regular files, prints verification booleans and the evidence label without receipt contents, and exits unsuccessfully for invalid local verification or an explicitly requested RPC check that cannot establish an anchor. It never accepts a signing key or broadcasts a transaction.

## Verification evidence

`tests/receipt-merkle.test.ts` exercises real PGlite transactions and a real persistent database restart, replay, late finalization, bounded overflow, owner privacy, route authentication, mismatched durable accounting, altered hash/signature/domain/token/conservation, corrupt stored leaves, odd/even trees, count/proof tampering, and fail-closed root-reader behavior.

The same test suite compiles the actual `ReceiptRoot.sol` and `SignerSet`, deploys them with generated test identities on a disposable loopback Anvil chain, publishes the service's stored five-leaf tree through its unsigned call, reads the actual root over RPC, and verifies all owned proofs using the contract's OpenZeppelin verifier. It uses no public chain, existing wallet, or paid request.

The controller must integrate schema registration/migration, authenticated route mounting, an hourly seal scheduler, operator publication of prepared calls, and monitoring of publication failures. Full batch settlement, publisher decentralization, host-signed compute metering, and CRIU/CUDA checkpoints remain separate requirements.
