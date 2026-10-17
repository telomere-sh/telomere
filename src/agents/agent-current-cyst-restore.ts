import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { keccak256, toHex } from 'viem';
import { z } from 'zod';
import { bytes32Schema, canonical } from '../common.js';
import { restoreLargeCystFileWithWrappedKey } from '../cysts/large-checkpoints.js';
import { largeCystRegistryDescriptorSchema, largeCystRegistryMatches } from '../cysts/large-registry.js';
import { cystRegistryHashSchema, cystRegistrySnapshotSchema, type CystRegistryReader } from '../cysts/registry-types.js';
import { cystAddressSchema, cystHeaderSchema, cystIdSchema } from '../cysts/types.js';
import { sessionCommandSchema } from '../host-kit/sessions/types.js';
import { paidSessionTaskSchema, parsePaidSessionLease } from '../host-kit/sessions/paid-protocol.js';
import { platformWorkloadHash } from '../platform-runtime/types.js';
import type { PlatformVaultRuntimeClient } from '../platform-runtime/vault-client.js';
import { checkedSessionCommand } from '../platform-runtime/session-client.js';
import type { CystCheckpointVault } from '../sdk/cyst-checkpoints.js';
import { decryptCheckpoint, encryptCheckpoint } from '../sdk/cysts.js';
import type { CystWrappingIdentity } from '../sdk/cyst-key-wrap.js';
import type { LargeCystAgentManifestStore } from '../sdk/large-cyst-agent-manifest.js';

/** Existing paid-session stdin is 8 KiB; larger Cysts require a new ingress protocol. */
export const AGENT_CURRENT_CYST_RESTORE_MAX_BYTES = 4096;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const operationIdSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const imageDigestSchema = paidSessionTaskSchema.shape.imageDigest;
const bindingSchema = z.object({ protocol: z.literal('telomere-agent-current-cyst-paid-restore-v1'),
  owner: cystAddressSchema, agent: cystAddressSchema, agentId: cystRegistryHashSchema,
  vault: cystAddressSchema, targetRunId: bytes32Schema, checkpointId: cystIdSchema,
  revision: z.string().regex(/^[1-9][0-9]*$/), sourceBlockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
  sourceBlockHash: cystRegistryHashSchema, checkpoint: largeCystRegistryDescriptorSchema,
  applicationSchema: cystHeaderSchema.shape.applicationSchema,
  imageDigest: imageDigestSchema, maxCommands: z.number().int().min(1).max(32),
  restoreOperationId: operationIdSchema, restoreSpecSha256: hex64, stateSha256: hex64,
}).strict();
type Binding = z.infer<typeof bindingSchema>;
const receiptSchema = z.object({ protocol: z.literal('telomere-agent-current-cyst-restore-v1'),
  agentId: cystRegistryHashSchema, targetRunId: bytes32Schema, checkpointId: cystIdSchema,
  revision: z.string().regex(/^[1-9][0-9]*$/), restoreOperationId: operationIdSchema,
  stateSha256: hex64 }).strict();
export type AgentCurrentCystRestoreReceipt = z.infer<typeof receiptSchema> & { commandId: string };
export type AgentCurrentCystRestoreInput = { targetRunId: string; restoreOperationId: string };

/** Original-agent-only, opt-in application-state restore into an already paid CPU
 * session. The agent controls its private X25519 key and encrypted operation
 * journal. Plaintext intentionally enters the reviewed Host Kit command stdin.
 */
export class AgentCurrentCystPaidRestore {
  private readonly owner: string;
  private readonly agent: string;
  private readonly agentId: string;
  private readonly applicationSchema: string;
  private readonly imageDigest: string;
  private readonly maxCommands: number;
  private readonly restoreArgvPrefix: readonly string[];
  private readonly restoreSpecSha256: string;
  private readonly reader: CystRegistryReader;
  private readonly store: LargeCystAgentManifestStore;
  private readonly identity: CystWrappingIdentity;
  private readonly client: Pick<PlatformVaultRuntimeClient, 'config' | 'get' | 'command'> & Partial<Pick<PlatformVaultRuntimeClient, 'sessionLease'>>;
  private readonly journal: CystCheckpointVault;
  private readonly temporaryDirectory: string;

