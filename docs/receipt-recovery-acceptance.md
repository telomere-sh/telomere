# Durable receipt recovery acceptance on Linux

The final isolated Linux acceptance passed on the VPS on 8 October 2026 at 19:18:07 Moscow time. It tested the current source snapshot, including the strict offline provider recovery validator, using a separate loopback Anvil chain 31337, fresh generated test identities, disposable mock token and escrow, persistent PGlite database in a private namespace, and real Docker CPU cells. It did not change the working staging installation, use its keys or connect to its database/chain.

`scripts/receipt-recovery-acceptance.ts` injects a transport error only when a run already has a durable completed CPU result and status `receipt_pending`. Actual chain admission, EIP-712 signing, transaction journal persistence, settlement submission, token accounting and signature/anchor verification use the real application code. The injected failure cannot interrupt pre-dispatch checks or invent CPU metering.

| Case | Observed result |
|---|---|
| Same worker loop | A completed seven-second Docker result stayed pending when the receipt RPC read failed. The same worker retried receipt construction after the normal cooldown and settled a 700-unit charge with 2,300 returned. CPU execution count remained one. |
| Restart with RPC still blocked | The worker stopped and its persistent database closed/reopened. Startup recovery retried the receipt under the still-failing transport and preserved the pending target and exact completed CPU result. After the fault cleared, it settled 700/2,300 without another CPU execution. |
| Known synthetic provider result | Real seven-second Docker work and one offline completion fixture were durably saved. After database reopen, startup recovery remained pending while the receipt RPC was blocked. The provider readiness fixture then reported unavailable. Receipt/settlement recovery used the already stored result, charging 10,700 and returning 2,300, with one CPU execution and one fixture call. |

The provider case is explicitly synthetic. Its request ID is `synthetic_acceptance_fixture_no_http_request`, and the public report labels the result `offline_synthetic_result`. Its stored evidence uses the strict TLS evidence schema accepted by the offline recovery validator. The 10,000-unit provider fee is a recovery accounting fixture; no HTTP request or NEAR inference was made. This case establishes durable outcome handling, not live provider attestation or completion acceptance.

All three receipts retained their exact stored CPU result and output, passed signature and on-chain anchor verification, and matched their actual settlement journal hash. Every charge plus refund equalled the reserved ceiling. The Docker acceptance used the digest-pinned Node image and a CPU limit of 0.5 for a positive measurable workload. Seven seconds is this run's observation, not a performance guarantee.

Each CPU cell carried an additional unique `telomere.receipt.acceptance` label. Inventory and orphan cleanup were narrowed to that label, so other pilot containers could not be selected. At completion, the harness stopped its worker and owned Anvil child, closed the database and confirmed zero namespaced cells. An independent post-run inventory also found zero managed Telomere cells, confirmed the harness and owned Anvil PIDs had exited, and found all staging and Enclave services active. Private database evidence stays under `/opt/telomere-pilot/work/receipt-recovery`; the harness rejects symlink parents and an existing scratch namespace, and creates its fresh namespace with permissions 0700. No private keys or raw transaction bytes appear in the public JSON report.

## Reproduce on the Linux VPS

The source harness requires explicit public image/binary/artifact locations:

```sh
CPU_IMAGE=node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 \
ACCEPTANCE_ANVIL_BINARY=/opt/telomere-pilot/app/node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil \
ACCEPTANCE_ARTIFACT_DIR=/opt/telomere-pilot/app/contracts/artifacts \
/opt/node-v22.23.3-linux-x64/bin/node --import=/opt/telomere-pilot/app/node_modules/tsx/dist/loader.mjs \
  /opt/telomere-pilot/app/scripts/receipt-recovery-acceptance.ts
```

For this final run, the same source and current worker were bundled into `/opt/telomere-pilot/work/final-receipt-2026-10-08T16-16-26Z` with external package imports resolved through the installed dependency directory. The tested bundle's SHA-256 was `c794dab9151db96b4ab80aa81b6f9d02f42fbf9497599fe08a16ad9a02abc5dc`, verified before execution. The work directory and its result file had permissions 0700 and 0600 respectively. This allowed testing the new recovery behavior without overwriting deployed application code. The harness creates only its own fresh child chain, namespaced database and labelled Docker cells. It does not start an HTTP controller or make public/provider requests.
