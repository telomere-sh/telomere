import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { asc } from 'drizzle-orm';
import { addressSchema } from '../common.js';
import { parseProfile, publicProfile } from './profile.js';
import { loadConfig, type Config } from '../config.js';
import { readCystQuotaPolicy, type CystQuotaPolicy } from '../cysts/quota.js';
import { CYST_CAPABILITIES, cystAddressSchema, cystDigestSchema, cystIdSchema, cystMetadataSchema } from '../cysts/types.js';
import { cystOwners, cysts } from '../cysts/schema.js';
import { CystService } from '../cysts/service.js';
import { ciphertextDigest } from '../cysts/storage.js';
import type { Database } from '../store.js';

const fileNames = ['database.dump', 'chain.json', 'profile.env'] as const;
const fileSchema = z.object({ name: z.enum(fileNames), bytes: z.number().int().min(1).max(1073741824),
  sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const manifestBase = z.object({ kind: z.literal('private_staging'),
  createdAt: z.string().datetime(), chainId: z.literal(31337), escrow: addressSchema, token: addressSchema,
  signer: addressSchema, demoOwner: addressSchema, servicesStopped: z.literal(true), managedCellsAbsent: z.literal(true) }).strict();
export const CYST_BACKUP_LIMITS = Object.freeze({ maxBlobs: 4096, maxCiphertextBytes: 128 * 1024 * 1024,
  maxSnapshotBytes: 192 * 1024 * 1024, maxMetadataRecords: 65536 });
export const cystSnapshotFileName = 'cysts.snapshot.json';
const cystSummarySchema = z.object({ snapshotVersion: z.literal(1), blobs: z.number().int().min(0).max(CYST_BACKUP_LIMITS.maxBlobs),
  ciphertextBytes: z.number().int().min(0).max(CYST_BACKUP_LIMITS.maxCiphertextBytes) }).strict();
const manifestV1 = manifestBase.extend({ schemaVersion: z.literal(1),
  files: z.array(fileSchema).length(3).refine(files => new Set(files.map(file => file.name)).size === 3, 'Duplicate backup files') }).strict();
const manifestV2 = manifestBase.extend({ schemaVersion: z.literal(2), cysts: cystSummarySchema,
  files: z.array(fileSchema.extend({ name: z.enum([...fileNames, cystSnapshotFileName]) })).length(4)
    .refine(files => new Set(files.map(file => file.name)).size === 4, 'Duplicate backup files') }).strict();
export const backupManifestSchema = z.discriminatedUnion('schemaVersion', [manifestV1, manifestV2]);
export type BackupManifest = z.infer<typeof backupManifestSchema>;

const snapshotBlobSchema = z.object({ name: z.string().regex(/^[a-f0-9]{64}\.blob$/),
  bytes: z.number().int().min(17).max(CYST_CAPABILITIES.maxCiphertextBytes), sha256: cystDigestSchema,
  ciphertext: z.string().min(24).max(Math.ceil(CYST_CAPABILITIES.maxCiphertextBytes / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict();
const snapshotSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('private_cyst_ciphertexts'),
  ciphertextBytes: z.number().int().min(0).max(CYST_BACKUP_LIMITS.maxCiphertextBytes),
  blobs: z.array(snapshotBlobSchema).max(CYST_BACKUP_LIMITS.maxBlobs) }).strict();
export type CystSnapshot = z.infer<typeof snapshotSchema>;
export type CystSnapshotSummary = z.infer<typeof cystSummarySchema>;
const referenceSchema = z.object({ owner: cystAddressSchema, id: cystIdSchema, sha256: cystDigestSchema,
  ciphertextBytes: z.number().int().min(17).max(CYST_CAPABILITIES.maxCiphertextBytes), state: z.enum(['pending', 'ready']) }).strict();
export type CystBackupReference = z.infer<typeof referenceSchema>;

function snapshotSummary(snapshot: CystSnapshot): CystSnapshotSummary {
  return { snapshotVersion: 1, blobs: snapshot.blobs.length, ciphertextBytes: snapshot.ciphertextBytes };
}
function checkedSnapshot(input: unknown): CystSnapshot {
  const snapshot = snapshotSchema.parse(input);
  let total = 0, previous = '';
  for (const blob of snapshot.blobs) {
    if (blob.name <= previous) throw new Error('Cyst snapshot names must be sorted and unique');
    const bytes = Buffer.from(blob.ciphertext, 'base64');
    if (bytes.toString('base64') !== blob.ciphertext || bytes.byteLength !== blob.bytes
      || createHash('sha256').update(bytes).digest('hex') !== blob.sha256) throw new Error('Cyst snapshot ciphertext checksum mismatch');
    total += bytes.byteLength;
    if (total > CYST_BACKUP_LIMITS.maxCiphertextBytes) throw new Error('Cyst snapshot exceeds ciphertext limit');
    previous = blob.name;
  }
  if (snapshot.ciphertextBytes !== total) throw new Error('Cyst snapshot byte count mismatch');
  return snapshot;
}

export function validateCystReferences(snapshot: CystSnapshot, references: readonly CystBackupReference[]) {
  if (references.length > CYST_BACKUP_LIMITS.maxMetadataRecords) throw new Error('Cyst metadata exceeds backup limit');
  const blobs = new Map(snapshot.blobs.map(blob => [blob.name, blob]));
  const seen = new Set<string>();
  let ready = 0, pending = 0, pendingWithoutBlob = 0;
  for (const value of references) {
    const reference = referenceSchema.parse(value);
    const identity = reference.owner + ':' + reference.id;
    if (seen.has(identity)) throw new Error('Duplicate Cyst metadata reference');
    seen.add(identity);
    const name = createHash('sha256').update('telomere-cyst-blob:' + reference.owner + ':' + reference.sha256).digest('hex') + '.blob';
    const blob = blobs.get(name);
    if (blob && (blob.bytes !== reference.ciphertextBytes || blob.sha256 !== reference.sha256)) throw new Error('Cyst metadata and ciphertext mismatch');
    if (reference.state === 'ready') {
      if (!blob) throw new Error('Ready Cyst ciphertext missing from snapshot');
      ready++;
    } else { pending++; if (!blob) pendingWithoutBlob++; }
  }
  return { ready, pending, pendingWithoutBlob };
}

/** The operator policy remains external to the ciphertext backup and is accepted
 * only when its private file matches the explicitly configured reviewed hash. */
export async function readBackupCystQuotaPolicy(config: Pick<Config,
  'CYSTS_ENABLED' | 'CYSTS_QUOTA_POLICY_PATH' | 'CYSTS_QUOTA_POLICY_SHA256'>): Promise<CystQuotaPolicy | undefined> {
  if (config.CYSTS_QUOTA_POLICY_PATH === undefined && config.CYSTS_QUOTA_POLICY_SHA256 === undefined) return undefined;
  if (!config.CYSTS_ENABLED || !config.CYSTS_QUOTA_POLICY_PATH || !config.CYSTS_QUOTA_POLICY_SHA256) {
    throw new Error('Cyst backup quota policy requires enabled Cysts and both reviewed pins');
  }
  return readCystQuotaPolicy(config.CYSTS_QUOTA_POLICY_PATH, config.CYSTS_QUOTA_POLICY_SHA256);
}

/** Proof over restored scratch data; safe inside an explicitly read-only transaction.
 * This does not enable or migrate a quota profile in the restored database. */
export async function verifyRestoredCysts(db: Database, directory: string, snapshot: CystSnapshot,
  options: { quotaPolicy?: CystQuotaPolicy } = {}): Promise<Record<string, unknown>> {
  const service = new CystService(db, directory, options);
  const quotaVersion = options.quotaPolicy === undefined ? 1 : 2;
  const capabilities = service.capabilities(quotaVersion);
  const records = await db.select().from(cysts).orderBy(asc(cysts.owner), asc(cysts.id)).limit(CYST_BACKUP_LIMITS.maxMetadataRecords + 1);
  const references = records.map(record => ({ owner: record.owner, id: record.id, sha256: record.sha256,
    ciphertextBytes: record.ciphertextBytes, state: record.state }));
  const completeness = validateCystReferences(snapshot, references);
  // CystService.initialize() can migrate the database under an explicit v2
  // policy. The restored scratch directory needs only its filesystem guard.
  await service.storage.initialize();
  const owners = await db.select().from(cystOwners).orderBy(asc(cystOwners.owner)).limit(CYST_BACKUP_LIMITS.maxMetadataRecords + 1);
  if (owners.length > CYST_BACKUP_LIMITS.maxMetadataRecords) throw new Error('Restored Cyst owner count exceeds limit');
  const recordsByOwner = new Map<string, typeof records>();
  for (const record of records) {
    const ownRecords = recordsByOwner.get(record.owner);
    if (ownRecords) ownRecords.push(record); else recordsByOwner.set(record.owner, [record]);
  }
  const ownerNames = new Set(owners.map(usage => usage.owner));
  let serviceListOwnersVerified = 0, pendingOwnerListsDeferred = 0, recoverablePending = 0;
  for (const usage of owners) {
    const expected = recordsByOwner.get(usage.owner) ?? [];
    if (!Number.isSafeInteger(usage.checkpoints) || usage.checkpoints < 0 || usage.checkpoints > capabilities.maxOwnerCheckpoints
      || !Number.isSafeInteger(usage.usedBytes) || usage.usedBytes < 0 || usage.usedBytes > capabilities.maxOwnerBytes) {
      throw new Error('Restored Cyst quota exceeds the reviewed profile');
    }
    if (usage.checkpoints !== expected.length || usage.usedBytes !== expected.reduce((total, record) => total + record.ciphertextBytes, 0)) {
      throw new Error('Restored Cyst quota mismatch');
    }
    for (const record of expected) {
      cystMetadataSchema.parse({ version: record.version, algorithm: record.algorithm, id: record.id, owner: record.owner,
        agent: record.agent, applicationSchema: record.applicationSchema, plaintextBytes: record.plaintextBytes,
        nonce: record.nonce, sha256: record.sha256, ciphertextBytes: record.ciphertextBytes, state: record.state,
        createdAt: record.createdAt.toISOString() });
      if (record.state === 'ready') {
        const downloaded = await service.download(record.owner, record.id);
        const bytes = Buffer.from(downloaded.ciphertext, 'base64');
        if (downloaded.metadata.sha256 !== record.sha256 || bytes.byteLength !== record.ciphertextBytes
          || ciphertextDigest(bytes) !== record.sha256) throw new Error('Restored Cyst download digest mismatch');
      } else if (await service.storage.read(record.owner, record.sha256, record.ciphertextBytes)) recoverablePending++;
    }
    // list() now repairs pending rows. Do not invoke that write path in read-only acceptance.
    // Raw metadata and file integrity above prove these owners without changing their states.
    if (expected.some(record => record.state === 'pending')) { pendingOwnerListsDeferred++; continue; }
    let cursor: string | undefined, observed = 0;
    for (;;) {
      const page = await service.list(usage.owner, { ...(cursor ? { cursor } : {}), quotaVersion });
      if (page.usage.bytes !== usage.usedBytes || page.usage.checkpoints !== usage.checkpoints) throw new Error('Restored Cyst list usage mismatch');
      for (const item of page.checkpoints) {
        const record = expected[observed++];
        if (!record || item.id !== record.id || item.owner !== record.owner || item.agent !== record.agent
          || item.sha256 !== record.sha256 || item.ciphertextBytes !== record.ciphertextBytes || item.state !== record.state) {
          throw new Error('Restored Cyst list metadata mismatch');
        }
      }
      if (!page.nextCursor) break;
      if (page.nextCursor <= (cursor ?? '') || observed >= expected.length) throw new Error('Restored Cyst list pagination mismatch');
      cursor = page.nextCursor;
    }
    if (observed !== expected.length) throw new Error('Restored Cyst list is incomplete');
    serviceListOwnersVerified++;
  }
  if (records.some(record => !ownerNames.has(record.owner))) throw new Error('Restored Cyst owner missing');
  if (recoverablePending !== completeness.pending - completeness.pendingWithoutBlob) throw new Error('Restored pending Cyst completeness mismatch');
  return { enabled: true, snapshotVersion: 1, blobs: snapshot.blobs.length, ciphertextBytes: snapshot.ciphertextBytes,
    readyCheckpoints: completeness.ready, pendingCheckpoints: completeness.pending, pendingWithoutBlob: completeness.pendingWithoutBlob,
    recoverablePending, metadataMatches: true, serviceListOwnersVerified, pendingOwnerListsDeferred,
    ...(quotaVersion === 2 ? { quotaVersion, maxOwnerCheckpoints: capabilities.maxOwnerCheckpoints, maxOwnerBytes: capabilities.maxOwnerBytes } : {}),
    downloadHashesMatch: true, pendingStatePreserved: true, clientRecoveryKeyRequired: true,
    metadataSha256: createHash('sha256').update(JSON.stringify(references)).digest('hex') };
}

async function assertNoSymlinkAncestors(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Backup directory must not contain symlinks');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  await assertNoSymlinkAncestors(path);
  const metadata = await lstat(path);
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) throw new Error('Cyst directories must be private');
}
function unchangedFile(before: BigIntStats, after: BigIntStats): boolean {
  return after.isFile() && !after.isSymbolicLink() && after.nlink === 1n && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mode === after.mode && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
async function assertFilePathUnchanged(path: string, metadata: BigIntStats): Promise<void> {
  await assertNoSymlinkAncestors(dirname(path));
  if (!unchangedFile(metadata, await lstat(path, { bigint: true }))) throw new Error('Backup file path changed during read');
}
export async function readPrivateBounded(path: string, minimum: number, maximum: number): Promise<Buffer> {
  await assertPrivateDirectory(dirname(path));
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < BigInt(minimum) || before.size > BigInt(maximum)
    || (process.platform !== 'win32' && (before.mode & 0o077n) !== 0n)) throw new Error('Invalid private Cyst file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!unchangedFile(before, metadata)) throw new Error('Cyst file changed during capture');
    // Never use readFile here: a concurrent append must not allocate past the checked size.
    const length = Number(metadata.size), bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(bytes, offset, length - offset, offset);
      if (result.bytesRead === 0) throw new Error('Cyst file truncated during capture');
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, length)).bytesRead !== 0) throw new Error('Cyst file grew during capture');
    if (!unchangedFile(metadata, await handle.stat({ bigint: true }))) throw new Error('Cyst file changed during capture');
    await assertFilePathUnchanged(path, metadata);
    await assertPrivateDirectory(dirname(path));
    return bytes;
  } finally { await handle.close(); }
}
async function writePrivateExclusive(path: string, bytes: Uint8Array): Promise<void> {
  await assertPrivateDirectory(dirname(path));
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

/** Capture immutable ciphertext only. The caller must keep the controller stopped. */
export async function captureCystSnapshot(source: string, destination: string,
  references?: readonly CystBackupReference[]): Promise<CystSnapshotSummary> {
  const directory = resolve(z.string().min(1).max(4096).parse(source));
  const output = privateBackupPath(destination);
  await assertPrivateDirectory(directory);
  const names = (await readdir(directory)).sort();
  if (names.length > CYST_BACKUP_LIMITS.maxBlobs) throw new Error('Cyst snapshot exceeds blob limit');
  let total = 0;
  // Preflight every path and size before creating the snapshot output.
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.blob$/.test(name)) throw new Error('Unexpected file in Cyst storage; inspect interrupted temporary uploads before backup');
    const metadata = await lstat(join(directory, name));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 17
      || metadata.size > CYST_CAPABILITIES.maxCiphertextBytes
      || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)) throw new Error('Invalid private Cyst blob');
    total += metadata.size;
    if (total > CYST_BACKUP_LIMITS.maxCiphertextBytes) throw new Error('Cyst snapshot exceeds ciphertext limit');
  }
  const blobs: CystSnapshot['blobs'] = [];
  for (const name of names) {
    const bytes = await readPrivateBounded(join(directory, name), 17, CYST_CAPABILITIES.maxCiphertextBytes);
    blobs.push({ name, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), ciphertext: bytes.toString('base64') });
  }
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(names)) throw new Error('Cyst directory changed during capture');
  const snapshot = checkedSnapshot({ schemaVersion: 1, kind: 'private_cyst_ciphertexts', ciphertextBytes: total, blobs });
  if (references) validateCystReferences(snapshot, references);
  const encoded = Buffer.from(JSON.stringify(snapshot) + '\n');
  if (encoded.byteLength > CYST_BACKUP_LIMITS.maxSnapshotBytes) throw new Error('Cyst snapshot exceeds file limit');
  await writePrivateExclusive(output, encoded);
  return snapshotSummary(snapshot);
}

