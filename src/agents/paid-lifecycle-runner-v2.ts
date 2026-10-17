import { createHash } from 'node:crypto';
import { decodeFunctionData, encodeFunctionData, parseAbi, parseEventLogs, type Hex } from 'viem';
import { z } from 'zod';
import { addressSchema, bytes32Schema, canonical, hashJson } from '../common.js';
import { cystAddressSchema, cystHeaderSchema } from '../cysts/types.js';
import { hostMessageHash, verifyHostMessage } from '../host-kit/protocol.js';
import { parsePaidSessionLease } from '../host-kit/sessions/paid-protocol.js';
import { cpuResourceProfileSchema, sessionCommandSchema } from '../host-kit/sessions/types.js';
import type { PlatformBridge } from '../platform-runtime/bridge.js';
import type { PlatformWalletPlan } from '../platform-runtime/client.js';
import { checkedSessionCommand } from '../platform-runtime/session-client.js';
import { platformEscrowAbi, platformWorkloadHash, typedPlatformQuote } from '../platform-runtime/types.js';
import { platformVaultBindingSchema, platformVaultClientAbi, type PlatformVaultRuntimeClient } from '../platform-runtime/vault-client.js';
import { decryptCheckpoint } from '../sdk/cysts.js';
import { lifecycleCheckpointEnvelope, type ClientAgentRunner, type ClientLifecycleControl } from './client.js';
import { PaidLifecycleClientVault, type PaidLifecycleStopPort } from './paid-lifecycle-runner.js';
import { PaidSessionCheckpointRunner } from './paid-session-checkpoint.js';
import { agentModeSchema, intentIdSchema, PAID_AGENT_POLICY } from './types.js';

const operationIdSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const kindSchema = z.enum(['migrate', 'rollover', 'sleep', 'wake', 'kill', 'profile']);
const runBindingSchema = z.object({ runId: bytes32Schema, hostId: bytes32Schema,
  admissionTx: bytes32Schema, quoteHash: bytes32Schema, ceiling: z.string().regex(/^[0-9]+$/) }).strict();
const bindingSchema = z.object({ protocol: z.literal('telomere-paid-lifecycle-runner-v2'),
  owner: cystAddressSchema, agent: cystAddressSchema, applicationSchema: cystHeaderSchema.shape.applicationSchema,
  intentId: intentIdSchema, kind: kindSchema, targetMode: agentModeSchema,
  source: runBindingSchema.nullable(), target: runBindingSchema.nullable(),
  vault: cystAddressSchema, agentId: bytes32Schema, leashId: bytes32Schema,
  imageDigest: digestSchema, chainId: z.number().int().positive().safe(), configHash: bytes32Schema,
  checkpointSpecHash: sha256Schema, restoreSpecHash: sha256Schema }).strict();
type Binding = z.infer<typeof bindingSchema>;
const signedLeaseBindingSchema = z.object({ protocol: z.literal('telomere-paid-lifecycle-lease-v2'),
  runId: bytes32Schema, hostId: bytes32Schema, hostKey: bytes32Schema,
  leaseHash: bytes32Schema, expiresAt: z.number().int().positive().safe(), resourceProfile: cpuResourceProfileSchema }).strict();
const stopRecordSchema = z.object({ protocol: z.literal('telomere-paid-lifecycle-stop-v2'),
  operationId: operationIdSchema, runId: bytes32Schema, planHash: bytes32Schema,
  transactionHash: bytes32Schema.nullable() }).strict();
const checkpointStopSchema = z.object({ protocol: z.literal('telomere-paid-checkpoint-source-stop-v2'),
  checkpointId: bytes32Schema, binding: bindingSchema, proof: stopRecordSchema,
  plan: z.object({ chainId: z.number().int().positive().safe(), to: addressSchema,
    data: z.string().regex(/^0x[a-fA-F0-9]+$/), value: z.literal('0') }).strict() }).strict();
