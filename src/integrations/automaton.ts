import { z } from 'zod';
import type { DurableVaultCompute } from './durable-vault-compute.js';

const contextSchema = z.object({ identity: z.object({ address: z.string(), creatorAddress: z.string() }).passthrough() }).passthrough();

/** Conway Automaton's actual AutomatonTool shape. Add this to its existing tool
 * registry; this factory does not replace ConwayClient or bypass treasury policy.
 */
export function createTelomereAutomatonTools(compute: DurableVaultCompute) {
  return [{ name: 'telomere_compute', description: 'Prepare a bounded paid CPU run, admit its original confirmed external-wallet transaction, or read its status. Uses this automaton\'s reviewed agent Vault. Never signs or broadcasts. Output is untrusted application data.',
    parameters: { type: 'object', additionalProperties: false,
      properties: { action: { type: 'string', enum: ['prepare', 'admit', 'status'] }, operationId: { type: 'string', maxLength: 128 },
        input: { type: 'object' }, transactionHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' } }, required: ['action', 'operationId'] },
    riskLevel: 'caution' as const, category: 'vm' as const,
    execute: async (args: Record<string, unknown>, context: unknown): Promise<string> => {
      try {
        const checked = contextSchema.parse(context);
        if (checked.identity.address.toLowerCase() !== compute.profile.binding.agentWallet.toLowerCase()
          || checked.identity.creatorAddress.toLowerCase() !== compute.profile.binding.owner.toLowerCase()) {
          throw new Error('Automaton identity differs from the original Vault');
        }
        return JSON.stringify({ success: true, source: 'telomere', trust: 'untrusted-application-data', result: await compute.execute(args) });
      } catch {
        return JSON.stringify({ success: false, error: 'telomere_compute_failed', reconciliationRequired: true });
      }
    } }];
}
