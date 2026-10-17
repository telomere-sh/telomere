# Real controller crash and settlement recovery acceptance

The automated harness passed on the Enclave VPS on **8 October 2026 at 17:10:51 Moscow time**. The machine-readable evidence is [recovery-acceptance.json](recovery-acceptance.json).

The harness used a separate randomly selected loopback Anvil chain 31337, newly generated test accounts, a disposable six-decimal MockToken, a durable on-disk PGlite database, and Docker cells bearing a unique `telomere.acceptance` label. It did not restart the existing staging service, touch Enclave storage, or call NEAR.

## Observed results

| Failure injection | What was observed after restart |
| --- | --- |
| `SIGKILL` of a real Node controller during active Docker CPU execution | A running orphan cell remained. Two already persisted valid meter ticks survived the crash, with 9 billable seconds. Startup removed the orphan, reconstructed a failed receipt from those observations, charged exactly 900 token base units and returned 2,100 from a 3,000-unit reservation. No second CPU cell was created. |
| `SIGKILL` after signed settlement bytes were committed, before broadcasting them | The reservation remained open and treasury unchanged. Restart reused the same transaction hash and raw bytes, settled the previously completed CPU result once, and charged 300 base units. A further restart produced no additional charge or CPU execution. |
| Settlement held before broadcast, followed by controller crash and expired-reservation refund | The local EVM clock advanced 21,632 seconds. The test owner successfully refunded the full 3,000-unit reservation. Restart reconciled the job as `refunded`, charged zero, and created no additional CPU cell. |

All acceptance cells were removed. The parent controller, crash victims, restarted controllers, Docker daemon, local EVM and durable filesystem database were real processes and services. Only the settlement broadcast boundary was deliberately held by the test fixture.

## Reproduce

Build contracts and run the harness on a Linux machine with Node 22, Docker and the installed Linux Anvil binary:

```sh
npm run contracts:compile
CPU_IMAGE='node@sha256:YOUR_REVIEWED_IMAGE_DIGEST' \
ACCEPTANCE_WORK_DIR='.local/recovery-acceptance' \
node --import tsx scripts/recovery-acceptance.ts
```

`ACCEPTANCE_ARTIFACT_DIR`, `ACCEPTANCE_ANVIL_BINARY` and `ACCEPTANCE_REPORT_PATH` can point to existing compiled artifacts, an Anvil binary and a report destination. Settings files contain only newly generated test secrets, are written with mode 0600 under a directory created with mode 0700, and must remain outside Git. The harness never reads the staging environment file.

The CPU crash fixture deliberately throttles its own container to 0.1 CPU, while retaining the other sandbox restrictions, to allow a five-second meter interval to be persisted before termination. This fixture limit does not change the deployed one-CPU execution profile.

## Limits

This acceptance establishes actual process-crash recovery on durable PGlite and the existing Docker host. It does not establish PostgreSQL disaster recovery, Robinhood confirmation/finality behavior, extension-wallet interaction, paid NEAR admission or hardware attestation of CPU work. CPU observations remain signed software host observations. The six-hour refund boundary was exercised by advancing the disposable EVM, rather than waiting six hours of wall time.

The unused signed transaction from the refund fixture remains in its isolated transaction journal. It is not broadcast after the contract reports a refund. Operator review is required before deciding how to consume an unresolved signer nonce in an actual deployment; the harness's ephemeral chain and identities are discarded afterward.
