import { createHash } from 'node:crypto';
import { parseAbi, parseEventLogs, type Hex } from 'viem';
import { z } from 'zod';
import { bytes32Schema, canonical } from '../common.js';
import { cystAddressSchema, cystEnvelopeSchema, cystHeaderSchema, type CystEnvelope } from '../cysts/types.js';
import { sessionCommandSchema } from '../host-kit/sessions/types.js';
import { parsePaidSessionLease } from '../host-kit/sessions/paid-protocol.js';
import type { PlatformBridge } from '../platform-runtime/bridge.js';
import type { PlatformWalletPlan } from '../platform-runtime/client.js';
import { checkedSessionCommand } from '../platform-runtime/session-client.js';
import { platformEscrowAbi } from '../platform-runtime/types.js';
import { platformVaultBindingSchema, type PlatformVaultRuntimeClient } from '../platform-runtime/vault-client.js';
import type { CystCheckpointVault } from '../sdk/cyst-checkpoints.js';
import { decryptCheckpoint, encryptCheckpoint } from '../sdk/cysts.js';
import type { ClientAgentRunner, ClientLifecycleControl, ClientLifecycleVault } from './client.js';
import { PaidSessionCheckpointRunner } from './paid-session-checkpoint.js';
import { intentIdSchema, PAID_AGENT_POLICY } from './types.js';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const operationIdSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.object({ owner: cystAddressSchema, agent: cystAddressSchema,
  applicationSchema: cystHeaderSchema.shape.applicationSchema }).strict();
const bindingSchema = z.object({ protocol: z.literal('telomere-paid-lifecycle-runner-v1'),
  owner: cystAddressSchema, agent: cystAddressSchema, applicationSchema: cystHeaderSchema.shape.applicationSchema,
  intentId: intentIdSchema, sourceRunId: bytes32Schema, targetRunId: bytes32Schema,
  vault: cystAddressSchema, agentId: bytes32Schema, leashId: bytes32Schema,
  imageDigest: digestSchema, sourceHostId: bytes32Schema, targetHostId: bytes32Schema,
  sourceHostKey: bytes32Schema, sourceLeaseHash: bytes32Schema,
  sourceAdmissionTx: bytes32Schema, targetAdmissionTx: bytes32Schema,
  sourceQuoteHash: bytes32Schema, targetQuoteHash: bytes32Schema,
  sourceExpiresAt: z.number().int().positive().safe(),
  checkpointSpecHash: hashSchema, restoreSpecHash: hashSchema }).strict();
type Binding = z.infer<typeof bindingSchema>;
const targetLeaseSchema = z.object({ protocol: z.literal('telomere-paid-lifecycle-target-lease-v1'),
  targetRunId: bytes32Schema, targetHostId: bytes32Schema, targetHostKey: bytes32Schema,
  targetLeaseHash: bytes32Schema, targetExpiresAt: z.number().int().positive().safe() }).strict();
type TargetLease = z.infer<typeof targetLeaseSchema>;
const stopRecordSchema = z.object({ protocol: z.literal('telomere-paid-lifecycle-stop-v1'),
  operationId: operationIdSchema, sourceRunId: bytes32Schema,
  transactionHash: bytes32Schema.nullable() }).strict();
const restoreReceiptSchema = z.object({ protocol: z.literal('telomere-paid-lifecycle-restore-v1'),
  sourceRunId: bytes32Schema, targetRunId: bytes32Schema, intentId: intentIdSchema,
  checkpointId: bytes32Schema, operationId: operationIdSchema, stateSha256: hashSchema }).strict();

/** Existing encrypted, exclusive CystCheckpointVault storage adapted to the
 * lifecycle coordinator's intent/checkpoint lookup contract. The same owner
 * vault also holds immutable runner intents and stop transaction references.
 */
