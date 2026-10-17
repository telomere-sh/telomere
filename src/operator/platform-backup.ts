import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import pg from 'pg';
import { getAddress, keccak256, parseTransaction, recoverTransactionAddress, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { bytes32Schema } from '../common.js';
import type { Config } from '../config.js';
import { cystCapabilities, cystQuotaPolicySchema, type CystQuotaPolicy } from '../cysts/quota.js';
import { CYST_CAPABILITIES } from '../cysts/types.js';
import { S3CiphertextStorage } from '../cysts/s3.js';
import { LargeCystReplicatedStore } from '../cysts/large-replicated.js';
import { inspectLargeCystRemoteTopology, LARGE_CYST_MAX_PART_BYTES, parseLargeCystHeader,
  parseLargeCystManifest } from '../cysts/large-checkpoints.js';
import { readReviewedLargeCystReplication } from '../cysts/large-configured.js';
import { admissionHash, hostScopeSchema, type HostScope } from '../host-kit/admission.js';
import { Ed25519Identity, hostMessageHash, signedAckSchema, signedLeaseSchema,
  signedTickSchema, verifyHostMessage } from '../host-kit/protocol.js';
import { hostBinding, hostClaims, hostPaidSessions, hostRuns, hostSessions, openHostJournal } from '../host-kit/journal.js';
import { platformPinsSchema } from '../platform-runtime/types.js';
import { createBackupDirectory, hashBackupFile, privateBackupPath, readPrivateBounded } from './backup.js';

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.object({ name: z.literal('database.dump'), bytes: z.number().int().min(1).max(1_073_741_824), sha256: hex64 }).strict();
const table = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), rows: z.number().int().min(0).max(100_000), sha256: hex64 }).strict();
const hostFile = z.object({ path: z.string().regex(/^[a-zA-Z0-9_.\/-]{1,512}$/), bytes: z.number().int().min(0).max(134_217_728), sha256: hex64 }).strict();
const hostDirectory = z.string().regex(/^[a-zA-Z0-9_.\/-]{1,512}$/);
const remote = z.object({ records: z.number().int().min(0).max(4096), bytes: z.number().int().min(0).max(2_147_483_648), sha256: hex64 }).strict();
export const platformBackupManifestSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('paid_platform_stopped_state'),
  createdAt: z.string().datetime(), chainId: z.union([z.literal(31337), z.literal(8453), z.literal(84532)]), blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
  blockHash: z.string().regex(/^0x[a-f0-9]{64}$/), profileSha256: hex64, platformConfigSha256: hex64,
  smallConfigSha256: hex64, largeConfigSha256: hex64,
  hostId: z.string().regex(/^0x[a-f0-9]{64}$/), hostKey: z.string().regex(/^0x[a-f0-9]{64}$/),
  hostControlKey: z.string().regex(/^0x[a-f0-9]{64}$/), hostScopeSha256: hex64,
  journalSigner: z.string().regex(/^0x[a-f0-9]{40}$/), initialSignerNonce: z.number().int().nonnegative().safe(),
  servicesStopped: z.literal(true), managedCellsAbsent: z.literal(true), activeRunsAbsent: z.literal(true),
  hostFiles: z.array(hostFile).max(1024), hostDirectories: z.array(hostDirectory).max(4096)
    .refine(items => items.every((item, index) => index === 0 || item > items[index - 1]!), 'Host directories must be sorted and unique'),
  tables: z.array(table).min(1).max(128), journalRows: z.number().int().min(0).max(4096),
  smallCysts: remote, largeCysts: remote, files: z.array(file).length(1),
  externalCiphertextRequired: z.literal(true), configurationRecovery: z.literal(false),
  largeShadowRecovery: z.literal(false), fullDisasterRecovery: z.literal(false),
}).strict();
export type PlatformBackupManifest = z.infer<typeof platformBackupManifestSchema>;
export type TableFingerprint = z.infer<typeof table>;
export type RemoteFingerprint = z.infer<typeof remote>;
export type HostFile = z.infer<typeof hostFile>;
export type HostSnapshot = { files: HostFile[]; directories: string[] };
export const PLATFORM_BACKUP_LIMITS = Object.freeze({ maxTables: 128, maxRowsPerTable: 100_000,
  maxTotalRows: 500_000, maxRowBytes: 2_097_152, maxTotalRowBytes: 536_870_912,
  maxHostFiles: 1024, maxHostBytes: 536_870_912, maxRemoteBytes: 2_147_483_648 });

/** A paid session is a separate Docker namespace from one-shot HostKit Cells.
 * Query label presence so a malformed marker value cannot be silently omitted. */
export async function verifyPaidDockerInventory(dockerHost: string,
  command: (binary: string, args: string[]) => Promise<string>): Promise<void> {
  for (const marker of ['telomere.managed', 'telomere.hostkit', 'telomere.session']) {
    if (await command('docker', ['--host', dockerHost, 'ps', '--all', '--filter', `label=${marker}`, '--format', '{{.ID}}']) !== '') {
      throw new Error('Paid Docker Cells remain after shutdown');
    }
  }
}

