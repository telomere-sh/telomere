import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { addressSchema, bytes32Schema } from '../common.js';
import type { Database } from '../store.js';
import { agents, agentRuntimeBinding } from './schema.js';

const scopeSchema = z.object({ protocol: z.enum(['legacy', 'platform', 'platform_vault']),
  chainId: z.number().int().positive().safe(), escrow: addressSchema, token: addressSchema,
  vaultProfileHash: bytes32Schema.optional() }).strict().superRefine((value, context) => {
  if ((value.protocol === 'platform_vault') !== (value.vaultProfileHash !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Only Vault lifecycle requires an immutable reviewed Vault profile' });
  }
});

/** One financial namespace per lifecycle database; changing it requires a separate reviewed database. */
export function createAgentRuntimeBinding(db: Database, raw: z.input<typeof scopeSchema>) {
  const parsed = scopeSchema.parse(raw);
  const scope = { ...parsed, escrow: parsed.escrow.toLowerCase(), token: parsed.token.toLowerCase() };
  let ready: Promise<void> | undefined;
  async function bind(): Promise<void> {
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(728419023, 19472)`);
      const [existing] = await tx.select().from(agentRuntimeBinding).where(eq(agentRuntimeBinding.id, 1));
      if (existing) {
        if (existing.protocol !== scope.protocol || existing.chainId !== scope.chainId
          || existing.escrow !== scope.escrow || existing.token !== scope.token
          || existing.vaultProfileHash !== (scope.vaultProfileHash ?? null)) {
          throw new Error('Agent lifecycle database belongs to a different reviewed runtime');
        }
        return;
      }
      // Existing unmarked records came from the shipped legacy controller. They cannot be reinterpreted as paid-platform state.
      if (scope.protocol !== 'legacy' && (await tx.select({ owner: agents.owner }).from(agents).limit(1)).length) {
        throw new Error('Unbound existing agents require the original legacy lifecycle runtime');
      }
      await tx.insert(agentRuntimeBinding).values({ id: 1, ...scope });
    });
  }
  return { scope, async ensureReady(): Promise<void> {
    ready ??= bind();
    try { await ready; } catch (error) { ready = undefined; throw error; }
  } };
}
