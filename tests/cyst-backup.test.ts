import { createHash } from 'node:crypto';
import { appendFile, chmod, link, lstat, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cystOwners, cysts } from '../src/cysts/schema.js';
import { CystService } from '../src/cysts/service.js';
import { cystQuotaPolicySchema } from '../src/cysts/quota-types.js';
import { CYST_CAPABILITIES } from '../src/cysts/types.js';
import { CYST_BACKUP_LIMITS, backupManifestSchema, captureCystSnapshot, createBackupDirectory, cystSnapshotFileName,
  finishBackup, hashBackupFile, readBackupCystQuotaPolicy, readCystSnapshot, restoreCystSnapshot, validateCystReferences, verifyBackup,
  verifyRestoredCysts, type CystBackupReference, type CystSnapshot } from '../src/operator/backup.js';
import { decryptCheckpoint, encryptCheckpoint, exportCystRecoveryKey } from '../src/sdk/cysts.js';
import { openStore } from '../src/store.js';

const owner = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const agent = '0x3333333333333333333333333333333333333333';
const plaintext = new TextEncoder().encode('{"counter":42,"memory":"client-private-backup-sentinel"}');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const profile = (enabled: boolean, directory: string) => [
  'MODE=demo', 'CHAIN_ID=31337', 'RPC_URL=http://127.0.0.1:18547',
  'SIGNER_PRIVATE_KEY=0x' + '11'.repeat(32), 'DEMO_PRIVATE_KEY=0x' + '22'.repeat(32),
  'ESCROW_ADDRESS=0x3333333333333333333333333333333333333333', 'TOKEN_ADDRESS=0x4444444444444444444444444444444444444444',
  'DATABASE_URL=postgresql://telomere:private-fixture@127.0.0.1:15434/telomere', 'PUBLIC_ORIGIN=http://127.0.0.1:3281',
  ...(enabled ? ['CYSTS_ENABLED=true', 'CYSTS_DIR=' + directory] : []),
].join('\n') + '\n';

// Intercept real descriptor operations to place a filesystem mutation precisely
// after checked metadata; production has no test hooks or alternate I/O path.
const fileRace = vi.hoisted(() => ({ opened: undefined as ((path: string, handle: FileHandle) => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    await fileRace.opened?.(String(args[0]), handle);
    return handle;
  } };
});

