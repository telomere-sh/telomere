# Declared application directories in Cysts

This M5 slice captures a deliberately selected application data directory into one bounded file and restores its files and empty directories inside a paid CPU Cell. It composes with the existing encrypted Large Cyst and [paid application-file transport](paid-cyst-input-v1.md). Existing routes, wallet funding, signed paid-session descriptors and settlement rules are unchanged.

The capture/restore helpers, manifest/path schemas, `DeclaredStateManifest`, `DECLARED_STATE_MAX_BYTES` and `DECLARED_STATE_CELL_DIRECTORY` are exported through `src/sdk/index.ts`. These are Node APIs; they do not introduce a filesystem upload endpoint or automatically choose which directories contain an agent's state.

## API and source privacy

Quiesce the application's writers before capture. The source must be an absolute, explicitly declared directory. On POSIX, the source and destination's immediate parent must be private, owned `0700` directories; ancestor paths cannot be symbolic links. Only owned regular, non-executable data files with a single hard link are admitted. Symbolic links, hard links, devices, sockets and executable files are refused. File ownership, permissions, executable metadata and process memory are not serialized.

```ts
const bundle = await captureDeclaredStateBundle({
  sourceDirectory: "/private/agent-state",
  destinationPath: "/private/cyst-staging/state.bin",
  maxBytes: 8 * 1024 * 1024,
  signal,
});
// bundle: { path, bytes, sha256, manifest }
```

The destination must be outside the source tree and must not exist. Capture walks a finite set of entries, records their identities, hashes every file, then verifies those hashes again while streaming the output. It rechecks file/directory metadata before publication. This detects observed source changes; the caller must still quiesce the application. It is not an atomic snapshot of a live directory or a database-consistency mechanism.

The output is a **plaintext** application bundle. Capture writes an exclusive private `0600` staging file, handles partial writes, syncs it and publishes without replacing an existing destination. Scratch plaintext buffers are cleared. A final cancellation check also runs after the publication directory's `fsync`; late cancellation refuses success and removes only the archive inode created by that invocation. Unknown or replaced paths are left for explicit recovery rather than deleted.

Encrypt the returned file through the existing Large Cyst pipeline before storage or transmission. The packer does not itself encrypt, publish a registry commitment or retain a key. Paths, names and file hashes in its manifest are application metadata and are protected only by that outer encryption. Ordinary unsealed paid CPU hosts can observe the deliberately supplied plaintext input and running application; this feature makes no sealed-host confidentiality claim.

## Bounds and wire format

| Item | Bound |
| --- | --- |
| Complete bundle, including header and manifest | 8 MiB; the caller may request a smaller capture limit |
| Regular files | 128 |
| Declared directories, including empty ones | 128 |
| UTF-8 manifest | 64 KiB |
| Relative path | 240 characters, at most 16 components, each at most 64 characters |
| Streaming file buffer | 64 KiB |

Paths use portable ASCII components containing letters, digits, `_`, `-` and `.`. Absolute paths, traversal, backslashes, reserved Windows names, trailing dots, case aliases and the reserved restore-receipt name are rejected. Every parent directory must be declared. Directory and file lists have strict lexical order, and declared file sizes must sum exactly to `payloadBytes`.

The `telomere-declared-state-v1` format is:

1. Eight ASCII bytes `TLMRDS1\n`.
2. A four-byte unsigned little-endian manifest length.
3. The exact canonical UTF-8 JSON manifest, with fields `protocol`, `directories`, `files` and `payloadBytes`.
4. Raw file bytes concatenated in manifest file order. Each file entry contains its relative `path`, integer `bytes` and lowercase hexadecimal SHA-256.

There is no compression or executable archive metadata inside this format. Decoding parses the strict schema and requires byte-for-byte equality with its canonical re-encoding, so alternate/ambiguous JSON encodings are refused. Per-file hashes and an independently expected complete-bundle hash are checked before a restore can succeed.

