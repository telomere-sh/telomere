# Immutable replicated application Cysts and recipient key wrapping

`src/cysts/replicated.ts` defines the `CiphertextStore` interface (`initialize`, `read(owner, digest, expectedBytes)`, `put(owner, digest, bytes)`). `S3CiphertextStorage` implements it using narrow S3 GET and conditional PUT requests, and `ReplicatedCystStorage` requires two separately reviewed destinations. The application checkpoint limit remains **2 MiB plaintext / 2 MiB + 16 bytes ciphertext**. This module neither sees plaintext nor accepts checkpoint recovery keys.

## Reviewed storage destinations

```ts
const primary = new S3CiphertextStorage({
  endpoint: 'https://s3.us-east-1.amazonaws.com', bucket: 'reviewed-primary-bucket',
  region: 'us-east-1', failureDomain: 'reviewed-primary-account-region', reviewed: true,
  credentials: primaryStorageCredentials,
});
const secondary = new S3CiphertextStorage({
  endpoint: 'https://s3.eu-west-1.amazonaws.com', bucket: 'reviewed-secondary-bucket',
  region: 'eu-west-1', failureDomain: 'reviewed-secondary-account-region', reviewed: true,
  credentials: secondaryStorageCredentials,
});
const ciphertextStore = new ReplicatedCystStorage([primary, secondary]);
await ciphertextStore.initialize();
```

Configuration requires distinct endpoint origins, region names and failure-domain review labels. These labels record an operator's review; they cannot prove the providers' actual geographic separation or failure independence. Two MinIO fixtures on one machine validate the protocol, **not a two-region deployment**. HTTPS is required except explicitly enabled loopback HTTP for isolated acceptance fixtures. Endpoints cannot contain credentials, path prefixes, queries or fragments. Buckets must already exist. Initialization validates local configuration; it does not create buckets or make remote calls. The first read/write verifies reachability and authentication.

Credentials remain in JavaScript private fields and are excluded from serialization, inspection and thrown messages. Runtime credential/config files must remain private and outside Git, public reports and client responses. The adapter signs the payload, all `x-amz-*` headers, scope metadata and conditional headers with SigV4. It does not implement public ACLs, presigned URLs, redirects, object listing, deletion, multipart uploads or transparent retries. Each request has a configurable 10–60000 ms deadline, including the response body.

Internal keys are `cysts/v1/SHA256("telomere-cyst-blob:" + owner + ":" + ciphertextSHA256).blob`. Owner addresses, checkpoint filenames and raw digests are not inserted into path components. Authenticated metadata binds format version, a domain-separated owner hash, ciphertext SHA-256 and exact byte count.

Use least-privilege prefix-scoped `GetObject`/`PutObject` credentials, block public access, and enforce conditional writes in bucket policy. Do not grant the application deletion or unconditional overwrite capabilities. AWS may return 403 for an absent key when the principal lacks bucket-list permission; the adapter treats that as unavailable rather than pretending it proved absence. The operator may allow narrowly scoped `ListBucket` permission to obtain authoritative absent-object 404 responses; the adapter itself never lists objects. Provider retention, object locking and independent backups remain deployment choices.

## Upload and recovery guarantees

Every PUT includes `If-None-Match: *`. A successful write, or a 412 response to an immutable retry, is followed by a bounded GET that verifies metadata, exact bytes and SHA-256. A 412 is not accepted merely because an object exists. Replication performs both stores independently, then verifies both reads again before acknowledging success. With the S3 adapter this is one PUT and two verification GETs per destination, with no repeated PUT inside a single attempt.

If one destination fails, the operation returns unavailable while retaining the other durable ciphertext. The original Cysts upload must remain pending; retry its original envelope and idempotency key. A new storage adapter/controller instance can complete the missing copy without overwriting the first. These guarantees depend on the storage provider honoring conditional PUT durability and the embedding Cysts service marking records ready only after the replicated `put` resolves.

Reads validate the caller-supplied bounded expected length and pinned ciphertext digest. Response metadata, declared length, streamed length, EOF and SHA-256 must agree. Compressed responses, oversized/short bodies and tampered metadata fail closed. Reads return absence only if both destinations independently returned absence. One absence plus an outage is unavailable.