/** Deterministic snapshot of every public table, not a hand-picked subset. The
 * caller keeps one exported, repeatable-read PostgreSQL snapshot open for pg_dump.
 */
export async function fingerprintPlatformDatabase(client: pg.ClientBase): Promise<TableFingerprint[]> {
  const names = await client.query<{ tablename: string }>(`SELECT tablename FROM pg_catalog.pg_tables
    WHERE schemaname='public' ORDER BY tablename LIMIT 129`);
  if (names.rows.length > PLATFORM_BACKUP_LIMITS.maxTables) throw new Error('Database table count exceeds backup limit');
  const found = new Set(names.rows.map(row => row.tablename));
  for (const required of ['platform_runs', 'platform_host_leases', 'platform_transaction_journal',
    'platform_receipt_batches', 'platform_receipt_entries', 'cysts', 'cyst_owners']) {
    if (!found.has(required)) throw new Error('Paid platform table is missing');
  }
  const result: TableFingerprint[] = [];
  let totalRows = 0, totalBytes = 0;
  for (const { tablename } of names.rows) {
    const name = table.shape.name.parse(tablename);
    const digest = createHash('sha256'); let offset = 0;
    for (;;) {
      const page = await client.query<{ payload: string }>(`SELECT row_to_json(t)::text AS payload
        FROM public."${name}" AS t ORDER BY payload LIMIT 256 OFFSET $1`, [offset]);
      if (page.rows.length === 0) break;
      for (const row of page.rows) {
        const bytes = Buffer.from(row.payload, 'utf8');
        if (bytes.byteLength > PLATFORM_BACKUP_LIMITS.maxRowBytes) throw new Error('Database row exceeds backup limit');
        digest.update(String(bytes.byteLength)).update(':').update(bytes);
        totalBytes += bytes.byteLength;
      }
      offset += page.rows.length; totalRows += page.rows.length;
      if (offset > PLATFORM_BACKUP_LIMITS.maxRowsPerTable || totalRows > PLATFORM_BACKUP_LIMITS.maxTotalRows
        || totalBytes > PLATFORM_BACKUP_LIMITS.maxTotalRowBytes) throw new Error('Database exceeds backup limit');
      if (page.rows.length < 256) break;
    }
    result.push(table.parse({ name, rows: offset, sha256: digest.digest('hex') }));
  }
  return result;
}

/** Checks all original signed bytes; canonical receipt/nonce reconciliation is a
 * separate chain audit and is not inferred from a PostgreSQL backup. */