export async function readCystSnapshot(path: string, expected?: { bytes: number; sha256: string }): Promise<CystSnapshot> {
  const bytes = await readPrivateBounded(resolve(path), 1, CYST_BACKUP_LIMITS.maxSnapshotBytes);
  if (expected && (expected.bytes !== bytes.byteLength || expected.sha256 !== createHash('sha256').update(bytes).digest('hex'))) {
    throw new Error('Cyst snapshot manifest checksum mismatch');
  }
  return checkedSnapshot(JSON.parse(bytes.toString('utf8')));
}

/** Restore only to a new ignored/private directory, never over live storage. */
export async function restoreCystSnapshot(path: string, destination: string,
  expected?: { bytes: number; sha256: string }): Promise<CystSnapshotSummary> {
  const snapshot = await readCystSnapshot(path, expected);
  const target = await createBackupDirectory(destination);
  for (const blob of snapshot.blobs) await writePrivateExclusive(join(target, blob.name), Buffer.from(blob.ciphertext, 'base64'));
  if (process.platform !== 'win32') {
    const directory = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  return snapshotSummary(snapshot);
}

export function privateBackupPath(input: string): string {
  const target = resolve(z.string().min(1).max(4096).parse(input));
  const relativeToVps = relative('/opt/telomere-pilot/backups', target);
  const inVpsRoot = process.platform === 'linux' && relativeToVps !== '' && !relativeToVps.startsWith('..') && !isAbsolute(relativeToVps);
  if (!inVpsRoot && !target.split(/[\\/]/).includes('.local')) throw new Error('Backups must be stored in a private ignored directory');
  return target;
}

export async function hashBackupFile(path: string) {
  const source = resolve(path);
  await assertNoSymlinkAncestors(dirname(source));
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 1073741824n) throw new Error('Invalid backup file');
  if (process.platform !== 'win32' && (before.mode & 0o077n) !== 0n) throw new Error('Backup files must be private');
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!unchangedFile(before, metadata)) throw new Error('Backup file changed before hashing');
    const digest = createHash('sha256'), length = Number(metadata.size);
    let bytes = 0;
    // Inclusive end permits only a one-byte EOF probe, even if the file grows.
    const stream = handle.createReadStream({ start: 0, end: length, autoClose: false });
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > length) throw new Error('Backup file grew during hashing');
      digest.update(chunk);
    }
    if (bytes !== length || !unchangedFile(metadata, await handle.stat({ bigint: true }))) throw new Error('Backup file changed during hashing');
    await assertFilePathUnchanged(source, metadata);
    return { bytes, sha256: digest.digest('hex') };
  } finally { await handle.close(); }
}

