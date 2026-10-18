import { Worker } from 'node:worker_threads';
import type { BigIntStats } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson, Problem } from '../common.js';
import { golemAmountToBaseUnits, golemFinanceIdSchema, golemPaymentSchema,
  type GolemFinanceProtocol, type GolemFinancePayment } from './golem-finance-types.js';
import { parseGolemFinanceWirePayment, type GolemFinanceHttpProtocol } from './golem-finance-http.js';
import { golemNodeIdSchema } from './golem-stats.js';

export const GOLEM_ATTRIBUTION_TABLES = ['pay_activity', 'pay_agreement', 'pay_allocation', 'pay_batch_order',
  'pay_batch_order_item', 'pay_batch_order_item_document', 'pay_payment', 'pay_payment_document'] as const;
const nativeIdentity = z.string().regex(/^(0|[1-9][0-9]{0,24})$/);
export const golemAttributionPolicySchema = z.object({ version: z.literal(1),
  sourceProfile: z.literal('yagna-c256fce-local-sqlite-v1'), databasePath: z.string().min(1).max(4096),
  databaseDevice: nativeIdentity, databaseInode: nativeIdentity, directoryDevice: nativeIdentity, directoryInode: nativeIdentity,
  schemaHash: bytes32Schema, requestorId: golemNodeIdSchema, payerAddr: addressSchema,
  maxDatabaseBytes: z.number().int().min(4096).max(268_435_456),
  maxWalBytes: z.number().int().min(0).max(67_108_864), maxShmBytes: z.number().int().min(0).max(1_048_576),
  timeoutMs: z.number().int().min(100).max(5000),
}).strict();
export type GolemAttributionPolicy = z.infer<typeof golemAttributionPolicySchema>;
export const golemAttributionSchemaRows = z.array(z.object({ name: z.enum(GOLEM_ATTRIBUTION_TABLES),
  type: z.literal('table'), sql: z.string().min(1).max(32_768) }).strict()).length(GOLEM_ATTRIBUTION_TABLES.length);
/** Operator reviews and installs this exact source schema pin; never auto-enrolled. */
export function golemAttributionSchemaHash(value: unknown) {
  const rows = golemAttributionSchemaRows.parse(value);
  if (new Set(rows.map(row => row.name)).size !== GOLEM_ATTRIBUTION_TABLES.length) throw new Error('Yagna attribution schema duplicated');
  return hashJson({ domain: 'telomere.golem.yagna-attribution-schema.v1', tables: rows.toSorted((a, b) => a.name.localeCompare(b.name)) });
}
const text = z.string().max(256), nullable = text.nullable();
const databasePayment = z.object({ id: text, owner_id: text, peer_id: text, payee_addr: text, payer_addr: text,
  payment_platform: text, role: text, amount: text, timestamp: text, details_hex: z.string().regex(/^[0-9A-F]{64}$/) }).strict();
const item = z.object({ order_id: text, owner_id: text, payee_addr: text, allocation_id: text, amount: text,
  payment_id: nullable, paid: z.number().int(), platform: nullable, payer_addr: nullable,
  allocation_address: nullable, allocation_platform: nullable, deposit: nullable, deposit_status: nullable }).strict();
const document = z.object({ order_id: text, owner_id: text, payee_addr: text, allocation_id: text,
  agreement_id: text, invoice_id: nullable, activity_id: nullable, debit_note_id: nullable, amount: text,
  agreement_role: nullable, peer_id: nullable, agreement_payer: nullable, agreement_payee: nullable, agreement_platform: nullable,
  activity_role: nullable, activity_agreement: nullable }).strict();
const paymentDocument = z.object({ payment_id: text, owner_id: text, peer_id: text, agreement_id: text,
  invoice_id: nullable, activity_id: nullable, debit_note_id: nullable, amount: text }).strict();
export const golemAttributionSnapshotSchema = z.object({ schemaHash: bytes32Schema,
  payments: z.array(databasePayment).max(2), items: z.array(item).max(129),
  documents: z.array(document).max(129), paymentDocuments: z.array(paymentDocument).max(65) }).strict();
export type GolemAttributionSnapshot = z.infer<typeof golemAttributionSnapshotSchema>;
const refused = () => new Problem(503, 'golem_allocation_attribution_unavailable',
  'Original Yagna payment allocation attribution is unavailable, changed or ambiguous.');

/** SQLite can fchmod an unchanged WAL during a read-only attachment on Linux.
 * Its ctime alone is not a content mutation. Keep identity, permission, owner,
 * size and mtime checks and additionally bind the complete bounded WAL bytes. */
export function sameGolemWalSnapshot(before: BigIntStats | undefined, after: BigIntStats | undefined,
  beforeHash: string | undefined, afterHash: string | undefined): boolean {
  if (!before || !after) return !before && !after && beforeHash === undefined && afterHash === undefined;
  return typeof beforeHash === 'string' && /^[a-f0-9]{64}$/.test(beforeHash) && beforeHash === afterHash
    && (['dev', 'ino', 'size', 'mtimeNs', 'mode', 'nlink', 'uid', 'gid'] as const).every(key => before[key] === after[key]);
}