export async function verifyPlatformSignedJournal(client: pg.ClientBase, chainId: number): Promise<number> {
  const rows = await client.query<{ key: string; chain_id: number; sender: string; to: string; data: string;
    raw: string; hash: string; nonce: number }>(`SELECT key,chain_id,sender,"to",data,raw,hash,nonce
      FROM platform_transaction_journal ORDER BY chain_id,sender,nonce,key LIMIT 4097`);
  if (rows.rows.length > 4096) throw new Error('Signed journal exceeds archival limit');
  const seen = new Set<string>();
  for (const row of rows.rows) {
    if (!/^0x(?:[a-f0-9]{2})+$/i.test(row.raw) || row.raw.length > 131_072 || !/^0x(?:[a-f0-9]{2})*$/i.test(row.data)
      || row.data.length > 131_072 || !Number.isSafeInteger(row.nonce) || row.nonce < 0 || row.chain_id !== chainId) {
      throw new Error('Invalid signed journal row');
    }
    const nonceKey = `${row.chain_id}:${row.sender.toLowerCase()}:${row.nonce}`;
    if (seen.has(nonceKey)) throw new Error('Duplicate signed nonce');
    seen.add(nonceKey);
    const raw = row.raw as TransactionSerialized, transaction = parseTransaction(raw);
    if (transaction.chainId !== chainId || transaction.nonce !== row.nonce || transaction.to?.toLowerCase() !== row.to.toLowerCase()
      || (transaction.data ?? '0x').toLowerCase() !== row.data.toLowerCase() || (transaction.value ?? 0n) !== 0n
      || keccak256(raw).toLowerCase() !== row.hash.toLowerCase()
      || (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() !== getAddress(row.sender).toLowerCase()) {
      throw new Error('Signed journal bytes do not match intent');
    }
  }
  return rows.rows.length;
}

const smallDestination = z.object({ endpoint: z.string().url(), bucket: z.string(), region: z.string(), failureDomain: z.string(),
  reviewed: z.literal(true), allowInsecureLoopback: z.boolean().optional(), credentials: z.object({ accessKeyId: z.string(),
    secretAccessKey: z.string(), sessionToken: z.string().optional() }).strict() }).strict();
const smallTopology = z.object({ version: z.literal(1), destinations: z.tuple([smallDestination, smallDestination]) }).strict();
async function privateJson(path: string, maximum: number): Promise<unknown> {
  return JSON.parse((await readPrivateBounded(path, 1, maximum)).toString('utf8')) as unknown;
}
async function privateText(path: string, maximum: number): Promise<string> {
  return (await readPrivateBounded(path, 1, maximum)).toString('utf8');
}
function sameHostEntry(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
/** PGlite creates 0755/0644 entries on some Linux builds. The private 0700
 * HostKit root still protects them; every descendant must retain its owner. */
async function hostAncestorStates(root: string, path: string): Promise<Array<{ path: string; info: BigIntStats }>> {
  const relativePath = relative(root, path);
  if (!relativePath || relativePath.length > 512 || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Host state file escaped its private root');
  }
  const components = relativePath.split(/[\\/]/);
  if (components.some(component => !/^[a-zA-Z0-9_.-]{1,128}$/.test(component) || component === '.' || component === '..')) {
    throw new Error('Invalid HostKit file path');
  }
  let ancestor = root;
  for (;;) {
    const info = await lstat(ancestor, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Host state ancestor is unsafe');
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const states: Array<{ path: string; info: BigIntStats }> = [];
  let current = root;
  const rootInfo = await lstat(current, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || process.platform !== 'win32' && (rootInfo.mode & 0o077n) !== 0n) throw new Error('Host state root is not private');
  states.push({ path: current, info: rootInfo });
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== rootInfo.uid) {
      throw new Error('Host state directory is unsafe');
    }
    states.push({ path: current, info });
  }
  return states;
}
async function readHostBounded(root: string, path: string, maximum: number): Promise<Buffer> {
  const beforeDirs = await hostAncestorStates(root, path);
  const before = await lstat(path, { bigint: true });
  const key = relative(root, path) === 'host-ed25519.pem';
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 0n || before.size > BigInt(maximum) || before.uid !== beforeDirs[0]!.info.uid
    || key && process.platform !== 'win32' && (before.mode & 0o077n) !== 0n) {
    throw new Error('Unsafe HostKit state file');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameHostEntry(before, opened)) throw new Error('HostKit file changed before read');
    const length = Number(opened.size), bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(bytes, offset, length - offset, offset);
      if (result.bytesRead === 0) throw new Error('HostKit file truncated during read');
      offset += result.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, length)).bytesRead !== 0) throw new Error('HostKit file grew during read');
    if (!sameHostEntry(opened, await handle.stat({ bigint: true }))
      || !sameHostEntry(opened, await lstat(path, { bigint: true }))) throw new Error('HostKit file changed during read');
    const afterDirs = await hostAncestorStates(root, path);
    if (afterDirs.length !== beforeDirs.length || afterDirs.some((item, index) =>
      item.path !== beforeDirs[index]!.path || !sameHostEntry(item.info, beforeDirs[index]!.info))) {
      throw new Error('HostKit directory changed during read');
    }
    return bytes;
  } finally { await handle.close(); }
}
async function copyVerifiedPrivate(sourceRoot: string, source: string, target: string, maximum: number): Promise<void> {
  const bytes = await readHostBounded(sourceRoot, source, maximum);
  const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function hashHostFile(root: string, path: string): Promise<{ bytes: number; sha256: string }> {
  const bytes = await readHostBounded(root, path, 134_217_728);
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}
/** Only a single local HostKit is currently supported by this stopped-state
 * drill. A multi-host or remote-host topology needs coordinated snapshots. */
export async function readPlatformBackupBinding(config: Config) {
  if (!config.PLATFORM_RUNTIME_CONFIG) throw new Error('Reviewed paid platform configuration is required');
  const raw = await privateText(config.PLATFORM_RUNTIME_CONFIG, 65_536);
  const binding = z.object({ pins: platformPinsSchema, signerKeyFile: z.string().min(1),
    hosts: z.array(z.object({ hostId: bytes32Schema, hostKey: bytes32Schema,
      controlPemFile: z.string().min(1) }).passthrough()).length(1) }).passthrough().parse(JSON.parse(raw));
  if (binding.pins.chainId !== config.CHAIN_ID) throw new Error('Platform chain pin changed');
  const signer = privateKeyToAccount(bytes32Schema.parse((await privateText(binding.signerKeyFile, 80)).trim())).address.toLowerCase();
  const controlKey = new Ed25519Identity(await privateText(binding.hosts[0]!.controlPemFile, 1024)).publicKey;
  return { pins: binding.pins, hostId: binding.hosts[0]!.hostId, hostKey: binding.hosts[0]!.hostKey,
    signer, controlKey, configSha256: sha256(raw) };
}
function summary(records: readonly unknown[], bytes: number): RemoteFingerprint {
  return remote.parse({ records: records.length, bytes, sha256: sha256(JSON.stringify(records)) });
}
export function verifySmallCystOwnerQuotas(records: readonly { owner: string; ciphertext_bytes: number }[],
  owners: readonly { owner: string; used_bytes: number; checkpoints: number }[], options: { quotaPolicy?: CystQuotaPolicy } = {}): void {
  const policy = options.quotaPolicy === undefined ? undefined : cystQuotaPolicySchema.parse(options.quotaPolicy);
  const capabilities = cystCapabilities(policy, policy === undefined ? 1 : 2);
  if (records.length > 4096 || owners.length > 4096) throw new Error('Small Cyst quota inventory exceeds backup limit');
  const expected = new Map<string, { bytes: number; checkpoints: number }>();
  for (const row of records) {
    if (!Number.isSafeInteger(row.ciphertext_bytes) || row.ciphertext_bytes < 17
      || row.ciphertext_bytes > CYST_CAPABILITIES.maxCiphertextBytes) throw new Error('Invalid small Cyst size');
    const entry = expected.get(row.owner) ?? { bytes: 0, checkpoints: 0 };
    entry.bytes += row.ciphertext_bytes; entry.checkpoints++;
    expected.set(row.owner, entry);
  }
  const seen = new Set<string>();
  for (const owner of owners) {
    const counted = expected.get(owner.owner) ?? { bytes: 0, checkpoints: 0 };
    if (!Number.isSafeInteger(owner.checkpoints) || owner.checkpoints < 0 || owner.checkpoints > capabilities.maxOwnerCheckpoints
      || !Number.isSafeInteger(owner.used_bytes) || owner.used_bytes < 0 || owner.used_bytes > capabilities.maxOwnerBytes) {
      throw new Error('Small Cyst owner quota exceeds the reviewed profile');
    }
    if (seen.has(owner.owner) || owner.used_bytes !== counted.bytes || owner.checkpoints !== counted.checkpoints) {
      throw new Error('Small Cyst owner quota differs from checkpoint metadata');
    }
    seen.add(owner.owner);
  }
  if ([...expected.keys()].some(owner => !seen.has(owner))) throw new Error('Small Cyst owner quota is missing');
}

/** All ready small checkpoints are read and hashed from both independent
 * destinations directly. ReplicatedCystStorage.read() is intentionally avoided
 * because it can repair a missing replica with a PUT. */
export async function verifyPlatformSmallCysts(client: pg.ClientBase, config: Config,
  options: { quotaPolicy?: CystQuotaPolicy } = {}): Promise<RemoteFingerprint> {
  const quotaPolicy = options.quotaPolicy === undefined ? undefined : Object.freeze(cystQuotaPolicySchema.parse(options.quotaPolicy));
  if (!config.CYSTS_ENABLED || !config.CYSTS_REPLICATION_CONFIG || config.CYSTS_DIR) throw new Error('Paid backup requires reviewed two-region small Cyst storage');
  const topology = smallTopology.parse(await privateJson(config.CYSTS_REPLICATION_CONFIG, 32768));
  const [first, second] = topology.destinations.map(item => new S3CiphertextStorage({
    endpoint: item.endpoint, bucket: item.bucket, region: item.region, failureDomain: item.failureDomain, reviewed: true,
    credentials: { accessKeyId: item.credentials.accessKeyId, secretAccessKey: item.credentials.secretAccessKey,
      ...(item.credentials.sessionToken ? { sessionToken: item.credentials.sessionToken } : {}) },
    ...(item.allowInsecureLoopback === undefined ? {} : { allowInsecureLoopback: item.allowInsecureLoopback }),
  })) as [S3CiphertextStorage, S3CiphertextStorage];
  if (first.destination.endpoint === second.destination.endpoint || first.destination.region === second.destination.region
    || first.destination.failureDomain === second.destination.failureDomain) throw new Error('Small Cyst regions are not independent');
  if (config.MODE !== 'demo' && topology.destinations.some(item => item.allowInsecureLoopback)) throw new Error('Insecure public Base Cyst destination');
  await Promise.all([first.initialize(), second.initialize()]);
  const rows = await client.query<{ owner: string; id: string; sha256: string; ciphertext_bytes: number; state: string }>(
    `SELECT owner,id,sha256,ciphertext_bytes,state FROM cysts ORDER BY owner,id LIMIT 4097`);
  if (rows.rows.length > 4096) throw new Error('Small Cyst count exceeds backup limit');
  const owners = await client.query<{ owner: string; used_bytes: number; checkpoints: number }>(
    `SELECT owner,used_bytes,checkpoints FROM cyst_owners ORDER BY owner LIMIT 4097`);
  verifySmallCystOwnerQuotas(rows.rows, owners.rows, quotaPolicy ? { quotaPolicy } : {});
  let bytes = 0;
  for (const item of rows.rows) {
    if (item.state !== 'ready') throw new Error('Pending Cyst must be resolved before stopped-state backup');
    bytes += item.ciphertext_bytes;
    if (bytes > PLATFORM_BACKUP_LIMITS.maxRemoteBytes) throw new Error('Small Cyst bytes exceed backup limit');
    const copies = await Promise.all([first.read(item.owner, item.sha256, item.ciphertext_bytes),
      second.read(item.owner, item.sha256, item.ciphertext_bytes)]);
    if (copies.some(copy => !copy || sha256(copy) !== item.sha256)) throw new Error('Small Cyst replica is missing or corrupt');
  }
  return summary(rows.rows, bytes);
}

async function canonicalPrivateJson<T>(path: string, maximum: number, ownerUid: number,
  parse: (value: unknown) => T): Promise<{
  value: T; bytes: Buffer;
}> {
  const info = await lstat(path);
  if (info.uid !== ownerUid || process.platform !== 'win32' && (info.mode & 0o700) !== 0o600) {
    throw new Error('Large Cyst local file owner or mode changed');
  }
  const bytes = await readPrivateBounded(path, 1, maximum);
  const value = parse(JSON.parse(bytes.toString('utf8')) as unknown);
  if (bytes.toString('utf8') !== JSON.stringify(value)) throw new Error('Large Cyst local JSON is not canonical');
  return { value, bytes };
}
type LocalLargeRecord = { id: string; manifestSha256: string; manifest: ReturnType<typeof parseLargeCystManifest> };
/** Read-only equivalent of the startup shadow scan, with stricter rejection of
 * unfinished writes. Every local part remains required even if S3 is healthy. */
export async function verifyPlatformLargeShadowLocal(rootInput: string, topologySha256: string,
  limits: { globalMaxBytes: number; ownerMaxBytes: number }): Promise<{ records: LocalLargeRecord[]; bytes: number }> {
  const root = resolve(rootInput), rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || process.platform !== 'win32' && (rootInfo.mode & 0o777) !== 0o700
    || !Number.isSafeInteger(limits.globalMaxBytes) || limits.globalMaxBytes < LARGE_CYST_MAX_PART_BYTES
    || limits.globalMaxBytes > 1_099_511_627_776
    || !Number.isSafeInteger(limits.ownerMaxBytes) || limits.ownerMaxBytes < LARGE_CYST_MAX_PART_BYTES
    || limits.ownerMaxBytes > limits.globalMaxBytes) {
    throw new Error('Large Cyst shadow root or quotas are invalid');
  }
  if (!await inspectLargeCystRemoteTopology(root, topologySha256)) throw new Error('Large Cyst topology marker changed');
  const names = (await readdir(root)).sort();
  if (names.includes('.writer.lock')) throw new Error('Large Cyst writer lock is present');
  const records: LocalLargeRecord[] = [], owners = new Map<string, { bytes: number; checkpoints: number }>();
  let bytes = 0, localUsed = 0;
  for (const name of names) {
    if (name === '.remote-topology.json') continue;
    if (!hex64.safeParse(name).success || records.length >= 4096) throw new Error('Unexpected or excess large Cyst shadow entry');
    const directory = join(root, name), info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== rootInfo.uid
      || process.platform !== 'win32' && (info.mode & 0o777) !== 0o700) throw new Error('Invalid large Cyst directory');
    const headerFile = await canonicalPrivateJson(join(directory, 'header.json'), 2048, rootInfo.uid, parseLargeCystHeader);
    const manifestFile = await canonicalPrivateJson(join(directory, 'manifest.json'), 131072, rootInfo.uid, parseLargeCystManifest);
    const proofFile = await canonicalPrivateJson(join(directory, 'remote-commit.json'), 128, rootInfo.uid,
      value => z.object({ version: z.literal(1), sha256: hex64 }).strict().parse(value));
    const manifest = manifestFile.value;
    if (manifest.header.id !== `0x${name}` || JSON.stringify(headerFile.value) !== JSON.stringify(manifest.header)
      || proofFile.value.sha256 !== sha256(manifestFile.bytes)) throw new Error('Large Cyst local header or commit changed');
    const expectedNames = ['header.json', 'manifest.json', 'remote-commit.json'];
    let directoryBytes = headerFile.bytes.length + manifestFile.bytes.length + proofFile.bytes.length;
    for (const part of manifest.parts) {
      const filename = `part-${String(part.index).padStart(6, '0')}.bin`, path = join(directory, filename);
      expectedNames.push(filename);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== rootInfo.uid
        || process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600
        || stat.size !== part.bytes || part.bytes > LARGE_CYST_MAX_PART_BYTES) throw new Error('Large Cyst local part is unsafe');
      const ciphertext = await readPrivateBounded(path, part.bytes, part.bytes);
      if (sha256(ciphertext) !== part.sha256) throw new Error('Large Cyst local part digest changed');
      bytes += part.bytes; directoryBytes += part.bytes;
      if (bytes > PLATFORM_BACKUP_LIMITS.maxRemoteBytes) throw new Error('Large Cyst bytes exceed backup limit');
    }
    if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expectedNames.sort())) {
      throw new Error('Large Cyst local directory contains missing or unexpected files');
    }
    localUsed += directoryBytes;
    const usage = owners.get(manifest.header.owner) ?? { bytes: 0, checkpoints: 0 };
    usage.bytes += directoryBytes; usage.checkpoints++;
    if (localUsed > limits.globalMaxBytes || usage.bytes > limits.ownerMaxBytes || usage.checkpoints > 32) {
      throw new Error('Large Cyst local quota differs from runtime limits');
    }
    owners.set(manifest.header.owner, usage);
    records.push({ id: manifest.header.id, manifestSha256: proofFile.value.sha256, manifest });
  }
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(names)) {
    throw new Error('Large Cyst shadow changed during verification');
  }
  return { records, bytes };
}
/** Both S3 regions are independently read and hashed after local startup state
 * has passed its own read-only integrity scan. Remote ciphertext is not copied. */
