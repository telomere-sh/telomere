import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Problem } from '../common.js';
import type { FinancialFact, FinancialHistory, FinancialScan } from './financial-history.js';

/** The read model stays paged; neither reporting path retains all facts. */
export type AccountingHistory = Pick<FinancialHistory, 'snapshot' | 'facts' | 'source'>;
const monthSchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/).refine(month => Number(month.slice(0, 4)) >= 1);
const querySchema = z.object({ month: monthSchema }).strict();
const uint = z.string().regex(/^(0|[1-9][0-9]{0,99})$/);
const timestamp = z.string().datetime({ offset: false });
const factSchema = z.object({
  runId: z.string().min(1).max(4096), payer: z.string().regex(/^0x[0-9a-f]{40}$/i),
  openedAt: timestamp, returnedAt: timestamp,
  kind: z.enum(['settlement', 'timeout_refund']),
  outcome: z.enum(['completed', 'failed', 'cancelled', 'timed_out', 'unknown']),
  charged: uint, returned: uint, ceiling: uint,
  billableSeconds: z.number().int().nonnegative().safe(), hardware: z.literal('CPU').nullable(), lane: z.null(),
});
export const ACCOUNTING_COLUMNS = ['run_id', 'host_id', 'hw_class', 'lane', 'started_at', 'stopped_at',
  'billable_seconds', 'amount_usdc', 'refund_usdc', 'stop_reason', 'reservation_opened_at',
  'settled_or_refunded_at', 'record_type', 'coverage', 'generation', 'export_completion'] as const;

export function accountingDecimal(atomic: string | bigint): string {
  const value = BigInt(atomic);
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')}`;
}
/** Quote every cell, including numeric-looking IDs. Protect spreadsheet formulas after whitespace/control characters. */
export function accountingCsvCell(value: string): string {
  const guarded = /^[\s\u0000-\u001f]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}
function csvRow(values: readonly string[]): string { return values.map(accountingCsvCell).join(',') + '\r\n'; }
export function accountingCompletionRow(generation: string, token: string): string {
  return csvRow(['', '', '', '', '', '', '', '', '', '', '', '', 'coverage_complete',
    'controller-recorded confirmed history', generation, token]);
}
function monthBounds(month: string): { start: number; end: number } {
  const start = Date.parse(`${month}-01T00:00:00.000Z`);
  const date = new Date(start); date.setUTCMonth(date.getUTCMonth() + 1);
  return { start, end: date.getTime() };
}
function isComplete(scan: FinancialScan): boolean {
  return scan.complete && scan.anchor !== null && (scan.state === 'ready' || scan.state === 'no_data')
    && scan.excluded === 0 && scan.visited === scan.candidates && scan.verified === scan.candidates;
}
async function pin(history: AccountingHistory, initial?: FinancialScan): Promise<FinancialScan> {
  const current = await history.snapshot();
  if (!isComplete(current) || initial && (current.generation !== initial.generation
    || current.anchor?.hash !== initial.anchor?.hash || current.anchor?.height !== initial.anchor?.height)) {
    throw new Error('History is incomplete or changed');
  }
  // Recheck the anchor explicitly as well as relying on FinancialHistory's own end-of-iterator check.
  if (!await history.source.canonical(current.anchor!)) throw new Error('History anchor changed');
  return current;
}
function coverage(history: AccountingHistory, scan: FinancialScan) {
  return { scope: 'controller-recorded confirmed history', source: history.source.scope,
    complete: isComplete(scan), candidates: scan.candidates, verified: scan.verified, excluded: scan.excluded,
    notes: ['The month uses settlement or timeout-refund time in UTC.',
      'Reservation times are separate from execution times. Unknown host, lane and execution timestamps are blank.',
      'Returns are releases into escrow, not wallet withdrawals.', ...scan.notes] };
}
async function* ownerMonthFacts(history: AccountingHistory, owner: string, month: string, signal: AbortSignal): AsyncGenerator<FinancialFact> {
  const { start, end } = monthBounds(month);
  for await (const fact of history.facts(owner)) {
    signal.throwIfAborted();
    // Defence in depth: a faulty owner-filtered source must never disclose another payer's data.
    if (typeof fact.payer !== 'string' || fact.payer.toLowerCase() !== owner.toLowerCase()) continue;
    factSchema.parse(fact);
    if (BigInt(fact.charged) + BigInt(fact.returned) !== BigInt(fact.ceiling)
      || Date.parse(fact.returnedAt) < Date.parse(fact.openedAt)) throw new Error('Invalid financial fact');
    const when = Date.parse(fact.returnedAt);
    if (when >= start && when < end) yield fact;
  }
  signal.throwIfAborted();
}
function factRow(fact: FinancialFact, generation: string): string {
  return csvRow([fact.runId, '', fact.hardware ?? '', '', '', '', String(fact.billableSeconds),
    accountingDecimal(fact.charged), accountingDecimal(fact.returned), fact.outcome === 'unknown' ? '' : fact.outcome,
    fact.openedAt, fact.returnedAt, fact.kind, 'controller-recorded confirmed history', generation, '']);
}
function queryMonth(context: Context): string {
  const parameters = new URL(context.req.url).searchParams;
  if (parameters.size !== 1 || parameters.getAll('month').length !== 1) throw new Problem(422, 'accounting_month', 'Choose one UTC month in YYYY-MM format.');
  return querySchema.parse(context.req.query()).month;
}
function privateHeaders(context: Context): void {
  context.header('Cache-Control', 'private, no-store');
  context.header('Vary', 'Cookie, X-Telomere-Owner');
  context.header('X-Content-Type-Options', 'nosniff');
}

