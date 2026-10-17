# Platform v2 immutable evidence publication

`src/receipts/platform-v2-publication.ts` provides an explicitly enabled publication port and a separate read-only reader. It installs no storage endpoint and leaves publication disabled unless its constructor receives `enabled: true`. `src/receipts/platform-v2-s3.ts` supplies a concrete reviewed S3-compatible transport. `configuredPlatformRuntime` can enable the paid CPU v2 producer through the private operator configuration's `receiptV2` section; default startup keeps it disabled.

The publisher accepts the strict redacted Platform v2 evidence core. Unknown fields are rejected: private lease argv/stdin, raw output and private output salt cannot be included as additional bundle fields. The core still contains public quote, delegation and signed metering evidence. Its existing versioned receipt hash commits the canonical core digest.

## Construction and exact bytes

Configure exactly two `PlatformV2PublicationStore` ports with distinct immutable identities and failure-domain declarations. These values are operator declarations; two identifiers cannot prove physical, administrative or regional independence. A successful read returns `configuredCopiesVerified: true`, `storageAssurance: "two-operator-declared-domains"`, and `independentlyPublished: false`.

`PlatformV2PublicationJournal(db, { chainId, escrow, hostRegistry })` supports the existing PostgreSQL/PGlite database. Call `initialize()` explicitly, or call the publisher's `initialize()`. Its optional table is not created by default startup migrations. The first record commits exact canonical text for the public core and manifest under deployment scope and run ID. There is no replacement operation. Changing the opening transaction, block hash, block number, event log index, core or declared destinations on retry fails before storage writes.

The manifest binds deployment scope, run ID, versioned receipt hash, core digest and byte count, canonical opening transaction/block/event coordinates, and the configured destination identities. `blockNumber` accepts a positive bigint or canonical positive decimal string and is published as a decimal string. The manifest digest is returned separately to avoid a circular self-commitment.

Object keys are deterministic:

* `v2/<deployment-scope>/<core-digest>/core.json`
* `v2/<deployment-scope>/runs/<run-id>/manifest.json`

On each destination, the core is immutably written and read back before its manifest is immutably written and read back. Readiness requires the exact bytes on both destinations. A lost write response or partial success leaves the durable original available for retry. The retry uses identical bytes and keys. It never replaces a conflicting object, generates a second receipt, or promotes a single available copy.

## Reviewed S3 transport

`PlatformV2S3EvidenceStore` accepts a reviewed, fixed storage origin, bucket, region and private credentials. Its strict public configuration contains only `identity`, `failureDomain`, `endpoint`, `bucket`, `region`, and `credentialsFile`. The credentials remain private class fields and are excluded from `toJSON()`. Public configuration requires HTTPS without URL credentials, path, query or fragment; HTTP loopback is available only through an explicit development constructor option for local tests.

The transport reuses the existing SigV4 signer. It permits only the two exact v2 evidence key formats above, signs `If-None-Match: *` for PUT, disables redirects and performs an exact bounded GET readback after HTTP 200, 201, 204 or 412. A pre-existing object is an idempotent success only when its bytes equal the submitted original. An uncertain reply is retried with the same journalled bytes. GET caps both declared Content-Length and streamed byte count, rejects content compression and holds the operation's cancellation/deadline across body streaming. It exposes no replace, delete or list operation.

These checks provide immutability through the API's conditional-write path. They do not prove bucket Object Lock, protection from bucket administrators, infrastructure independence, or durability after a physical provider failure. Runtime configuration additionally rejects repeated actual endpoint/bucket destinations; distinct operator declarations still require independent operational review and live acceptance.

## Read-only consumer

`PlatformV2PublishedEvidenceReader(scope, stores, { timeoutMs? }).retrieve(runId, { expectedReceiptHash?, signal? })` re-reads both manifests and both cores on every request. It checks exact UTF-8 canonical encoding, strict schemas, all manifest-to-core commitments, both configured destinations, and agreement between copies. It rejects missing, corrupt, divergent or oversized objects. Reads do not repair copies or accept request-controlled storage URLs.

The core bound is 256 KiB; the manifest bound is 4 KiB. Each configured store operation receives `signal` and `maxBytes`. A concrete adapter must enforce the bound while streaming and honour cancellation. The module adds an operation deadline of 10 seconds by default, configurable from 1 ms to 30 seconds, and retains one of four in-flight slots until the underlying call settles, including after a timed-out adapter ignores cancellation. This prevents repeated timeouts from accumulating unlimited unresolved work.

Retrieval proves copy integrity and agreement. A consumer must still pass the fetched core to the combined public verifier and authenticate the manifest's opening coordinates against canonical, confirmed archive-RPC history. Publication does not authenticate a block, prove signing time, establish execution exit status, verify raw output, or turn operator-declared domains into independently observed infrastructure.

## Verification

The publication suite uses actual signed v2 evidence, in-memory immutable storage ports and a disk-backed PGlite reopen. It covers disabled writes, destination separation, private-field rejection, canonical encoding, lost write response recovery, changed retry refusal, missing/divergent/oversized copies, durable corruption, cancellation, and bounded unresolved adapter calls. The S3 transport suite uses an injected local fixture fetch implementation to check signing, conditional-write conflicts, uncertain replies, exact readback, key restrictions, streaming bounds, deadline cancellation and redacted failures. Neither suite uses a public storage service, wallet or public-chain transaction.
