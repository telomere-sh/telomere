import { z } from 'zod';
import { bytes32Schema, canonical, hashJson, moneySchema } from '../common.js';
import { cystAddressSchema, cystIdSchema } from '../cysts/types.js';
import { DurableVaultCompute } from '../integrations/durable-vault-compute.js';
import type { PlatformWalletPlan } from '../platform-runtime/client.js';
import { platformPreparedSchema, validatedPlatformQuoteInputSchema } from '../platform-runtime/types.js';
import { TelomereApiError } from '../sdk/transport.js';
import type { ClientLifelineControl } from './lifeline.js';
import type { PaidLifecycleClientVault } from './paid-lifecycle-runner.js';
import { PAID_AGENT_POLICY, type AgentMode } from './types.js';

export const PAID_LIFELINE_FUNDING_SCHEMA = 'telomere-paid-lifeline-funding/v1';
const positiveUnits = moneySchema.refine(value => BigInt(value) > 0n);
/** An explicit finite owner approval, in native USDC units. Reservations consume
 * their entire conservative ceiling; refunds do not replenish this policy. */
export const paidLifelineFundingPolicySchema = z.object({ version: z.literal(1),
  owner: cystAddressSchema, agent: cystAddressSchema, computeProfileHash: bytes32Schema,
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), maxCommands: z.number().int().min(1).max(32),
  leaseSeconds: z.number().int().min(31).max(120), regions: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).min(1).max(32),
  maxReservationCeiling: positiveUnits.refine(value => BigInt(value) <= 250_000_000n),
  maxReservedUnits: positiveUnits, maxReservations: z.number().int().min(1).max(1000),
  notBefore: z.number().int().positive().safe(), expiresAt: z.number().int().positive().safe(),
}).strict().refine(value => value.expiresAt > value.notBefore && value.expiresAt - value.notBefore <= 86400
  && BigInt(value.maxReservedUnits) >= BigInt(value.maxReservationCeiling)
  && BigInt(value.maxReservedUnits) <= BigInt(value.maxReservationCeiling) * BigInt(value.maxReservations),
  'A funding policy needs a finite one-day time and reservation budget');
export type PaidLifelineFundingPolicy = z.infer<typeof paidLifelineFundingPolicySchema>;
export interface PaidLifelineFundingPort {
  /** Persist this operation and its exact calldata before broadcast. No automatic
   * resend under a new operation ID, including after an ambiguous timeout. */
  submit(plan: PlatformWalletPlan, operationId: string, approval: { policy: PaidLifelineFundingPolicy;
    policyHash: string; index: number; ledgerHash: string; totalReserved: string; ceiling: string }): Promise<string>;
  /** Durable lookup of the original wallet operation. Null means unresolved;
   * it never authorizes a second submit of an attempted operation. */
  lookup(operationId: string): Promise<string | null>;
  /** Most recent accepted submit, retained atomically before broadcast. The
   * wallet enforces this finite policy independently of the owner process. */
  anchor(policyHash: string): Promise<{ index: number; ledgerHash: string; totalReserved: string } | null>;
}
const contextSchema = z.object({ version: z.number().int().nonnegative(), currentRunId: bytes32Schema.nullable(),
  checkpointId: cystIdSchema.nullable(), mode: z.enum(['full', 'lean', 'torpor']) }).strict();
const slotSchema = z.object({ version: z.literal(1), policyHash: bytes32Schema, index: z.number().int().min(0).max(999),
  operationId: z.string().regex(/^lifeline-[a-f0-9]{64}$/), context: contextSchema,
  input: validatedPlatformQuoteInputSchema }).strict();
type Slot = z.infer<typeof slotSchema>;
const proposalSchema = z.object({ runId: bytes32Schema, transaction: platformPreparedSchema.shape.transaction,
  ceiling: positiveUnits, expiresAt: z.number().int().positive().safe() }).strict();
type Proposal = z.infer<typeof proposalSchema>;
const budgetSchema = z.object({ policyHash: bytes32Schema, index: z.number().int().nonnegative(),
  previousHash: bytes32Schema, reserved: moneySchema, totalReserved: moneySchema }).strict();
const doneSchema = z.object({ state: z.enum(['admitted', 'retired']), runId: bytes32Schema.nullable() }).strict();
const zeroHash = '0x' + '0'.repeat(64);
type Compute = Pick<DurableVaultCompute, 'profile' | 'prepare' | 'admit' | 'status'>;

