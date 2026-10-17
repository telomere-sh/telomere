# CystRegistry: registered-agent checkpoint publication

`contracts/CystRegistry.sol` publishes the SHA-256 hash, ciphertext length and an opaque storage reference for an agent in one immutable `PlatformSelectionRegistry`. `src/cysts/registry-service.ts` connects that contract to the existing encrypted application checkpoint store. The HTTP service and SDK prepare unsigned transactions; they do not hold an agent signing key or submit a transaction.

## Authority and lifecycle

The bytes32 Selection `agentId`, its EOA `agentWallet`, and its Vault address are different identities. The contract resolves `getAgent(agentId)` on its immutable Selection registry for every mutation. Only that registered `agentWallet` can commit or retire. The human owner, controller and Vault have no substitute authority. The checked RPC reader also verifies `agentWalletAgent(agentWallet) == agentId`.

The existing `/api/cysts` upload namespace remains owner controlled. Its `agent` label alone proves no registration or delegation. Before preparing a commit, the service authorizes the session against Selection, reads and validates the actual stored ciphertext, and requires its metadata owner and agent to equal the registered owner and EOA agent wallet. It then rereads the chain binding before returning a plan. Owner and agent sessions may read latest state or verification; only the agent session may prepare commit/retire plans. In either public Base mode both participating session addresses must be explicitly admitted by `PILOT_ALLOWED_OWNERS`, which is the existing session allowlist despite its historical name.

Alive and Dormant agents can commit. Freeze and a killed compute Leash do not prevent preservation of application state. A Dead agent cannot commit but retains its retirement right. Retirement is logical: it retains the hash, storage reference, original commit timestamp and event history. It does not delete ciphertext, release owner storage quota or erase logs. A later commit can establish another live revision if the agent is not Dead.

## Contract and revision checks

The original specification entrypoints remain available:

```solidity
commit(bytes32 agentId, bytes32 cystHash, uint64 sizeBytes, bytes32 storageRef)
latest(bytes32 agentId) returns (Cyst)
retire(bytes32 agentId)
```

`Cyst` has `cystHash,sizeBytes,storageRef,revision,committedAt,retired` in that order. Unknown agents or agents without a checkpoint return the zero tuple from `latest`; this read is not proof of registration. Both mutations increment the uint64 revision. Zero hashes/references, empty ciphertext and ciphertext larger than 2 GiB are rejected. Repeating retirement without a live checkpoint reverts.

The original mutations are last write wins. Every prepared API/SDK plan instead uses `commitChecked(...,expectedRevision)` or `retireChecked(agentId,expectedRevision)`. The contract rejects a stale revision even if the caller already signed the plan. Refresh and review after another commit or retirement; do not silently retry a signed stale transaction.

`storageRef` is Keccak-256 of the UTF-8 ordered JSON tuple:

```text
["telomere.cyst.locator",1,version,algorithm,id,owner,agent,
 applicationSchema,plaintextBytes,nonce,sha256,ciphertextBytes]
```

Owner/agent addresses use the checkpoint format's lowercase normalization. The reference binds the encrypted checkpoint context; it is not a URL, storage credential or recovery key. The hash committed as `cystHash` is the ciphertext SHA-256 with its `0x` prefix. Selection's separate bootstrap `cystHash` is not automatically updated by this registry.

## Operator configuration

The routes are disabled unless `CYST_REGISTRY_CONFIG` names a reviewed private JSON file and Cysts storage is enabled. The file contains directly:

```typescript
type CystRegistryPins = {
  chainId: number;
  registryAddress: `0x${string}`;
  registryCodeHash: `0x${string}`;
  selectionRegistryAddress: `0x${string}`;
  selectionRegistryCodeHash: `0x${string}`;
  confirmations: number;
};
```

Use actual independently reviewed runtime code hashes, including deployed immutables, rather than a creation-bytecode hash or unchecked API config. The file is at most 8 KiB, regular, single-link and nonsymlink; POSIX permissions must exclude group/other access. Windows deployments require an operator-owned private ACL. Its chain must match `CHAIN_ID`; testnet requires at least one confirmation. The RPC must use HTTPS or loopback HTTP. Startup checks the chain, both code hashes at current and confirmed heights, the immutable Selection link and the contract's 2 GiB bound. Failure aborts startup and releases the database controller lock.

Every read repeats the deployment checks, reads Selection and Cyst state at the same confirmed block, checks the registered signing-key mapping, and rechecks the canonical block hash and confirmation depth. Contract calls and code reads use EIP-1898 `blockHash` with `requireCanonical: true`; a provider without that support fails closed. Number-only state reads could mix temporarily divergent RPC replicas during a reorg. JSON-RPC responses are bounded to 256 KiB with a ten-second request/body timeout and no redirects. Confirmation depth is an operator policy, not a claim of absolute finality.