export class PaidLifecycleClientVault implements ClientLifecycleVault {
  readonly scope: z.infer<typeof scopeSchema>;
  constructor(private readonly journal: CystCheckpointVault, options: { owner: string; agent: string; applicationSchema: string }) {
    if (!journal || typeof journal.exclusive !== 'function') throw new Error('A durable private owner vault is required');
    this.scope = scopeSchema.parse(options);
  }
  private id(kind: string, value: string): string {
    return 'cyst-hook-' + sha256(JSON.stringify(['telomere-paid-lifecycle-vault-v1', kind, value]));
  }
  private checked(record: { envelope: CystEnvelope; recoveryKey: Uint8Array }) {
    const envelope = cystEnvelopeSchema.parse(record.envelope);
    if (envelope.owner !== this.scope.owner || envelope.agent !== this.scope.agent
      || envelope.applicationSchema !== this.scope.applicationSchema || record.recoveryKey.byteLength !== 32) {
      throw new Error('Owner vault checkpoint changed its reviewed scope');
    }
    return { envelope, recoveryKey: record.recoveryKey };
  }
  private async readCheckpoint(id: string) {
    return this.journal.exclusive(this.scope, async journal => {
      const record = await journal.checkpoint(id);
      if (!record) return undefined;
      try {
        const valid = this.checked(record);
        const plaintext = await decryptCheckpoint(valid.envelope, valid.recoveryKey);
        plaintext.fill(0);
        return { envelope: valid.envelope, recoveryKey: new Uint8Array(valid.recoveryKey) };
      } finally { record.recoveryKey.fill(0); }
    });
  }
  private async exactSave(id: string, value: { envelope: CystEnvelope; recoveryKey: Uint8Array }) {
    await this.journal.exclusive(this.scope, async journal => {
      const existing = await journal.checkpoint(id);
      if (existing) {
        try {
          if (canonical(existing.envelope) !== canonical(value.envelope)
            || !existing.recoveryKey.every((byte, index) => byte === value.recoveryKey[index])) {
            throw new Error('Owner vault record belongs to another original checkpoint');
          }
        } finally { existing.recoveryKey.fill(0); }
      } else await journal.saveCheckpoint(id, value);
    });
  }
  async getCheckpoint(intentId: string) {
    const record = await this.readCheckpoint(this.id('intent-checkpoint', intentIdSchema.parse(intentId)));
    if (!record) return undefined;
    try {
      // A partial two-record write is repaired before the coordinator can
      // acknowledge an uploaded checkpoint and move to stop.
      await this.exactSave(this.id('checkpoint-id', record.envelope.id), record);
      return { envelope: record.envelope, recoveryKey: new Uint8Array(record.recoveryKey) };
    } finally { record.recoveryKey.fill(0); }
  }
  async putCheckpoint(intentId: string, envelopeValue: CystEnvelope, recoveryKey: Uint8Array): Promise<void> {
    const envelope = cystEnvelopeSchema.parse(envelopeValue), record = this.checked({ envelope, recoveryKey });
    const plaintext = await decryptCheckpoint(record.envelope, record.recoveryKey);
    plaintext.fill(0);
    await this.exactSave(this.id('intent-checkpoint', intentIdSchema.parse(intentId)), record);
    await this.exactSave(this.id('checkpoint-id', envelope.id), record);
  }
  async recoveryKey(checkpointId: string): Promise<Uint8Array> {
    const id = bytes32Schema.parse(checkpointId);
    const record = await this.readCheckpoint(this.id('checkpoint-id', id));
    if (!record || record.envelope.id !== id) throw new Error('Owner vault lacks the original checkpoint recovery key');
    return record.recoveryKey;
  }
  /** Immutable encrypted JSON record; one journal scope has one original pair. */
  async claim(kind: string, value: unknown): Promise<void> {
    const id = this.id('claim', kind);
    await this.journal.exclusive(this.scope, async journal => {
      let record = await journal.checkpoint(id);
      if (!record) {
        const bytes = Buffer.from(JSON.stringify(value));
        let generated: Awaited<ReturnType<typeof encryptCheckpoint>> | undefined;
        try {
          generated = await encryptCheckpoint(bytes, this.scope);
          await journal.saveCheckpoint(id, generated);
        } finally { bytes.fill(0); generated?.recoveryKey.fill(0); }
        record = await journal.checkpoint(id);
      }
      if (!record) throw new Error('Owner vault did not durably bind the original lifecycle operation');
      try {
        const bytes = await decryptCheckpoint(record.envelope, record.recoveryKey);
        try {
          if (canonical(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) !== canonical(value)) {
            throw new Error('Paid lifecycle operation is already bound to different original facts');
          }
        } finally { bytes.fill(0); }
      } finally { record.recoveryKey.fill(0); }
    });
  }
  async read(kind: string): Promise<unknown | undefined> {
    const id = this.id('claim', kind);
    return this.journal.exclusive(this.scope, async journal => {
      const record = await journal.checkpoint(id);
      if (!record) return undefined;
      try {
        const bytes = await decryptCheckpoint(record.envelope, record.recoveryKey);
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
        finally { bytes.fill(0); }
      } finally { record.recoveryKey.fill(0); }
    });
  }
  /** Separate durable lock scope: v2 wallet reconciliation can safely call this
   * vault's existing claim/read methods while holding its operation lock. */
  async exclusiveOperation<T>(kind: string, operation: () => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9:_-]{1,256}$/.test(kind)) throw new Error('Invalid private lifecycle operation lock');
    const scope = { owner: this.scope.owner, agent: this.scope.agent,
      applicationSchema: 'pl2.' + sha256(canonical([this.scope, kind])).slice(0, 60) };
    return this.journal.exclusive(scope, async () => operation());
  }
}

