# Encrypted owner checkpoint file vault

`CystCheckpointFileVault` is the Node-only durable storage implementation for `CystCheckpointCoordinator`. It retains checkpoint scheduling state, the complete original encrypted Cyst envelope and its recovery key on an owner-controlled local filesystem. It uses AES-256-GCM with a fresh random 96-bit nonce for each write. Authenticated data binds the format version, owner, agent, application schema, record kind and, for checkpoint records, operation ID.

Import this module directly from `src/sdk/cyst-checkpoints-file-vault.js`, or the corresponding compiled `dist/src/sdk` path. It is deliberately absent from the browser SDK entry point.

```typescript
import { CystCheckpointCoordinator } from '../src/sdk/index.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';

// The embedding application obtains this owning 32-byte key from its key store.
// The directory is absolute; its parent already exists.
const vault = new CystCheckpointFileVault({
  directory: privateCheckpointDirectory,
  masterKey: callerMasterKey,
  acquireTimeoutMs: 5000,
  maxRecordsPerScope: 512,
});
const checkpoints = new CystCheckpointCoordinator({
  owner,
  agent,
  applicationSchema: 'counter.v1',
  cysts: ownerAuthenticatedCystClient,
  vault,
  onCyst: async ({ operationId }) => captureApplicationState(operationId),
});

await checkpoints.tick();
await checkpoints.snapshot('owner_request');
const restoredBytes = await checkpoints.restoreLatest();
// Stop scheduler/coordinator work and await its operations before clearing the key.
vault.close();
```

The caller supplies and backs up the master key. The vault copies it at construction and clears that owning copy on `close()`. It does not write the master key to disk, log keys or paths, send recovery keys to the API, sign transactions or contact a public chain. Losing the master key prevents recovery from the encrypted files. JavaScript and the operating system do not guarantee complete secure memory erasure. Key provisioning, rotation, backup and application validation of restored bytes belong to the embedding application.

## Durability and exact retry

Every `exclusive(scope, callback)` operation obtains the same filesystem lock for the exact owner/agent/application-schema tuple. The lock covers the whole callback, including a coordinator's upload. Each journal write becomes durable separately; a later callback failure does not roll back completed writes.

Files are written privately with exclusive creation, synced, renamed atomically, and read back. On POSIX, the containing directory is also synced, including newly created vault/scope directory entries. Reads check the named file and opened descriptor before and after reading. Files must be regular, singly linked and bounded; symlinks, changed file identities and unsafe POSIX permissions fail closed. An encrypted identity marker rejects a wrong master key before the application callback can overwrite existing state.

Checkpoint records are immutable and idempotent by operation ID. Repeating the same operation accepts only the full original envelope and the same recovery key; a different record fails. Returned objects and key arrays are independent copies. The saved key is authenticated against the Cyst ciphertext. A completed state pointer must resolve to an intact record matching the original full header and digest. Missing, corrupt or substituted records prevent further use of that scope.

The coordinator saves its pending operation before capture and the original envelope/key before upload. Reopening this vault after an uncertain upload reuses the exact original idempotency key, checkpoint ID, nonce and ciphertext. Restore downloads the original owner-scoped envelope and compares it before local decryption. The vault itself performs no network calls. Scope labels in local files do not grant API authorization; the Cyst client still requires the owner's authenticated session.

State plaintext is bounded to 8192 bytes. Application checkpoints retain the existing 2 MiB maximum. The default per-scope record limit is 512, configurable from 1 through 4096; lock acquisition is bounded to 10–60000 ms. With only the default 15-minute periodic captures, 512 records cover 128 hours (5 days 8 hours); additional explicit captures consume capacity sooner. No automatic record deletion or retention process runs. Reaching the record limit fails before writing another recovery record. Before continuous operation, owners must choose an appropriate bound and arrange a separate reviewed retention/backup policy that preserves every live completed/pending record and the keys required by their recovery policy. Raising this local bound does not change the Cyst API's own storage quotas. The current vault API provides no prune or garbage-collection operation.

## Process locks and explicit crash recovery

Independent Node processes serialize through exclusive filesystem creation of `exclusive.lock`; no process-local mutex is relied upon. Acquisition never steals a lock based on age. Lock metadata is encrypted and authenticated, and release verifies its own random token and file identity before deletion.

A process crash can leave the lock behind. Inspect it with `lockStatus(scope)`, then explicitly call `recoverStaleLock(scope, observed.lockId)` only when recovery is appropriate. The API removes a stale lock only when its authenticated owner belongs to the same Linux boot **and PID namespace**, and `kill(pid, 0)` establishes that the process no longer exists. A live or reused PID, permission error, other namespace/boot, unsupported platform or unavailable process evidence prevents recovery. The returned `sameLinuxBoot` flag includes the PID namespace check. The exact observed token and file identity are checked again before removal.

Concurrent recovery attempts also serialize through a separate `recovery.lock`. A crash during recovery, incomplete lock creation, corrupted lock or a lock from another boot cannot be repaired automatically. These cases require the filesystem owner to stop all participating processes, inspect the private directory and perform an explicit administrative repair. The library supplies no force-unlock function and never removes an unknown lock. A crash during a file write may leave an encrypted private temporary file; it is retained for administrative diagnosis rather than deleted by another process on an assumption.

## Filesystem and platform boundaries

Use a local filesystem with reliable exclusive creation, atomic rename and fsync semantics. Every participating process must use the same directory and key, and the filesystem owner must control directory ancestors. Existing POSIX vault directories must belong to the effective user with mode `0700`; files must have owner read/write access and no group/other access. The implementation refuses unsafe entries instead of silently repairing permissions. It does not establish distributed filesystem locking, protect against an administrator or malicious filesystem owner, or make guarantees for NFS/network shares.

Windows uses exclusive creation, file sync, atomic replacement and file identity/link checks, but Node's POSIX mode/UID tests do not establish Windows ACL privacy. The caller must provision private Windows ACLs. Directory fsync and automatic stale-process recovery are unavailable on Windows. The frozen file-vault suite passed all 14 cases on isolated Linux, exercising POSIX permissions, directory syncing, foreign boot/PID-namespace refusal and proven-dead explicit recovery. It ran within a 247-case focused acceptance; the validation record distinguishes that run from the Windows 12 passed plus 2 skipped cases.

Authenticated encryption detects corruption and scope/operation substitution. It does **not** detect replay of an entire older, valid vault snapshot by the filesystem owner. There is no external monotonic anchor or filesystem anti-rollback guarantee. Encrypted files still reveal file sizes, record counts, random operation IDs and access timing.

This stores bounded application checkpoints. It does not snapshot a Cell's filesystem/process/GPU state, stop or resume a Cell, register a Cyst onchain, migrate execution, replicate across independent regions or release keys to an attested enclave. See `cyst-checkpoints.md` for coordinator behavior and `cyst-checkpoints-file-vault-validation.json` for the dated acceptance scope.
