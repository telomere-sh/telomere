# Private Platform v2 admission witness

`src/receipts/platform-v2-witness.ts` provides a default-unmounted verifier and
idempotent private journal for one HostKit v2 admission witness per CPU run. The
persisted artifact contains the exact original admission envelope (including
the signed lease, private argv and stdin), the host-signed admission receipt,
the unchanged public v2 core digest and receipt hash, and the opening transaction
and block hashes. The verifier checks the host signature and every admission
scope field against the envelope, the original lease, the delegation and the
full signed tick/ACK core. It requires the host's claimed acceptance time to
precede the first tick. The journal checks deployment scope before inserting,
reads the row back, accepts exact retries and rejects changed witnesses.

This is a **private operational witness**, not a public v2 issuer. The current
public v2 receipt hash commits to the evidence core, which does not contain the
host admission receipt or this witness hash. The existing combined verifier can
therefore accept a committed core without this witness. Neither this journal
nor its database timestamp independently dates the EOA delegation or proves a
host never ran an earlier workload. The historical authority and opening
references passed to the isolated verifier remain caller supplied unless a
caller obtains them from the archive-backed opening reader.

The default Platform CPU executor still calls `/v1/leases`, and the live
`persistOutcome` path still creates a v1 receipt. This module does not mount a
route, settle a run, or publish a public evidence copy. The private envelope
must never be returned through a public retrieval route because it contains
the original command and stdin. A complete opt-in issuer would need a durable
v2 selection before the quote/opening, `/v2/leases` dispatch with response-loss
recovery, a versioned public core that commits to the host receipt, a persisted
random output salt before settlement intent, two independently readable
immutable evidence copies with digest readback, and fail-closed recovery before
financial root publication and settlement. Local two-directory tests can check
idempotency and divergence handling, but cannot establish independent storage
or retention guarantees.

Focused local verification: `npx vitest run tests/platform-v2-witness.test.ts`
and `npm run typecheck`.