## Restore and completion

```ts
const restored = await restoreDeclaredStateBundle({
  bundlePath: "/private/cyst-staging/state.bin",
  destinationDirectory: "/private/application/restored-operation-1",
  expectedBytes: bundle.bytes,
  expectedSha256: bundle.sha256,
  signal,
});
// restored: { directory, manifest, bytes, sha256 }
```

For recovery, obtain `expectedBytes` and `expectedSha256` from the independently authenticated current Cyst/paid-input descriptor. Reading a hash from an untrusted bundle is not authentication. Source and destination paths are absolute; the destination's parent must be private and its ancestor identities must remain intact. The input must be a bounded regular file with reviewed read-only/private permissions.

The restorer first verifies data in an owned private staging tree. It then claims a **fresh** destination with exclusive `mkdir`, links only its verified regular files into that tree, verifies the exact final names, sizes and hashes, and syncs the files/directories. It writes `.telomere-declared-state.json` last, containing `protocol:"telomere-declared-state-restore-v1"`, `status:"complete"`, bundle length/hash and the manifest.

This is not an atomic directory rename. The application must wait for the successful restore result and completion receipt before using the destination. An existing destination always causes refusal, including an empty directory or a directory from an interrupted attempt. Failure cleanup removes only recorded inodes while their ancestor identities and known link counts still match. Unknown entries remain private and require reconciliation; where possible, an exclusively created `status:"failed"` marker makes an uncertain claimed destination explicit. No recursive deletion of foreign files or automatic overwrite is used.

The completion receipt establishes this local operation's result. It does not establish that an on-chain Cyst is still current at a later time; the existing current-Cyst coordinator retains those canonical read and revision checks.

## Paid Cell hook and image

`scripts/declared-state-cell.ts` is a bounded Cell-side CLI adapter for `AgentCurrentCystPaidFileRestore`. Bundle it with the locked toolchain as `declared-state-cell.cjs`, and include it at `/opt/telomere/declared-state-cell.cjs` in an independently reviewed CPU image. The fixed argv suffix is:

```text
agentId targetRunId checkpointId revision operationId plaintextSha256 /run/telomere-cyst/state.bin
```

The CLI accepts at most 4 KiB of strict JSON on stdin containing the existing `telomere-agent-current-cyst-file-restore-v1` receipt. It matches every receipt field against the argv scope and the exact input length/hash, restores only to `/tmp/telomere-declared-state/<operationId>`, and prints only that receipt after success. SIGTERM, SIGINT and its fifteen-second deadline cancel the operation. There is no selectable extraction destination, recovery key or arbitrary archive command in the CLI input.

Use the existing coordinator with:

```ts
restoreArgvPrefix: ["/usr/local/bin/node", "/opt/telomere/declared-state-cell.cjs"]
```

The bundle is supplied through the existing authenticated binary upload and fixed read-only paid-input mount. The application command journal contains only the small receipt and operation arguments, not the bundle's file contents. The original signed image digest, Cyst descriptor, revision, Vault/run and deterministic command identity remain authoritative. Lost command responses are recovered through the existing HostKit command journal; they do not authorize another extraction, payment or operation ID. Calling the CLI directly again against an existing destination is refused.

`infra/host-kit/Dockerfile.declared-state` deliberately uses classic-builder-compatible `COPY --chown=0:0`. Its tracked comment requires the reviewed builder to seal **only the newly validated build-context CJS files to mode `0444` before COPY**. COPY preserves that mode, making the root-owned hooks readable by the non-root Cell despite a private `umask 077` build context. Do not apply broad permission changes to the source tree, existing images or host state. The extension image must be identified by its actual manifest digest and explicitly reviewed before admission.

## Small Cell checkpoint output

