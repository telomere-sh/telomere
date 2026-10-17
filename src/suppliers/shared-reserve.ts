import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { addressSchema, bytes32Schema, Problem } from '../common.js';
import { FileSupplierLedger, supplierReserveHeld } from './ledger.js';
import { FileNosanaLedger } from './nosana-ledger.js';
import { PrivateSupplierJournal, SupplierJournalLocked } from './private-journal.js';

const positiveAmount = z.string().regex(/^[1-9][0-9]{0,29}$/);
const candidateSchema = z.object({ network: z.enum(['akash', 'nosana']), owner: addressSchema, runId: bytes32Schema,
  reservedUsdcMicros: positiveAmount }).strict();
const sharedStateSchema = z.object({ version: z.literal(1), akashGeneration: z.string().uuid(), nosanaGeneration: z.string().uuid() }).strict();

/**
 * Serializes admissions across two explicitly initialized journals. A missing,
 * unreadable or malformed journal fails closed. An unsubmitted canceled Akash plan
 * releases its local projection; all external, terminal and quarantined rows retain it.
 */
export class FileSupplierSharedReserve {
  private readonly journal: PrivateSupplierJournal<z.infer<typeof sharedStateSchema>>;
  readonly akash: FileSupplierLedger;
  readonly nosana: FileNosanaLedger;
  private readonly ceiling: bigint;

  constructor(options: { lockPath: string; akash: FileSupplierLedger; nosana: FileNosanaLedger;
    maxOpenReservedUsdcMicros: string }) {
    if (!isAbsolute(options.lockPath) || options.lockPath.includes('\0')) throw new Error('Shared supplier lock path is invalid');
    this.akash = options.akash;
    this.nosana = options.nosana;
    this.ceiling = BigInt(positiveAmount.parse(options.maxOpenReservedUsdcMicros));
    const lockPath = resolve(options.lockPath);
    this.journal = new PrivateSupplierJournal({ path: lockPath + '.state', lockPath,
      kind: 'telomere-shared-supplier-reserve-v1', schema: sharedStateSchema, maximum: 256,
      binding: JSON.stringify({ akashPath: this.akash.path, nosanaPath: this.nosana.path, ceiling: this.ceiling.toString() }) });
    const paths = [...this.akash.storagePaths(), ...this.nosana.storagePaths(), ...this.journal.paths()];
    if (new Set(paths).size !== paths.length) throw new Error('Shared supplier journal paths overlap');
  }

  async initializeFresh(): Promise<void> {
    const [akashGeneration, nosanaGeneration] = await Promise.all([this.akash.initializationGeneration(), this.nosana.initializationGeneration()]);
    await this.journal.initializeFresh({ version: 1, akashGeneration, nosanaGeneration });
  }

  async admit<T>(value: { network: 'akash' | 'nosana'; owner: string; runId: string; reservedUsdcMicros: string },
    commit: () => Promise<T>): Promise<T> {
    const candidate = candidateSchema.parse(value);
    try {
      return await this.journal.transact(async (state, uncertain) => {
        const generations = await Promise.all([this.akash.initializationGeneration(), this.nosana.initializationGeneration()]);
        if (state.akashGeneration !== generations[0] || state.nosanaGeneration !== generations[1]) throw new Error('Shared supplier journal generation differs; recovery required');
        const [akash, nosana] = await Promise.all([this.akash.read(), this.nosana.read()]);
        const checkGenerations = async () => {
          const current = await Promise.all([this.akash.initializationGeneration(), this.nosana.initializationGeneration()]);
          if (JSON.stringify(current) !== JSON.stringify(generations)) throw new Error('Shared supplier journal generation changed; recovery required');
        };
        await checkGenerations();
        const otherNetwork = candidate.network === 'akash' ? nosana.records : akash.records;
        if (otherNetwork.some(row => row.owner === candidate.owner && row.runId === candidate.runId))
          throw new Problem(409, 'supplier_run_already_reserved', 'This run already has a supplier reservation.');
        const commitLocalJournal = async () => {
          try { await checkGenerations(); const result = await commit(); uncertain(); await checkGenerations(); return result; }
          catch (error) {
            // This callback is a local ledger mutation, never a supplier POST.
            // A known unchanged validation refusal can release the gate. A
            // changed, lost or unreadable peer requires operator reconciliation.
            try {
              const current = await Promise.all([this.akash.read(), this.nosana.read()]);
              const currentGenerations = await Promise.all([this.akash.initializationGeneration(), this.nosana.initializationGeneration()]);
              if (JSON.stringify(current) !== JSON.stringify([akash, nosana]) || JSON.stringify(currentGenerations) !== JSON.stringify(generations)) uncertain();
            } catch { uncertain(); }
            throw error;
          }
        };
        // The original journal still checks the exact request before a retry.
        const ownNetwork = candidate.network === 'akash' ? akash.records : nosana.records;
        if (ownNetwork.some(row => row.owner === candidate.owner && row.runId === candidate.runId)) return commitLocalJournal();
        const records = [...akash.records.filter(supplierReserveHeld), ...nosana.records];
        const reserved = records.reduce((total, row) => total + BigInt(row.reservedUsdcMicros), 0n);
        if (reserved + BigInt(candidate.reservedUsdcMicros) > this.ceiling)
          throw new Problem(409, 'supplier_shared_budget_exceeded', 'The shared supplier USDC reserve ceiling is exhausted.');
        return commitLocalJournal();
      });
    } catch (error) {
      if (error instanceof SupplierJournalLocked) throw new Problem(409, 'supplier_shared_reserve_locked',
        'Shared supplier admission is locked; inspect the previous writer before retrying.');
      throw error;
    }
  }
}