  constructor(options: { owner: string; agent: string; agentId: string; applicationSchema: string;
    imageDigest: string; maxCommands: number; restoreArgvPrefix: readonly string[];
    reader: CystRegistryReader; store: LargeCystAgentManifestStore; identity: CystWrappingIdentity;
    client: Pick<PlatformVaultRuntimeClient, 'config' | 'get' | 'command'> & Partial<Pick<PlatformVaultRuntimeClient, 'sessionLease'>>;
    journal: CystCheckpointVault; temporaryDirectory: string }) {
    this.owner = cystAddressSchema.parse(options.owner);
    this.agent = cystAddressSchema.parse(options.agent);
    this.agentId = cystRegistryHashSchema.parse(options.agentId);
    this.applicationSchema = cystHeaderSchema.shape.applicationSchema.parse(options.applicationSchema);
    const task = paidSessionTaskSchema.parse({ kind: 'session', imageDigest: options.imageDigest,
      maxCommands: options.maxCommands });
    this.imageDigest = task.imageDigest; this.maxCommands = task.maxCommands;
    this.restoreArgvPrefix = Object.freeze([...options.restoreArgvPrefix]);
    sessionCommandSchema.parse({ commandId: 'restore-validation', argv: [...this.restoreArgvPrefix,
      this.agentId, '0x' + '1'.repeat(64), '0x' + '2'.repeat(64), '1', 'restore-validation', '0'.repeat(64)] });
    this.restoreSpecSha256 = sha256(JSON.stringify(['telomere-agent-current-cyst-restore-command-v1', this.restoreArgvPrefix]));
    if (!options.reader || !options.store || !options.identity || !options.client || !options.journal
      || typeof options.store.resolveCurrent !== 'function' || typeof options.client.command !== 'function'
      || typeof options.journal.exclusive !== 'function' || !options.temporaryDirectory) {
      throw new Error('Supply reviewed registry, authenticated agent clients and a private durable journal');
    }
    this.reader = options.reader; this.store = options.store; this.identity = options.identity;
    if (!isAbsolute(options.temporaryDirectory)) throw new Error('Use an absolute private restore directory');
    this.client = options.client; this.journal = options.journal; this.temporaryDirectory = resolve(options.temporaryDirectory);
  }