export async function verifyPlatformLargeCysts(config: Config): Promise<RemoteFingerprint> {
  if (!config.CYSTS_LARGE_DIR || !config.CYSTS_LARGE_REPLICATION_CONFIG
    || !config.CYSTS_LARGE_GLOBAL_BYTES || !config.CYSTS_LARGE_OWNER_BYTES) {
    throw new Error('Paid backup requires reviewed two-region large Cyst storage and quotas');
  }
  const root = resolve(config.CYSTS_LARGE_DIR);
  const { destinations, topologySha256 } = await readReviewedLargeCystReplication(config, root);
  const local = await verifyPlatformLargeShadowLocal(root, topologySha256,
    { globalMaxBytes: config.CYSTS_LARGE_GLOBAL_BYTES, ownerMaxBytes: config.CYSTS_LARGE_OWNER_BYTES });
  await Promise.all(destinations.map(store => store.initializeReadOnly()));
  const store = new LargeCystReplicatedStore(destinations);
  for (const record of local.records) {
    if (!await store.isDurable(record.id)) throw new Error('Large Cyst remote copy is missing or corrupt');
    const remoteManifest = await store.manifest(record.id);
    if (JSON.stringify(remoteManifest) !== JSON.stringify(record.manifest)) throw new Error('Large Cyst manifest changed remotely');
  }
  return summary(local.records.map(({ id, manifestSha256 }) => ({ id, manifestSha256 })), local.bytes);
}

