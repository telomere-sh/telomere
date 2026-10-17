import { z } from 'zod';
import { canonical, hashJson, bytes32Schema } from '../common.js';
import type { PaidLifecycleClientVault } from '../agents/paid-lifecycle-runner.js';
import { PlatformVaultRuntimeClient, platformVaultBindingSchema, platformVaultPinsSchema,
  type PlatformVaultRuntimeConfig } from '../platform-runtime/vault-client.js';
import { platformPinsSchema, platformPreparedSchema, validatedPlatformQuoteInputSchema,
  type PlatformPrepared } from '../platform-runtime/types.js';
import type { PlatformRuntimeRun } from '../platform-runtime/client.js';
import type { FetchTransport } from '../sdk/types.js';

export const FRAMEWORK_COMPUTE_SCHEMA = 'telomere-framework-compute/v1';
const operationId = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
export const frameworkComputeProfileSchema = z.object({ baseUrl: z.string().url(), pins: platformPinsSchema,
  vaultPins: platformVaultPinsSchema, binding: platformVaultBindingSchema,
  cpuReceiptVersion: z.literal(2).optional() }).strict();
export type FrameworkComputeProfile = z.infer<typeof frameworkComputeProfileSchema>;
export type FrameworkComputeJournal = Pick<PaidLifecycleClientVault, 'scope' | 'claim' | 'read'>;
const intentSchema = z.object({ version: z.literal(1), profileHash: bytes32Schema, operationId,
  input: validatedPlatformQuoteInputSchema }).strict();
const transactionRecord = z.object({ runId: bytes32Schema, transactionHash: bytes32Schema }).strict();
export const frameworkComputeCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare'), operationId, input: validatedPlatformQuoteInputSchema }).strict(),
  z.object({ action: z.literal('admit'), operationId, transactionHash: bytes32Schema }).strict(),
  z.object({ action: z.literal('status'), operationId }).strict(),
]);
export type FrameworkComputeCommand = z.infer<typeof frameworkComputeCommandSchema>;
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Immutable encrypted owner records + checked Vault SDK. No signer or broadcast port.
 * claim must atomically retain an exact immutable value before resolving. The supplied
 * PaidLifecycleClientVault provides this on CystCheckpointFileVault's process lock.
 */