export interface PaidLifecycleStopPort {
  /** External owner wallet submits this exact reviewed plan once for operationId. */
  submit(plan: PlatformWalletPlan, operationId: string): Promise<string>;
  /** Durable wallet-side lookup; absence after an attempted submit is ambiguous. */
  lookup(operationId: string): Promise<string | null>;
}

type PaidClient = Pick<PlatformVaultRuntimeClient, 'config' | 'get' | 'sessionLease' | 'command' | 'sessionEvents' | 'stopPlan'>;
type ReadOnlyChain = Pick<PlatformBridge['public'], 'getChainId' | 'getTransaction' | 'getTransactionReceipt' | 'getBlock' | 'readContract'>;
const stopEventAbi = parseAbi(['event StopRequested(bytes32 indexed runId,uint64 stopAt)']);

/** Owner-side, full CPU migration of one original approved Vault session pair.
 * The owner supplies a separate wallet stop port; this runner never signs,
 * funds, quotes or admits a session. Guest commands are fixed at construction.
 */
export class PaidAgentLifecycleRunner implements ClientAgentRunner {
  private readonly owner: string;
  private readonly agent: string;
  private readonly intentId: string;
  private readonly sourceRunId: string;
  private readonly targetRunId: string;
  private readonly imageDigest: string;
  private readonly client: PaidClient;
  private readonly control: ClientLifecycleControl;
  private readonly vault: PaidLifecycleClientVault;
  private readonly chain: ReadOnlyChain;
  private readonly stopPort: PaidLifecycleStopPort;
  private readonly capture: PaidSessionCheckpointRunner;
  private readonly restoreArgvPrefix: readonly string[];
  private readonly checkpointSpecHash: string;
  private readonly restoreSpecHash: string;
  private readonly now: () => number;

  constructor(options: { owner: string; agent: string; applicationSchema: string; intentId: string; sourceRunId: string; targetRunId: string;
    imageDigest: string; client: PaidClient; control: ClientLifecycleControl; vault: PaidLifecycleClientVault;
    chain: ReadOnlyChain; stopPort: PaidLifecycleStopPort;
    checkpointArgvPrefix: readonly string[]; restoreArgvPrefix: readonly string[]; now?: () => number }) {
    this.owner = cystAddressSchema.parse(options.owner); this.agent = cystAddressSchema.parse(options.agent);
    this.intentId = intentIdSchema.parse(options.intentId);
    this.sourceRunId = bytes32Schema.parse(options.sourceRunId); this.targetRunId = bytes32Schema.parse(options.targetRunId);
    if (this.sourceRunId === this.targetRunId) throw new Error('Paid lifecycle requires two different original sessions');
    this.imageDigest = digestSchema.parse(options.imageDigest);
    if (!options.vault || canonical(options.vault.scope) !== canonical({ owner: this.owner, agent: this.agent,
      applicationSchema: cystHeaderSchema.shape.applicationSchema.parse(options.applicationSchema) }) || !options.stopPort
      || typeof options.stopPort.submit !== 'function' || typeof options.stopPort.lookup !== 'function') {
      throw new Error('Original owner scope, durable vault and external stop port are required');
    }
    this.client = options.client; this.control = options.control; this.vault = options.vault;
    this.chain = options.chain; this.stopPort = options.stopPort; this.now = options.now ?? Date.now;
    this.capture = new PaidSessionCheckpointRunner({ client: options.client,
      argvPrefix: options.checkpointArgvPrefix, maxBytes: 4096 });
    this.restoreArgvPrefix = Object.freeze([...options.restoreArgvPrefix]);
    sessionCommandSchema.parse({ commandId: 'restore-validation', argv: [...this.restoreArgvPrefix,
      this.sourceRunId, this.targetRunId, this.intentId, this.targetRunId, 'restore-validation', '0'.repeat(64)] });
    this.checkpointSpecHash = sha256(JSON.stringify(['telomere-paid-lifecycle-checkpoint-v1', options.checkpointArgvPrefix]));
    this.restoreSpecHash = sha256(JSON.stringify(['telomere-paid-lifecycle-restore-v1', this.restoreArgvPrefix]));
  }