/** Installed local DB trust, not provider/chain/physical-stop authority. Windows
 * ACLs must be installed by the operator; POSIX private ownership/modes are checked.
 * No file is created, migrated, repaired or enrolled by this reader. */
export class GolemAllocationAttributionReader {
  readonly policy: Readonly<GolemAttributionPolicy>;
  private readonly workers = new Set<Worker>();
  constructor(policy: GolemAttributionPolicy) {
    this.policy = Object.freeze(golemAttributionPolicySchema.parse(policy));
    if (!isAbsolute(this.policy.databasePath) || resolve(this.policy.databasePath) !== this.policy.databasePath
      || this.policy.databasePath.includes('\0')) throw new Error('Absolute reviewed Yagna database path required');
  }
  private snapshot(paymentId: string, signal: AbortSignal): Promise<GolemAttributionSnapshot> {
    if (!(signal instanceof AbortSignal) || signal.aborted || this.workers.size >= 2) return Promise.reject(refused());
    return new Promise((resolveResult, reject) => {
      let worker: Worker | undefined, done = false;
      const finish = (value?: unknown) => {
        if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', aborted);
        const parsed = golemAttributionSnapshotSchema.safeParse(value);
        // Termination also closes a stalled native SQLite operation; no main-loop
        // synchronous database work or cancellation-dependent DB callback exists.
        void worker?.terminate().catch(() => undefined);
        if (parsed.success && !signal.aborted) resolveResult(parsed.data); else reject(refused());
      };
      const aborted = () => finish();
      const timer = setTimeout(aborted, this.policy.timeoutMs);
      signal.addEventListener('abort', aborted, { once: true });
      try {
        if (signal.aborted) { finish(); return; }
        const source = import.meta.url.endsWith('.ts');
        worker = new Worker(new URL(source ? './golem-allocation-attribution-worker-loader.ts' : './golem-allocation-attribution-worker-loader.js', import.meta.url), {
          workerData: { policy: this.policy, paymentId }, execArgv: source ? ['--import', 'tsx'] : [],
          stdout: true, stderr: true,
          resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        });
        const owned = worker; this.workers.add(owned);
        owned.stdout?.resume(); owned.stderr?.resume();
        worker.once('message', finish); worker.once('error', aborted);
        worker.once('exit', () => { this.workers.delete(owned); finish(); });
      } catch { finish(); }
    });
  }
  async attribute(paymentInput: unknown, signal: AbortSignal): Promise<{ payment: GolemFinancePayment; evidenceHash: string;
    source: 'operator-local-yagna-sqlite'; allocationAttribution: 'exact-native-payment-order-document-join' }> {
    try {
      const wire = parseGolemFinanceWirePayment(paymentInput);
      if (wire.payerId !== this.policy.requestorId || wire.payerAddr !== this.policy.payerAddr) throw refused();
      // Initial supported surface is one peer and one agreement OR activity share.
      const activity = wire.activityPayments[0], agreement = wire.agreementPayments[0];
      if (wire.activityPayments.length + wire.agreementPayments.length !== 1) throw refused();
      const share = activity ?? agreement; if (!share) throw refused();
      const amount = golemAmountToBaseUnits(wire.amount);
      if (amount === 0n || golemAmountToBaseUnits(share.amount) !== amount) throw refused();
      const snapshot = await this.snapshot(wire.paymentId, signal);
      if (snapshot.schemaHash !== this.policy.schemaHash || snapshot.payments.length !== 1
        || snapshot.items.length < 1 || snapshot.items.length > 128 || snapshot.documents.length < 1 || snapshot.documents.length > 128
        || snapshot.paymentDocuments.length !== 1) throw refused();
      const units = (value: unknown) => golemAmountToBaseUnits(parseGolemFinanceWirePayment({ ...wire, amount: value }).amount);
      const native = snapshot.payments[0]!, nativeDoc = snapshot.paymentDocuments[0]!;
      if (native.id !== wire.paymentId || native.owner_id !== wire.payerId || native.peer_id !== wire.payeeId || native.role !== 'R'
        || addressSchema.parse(native.payer_addr) !== wire.payerAddr || addressSchema.parse(native.payee_addr) !== wire.payeeAddr
        || native.payment_platform !== wire.paymentPlatform || units(native.amount) !== amount
        || Buffer.from(native.details_hex, 'hex').toString('base64') !== wire.details
        || !Number.isFinite(Date.parse(native.timestamp.replace(' ', 'T') + 'Z'))
        || Date.parse(native.timestamp.replace(' ', 'T') + 'Z') !== Date.parse(wire.timestamp)) throw refused();
      const allocation = snapshot.items[0]!.allocation_id, matchedAgreement = activity ? nativeDoc.agreement_id : agreement!.agreementId;
      golemFinanceIdSchema.parse(allocation); golemFinanceIdSchema.parse(matchedAgreement);
      const itemKey = (row: { order_id: string; owner_id: string; payee_addr: string; allocation_id: string }) =>
        hashJson({ order: row.order_id, owner: row.owner_id, payee: row.payee_addr.toLowerCase(), allocation: row.allocation_id });
      const items = new Map(snapshot.items.map(row => [itemKey(row), row]));
      if (items.size !== snapshot.items.length || share.allocationId != null && share.allocationId !== allocation) throw refused();
      let totalItems = 0n, totalDocs = 0n;
      const byItem = new Map<string, bigint>(), documents = new Set<string>();
      for (const row of snapshot.items) {
        if (row.payment_id !== wire.paymentId || row.owner_id !== wire.payerId || row.allocation_id !== allocation || row.paid !== 1
          || addressSchema.parse(row.payee_addr) !== wire.payeeAddr || addressSchema.parse(row.payer_addr) !== wire.payerAddr
          || row.platform !== wire.paymentPlatform || addressSchema.parse(row.allocation_address) !== wire.payerAddr
          || row.allocation_platform !== wire.paymentPlatform || row.deposit !== null || row.deposit_status !== null || units(row.amount) <= 0n) throw refused();
        totalItems += units(row.amount);
      }
      for (const row of snapshot.documents) {
        const key = itemKey(row), documentKey = hashJson({ key, agreement: row.agreement_id, activity: row.activity_id,
          invoice: row.invoice_id, debit: row.debit_note_id });
        if (!items.has(key) || documents.has(documentKey) || row.owner_id !== wire.payerId || row.agreement_id !== matchedAgreement
          || row.allocation_id !== allocation || addressSchema.parse(row.payee_addr) !== wire.payeeAddr || row.agreement_role !== 'R'
          || row.peer_id !== wire.payeeId || addressSchema.parse(row.agreement_payer) !== wire.payerAddr
          || addressSchema.parse(row.agreement_payee) !== wire.payeeAddr || row.agreement_platform !== wire.paymentPlatform
          || (activity ? row.activity_id !== activity.activityId || row.activity_role !== 'R' || row.activity_agreement !== matchedAgreement
            || row.debit_note_id === null || row.invoice_id !== null : row.activity_id !== null || row.invoice_id === null || row.debit_note_id !== null)
          || units(row.amount) <= 0n) throw refused();
        documents.add(documentKey); const value = units(row.amount); byItem.set(key, (byItem.get(key) ?? 0n) + value); totalDocs += value;
      }
      if (totalItems !== amount || totalDocs !== amount || snapshot.items.some(row => byItem.get(itemKey(row)) !== units(row.amount))
        || nativeDoc.payment_id !== wire.paymentId || nativeDoc.owner_id !== wire.payerId || nativeDoc.peer_id !== wire.payeeId
        || nativeDoc.agreement_id !== matchedAgreement || nativeDoc.activity_id !== (activity?.activityId ?? null)
        // Pinned PaymentDao stores both IDs as NULL for activity and agreement
        // shares. Actual document IDs are required above on the batch rows.
        || nativeDoc.invoice_id !== null || nativeDoc.debit_note_id !== null
        || units(nativeDoc.amount) !== amount) throw refused();
      signal.throwIfAborted();
      const payment = golemPaymentSchema.parse({ ...wire,
        activityPayments: wire.activityPayments.map(row => ({ ...row, allocationId: allocation })),
        agreementPayments: wire.agreementPayments.map(row => ({ ...row, allocationId: allocation })) });
      return { payment, evidenceHash: hashJson({ domain: 'telomere.golem.native-allocation-attribution.v1', policy: this.policy,
        snapshot, paymentHash: hashJson(payment) }), source: 'operator-local-yagna-sqlite',
      allocationAttribution: 'exact-native-payment-order-document-join' };
    } catch { throw refused(); }
  }
}

/** Composes the existing bounded authenticated HTTP protocol with exact local
 * attribution. All mutation/original-intent/finality/stop checks remain in the
 * existing financial lifecycle; no new ledger, writer, mount, chain-finality or
 * physical-stop authority is introduced by this local attribution reader. */
export class GolemAttributedFinanceProtocol implements GolemFinanceProtocol {
  constructor(private readonly protocol: Pick<GolemFinanceHttpProtocol, 'document' | 'wirePayment' | 'mutate'>,
    private readonly attribution: GolemAllocationAttributionReader) {}
  readonly document: GolemFinanceProtocol['document'] = (kind, id, signal) => this.protocol.document(kind, id, signal);
  readonly mutate: GolemFinanceProtocol['mutate'] = (action, binding, id, amount, signal) => this.protocol.mutate(action, binding, id, amount, signal);
  async payment(id: string, signal: AbortSignal): Promise<GolemFinancePayment> {
    return (await this.attribution.attribute(await this.protocol.wirePayment(id, signal), signal)).payment;
  }
}
