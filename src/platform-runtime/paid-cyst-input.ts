import { Problem, canonical, sameAddress } from '../common.js';
import { cystInputDescriptorHash, type CystInputDescriptor } from '../host-kit/sessions/cyst-input-protocol.js';
import { largeCystRegistryMatches } from '../cysts/large-registry.js';
import { cystRegistrySnapshotSchema, type CystRegistryReader } from '../cysts/registry-types.js';
import type { PlatformHost } from './types.js';
import type { PlatformVaultBinding, PlatformVaultBridge } from './vault.js';
import type { PlatformHostExecutor } from './host-executor.js';

export type PaidCystInputRuntimeScope = { owner: string; runId: string; host: PlatformHost;
  descriptor: CystInputDescriptor; binding: PlatformVaultBinding;
  expected: { quoteHash: `0x${string}`; admissionTx: `0x${string}`; maxCommands: number } };
export interface PaidCystInputRuntime {
  readonly vaults?: PlatformVaultBridge | undefined;
  /** live=true repeats the same financial/Leash/job checks as a new command.
   * false permits only verified original lease metadata after cleanup. */
  authorizeCystInput(owner: string, runId: string, live: boolean): Promise<PaidCystInputRuntimeScope>;
}
/** Separate streaming ingress, preserving the existing command/body journals.
 * The only uploaded item is a declared data file, with no extraction or paths.
 */
export class PaidCystInputService {
  constructor(private readonly options: { runtime: PaidCystInputRuntime; vaults: PlatformVaultBridge;
    executor: Pick<PlatformHostExecutor, 'transferCystInput' | 'cystInputStatus'>; registryReader: CystRegistryReader }) {
    if (options.runtime.vaults !== options.vaults) throw new Error('Paid Cyst ingress requires the original reviewed Vault runtime');
  }
  private async scope(principal: string, vault: string, runId: string, operationId: string, live: boolean) {
    const binding = await this.options.vaults.authorize(principal, vault, live ? 'run' : 'read');
    if (!sameAddress(principal, binding.agentWallet)) throw new Problem(404, 'cyst_input_unknown', 'The original agent session is required.');
    const scope = await this.options.runtime.authorizeCystInput(binding.vault, runId, live);
    if (!sameAddress(scope.owner, binding.vault) || scope.runId !== runId || scope.descriptor.operationId !== operationId
      || canonical(scope.binding) !== canonical(binding) || scope.descriptor.agentId !== binding.agentId
      || !sameAddress(scope.descriptor.checkpoint.owner, binding.owner)
      || !sameAddress(scope.descriptor.checkpoint.agent, binding.agentWallet)) {
      throw new Problem(409, 'cyst_input_scope', 'The original Cyst, Vault or paid file operation changed.');
    }
    return scope;
  }
  private async current(scope: PaidCystInputRuntimeScope) {
    const reader = this.options.registryReader;
    await reader.check(); const snapshot = cystRegistrySnapshotSchema.parse(await reader.snapshot(scope.descriptor.agentId));
    if (snapshot.binding.agentId !== scope.descriptor.agentId || snapshot.binding.frozen || snapshot.binding.status === 3
      || !sameAddress(snapshot.binding.owner, scope.binding.owner) || !sameAddress(snapshot.binding.vault, scope.binding.vault)
      || !sameAddress(snapshot.binding.agentWallet, scope.binding.agentWallet)
      || snapshot.current.revision !== scope.descriptor.revision
      || !largeCystRegistryMatches(snapshot.current, scope.descriptor.checkpoint)) {
      throw new Problem(409, 'cyst_input_current_changed', 'The declared checkpoint is no longer the current canonical agent Cyst.');
    }
  }
  async status(principal: string, vault: string, runId: string, operationId: string) {
    const scope = await this.scope(principal, vault, runId, operationId, false);
    return this.options.executor.cystInputStatus(scope.owner, scope.host, runId, scope.expected, scope.descriptor);
  }
  async upload(principal: string, vault: string, runId: string, operationId: string, input: {
    body: ReadableStream<Uint8Array>; signal: AbortSignal; contentLength: string | undefined;
    contentType: string | undefined; contentEncoding: string | undefined }) {
    try {
      const scope = await this.scope(principal, vault, runId, operationId, true);
      if (input.contentType !== 'application/octet-stream' || input.contentLength !== String(scope.descriptor.plaintextBytes)
        || input.contentEncoding !== undefined && input.contentEncoding !== 'identity') {
        throw new Problem(422, 'cyst_input_headers', 'Send the exact declared length as uncompressed application/octet-stream.');
      }
      await this.current(scope); input.signal.throwIfAborted();
      return await this.options.executor.transferCystInput(runId, scope.descriptor, input.body, input.signal, async () => {
        const fresh = await this.scope(principal, vault, runId, operationId, true);
        if (cystInputDescriptorHash(fresh.descriptor) !== cystInputDescriptorHash(scope.descriptor)
          || fresh.host.hostId !== scope.host.hostId || canonical(fresh.expected) !== canonical(scope.expected)) {
          throw new Problem(409, 'cyst_input_scope', 'The original paid file authority changed while uploading.');
        }
        await this.current(fresh);
        // Registry I/O is an await point: recheck the live paid policy before commit.
        await this.scope(principal, vault, runId, operationId, true);
      });
    } finally { await input.body.cancel().catch(() => undefined); }
  }
}