export const paidLifecycleRestoreV2Schema = z.object({ protocol: z.literal('telomere-paid-lifecycle-restore-v2'),
  sourceRunId: bytes32Schema.nullable(), targetRunId: bytes32Schema, intentId: intentIdSchema,
  checkpointId: bytes32Schema, operationId: operationIdSchema, stateSha256: sha256Schema,
  resourceProfile: cpuResourceProfileSchema }).strict();
const stopEventAbi = parseAbi(['event StopRequested(bytes32 indexed runId,uint64 stopAt)']);
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type PaidClient = Pick<PlatformVaultRuntimeClient, 'config' | 'get' | 'sessionLease' | 'command' | 'sessionEvents' | 'stopPlan'>;
type ReadOnlyChain = Pick<PlatformBridge['public'], 'getChainId' | 'getTransaction' | 'getTransactionReceipt' | 'getBlock' | 'readContract'>;

export interface PaidAgentLifecycleRunnerV2Options {
  owner: string; agent: string; applicationSchema: string; intentId: string;
  kind: z.infer<typeof kindSchema>; targetMode: z.infer<typeof agentModeSchema>;
  sourceRunId: string | null; targetRunId: string | null; imageDigest: string;
  client: PaidClient; control: ClientLifecycleControl; vault: PaidLifecycleClientVault;
  chain: ReadOnlyChain; stopPort: PaidLifecycleStopPort;
  checkpointArgvPrefix: readonly string[]; restoreArgvPrefix: readonly string[];
  now?: () => number; minConfirmations?: number;
}

/** Owner-side generalized paid CPU lifecycle. Every target is already admitted;
 * the external wallet stop port is the only transaction writer. */