/** Optional OWNER process adapter. The controller receives only an admitted run.
 * Both this policy ledger and the wallet's lookup journal must survive restart;
 * neither is a substitute for the on-chain Vault/Leash spending limit. */
export class PaidLifelineReservations {
  readonly policy: Readonly<PaidLifelineFundingPolicy>;
  readonly policyHash: string;
  private readonly now: () => number;
  constructor(private readonly options: { policy: PaidLifelineFundingPolicy; compute: Compute;
    journal: Pick<PaidLifecycleClientVault, 'scope' | 'claim' | 'read' | 'exclusiveOperation'>;
    control: Pick<ClientLifelineControl, 'get'>; wallet: PaidLifelineFundingPort; nowSeconds?: () => number;
    canFund?: () => Promise<boolean> }) {
    const policy = paidLifelineFundingPolicySchema.parse(options.policy);
    this.policy = Object.freeze({ ...policy, regions: Object.freeze([...policy.regions]) as unknown as string[] });
    this.policyHash = hashJson(policy); this.now = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    if (options.journal.scope.owner !== policy.owner || options.journal.scope.agent !== policy.agent
      || options.journal.scope.applicationSchema !== PAID_LIFELINE_FUNDING_SCHEMA
      || options.compute.profile.binding.owner.toLowerCase() !== policy.owner
      || options.compute.profile.binding.agentWallet.toLowerCase() !== policy.agent
      || hashJson(options.compute.profile) !== policy.computeProfileHash) throw new Error('Paid funding approval changed its original owner, agent or deployment');
  }
  private key(index: number, kind: string) { return 'lifeline-funding:' + this.policyHash.slice(2) + ':' + index + ':' + kind; }
  private async claim(key: string, value: unknown) {
    await this.options.journal.claim(key, value);
    if (canonical(await this.options.journal.read(key)) !== canonical(value)) throw new Error('Paid funding ledger failed durable readback');
  }
  private async state(mode: Exclude<AgentMode, 'cyst'>) {
    const state = await this.options.control.get(this.policy.owner, this.policy.agent);
    if (state.agent.owner !== this.policy.owner || state.agent.agent !== this.policy.agent
      || state.policy.maximumLeaseSeconds !== PAID_AGENT_POLICY.maximumLeaseSeconds) throw new Error('Paid funding lifecycle scope changed');
    return { state, context: contextSchema.parse({ version: state.agent.version,
      currentRunId: state.agent.currentRunId, checkpointId: state.agent.checkpointId, mode }) };
  }
  private async slot(index: number): Promise<Slot | undefined> {
    const raw = await this.options.journal.read(this.key(index, 'slot'));
    if (raw === undefined) return undefined;
    const slot = slotSchema.parse(raw);
    if (slot.index !== index || slot.policyHash !== this.policyHash
      || slot.operationId !== 'lifeline-' + hashJson([this.policyHash, index, slot.context]).slice(2)
      || canonical(slot.input) !== canonical(this.input(slot.context, slot.input.deadline))) throw new Error('Paid funding original input changed');
    return slot;
  }
  private input(context: z.infer<typeof contextSchema>, deadline: number) {
    return validatedPlatformQuoteInputSchema.parse({ leashId: this.options.compute.profile.binding.leashId,
      task: { kind: 'session', imageDigest: this.policy.imageDigest, maxCommands: this.policy.maxCommands, resourceProfile: context.mode },
      maxSeconds: this.policy.leaseSeconds, deadline, maxSpend: this.policy.maxReservationCeiling, regions: [...this.policy.regions] });
  }
  /** Prefix append-only slots under one process-shared owner lock. Binary lookup
   * avoids scanning a day's encrypted records on every five-second poll. */
  private async nextIndex() {
    let low = 0, high = this.policy.maxReservations;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (await this.slot(mid)) low = mid + 1; else high = mid; }
    return low;
  }
  private async previousBudget(index: number) {
    if (!index) return { total: 0n, hash: zeroHash };
    const previous = budgetSchema.parse(await this.options.journal.read(this.key(index - 1, 'budget')));
    if (previous.index !== index - 1 || previous.policyHash !== this.policyHash) throw new Error('Paid funding previous budget changed');
    return { total: BigInt(previous.totalReserved), hash: hashJson(previous) };
  }
  private async budget(slot: Slot, reserved: string) {
    const prior = await this.previousBudget(slot.index), total = prior.total + BigInt(reserved);
    if (BigInt(reserved) > BigInt(this.policy.maxReservationCeiling) || total > BigInt(this.policy.maxReservedUnits)) return false;
    await this.claim(this.key(slot.index, 'budget'), budgetSchema.parse({ policyHash: this.policyHash, index: slot.index,
      previousHash: prior.hash, reserved, totalReserved: total.toString() }));
    return true;
  }
  private async checkWalletAnchor() {
    const raw = await this.options.wallet.anchor(this.policyHash);
    if (raw === null) return;
    const anchor = z.object({ index: z.number().int().min(0).max(this.policy.maxReservations - 1),
      ledgerHash: bytes32Schema, totalReserved: moneySchema }).strict().parse(raw);
    const saved = await this.options.journal.read(this.key(anchor.index, 'budget'));
    if (saved === undefined || hashJson(budgetSchema.parse(saved)) !== anchor.ledgerHash
      || budgetSchema.parse(saved).totalReserved !== anchor.totalReserved) {
      throw new Error('Paid funding wallet and owner journal have different recovery points; reconcile before funding');
    }
  }
  private async retire(slot: Slot, proposal?: Proposal) {
    const raw = await this.options.journal.read(this.key(slot.index, 'budget'));
    if (raw === undefined) await this.budget(slot, '0');
    await this.claim(this.key(slot.index, 'done'), { state: 'retired', runId: proposal?.runId ?? null });
  }
  private inWindow() { const now = this.now(); return now >= this.policy.notBefore && now + this.policy.leaseSeconds + 5 < this.policy.expiresAt; }

  /** Compatible with PaidAgentLifeline.approvedTarget. An unresolved broadcast
   * blocks further funding even if the agent's lifecycle version changes. */
  async approvedTarget(owner: string, agent: string, mode: Exclude<AgentMode, 'cyst'> = 'full'): Promise<string | undefined> {
    if (cystAddressSchema.parse(owner) !== this.policy.owner || cystAddressSchema.parse(agent) !== this.policy.agent) throw new Error('Paid funding requested for another agent');
    return this.options.journal.exclusiveOperation('paid-lifeline-funding', async () => {
      await this.claim('lifeline-funding-policy', { policyHash: this.policyHash, policy: this.policy });
      await this.checkWalletAnchor();
      const current = await this.state(mode); let next = await this.nextIndex();
      if (next) {
        const prior = (await this.slot(next - 1))!, rawDone = await this.options.journal.read(this.key(prior.index, 'done'));
        if (rawDone === undefined) return this.finish(prior, current);
        const done = doneSchema.parse(rawDone);
        if (done.state === 'admitted' && canonical(prior.context) === canonical(current.context)
          && !current.state.intent && !current.state.agent.killedAt && this.inWindow()) {
          const run = await this.options.compute.status(prior.operationId);
          if (run.id !== done.runId) throw new Error('Paid funding admitted run changed');
          if (['queued', 'running'].includes(run.status)) return run.id;
        }
      }
      if (next >= this.policy.maxReservations || !this.inWindow() || current.state.intent || current.state.agent.killedAt
        || !current.context.currentRunId && !current.context.checkpointId) return undefined;
      // A complete lease must fit before the approved window closes. Immutable
      // deadline is retained before the first quote request, including failures.
      const deadline = Math.min(this.policy.expiresAt, this.now() + this.policy.leaseSeconds + 60);
      const slot = slotSchema.parse({ version: 1, policyHash: this.policyHash, index: next,
        operationId: 'lifeline-' + hashJson([this.policyHash, next, current.context]).slice(2),
        context: current.context, input: this.input(current.context, deadline) });
      await this.claim(this.key(next, 'slot'), slot); return this.finish(slot, current);
    });
  }
  private async finish(slot: Slot, current: Awaited<ReturnType<PaidLifelineReservations['state']>>): Promise<string | undefined> {
    let rawProposal = await this.options.journal.read(this.key(slot.index, 'proposal'));
    const attempted = await this.options.journal.read(this.key(slot.index, 'attempted'));
    if (attempted !== undefined && attempted !== true) throw new Error('Paid funding submission marker changed');
    const matches = () => canonical(slot.context) === canonical(current.context)
      && !current.state.intent && !current.state.agent.killedAt && this.inWindow();
    if (rawProposal === undefined) {
      if (attempted) throw new Error('Paid funding attempted without its original proposal');
      if (!matches() || this.now() + this.policy.leaseSeconds + 5 >= slot.input.deadline) { await this.retire(slot); return undefined; }
      let prepared: Awaited<ReturnType<Compute['prepare']>>;
      try { prepared = await this.options.compute.prepare(slot.operationId, slot.input); }
      catch (error) {
        if (error instanceof TelomereApiError && [409, 503].includes(error.status)
          && ['deadline_infeasible', 'platform_budget_exceeded', 'platform_host_unavailable'].includes(error.code)) return undefined;
        throw error;
      }
      if (prepared.phase !== 'wallet_required') throw new Error('Paid funding found a transaction without its original wallet ledger');
      rawProposal = proposalSchema.parse({ runId: prepared.runId, transaction: prepared.transaction, ceiling: prepared.ceiling, expiresAt: prepared.expiresAt });
      await this.claim(this.key(slot.index, 'proposal'), rawProposal);
    }
    const proposal = proposalSchema.parse(rawProposal);
    if (!await this.budget(slot, proposal.ceiling)) { await this.retire(slot, proposal); return undefined; }
    let hash = await this.options.journal.read(this.key(slot.index, 'transaction'));
    if (hash === undefined) {
      const found = await this.options.wallet.lookup(slot.operationId);
      if (found !== null) hash = bytes32Schema.parse(found);
      else if (attempted) return undefined;
      else {
        if (this.options.canFund && !await this.options.canFund()) { await this.retire(slot, proposal); return undefined; }
        current = await this.state(slot.context.mode);
        if (!matches() || this.now() + 5 >= proposal.expiresAt) { await this.retire(slot, proposal); return undefined; }
        // Mark before broadcast. An exception or a crash can only be reconciled
        // by lookup; it cannot open a second transaction under a new key.
        await this.claim(this.key(slot.index, 'attempted'), true);
        const budget = budgetSchema.parse(await this.options.journal.read(this.key(slot.index, 'budget')));
        try { hash = bytes32Schema.parse(await this.options.wallet.submit(proposal.transaction, slot.operationId, {
          policy: this.policy, policyHash: this.policyHash, index: slot.index, ledgerHash: hashJson(budget),
          totalReserved: budget.totalReserved, ceiling: proposal.ceiling })); }
        catch { const recovered = await this.options.wallet.lookup(slot.operationId); if (recovered === null) return undefined; hash = bytes32Schema.parse(recovered); }
      }
      await this.claim(this.key(slot.index, 'transaction'), hash);
    }
    const transactionHash = bytes32Schema.parse(hash);
    current = await this.state(slot.context.mode);
    if (!matches()) { await this.retire(slot, proposal); return undefined; }
    // admit persists the original wallet hash before its POST; replay after a
    // lost admission response uses this same quote and transaction.
    const run = await this.options.compute.admit(slot.operationId, transactionHash);
    if (run.id !== proposal.runId || run.admissionTx !== transactionHash || run.ceiling !== proposal.ceiling) throw new Error('Paid funding admission changed its original reservation');
    current = await this.state(slot.context.mode);
    if (!matches() || !['queued', 'running'].includes(run.status)) { await this.retire(slot, proposal); return undefined; }
    await this.claim(this.key(slot.index, 'done'), { state: 'admitted', runId: run.id }); return run.id;
  }

  /** Explicit recovery inventory includes retired funded runs. A stale target
   * is never admitted merely to make it visible: use the checked Vault SDK's
   * refundPlan after its canonical timeout, or stopPlan for an admitted run.
   * The controller already retains every prepared quote for refund recovery. */
  async inventory() {
    return this.options.journal.exclusiveOperation('paid-lifeline-funding', async () => {
      const saved = await this.options.journal.read('lifeline-funding-policy');
      if (saved === undefined) return [];
      if (canonical(saved) !== canonical({ policyHash: this.policyHash, policy: this.policy })) throw new Error('Paid funding policy changed');
      const length = await this.nextIndex(), rows = [];
      for (let index = 0; index < length; index++) {
        const slot = (await this.slot(index))!, proposal = await this.options.journal.read(this.key(index, 'proposal'));
        const done = await this.options.journal.read(this.key(index, 'done'));
        const transaction = await this.options.journal.read(this.key(index, 'transaction'));
        const budget = await this.options.journal.read(this.key(index, 'budget'));
        rows.push({ operationId: slot.operationId, context: slot.context,
          runId: proposal === undefined ? null : proposalSchema.parse(proposal).runId,
          transactionHash: transaction === undefined ? null : bytes32Schema.parse(transaction),
          attempted: await this.options.journal.read(this.key(index, 'attempted')) === true,
          state: done === undefined ? 'pending' as const : doneSchema.parse(done).state,
          reserved: budget === undefined ? '0' : budgetSchema.parse(budget).reserved });
      }
      return rows;
    });
  }
}
