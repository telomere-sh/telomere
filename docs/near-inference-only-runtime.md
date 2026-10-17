# One-shot NEAR inference in the paid Platform runtime

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`task: { "kind": "near_inference" }` is a logical inference job. It does not run a CPU task, admit a HostKit lease, launch user code, or provide a GPU/TEE Cell. It uses the reviewed NEAR model-completion adapter, which remains disabled unless the platform operator explicitly configures `nearInference: true` with a fixed model, policy hash, price, provider timeout and matching payout operator.

An authenticated payer or Vault agent prepares the job with the existing `POST /api/platform/quotes` or Vault quote route. The quote body includes the usual Leash, deadline, maximum duration, region and USDC spending cap, plus:

```json
{
  "task": { "kind": "near_inference" },
  "near": {
    "model": "reviewed-model-id",
    "maxTokens": 32,
    "policySha256": "0x...",
    "prompt": "Bounded prompt text"
  }
}
```

The configured model, token limit and policy hash must match exactly. Prompts are at most 8 KiB, output is bounded by the reviewed token limit (at most 512), and the original quote binds the request with `platformWorkloadHash`. The run uses the same owner-funded `openRun` transaction, HTTP admission, Leash checks, durable single-dispatch intent, receipt publication and settlement as other paid Platform work. Repeating an idempotency key returns the original prepared quote; it does not send a second NEAR request.

The registered CPU-class host in the quote identifies the existing escrow payout operator. It is not an execution host for this job. The operator must equal the configured NEAR billing operator before quoting and again before the paid provider call. The escrow reserves the fixed inference price plus the CPU-class maximum-duration ceiling and platform fee; no HostKit slot is probed or used. The final settlement has **zero billable CPU seconds**. Only a timely, enclave-verified NEAR response bound to the exact original request incurs the fixed inference charge and fee. A rejected, unavailable, late, ambiguous or crash-recovered request has zero inference charge and zero payable host amount; the unused reserve is refunded through the original settlement. A paid POST is never retried after an uncertain outcome.

`GET /api/platform/runs/:id` reports `executionKind: "near_inference"`. Its `result` is a zero-duration controller state record, not proof of CPU execution. The verified model output appears in `nearResult` only when it was charged and its evidence matches the committed receipt. Arbitrary CUDA/Docker execution, GPU-second metering, isolation of user GPU code and Cyst key release inside a GPU TEE are outside this mode.

Live use still requires a fresh accepted NEAR policy, passing gateway/model verification, a configured billing operator, confirmed owner-funded chain transactions and end-to-end settlement acceptance. Local fixture tests prove the financial and recovery behavior, not those external conditions.