  private scope() {
    return { owner: this.owner, agent: this.agent,
      // Stable across application-schema changes: the immutable record itself
      // binds the schema, so one agent cannot reuse an operation ID for a new one.
      applicationSchema: 'agent.restore.' + sha256(this.agentId).slice(0, 50) };
  }
  private recordId(operationId: string): string {
    return 'cyst-hook-' + sha256(JSON.stringify(['telomere-agent-current-cyst-restore-record-v1', operationId]));
  }
  private async existing(operationId: string): Promise<Binding | undefined> {
    return this.journal.exclusive(this.scope(), async journal => {
      const record = await journal.checkpoint(this.recordId(operationId));
      if (!record) return undefined;
      try {
        const bytes = await decryptCheckpoint(record.envelope, record.recoveryKey);
        try { return bindingSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
        finally { bytes.fill(0); }
      } finally { record.recoveryKey.fill(0); }
    });
  }

  private async current(expected: Pick<Binding, 'checkpoint' | 'revision' | 'sourceBlockNumber' | 'sourceBlockHash' | 'vault'>) {
    await this.reader.check();
    const fresh = cystRegistrySnapshotSchema.parse(await this.reader.snapshot(this.agentId));
    if (fresh.binding.agentId !== this.agentId || fresh.binding.owner.toLowerCase() !== this.owner
      || fresh.binding.agentWallet.toLowerCase() !== this.agent || fresh.binding.status === 3
      || fresh.binding.frozen || !largeCystRegistryMatches(fresh.current, expected.checkpoint)) {
      throw new Error('Current registered checkpoint or agent binding changed');
    }
    if (fresh.binding.vault.toLowerCase() !== expected.vault
      || fresh.current.revision !== expected.revision
      || BigInt(fresh.current.block.number) < BigInt(expected.sourceBlockNumber)
      || fresh.current.block.number === expected.sourceBlockNumber
        && fresh.current.block.hash !== expected.sourceBlockHash) {
      throw new Error('Current registered checkpoint revision or canonical block changed');
    }
    return fresh;
  }

  private async bind(candidate: Binding): Promise<{ binding: Binding; created: boolean }> {
    const scope = this.scope();
    const recordId = this.recordId(candidate.restoreOperationId);
    return this.journal.exclusive(scope, async journal => {
      let record = await journal.checkpoint(recordId), created = false;
      if (!record) {
        const bytes = Buffer.from(JSON.stringify(candidate));
        let encrypted: Awaited<ReturnType<typeof encryptCheckpoint>> | undefined;
        try { encrypted = await encryptCheckpoint(bytes, scope); await journal.saveCheckpoint(recordId, encrypted); }
        finally { bytes.fill(0); encrypted?.recoveryKey.fill(0); }
        record = await journal.checkpoint(recordId); created = true;
      }
      if (!record) throw new Error('Agent journal did not retain the restore operation');
      try {
        const bytes = await decryptCheckpoint(record.envelope, record.recoveryKey);
        try {
          const prior = bindingSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
          const { sourceBlockNumber: _number, sourceBlockHash: _hash, ...saved } = prior;
          const { sourceBlockNumber: _newNumber, sourceBlockHash: _newHash, ...requested } = candidate;
          if (canonical(saved) !== canonical(requested)
            || BigInt(candidate.sourceBlockNumber) < BigInt(prior.sourceBlockNumber)
            || candidate.sourceBlockNumber === prior.sourceBlockNumber
              && candidate.sourceBlockHash !== prior.sourceBlockHash) {
            throw new Error('Restore operation is already bound to another checkpoint, Cell or command');
          }
          return { binding: prior, created };
        } finally { bytes.fill(0); }
      } finally { record.recoveryKey.fill(0); }
    });
  }

  async restore(raw: AgentCurrentCystRestoreInput): Promise<AgentCurrentCystRestoreReceipt> {
    const targetRunId = bytes32Schema.parse(raw.targetRunId), restoreOperationId = operationIdSchema.parse(raw.restoreOperationId);
    const resolved = await this.store.resolveCurrent(this.reader);
    const descriptor = largeCystRegistryDescriptorSchema.parse(resolved.checkpoint);
    if (resolved.binding.agentId !== this.agentId || resolved.binding.owner.toLowerCase() !== this.owner
      || resolved.binding.agentWallet.toLowerCase() !== this.agent || resolved.binding.status === 3
      || resolved.binding.frozen || descriptor.applicationSchema !== this.applicationSchema
      || descriptor.owner !== this.owner || descriptor.agent !== this.agent
      || resolved.manifest.header.plaintextBytes < 1
      || resolved.manifest.header.plaintextBytes > AGENT_CURRENT_CYST_RESTORE_MAX_BYTES) {
      throw new Error('Current Cyst does not fit the reviewed agent restore scope');
    }
    const vault = resolved.binding.vault.toLowerCase();
    // The authenticated Vault client checks its deployment pins and original agent session.
    const config = await this.client.config(), run = await this.client.get(targetRunId);
    let workloadHash = platformWorkloadHash({ task: { kind: 'session',
      imageDigest: this.imageDigest, maxCommands: this.maxCommands } });
    // The legacy full/standard hash needs no additional request. New profiles
    // and lanes must come from the authenticated SDK's checked signed lease.
    if (workloadHash !== run.quote.workloadHash && this.client.sessionLease) {
      const evidence = await this.client.sessionLease(targetRunId);
      const { lease, payload } = parsePaidSessionLease(evidence.lease);
      if (evidence.hostId !== run.quote.hostId || lease.body.runId !== targetRunId
        || lease.body.owner.toLowerCase() !== vault || lease.body.maxSeconds !== run.quote.maxSeconds
        || !lease.body.image.endsWith('@' + this.imageDigest) || payload.spec.policy.maxCommands !== this.maxCommands
        || payload.admissionTx !== run.admissionTx) throw new Error('Current Cyst target lease changed');
      workloadHash = platformWorkloadHash({ task: { kind: 'session', imageDigest: this.imageDigest,
        maxCommands: this.maxCommands, ...(payload.resourceProfile === undefined ? {} : { resourceProfile: payload.resourceProfile }) },
        ...(payload.cpuScheduling === undefined ? {} : { cpuScheduling: payload.cpuScheduling }) });
    }
    const previous = await this.existing(restoreOperationId);
    if (previous && (previous.targetRunId !== targetRunId || previous.vault !== vault
      || previous.agentId !== this.agentId || previous.owner !== this.owner || previous.agent !== this.agent
      || previous.checkpointId !== resolved.checkpointId || previous.revision !== resolved.current.revision
      || canonical(previous.checkpoint) !== canonical(descriptor)
      || previous.imageDigest !== this.imageDigest || previous.maxCommands !== this.maxCommands
      || previous.restoreSpecSha256 !== this.restoreSpecSha256)) {
      throw new Error('Restore operation is already bound to another checkpoint, Cell or command');
    }
    if (config.binding.agentId !== this.agentId || config.binding.owner.toLowerCase() !== this.owner
      || config.binding.agentWallet.toLowerCase() !== this.agent || config.binding.vault.toLowerCase() !== vault
      || run.id !== targetRunId || run.quote.runId !== targetRunId
      || run.quote.payer.toLowerCase() !== vault || run.quote.leashId !== config.binding.leashId
      || !run.admissionTx
      || run.quote.hwClass !== 0 || run.quote.inferencePrice !== '0'
      || run.quote.imageHash !== keccak256(toHex(this.imageDigest))
      || run.quote.workloadHash !== workloadHash
      || !config.capacity.some(host => host.hostId === run.quote.hostId
        && host.imageDigest === this.imageDigest && host.sessionEnabled === true
        && run.quote.regionHash === keccak256(toHex(host.region)))
      || run.status !== 'running' && !previous) {
      throw new Error('Target run is not the reviewed admitted paid CPU session');
    }
    const work = await mkdtemp(join(this.temporaryDirectory, 'agent-cyst-restore-'));
    if (!resolve(work).startsWith(this.temporaryDirectory + sep)) throw new Error('Restore directory escaped its private root');
    let state: Buffer | undefined;
    try {
      const destinationPath = join(work, 'state.bin');
      await restoreLargeCystFileWithWrappedKey({ store: { header: id => this.store.header(id),
        manifest: async id => id === resolved.checkpointId ? resolved.manifest : undefined,
        part: (id, index) => this.store.part(id, index) },
      id: resolved.checkpointId, destinationPath,
      scope: { owner: this.owner, agent: this.agent, applicationSchema: this.applicationSchema },
      recipient: 'agent', identity: this.identity });
      state = await readFile(destinationPath);
      if (state.byteLength !== resolved.manifest.header.plaintextBytes
        || state.byteLength < 1 || state.byteLength > AGENT_CURRENT_CYST_RESTORE_MAX_BYTES) {
        throw new Error('Restored agent state length changed');
      }
      const stateSha256 = sha256(state);
      await this.current({ checkpoint: descriptor, revision: resolved.current.revision,
        sourceBlockNumber: resolved.current.block.number,
        sourceBlockHash: resolved.current.block.hash, vault });
      const candidate = bindingSchema.parse({ protocol: 'telomere-agent-current-cyst-paid-restore-v1',
        owner: this.owner, agent: this.agent, agentId: this.agentId, vault, targetRunId,
        checkpointId: resolved.checkpointId, revision: resolved.current.revision,
        sourceBlockNumber: resolved.current.block.number, sourceBlockHash: resolved.current.block.hash,
        checkpoint: descriptor, applicationSchema: this.applicationSchema, imageDigest: this.imageDigest,
        maxCommands: this.maxCommands, restoreOperationId, restoreSpecSha256: this.restoreSpecSha256, stateSha256 });
      const { binding, created } = await this.bind(candidate);
      await this.current(binding);
      const latestConfig = await this.client.config(), latestRun = await this.client.get(targetRunId);
      if (latestConfig.binding.agentId !== this.agentId || latestConfig.binding.vault.toLowerCase() !== vault
        || latestConfig.binding.agentWallet.toLowerCase() !== this.agent
        || latestRun.id !== targetRunId || latestRun.quote.runId !== targetRunId
        || latestRun.quote.payer.toLowerCase() !== vault
        || latestRun.quote.leashId !== latestConfig.binding.leashId
        || latestRun.quote.workloadHash !== run.quote.workloadHash || latestRun.quote.imageHash !== run.quote.imageHash
        || latestRun.quote.hostId !== run.quote.hostId || !latestRun.admissionTx
        || !latestConfig.capacity.some(host => host.hostId === run.quote.hostId
          && host.imageDigest === this.imageDigest && host.sessionEnabled === true
          && latestRun.quote.regionHash === keccak256(toHex(host.region)))
        || created && latestRun.status !== 'running') {
        throw new Error('Target paid Cell changed or is no longer runnable');
      }
      // Narrow the inevitable cross-service TOCTOU window to the command call.
      await this.current(binding);
      const commandId = 'ac' + sha256(JSON.stringify(['telomere-agent-current-cyst-restore-v1',
        this.agentId, restoreOperationId])).slice(0, 62);
      const receipt = receiptSchema.parse({ protocol: 'telomere-agent-current-cyst-restore-v1',
        agentId: this.agentId, targetRunId, checkpointId: resolved.checkpointId,
        revision: binding.revision, restoreOperationId, stateSha256 });
      const command = sessionCommandSchema.parse({ commandId,
        argv: [...this.restoreArgvPrefix, this.agentId, targetRunId, resolved.checkpointId,
          binding.revision, restoreOperationId, stateSha256],
        stdin: JSON.stringify({ ...receipt, stateBase64: state.toString('base64') }) });
      const result = checkedSessionCommand(await this.client.command(targetRunId, command), command);
      if (result.state !== 'completed' || result.exitCode !== 0 || result.stderr !== '') {
        throw new Error('Paid agent restore command did not complete cleanly');
      }
      let observed: z.infer<typeof receiptSchema>;
      try { observed = receiptSchema.parse(JSON.parse(result.stdout)); }
      catch { throw new Error('Paid agent restore receipt is invalid'); }
      if (canonical(observed) !== canonical(receipt)) throw new Error('Paid agent restore receipt changed its binding');
      await this.current(binding);
      return { ...receipt, commandId };
    } finally {
      state?.fill(0);
      await rm(work, { recursive: true, force: true });
    }
  }
}
