# Large encrypted Cyst file checkpoints

This pilot slice transfers a quiesced application checkpoint file through an authenticated, owner-scoped API. It is a separate versioned format. The existing `/api/cysts` JSON envelope and Python/TypeScript SDK retain their 2 MiB limit and protocol. The large format accepts one regular, nonempty source file up to `2 GiB - 256 KiB`, with the complete stored header, ciphertext, and manifest bounded by the CystRegistry 2 GiB ciphertext limit. The implementation does not allocate a 2 GiB buffer.

## Transfer and restore

The owner-side writer must first durably save a random 32-byte recovery key and a random checkpoint ID in its private vault, then quiesce the source file. `saveLargeCystFile` scans the file in 4 MiB chunks to compute a keyed whole-file MAC. For each chunk it creates a fresh 24-byte XChaCha20-Poly1305 nonce and 16-byte tag; associated data binds the header, index, and exact plaintext length. The store receives only the immutable header, encrypted parts, and a keyed manifest. The recovery key and plaintext never cross the transfer API.

`LargeCystHttpStore` is a **Node-only** owner-side adapter. It sets the authenticated session cookie and Origin header, requires HTTPS outside loopback, refuses redirects and compressed responses, and bounds each response. Example for an already authenticated owner process:

```ts
import { randomBytes } from 'node:crypto';
import { LargeCystHttpStore } from './src/sdk/large-cyst-http-store.js';
import { generateLargeCystId, saveLargeCystFile, restoreLargeCystFile } from './src/cysts/large-checkpoints.js';

const id = generateLargeCystId();
const recoveryKey = randomBytes(32);
// Persist id and recoveryKey in the owner's private vault before the upload.
const scope = { owner: '0x...', agent: '0x...', applicationSchema: 'overlay.tar.zst/v1' };
const store = new LargeCystHttpStore({ baseUrl: 'https://controller.example', sessionToken });
await saveLargeCystFile({ store, sourcePath: '/private/staged/overlay.tar.zst', id, scope, recoveryKey });
await restoreLargeCystFile({ store, id, destinationPath: '/private/restore/overlay.tar.zst', scope, recoveryKey });
```

The API exposes `POST /api/cysts-large` for the header, `PUT/GET /api/cysts-large/:id/parts/:index` for binary ciphertext parts, `POST /api/cysts-large/:id/commit`, and `GET /api/cysts-large/:id/header` and `/manifest`. All routes require the existing owner session. A different owner sees 404 for an ID. Mutations retain the normal Origin check and rate limit. Binary PUT bypasses the generic JSON body limit only at this path and enforces an exact part size of at most `4 MiB + 40 bytes`. Request bodies use explicit byte bounds and a 60-second read deadline; compressed transport is rejected. The API admits at most four expensive transfers globally, two per owner, and one manifest commit globally; saturation returns 429. A download that is never consumed releases its slot after 60 seconds.

An interrupted upload retains completed immutable parts. A restarted owner can repeat `saveLargeCystFile` with the exact ID, key, scope, and unchanged source: it authenticates existing parts and uploads only missing ones. A different byte sequence cannot replace a completed part. `commit` verifies every part length and SHA-256 digest before publishing the canonical HMAC-authenticated manifest. Restore checks the owner/agent/schema scope, key commitment, manifest MAC, each digest and AEAD tag, then the whole-file MAC. It writes to a private temporary file and publishes the destination with a no-overwrite hard link only after full validation. Incomplete or tampered checkpoints are not restored.

The existing `wrapCystRecoveryKey` helper can wrap this 32-byte key to the owner and agent X25519 public keys under the checkpoint ID. The owner can now pass the **same durably saved** bundle, its X25519 identity and the reviewed agent public key to `saveLargeCystFile`. Before the first upload the writer proves the owner wrap decrypts to the exact recovery key and checks recipient scope and agent public key. The owner cannot decrypt the agent wrap, so `checkedLargeCystCommitPlan` additionally requires the actual agent identity and verifies its wrap against the recovery key before returning signable publication calldata. The optional bundle is stored inside the immutable, owner-MACed manifest and therefore included in its registry hash and opaque storage reference. A retry must pass the same bundle; generating a fresh randomized wrap for the same checkpoint after an uncertain commit conflicts instead of silently changing the registry commitment. Existing checkpoints without a bundle still parse and restore with a separately retained raw key.

