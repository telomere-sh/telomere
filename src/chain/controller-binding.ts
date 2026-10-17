import { eq, getTableName, sql } from 'drizzle-orm';
import { z } from 'zod';
import { addressSchema, hashJson } from '../common.js';
import type { Config } from '../config.js';
import { controllerChainBinding, storeSchema, type Database } from '../store.js';
import { chainForId } from './chains.js';

/** A network migration starts a separate financial database, including owner sessions. */
export async function bindControllerChain(db: Database, config: Config, signer: string): Promise<void> {
  chainForId(config.CHAIN_ID);
  const scopeHash = hashJson({ protocol: 'telomere-controller-chain-v1', mode: config.MODE,
    chainId: config.CHAIN_ID, escrow: config.ESCROW_ADDRESS.toLowerCase(), token: config.TOKEN_ADDRESS.toLowerCase(),
    signer: addressSchema.parse(signer).toLowerCase(), tokenCodeHash: config.TOKEN_CODE_HASH ?? null,
    implementation: config.TOKEN_IMPLEMENTATION_ADDRESS?.toLowerCase() ?? null,
    implementationCodeHash: config.TOKEN_IMPLEMENTATION_CODE_HASH ?? null });
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(728419023, 19473)`);
    const [existing] = await tx.select().from(controllerChainBinding).where(eq(controllerChainBinding.id, 1));
    if (existing) {
      if (existing.scopeHash !== scopeHash || existing.chainId !== config.CHAIN_ID) {
        throw new Error('Controller database belongs to a different chain or reviewed deployment; use a separate database');
      }
      return;
    }
    if (config.MODE !== 'demo') {
      // Disabled optional modules may still retain financial state; only migration-created locks are exempt.
      const migrationLocks = new Set(['x402_lock', 'platform_signer_lock', 'platform_receipt_lock',
        'receipt_hour_lock', 'selection_income_endpoint_lock']);
      for (const table of Object.values(storeSchema)) {
        if (table === controllerChainBinding || migrationLocks.has(getTableName(table))) continue;
        const populated = await tx.select({ present: sql<number>`1` }).from(table).limit(1);
        if (populated.length > 0) {
          throw new Error('Unbound existing public records require their original runtime; Base migration needs a fresh database');
        }
      }
      // Opt-in evidence tables are initialized separately from storeSchema.
      // A disabled publisher must not hide prior network-bound signed records.
      for (const tableName of ['platform_v2_admission_delegations', 'platform_v2_host_admissions',
        'platform_v2_evidence_journal', 'platform_v2_admission_witnesses',
        'platform_v2_publication_journal', 'platform_v2_issuance_drafts']) {
        const table = z.object({ rows: z.array(z.object({ present: z.string().nullable() })) })
          .parse(await tx.execute(sql`SELECT to_regclass(${tableName})::text AS present`));
        if (table.rows[0]?.present) {
          const populated = await tx.select({ present: sql<number>`1` }).from(sql`${sql.identifier(tableName)}`).limit(1);
          if (populated.length) throw new Error('Unbound existing optional public evidence requires its original runtime; Base migration needs a fresh database');
        }
      }
    }
    await tx.insert(controllerChainBinding).values({ id: 1, scopeHash, chainId: config.CHAIN_ID });
  });
}