/** Mount under /api/insights. Resolver must verify the existing signed session, never a query owner. */
export function createAccountingRoutes(history: AccountingHistory, ownerResolver: (context: Context) => Promise<string>) {
  const routes = new Hono();
  routes.get('/accounting', async context => {
    privateHeaders(context);
    const owner = await ownerResolver(context), month = queryMonth(context);
    let scan: FinancialScan | undefined;
    try {
      scan = await pin(history);
      let charged = 0n, returned = 0n, ceiling = 0n, timeoutReturned = 0n, count = 0n, settled = 0n, timeouts = 0n, seconds = 0n;
      for await (const fact of ownerMonthFacts(history, owner, month, context.req.raw.signal)) {
        charged += BigInt(fact.charged); returned += BigInt(fact.returned); ceiling += BigInt(fact.ceiling);
        seconds += BigInt(fact.billableSeconds); ++count;
        if (fact.kind === 'timeout_refund') { ++timeouts; timeoutReturned += BigInt(fact.returned); } else ++settled;
      }
      await pin(history, scan);
      return context.json({ state: count ? 'ready' : 'no_data', month, owner, asOf: scan.asOf, generation: scan.generation,
        anchor: scan.anchor, coverage: coverage(history, scan),
        totals: { records: count.toString(), settlements: settled.toString(), timeoutRefunds: timeouts.toString(), billableSeconds: seconds.toString(),
          chargedAtomic: charged.toString(), returnedAtomic: returned.toString(), ceilingAtomic: ceiling.toString(), timeoutReturnedAtomic: timeoutReturned.toString(),
          chargedUsdc: accountingDecimal(charged), returnedUsdc: accountingDecimal(returned), ceilingUsdc: accountingDecimal(ceiling), timeoutReturnedUsdc: accountingDecimal(timeoutReturned) } });
    } catch {
      return context.json({ state: scan ? 'unavailable' : 'partial', month, totals: null,
        coverage: { complete: false, scope: 'controller-recorded confirmed history' },
        detail: 'Confirmed accounting history is incomplete or unavailable. Retry after the history scan completes.' }, 503);
    }
  });
  routes.get('/accounting.csv', async context => {
    privateHeaders(context);
    const owner = await ownerResolver(context), month = queryMonth(context);
    let scan: FinancialScan;
    try { scan = await pin(history); }
    catch { return context.json({ state: 'partial', coverage: { complete: false }, detail: 'Complete confirmed history is required for export.' }, 503); }
    const token = randomUUID();
    const abort = new AbortController();
    const requestSignal = context.req.raw.signal;
    const onAbort = (): void => abort.abort();
    requestSignal.addEventListener('abort', onAbort, { once: true });
    if (requestSignal.aborted) abort.abort();
    const iterator = ownerMonthFacts(history, owner, month, abort.signal);
    const encoder = new TextEncoder();
    let header = false, finished = false;
    const cleanup = (): void => requestSignal.removeEventListener('abort', onAbort);
    const body = new ReadableStream<Uint8Array>({
      // One row per pull preserves backpressure and paged source bounds for any total history size.
      async pull(controller) {
        try {
          abort.signal.throwIfAborted();
          if (!header) { header = true; controller.enqueue(encoder.encode('\uFEFF' + csvRow(ACCOUNTING_COLUMNS))); return; }
          const row = await iterator.next();
          abort.signal.throwIfAborted();
          if (!row.done) { controller.enqueue(encoder.encode(factRow(row.value, scan.generation))); return; }
          await pin(history, scan);
          abort.signal.throwIfAborted();
          // Only this terminal coverage record certifies the stream. The UI verifies it before offering a file.
          controller.enqueue(encoder.encode(accountingCompletionRow(scan.generation, token)));
          finished = true; cleanup(); controller.close();
        } catch {
          abort.abort(); cleanup();
          await iterator.return(undefined).catch(() => undefined);
          controller.error(new Error('Accounting export did not complete. Request a fresh export.'));
        }
      },
      async cancel() {
        abort.abort(); cleanup();
        if (!finished) await iterator.return(undefined).catch(() => undefined);
      },
    }, { highWaterMark: 0 });
    return new Response(body, { headers: {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="telomere-accounting-${month}.csv"`,
      'Cache-Control': 'private, no-store', Vary: 'Cookie, X-Telomere-Owner', 'X-Content-Type-Options': 'nosniff',
      'X-Telomere-Export-Generation': scan.generation, 'X-Telomere-Export-Completion': token,
    } });
  });
  return routes;
}