describe('bounded private Cyst backup and relocation', () => {
  const roots: string[] = [];
  const stores: Awaited<ReturnType<typeof openStore>>[] = [];
  afterEach(async () => {
    fileRace.opened = undefined;
    vi.restoreAllMocks();
    for (const store of stores.splice(0)) await store.close();
    for (const root of roots.splice(0)) {
      // Recursive cleanup is restricted to this test's explicitly created temporary directory.
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('telomere-cyst-backup-')) throw new Error('Unsafe test cleanup');
      await rm(root, { recursive: true, force: true });
    }
  });
  async function fixture(enabled = true) {
    const root = await mkdtemp(join(tmpdir(), 'telomere-cyst-backup-')); roots.push(root);
    const directory = await createBackupDirectory(join(root, '.local', 'backups', 'source'));
    const store = await openStore({ DATA_DIR: ':memory:' }); stores.push(store);
    const service = new CystService(store.db, join(root, 'original-ciphertexts')); await service.initialize();
    await writeFile(join(directory, 'database.dump'), 'PGDMPoperator-format-fixture', { mode: 0o600 });
    await writeFile(join(directory, 'chain.json'), JSON.stringify({ block: { number: 1 }, accounts: {} }), { mode: 0o600 });
    await writeFile(join(directory, 'profile.env'), profile(enabled, service.privateDirectory), { mode: 0o600 });
    return { root, directory, store, service, snapshotPath: join(directory, cystSnapshotFileName) };
  }
  async function references(store: Awaited<ReturnType<typeof openStore>>): Promise<CystBackupReference[]> {
    return store.db.select({ owner: cysts.owner, id: cysts.id, sha256: cysts.sha256,
      ciphertextBytes: cysts.ciphertextBytes, state: cysts.state }).from(cysts);
  }
  async function cloneMetadata(source: Awaited<ReturnType<typeof openStore>>) {
    const restored = await openStore({ DATA_DIR: ':memory:' }); stores.push(restored);
    const owners = await source.db.select().from(cystOwners), records = await source.db.select().from(cysts);
    if (owners.length) await restored.db.insert(cystOwners).values(owners);
    if (records.length) await restored.db.insert(cysts).values(records);
    return restored;
  }
  async function upload(service: CystService, tenant = owner, key = 'checkpoint-backup-1') {
    const encrypted = await encryptCheckpoint(plaintext, { owner: tenant, agent, applicationSchema: 'counter.v1' });
    await service.upload(tenant, encrypted.envelope, key);
    return encrypted;
  }
  async function writeSnapshot(path: string, value: unknown) {
    await writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 });
  }
  function singleBlobSnapshot(): CystSnapshot {
    const bytes = Buffer.alloc(17, 0);
    return { schemaVersion: 1, kind: 'private_cyst_ciphertexts', ciphertextBytes: bytes.byteLength,
      blobs: [{ name: 'aa'.repeat(32) + '.blob', bytes: bytes.byteLength, sha256: digest(bytes), ciphertext: bytes.toString('base64') }] };
  }

  it('keeps historical version 1 backups unchanged when Cysts are disabled', async () => {
    const { directory } = await fixture(false);
    const manifest = await finishBackup(directory);
    expect(manifest.schemaVersion).toBe(1); expect(manifest.files).toHaveLength(3);
    expect(await verifyBackup(directory)).toEqual(manifest);
    expect((await readdir(directory)).includes(cystSnapshotFileName)).toBe(false);
  });

  it('requires the fourth encrypted snapshot before an enabled backup can be finalized', async () => {
    const { directory } = await fixture();
    await expect(finishBackup(directory)).rejects.toThrow();
    await expect(lstat(join(directory, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(directory, 'database.dump'), 'utf8')).toBe('PGDMPoperator-format-fixture');
  });

  it('captures opaque ciphertext, verifies version 2 and restores real encrypted state under new paths', async () => {
    const { root, directory, store, service, snapshotPath } = await fixture();
    const first = await upload(service), second = await upload(service, other, 'checkpoint-backup-2');
    const before = await service.list(owner), beforeOther = await service.list(other);
    const summary = await captureCystSnapshot(service.privateDirectory, snapshotPath, await references(store));
    expect(summary).toMatchObject({ snapshotVersion: 1, blobs: 2, ciphertextBytes: 2 * (plaintext.byteLength + 16) });
    const raw = await readFile(snapshotPath, 'utf8');
    expect(raw).not.toContain(new TextDecoder().decode(plaintext));
    expect(raw).not.toContain(exportCystRecoveryKey(first.recoveryKey));
    expect(raw).not.toContain(exportCystRecoveryKey(second.recoveryKey));
    expect(raw).not.toContain('recoveryKey'); expect(raw).not.toContain('plaintext'); expect(raw).not.toContain(owner);
    const manifest = await finishBackup(directory);
    expect(manifest.schemaVersion).toBe(2); expect(manifest.files).toHaveLength(4);
    expect(await verifyBackup(directory)).toEqual(manifest);
    const entry = manifest.files.find(file => file.name === cystSnapshotFileName);
    if (!entry) throw new Error('Missing snapshot entry');
    const restoredDirectory = join(root, '.local', 'restore', 'relocated-ciphertexts');
    expect(await restoreCystSnapshot(snapshotPath, restoredDirectory, entry)).toEqual(summary);
    const restoredStore = await cloneMetadata(store);
    const restored = new CystService(restoredStore.db, restoredDirectory); await restored.initialize();
    expect(restored.privateDirectory).not.toBe(service.privateDirectory);
    expect(await restored.list(owner)).toEqual(before); expect(await restored.list(other)).toEqual(beforeOther);
    const downloaded = await restored.download(owner, first.envelope.id);
    expect(downloaded.ciphertext).toBe(first.envelope.ciphertext);
    expect(digest(Buffer.from(downloaded.ciphertext, 'base64'))).toBe(first.envelope.sha256);
    await expect(decryptCheckpoint({ ...first.envelope, ciphertext: downloaded.ciphertext }, first.recoveryKey)).resolves.toEqual(plaintext);
    expect((await restored.download(other, second.envelope.id)).ciphertext).toBe(second.envelope.ciphertext);
    expect(validateCystReferences(await readCystSnapshot(snapshotPath), await references(restoredStore))).toEqual({ ready: 2, pending: 0, pendingWithoutBlob: 0 });
  });

  it('refuses a complete backup when a ready database checkpoint has no ciphertext', async () => {
    const { service, store, snapshotPath } = await fixture();
    await upload(service);
    const name = (await readdir(service.privateDirectory))[0];
    if (!name) throw new Error('Missing fixture blob');
    await rm(join(service.privateDirectory, name));
    await expect(captureCystSnapshot(service.privateDirectory, snapshotPath, await references(store))).rejects.toThrow('Ready Cyst ciphertext missing');
    await expect(lstat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves interrupted pending uploads and their quota, allowing only the original retry to finish', async () => {
    const { root, store, service, snapshotPath } = await fixture();
    const encrypted = await encryptCheckpoint(plaintext, { owner, agent, applicationSchema: 'counter.v1' });
    const failure = vi.spyOn(service.storage, 'put').mockRejectedValue(new Error('Injected disk interruption'));
    await expect(service.upload(owner, encrypted.envelope, 'interrupted-upload')).rejects.toThrow('Injected disk interruption');
    failure.mockRestore();
    expect(await captureCystSnapshot(service.privateDirectory, snapshotPath, await references(store))).toMatchObject({ blobs: 0, ciphertextBytes: 0 });
    const snapshot = await readCystSnapshot(snapshotPath);
    expect(validateCystReferences(snapshot, await references(store))).toEqual({ ready: 0, pending: 1, pendingWithoutBlob: 1 });
    const target = join(root, '.local', 'restored-pending'); await restoreCystSnapshot(snapshotPath, target);
    const restoredStore = await cloneMetadata(store), restored = new CystService(restoredStore.db, target); await restored.initialize();
    expect((await restored.list(owner)).checkpoints[0]?.state).toBe('pending');
    await expect(restored.download(owner, encrypted.envelope.id)).rejects.toMatchObject({ code: 'cyst_pending' });
    const beforeUsage = (await restored.list(owner)).usage;
    expect((await restored.upload(owner, encrypted.envelope, 'interrupted-upload')).replayed).toBe(true);
    expect((await restored.list(owner)).usage).toEqual(beforeUsage);
    expect((await restored.download(owner, encrypted.envelope.id)).ciphertext).toBe(encrypted.envelope.ciphertext);
  });

  it('retains a pending blob after interrupted readiness storage and lets CystService recover it', async () => {
    const { root, store, service, snapshotPath } = await fixture();
    const encrypted = await upload(service);
    await store.db.update(cysts).set({ state: 'pending' }).where(and(eq(cysts.owner, owner), eq(cysts.id, encrypted.envelope.id)));
    await captureCystSnapshot(service.privateDirectory, snapshotPath, await references(store));
    expect(validateCystReferences(await readCystSnapshot(snapshotPath), await references(store))).toEqual({ ready: 0, pending: 1, pendingWithoutBlob: 0 });
    const target = join(root, '.local', 'restored-readiness'); await restoreCystSnapshot(snapshotPath, target);
    const restoredStore = await cloneMetadata(store), restored = new CystService(restoredStore.db, target); await restored.initialize();
    const quota = (await restored.list(owner)).usage;
    expect((await restored.download(owner, encrypted.envelope.id)).ciphertext).toBe(encrypted.envelope.ciphertext);
    expect((await restored.list(owner)).checkpoints[0]?.state).toBe('ready');
    expect((await restored.list(owner)).usage).toEqual(quota);
  });

  it('proves recoverable and missing pending checkpoints in a real read-only transaction without promotions', async () => {
    const { root, store, service, snapshotPath } = await fixture();
    const complete = await upload(service);
    await store.db.update(cysts).set({ state: 'pending' }).where(and(eq(cysts.owner, owner), eq(cysts.id, complete.envelope.id)));
    const interrupted = await encryptCheckpoint(plaintext, { owner, agent, applicationSchema: 'counter.v1' });
    const failure = vi.spyOn(service.storage, 'put').mockRejectedValue(new Error('Interrupted before ciphertext write'));
    await expect(service.upload(owner, interrupted.envelope, 'readonly-missing-pending')).rejects.toThrow(); failure.mockRestore();
    await upload(service, other, 'readonly-ready-other');
    await captureCystSnapshot(service.privateDirectory, snapshotPath, await references(store));
    const snapshot = await readCystSnapshot(snapshotPath), target = join(root, '.local', 'readonly-restored');
    await restoreCystSnapshot(snapshotPath, target);
    const restored = await cloneMetadata(store);
    const rowsBefore = await restored.db.select().from(cysts).orderBy(cysts.owner, cysts.id);
    const quotaBefore = await restored.db.select().from(cystOwners).orderBy(cystOwners.owner);
    const proof = await restored.db.transaction(transaction => verifyRestoredCysts(transaction, target, snapshot),
      { accessMode: 'read only', isolationLevel: 'repeatable read' });
    expect(proof).toMatchObject({ readyCheckpoints: 1, pendingCheckpoints: 2, pendingWithoutBlob: 1,
      recoverablePending: 1, pendingStatePreserved: true, metadataMatches: true,
      serviceListOwnersVerified: 1, pendingOwnerListsDeferred: 1, downloadHashesMatch: true });
    expect(await restored.db.select().from(cysts).orderBy(cysts.owner, cysts.id)).toEqual(rowsBefore);
    expect(await restored.db.select().from(cystOwners).orderBy(cystOwners.owner)).toEqual(quotaBefore);
  });

  it('verifies 513 restored encrypted checkpoints under explicit quota2 in read-only SQL without schema or metadata changes', async () => {
    const { root, store, service: legacyService, snapshotPath } = await fixture();
    const quotaPolicy = cystQuotaPolicySchema.parse({ version: 2, kind: 'telomere-cyst-quota-v2',
      maxOwnerCheckpoints: 4096, maxOwnerBytes: 33554432 });
    const service = new CystService(store.db, legacyService.privateDirectory, { quotaPolicy }); await service.initialize();
    const encrypted: Awaited<ReturnType<typeof encryptCheckpoint>>[] = [];
    try {
      for (let index = 0; index < 513; index++) {
        const checkpoint = await encryptCheckpoint(Buffer.from(JSON.stringify({ index })), { owner, agent, applicationSchema: 'backup.quota2.v1' });
        encrypted.push(checkpoint); await service.upload(owner, checkpoint.envelope, 'expanded-backup-' + index, 2);
      }
      await captureCystSnapshot(service.privateDirectory, snapshotPath, await references(store));
      const snapshot = await readCystSnapshot(snapshotPath), target = join(root, '.local', 'readonly-quota2-restored');
      await restoreCystSnapshot(snapshotPath, target);
      const restored = await openStore({ DATA_DIR: ':memory:' }); stores.push(restored);
      // The fixture restores its already enabled schema before verification.
      // No migration may be attempted by verifyRestoredCysts in its read-only transaction.
      await new CystService(restored.db, target, { quotaPolicy }).initialize();
      await restored.db.insert(cystOwners).values(await store.db.select().from(cystOwners));
      await restored.db.insert(cysts).values(await store.db.select().from(cysts));
      const schemaBefore = await restored.db.execute(sql`SELECT conname,pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid='cyst_owners'::regclass ORDER BY conname`);
      const rowsBefore = await restored.db.select().from(cysts).orderBy(cysts.owner, cysts.id);
      const usageBefore = await restored.db.select().from(cystOwners);
      const verify = (options: Parameters<typeof verifyRestoredCysts>[3] = {}) => restored.db.transaction(
        transaction => verifyRestoredCysts(transaction, target, snapshot, options),
        { accessMode: 'read only', isolationLevel: 'repeatable read' });
      await expect(verify()).rejects.toThrow('exceeds the reviewed profile');
      await expect(verify({ quotaPolicy: JSON.parse(JSON.stringify({ ...quotaPolicy, maxOwnerCheckpoints: 8192 })) }))
        .rejects.toThrow();
      expect(await verify({ quotaPolicy })).toMatchObject({ readyCheckpoints: 513, serviceListOwnersVerified: 1,
        pendingOwnerListsDeferred: 0, downloadHashesMatch: true, quotaVersion: 2, maxOwnerCheckpoints: 4096, maxOwnerBytes: 33554432 });
      expect(await restored.db.select().from(cysts).orderBy(cysts.owner, cysts.id)).toEqual(rowsBefore);
      expect(await restored.db.select().from(cystOwners)).toEqual(usageBefore);
      expect(await restored.db.execute(sql`SELECT conname,pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid='cyst_owners'::regclass ORDER BY conname`)).toEqual(schemaBefore);
      for (const index of [0, 512]) {
        const checkpoint = encrypted[index]; if (!checkpoint) throw new Error('Missing restored fixture checkpoint');
        const downloaded = new CystService(restored.db, target, { quotaPolicy });
        await downloaded.storage.initialize();
        const result = await downloaded.download(owner, checkpoint.envelope.id);
        expect(JSON.parse(Buffer.from(await decryptCheckpoint({ ...checkpoint.envelope, ciphertext: result.ciphertext }, checkpoint.recoveryKey)).toString())).toEqual({ index });
      }
      // A deferred pending owner must not bypass the default 512 cap.
      await restored.db.update(cysts).set({ state: 'pending' });
      await expect(verify()).rejects.toThrow('exceeds the reviewed profile');
      expect(await verify({ quotaPolicy })).toMatchObject({ readyCheckpoints: 0, pendingCheckpoints: 513,
        recoverablePending: 513, pendingOwnerListsDeferred: 1, pendingStatePreserved: true });
      expect((await restored.db.select().from(cysts)).every(row => row.state === 'pending')).toBe(true);
    } finally { for (const checkpoint of encrypted) checkpoint.recoveryKey.fill(0); }
  }, 90_000);

  it('accepts the external private quota policy only with both reviewed configuration pins', async () => {
    const { directory } = await fixture(), policyPath = join(directory, 'quota-policy.json');
    const policy = { version: 2, kind: 'telomere-cyst-quota-v2', maxOwnerCheckpoints: 4096, maxOwnerBytes: 33554432 };
    const bytes = Buffer.from(JSON.stringify(policy)); await writeFile(policyPath, bytes, { mode: 0o600 });
    expect(await readBackupCystQuotaPolicy({ CYSTS_ENABLED: true, CYSTS_QUOTA_POLICY_PATH: policyPath,
      CYSTS_QUOTA_POLICY_SHA256: digest(bytes) })).toEqual(policy);
    expect(await readBackupCystQuotaPolicy({ CYSTS_ENABLED: true })).toBeUndefined();
    await expect(readBackupCystQuotaPolicy({ CYSTS_ENABLED: true, CYSTS_QUOTA_POLICY_PATH: policyPath })).rejects.toThrow('both reviewed pins');
    await expect(readBackupCystQuotaPolicy({ CYSTS_ENABLED: true, CYSTS_QUOTA_POLICY_PATH: policyPath,
      CYSTS_QUOTA_POLICY_SHA256: '0'.repeat(64) })).rejects.toThrow('reviewed hash');
    await expect(readBackupCystQuotaPolicy({ CYSTS_ENABLED: false, CYSTS_QUOTA_POLICY_PATH: policyPath,
      CYSTS_QUOTA_POLICY_SHA256: digest(bytes) })).rejects.toThrow('both reviewed pins');
    await writeFile(policyPath, JSON.stringify({ ...policy, maxOwnerBytes: 67108864 }), { mode: 0o600 });
    await expect(readBackupCystQuotaPolicy({ CYSTS_ENABLED: true, CYSTS_QUOTA_POLICY_PATH: policyPath,
      CYSTS_QUOTA_POLICY_SHA256: digest(bytes) })).rejects.toThrow('reviewed hash');
  });

  it('checks tenant-derived names and database lengths instead of accepting an unrelated valid blob', async () => {
    const { store, service, snapshotPath } = await fixture(); await upload(service);
    await captureCystSnapshot(service.privateDirectory, snapshotPath, await references(store));
    const snapshot = await readCystSnapshot(snapshotPath), refs = await references(store), reference = refs[0];
    if (!reference) throw new Error('Missing fixture reference');
    expect(() => validateCystReferences(snapshot, [{ ...reference, owner: other }])).toThrow('Ready Cyst ciphertext missing');
    expect(() => validateCystReferences(snapshot, [{ ...reference, ciphertextBytes: reference.ciphertextBytes + 1 }])).toThrow('metadata and ciphertext mismatch');
    expect(() => validateCystReferences(snapshot, [reference, reference])).toThrow('Duplicate Cyst metadata');
  });

  it.each(['../escape.blob', 'C:\\outside.blob', 'nested/blob', 'KEY.txt'])('rejects unsafe snapshot name %s before creating restore files', async name => {
    const { root, snapshotPath } = await fixture();
    const snapshot = singleBlobSnapshot(); snapshot.blobs[0]!.name = name;
    await writeSnapshot(snapshotPath, snapshot);
    const target = join(root, '.local', 'unsafe-restore');
    await expect(restoreCystSnapshot(snapshotPath, target)).rejects.toThrow();
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects duplicate names, noncanonical base64 and mismatched byte totals', async () => {
    const { snapshotPath } = await fixture();
    const valid = singleBlobSnapshot(), blob = valid.blobs[0]; if (!blob) throw new Error('Missing fixture blob');
    await writeSnapshot(snapshotPath, { ...valid, ciphertextBytes: 34, blobs: [blob, blob] });
    await expect(readCystSnapshot(snapshotPath)).rejects.toThrow('sorted and unique');
    await writeSnapshot(snapshotPath, { ...valid, blobs: [{ ...blob, ciphertext: blob.ciphertext.slice(0, -2) + 'B=' }] });
    await expect(readCystSnapshot(snapshotPath)).rejects.toThrow('checksum');
    await writeSnapshot(snapshotPath, { ...valid, ciphertextBytes: 18 });
    await expect(readCystSnapshot(snapshotPath)).rejects.toThrow('byte count mismatch');
  });

  it('checks inner ciphertext digests even when a changed outer snapshot checksum is supplied', async () => {
    const { directory, store, service, snapshotPath } = await fixture(); await upload(service);
    await captureCystSnapshot(service.privateDirectory, snapshotPath, await references(store)); await finishBackup(directory);
    const snapshot = await readCystSnapshot(snapshotPath), blob = snapshot.blobs[0]; if (!blob) throw new Error('Missing fixture blob');
    const modified = Buffer.from(blob.ciphertext, 'base64'); modified[0] = (modified[0] ?? 0) ^ 1; blob.ciphertext = modified.toString('base64');
    await writeSnapshot(snapshotPath, snapshot);
    const manifest = backupManifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
    const actual = await hashBackupFile(snapshotPath);
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest,
      files: manifest.files.map(file => file.name === cystSnapshotFileName ? { ...file, ...actual } : file) }), { mode: 0o600 });
    await expect(verifyBackup(directory)).rejects.toThrow('ciphertext checksum');
  });

  it('refuses snapshot limits before restoring or writing a capture output', async () => {
    const { root, service, snapshotPath } = await fixture();
    const one = singleBlobSnapshot();
    await writeSnapshot(snapshotPath, { ...one, blobs: Array.from({ length: CYST_BACKUP_LIMITS.maxBlobs + 1 }, () => one.blobs[0]) });
    const target = join(root, '.local', 'oversized-restore');
    await expect(restoreCystSnapshot(snapshotPath, target)).rejects.toThrow();
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(snapshotPath);
    // Sparse lengths test the total-size preflight without allocating or reading 128 MiB of data.
    const count = Math.floor(CYST_BACKUP_LIMITS.maxCiphertextBytes / CYST_CAPABILITIES.maxCiphertextBytes) + 1;
    for (let index = 0; index < count; index++) {
      const handle = await open(join(service.privateDirectory, index.toString(16).padStart(64, '0') + '.blob'), 'wx', 0o600);
      try { await handle.truncate(CYST_CAPABILITIES.maxCiphertextBytes); } finally { await handle.close(); }
    }
    await expect(captureCystSnapshot(service.privateDirectory, snapshotPath)).rejects.toThrow('ciphertext limit');
    await expect(lstat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not overwrite an existing restore directory or its retained data', async () => {
    const { root, snapshotPath } = await fixture(); await writeSnapshot(snapshotPath, singleBlobSnapshot());
    const target = await createBackupDirectory(join(root, '.local', 'existing-restore'));
    await writeFile(join(target, 'retained.txt'), 'preserve-existing-directory', { mode: 0o600 });
    await expect(restoreCystSnapshot(snapshotPath, target)).rejects.toThrow();
    expect(await readFile(join(target, 'retained.txt'), 'utf8')).toBe('preserve-existing-directory');
    expect(await readdir(target)).toEqual(['retained.txt']);
  });

  it.each(['recovery-key.txt', '.tmp-11111111-1111-4111-8111-111111111111'])('fails capture rather than including unexpected storage file %s', async name => {
    const { service, snapshotPath } = await fixture();
    await writeFile(join(service.privateDirectory, name), 'private-file-must-not-be-captured', { mode: 0o600 });
    await expect(captureCystSnapshot(service.privateDirectory, snapshotPath)).rejects.toThrow('Unexpected file');
    await expect(lstat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects hard-linked blobs instead of copying mutable external aliases', async () => {
    const { root, service, snapshotPath } = await fixture(); await upload(service);
    const name = (await readdir(service.privateDirectory))[0]; if (!name) throw new Error('Missing fixture blob');
    await link(join(service.privateDirectory, name), join(root, 'external-alias.blob'));
    await expect(captureCystSnapshot(service.privateDirectory, snapshotPath)).rejects.toThrow('Invalid private Cyst blob');
  });

  it('bounds snapshot descriptor reads when a file grows after its checked stat', async () => {
    const { snapshotPath } = await fixture(); await writeSnapshot(snapshotPath, singleBlobSnapshot());
    const initialBytes = (await lstat(snapshotPath)).size;
    let observedBytes = 0, appended = false;
    fileRace.opened = async (path, handle) => {
      if (path !== snapshotPath) return;
      const originalStat = handle.stat.bind(handle), originalRead = handle.read.bind(handle), originalReadFile = handle.readFile.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation((async (...args: unknown[]) => {
        const metadata = await Reflect.apply(originalStat, handle, args);
        if (!appended) { appended = true; await appendFile(snapshotPath, Buffer.alloc(2 * 1024 * 1024)); }
        return metadata;
      }) as FileHandle['stat']);
      vi.spyOn(handle, 'read').mockImplementation((async (...args: unknown[]) => {
        const result = await Reflect.apply(originalRead, handle, args) as { bytesRead: number };
        observedBytes += result.bytesRead; return result;
      }) as FileHandle['read']);
      vi.spyOn(handle, 'readFile').mockImplementation((async (...args: unknown[]) => {
        const result = await Reflect.apply(originalReadFile, handle, args) as Buffer;
        observedBytes += result.byteLength; return result;
      }) as FileHandle['readFile']);
    };
    await expect(readCystSnapshot(snapshotPath)).rejects.toThrow(/grew|changed/);
    expect(appended).toBe(true);
    expect(observedBytes).toBeLessThanOrEqual(initialBytes + 1);
  });

  it('bounds streamed hashing and rejects a concurrent append instead of hashing undeclared bytes', async () => {
    const { directory } = await fixture(); const source = join(directory, 'race.dump');
    await writeFile(source, Buffer.alloc(65_536), { mode: 0o600 });
    const initialBytes = (await lstat(source)).size;
    let streamedBytes = 0, appended = false;
    fileRace.opened = async (path, handle) => {
      if (path !== source) return;
      const originalStat = handle.stat.bind(handle), originalStream = handle.createReadStream.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation((async (...args: unknown[]) => {
        const metadata = await Reflect.apply(originalStat, handle, args);
        if (!appended) { appended = true; await appendFile(source, Buffer.alloc(2 * 1024 * 1024)); }
        return metadata;
      }) as FileHandle['stat']);
      vi.spyOn(handle, 'createReadStream').mockImplementation((...args: Parameters<FileHandle['createReadStream']>) => {
        const stream = originalStream(...args); stream.on('data', (bytes: string | Buffer) => { streamedBytes += Buffer.byteLength(bytes); }); return stream;
      });
    };
    await expect(hashBackupFile(source)).rejects.toThrow(/grew|changed/);
    expect(appended).toBe(true); expect(streamedBytes).toBeGreaterThan(0);
    expect(streamedBytes).toBeLessThanOrEqual(initialBytes + 1);
  });

  it('checks the original pathname inode after the final descriptor stat', async () => {
    const { directory } = await fixture(); const source = join(directory, 'race-path.dump');
    await writeFile(source, 'same-sized-old-data', { mode: 0o600 });
    let calls = 0, replaced = false;
    fileRace.opened = async (path, handle) => {
      if (path !== source) return;
      const originalStat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation((async (...args: unknown[]) => {
        const metadata = await Reflect.apply(originalStat, handle, args);
        if (++calls === 2) {
          await rename(source, join(directory, 'retained-race-original.dump'));
          await writeFile(source, 'same-sized-new-data', { mode: 0o600 }); replaced = true;
        }
        return metadata;
      }) as FileHandle['stat']);
    };
    await expect(hashBackupFile(source)).rejects.toThrow('path changed during read');
    expect(replaced).toBe(true);
    expect(await readFile(source, 'utf8')).toBe('same-sized-new-data');
  });

  it('rejects hard-linked general backup files at hash preflight', async () => {
    const { root, directory } = await fixture(); const source = join(directory, 'database.dump');
    await link(source, join(root, 'archive-alias.dump'));
    await expect(hashBackupFile(source)).rejects.toThrow('Invalid backup file');
  });

  it.skipIf(process.platform === 'win32')('rejects public permissions and symlinked source or restore paths', async () => {
    const { root, service, snapshotPath } = await fixture(); await upload(service);
    const name = (await readdir(service.privateDirectory))[0]; if (!name) throw new Error('Missing fixture blob');
    const original = join(service.privateDirectory, name);
    await chmod(original, 0o644);
    await expect(captureCystSnapshot(service.privateDirectory, snapshotPath)).rejects.toThrow('Invalid private Cyst blob');
    await chmod(original, 0o600);
    await captureCystSnapshot(service.privateDirectory, snapshotPath);
    const outside = join(root, 'outside.blob'); await writeFile(outside, await readFile(original), { mode: 0o600 });
    await rm(original); await symlink(outside, original);
    await expect(captureCystSnapshot(service.privateDirectory, join(dirname(snapshotPath), 'linked.json'))).rejects.toThrow('Invalid private Cyst blob');
    await symlink(service.privateDirectory, join(root, '.local', 'redirect'));
    await expect(restoreCystSnapshot(snapshotPath, join(root, '.local', 'redirect', 'restore'))).rejects.toThrow('symlinks');
  });

  it('rejects a profile/version mismatch even after the profile checksum is recomputed', async () => {
    const { directory, service, snapshotPath } = await fixture();
    await captureCystSnapshot(service.privateDirectory, snapshotPath); await finishBackup(directory);
    await writeFile(join(directory, 'profile.env'), profile(false, service.privateDirectory), { mode: 0o600 });
    const manifest = backupManifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
    const changed = await hashBackupFile(join(directory, 'profile.env'));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest,
      files: manifest.files.map(file => file.name === 'profile.env' ? { ...file, ...changed } : file) }), { mode: 0o600 });
    await expect(verifyBackup(directory)).rejects.toThrow('profile/version mismatch');
  });
});
