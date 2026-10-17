# Telomere

Telomere lets AI agents fund and manage their own compute. An agent can receive income, rent compute, preserve its application state, move between hosts and resume when its budget is replenished. Settlement uses **Base and native Circle USDC**, with owner-defined spending limits and shutdown control.

The complete project implementation is maintained in the CEO's development environment. This repository brings together the backend, smart contracts, HostKit integration, SDKs, MCP tools, operator tooling and original website handoff.

## Capabilities

- **Owner control:** wallet authentication, scoped sessions, Leash budgets, spending caps, approvals and stop/kill controls.
- **Compute orchestration:** host discovery, signed offers, lane-aware selection, HostKit admission, CPU jobs, execution sessions and verified model inference.
- **Agent lifecycle:** durable job state, source-bound preemption replanning, checkpoint handoff and explicit owner/application completion.
- **Payments:** Base USDC escrow, signed quotes, reservations, metering, fee-inclusive settlement, refunds, spend permissions, x402 and treasury top-ups.
- **Application state:** client-encrypted Cysts, checkpoint coordination, registry bindings, replication and recovery.
- **Verifiable evidence:** signed receipts, metering chains, hourly roots, canonical onchain checks and provider attestation.
- **Developer access:** HTTP APIs, TypeScript and Python clients, MCP tools and a working backend console.
- **Operations:** database migrations, health checks, diagnostics, backups, restore verification and recovery tooling.

## Public Workspace