export class DurableVaultCompute {
  readonly profile: FrameworkComputeProfile;
  private readonly client: PlatformVaultRuntimeClient;
  private readonly profileHash: string;
  constructor(private readonly options: { profile: FrameworkComputeProfile; journal: FrameworkComputeJournal;
    sessionToken: string; fetch?: FetchTransport; nowSeconds?: () => number }) {
    this.profile = frameworkComputeProfileSchema.parse(options.profile);
    if (!options.journal || typeof options.journal.claim !== 'function' || typeof options.journal.read !== 'function'
      || options.journal.scope.owner.toLowerCase() !== this.profile.binding.owner.toLowerCase()
      || options.journal.scope.agent.toLowerCase() !== this.profile.binding.agentWallet.toLowerCase()
      || options.journal.scope.applicationSchema !== FRAMEWORK_COMPUTE_SCHEMA) throw new Error('Framework compute requires its original private owner journal');
    this.client = new PlatformVaultRuntimeClient({ baseUrl: this.profile.baseUrl, pins: this.profile.pins,
      vaultPins: this.profile.vaultPins, binding: this.profile.binding, vault: this.profile.binding.vault,
      sessionToken: options.sessionToken, ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(this.profile.cpuReceiptVersion === undefined ? {} : { cpuReceiptVersion: this.profile.cpuReceiptVersion }),
      ...(options.nowSeconds === undefined ? {} : { nowSeconds: options.nowSeconds }) });
    this.profile.baseUrl = this.client.origin;
    this.profileHash = hashJson(this.profile);
    freeze(this.profile);
  }
  private record(id: string, stage: string): string { return 'framework:' + operationId.parse(id) + ':' + stage; }
  private key(id: string, stage: string): string { return 'framework-' + hashJson([this.profileHash, operationId.parse(id), stage]).slice(2); }
  private async config(): Promise<PlatformVaultRuntimeConfig> {
    await this.options.journal.claim('framework-profile', this.profile);
    if (canonical(frameworkComputeProfileSchema.parse(await this.options.journal.read('framework-profile'))) !== canonical(this.profile)) {
      throw new Error('Framework compute profile failed durable readback');
    }
    const value = await this.client.config();
    const floor = await this.options.journal.read('framework-cpu-receipt-floor');
    if (floor !== undefined && z.literal(2).parse(floor) > (value.cpuReceiptVersion ?? 1)) {
      throw new Error('Framework compute durable CPU receipt protocol was downgraded');
    }
    if (value.cpuReceiptVersion === 2) {
      await this.options.journal.claim('framework-cpu-receipt-floor', 2);
      if (z.literal(2).parse(await this.options.journal.read('framework-cpu-receipt-floor')) !== 2) {
        throw new Error('Framework compute receipt floor failed durable readback');
      }
    }
    if (canonical(value.binding) !== canonical(this.profile.binding) || canonical(value.pins) !== canonical(this.profile.pins)
      || canonical(value.vaultPins) !== canonical(this.profile.vaultPins)) throw new Error('Framework compute deployment changed');
    return value;
  }
  private async original(id: string): Promise<PlatformPrepared> {
    const intent = intentSchema.parse(await this.options.journal.read(this.record(id, 'intent')));
    const prepared = platformPreparedSchema.parse(await this.options.journal.read(this.record(id, 'prepared')));
    if (intent.operationId !== id || intent.profileHash !== this.profileHash || canonical(prepared.input) !== canonical(intent.input)
      || prepared.quote.leashId !== this.profile.binding.leashId || prepared.quote.payer.toLowerCase() !== this.profile.binding.vault.toLowerCase()) {
      throw new Error('Framework compute original reservation changed');
    }
    return prepared;
  }
  async prepare(idValue: string, raw: unknown) {
    const id = operationId.parse(idValue), input = validatedPlatformQuoteInputSchema.parse(raw);
    if (input.leashId !== this.profile.binding.leashId) throw new Error('Framework compute Leash differs from its original Vault');
    await this.config();
    const intent = intentSchema.parse({ version: 1, profileHash: this.profileHash, operationId: id, input });
    await this.options.journal.claim(this.record(id, 'intent'), intent);
    if (canonical(intentSchema.parse(await this.options.journal.read(this.record(id, 'intent')))) !== canonical(intent)) {
      throw new Error('Framework compute intent failed durable readback');
    }
    let saved = await this.options.journal.read(this.record(id, 'prepared'));
    if (saved === undefined) {
      const prepared = await this.client.quote(input, this.key(id, 'quote'));
      await this.options.journal.claim(this.record(id, 'prepared'), prepared);
      saved = await this.options.journal.read(this.record(id, 'prepared'));
    }
    const prepared = await this.original(id);
    if (canonical(platformPreparedSchema.parse(saved)) !== canonical(prepared)) throw new Error('Framework compute journal failed readback');
    const payment = await this.options.journal.read(this.record(id, 'payment'));
    if (payment !== undefined) {
      const original = transactionRecord.parse(payment);
      if (original.runId !== prepared.quote.runId) throw new Error('Framework compute original transaction changed');
      return { operationId: id, runId: prepared.quote.runId, phase: 'transaction_recorded' as const,
        requiresWallet: false as const, transactionHash: original.transactionHash };
    }
    // Recheck current capacity, expiry, signature and exact calldata before exposing a wallet action.
    const transaction = await this.client.openPlan(prepared);
    return { operationId: id, runId: prepared.quote.runId, phase: 'wallet_required' as const,
      requiresWallet: true as const, transaction, ceiling: prepared.ceiling, expiresAt: prepared.quote.quoteExpiry,
      binding: this.profile.binding, hostId: prepared.quote.hostId, workloadHash: prepared.quote.workloadHash };
  }
  private checked(run: PlatformRuntimeRun, prepared: PlatformPrepared, payment: z.infer<typeof transactionRecord>): PlatformRuntimeRun {
    if (run.id !== prepared.quote.runId || canonical(run.quote) !== canonical(prepared.quote)
      || run.ceiling !== prepared.ceiling || run.admissionTx !== payment.transactionHash) throw new Error('Framework compute observation substituted the original paid run');
    return run;
  }
  async admit(idValue: string, hashValue: string): Promise<PlatformRuntimeRun> {
    const id = operationId.parse(idValue), transactionHash = bytes32Schema.parse(hashValue);
    await this.config(); const prepared = await this.original(id);
    // Persist this exact external wallet outcome before the first admission POST.
    const payment = { runId: prepared.quote.runId, transactionHash };
    await this.options.journal.claim(this.record(id, 'payment'), payment);
    if (canonical(transactionRecord.parse(await this.options.journal.read(this.record(id, 'payment')))) !== canonical(payment)) {
      throw new Error('Framework compute transaction failed durable readback');
    }
    return this.checked(await this.client.admit(payment, this.key(id, 'admit')), prepared, payment);
  }
  async status(idValue: string): Promise<PlatformRuntimeRun> {
    const id = operationId.parse(idValue); await this.config(); const prepared = await this.original(id);
    const payment = transactionRecord.parse(await this.options.journal.read(this.record(id, 'payment')));
    return this.checked(await this.client.get(prepared.quote.runId), prepared, payment);
  }
  async execute(raw: unknown): Promise<unknown> {
    const command = frameworkComputeCommandSchema.parse(raw);
    switch (command.action) {
      case 'prepare': return this.prepare(command.operationId, command.input);
      case 'admit': return this.admit(command.operationId, command.transactionHash);
      case 'status': return this.status(command.operationId);
    }
  }
}
