# Owner wallet SDK and local MCP

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

The SDK prepares exact wallet actions against this pilot's escrow and token. Signing belongs to the owner's wallet. The MCP server returns pending actions and never signs, broadcasts, funds the account or uses a private key.

## TypeScript client

Import `TelomereClient` and `OwnerWallet` from `src/sdk/index.ts`. A browser adapter implements `getChainId`, `signMessage`, `sendTransaction` and `waitForTransaction` using the connected wallet. The SDK has no owner-key field or key storage.

```ts
import { TelomereClient, type OwnerWallet } from './src/sdk/index.js';

// Obtain these public values from the reviewed deployment, independently of the API.
const client = new TelomereClient({
  baseUrl: deployment.origin,
  pins: {
    chainId: deployment.chainId, // 31337 local, 8453 Base mainnet, or 84532 Base Sepolia
    escrowAddress: deployment.escrowAddress,
    tokenAddress: deployment.tokenAddress,
    receiptSigner: deployment.receiptSigner,
    tokenCodeHash: deployment.tokenCodeHash, // mandatory on either public Base chain
    assetImplementation: deployment.assetImplementation, // { address, codeHash }
  },
});
const wallet: OwnerWallet = connectedOwnerWalletAdapter;
await client.authenticate(wallet);

// Amounts are integer base units: 1_000_000 = one token, six decimals.
const funding = await client.prepareDeposit('1000000');
await client.executePlan(funding, wallet, async intent => {
  // Display summary, chain, target and calldata in your application's review UI.
  return await showOwnerConfirmation(intent);
});

const quote = await client.quote({
  leashId: confirmedLeashId,
  task: { kind: 'hash_chain', text: 'hello', iterations: 100000 },
  maxSeconds: 10,
}, { idempotencyKey: originalRequestId });
const opened = await client.executePlan(quote.walletAction, wallet, showOwnerConfirmation);
await client.admit(quote.quote.runId, opened.confirmed[0]!.txHash);
const status = await client.run(quote.quote.runId);
const receipt = await client.receipt(quote.quote.runId);
```

`authenticate` validates the exact domain, owner address, chain, nonce, session-only wording and five-minute validity before calling the wallet's message signer. Browser requests use the API origin and its HttpOnly cookie. Node clients can receive an already authorized `sessionToken` through private host configuration. There is no bearer-auth bypass.

`prepareLeash`, `prepareUpdateLeash`, `prepareWithdraw`, `prepareStop`, `prepareKill` and `prepareRefund` return the same wallet-plan format. Planning alone does not execute them. A budget update preserves the current agent and all spending/reservations, rejects caps below committed usage, and can renew an expired leash. Killed leashes cannot be renewed. The client checks the agent again immediately before wallet submission; the existing contract ABI does not offer an atomic compare-and-swap against concurrent owner edits. Creating a leash records a pending reference in the API; its budget becomes effective after the owner confirms the transaction. Quotes record a pending job but do not reserve funds. Admission accepts the original confirmed `openRun` transaction and starts work already reserved by the owner.

Before returning a plan, the client independently encodes and compares its full calldata and target. A deposit uses an exact approval amount. Quotes additionally check the operator's EIP-712 signature, chain/escrow domain, payer, leash, duration, published prices, expiry and ceiling. The SDK independently hashes the normalized request, published token limit and model metadata, and rejects a signed quote for a different workload. API v0.1 requires `workload.nearModel` in configuration, including `null` when no model is configured. In this pilot quote and receipt signers are the same operator.

Actual SDK wallet sends require deployment pins. Pins must come from the reviewed deployment rather than copying unreviewed values from `/api/config`. Each send requires the supplied confirmation callback and a fresh chain check. Only unchanged plans issued by that client can execute.

## Retry and uncertain outcome handling

Retain one idempotency key per intended run. Repeated equivalent `quote` calls on the same client return the original quote and plan; changing a request under the same key fails. API idempotency survives process restarts. Expired quotes must not be sent.