  private async intent(phase: 'checkpoint' | 'stop' | 'attach' | 'resume', operationId: string) {
    if (operationIdSchema.parse(operationId) !== this.intentId + ':' + phase) throw new Error('Lifecycle operation ID changed');
    const state = await this.control.get(this.owner, this.agent), intent = state.intent;
    if (state.policy.maximumLeaseSeconds !== PAID_AGENT_POLICY.maximumLeaseSeconds || !intent
      || intent.id !== this.intentId || intent.owner !== this.owner || intent.agent !== this.agent
      || !['migrate', 'rollover'].includes(intent.kind) || intent.phase !== phase || intent.targetMode !== 'full'
      || intent.sourceRunId !== this.sourceRunId || intent.targetRunId !== this.targetRunId) {
      throw new Error('Original full CPU lifecycle intent changed');
    }
    await this.control.validateExecution(this.owner, intent.id, intent.version, phase);
    return intent;
  }
  private time() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Owner clock is invalid');
    return value;
  }
  private record(kind: string): string { return this.intentId + ':' + kind; }
  private async binding(): Promise<Binding> {
    const config = await this.client.config();
    const scope = platformVaultBindingSchema.parse(config.binding);
    if (scope.owner.toLowerCase() !== this.owner || scope.agentWallet.toLowerCase() !== this.agent
      || config.maxSeconds !== 120) throw new Error('Reviewed Vault owner or agent changed');
    const [source, target, sourceLease] = await Promise.all([
      this.client.get(this.sourceRunId), this.client.get(this.targetRunId),
      this.client.sessionLease(this.sourceRunId),
    ]);
    const sourceBody = parsePaidSessionLease(sourceLease.lease).lease.body;
    const valid = (run: typeof source) => run.id === run.quote.runId && run.admissionTx !== null
      && run.quote.payer.toLowerCase() === scope.vault.toLowerCase()
      && run.quote.leashId === scope.leashId && run.quote.maxSeconds <= 120;
    if (!valid(source) || !valid(target) || sourceLease.hostId !== source.quote.hostId
      || sourceBody.runId !== source.id || sourceBody.owner.toLowerCase() !== scope.vault.toLowerCase()
      || !sourceBody.image.endsWith('@' + this.imageDigest) || sourceBody.maxSeconds !== source.quote.maxSeconds
      || source.quote.hostId === target.quote.hostId
      || !config.capacity.some(host => host.hostId === target.quote.hostId && host.sessionEnabled === true
        && host.imageDigest === this.imageDigest)) {
      throw new Error('Original paid sessions changed Vault, host, image or admission');
    }
    return bindingSchema.parse({ protocol: 'telomere-paid-lifecycle-runner-v1',
      owner: this.owner, agent: this.agent, applicationSchema: this.vault.scope.applicationSchema,
      intentId: this.intentId, sourceRunId: this.sourceRunId, targetRunId: this.targetRunId,
      vault: scope.vault.toLowerCase(), agentId: scope.agentId, leashId: scope.leashId,
      imageDigest: this.imageDigest, sourceHostId: sourceLease.hostId, targetHostId: target.quote.hostId,
      sourceHostKey: sourceBody.hostKey, sourceLeaseHash: sourceLease.leaseHash,
      sourceAdmissionTx: source.admissionTx, targetAdmissionTx: target.admissionTx,
      sourceQuoteHash: sha256(canonical(source.quote)).replace(/^/, '0x'),
      targetQuoteHash: sha256(canonical(target.quote)).replace(/^/, '0x'),
      sourceExpiresAt: sourceBody.expiresAt,
      checkpointSpecHash: this.checkpointSpecHash, restoreSpecHash: this.restoreSpecHash });
  }
  private async original(): Promise<Binding> {
    const fresh = await this.binding();
    await this.vault.claim(this.record('original-pair'), fresh);
    return fresh;
  }
  private async targetReady(binding: Binding): Promise<TargetLease> {
    const [config, run, lease] = await Promise.all([
      this.client.config(), this.client.get(this.targetRunId), this.client.sessionLease(this.targetRunId),
    ]);
    const body = parsePaidSessionLease(lease.lease).lease.body;
    if (run.status !== 'running' || !run.admissionTx || run.admissionTx !== binding.targetAdmissionTx
      || run.id !== this.targetRunId || run.quote.runId !== this.targetRunId
      || run.quote.hostId !== binding.targetHostId || run.quote.payer.toLowerCase() !== binding.vault
      || run.quote.leashId !== binding.leashId
      || lease.hostId !== binding.targetHostId || body.hostKey === binding.sourceHostKey
      || body.runId !== this.targetRunId || !body.image.endsWith('@' + this.imageDigest)
      || body.expiresAt <= this.time() + 5000) {
      throw new Error('Original target paid Cell is no longer live with enough lease time');
    }
    if (await this.chain.getChainId() !== config.pins.chainId) throw new Error('Target reservation chain changed');
    const [onchain, block] = await Promise.all([this.chain.readContract({ address: config.pins.escrowAddress,
      // REASON: The stored run ID is validated by bytes32Schema at construction.
      abi: platformEscrowAbi, functionName: 'getRun', args: [this.targetRunId as Hex] }), this.chain.getBlock()]);
    if (onchain.status !== 1 || onchain.stopAt !== 0n || onchain.payer.toLowerCase() !== binding.vault
      || onchain.hostId !== binding.targetHostId
      || onchain.acceptedExpiry * 1000n <= BigInt(Math.max(this.time(), Number(block.timestamp) * 1000) + 5000)) {
      throw new Error('Original target paid reservation stopped or expired');
    }
    const exact = targetLeaseSchema.parse({ protocol: 'telomere-paid-lifecycle-target-lease-v1',
      targetRunId: this.targetRunId, targetHostId: lease.hostId, targetHostKey: body.hostKey,
      targetLeaseHash: lease.leaseHash, targetExpiresAt: body.expiresAt });
    const saved = await this.vault.read(this.record('target-lease'));
    if (saved && canonical(targetLeaseSchema.parse(saved)) !== canonical(exact)) {
      throw new Error('Original target signed lease changed');
    }
    return exact;
  }
  async checkpoint(sourceRunId: string, operationId: string): Promise<Uint8Array> {
    if (bytes32Schema.parse(sourceRunId) !== this.sourceRunId) throw new Error('Checkpoint source changed');
    await this.intent('checkpoint', operationId);
    const binding = await this.original();
    const source = await this.client.get(this.sourceRunId);
    if (source.status !== 'running') throw new Error('Original source paid Cell is not running');
    const target = await this.client.get(this.targetRunId);
    if (!['queued', 'running'].includes(target.status)) throw new Error('Original approved target is no longer reserved');
    const config = await this.client.config();
    if (await this.chain.getChainId() !== config.pins.chainId) throw new Error('Target reservation chain changed');
    const [onchain, block] = await Promise.all([this.chain.readContract({ address: config.pins.escrowAddress,
      // REASON: The stored run ID is validated by bytes32Schema at construction.
      abi: platformEscrowAbi, functionName: 'getRun', args: [this.targetRunId as Hex] }), this.chain.getBlock()]);
    if (onchain.status !== 1 || onchain.stopAt !== 0n || onchain.payer.toLowerCase() !== binding.vault
      || onchain.hostId !== binding.targetHostId
      || onchain.acceptedExpiry * 1000n <= BigInt(Math.max(this.time(), Number(block.timestamp) * 1000) + 5000)) {
      throw new Error('Original approved target reservation is no longer live');
    }
    await this.intent('checkpoint', operationId);
    return this.capture.checkpoint(this.sourceRunId, operationId);
  }
  private async verifiedStop(hashValue: string, binding: Binding, plan: PlatformWalletPlan): Promise<void> {
    const hash = bytes32Schema.parse(hashValue) as Hex;
    if (await this.chain.getChainId() !== plan.chainId) throw new Error('Stop transaction chain changed');
    const [transaction, receipt] = await Promise.all([
      this.chain.getTransaction({ hash }), this.chain.getTransactionReceipt({ hash }),
    ]);
    const block = await this.chain.getBlock({ blockNumber: receipt.blockNumber });
    if (transaction.hash !== hash || receipt.transactionHash !== hash || receipt.status !== 'success'
      || receipt.blockHash !== block.hash || transaction.chainId !== plan.chainId
      || transaction.from.toLowerCase() !== binding.owner || transaction.to?.toLowerCase() !== binding.vault
      || receipt.to?.toLowerCase() !== binding.vault || transaction.input !== plan.data
      || transaction.value !== 0n || plan.to.toLowerCase() !== binding.vault || plan.value !== '0') {
      throw new Error('Canonical owner stop transaction changed its exact Vault call');
    }
    // The escrow emits StopRequested; its deployment address is supplied by
    // the independently checked Vault config pins, not inferred from the tx.
    const config = await this.client.config();
    const escrowEvents = parseEventLogs({ abi: stopEventAbi, logs: receipt.logs.filter(log =>
      log.address.toLowerCase() === config.pins.escrowAddress.toLowerCase()), strict: true });
    const stopEvents = escrowEvents.filter(event => event.eventName === 'StopRequested'
      && event.args.runId === binding.sourceRunId && event.args.stopAt > 0n);
    if (stopEvents.length !== 1) {
      throw new Error('Original source has no canonical owner stop event');
    }
    const run = await this.chain.readContract({ address: config.pins.escrowAddress,
      abi: platformEscrowAbi, functionName: 'getRun', args: [binding.sourceRunId], blockNumber: receipt.blockNumber });
    if (run.payer.toLowerCase() !== binding.vault || run.hostId !== binding.sourceHostId
      || run.stopAt !== stopEvents[0]!.args.stopAt) throw new Error('On-chain original source stop changed its reservation');
    if ((await this.chain.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) {
      throw new Error('Original stop transaction became noncanonical');
    }
  }
  private async terminalSource() {
    const source = await this.client.get(this.sourceRunId);
    if (!['receipt_pending', 'settling', 'completed'].includes(source.status) || !source.result || !source.settlement) {
      throw new Error('Signed original source cleanup is still uncertain');
    }
    const page = await this.client.sessionEvents(this.sourceRunId, -1, 1);
    if (page.state !== 'cancelled' || page.eventCount < 1) throw new Error('Source paid Cell did not stop cleanly');
    const final = await this.client.sessionEvents(this.sourceRunId, page.eventCount - 2, 1);
    if (final.events[0]?.kind !== 'session_exit') throw new Error('Original source terminal HostKit event is missing');
  }
  private async assertStopped(binding: Binding): Promise<void> {
    const proof = stopRecordSchema.parse(await this.vault.read(this.record('stop-confirmed')));
    if (proof.operationId !== this.intentId + ':stop' || proof.sourceRunId !== this.sourceRunId || !proof.transactionHash) {
      throw new Error('Original source stop proof changed');
    }
    const plan = await this.client.stopPlan(this.sourceRunId, proof.operationId);
    await this.verifiedStop(proof.transactionHash, binding, plan);
    await this.terminalSource();
  }
  async stop(sourceRunId: string, operationId: string): Promise<void> {
    if (bytes32Schema.parse(sourceRunId) !== this.sourceRunId) throw new Error('Stop source changed');
    await this.intent('stop', operationId);
    const binding = await this.original(), plan = await this.client.stopPlan(this.sourceRunId, operationId);
    const stored = await this.vault.read(this.record('stop-transaction'));
    const confirmed = await this.vault.read(this.record('stop-confirmed'));
    let hash: string;
    if (stored) {
      const proof = stopRecordSchema.parse(stored);
      if (proof.operationId !== operationId || proof.sourceRunId !== this.sourceRunId) throw new Error('Original stop operation changed');
      const confirmedProof = confirmed === undefined ? undefined : stopRecordSchema.parse(confirmed);
      if (confirmedProof && (confirmedProof.operationId !== operationId || confirmedProof.sourceRunId !== this.sourceRunId)) {
        throw new Error('Original confirmed stop operation changed');
      }
      hash = confirmedProof?.transactionHash ?? await this.stopPort.lookup(operationId) ?? '';
      if (!hash) throw new Error('Owner stop submission is ambiguous; reconcile the original wallet operation');
    } else {
      if (confirmed) throw new Error('Confirmed stop has no original submission marker');
      await this.vault.claim(this.record('stop-transaction'), stopRecordSchema.parse({ protocol: 'telomere-paid-lifecycle-stop-v1',
        operationId, sourceRunId: this.sourceRunId, transactionHash: null }));
      hash = await this.stopPort.submit(plan, operationId);
    }
    await this.verifiedStop(hash, binding, plan);
    await this.vault.claim(this.record('stop-confirmed'), stopRecordSchema.parse({ protocol: 'telomere-paid-lifecycle-stop-v1',
      operationId, sourceRunId: this.sourceRunId, transactionHash: bytes32Schema.parse(hash) }));
    await this.terminalSource();
  }
  async attach(targetRunId: string, operationId: string): Promise<void> {
    if (bytes32Schema.parse(targetRunId) !== this.targetRunId) throw new Error('Attach target changed');
    await this.intent('attach', operationId);
    const binding = await this.original();
    await this.assertStopped(binding);
    const lease = await this.targetReady(binding);
    await this.vault.claim(this.record('target-lease'), lease);
    await this.vault.claim(this.record('attach'), { protocol: 'telomere-paid-lifecycle-attach-v1',
      operationId, sourceRunId: this.sourceRunId, targetRunId: this.targetRunId,
      targetLeaseHash: lease.targetLeaseHash });
  }
  async resume(targetRunId: string, state: Uint8Array, mode: 'full' | 'lean' | 'torpor', operationId: string): Promise<void> {
    if (bytes32Schema.parse(targetRunId) !== this.targetRunId || mode !== 'full') throw new Error('Only original full CPU target is supported');
    const intent = await this.intent('resume', operationId);
    const binding = await this.original();
    if (!await this.vault.read(this.record('attach'))) throw new Error('Original paid lifecycle phases are incomplete');
    await this.assertStopped(binding);
    const lease = await this.targetReady(binding);
    await this.vault.claim(this.record('target-lease'), lease);
    if (!(state instanceof Uint8Array) || state.byteLength < 1 || state.byteLength > 4096 || !intent.checkpointId) {
      throw new Error('Original lifecycle state exceeds the paid command bound');
    }
    const record = await this.vault.getCheckpoint(this.intentId);
    if (!record) throw new Error('Original lifecycle checkpoint is absent from owner vault');
    try {
      if (record.envelope.id !== intent.checkpointId || record.envelope.sha256 !== intent.checkpointSha256) {
        throw new Error('Lifecycle checkpoint differs from the original owner vault record');
      }
      const originalState = await decryptCheckpoint(record.envelope, record.recoveryKey);
      try { if (sha256(originalState) !== sha256(state)) throw new Error('Lifecycle restore state changed'); }
      finally { originalState.fill(0); }
    } finally { record.recoveryKey.fill(0); }
    const stateSha256 = sha256(state);
    const receipt = restoreReceiptSchema.parse({ protocol: 'telomere-paid-lifecycle-restore-v1',
      sourceRunId: this.sourceRunId, targetRunId: this.targetRunId, intentId: this.intentId,
      checkpointId: intent.checkpointId, operationId, stateSha256 });
    await this.vault.claim(this.record('restore'), { ...receipt, restoreSpecHash: this.restoreSpecHash,
      targetLeaseHash: lease.targetLeaseHash });
    await this.targetReady(binding);
    const commandId = 'lr' + sha256(JSON.stringify(['telomere-paid-lifecycle-restore-v1', this.intentId, operationId])).slice(0, 62);
    const command = sessionCommandSchema.parse({ commandId,
      argv: [...this.restoreArgvPrefix, this.sourceRunId, this.targetRunId, this.intentId,
        intent.checkpointId, operationId, stateSha256],
      stdin: JSON.stringify({ ...receipt, stateBase64: Buffer.from(state).toString('base64') }) });
    // Kill/supersession can happen while reading the Vault or chain. Recheck
    // the same intent immediately before invoking the target guest command.
    await this.intent('resume', operationId);
    const result = checkedSessionCommand(await this.client.command(this.targetRunId, command), command);
    if (result.state !== 'completed' || result.exitCode !== 0 || result.stderr !== '') throw new Error('Paid lifecycle restore did not complete cleanly');
    let observed: z.infer<typeof restoreReceiptSchema>;
    try { observed = restoreReceiptSchema.parse(JSON.parse(result.stdout)); }
    catch { throw new Error('Paid lifecycle restore receipt is invalid'); }
    if (canonical(observed) !== canonical(receipt)) throw new Error('Paid lifecycle restore receipt changed the original state');
  }
  async profile(): Promise<void> { throw new Error('Paid lifecycle CPU profile changes are outside the reviewed full-mode runner'); }
}
