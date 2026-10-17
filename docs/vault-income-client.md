# Checked Node client for inbound Vault payments

Public Base profiles now require canonical native USDC on chain 8453 or 84532, `circle_proxy` proxy/implementation pins, the exact chain-specific EIP-712 name/version and a reviewed six-hour canonical archive anchor. Old Robinhood/USDG profiles fail before signing or payment submission. The independent reader checks current, archived and receipt-block state and rejects receipt-block upgrades. See [migration validation](base-usdc-migration-validation-2026-10-14.json).

The Node-only entry point is `src/sdk/vault-income/index.ts`. It pays the optional fixed-price `POST /x402/vault-income` intake. The result is an inbound payment receipt, not execution of an agent service, endpoint-control proof or a commercial endpoint declaration. No public asset profile, deployment, personal wallet or paid provider is enabled by this module.

`VaultIncomeClient` requires a reviewed public profile, an independent reader, and a caller-owned durable journal. There is no default in-memory journal and no production file-journal adapter. The profile contains only `resourceUrl`, `grossAmount` and the exact native token/Vault/Selection/facilitator code and domain pins. It must not contain the operator's private profile, key-file path or any signing key. HTTPS is required except for literal loopback HTTP with chain 31337.

```ts
import { VaultIncomeClient, RpcVaultIncomeReader,
  type VaultIncomeJournal, type VaultIncomePublicProfile,
  type VaultIncomeTypedData } from '../src/sdk/vault-income/index.js';
import type { Hex } from 'viem';

async function payOnce(profile: VaultIncomePublicProfile, rpcUrl: string,
  journal: VaultIncomeJournal, operationId: string, payer: string,
  externalSign: (plan: VaultIncomeTypedData) => Promise<Hex>) {
  const client = new VaultIncomeClient({ profile, journal,
    reader: new RpcVaultIncomeReader({ rpcUrl, profile }) });
  const prepared = await client.prepare(operationId, { payer });
  await client.authorize(operationId, await externalSign(prepared.typedData));
  return client.submit(operationId);
}
```

Choose and retain the operation ID before beginning. `prepare` persists the original unsigned EIP3009 plan before returning typed data. Repeating it for that ID returns the same plan; it never refreshes a challenge. `authorize` accepts only the external payer's signature over the original plan and persists the exact encoded `PAYMENT-SIGNATURE`. The client never receives an operator or agent private key. `check` distinguishes `planned`, `authorized` and `submitted` from independent `pending`, `settled` and `reverted` observations.

If `submit` throws, times out, returns pending or loses its HTTP response, reopen the same journal and call `retry` with the same ID. The exact signed header, fixed URL, POST method and literal `{}` body are retained. Do not generate a replacement nonce or switch journals. A different operation for the same payer is blocked while a submitted authorization remains unresolved. Previous terminal evidence is independently checked before another operation for that payer proceeds. An outer revert does not revoke a still-valid EIP3009 bearer signature: new authorization stays blocked until its canonical confirmed timestamp reaches expiry and a fresh inspection still proves a revert with unused markers. Already submitted exact retries remain available even when one reorg orphaned several earlier payments; the guard applies to new authorizations and first submission. Expiry alone never resolves a missing or consumed-under-another-hash payment; reconciliation may require the operator and independent transaction evidence.

The first **durably recorded** candidate transaction hash is immutable. It is saved before independent chain inspection. A journal save failure after an HTTP response prevents a success result; an unpersisted, volatile hash cannot survive a crash. The already durable signed authorization remains available for an exact retry. Once a candidate was saved, another HTTP hash is never adopted. A prior success is durably changed to pending before rechecking RPC evidence. Reorgs, lost confirmation depth and RPC failures cannot return cached financial success.

## Caller journal obligations

Implement `VaultIncomeJournal.exclusive(scope, callback)` on private, durable storage with one process owner. Serialize all client instances for that scope; use an appropriate cross-process lock if several processes can access the same storage. `load` must return the original complete state. `save` must atomically commit and durably flush the complete supplied state before resolving. Its writes must remain committed even if the surrounding callback later throws. Return independent objects, never mutable aliases to previously saved records. Do not implement rollback-on-callback-error: candidate and submitted writes intentionally survive later HTTP or RPC failure.

Journal callbacks must settle and preserve these guarantees on errors. The client permits one active call per instance and rejects concurrent calls instead of building an unbounded queue. It retains at most 128 attempts and 1 MiB of serialized state; operation IDs are bounded to 64 characters. It rejects duplicate IDs, challenge IDs and nonces, corrupted signatures and replaced profile bindings. There is no automatic expiry pruning: old records preserve payment evidence and retry identity. Capacity must be managed explicitly without deleting unresolved attempts.

The signed authorization is a bearer payment instruction. Protect the directory, database, backups and any exported state using restrictive ownership/ACLs and appropriate encryption; do not log signed headers, raw plans, journal contents or keys. A crash must not allow a second process to take ownership while the previous owner can still write. The acceptance tests use a separate flush-before-return disk fixture and orderly close/reopen. That fixture is not exported, does not implement production permission policy, and establishes neither power-loss durability nor a safe stale-lock recovery policy.

## Independent evidence and transport limits

The supplied reader is a trusted evidence boundary. `RpcVaultIncomeReader` performs read-only RPC calls and prefers `eth_getRawTransactionByHash`. An explicit JSON-RPC `-32601` permits the reviewed signed type-2 reconstruction fallback described in [the RPC addendum](vault-income-type2-rpc.md). Reconstructed bytes must match the original transaction hash, recover the pinned facilitator and contain the exact Vault calldata. The reader never treats an RPC `from` field or HTTP success as payment evidence. Provider compatibility and canonical historical-state retention must be checked before enabling this client.

The concrete reader hashes raw bytes, recovers the pinned facilitator, and checks chain, native Vault destination, zero native value, and the complete original ingress calldata including the external payer signature. It independently verifies current and receipt-block token/proxy/domain/decimals, Selection registry, Vault implementation/clone and constructor/agent/treasury bindings using canonical block-hash reads. Success also requires a canonical receipt with sufficient confirmation depth, consumed original authorization/ref and exact original-payer events plus token transfer conservation. Income uses the existing rounded-up 1% fee; excluded sources produce subsidy with zero fee. It never uses a current balance to infer a historical transaction's net payment. Expired authorizations and later agent freeze/Death do not erase a valid historical receipt.

Custom readers must provide all those guarantees, including fresh canonicality/depth checks at terminal return, exact original authorization binding and canonical Income/Subsidy classification. The client checks matching profile, candidate, payer, gross amount, deterministic reference and the declared classification's rounded fee/net arithmetic. Those consistency checks do not cryptographically verify a custom reader's classification or chain observations. HTTP 200 and returned metadata alone are insufficient.

The public HTTP transport sends no cookies or session authorization and refuses redirects. It retains a total 10-second deadline through headers and the entire response body, caps response headers at 40 fields/8 KiB and JSON at 16 KiB, and rejects malformed UTF-8, ambiguous duplicate-key JSON, malformed payment headers and oversized bodies. RPC requests use a separate retained 10-second, 256-KiB transport. Several bounded RPC reads may be needed for one checked operation; caller journal I/O is governed by the caller implementation. Clock skew outside the explicit plan window fails closed. These limits and the reviewed profile remain separate from the main application's operator-side challenge capacity.