## Operator setup and recovery

The large endpoint is disabled by default. Set `CYSTS_ENABLED=true` with the existing small-Cyst storage configuration, then set `CYSTS_LARGE_DIR`, `CYSTS_LARGE_GLOBAL_BYTES`, and `CYSTS_LARGE_OWNER_BYTES`. Both byte caps are mandatory; the owner cap may not exceed the global cap. Use a distinct private directory tree for the large store. Example:

```text
CYSTS_ENABLED=true
CYSTS_DIR=/private/cysts-small
CYSTS_LARGE_DIR=/private/cysts-large
CYSTS_LARGE_GLOBAL_BYTES=21474836480
CYSTS_LARGE_OWNER_BYTES=4294967296
```

The directory must already exist. On POSIX, directories require mode 0700 and files mode 0600, owned by the service UID; path symlinks and file hard links are refused. On Windows, provision a private ACL for the service account because POSIX mode bits do not enforce Windows ACLs. Quotas count checkpoint headers, parts, manifests, per-checkpoint remote intents or commit markers and restart-left `.tmp-*` ciphertext files; the fixed root topology marker is separate metadata. The implementation also limits each owner to 32 checkpoint IDs and the directory to 4096 IDs. It does not garbage-collect old checkpoints: an operator must plan retention, backup, and offline deletion before production use.

To enable the optional two-S3-destination mode, additionally set `CYSTS_LARGE_REPLICATION_CONFIG` to an operator-owned JSON file and `CYSTS_LARGE_REPLICATION_CONFIG_SHA256` to `0x` followed by the lowercase SHA-256 of that file's exact bytes. The file must be a regular, non-symlink file of at most 32 KiB; on POSIX its mode must exclude group/other access. It has this strict shape:

```json
{"version":1,"destinations":[{"endpoint":"https://primary.example","bucket":"telomere-large-primary","region":"us-east-1","failureDomain":"primary-region","reviewed":true,"credentials":{"accessKeyId":"REPLACE_WITH_PRIVATE_ACCESS_KEY","secretAccessKey":"REPLACE_WITH_PRIVATE_SECRET_KEY"}},{"endpoint":"https://secondary.example","bucket":"telomere-large-secondary","region":"eu-west-1","failureDomain":"secondary-region","reviewed":true,"credentials":{"accessKeyId":"REPLACE_WITH_PRIVATE_ACCESS_KEY","secretAccessKey":"REPLACE_WITH_PRIVATE_SECRET_KEY"}}]}
```

The endpoint origins, region names and failure-domain labels must differ. Testnet mode rejects insecure loopback HTTP. Keep the file out of source control and backups visible to application users. Changing credentials requires repinning the exact file bytes; changing a destination or the local quota directory fails the stored topology binding. A nonempty legacy local directory cannot be switched to remote mode automatically. A remote-bound directory cannot silently fall back to local mode. Review physical provider/region independence and perform offline migration before changing storage topology.

One writer process owns the directory through an exclusive `.writer.lock`; a second process fails startup. If the writer crashes, inspect `lockStatus()`, verify that the reported PID is absent on the same host, and call `recoverStaleLock(token)` with its exact token before restarting. The method rejects a live PID and mismatched token. Never remove the lock merely because a request failed. The storage root must not be mounted simultaneously by other writers. A crash-left temporary ciphertext file consumes quota until an operator cleans it while the writer is stopped; an abrupt crash during restore can leave a `.cyst-restore-*` **plaintext** temporary file in the private destination directory and needs the same offline cleanup. Keep those destination directories private.

