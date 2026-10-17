import { bytes32Schema, Problem, sameAddress } from '../common.js';
import { platformAdmissionSchema, validatedPlatformQuoteInputSchema } from './types.js';
import { PlatformRuntimeService } from './service.js';
import { PlatformVaultBridge } from './vault.js';

/** An authenticated human/agent principal is never confused with the contract payer. */
export class PlatformVaultRuntimeService {
  constructor(readonly runtime: PlatformRuntimeService, readonly vaults: PlatformVaultBridge) {
    if (runtime.vaults !== vaults) throw new Error('Vault routes require the runtime\'s original reviewed adapter');
  }
  async config(principal: string, vault: string) {
    const binding = await this.vaults.authorize(principal, vault, 'read');
    return { ...this.runtime.publicConfig(), binding, vaultPins: this.vaults.config };
  }
  async balance(principal: string, vault: string) {
    const binding = await this.vaults.authorize(principal, vault, 'read');
    return this.vaults.balance(binding.vault);
  }
  async quote(principal: string, vault: string, raw: unknown, key: string) {
    const input = validatedPlatformQuoteInputSchema.parse(raw);
    const binding = await this.vaults.authorize(principal, vault,
      input.cpuScheduling?.lane === 'interruptible' ? 'owner' : 'run');
    if (input.leashId !== binding.leashId) throw new Problem(409, 'platform_vault_leash_mismatch', 'Use the Vault\'s original Leash.');
    return this.runtime.quote(binding.vault, input, key, binding);
  }
  async admit(principal: string, vault: string, raw: unknown, key: string) {
    // Paid work may be admitted after kill/freeze for zero-work settlement and a refund.
    const binding = await this.vaults.authorize(principal, vault, 'read');
    if (!sameAddress(principal, binding.agentWallet)) throw new Problem(404, 'platform_vault_unknown', 'The reviewed registry has no matching Vault.');
    const input = platformAdmissionSchema.parse(raw), run = await this.runtime.get(binding.vault, input.runId);
    if (run.quote.leashId !== binding.leashId) throw new Problem(404, 'platform_run_not_found', 'Platform run was not found.');
    return this.runtime.admit(binding.vault, input, key);
  }
  async list(principal: string, vault: string) {
    const binding = await this.vaults.authorize(principal, vault, 'read');
    return this.runtime.list(binding.vault);
  }
  async get(principal: string, vault: string, runId: string) {
    const binding = await this.vaults.authorize(principal, vault, 'read');
    return this.runtime.get(binding.vault, runId);
  }
  async sessionLease(principal: string, vault: string, runId: string) {
    const binding = await this.vaults.authorize(principal, vault, 'read');
    const run = await this.runtime.get(binding.vault, runId);
    if (run.quote.leashId !== binding.leashId) throw new Problem(404, 'platform_run_not_found', 'Platform run was not found.');
    return this.runtime.sessionLease(binding.vault, runId);
  }
  async preemptionOptIn(principal: string, vault: string, runId: string, key: string) {
    const binding = await this.vaults.authorize(principal, vault, 'owner');
    const run = await this.runtime.get(binding.vault, runId);
    if (run.quote.leashId !== binding.leashId) throw new Problem(404, 'platform_run_not_found', 'Platform run was not found.');
    return this.runtime.preemptionOptIn(binding.vault, runId, key);
  }
  async preemptionNotice(principal: string, vault: string, runId: string) {
    const binding = await this.vaults.authorize(principal, vault, 'read');
    const run = await this.runtime.get(binding.vault, runId);
    if (run.quote.leashId !== binding.leashId) throw new Problem(404, 'platform_run_not_found', 'Platform run was not found.');
    return this.runtime.preemptionNotice(binding.vault, runId);
  }
  async command(principal: string, vault: string, runId: string, raw: unknown) {
    // Identity is checked here; the runtime applies current Vault/Leash policy only to new live work.
    // This permits a historical same-ID replay after the Vault is frozen or its Leash is killed.
    const binding = await this.vaults.authorize(principal, vault, 'read');
    if (!sameAddress(principal, binding.agentWallet)) throw new Problem(404, 'platform_vault_unknown', 'The reviewed registry has no matching Vault.');
    const run = await this.runtime.get(binding.vault, runId);
    if (run.quote.leashId !== binding.leashId) throw new Problem(404, 'platform_run_not_found', 'Platform run was not found.');
    return this.runtime.command(binding.vault, runId, raw);
  }
  async sessionEvents(principal: string, vault: string, runId: string, afterSequence = -1, limit = 8) {
    const binding = await this.vaults.authorize(principal, vault, 'read');
    const run = await this.runtime.get(binding.vault, runId);
    if (run.quote.leashId !== binding.leashId) throw new Problem(404, 'platform_run_not_found', 'Platform run was not found.');
    return this.runtime.sessionEvents(binding.vault, runId, afterSequence, limit);
  }
  async stopPlan(principal: string, vault: string, runId: string) {
    const binding = await this.vaults.authorize(principal, vault, 'owner');
    await this.runtime.get(binding.vault, runId);
    return this.vaults.stopPlan(binding, bytes32Schema.parse(runId));
  }
  async refundPlan(principal: string, vault: string, runId: string) {
    const binding = await this.vaults.authorize(principal, vault, 'read');
    await this.runtime.get(binding.vault, runId);
    return this.vaults.refundPlan(binding, bytes32Schema.parse(runId));
  }
}
