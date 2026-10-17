# Reviewed S3 storage for large Cysts

`S3LargeCystStore` is one S3-compatible destination for the existing `LargeCystStore` protocol. It uses the shared SigV4 signer and path-style requests. Header, part and manifest objects have opaque checkpoint paths. Every `PUT` includes `If-None-Match: *` and is acknowledged only after a `GET` verifies exact length, SHA-256 metadata and bytes. A `412` is an exact-content retry; differing stored content is a conflict. There are no list, overwrite or delete operations.

The adapter accepts only an explicitly reviewed HTTPS endpoint, bucket, region and failure-domain label. HTTP requires `allowInsecureLoopback: true` and a loopback hostname. Credentials remain private fields and are omitted from JSON. Each request has a bounded timeout, rejects redirects and encoded responses, and reads at most 2,048 header bytes, 131,072 manifest bytes or the expected part length (up to 4 MiB + 40 bytes). JSON must be byte-for-byte canonical after strict schema parsing. A committed part must match the manifest digest.

`initialize()` actively checks the configured endpoint, credentials and bucket before enabling the destination. It conditionally writes one immutable canary at `large-cysts/v1/_connectivity/probe.bin`, repeats the same conditional PUT and requires HTTP `412` to verify that the provider honors `If-None-Match: *`, then reads the canary with a signed GET and verifies the exact fixed body, metadata, digest and length. A restart reuses this key, so the probe creates no additional objects and deletes nothing. Invalid credentials, wrong bucket, inaccessible endpoint, ignored write preconditions, changed canary or failed read-back prevent initialization. This requires conditional `PutObject` and `GetObject` access to the dedicated canary key. A successful probe confirms those operations at startup, but it cannot establish future availability or prove independent failure domains.

```ts
import { S3LargeCystStore } from './src/cysts/large-s3.js';
import { LargeCystReplicatedStore } from './src/cysts/large-replicated.js';
import type { S3Credentials } from './src/cysts/s3.js';

async function createReviewedStore(primaryCredentials: S3Credentials,
  secondaryCredentials: S3Credentials): Promise<LargeCystReplicatedStore> {
  const primary = new S3LargeCystStore({
    endpoint: 'https://reviewed-primary.example', bucket: 'reviewed-primary-bucket',
    region: 'us-east-1', failureDomain: 'reviewed-primary-domain', reviewed: true,
    credentials: primaryCredentials,
  });
  const secondary = new S3LargeCystStore({
    endpoint: 'https://reviewed-secondary.example', bucket: 'reviewed-secondary-bucket',
    region: 'eu-west-1', failureDomain: 'reviewed-secondary-domain', reviewed: true,
    credentials: secondaryCredentials,
  });
  await Promise.all([primary.initialize(), secondary.initialize()]);
  return new LargeCystReplicatedStore([primary, secondary]);
}
```

The example shows the low-level adapter. The main server now offers an optional, disabled-by-default two-destination configuration through `CYSTS_LARGE_REPLICATION_CONFIG` and `CYSTS_LARGE_REPLICATION_CONFIG_SHA256`. It wraps both S3 stores in `LargeCystQuotaShadowStore`, preserving local byte and checkpoint-count quotas, original ciphertext for retries, and an immutable topology binding. See `large-cyst-checkpoints.md` for the operator setup. Two separately operated providers, credentials, actual failure-domain independence and restore drills still require review before enablement. Different failure-domain strings alone do not prove independent regions or operators. The S3 principal should be restricted to `GetObject` and conditional `PutObject` on the dedicated prefix. Provider behavior and durability have only been exercised with the local signed loopback fixture; no external provider has been contacted by this implementation or its tests. Remote capacity, lifecycle retention and cost controls remain deployment responsibilities.