/** Copy a stopped, local HostKit root including PGlite and its signing key.
 * A remote host or unreviewed directory cannot silently be treated as covered. */
export async function snapshotPlatformHost(source: string, destination: string): Promise<HostSnapshot> {
  const root = resolve(source), target = privateBackupPath(destination), entries: HostFile[] = [], directories: string[] = [];
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || process.platform !== 'win32' && (rootInfo.mode & 0o077) !== 0) throw new Error('Host state is not private');
  await createBackupDirectory(target);
  let total = 0;
  const walk = async (from: string, to: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(from)).sort()) {
      if (name === 'host.lock' || name === 'session.lock') throw new Error('Host journal lock remains after shutdown');
      if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(name) || name === '.' || name === '..') throw new Error('Unexpected host state path');
      const path = join(from, name), relativeName = prefix ? `${prefix}/${name}` : name, stat = await lstat(path);
      if (stat.isSymbolicLink() || stat.uid !== rootInfo.uid
        || relativeName === 'host-ed25519.pem' && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw new Error('Unsafe host state entry');
      }
      if (stat.isDirectory()) {
        directories.push(hostDirectory.parse(relativeName));
        if (directories.length > 4096) throw new Error('Host directory count exceeds backup limit');
        await mkdir(join(to, name), { mode: 0o700 }); await walk(path, join(to, name), relativeName); continue;
      }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 134_217_728) throw new Error('Invalid host state file');
      total += stat.size;
      if (entries.length >= PLATFORM_BACKUP_LIMITS.maxHostFiles || total > PLATFORM_BACKUP_LIMITS.maxHostBytes) throw new Error('Host state exceeds backup limit');
      await copyVerifiedPrivate(root, path, join(to, name), 134_217_728);
      entries.push(hostFile.parse({ path: relativeName, ...await hashHostFile(target, join(to, name)) }));
    }
  };
  await walk(root, target, '');
  if (!entries.some(item => item.path === 'host-ed25519.pem') || !entries.some(item => item.path.startsWith('journal/'))) {
    throw new Error('Host signing identity or PGlite journal is absent');
  }
  return { files: entries, directories: directories.sort() };
}