A verified surviving replica can serve reads during the other destination's outage. `readDetailed` reports per-replica status (`verified`, `missing`, `unavailable`, `invalid`) and repair results. A **confirmed missing** object can be repaired from the verified ciphertext using conditional PUT and a verification read. Repair failure does not discard the healthy copy, but remains visible in this result. Existing corrupt/foreign-metadata objects are never overwritten automatically; they require operator investigation. A fallback can therefore restore a checkpoint without falsely reporting restored redundancy.

`isDurable` is separate from fallback readability: it returns true only when both replicas were independently verified, or a missing replica was successfully repaired and verified. CystService must use this optional storage hook before recovering a pending record to ready; one healthy replica plus an unavailable/failed replica cannot promote a partial upload.

This module is a storage implementation for integration into CystService. Deployments must explicitly select the replicated store; adding the module does not change existing local-private storage or prove production region provisioning. Database checkpoint metadata, owner quotas and pending-upload state still need their ordinary durable backup/restore path.

## Owner/agent recipient key wrapping

`src/sdk/cyst-key-wrap.ts` wraps the existing 32-byte checkpoint recovery key separately to one owner and one agent X25519 public key. It uses WebCrypto X25519 agreement and HKDF-SHA-256, then the already installed XChaCha20-Poly1305 implementation to encrypt the recovery key. Every recipient receives a fresh ephemeral keypair, 32-byte salt and 24-byte nonce.

```ts
const ownerIdentity = await generateCystWrappingIdentity();
const agentIdentity = await generateCystWrappingIdentity();
const scope = { owner, agent, checkpointId: encryptedCheckpoint.envelope.id };
const wrapped = await wrapCystRecoveryKey(encryptedCheckpoint.recoveryKey, scope, {
  ownerPublicKey: ownerIdentity.publicKey,
  agentPublicKey: agentIdentity.publicKey,
});
const ownerRecoveryKey = await unwrapCystRecoveryKey(wrapped, scope, 'owner', ownerIdentity);
```

The domain-separated HKDF info and AEAD additional data bind version, algorithm, owner address, agent address, checkpoint ID, recipient role, recipient public key, ephemeral public key, salt and nonce. Unwrap requires an independently selected expected scope, role and recipient identity. Changing bundle metadata and presenting that altered scope still fails AEAD authentication. Recipient public keys must be authenticated by the owner before wrapping; this helper is not a public-key identity registry or a wallet-to-X25519 proof.

Generated private keys are nonextractable WebCrypto keys. Keep/persist their handles in an appropriate private client vault and retain an independent recovery-key backup; losing all recipient private keys and recovery-key backups loses the checkpoint. JavaScript temporary shared secrets and wrapping/recovery-key copies are cleared after use where possible; CryptoKey runtime memory cannot be explicitly erased. The caller's original recovery key remains unchanged. These are application-side helpers: no server private-key, key-release or wallet endpoint is added. Persisting/distributing wrapped bundles is an explicit client/application integration; the existing strict checkpoint envelope is unchanged.

The wire format is strict canonical JSON produced by `serializeWrappedCystKey`, bounded to 2048 bytes, with exactly one owner and one agent recipient. `parseWrappedCystKey` rejects extra fields, malformed lengths, duplicate properties and noncanonical documents. The construction is versioned and tested; it is not represented as a formally audited HPKE implementation or a hardware attestation/key-release protocol.

## Evidence and references

`tests/cyst-replication.test.ts` uses two actual local HTTP servers with an independent server-side SigV4 verifier. It checks the published AWS GET and signed-payload PUT vectors, separately authenticated replicas, conditional writes, immutable retry after partial failure and restart, read repair, outages, integrity failures, redirects, deadlines, redaction, owner namespace separation and the maximum checkpoint size. It also replicates/decrypts an actual application checkpoint. These tests do not use real AWS accounts or paid requests.

`tests/cyst-key-wrap.test.ts` generates independent owner/agent identities, restores the actual encrypted application checkpoint with either recipient, rejects cross-recipient/wrong-private-key decryption, verifies fresh randomness and authenticates every scope/key-wrapping field. No private key or recovery key appears in the serialized bundle.

Run `npx vitest run tests/cyst-replication.test.ts tests/cyst-key-wrap.test.ts`.

Primary references: [AWS single-chunk SigV4 calculations and vectors](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html), [AWS conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html), [AWS bucket-policy enforcement](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html), [W3C Web Cryptography X25519 and HKDF](https://www.w3.org/TR/WebCryptoAPI/).
