import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, statfs, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { bytes32Schema, canonical } from '../common.js';
import { LARGE_CYST_MAX_PLAINTEXT_BYTES, restoreLargeCystFileWithWrappedKey } from '../cysts/large-checkpoints.js';
import { largeCystRegistryDescriptorSchema, largeCystRegistryMatches } from '../cysts/large-registry.js';
import { cystRegistryHashSchema, cystRegistrySnapshotSchema, type CystRegistryReader } from '../cysts/registry-types.js';
import { cystAddressSchema, cystHeaderSchema } from '../cysts/types.js';
import { CYST_INPUT_PATH, cystInputDescriptorHash, cystInputDescriptorSchema, type CystInputDescriptor } from '../host-kit/sessions/cyst-input-protocol.js';
import { parsePaidSessionLease, paidSessionTaskSchema } from '../host-kit/sessions/paid-protocol.js';
import { hostMessageHash } from '../host-kit/protocol.js';
import { sessionCommandSchema } from '../host-kit/sessions/types.js';
import { checkedSessionCommand } from '../platform-runtime/session-client.js';
import type { PlatformVaultRuntimeClient } from '../platform-runtime/vault-client.js';
import type { CystCheckpointJournal, CystCheckpointVault } from '../sdk/cyst-checkpoints.js';
import type { CystWrappingIdentity } from '../sdk/cyst-key-wrap.js';
import { decryptCheckpoint, encryptCheckpoint } from '../sdk/cysts.js';
import type { LargeCystAgentManifestStore } from '../sdk/large-cyst-agent-manifest.js';
import type { PaidCystInputClient } from '../sdk/paid-cyst-input.js';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const planSchema = z.object({ version: z.literal(1), operationId: cystInputDescriptorSchema.shape.operationId,
  owner: cystAddressSchema, agent: cystAddressSchema, agentId: bytes32Schema, vault: cystAddressSchema,
  applicationSchema: cystHeaderSchema.shape.applicationSchema, imageDigest: paidSessionTaskSchema.shape.imageDigest,
  maxCommands: paidSessionTaskSchema.shape.maxCommands, restoreSpecSha256: hex,
  checkpoint: largeCystRegistryDescriptorSchema, revision: z.string().regex(/^[1-9][0-9]{0,77}$/),
  blockNumber: z.string().regex(/^(0|[1-9][0-9]{0,77})$/), blockHash: cystRegistryHashSchema,
  plaintextBytes: z.number().int().min(1).max(LARGE_CYST_MAX_PLAINTEXT_BYTES),
  createdAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().positive().safe() }).strict();
const readySchema = z.object({ version: z.literal(1), planHash: hex, descriptor: cystInputDescriptorSchema }).strict();
const targetSchema = z.object({ version: z.literal(1), runId: bytes32Schema, leaseHash: bytes32Schema,
  descriptorHash: bytes32Schema }).strict();
const receiptSchema = z.object({ protocol: z.literal('telomere-agent-current-cyst-file-restore-v1'),
  agentId: bytes32Schema, targetRunId: bytes32Schema, checkpointId: bytes32Schema,
  revision: planSchema.shape.revision, operationId: cystInputDescriptorSchema.shape.operationId,
  plaintextBytes: planSchema.shape.plaintextBytes, plaintextSha256: hex }).strict();
type Plan = z.infer<typeof planSchema>;
type CheckedClient = Pick<PlatformVaultRuntimeClient, 'origin' | 'config' | 'get' | 'command' | 'sessionLease'>;
type SourceStore = Pick<LargeCystAgentManifestStore, 'resolveCurrent' | 'part'>;

/** One explicit operation and one private plaintext file per configured directory.
 * Preparation needs no wallet; paying/admitting the returned task is a separate
 * checked Vault SDK operation. This restores declared application data, not an
 * arbitrary filesystem archive or a VM/container writable layer.
 */