export async function verifyPlatformHostFiles(directory: string, expected: HostSnapshot): Promise<string> {
  const root = resolve(directory), seen: HostFile[] = [], directories: string[] = []; let total = 0;
  const walk = async (path: string, prefix: string): Promise<void> => {
    const directoryInfo = await lstat(path);
    const rootInfo = await lstat(root);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.uid !== rootInfo.uid
      || path === root && process.platform !== 'win32' && (directoryInfo.mode & 0o077) !== 0) {
      throw new Error('Host backup directory is unsafe');
    }
    for (const name of (await readdir(path)).sort()) {
      if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(name)) throw new Error('Unexpected host backup path');
      const child = join(path, name), pathName = prefix ? `${prefix}/${name}` : name, info = await lstat(child);
      if (info.isDirectory()) { directories.push(hostDirectory.parse(pathName)); await walk(child, pathName); continue; }
      total += info.size;
      if (seen.length >= PLATFORM_BACKUP_LIMITS.maxHostFiles || total > PLATFORM_BACKUP_LIMITS.maxHostBytes) throw new Error('Host backup exceeds limit');
      seen.push(hostFile.parse({ path: pathName, ...await hashHostFile(root, child) }));
    }
  };
  await walk(root, '');
  const sorted = [...expected.files].sort((a, b) => a.path.localeCompare(b.path));
  seen.sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(seen) !== JSON.stringify(sorted)
    || JSON.stringify(directories.sort()) !== JSON.stringify([...expected.directories].sort())) {
    throw new Error('Host journal backup checksum or completeness mismatch');
  }
  const pem = (await readHostBounded(root, join(root, 'host-ed25519.pem'), 1024)).toString('utf8');
  return new Ed25519Identity(pem).publicKey;
}