## HTTP and checked Node SDK

All endpoints use the existing authenticated session, trusted Origin, JSON, no-store and socket-rate policies.

| Method and path | Result |
| --- | --- |
| `GET /api/cyst-registry/config` | Protocol, reviewed deployment pins and exact limits |
| `GET /api/cyst-registry/agents/:agentId/latest` | Confirmed Selection binding and current Cyst state |
| `GET /api/cyst-registry/agents/:agentId/checkpoints/:checkpointId/blob` | Actual ciphertext only for the current published live checkpoint |
| `POST /api/cyst-registry/agents/:agentId/commit-plan` | `{checkpointId}` to an unsigned agent-only CAS transaction |
| `POST /api/cyst-registry/agents/:agentId/retire-plan` | `{expectedRevision}` to an unsigned agent-only CAS transaction |
| `POST /api/cyst-registry/agents/:agentId/verify` | `{checkpointId}` to stored metadata, confirmed state and match result |

Plan POSTs require an `Idempotency-Key` in the existing 8–128-character format. They perform reads and prepare calldata; the key is not a durable transaction replay ledger. A refreshed request may observe a new revision. Bodies have a separate streamed 8 KiB bound and five-second completion deadline. No endpoint accepts plaintext, a recovery key, signing key, transaction destination override or caller-provided replacement digest.

```typescript
import { CystRegistryClient, RpcCystRegistryReader } from '../src/sdk/index.js';

// reviewedPins and rpcUrl come from an independently reviewed deployment.
const reader = new RpcCystRegistryReader({ pins: reviewedPins, rpcUrl });
const registry = new CystRegistryClient({ baseUrl, pins: reviewedPins, reader, sessionToken: agentSession });
const plan = await registry.commitPlan(agentId, originalUploadedMetadata, crypto.randomUUID());
// A caller separately reviews/signs plan.transaction with the registered agent.
const result = await registry.verify(agentId, originalUploadedMetadata);
const plaintext = await registry.restore(agentId, originalUploadedMetadata, separatelyHeldRecoveryKey);
```

The mandatory independent reader establishes chain authority separately from the API origin. Each SDK action rereads config, the authenticated principal and independent current state; mutation/verification/download responses are checked again after the API call. Commit/verify/download require the original complete ready checkpoint metadata, not a server-selected substitute. The SDK compares all substantive state/binding fields and exact locally encoded checked calldata, destination, sender, chain and zero value. Legitimate API and independent reads can have different block heights while state is unchanged; the returned block is always the independent reader's block. An API boolean or echoed block is never used as chain proof. The client is browser-bundle compatible and performs no signing or broadcasting.

The delegated blob route serves the owner or registered agent only when the current confirmed live hash, length and opaque reference match the requested stored checkpoint. Unpublished labels, replaced checkpoints and retired revisions are denied through this route. The owner's original `/api/cysts` history remains available under its original ownership policy. The SDK verifies exact original metadata, canonical base64, byte count and SHA-256 before returning an envelope; `restore` additionally authenticates/decrypts AEAD locally. The recovery key is never sent to the service. This permits application-byte recovery and does not start a process or admit a replacement host.

The Python `CystRegistryClient` follows the same checked metadata, role, revision and calldata rules. It requires a separately supplied trusted `CystRegistryReader` protocol implementation and crypto verifier; this package does not include a Python RPC reader. Its HTTP transport bounds the whole response-body read, including trickled chunk headers, with a socket-shutdown deadline. DNS resolution and response-header parsing do not have a hard whole-operation deadline. Both SDK transports cancel rejected oversized bodies; a cancellation failure cannot replace the original size-limit error.

## Acceptance scope and remaining work

Contract acceptance uses real local Platform Selection, Vaults, escrow and lifecycle contracts. Runtime acceptance uses real `startPilot`, signed challenge/session authentication, filesystem ciphertext, persistent PGlite and disposable Anvil. Tests sign only with generated local identities; no personal wallet, public-chain transaction or paid provider call is needed.

The contract can describe up to 2 GiB, but the current encrypted application upload/download remains **2 MiB plaintext plus 16 bytes ciphertext authentication tag**. Registry publication does not prove the plaintext is safe, verify AEAD without the client key, make an unprovisioned storage replica durable, or supply a process/GPU snapshot. Client recovery keys and wrapped recipient-key bundles remain client responsibilities. Large/multipart snapshots, storage charging/garbage collection, host resume permits, attested key release, migration and a reviewed funded public deployment remain separate work.