export class AgentCurrentCystPaidFileRestore {
  private readonly root: string;
  private readonly scope: { owner: string; agent: string; applicationSchema: string };
  private readonly configuration: string;
  private readonly prefix: readonly string[];
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private readonly policy: { maxBytes: number; minimumFreeBytes: number; preparationMs: number; plaintextTtlMs: number };
  constructor(private readonly options: { owner: string; agent: string; agentId: string; applicationSchema: string;
    operationId: string; directory: string; imageDigest: string; maxCommands: number; restoreArgvPrefix: readonly string[];
    reader: CystRegistryReader; store: SourceStore; identity: CystWrappingIdentity; client: CheckedClient;
    input: Pick<PaidCystInputClient, 'origin' | 'uploadFile'>; journal: CystCheckpointVault;
    maxBytes: number; minimumFreeBytes: number; preparationMs?: number; plaintextTtlMs?: number }) {
    this.options = Object.freeze({ ...options, restoreArgvPrefix: Object.freeze([...options.restoreArgvPrefix]) });
    cystAddressSchema.parse(options.owner); cystAddressSchema.parse(options.agent); bytes32Schema.parse(options.agentId);
    cystInputDescriptorSchema.shape.operationId.parse(options.operationId);
    if (!isAbsolute(options.directory)) throw new Error('Use an absolute private single-operation directory');
    this.root = resolve(options.directory);
    if (options.input.origin !== options.client.origin) throw new Error('Application restore and binary transport require one reviewed origin');
    this.scope = { owner: cystAddressSchema.parse(options.owner), agent: cystAddressSchema.parse(options.agent),
      applicationSchema: 'agent.file.' + sha(options.agentId).slice(0, 50) };
    this.policy = z.object({ maxBytes: planSchema.shape.plaintextBytes,
      minimumFreeBytes: z.number().int().nonnegative().safe(), preparationMs: z.number().int().min(1000).max(600_000),
      plaintextTtlMs: z.number().int().min(1000).max(1_800_000) }).strict().parse({
      maxBytes: options.maxBytes, minimumFreeBytes: options.minimumFreeBytes,
      preparationMs: options.preparationMs ?? 300_000, plaintextTtlMs: options.plaintextTtlMs ?? 300_000 });
    this.prefix = Object.freeze([...options.restoreArgvPrefix]);
    sessionCommandSchema.parse({ commandId: 'file-restore-validation', argv: [...this.prefix, options.agentId,
      '0x' + '1'.repeat(64), '0x' + '2'.repeat(64), '1', options.operationId, '0'.repeat(64), CYST_INPUT_PATH] });
    paidSessionTaskSchema.parse({ kind: 'session', imageDigest: options.imageDigest, maxCommands: options.maxCommands });
    cystHeaderSchema.shape.applicationSchema.parse(options.applicationSchema);
    this.configuration = canonical({ root: this.root, owner: this.scope.owner, agent: this.scope.agent,
      agentId: options.agentId.toLowerCase(), operationId: options.operationId,
      applicationSchema: options.applicationSchema, imageDigest: options.imageDigest,
      maxCommands: options.maxCommands, prefix: this.prefix, policy: this.policy });
  }
  private recordId(kind: 'plan' | 'ready' | 'target') {
    return 'cyst-hook-' + sha(canonical(['telomere-paid-cyst-file-v1', this.options.operationId, kind]));
  }
  private async load<T extends z.ZodTypeAny>(journal: CystCheckpointJournal, kind: 'plan' | 'ready' | 'target', schema: T): Promise<z.output<T> | undefined> {
    const record = await journal.checkpoint(this.recordId(kind)); if (!record) return undefined;
    try { const bytes = await decryptCheckpoint(record.envelope, record.recoveryKey);
      try { return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
      finally { bytes.fill(0); }
    } finally { record.recoveryKey.fill(0); }
  }
  private async retain(journal: CystCheckpointJournal, kind: 'plan' | 'ready' | 'target', value: unknown) {
    const bytes = Buffer.from(canonical(value)); let encrypted: Awaited<ReturnType<typeof encryptCheckpoint>> | undefined;
    try { encrypted = await encryptCheckpoint(bytes, this.scope); await journal.saveCheckpoint(this.recordId(kind), encrypted); }
    finally { bytes.fill(0); encrypted?.recoveryKey.fill(0); }
  }
  private async directory() {
    try { await mkdir(this.root, { mode: 0o700 }); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    for (let path = this.root; path !== parse(path).root; path = dirname(path)) {
      const info = await lstat(path, { bigint: true }); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Private restore directory changed');
      if (path === this.root && process.platform !== 'win32' && ((info.mode & 0o777n) !== 0o700n
        || typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))) throw new Error('Private restore directory is exposed');
    }
    const marker = join(this.root, '.operation');
    const markerValue = sha(this.configuration);
    try {
      const file = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      try { await file.writeFile(markerValue); await file.sync(); } finally { await file.close(); }
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    const named = await this.privateFile(marker, 64);
    const file = await open(marker, constants.O_RDONLY | noFollow);
    try {
      if (this.identity(named) !== this.identity(await file.stat({ bigint: true }))
        || await file.readFile('utf8') !== markerValue) throw new Error('Private operation directory is already bound');
    } finally { await file.close(); }
    const names = await readdir(this.root);
    if (names.length > 3 || names.some(name => name !== '.operation' && name !== 'state.bin'
      && !/^\.cyst-restore-[a-f0-9-]{36}$/.test(name))) throw new Error('Private operation directory contains unreviewed entries');
  }
  private identity(s: BigIntStats) { return canonical([s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs]); }
  private async privateFile(path: string, exactBytes?: number) {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size < 0n
      || info.size > BigInt(Math.max(this.policy.maxBytes, Buffer.byteLength(this.configuration)))
      || exactBytes !== undefined && info.size !== BigInt(exactBytes)
      || process.platform !== 'win32' && ((info.mode & 0o777n) !== 0o600n
        || typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))) throw new Error('Prepared file is not private and bounded');
    return info;
  }
  private async digest(path: string, exactBytes: number, signal?: AbortSignal) {
    const before = await this.privateFile(path, exactBytes), file = await open(path, constants.O_RDONLY | noFollow);
    try {
      if (this.identity(before) !== this.identity(await file.stat({ bigint: true }))) throw new Error('Prepared file changed while opening');
      const hash = createHash('sha256'), bytes = Buffer.alloc(65_536); let offset = 0;
      try { while (offset < exactBytes) {
        signal?.throwIfAborted(); const part = await file.read(bytes, 0, Math.min(bytes.length, exactBytes - offset), offset);
        if (!part.bytesRead) throw new Error('Prepared file ended early'); hash.update(bytes.subarray(0, part.bytesRead)); offset += part.bytesRead;
      } } finally { bytes.fill(0); }
      if (this.identity(before) !== this.identity(await file.stat({ bigint: true }))
        || this.identity(before) !== this.identity(await this.privateFile(path, exactBytes))) throw new Error('Prepared file changed while reading');
      return hash.digest('hex');
    } finally { await file.close(); }
  }
  private async removePlaintext() {
    await this.directory();
    for (const name of await readdir(this.root)) {
      if (name === '.operation') continue;
      const path = join(this.root, name); await this.privateFile(path); await unlink(path);
    }
  }
  private async current(plan: Plan) {
    await this.options.reader.check();
    const snapshot = cystRegistrySnapshotSchema.parse(await this.options.reader.snapshot(plan.agentId));
    if (snapshot.binding.agentId !== plan.agentId || snapshot.binding.owner.toLowerCase() !== plan.owner
      || snapshot.binding.agentWallet.toLowerCase() !== plan.agent || snapshot.binding.vault.toLowerCase() !== plan.vault
      || snapshot.binding.frozen || snapshot.binding.status === 3 || snapshot.current.revision !== plan.revision
      || !largeCystRegistryMatches(snapshot.current, plan.checkpoint)
      || BigInt(snapshot.current.block.number) < BigInt(plan.blockNumber)
      || snapshot.current.block.number === plan.blockNumber && snapshot.current.block.hash !== plan.blockHash) {
      throw new Error('Original current Cyst or agent binding changed');
    }
  }
  private validPlan(plan: Plan) {
    if (plan.operationId !== this.options.operationId || plan.owner !== this.scope.owner || plan.agent !== this.scope.agent
      || plan.agentId !== this.options.agentId.toLowerCase() || plan.applicationSchema !== this.options.applicationSchema
      || plan.imageDigest !== this.options.imageDigest || plan.maxCommands !== this.options.maxCommands
      || plan.restoreSpecSha256 !== sha(canonical(this.prefix)) || plan.plaintextBytes > this.policy.maxBytes
      || plan.createdAt > Date.now() || plan.expiresAt - plan.createdAt !== this.policy.plaintextTtlMs) throw new Error('Prepared operation changed its reviewed scope');
  }
  private task(descriptor: CystInputDescriptor) {
    return paidSessionTaskSchema.parse({ kind: 'session', imageDigest: this.options.imageDigest,
      maxCommands: this.options.maxCommands, cystInput: descriptor });
  }
  private validReady(plan: Plan, ready: z.infer<typeof readySchema>) {
    const descriptor = cystInputDescriptorSchema.parse({ protocol: 'telomere-cyst-application-file-v1',
      operationId: plan.operationId, agentId: plan.agentId, revision: plan.revision, checkpoint: plan.checkpoint,
      plaintextBytes: plan.plaintextBytes, plaintextSha256: ready.descriptor.plaintextSha256 });
    if (ready.planHash !== sha(canonical(plan)) || canonical(descriptor) !== canonical(ready.descriptor)) throw new Error('Prepared Cyst journal changed its original scope');
  }
  /** Three small encrypted immutable journal records at most; no plaintext or recovery keys are returned. */
  prepare(signal?: AbortSignal) {
    return this.options.journal.exclusive(this.scope, async journal => {
      await this.directory();
      let deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.policy.preparationMs)]);
      let plan = await this.load(journal, 'plan', planSchema);
      const ready = await this.load(journal, 'ready', readySchema);
      if (plan) {
        this.validPlan(plan);
        if (Date.now() >= plan.expiresAt) { await this.removePlaintext(); throw new Error('Prepared plaintext lease expired; use a new explicit operation directory'); }
        deadline = AbortSignal.any([deadline, AbortSignal.timeout(Math.max(1, plan.expiresAt - Date.now()))]);
      }
      if (ready && plan) {
        this.validReady(plan, ready);
        if (ready.descriptor.plaintextSha256 !== await this.digest(join(this.root, 'state.bin'), plan.plaintextBytes, deadline)) {
          throw new Error('Prepared file differs from its immutable authenticated operation');
        }
        await this.current(plan);
        if (Date.now() >= plan.expiresAt) { await this.removePlaintext(); throw new Error('Prepared plaintext lease expired'); }
        deadline.throwIfAborted(); this.arm(plan.expiresAt);
        return { descriptor: ready.descriptor, task: this.task(ready.descriptor), expiresAt: plan.expiresAt };
      }
      if (ready) throw new Error('Prepared Cyst journal is incomplete');
      const resolved = await this.options.store.resolveCurrent(this.options.reader, deadline);
      const checkpoint = largeCystRegistryDescriptorSchema.parse(resolved.checkpoint);
      if (resolved.binding.agentId !== this.options.agentId.toLowerCase() || checkpoint.owner !== this.scope.owner
        || checkpoint.agent !== this.scope.agent || checkpoint.applicationSchema !== this.options.applicationSchema
        || resolved.binding.frozen || resolved.binding.status === 3 || resolved.manifest.header.plaintextBytes > this.policy.maxBytes) {
        throw new Error('Current encrypted Cyst is outside the reviewed application file scope');
      }
      if (!plan) {
        const now = Date.now();
        plan = planSchema.parse({ version: 1, operationId: this.options.operationId, owner: this.scope.owner, agent: this.scope.agent,
          agentId: this.options.agentId, vault: resolved.binding.vault, applicationSchema: this.options.applicationSchema,
          imageDigest: this.options.imageDigest, maxCommands: this.options.maxCommands, restoreSpecSha256: sha(canonical(this.prefix)),
          checkpoint, revision: resolved.current.revision, blockNumber: resolved.current.block.number, blockHash: resolved.current.block.hash,
          plaintextBytes: resolved.manifest.header.plaintextBytes, createdAt: now, expiresAt: now + this.policy.plaintextTtlMs });
        await this.retain(journal, 'plan', plan);
        deadline = AbortSignal.any([deadline, AbortSignal.timeout(Math.max(1, plan.expiresAt - Date.now()))]);
      }
      this.validPlan(plan); await this.current(plan);
      if (canonical(plan.checkpoint) !== canonical(checkpoint) || plan.plaintextBytes !== resolved.manifest.header.plaintextBytes) throw new Error('Incomplete preparation cannot change its checkpoint');
      await this.removePlaintext();
      const free = await statfs(this.root, { bigint: true });
      if (free.bavail * free.bsize < BigInt(plan.plaintextBytes + this.policy.minimumFreeBytes)) throw new Error('Private preparation disk quota/headroom is insufficient');
      const activePlan = plan;
      try {
        await restoreLargeCystFileWithWrappedKey({ store: {
          manifest: async id => { deadline.throwIfAborted(); return id === checkpoint.id ? resolved.manifest : undefined; },
          header: async id => { deadline.throwIfAborted(); return id === checkpoint.id ? resolved.manifest.header : undefined; },
          part: (id, index) => this.options.store.part(id, index, deadline) },
        id: checkpoint.id, destinationPath: join(this.root, 'state.bin'),
        scope: { owner: this.scope.owner, agent: this.scope.agent, applicationSchema: this.options.applicationSchema },
        recipient: 'agent', identity: this.options.identity, beforePublish: async () => {
          deadline.throwIfAborted(); await this.current(activePlan); deadline.throwIfAborted();
          if (Date.now() >= activePlan.expiresAt) throw new Error('Prepared plaintext lease expired');
        } });
        const digest = await this.digest(join(this.root, 'state.bin'), plan.plaintextBytes, deadline);
        await this.current(plan); deadline.throwIfAborted();
        if (Date.now() >= plan.expiresAt) throw new Error('Prepared plaintext lease expired');
        const descriptor = cystInputDescriptorSchema.parse({ protocol: 'telomere-cyst-application-file-v1',
          operationId: this.options.operationId, agentId: plan.agentId, revision: plan.revision,
          checkpoint, plaintextBytes: plan.plaintextBytes, plaintextSha256: digest });
        await this.retain(journal, 'ready', { version: 1, planHash: sha(canonical(plan)), descriptor });
        this.arm(plan.expiresAt); return { descriptor, task: this.task(descriptor), expiresAt: plan.expiresAt };
      } catch (error) { await this.removePlaintext(); throw error; }
    });
  }
  private arm(expiresAt: number) {
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => { void this.dispose().catch(() => undefined); }, Math.max(1, expiresAt - Date.now()));
    this.expiry.unref();
  }
  restore(targetRunId: string, signal?: AbortSignal) {
    const runId = bytes32Schema.parse(targetRunId);
    return this.options.journal.exclusive(this.scope, async journal => {
      await this.directory();
      const plan = await this.load(journal, 'plan', planSchema), ready = await this.load(journal, 'ready', readySchema);
      if (!plan || !ready) throw new Error('Prepare the current encrypted Cyst before paying for a session');
      this.validPlan(plan); this.validReady(plan, ready);
      // Recovery must discard expired authenticated local plaintext even when a
      // later current-registry check rejects this obsolete operation.
      if (Date.now() >= plan.expiresAt) await this.removePlaintext();
      await this.current(plan); signal?.throwIfAborted();
      const config = await this.options.client.config(), run = await this.options.client.get(runId);
      const evidence = await this.options.client.sessionLease(runId), { lease, payload } = parsePaidSessionLease(evidence.lease);
      if (config.binding.vault.toLowerCase() !== plan.vault || config.binding.agentId !== plan.agentId
        || config.binding.agentWallet.toLowerCase() !== plan.agent || run.id !== runId || lease.body.runId !== runId
        || !payload.spec.cystInput || cystInputDescriptorHash(payload.spec.cystInput) !== cystInputDescriptorHash(ready.descriptor)
        || !payload.spec.image.endsWith('@' + plan.imageDigest) || payload.spec.policy.maxCommands !== plan.maxCommands
        || lease.body.owner !== plan.vault || evidence.leaseHash !== hostMessageHash(lease)) throw new Error('Paid target differs from the prepared application file');
      const target = targetSchema.parse({ version: 1, runId, leaseHash: evidence.leaseHash, descriptorHash: cystInputDescriptorHash(ready.descriptor) });
      const prior = await this.load(journal, 'target', targetSchema);
      if (prior && canonical(prior) !== canonical(target)) throw new Error('File restore operation is already bound to another paid Cell');
      if (!prior) await this.retain(journal, 'target', target);
      // Upload client checks a signed committed replay before opening a source file.
      if (Date.now() >= plan.expiresAt) { await this.removePlaintext(); if (!prior) throw new Error('Prepared plaintext lease expired'); }
      const remaining = plan.expiresAt - Date.now();
      const transferSignal = remaining > 0 ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(remaining)]) : signal;
      if (remaining > 0) this.arm(plan.expiresAt);
      await this.options.input.uploadFile(runId, ready.descriptor, join(this.root, 'state.bin'), transferSignal);
      await this.current(plan); signal?.throwIfAborted();
      const receipt = receiptSchema.parse({ protocol: 'telomere-agent-current-cyst-file-restore-v1', agentId: plan.agentId,
        targetRunId: runId, checkpointId: plan.checkpoint.id, revision: plan.revision, operationId: plan.operationId,
        plaintextBytes: ready.descriptor.plaintextBytes, plaintextSha256: ready.descriptor.plaintextSha256 });
      const commandId = 'cf' + sha(canonical([plan.agentId, plan.operationId])).slice(0, 62);
      const command = sessionCommandSchema.parse({ commandId, argv: [...this.prefix, plan.agentId, runId, plan.checkpoint.id,
        plan.revision, plan.operationId, ready.descriptor.plaintextSha256, CYST_INPUT_PATH], stdin: JSON.stringify(receipt) });
      const result = checkedSessionCommand(await this.options.client.command(runId, command), command);
      if (result.state !== 'completed' || result.exitCode !== 0 || result.stderr !== ''
        || canonical(receiptSchema.parse(JSON.parse(result.stdout))) !== canonical(receipt)) throw new Error('Application did not acknowledge its declared restored state');
      await this.current(plan); return { ...receipt, commandId };
    });
  }
  /** Removes only this reviewed operation's private plaintext and partial chunk file. */
  dispose() {
    clearTimeout(this.expiry); this.expiry = undefined;
    return this.options.journal.exclusive(this.scope, () => this.removePlaintext());
  }
}
