# Public receipt verifier

`/verify/` accepts a signed CPU receipt, an execution-record export, an exported
hourly proof, or a run ID. No wallet connection or transaction is required.
The endpoint is `POST /api/public/receipts/verify`, with exactly one of `receipt`
and `runId`, plus an optional `settlementTxHash` in either mode.

The report separates receipt format, configured chain/escrow/signer, complete-body
hash, EIP-712 signature, accounting conservation, meter-record integrity, on-chain
run binding, settlement event and canonical confirmation depth. Required checks
must pass for `verified`; invalid evidence, missing evidence and unavailable RPC
produce distinct outcomes. Settlement event amounts and refund must match the
receipt. The transaction must target the configured escrow and come from its
configured operator. Twelve confirmations and a canonical block/state are required.

Current CPU receipts contain operator-signed software metering. Their hash-linked
ticks are checked for integrity and measured time; they do not contain independent
host signatures or hardware attestation. These checks do not establish the
mathematical correctness of task output. Independent host signatures are marked
not applicable. An hourly root is optional for this direct-settlement profile and
is checked only against the configured root contract and a supplied hourly proof.

Run-ID lookup checks for settled on-chain state before reading a stored receipt.
Only receipt and settlement-hash columns are selected. Neither private owner APIs
nor raw stored receipts are made public. The response contains fixed report text
and a small accounting summary, excluding inputs, outputs, ticks, signatures,
private timestamps, sessions and Cyst locators. Submitted JSON is not persisted
or included in application request logs. Public run IDs and the accounting summary
are already committed by the escrow; this endpoint does not publish workload data.

The public verifier uses fixed deployment configuration, never caller-provided
RPC URLs. The endpoint has a 128 KiB streamed body limit, five-second body deadline,
bounded JSON complexity, two concurrent verification slots, a 30-second response
deadline, and the public financial rate bucket of six requests per minute per IP.
Timed-out RPC work retains its slot until it finishes. Existing Origin restrictions
remain in force, and reports use `Cache-Control: no-store`.

Workspace receipt import now accepts signed receipt exports only and requires a
verified report before adding an accounting display row. Historical imported rows
remain labeled Imported. The owner-only execution-record viewer links to the public
verifier without embedding any receipt data in the URL.

Validation includes real EIP-712 signatures, altered bodies and signatures, wrong
domains/amounts/workloads, missing receipts, active/refunded runs, missing events,
insufficient confirmations, noncanonical observations, RPC errors, malformed hourly
proofs, request bounds and concurrency after timeout. A disposable local EVM test
deploys the real escrow, deposits/reserves/settles funds, checks the report and
confirms that verification does not broadcast transactions or expose job data.
