# ElizaOS and Conway Automaton paid compute starters

The starters in `src/integrations` use the current Base/USDC platform API and the original per-agent `PlatformAgentVault`. They prepare a signed, bounded CPU reservation, return its exact unsigned `payRun` transaction for the separate agent wallet, admit the original confirmed transaction, and read the original run's settlement. Neither starter contains a wallet signer or a transaction broadcast port. The owner funds and controls the Vault; the authorized agent wallet pays within its Leash.

`DurableVaultCompute` is reusable independently of either framework. It requires independently reviewed platform code hashes, registry/implementation code hashes, and the exact owner/agent/Vault/agentId/Leash binding. Its encrypted owner journal first stores that profile, then the exact operation input before requesting a quote, the exact prepared quote before exposing its transaction, and the original transaction hash before admission. Restart retries use the same server idempotency keys. A recorded wallet transaction suppresses further wallet actions; an expired unpaid quote cannot silently become a replacement payment. Status always makes a fresh checked API read. The API response remains controller evidence; this adapter does not independently verify a public-chain receipt or a TEE.

For a reviewed CPU receipt v2 deployment, include `cpuReceiptVersion: 2` in the private profile. It is part of the immutable profile commitment and is passed to the SDK before the first request. Observing the API's v2 marker also durably records a v2 protocol floor: subsequent requests and process restarts reject a missing or downgraded marker. The marker identifies the issuer protocol; it does not independently prove the underlying execution or publication.

Use the existing `CystCheckpointFileVault` and `PaidLifecycleClientVault` as the durable journal. Their scope must be the original owner and agent with application schema `telomere-framework-compute/v1`. Retain the same directory and master key across restarts. The journal stores application input encrypted, but its owner controls the key; independent backups, key recovery and filesystem ACLs remain deployment responsibilities.

The command contract is:

```typescript
type Command =
  | { action: 'prepare'; operationId: string; input: PlatformQuoteInput }
  | { action: 'admit'; operationId: string; transactionHash: string }
  | { action: 'status'; operationId: string };
```

`PlatformQuoteInput` includes the original Leash, CPU task, bounded duration, deadline, maximum spend and allowed regions. Reviewed exec/session images and a separately enabled managed-inference request use the existing checked SDK request schema. Arbitrary GPU Cells are not exposed. `operationId` is an application-owned durable identifier; never generate a fresh one merely because a response is uncertain. An admission hash must be the confirmed external wallet's exact `payRun`, not a guessed new payment.

## Framework registration

[ElizaOS released core 1.7.2](https://registry.npmjs.org/@elizaos/core/1.7.2) defines a three-argument Action validator and a handler with `HandlerOptions`. `createTelomereElizaPlugin(compute)` satisfies its actual `Plugin` declaration. That release can send an exact JSON command in `Memory.content.text`; the handler does not invent an LLM extraction API. Newer [upstream component contracts](https://github.com/elizaOS/eliza/blob/b4e72f71456fbe4a3cbfd941b4c418d41cfb0bba/packages/core/src/types/components.ts) can pass the same command as `options.parameters.request`. Bind one plugin instance to one agent's original authenticated Vault session:

```typescript
import type { Plugin } from '@elizaos/core';
import { createTelomereElizaPlugin } from './telomere/dist/src/integrations/index.js';

const plugin: Plugin = createTelomereElizaPlugin(compute);
// Register plugin through your actual Eliza runtime's normal plugin configuration.
```

[Conway Automaton's actual Tool contract](https://github.com/Conway-Research/automaton/blob/d8f816881fd24b6f5e3d616e59edec387a447667/src/types.ts) has `execute(args, context)`, JSON Schema parameters, risk level and category. `createTelomereAutomatonTools(compute)` satisfies `AutomatonTool[]`; add the returned tools where that runtime assembles its real [builtin tools](https://github.com/Conway-Research/automaton/blob/d8f816881fd24b6f5e3d616e59edec387a447667/src/agent/tools.ts). Its tool verifies `context.identity.address` and `creatorAddress` against the original reviewed binding before accessing Telomere. Keep the existing runtime policy engine around execution. This is a source-level tool integration, not a fabricated Conway provider or dynamic plugin-install API.

```typescript
import type { AutomatonTool } from './src/types.js';
import { createTelomereAutomatonTools } from './telomere/dist/src/integrations/index.js';

const tools: AutomatonTool[] = [
  ...createBuiltinTools(sandboxId),
  ...createTelomereAutomatonTools(compute),
];
```

Both wrappers mark returned application output as untrusted data and return generic errors without disclosing cookies, input contents or keys. The starter supplies compute tools to an existing framework runtime; it does not replace that runtime's inference, survival loop, Conway Cloud client or treasury policy.

## Runnable CLI

`src/integrations/cli.ts` uses the same real factories and private file journal. Provision a reviewed JSON profile (`{baseUrl,pins,vaultPins,binding}`), an authenticated **agent** session file, a stable 32-byte hex journal master-key file and a command JSON file. Secret files must be private regular files; on POSIX use mode 0600, and on Windows restrict their ACL to the agent operator. Keys and tokens are file contents, never command-line values. From the repository root:

```powershell
npx tsx src/integrations/cli.ts --framework elizaos `
  --profile-file .local/reviewed-agent-profile.json `
  --journal-directory .local/private-agent-compute `
  --master-key-file .local/private-agent-compute-key.txt `
  --session-token-file .local/private-agent-session.txt `
  --command-file .local/agent-command.json
```

Use `--framework automaton` for the Conway tool entry point. It prints one machine-readable JSON result. `prepare` returns a wallet action; send it once through the separately controlled original agent wallet and put its confirmed hash in the `admit` command. A subsequent `status` command reuses the same profile, operation and journal. Reconcile an uncertain result before attempting any further payment. The CLI takes its framework identity from the independently reviewed profile; an actual Automaton host additionally checks its live `ToolContext` identity.

## Reproducible local acceptance

```powershell
npx vitest run tests/framework-starters.test.ts --reporter=verbose
```

The acceptance uses a disposable Anvil chain, real immutable Selection/Vault contracts, real authenticated HTTP routes, an encrypted file journal reopened across lost quote/admission responses, and one actual HostKit CPU child. The separately held local agent wallet broadcasts exactly one payment. Both framework handlers observe the same completed run with a positive charge, fee, refund and exact SHA-256 result. Wrong profile, changed original input, replacement transaction hash, underfunded request and wrong Automaton identity fail. The child-process fixture does not establish gVisor/TDX isolation. No paid external provider request or public-chain transaction is made.

The official npm 1.7.2 Plugin declaration and pinned Conway AutomatonTool declaration were also used for a separate TypeScript compatibility check. Starting a full Eliza/Automaton LLM loop, public Base deployment, paid managed inference and funded production-wallet acceptance are deployment checks, not outcomes of this local starter test.