export async function createBackupDirectory(path: string): Promise<string> {
  const target = privateBackupPath(path);
  const parent = resolve(target, '..');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  // Resolving a pre-existing symlink would move private material outside the reviewed backup root.
  await assertNoSymlinkAncestors(parent);
  await mkdir(target, { mode: 0o700 });
  return target;
}

export async function copyPrivate(source: string, destination: string): Promise<void> {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 134217728) throw new Error('Invalid backup source');
  const handle = await open(destination, 'wx', 0o600);
  await handle.close();
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const durable = await open(destination, 'r+');
  try { await durable.sync(); } finally { await durable.close(); }
}

export async function finishBackup(directory: string): Promise<BackupManifest> {
  const config = loadConfig(parseProfile((await readPrivateBounded(join(directory, 'profile.env'), 1, 65536)).toString('utf8')));
  const metadata = publicProfile(config);
  if (config.MODE !== 'demo' || config.CHAIN_ID !== 31337 || !metadata.demoOwner || !config.DATABASE_URL) throw new Error('Not a private staging backup');
  const files: { name: string; bytes: number; sha256: string }[] = [];
  for (const name of fileNames) files.push({ name, ...await hashBackupFile(join(directory, name)) });
  const cystSnapshot = config.CYSTS_ENABLED ? await readCystSnapshot(join(directory, cystSnapshotFileName)) : undefined;
  if (cystSnapshot) files.push({ name: cystSnapshotFileName, ...await hashBackupFile(join(directory, cystSnapshotFileName)) });
  const manifest = backupManifestSchema.parse({ schemaVersion: cystSnapshot ? 2 : 1, kind: 'private_staging', createdAt: new Date().toISOString(), chainId: 31337,
    escrow: metadata.escrow, token: metadata.token, signer: metadata.signer, demoOwner: metadata.demoOwner,
    servicesStopped: true, managedCellsAbsent: true, files, ...(cystSnapshot ? { cysts: snapshotSummary(cystSnapshot) } : {}) });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const handle = await open(join(directory, 'manifest.json'), 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  return manifest;
}

export async function verifyBackup(path: string): Promise<BackupManifest> {
  const directory = resolve(z.string().min(1).max(4096).parse(path));
  await assertNoSymlinkAncestors(directory);
  const manifestPath = join(directory, 'manifest.json');
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 16384) throw new Error('Invalid backup manifest');
  if (process.platform !== 'win32' && (manifestInfo.mode & 0o077) !== 0) throw new Error('Backup manifest must be private');
  const manifest = backupManifestSchema.parse(JSON.parse((await readPrivateBounded(manifestPath, 1, 16384)).toString('utf8')));
  for (const item of manifest.files) {
    const actual = await hashBackupFile(join(directory, item.name));
    if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw new Error('Backup checksum mismatch');
  }
  const db = await open(join(directory, 'database.dump'), 'r');
  try { const header = Buffer.alloc(5); await db.read(header, 0, 5, 0); if (header.toString('ascii') !== 'PGDMP') throw new Error('Invalid PostgreSQL archive'); }
  finally { await db.close(); }
  if ((await lstat(join(directory, 'chain.json'))).size > 134217728) throw new Error('Chain state exceeds backup verification limit');
  if ((await lstat(join(directory, 'profile.env'))).size > 65536) throw new Error('Profile exceeds backup verification limit');
  const chainBytes = await readPrivateBounded(join(directory, 'chain.json'), 1, 134217728);
  const chainFile = manifest.files.find(file => file.name === 'chain.json');
  if (!chainFile || chainBytes.byteLength !== chainFile.bytes || createHash('sha256').update(chainBytes).digest('hex') !== chainFile.sha256) throw new Error('Backup chain checksum mismatch');
  const chain = z.record(z.unknown()).parse(JSON.parse(chainBytes.toString('utf8')));
  if (!Object.keys(chain).length) throw new Error('Empty chain state');
  const profileBytes = await readPrivateBounded(join(directory, 'profile.env'), 1, 65536);
  const profileFile = manifest.files.find(file => file.name === 'profile.env');
  if (!profileFile || profileBytes.byteLength !== profileFile.bytes || createHash('sha256').update(profileBytes).digest('hex') !== profileFile.sha256) throw new Error('Backup profile checksum mismatch');
  const config = loadConfig(parseProfile(profileBytes.toString('utf8')));
  const metadata = publicProfile(config);
  if (config.MODE !== 'demo' || config.CHAIN_ID !== manifest.chainId || !config.DATABASE_URL || metadata.escrow !== manifest.escrow
    || metadata.token !== manifest.token || metadata.signer !== manifest.signer || metadata.demoOwner !== manifest.demoOwner) throw new Error('Backup profile mismatch');
  if (config.CYSTS_ENABLED !== (manifest.schemaVersion === 2)) throw new Error('Backup Cyst profile/version mismatch');
  if (manifest.schemaVersion === 2) {
    const snapshotFile = manifest.files.find(file => file.name === cystSnapshotFileName);
    if (!snapshotFile) throw new Error('Missing Cyst snapshot manifest entry');
    const snapshot = await readCystSnapshot(join(directory, cystSnapshotFileName), snapshotFile);
    const summary = snapshotSummary(snapshot);
    if (summary.blobs !== manifest.cysts.blobs || summary.ciphertextBytes !== manifest.cysts.ciphertextBytes) throw new Error('Backup Cyst manifest count mismatch');
  }
  return manifest;
}
