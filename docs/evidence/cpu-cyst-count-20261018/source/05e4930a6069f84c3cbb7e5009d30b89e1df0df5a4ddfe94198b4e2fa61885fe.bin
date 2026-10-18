# Encrypted application checkpoints: first Cysts slice

The closed pilot can save and recover bounded **application state** without a personal wallet. A client supplies an already authenticated owner session (including the explicit local-chain demo session), encrypts state locally, uploads ciphertext, and later downloads and decrypts it on a separate client. The server never needs or accepts the recovery key or plaintext.

This implements the application-checkpoint option in the Telomere Cysts specification. It is not a Linux process snapshot, CRIU restore, a GPU/CUDA checkpoint, host migration, or the complete Cysts/Metabolism platform. The bytes are never automatically executed or restored into a running process.

## Encryption and ownership

`encryptCheckpoint` creates a fresh independent 32-byte recovery key by default, a random 24-byte nonce, and a random checkpoint identifier using `crypto.getRandomValues`. It uses `xchacha20poly1305` from directly pinned `@noble/ciphers` 1.3.0. [The library's official 1.3.0 documentation](https://github.com/paulmillr/noble-ciphers/blob/1.3.0/README.md#xchacha20-poly1305-encryption) documents the key/nonce sizes and authenticated encryption API.

Authenticated associated data is a fixed ordered JSON tuple containing the domain `telomere.application-cyst`, envelope version, algorithm, checkpoint ID, normalized owner and agent addresses, application schema identifier, original plaintext byte count, and nonce. Ciphertext includes the 16-byte Poly1305 tag. Its SHA-256 digest is checked by both client and server. Metadata changes or ciphertext changes, even with a recomputed public digest, fail client authentication.

Keep the returned recovery key separately on the client; `exportCystRecoveryKey` and `importCystRecoveryKey` convert between the 32 bytes and a strictly validated 64-character lowercase hex recovery code. Losing this key loses access to the plaintext. Neither recovery codes nor keys belong in API bodies, logs, public metadata, or server configuration. The helpers clear their temporary key copies after decryption, import/export and failed encryption; successful encryption returns a live recovery-key buffer owned by the caller. Caller-supplied keys are preserved, including on failure, so repeated restores remain possible. JavaScript does not guarantee secure memory erasure; string recovery codes and runtime-internal copies cannot reliably be wiped.

The authenticated owner can store checkpoints labeled with an agent address and filter them by that agent. This is an owner-controlled namespace, not proof of an on-chain agent registration or authorization by the labeled agent. Reads and writes are scoped to the authenticated owner; another owner gets an empty list and indistinguishable checkpoint-not-found responses. Server-side AEAD verification is impossible without the key: the server verifies structure, bounds, SHA-256, and ownership, while decryption verifies authenticity in the client.

## Exact pilot limits

`GET /api/cysts/capabilities` exposes the same immutable limits the SDK enforces:

| Limit | Value |
| --- | --- |
| Plaintext checkpoint | 1 byte through 2,097,152 bytes (2 MiB) |
| Ciphertext | Plaintext length plus exactly 16 bytes |
| JSON upload/download bound | 2,800,320 bytes |
| Owner storage quota | 33,554,432 ciphertext bytes (32 MiB), including tags |
| Owner checkpoint count | 512, including pending uploads |
| List page | 100 records, deterministic ascending checkpoint ID cursor |
| Public application schema ID | 1–64 ASCII letters/digits and `._/-`, starting with a letter/digit |

The 32 MiB quota counts every immutable checkpoint reservation, even if identical ciphertext can share its stored blob within the same owner. This conservative accounting avoids races and prevents interrupted uploads from escaping the quota. This slice does not delete or expire checkpoints; reaching either quota needs a future retention/retirement policy rather than silently discarding state.

## API and SDK

The feature is disabled by default. The operator must set `CYSTS_ENABLED=true` and an explicit dedicated `CYSTS_DIR` before startup; startup initializes and validates that directory before serving requests. A deployment with Cysts disabled does not mount these routes or increase its request bound. The API uses the existing owner session, origin checks, JSON requirement, and rate limits. Only the `/api/cysts` namespace receives the larger checkpoint request bound; unrelated API limits remain unchanged. Upload bodies are strict encrypted envelopes. Extra fields such as `recoveryKey`, `filename`, or server filesystem paths are rejected.

| Request | Result |
| --- | --- |
| `GET /api/cysts/capabilities` | Exact supported format and limits |
| `GET /api/cysts?agent=0x…&cursor=0x…` | Owner-scoped metadata, logical usage and optional next cursor |
| `POST /api/cysts` with `Idempotency-Key` | Store original encrypted envelope; 201 first upload, 200 exact replay |
| `GET /api/cysts/:id` | Public metadata, including `pending` or `ready` |
| `GET /api/cysts/:id/blob` | Validated metadata and canonical base64 ciphertext |

```typescript
import { TelomereClient, encryptCheckpoint, exportCystRecoveryKey } from './src/sdk/index.js';

// Authenticate this client through the existing generated local demo identity
// or an owner session before storing checkpoints.
const client = new TelomereClient({ baseUrl: 'http://127.0.0.1:3281' });
await client.authenticateDemo({ explicitlyEnabled: true });
const { address: owner } = await client.me();
const { envelope, recoveryKey } = await encryptCheckpoint(
  new TextEncoder().encode(JSON.stringify({ counter: 42 })),
  { owner, applicationSchema: 'counter.v1' },
);
const recoveryCode = exportCystRecoveryKey(recoveryKey); // Keep on the client.
await client.cysts.upload(envelope, crypto.randomUUID());
const bytes = await client.cysts.restore(envelope.id, recoveryKey, { owner });
const restoredState = JSON.parse(new TextDecoder().decode(bytes));
```

The exported `CystClient` can also share an existing `ApiTransport` directly. `upload` validates the echoed checkpoint, `download` requires the expected owner scope and checks the digest, and `restore` returns decrypted bytes. Parsing or using application state remains a caller decision; do not execute code from a checkpoint.

## Storage, interruption and backup

`CystService` stores metadata and a quota ledger in PostgreSQL/PGlite. The transaction locks the owner's quota row, reserves bounded metadata and quota, then commits a `pending` checkpoint before writing ciphertext. This ordering avoids unlimited orphan blobs on database failures.

Ciphertext lives in the dedicated operator-configured `CYSTS_DIR`. Filenames are internal SHA-256 values derived from the normalized owner and ciphertext digest; requests cannot choose paths. The storage root is validated against symlinks and inode replacement. On POSIX it must be private (0700), and blobs are created exclusively with 0600. A private temporary file is written and synced, published using an atomic hard link without overwriting an existing blob, then the directory entry is synced. Every read checks file type, hard-link count, permissions, bounded length and content digest, and refuses symlink files. Startup occurs after the database controller lock and before requests; it removes only internally named `.tmp-UUID` crash leftovers after bounded size, regular-file, inode, link and permission checks. Unexpected symlink or oversized temporary files cause startup to fail closed. Windows mode bits do not enforce an ACL; use an operator-owned directory with restrictive Windows ACLs. This file store assumes the dedicated service user and operator control their directory; it is not isolation against a hostile operating-system administrator.

A failed file write leaves a `pending` reservation. Retry **the original envelope and idempotency key** to complete it with no extra quota reservation. A successful blob write followed by a lost `ready` database update can be recognized by owner-scoped listing or metadata/blob access after restart: the exact stored digest and size are verified before promotion to `ready`. Listing reconciles only its returned page, sequentially, without scanning all owners; this lets a fresh client restore with its separately saved recovery key even after losing the original upload envelope and idempotency key. A pending checkpoint with no blob remains pending and is unavailable for download; no plaintext or replacement ciphertext is invented. Existing corrupted or linked blobs are never overwritten during replay.

Backups must capture **both metadata database and this ciphertext directory** while the service is stopped, together with the service profile that selects that directory. Client recovery keys must be backed up independently on the client; a server backup does not contain them. Portable restore is verified by reopening a persistent database and copying ciphertext into an independent directory, then decrypting on the client using its recovery key. This is local private storage for the closed pilot. Off-host S3 storage and redundancy across two regions are still required for the full specification.

## Remaining full-specification work

Recipient key wrapping and immutable two-destination storage are implemented separately in [Cyst replication](cyst-replication.md). The optional [CystRegistry](cyst-registry.md) connects registered Selection agents to unsigned checkpoint publication/retirement plans, canonical verification and retrieval of their current published ciphertext. These features require explicit configuration; the original owner upload API is unchanged.

The owner-side [checkpoint coordinator](cyst-checkpoints.md) adds a durable application capture hook, default tick-driven 15-minute cadence, explicit lifecycle triggers, exact prepared-envelope retries, persistent pause/resume and local restoration. The embedding application supplies its scheduler and private durable vault; automatic host-runtime event wiring remains separate.

Remaining work includes owner-signed permits for another host, CRIU/CUDA and large encrypted filesystem snapshots, rolling snapshot leases, storage payments, garbage collection, production host transfer/resume, verified independent storage regions, full Metabolism runner integration, host attestation and key release. Registry retirement alone does not delete a blob or reclaim quota.

Meaningful checks are in `tests/cysts.test.ts`: SDK-to-Hono-to-PGlite upload/download/decrypt; random keys/nonces; AEAD metadata binding; tenant isolation; concurrent quota reservation; idempotency; malformed envelopes and body limits; a maximum 2 MiB checkpoint; filesystem and ready-update failures; restart and independent-directory restore; tamper/no-overwrite checks; directory replacement; and POSIX symlink/mode enforcement.