`captureDeclaredStateCheckpoint` adapts a declared directory to the existing `telomere-paid-app-checkpoint-v1` output. The **whole bundle is limited to 4,096 bytes**, including its manifest. This fits the existing owner Lifeline/handoff bound; it does not increase the paid command's output, argv or stdin limits. The programmatic helper accepts private absolute `sourceDirectory` and `scratchDirectory`, the exact `sourceRunId`, `operationId` and optional abort signal. It returns the existing run/operation-bound JSON with `stateBase64`.

The reviewed `scripts/declared-state-cell-capture.ts` executable takes only the existing two run/operation arguments. Its source is fixed to `/tmp/telomere-declared-application` and its private scratch parent to `/tmp/telomere-declared-capture`. The application must quiesce its writers. A restore root containing `.telomere-declared-state.json` is refused by the existing manifest rules; the application must deliberately select its data rather than capture that receipt as application state.

Build the capture CLI separately as `declared-state-cell-capture.cjs`, include it through the tracked extension Dockerfile, and configure the existing `PaidSessionCheckpointRunner` with `["/usr/local/bin/node", "/opt/telomere/declared-state-cell-capture.cjs"]` and `maxBytes: 4096`. Its deterministic paid command ID owns lost-response replay: the original output can be recovered after the application changes or the source session stops. A fresh direct invocation of the CLI is a fresh capture, and is not an independent idempotency authority.

Before successful output the helper authenticates its complete bundle, clears its mutable buffer, overwrites/fsyncs its exact owned scratch inode, rechecks identities after closing it and removes only that owned file/directory. Replaced or unprovable identities cause refusal and may retain private residue for reconciliation. This is not a promise of mandatory erasure on every failure or physical disk erasure. Plaintext stdout remains part of the existing ordinary paid-command output/history contract; this hook does not establish sealed execution.

## Acceptance boundary and remaining M5 work

Local capture/restore tests cover deterministic nested data, empty files/directories, canonical hashes, existing-destination refusal, invalid paths and integrity/cleanup failures. POSIX-only checks cover links, executable data and cancellation during final directory sync. Windows results do not establish POSIX permission or sandbox behavior.

The optional paid integration case uses `TELOMERE_ACCEPTANCE_DECLARED_STATE_CELL=1` together with an explicitly isolated Linux gVisor socket and the reviewed extension image. It carries an encrypted multipart Cyst containing several files and an empty directory through real local Vault funding, paid input upload, the Cell hook, application mutation and receipted settlement. It is an isolated acceptance profile, not an instruction to change an existing staging or production host. Existing file-input enablement, quotas, transport routes and wallet-last behavior remain unchanged.

The [corrected actual Linux/gVisor cohort](evidence/backend-completion-linux-20261015/completion-gvisor-acceptance.json) completed **167/167 checks in 15 complete files, no failures or skips**, on test revision `36d8a7f` and the independently built d448 image `127.0.0.1:15004/telomere-declared-state@sha256:db091765b34bac310fa2fa6284d59abe97f294e5d2a800946c38f46e46f31eea`. Both current-file and declared-directory paid restore cases ran, as did the small checkpoint capture/lost-response replay case. The latter uses synthetic admission references in a signed HostLease and an owner-private restore destination; it does not independently establish canonical Vault/CystRegistry funding or a second target Cell. Original and corrected 708-file source inventories, dependencies and compiled runtime stayed identical before/after. See the [completion record](backend-completion-2026-10-15.md) for separate source cutoffs, retained initial fixture failures and cleanup; no full latest-source suite or hardware-attested restore is inferred from this cohort.

This slice does not complete the original full writable-root/overlay-diff snapshot, zstd tar format, CRIU/CUDA process recovery, arbitrary 2-GiB state, under-twenty-second recovery target, independent two-region object-storage operation or physical-host-loss recovery. It does not add automatic checkpoint triggers, long-lived autonomous Lifeline renewal or real sealed-Cell key release. Those remain distinct original M5/infrastructure requirements; a successful bounded application-directory restore must not be reported as their acceptance.