export class PaidAgentLifecycleRunnerV2 implements ClientAgentRunner {
  private readonly owner: string; private readonly agent: string; private readonly intentId: string;
  private readonly sourceRunId: Hex | null; private readonly targetRunId: Hex | null;
  private readonly kind: z.infer<typeof kindSchema>; private readonly mode: z.infer<typeof agentModeSchema>;
  private readonly imageDigest: string; private readonly capture: PaidSessionCheckpointRunner;
  private readonly restorePrefix: readonly string[]; private readonly checkpointSpecHash: string;
  private readonly restoreSpecHash: string; private readonly now: () => number;
  private readonly depth: number;
  private readonly options: Readonly<PaidAgentLifecycleRunnerV2Options>;
  constructor(options: PaidAgentLifecycleRunnerV2Options) {
    this.options = Object.freeze({ ...options });
    this.owner = cystAddressSchema.parse(options.owner); this.agent = cystAddressSchema.parse(options.agent);
    this.intentId = intentIdSchema.parse(options.intentId); this.kind = kindSchema.parse(options.kind);
    this.mode = agentModeSchema.parse(options.targetMode); this.imageDigest = digestSchema.parse(options.imageDigest);
    this.sourceRunId = options.sourceRunId === null ? null : bytes32Schema.parse(options.sourceRunId);
    this.targetRunId = options.targetRunId === null ? null : bytes32Schema.parse(options.targetRunId);
    if ((['migrate', 'rollover'].includes(this.kind) && (!this.sourceRunId || !this.targetRunId || this.sourceRunId === this.targetRunId || this.mode === 'cyst'))
      || (this.kind === 'sleep' && (!this.sourceRunId || this.targetRunId || this.mode !== 'cyst'))
      || (this.kind === 'wake' && (this.sourceRunId || !this.targetRunId || this.mode === 'cyst'))
      || (this.kind === 'kill' && (this.mode !== 'cyst' || !this.sourceRunId && !this.targetRunId))
      || (this.kind === 'profile' && (!this.sourceRunId || this.targetRunId || this.mode === 'cyst'))) {
      throw new Error('Paid lifecycle kind changed its original source, target or mode');
    }
    if (canonical(options.vault.scope) !== canonical({ owner: this.owner, agent: this.agent,
      applicationSchema: cystHeaderSchema.shape.applicationSchema.parse(options.applicationSchema) })
      || typeof options.stopPort.submit !== 'function' || typeof options.stopPort.lookup !== 'function') {
      throw new Error('Original owner scope, durable vault and external stop port are required');
    }
    this.capture = new PaidSessionCheckpointRunner({ client: options.client, argvPrefix: options.checkpointArgvPrefix, maxBytes: 4096 });
    this.restorePrefix = Object.freeze([...options.restoreArgvPrefix]);
    sessionCommandSchema.parse({ commandId: 'restore-v2-validation', argv: [...this.restorePrefix,
      this.sourceRunId ?? 'none', this.targetRunId ?? 'none', this.intentId, '0x' + '0'.repeat(64), this.intentId + ':resume', '0'.repeat(64), 'full'] });
    this.checkpointSpecHash = sha256(canonical(['telomere-paid-lifecycle-checkpoint-v2', options.checkpointArgvPrefix]));
    this.restoreSpecHash = sha256(canonical(['telomere-paid-lifecycle-restore-v2', this.restorePrefix]));
    this.now = options.now ?? Date.now;
    this.depth = z.number().int().min(1).max(128).parse(options.minConfirmations ?? 12);
  }
  private time(): number {
    const value = this.now(); if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Owner clock is invalid'); return value;
  }
  private record(kind: string): string { return 'v2:' + this.intentId + ':' + kind; }
  private async intent(phase: 'checkpoint' | 'stop' | 'attach' | 'resume' | 'profile', operationId: string, targetStop = false) {
    const expected = this.intentId + ':' + phase + (targetStop ? ':target' : '');
    if (operationIdSchema.parse(operationId) !== expected || targetStop && this.kind !== 'kill') throw new Error('Lifecycle operation ID changed');
    const state = await this.options.control.get(this.owner, this.agent), intent = state.intent;
    if (state.policy.maximumLeaseSeconds !== PAID_AGENT_POLICY.maximumLeaseSeconds || !intent
      || intent.id !== this.intentId || intent.owner !== this.owner || intent.agent !== this.agent || intent.phase !== phase
      || intent.kind !== this.kind || intent.targetMode !== this.mode || intent.sourceRunId !== this.sourceRunId
      || intent.targetRunId !== this.targetRunId) throw new Error('Original paid lifecycle intent changed');
    await this.options.control.validateExecution(this.owner, intent.id, intent.version, phase); return intent;
  }
  private async canonicalReceipt(hash: Hex, destination: string) {
    const receipt = await this.options.chain.getTransactionReceipt({ hash }), block = await this.options.chain.getBlock({ blockNumber: receipt.blockNumber });
    const latest = await this.options.chain.getBlock();
    if (receipt.status !== 'success' || receipt.transactionHash !== hash || receipt.blockHash !== block.hash
      || receipt.to?.toLowerCase() !== destination.toLowerCase() || latest.number < receipt.blockNumber
      || latest.number - receipt.blockNumber + 1n < BigInt(this.depth)) throw new Error('Canonical paid lifecycle transaction is unavailable');
    return receipt;
  }
  private async runBinding(runId: Hex, scope: z.infer<typeof platformVaultBindingSchema>, chainId: number) {
    const run = await this.options.client.get(runId);
    if (run.id !== runId || run.quote.runId !== runId || !run.admissionTx || run.quote.payer.toLowerCase() !== scope.vault.toLowerCase()
      || run.quote.leashId !== scope.leashId || run.quote.maxSeconds > 120 || run.quote.inferencePrice !== '0') throw new Error('Original paid session quote changed');
    const hash = bytes32Schema.parse(run.admissionTx), receipt = await this.canonicalReceipt(hash, scope.vault);
    const transaction = await this.options.chain.getTransaction({ hash });
    const call = decodeFunctionData({ abi: platformVaultClientAbi, data: transaction.input });
    if (transaction.hash !== hash || transaction.chainId !== chainId || transaction.to?.toLowerCase() !== scope.vault.toLowerCase()
      || transaction.value !== 0n || call.functionName !== 'payRun' || canonical(call.args[0]) !== canonical(typedPlatformQuote(run.quote))) {
      throw new Error('Original paid session admission changed its exact quote');
    }
    if ((await this.options.chain.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Original paid session admission became noncanonical');
    return runBindingSchema.parse({ runId, hostId: run.quote.hostId, admissionTx: hash, quoteHash: hashJson(run.quote), ceiling: run.ceiling });
  }
  private async original(): Promise<Binding> {
    const config = await this.options.client.config(), scope = platformVaultBindingSchema.parse(config.binding);
    if (scope.owner.toLowerCase() !== this.owner || scope.agentWallet.toLowerCase() !== this.agent || config.maxSeconds !== 120
      || await this.options.chain.getChainId() !== config.pins.chainId) throw new Error('Reviewed Vault owner, agent or chain changed');
    const source = this.sourceRunId ? await this.runBinding(this.sourceRunId, scope, config.pins.chainId) : null;
    const target = this.targetRunId ? await this.runBinding(this.targetRunId, scope, config.pins.chainId) : null;
    for (const row of [source, target]) if (row && !config.capacity.some(host => host.hostId === row.hostId
      && host.sessionEnabled === true && host.imageDigest === this.imageDigest)) throw new Error('Original paid session image or reviewed host changed');
    const binding = bindingSchema.parse({ protocol: 'telomere-paid-lifecycle-runner-v2', owner: this.owner, agent: this.agent,
      applicationSchema: this.options.vault.scope.applicationSchema, intentId: this.intentId, kind: this.kind, targetMode: this.mode,
      source, target, vault: scope.vault.toLowerCase(), agentId: scope.agentId, leashId: scope.leashId,
      imageDigest: this.imageDigest, chainId: config.pins.chainId,
      configHash: hashJson({ pins: config.pins, vaultPins: config.vaultPins, binding: scope }),
      checkpointSpecHash: this.checkpointSpecHash, restoreSpecHash: this.restoreSpecHash });
    await this.options.vault.claim(this.record('binding'), binding); return binding;
  }
  private async lease(binding: Binding, row: z.infer<typeof runBindingSchema>, live: boolean) {
    const evidence = await this.options.client.sessionLease(row.runId), run = await this.options.client.get(row.runId);
    const { lease, payload } = parsePaidSessionLease(evidence.lease), body = lease.body;
    if (evidence.hostId !== row.hostId || body.runId !== row.runId || body.owner.toLowerCase() !== binding.vault
      || !body.image.endsWith('@' + binding.imageDigest) || payload.quoteHash !== row.quoteHash || payload.admissionTx !== row.admissionTx
      || body.maxSeconds !== run.quote.maxSeconds || hostMessageHash(lease) !== evidence.leaseHash
      || !verifyHostMessage(evidence.controllerKey, 'lease', lease)
      || platformWorkloadHash({ task: { kind: 'session', imageDigest: this.imageDigest, maxCommands: payload.spec.policy.maxCommands,
        ...(payload.resourceProfile === undefined ? {} : { resourceProfile: payload.resourceProfile }) },
        ...(payload.cpuScheduling ? { cpuScheduling: payload.cpuScheduling } : {}) }) !== run.quote.workloadHash) {
      throw new Error('Original signed paid session lease changed');
    }
    const exact = signedLeaseBindingSchema.parse({ protocol: 'telomere-paid-lifecycle-lease-v2', runId: row.runId,
      hostId: row.hostId, hostKey: body.hostKey, leaseHash: evidence.leaseHash, expiresAt: body.expiresAt,
      resourceProfile: payload.resourceProfile ?? 'full' });
    await this.options.vault.claim(this.record('lease-' + row.runId), exact);
    if (live) {
      const config = await this.options.client.config();
      const onchain = await this.options.chain.readContract({ address: config.pins.escrowAddress,
        abi: platformEscrowAbi, functionName: 'getRun', args: [row.runId] });
      const block = await this.options.chain.getBlock();
      if (run.status !== 'running' || body.expiresAt <= this.time() + 5000 || onchain.status !== 1 || onchain.stopAt !== 0n
        || onchain.payer.toLowerCase() !== binding.vault || onchain.hostId !== row.hostId || onchain.workloadHash !== run.quote.workloadHash
        || onchain.acceptedExpiry * 1000n <= BigInt(Math.max(this.time(), Number(block.timestamp) * 1000) + 5000)) {
        throw new Error('Original paid Cell is no longer live with enough lease time');
      }
    }
    return exact;
  }
  private async terminal(row: z.infer<typeof runBindingSchema>) {
    const run = await this.options.client.get(row.runId);
    if (run.cpuDispatch) {
      if (run.cpuDispatch.state !== 'never_dispatched' || !run.cpuDispatch.confirmed || run.cpuDispatch.admissionTx !== row.admissionTx
        || !['completed', 'refunded'].includes(run.status) || run.charged !== '0' || run.refund !== row.ceiling) {
        throw new Error('Original no-dispatch observation lacks confirmed full-refund accounting');
      }
      const config = await this.options.client.config();
      const latest = await this.options.chain.getBlock();
      if (latest.number + 1n < BigInt(this.depth)) throw new Error('Confirmed no-dispatch state is unavailable');
      const anchor = await this.options.chain.getBlock({ blockNumber: latest.number + 1n - BigInt(this.depth) });
      const state = await this.options.chain.readContract({ address: config.pins.escrowAddress, abi: platformEscrowAbi,
        functionName: 'getRun', args: [row.runId], blockNumber: anchor.number });
      if (state.payer.toLowerCase() !== run.quote.payer.toLowerCase() || state.hostId !== row.hostId
        || state.ceiling.toString() !== row.ceiling || !state.hostReleased || state.billableSeconds !== 0n || state.inferenceCharge !== 0n) {
        throw new Error('Original no-dispatch financial completion is not canonical');
      }
      if (run.status === 'refunded' && state.status === 3) {
        if ((await this.options.chain.getBlock({ blockNumber: anchor.number })).hash !== anchor.hash) {
          throw new Error('Original no-dispatch refund became noncanonical');
        }
        return;
      }
      if (!run.settlementTx) throw new Error('Original no-dispatch settlement transaction is unavailable');
      const receipt = await this.canonicalReceipt(bytes32Schema.parse(run.settlementTx), config.pins.escrowAddress);
      const logs = receipt.logs.filter(log => log.address.toLowerCase() === config.pins.escrowAddress.toLowerCase());
      const settled = parseEventLogs({ abi: platformEscrowAbi, eventName: 'RunSettled', logs, strict: true });
      const refunded = parseEventLogs({ abi: platformEscrowAbi, eventName: 'RunRefunded', logs, strict: true });
      if (!(state.status === 2 && settled.some(event => event.args.runId === row.runId && event.args.receiptHash === state.receiptHash
          && event.args.hostAmount === 0n && event.args.platformFee === 0n && event.args.returnedAmount.toString() === row.ceiling)
          || state.status === 3 && refunded.some(event => event.args.runId === row.runId
            && event.args.payer.toLowerCase() === run.quote.payer.toLowerCase() && event.args.amount.toString() === row.ceiling))
        || (await this.options.chain.getBlock({ blockNumber: anchor.number })).hash !== anchor.hash) {
        throw new Error('Original no-dispatch financial completion is not canonical');
      }
      return;
    }
    if (!['receipt_pending', 'settling', 'completed'].includes(run.status) || !run.result || !run.settlement
      || run.settlement.runId !== row.runId) throw new Error('Original paid Cell cleanup is still uncertain');
    const page = await this.options.client.sessionEvents(row.runId, -1, 1);
    if (!['cancelled', 'completed', 'timed_out', 'failed'].includes(page.state) || page.eventCount < 1) {
      throw new Error('Original paid Cell did not stop cleanly');
    }
    const final = await this.options.client.sessionEvents(row.runId, page.eventCount - 2, 1);
    if (final.events[0]?.kind !== 'session_exit') throw new Error('Original terminal HostKit event is missing');
  }
  private async verifiedStop(hash: Hex, binding: Binding, row: z.infer<typeof runBindingSchema>, plan: PlatformWalletPlan) {
    if (await this.options.chain.getChainId() !== binding.chainId || plan.chainId !== binding.chainId
      || plan.to.toLowerCase() !== binding.vault || plan.value !== '0') throw new Error('Original stop plan changed');
    const receipt = await this.canonicalReceipt(hash, binding.vault), tx = await this.options.chain.getTransaction({ hash });
    if (tx.hash !== hash || tx.chainId !== plan.chainId || tx.from.toLowerCase() !== this.owner
      || tx.to?.toLowerCase() !== binding.vault || tx.input !== plan.data || tx.value !== 0n) throw new Error('Canonical owner stop changed its exact call');
    const config = await this.options.client.config(), events = parseEventLogs({ abi: stopEventAbi,
      logs: receipt.logs.filter(log => log.address.toLowerCase() === config.pins.escrowAddress.toLowerCase()), strict: true });
    const stops = events.filter(event => event.args.runId === row.runId && event.args.stopAt > 0n);
    const run = await this.options.chain.readContract({ address: config.pins.escrowAddress, abi: platformEscrowAbi,
      functionName: 'getRun', args: [row.runId], blockNumber: receipt.blockNumber });
    if (stops.length !== 1 || run.payer.toLowerCase() !== binding.vault || run.hostId !== row.hostId
      || run.stopAt !== stops[0]!.args.stopAt || (await this.options.chain.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) {
      throw new Error('Original paid stop event or canonical block changed');
    }
  }
  private async stopPlan(binding: Binding, row: z.infer<typeof runBindingSchema>, operationId: string): Promise<PlatformWalletPlan> {
    const plan = await this.options.client.stopPlan(row.runId, operationId);
    const data = encodeFunctionData({ abi: platformVaultClientAbi, functionName: 'requestStop', args: [row.runId] });
    if (plan.chainId !== binding.chainId || plan.to.toLowerCase() !== binding.vault || plan.value !== '0' || plan.data !== data) {
      throw new Error('Original stop plan changed before wallet submission');
    }
    return plan;
  }
  private async assertStopped(binding: Binding, checkpointId: string | null) {
    if (!binding.source) {
      if (!checkpointId) throw new Error('Wake requires the original stopped checkpoint source');
      const saved = checkpointStopSchema.parse(await this.options.vault.read('v2:checkpoint-source-stop:' + checkpointId));
      const original = saved.binding, source = original.source;
      if (saved.checkpointId !== checkpointId || !source || original.owner !== binding.owner || original.agent !== binding.agent
        || original.vault !== binding.vault || original.agentId !== binding.agentId || original.leashId !== binding.leashId
        || original.chainId !== binding.chainId || original.configHash !== binding.configHash
        || saved.proof.runId !== source.runId || saved.proof.operationId !== original.intentId + ':stop'
        || !saved.proof.transactionHash || saved.proof.planHash !== hashJson(saved.plan)) {
        throw new Error('Wake checkpoint source stop changed its original paid scope');
      }
      // REASON: The private record schema validates the transaction data as hex.
      await this.verifiedStop(saved.proof.transactionHash, original, source, { ...saved.plan, data: saved.plan.data as Hex });
      await this.terminal(source); return;
    }
    const row = binding.source, operationId = this.intentId + ':stop';
    const proof = stopRecordSchema.parse(await this.options.vault.read(this.record('stop-confirmed-' + row.runId)));
    const plan = await this.stopPlan(binding, row, operationId);
    if (proof.operationId !== operationId || proof.runId !== row.runId || !proof.transactionHash || proof.planHash !== hashJson(plan)) {
      throw new Error('Original source stop proof changed');
    }
    await this.verifiedStop(proof.transactionHash, binding, row, plan); await this.terminal(row);
  }
  async checkpoint(runIdValue: string, operationId: string): Promise<Uint8Array> {
    if (bytes32Schema.parse(runIdValue) !== this.sourceRunId) throw new Error('Checkpoint source changed');
    await this.intent('checkpoint', operationId); const binding = await this.original();
    if (!binding.source) throw new Error('Checkpoint source is absent');
    await this.lease(binding, binding.source, true);
    if (binding.target) {
      const target = await this.options.client.get(binding.target.runId);
      if (!['queued', 'running'].includes(target.status)) throw new Error('Original approved target is no longer reserved');
    }
    await this.intent('checkpoint', operationId); return this.capture.checkpoint(binding.source.runId, operationId);
  }
  async stop(runIdValue: string, operationId: string): Promise<void> {
    const runId = bytes32Schema.parse(runIdValue), targetStop = runId !== this.sourceRunId;
    if (targetStop && (this.kind !== 'kill' || runId !== this.targetRunId)) throw new Error('Stop source changed');
    await this.intent('stop', operationId, targetStop); const binding = await this.original();
    const row = targetStop ? binding.target : binding.source; if (!row) throw new Error('Original stop reservation is absent');
    await this.options.vault.exclusiveOperation(this.record('wallet-stop-' + runId), async () => {
      await this.intent('stop', operationId, targetStop);
      const current = await this.options.client.get(runId);
      if (current.cpuDispatch) {
        await this.terminal(row);
        await this.options.vault.claim(this.record('no-dispatch-stop-' + runId), {
          protocol: 'telomere-paid-no-dispatch-stop-v2', operationId, runId, admissionTx: row.admissionTx,
          completionTx: current.settlementTx, fullRefund: current.refund });
        return;
      }
      if (current.status === 'running') await this.lease(binding, row, false);
      const plan = await this.stopPlan(binding, row, operationId), planHash = hashJson(plan);
      const markerKey = this.record('stop-attempt-' + runId), confirmedKey = this.record('stop-confirmed-' + runId);
      const marker = await this.options.vault.read(markerKey), confirmed = await this.options.vault.read(confirmedKey);
      let hash: Hex;
      if (marker) {
        const existing = stopRecordSchema.parse(marker), proof = confirmed === undefined ? undefined : stopRecordSchema.parse(confirmed);
        for (const record of [existing, proof]) if (record && (record.operationId !== operationId || record.runId !== runId || record.planHash !== planHash)) {
          throw new Error('Original stop wallet operation changed');
        }
        const found = proof?.transactionHash ?? await this.options.stopPort.lookup(operationId);
        if (!found) throw new Error('Owner stop submission is ambiguous; reconcile the original wallet operation');
        hash = bytes32Schema.parse(found);
      } else {
        if (confirmed) throw new Error('Confirmed stop has no original submission marker');
        await this.options.vault.claim(markerKey, stopRecordSchema.parse({ protocol: 'telomere-paid-lifecycle-stop-v2',
          operationId, runId, planHash, transactionHash: null }));
        hash = bytes32Schema.parse(await this.options.stopPort.submit(plan, operationId));
      }
      await this.verifiedStop(hash, binding, row, plan);
      await this.options.vault.claim(confirmedKey, stopRecordSchema.parse({ protocol: 'telomere-paid-lifecycle-stop-v2',
        operationId, runId, planHash, transactionHash: hash }));
      await this.terminal(row);
      await this.lease(binding, row, false);
      const stoppedIntent = await this.intent('stop', operationId, targetStop);
      if (!targetStop && stoppedIntent.checkpointId && ['sleep', 'migrate', 'rollover'].includes(this.kind)) {
        await this.options.vault.claim('v2:checkpoint-source-stop:' + stoppedIntent.checkpointId, checkpointStopSchema.parse({
          protocol: 'telomere-paid-checkpoint-source-stop-v2', checkpointId: stoppedIntent.checkpointId, binding,
          proof: { protocol: 'telomere-paid-lifecycle-stop-v2', operationId, runId, planHash, transactionHash: hash },
          plan: { ...plan, to: plan.to.toLowerCase() } }));
      }
    });
  }
  async attach(runIdValue: string, operationId: string): Promise<void> {
    if (bytes32Schema.parse(runIdValue) !== this.targetRunId) throw new Error('Attach target changed');
    const intent = await this.intent('attach', operationId); const binding = await this.original();
    if (!binding.target) throw new Error('Attach target is absent');
    await this.assertStopped(binding, intent.checkpointId); const lease = await this.lease(binding, binding.target, true);
    if (lease.resourceProfile !== this.mode) throw new Error('Approved target resource profile differs from the lifecycle mode');
    await this.options.vault.claim(this.record('attach'), { protocol: 'telomere-paid-lifecycle-attach-v2', operationId,
      targetRunId: binding.target.runId, targetLeaseHash: lease.leaseHash, targetMode: this.mode });
  }
  async resume(runIdValue: string, state: Uint8Array, mode: 'full' | 'lean' | 'torpor', operationId: string): Promise<void> {
    if (bytes32Schema.parse(runIdValue) !== this.targetRunId || mode !== this.mode) throw new Error('Original target run or resource profile changed');
    const intent = await this.intent('resume', operationId), binding = await this.original();
    if (!binding.target || !await this.options.vault.read(this.record('attach')) || !intent.checkpointId
      || !(state instanceof Uint8Array) || state.byteLength < 1 || state.byteLength > 4096) throw new Error('Original lifecycle restore scope is incomplete');
    await this.assertStopped(binding, intent.checkpointId); const lease = await this.lease(binding, binding.target, true);
    if (lease.resourceProfile !== mode) throw new Error('Approved target resource profile differs from the lifecycle mode');
    const key = await this.options.vault.recoveryKey(intent.checkpointId);
    try {
      const downloaded = await this.options.control.download(this.owner, intent.checkpointId), envelope = lifecycleCheckpointEnvelope(downloaded);
      if (envelope.owner !== this.owner || envelope.agent !== this.agent || envelope.id !== intent.checkpointId
        || envelope.applicationSchema !== this.options.vault.scope.applicationSchema
        || intent.checkpointSha256 !== null && envelope.sha256 !== intent.checkpointSha256) throw new Error('Original owner checkpoint scope changed');
      const original = await decryptCheckpoint(envelope, key);
      try { if (sha256(original) !== sha256(state)) throw new Error('Lifecycle restore state changed'); } finally { original.fill(0); }
    } finally { key.fill(0); }
    const receipt = paidLifecycleRestoreV2Schema.parse({ protocol: 'telomere-paid-lifecycle-restore-v2', sourceRunId: this.sourceRunId,
      targetRunId: this.targetRunId, intentId: this.intentId, checkpointId: intent.checkpointId, operationId,
      stateSha256: sha256(state), resourceProfile: mode });
    await this.options.vault.claim(this.record('restore'), { ...receipt, restoreSpecHash: this.restoreSpecHash, targetLeaseHash: lease.leaseHash });
    const command = sessionCommandSchema.parse({ commandId: 'lv' + sha256(canonical([this.intentId, operationId])).slice(0, 62),
      argv: [...this.restorePrefix, this.sourceRunId ?? 'none', this.targetRunId, this.intentId, intent.checkpointId,
        operationId, receipt.stateSha256, mode], stdin: JSON.stringify({ ...receipt, stateBase64: Buffer.from(state).toString('base64') }) });
    await this.intent('resume', operationId); await this.lease(binding, binding.target, true);
    const result = checkedSessionCommand(await this.options.client.command(binding.target.runId, command), command);
    if (result.state !== 'completed' || result.exitCode !== 0 || result.stderr !== '') throw new Error('Paid lifecycle restore did not complete cleanly');
    let observed: z.infer<typeof paidLifecycleRestoreV2Schema>;
    try { observed = paidLifecycleRestoreV2Schema.parse(JSON.parse(result.stdout)); } catch { throw new Error('Paid lifecycle restore receipt is invalid'); }
    if (canonical(observed) !== canonical(receipt)) throw new Error('Paid lifecycle restore receipt changed the original state');
  }
  async profile(runIdValue: string, mode: 'full' | 'lean' | 'torpor', operationId: string): Promise<void> {
    if (bytes32Schema.parse(runIdValue) !== this.sourceRunId || mode !== this.mode) throw new Error('Original paid profile changed');
    await this.intent('profile', operationId); const binding = await this.original();
    if (!binding.source || (await this.lease(binding, binding.source, true)).resourceProfile !== mode) {
      throw new Error('Changing a paid CPU quota requires a new separately approved reservation');
    }
    await this.options.vault.claim(this.record('profile-noop'), { protocol: 'telomere-paid-lifecycle-profile-v2', operationId, runId: this.sourceRunId, resourceProfile: mode });
  }
}