/** Only materialize a verified host snapshot inside a fresh private scratch
 * root. PGlite may change these copied files during semantic verification. */
export async function restorePlatformHostFiles(source: string, destination: string,
  expected: HostSnapshot): Promise<void> {
  await verifyPlatformHostFiles(source, expected);
  const target = await createBackupDirectory(destination);
  for (const item of expected.directories) {
    const components = item.split('/');
    if (components.some(component => component === '.' || component === '..' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(component))) {
      throw new Error('Invalid HostKit directory path');
    }
    await mkdir(join(target, ...components), { recursive: true, mode: 0o700 });
  }
  for (const item of expected.files) {
    const components = item.path.split('/');
    if (components.some(component => component === '.' || component === '..' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(component))) {
      throw new Error('Invalid host journal path');
    }
    let parent = target;
    for (const component of components.slice(0, -1)) {
      parent = join(parent, component);
      await mkdir(parent, { recursive: true, mode: 0o700 });
    }
    await copyVerifiedPrivate(resolve(source), join(source, ...components), join(target, ...components), 134_217_728);
  }
  if (await verifyPlatformHostFiles(target, expected) !== await verifyPlatformHostFiles(source, expected)) {
    throw new Error('Scratch host journal changed during materialization');
  }
}

/** Opens only a disposable copy, so HostKit's PGlite migration and lock never
 * touch either the stopped source or the immutable backup. */