## Two-destination protocol integration

`LargeCystReplicatedStore` implements the same `LargeCystStore` interface used by the authenticated API. It takes two separately initialized stores. Header and part writes are acknowledged only after both destinations read back the exact bytes. A manifest commit is acknowledged only after both stores have every digest-verified part and the identical committed manifest. A failure may leave a partial first copy, but the caller receives an error and may retry with the same ID, key and source. `repair(id)` can complete a partial committed upload after restart; an owner retry can also fill missing parts. `isDurable(id)` checks both complete copies without repair.

For restore, the wrapper serves a part from one copy only when it matches the committed manifest's length and SHA-256 digest. The owner-side restore still checks the manifest MAC, AEAD tag and whole-file MAC before publishing plaintext. The wrapper never overwrites a present corrupt or conflicting immutable object. A confirmed missing object can be repaired from a verified peer; an unreachable destination cannot be treated as missing or as full durability. Operators must investigate and remove a corrupt object offline before repair.

The main server now mounts `LargeCystQuotaShadowStore` when the pinned two-destination config is present. It preserves a full local ciphertext copy for quota accounting and retry and exposes a manifest only after both S3 destinations verify durable. First boot requires both signed S3 probes. After a successful topology binding, a restart during an S3 outage serves previously sealed checkpoints read-only and refuses writes; `/api/config` reports `largeCystsWritable=false`. A restart after both destinations recover restores writes. This is an opt-in code path, not evidence that the configured providers are independent or operational. Production acceptance still needs two approved provider accounts in verified separate failure domains, real outage/restart/restore drills and a 2 GiB performance run. The existing small-Cyst `ReplicatedCystStorage` and S3 adapter retain their 2 MiB ciphertext cap; large parts use the separate reviewed large-object adapter.

This slice does not capture a live overlay or CRIU/CUDA process state, create `zstd` archives, prove replication across two independent S3 regions, broadcast a CystRegistry transaction, or demonstrate a 2 GiB transfer under 20 seconds. The optional wrapped-key manifest and agent ciphertext route still need public wallet and independent-region acceptance. Without the optional pinned S3 configuration the runtime remains a single-host private ciphertext store. Neither mode is full M5 acceptance yet.

`tests/large-cyst-checkpoints.test.ts` covers real multi-part files, restart/retry, mutation/tamper, wrong key/scope, key-wrap restoration, storage privacy, quotas, locking, and an over-limit sparse file. `tests/large-cyst-http.test.ts` exercises an actual Node HTTP server and owner session, binary transfer/restore, authorization and Origin checks, body and concurrency limits, and stalled streams.

`tests/large-cyst-replication.test.ts` covers two-destination write acknowledgment, partial commit and part-write repair after restart, digest-verified degraded restore, refusal to overwrite corrupt data, unknown destination outages, and an actual owner-authenticated HTTP upload that rejects an unreplicated commit. These fixtures use two directories on one test host; they validate protocol behavior, not independent-region durability.

Run the three focused suites with `npx vitest run tests/large-cyst-checkpoints.test.ts tests/large-cyst-http.test.ts tests/large-cyst-replication.test.ts`.

On 13 October, the exact committed `4a4165d` source archive ran in an isolated temporary directory on the private Linux VPS using its existing Node 22 runtime and dependencies. Both suites passed **16/16**, including the two POSIX permission tests skipped on Windows. The temporary copy was removed after the run; staging services and data were untouched. This validates local Linux file and HTTP behavior, not independent-region durability or the 2 GiB/<20s performance target.

The later `8460723` archive also passed a full build and **48/48** Linux S3/config/quota/checkpoint tests in a fresh private directory. It exercised the POSIX branches of the new two-destination factory and crash-safe local shadow. The copied source matched its archive, existing services stayed ready, and the temporary directory was removed. See `large-cyst-linux-validation.json`; these signed loopback fixtures still do not prove external-region durability or the 2 GiB/<20s target.