`executePlan` caches its result for that plan. An RPC timeout or ambiguous wallet result raises `WalletActionUncertainError` with the original hash when available and any already confirmed actions. Repeating that plan does not send another transaction. Reconcile the original transaction through the wallet/explorer before creating a replacement action. For a two-step deposit, approval may already be confirmed even if the deposit outcome is uncertain.

The SDK's execution cache lives in memory. The calling application must persist original request IDs and wallet transaction hashes across reloads. Never retry an uncertain payment by inventing a new request ID. Use a separate client per owner session.

Stopping preserves payment for accepted work. Killing a budget permanently prevents new reservations. A full timeout refund is available only after the run's maximum duration plus six hours. Receipt results distinguish pending receipts from verified signature, anchor and accounting evidence.

## Local stdio MCP

The server uses the official `@modelcontextprotocol/sdk` 1.32.1 maintenance line, compatible with this project's Zod 3 schemas. Start it with:

```sh
node --import tsx scripts/mcp.ts
```

Set `TELOMERE_API_URL` to the exact public origin. Its default is `http://127.0.0.1:3280`; HTTP is accepted only for loopback. Remote deployments require HTTPS. Stdout contains only MCP protocol messages.

Example MCP host configuration, with the project path adjusted for the host:

```json
{
  "mcpServers": {
    "telomere": {
      "command": "node",
      "args": ["--import", "tsx", "C:/path/to/telomere/scripts/mcp.ts"],
      "cwd": "C:/path/to/telomere",
      "env": {
        "TELOMERE_API_URL": "http://127.0.0.1:3280"
      }
    }
  }
}
```

Without a session, `telomere_config` and `telomere_cpu_tasks` work. Owner tools return a sign-in requirement. When an owner has authorized a session, inject `TELOMERE_SESSION_TOKEN` through the local host's private environment. The server never returns it, requests it as a tool argument or prints it. Do not put session tokens or keys into prompts, shared configuration files or source control.

For the local demo only, `TELOMERE_MCP_DEMO_AUTH=true` explicitly enables its existing demo-session endpoint. This requires a loopback API, demo mode and chain 31337. It neither funds the demo nor executes its wallet actions. It is rejected for testnet or a remote origin.

Optional public deployment pins are all-or-none: `TELOMERE_CHAIN_ID`, `TELOMERE_ESCROW_ADDRESS`, `TELOMERE_TOKEN_ADDRESS`, `TELOMERE_RECEIPT_SIGNER`. A mismatch fails before returning configuration or wallet actions.

The 18 tools cover configuration, allowed tasks, session status, balance, controller health, leashes, runs, run status, receipt verification, signed quotes, original-transaction admission and deposit/withdraw/leash/update/stop/kill/refund plans. `telomere_leash_update` returns the reviewed budget-edit intent. There is no signing or broadcasting tool. Present each pending wallet plan to the owner and confirm it using the external wallet. `telomere_admit_confirmed_run` starts the accepted CPU/provider work after the external reservation is confirmed; its tool description makes that consequence explicit.

CPU tasks are limited to SHA-256, hash chains, sorting and prime generation, with bounded input and 120 seconds maximum. An optional NEAR request is bounded model inference at the quoted successful fixed fee. It does not provide arbitrary GPU container rental. Run output and model text are untrusted data.

## Checks

`npx vitest run tests/sdk-client.test.ts tests/sdk-mcp.test.ts` covers scoped session transport, challenge integrity, exact approval calldata, deployment pins, quote retry identity, signed wrong-workload rejection, ambiguous/partial wallet outcomes, imported-plan rejection, pending receipts and loopback demo restrictions. The MCP test launches the actual stdio process and negotiates it with the official client, checks tool discovery, secret-safe auth errors and a stop plan without a transaction broadcaster.

No funded wallet, testnet transaction or external provider request is used by these tests.