export async function verifyPlatformHostSemantic(path: string, expectedHostId: string,
  expectedHostKey: string, controlKey: string, expectedScope: HostScope, database: pg.ClientBase): Promise<{
    hostRuns: number; paidSessions: number; controllerLeases: number;
  }> {
  const reviewedScope = hostScopeSchema.parse(expectedScope);
  if (reviewedScope.hostKey !== expectedHostKey || reviewedScope.controlKey !== controlKey) {
    throw new Error('Reviewed HostKit scope and platform binding differ');
  }
  const host = await openHostJournal(path);
  try {
    if (host.identity.publicKey !== expectedHostKey) throw new Error('Restored host signing key changed');
    const [bindings, claims, runs, paid, sessions] = await Promise.all([
      host.db.select().from(hostBinding).limit(2), host.db.select().from(hostClaims).limit(1),
      host.db.select().from(hostRuns).limit(4097), host.db.select().from(hostPaidSessions).limit(4097),
      host.db.select().from(hostSessions).limit(4097),
    ]);
    const savedScope = bindings[0] ? hostScopeSchema.parse(bindings[0].scope) : undefined;
    const scopeHash = admissionHash(reviewedScope);
    if (runs.length + paid.length > 4096 || sessions.length > 4096
      || bindings.length !== 1 || !bindings[0] || !savedScope
      || bindings[0].slot !== 'cpu1' || bindings[0].scopeHash !== scopeHash
      || admissionHash(savedScope) !== scopeHash
      || claims.length !== 0 || sessions.some(row => !row.record || !row.record.cleanupConfirmed
        || ['starting', 'running'].includes(row.record.state))) {
      throw new Error('Restored HostKit has unresolved claim, session or changed binding');
    }
    const known = new Map<string, { leaseHash: string; lease: { body: unknown; signature: string };
      ticks: readonly { body: unknown; signature: string }[]; acks: readonly { body: unknown; signature: string }[] }>();
    for (const row of [...runs, ...paid]) {
      const id = 'runId' in row ? row.runId : row.sessionId;
      const lease = signedLeaseSchema.parse(row.lease);
      const leaseBodyHash = hostMessageHash({ body: lease.body, signature: '' });
      if (!row.cleanupConfirmed || ['starting', 'running'].includes(row.state)
        || !verifyHostMessage(controlKey, 'lease', lease) || lease.body.hostKey !== expectedHostKey
        || lease.body.runId !== id || lease.body.owner !== row.owner
        || hostMessageHash(row.lease) !== row.leaseHash
        || row.ticks.length !== row.acks.length || row.ticks.length > 101
        || row.billableSeconds !== (row.acks.at(-1)?.body.billableSeconds ?? 0)
        || row.ticks.some(tick => !verifyHostMessage(expectedHostKey, 'tick', tick))
        || row.acks.some(ack => !verifyHostMessage(controlKey, 'ack', ack))) {
        throw new Error('Restored HostKit signed history or cleanup is invalid');
      }
      for (let index = 0; index < row.ticks.length; index++) {
        const tick = signedTickSchema.parse(row.ticks[index]), ack = signedAckSchema.parse(row.acks[index]);
        if (tick.body.hostKey !== expectedHostKey || tick.body.runId !== id || tick.body.owner !== row.owner
          || tick.body.leaseHash !== leaseBodyHash || tick.body.sequence !== index
          || tick.body.previousHash !== (index === 0 ? null : hostMessageHash(row.ticks[index - 1]!))
          || ack.body.hostKey !== expectedHostKey || ack.body.runId !== id || ack.body.leaseHash !== leaseBodyHash
          || ack.body.sequence !== index || ack.body.tickHash !== hostMessageHash(tick)
          || ack.body.billableSeconds !== (index === 0 ? 0 : row.acks[index - 1]!.body.billableSeconds) + ack.body.billableDelta) {
          throw new Error('Restored HostKit tick/ACK chain is inconsistent');
        }
      }
      if (known.has(id)) throw new Error('Duplicate HostKit run identity');
      known.set(id, { leaseHash: row.leaseHash, lease: row.lease, ticks: row.ticks, acks: row.acks });
    }
    const controller = await database.query<{ run_id: string; host_id: string; lease_hash: string; cleanup_confirmed: number;
      lease: { body: unknown; signature: string }; ticks: { body: unknown; signature: string }[];
      acknowledgments: { body: unknown; signature: string }[] }>(
      `SELECT run_id,host_id,lease_hash,lease,ticks,acknowledgments,cleanup_confirmed
        FROM platform_host_leases ORDER BY run_id LIMIT 4097`);
    if (controller.rows.length > 4096 || controller.rows.length !== known.size) {
      throw new Error('Controller and HostKit lease counts disagree');
    }
    for (const row of controller.rows) {
      const original = known.get(row.run_id);
      if (!original || row.host_id !== expectedHostId || row.cleanup_confirmed !== 1
        || row.lease_hash !== original.leaseHash
        || hostMessageHash(row.lease) !== original.leaseHash
        || !verifyHostMessage(controlKey, 'lease', row.lease)
        || JSON.stringify(row.ticks.map(tick => hostMessageHash(tick)))
          !== JSON.stringify(original.ticks.map(tick => hostMessageHash(tick)))
        || JSON.stringify(row.acknowledgments.map(ack => hostMessageHash(ack)))
          !== JSON.stringify(original.acks.map(ack => hostMessageHash(ack)))) {
        throw new Error('Controller and HostKit signed lease journals disagree');
      }
    }
    return { hostRuns: runs.length, paidSessions: paid.length, controllerLeases: controller.rows.length };
  } finally { await host.close(); }
}

export async function writePlatformBackupManifest(directory: string, raw: unknown): Promise<PlatformBackupManifest> {
  const target = privateBackupPath(directory), manifest = platformBackupManifestSchema.parse(raw);
  const path = join(target, 'manifest.json'), handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(JSON.stringify(manifest, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  return manifest;
}
export async function verifyPlatformBackupManifest(directory: string): Promise<PlatformBackupManifest> {
  const root = privateBackupPath(directory), manifest = platformBackupManifestSchema.parse(await privateJson(join(root, 'manifest.json'), 1_048_576));
  for (const item of manifest.files) {
    const actual = await hashBackupFile(join(root, item.name));
    if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw new Error('Paid backup file checksum mismatch');
  }
  const archive = await open(join(root, 'database.dump'), 'r');
  try { const magic = Buffer.alloc(5); await archive.read(magic, 0, 5, 0);
    if (magic.toString('ascii') !== 'PGDMP') throw new Error('Invalid PostgreSQL archive'); }
  finally { await archive.close(); }
  const hostKey = await verifyPlatformHostFiles(join(root, 'host'),
    { files: manifest.hostFiles, directories: manifest.hostDirectories });
  if (hostKey !== manifest.hostKey) throw new Error('Host signing identity differs from backup');
  return manifest;
}