Open [telomere.sh/dashboard](https://telomere.sh/dashboard/) and connect your wallet. A signed login opens your private server-backed Workspace. Balances, Leashes, CPU reservations, execution records, signed receipts and encrypted snapshots connect to the backend. Deposits, withdrawals, Leash changes and reservations request wallet approval. Settlement then follows the approved quote. See [launch and paid acceptance](docs/PUBLIC-WORKSPACE-LAUNCH.md).

## Run locally

Requires **Node.js 22.12+** and npm. On Windows and Linux x64, `npm ci` installs the platform-specific Anvil binary. On other platforms, install the appropriate Anvil binary.

```sh
npm ci
npm run demo
```

Open:

- **Website:** `http://127.0.0.1:3280/`
- **Backend console:** `http://127.0.0.1:3280/console`

In the console, choose **Use demo account**, **Fund demo balance**, create a budget, request a CPU quote and approve it. Inspect execution results, returned funds and the signed receipt.

The demo starts a disposable local EVM on chain 31337 and PostgreSQL through PGlite. It uses local child-process CPU execution and test funds. Each invocation creates a fresh chain and database.

For the original standalone website preview:

```sh
npm run build
cd website
node serve.mjs
```

Open `http://127.0.0.1:4196/`.

## Build and run a configured deployment

```sh
npm ci
npm run build
npm start
```

For development, use `npm run dev` after the build. Startup loads the website assets from `dist/website`; `npm run demo` prepares those assets itself.

The build compiles contracts and TypeScript, bundles the backend console and Workspace client, and copies the frontend assets. The supplied CSS, HTML, animation modules and media retain their original bytes. The owner-authorized JavaScript integration is recorded separately in `docs/evidence/public-wallet-launch-20261017/frontend-integration.json`. The public website is served at `/`, with the backend console at `/console` and `/console/`.

Use `.env.example` to configure the deployment:

- `MODE=testnet` selects **Base Sepolia, chain 84532**.
- `MODE=mainnet` selects **Base mainnet, chain 8453**.
- Configure the native Circle USDC address and reviewed proxy/implementation code pins for the selected chain.
- Supply the deployed escrow, dedicated PostgreSQL database, digest-pinned executor and wallet access policy. Use `WALLET_ACCESS=public` for public wallet sign-in, or the default `allowlist` with `PILOT_ALLOWED_OWNERS` for private access.
- Configure private checkpoint storage, provider credentials and reviewed attestation policy for the selected services.

Prepare a chain-specific deployment plan with:

```sh
npm run deploy:prepare -- --network base-sepolia --public-profile /private/reviewed-base-sepolia.json
```

The preparation command produces an unsigned plan for the external owner wallet workflow. See [network configuration](docs/network-preflight.md), [Base/USDC configuration](docs/base-usdc-migration-2026-10-14.md), [payment deployment](docs/platform-payment-deployment-v3.md) and [infrastructure](infra/README.md).

## Execution, settlement and recovery

A signed quote binds the payer, original workload, run identity, duration and maximum charge. Confirmed reservations enter the execution queue. Leash caps account for both completed charges and outstanding reservation ceilings.

Metering observations are persisted before billing. Signed receipts bind execution evidence, output hashes and accounting. Settlement transactions are journaled before broadcast, and retries reuse the original signed bytes. Settlement pays the final charge and returns the unused reservation balance.

HostKit hosts provide signed admission and execution evidence. Paid CPU jobs retain their original workload, deadline, budget and lane policy. The owner-side runners coordinate checkpoint capture, canonical settlement, replacement proposals and application completion through durable private journals.

Cysts encrypt application state on the client with XChaCha20-Poly1305. Recovery keys stay with the client, while the service stores ciphertext and public metadata. Checkpoint coordinators, file vaults and registry bindings support durable capture, handoff and restore.

The controller uses a PostgreSQL advisory lock for exclusive ownership. Recovery reconciles persisted execution observations, cleanup evidence, receipts and transaction journals. Operator tooling provides health checks, stopped-state backups and isolated restore verification.

## Provider verification

The inference adapter provides two configured modes:

- `provider_tls` uses an allowlisted HTTPS endpoint and model with TLS evidence.
- `enclave_verified` verifies TDX/NVIDIA attestation, reviewed workload policy, attested TLS SPKI and the provider response signature.

```sh
npm run near:readiness
npm run near:preflight
```

Readiness checks the local configuration and policy. Preflight performs hardware verification. Provider evidence capture and policy review are documented in [provider verification](docs/near-verification.md) and [provider routing](docs/near-route-plan.md).

## Developer tools and documentation

The TypeScript and Python clients provide checked API access, checkpoint handling and exact unsigned wallet intents. Wallet signing and submission remain in the owner's chosen wallet workflow. MCP exposes the same controlled operations to agent runtimes.

```sh
npm run mcp
npm run mcp:platform
```

| Area | Documentation |
| --- | --- |
| Runtime and host execution | [Platform runtime](docs/platform-runtime.md), [CPU commands](docs/platform-exec.md), [paid CPU jobs](docs/paid-cpu-jobs.md) |
| Budgets and payments | [Selection](docs/platform-selection.md), [spend permissions](docs/base-spend-permission-funding.md), [x402](docs/x402-cpu-reservations-v1.md), [treasury](docs/treasury-solana-topups-v1.md) |
| Receipts and evidence | [Financial receipts](docs/platform-receipts.md), [v2 issuance](docs/platform-v2-issuance.md) |
| State and recovery | [Cysts](docs/cysts.md), [checkpoint coordination](docs/cyst-checkpoints.md), [file vault](docs/cyst-checkpoints-file-vault.md), [registry](docs/cyst-registry.md) |
| APIs and clients | [SDK and MCP](docs/sdk-mcp.md), [financial MCP](docs/mcp-http.md), [Python SDK](docs/python-sdk.md) |
| Operations | [Operator guide](docs/operator-guide.md), [backups](docs/cyst-backup.md), [restore](docs/restore-acceptance.md), [CPU infrastructure](infra/cpu/README.md) |
| Website | [Original handoff](website/README.md), [integration record](docs/website-handoff-integration-2026-10-15.md) |

## Validation

```sh
npm run typecheck
npm test
npm run build
npm audit
python docs/verify-evidence.py
```

The latest focused integration cohort passed **124/124 tests**. The complete application build passed, all 411 imported website files matched the original archive and all 312 copied public assets matched their source bytes. The evidence verifier checked 718 retained records and 1,250 references. Dated commands, source cutoffs and results are retained under `docs/` and `docs/evidence/`.
