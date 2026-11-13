import { randomUUID } from 'node:crypto';

export type FinancialFact = {
  runId: string; payer: string; transactionHash: string; blockNumber: string; blockHash: string;
  openedAt: string; returnedAt: string; receiptHash: string | null;
  kind: 'settlement' | 'timeout_refund'; outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'unknown';
  charged: string; returned: string; ceiling: string; billableSeconds: number;
  pricePerSecond: string | null; hardware: 'CPU' | null; lane: null;
};
export type FinancialCandidate = { id: string; receipt: unknown; settlementTxHash: string | null };
export interface FinancialHistorySource {
  scope: string; chainId: number; token: string; escrow: string;
  anchor(): Promise<{ height: string; hash: string }>;
  canonical(anchor: { height: string; hash: string }): Promise<boolean>;
  count(cutoff: Date): Promise<number>;
  page(cutoff: Date, after: string | undefined): Promise<FinancialCandidate[]>;
  verify(candidate: FinancialCandidate, anchor: { height: string; hash: string }): Promise<FinancialFact | null>;
  save(fact: FinancialFact, generation: string): Promise<void>;
  facts(generation: string, after: string | undefined, owner?: string): Promise<FinancialFact[]>;
}
export type FinancialScan = {
  generation: string; startedAt: string; asOf: string; state: 'partial' | 'ready' | 'no_data' | 'unavailable';
  anchor: { height: string; hash: string } | null; candidates: number; visited: number; verified: number;
  excluded: number; complete: boolean; notes: string[]; refunds: Record<'all' | '24h' | '7d', RefundAggregate>;
};

/** A bounded progressive scan. Every recorded page is visited; no fixed total-history cutoff. */
export class FinancialHistory {
  private scan: FinancialScan | undefined;
  private running: Promise<void> | undefined;
  private checkedAt = 0;
  constructor(readonly source: FinancialHistorySource, private readonly now: () => number = Date.now,
    private readonly refreshMs = 60000) {}
  private begin(): void {
    if (this.running) return;
    const started = new Date(this.now());
    const scan: FinancialScan = { generation: randomUUID(), startedAt: started.toISOString(), asOf: started.toISOString(),
      state: 'partial', anchor: null, candidates: 0, visited: 0, verified: 0, excluded: 0, complete: false,
      notes: ['Scanning controller-recorded history against confirmed chain evidence.'],
      refunds: { all: emptyRefundAggregate(), '24h': emptyRefundAggregate(), '7d': emptyRefundAggregate() } };
    this.scan = scan;
    this.running = this.collect(scan, started).catch(() => {
      scan.state = 'unavailable'; scan.complete = false;
      scan.notes = ['Chain or history verification is unavailable. Totals have not been certified as complete.'];
    }).finally(() => { this.checkedAt = this.now(); this.running = undefined; });
  }
  private async collect(scan: FinancialScan, cutoff: Date): Promise<void> {
    const anchor = await this.source.anchor(); scan.anchor = anchor;
    scan.candidates = await this.source.count(cutoff);
    let after: string | undefined;
    // Accumulators retain only fixed totals and 90 daily buckets. Facts remain paged in PostgreSQL.
    for (;;) {
      const page = await this.source.page(cutoff, after);
      if (!page.length) break;
      if (page.length > 25 || page.some((row, index) => !/^0x[a-f0-9]{64}$/.test(row.id)
        || row.id <= (index ? page[index - 1]!.id : after ?? ''))) throw new Error('Invalid history page');
      for (let index = 0; index < page.length; index += 2) {
        const group = page.slice(index, index + 2);
        const results = await Promise.all(group.map(row => this.source.verify(row, anchor)));
        for (const fact of results) {
          ++scan.visited;
          if (fact) {
            await this.source.save(fact, scan.generation); ++scan.verified;
            for (const period of ['all', '24h', '7d'] as const) {
              const cutoff = period === 'all' ? 0 : Date.parse(scan.startedAt) - (period === '24h' ? 86400000 : 604800000);
              if (Date.parse(fact.returnedAt) >= cutoff && Date.parse(fact.returnedAt) <= Date.parse(scan.startedAt)) {
                accumulateRefund(scan.refunds[period], fact, Date.parse(scan.startedAt));
              }
            }
          }
          else ++scan.excluded;
        }
        scan.asOf = new Date(this.now()).toISOString();
      }
      after = page.at(-1)!.id;
    }
    if (!await this.source.canonical(anchor)) throw new Error('History anchor changed');
    const finalCount = await this.source.count(cutoff);
    scan.complete = finalCount === scan.candidates && scan.visited === scan.candidates && scan.excluded === 0;
    scan.state = scan.complete ? scan.verified ? 'ready' : 'no_data' : 'partial';
    scan.notes = [
      'Scope: final controller-recorded runs, not a claim of complete lifetime contract activity.',
      'Returns release funds into escrow. Wallet withdrawals are not included.',
      ...(scan.excluded ? [`${scan.excluded} records lack complete confirmed evidence and are excluded from totals.`] : []),
      ...(finalCount !== scan.candidates || scan.visited !== scan.candidates ? ['History changed while scanning; the next refresh will reconcile it.'] : []),
    ];
  }
  async snapshot(): Promise<FinancialScan> {
    if (!this.scan || !this.running && this.now() - this.checkedAt >= this.refreshMs) this.begin();
    const scan = this.scan!;
    if (scan.anchor && ['ready', 'no_data'].includes(scan.state)) {
      try {
        if (!await this.source.canonical(scan.anchor)) { this.begin(); return this.scan!; }
      } catch { return { ...scan, state: 'unavailable', complete: false, notes: ['The cached chain anchor could not be rechecked. Retry later.'] }; }
    }
    return structuredClone(scan);
  }
  /** Operator/test synchronization only; never sends a transaction. */
  async settled(): Promise<FinancialScan> { if (!this.scan) this.begin(); await this.running; return this.snapshot(); }
  async *facts(owner?: string): AsyncGenerator<FinancialFact> {
    const scan = await this.snapshot();
    if (!scan.complete || !['ready', 'no_data'].includes(scan.state)) throw new Error('Confirmed history is still refreshing');
    let after: string | undefined;
    for (;;) {
      const page = await this.source.facts(scan.generation, after, owner);
      if (!page.length) break;
      if (page.length > 25 || page.some((row, index) => row.runId <= (index ? page[index - 1]!.runId : after ?? ''))) throw new Error('Invalid fact page');
      for (const fact of page) yield fact;
      after = page.at(-1)!.runId;
    }
    if (this.scan?.generation !== scan.generation || !await this.source.canonical(scan.anchor!)) throw new Error('History changed while reading');
  }
}

function emptyRefundAggregate() {
  return { totals: { settledRuns: 0, successfulRuns: 0, failedRuns: 0, timeoutRefunds: 0, returnedAtomic: '0',
    unusedSuccessAtomic: '0', failedReturnedAtomic: '0', timeoutReturnedAtomic: '0', unclassifiedReturnedAtomic: '0',
    failedWithReturn: 0, meanReturnSeconds: null as string | null }, durationMs: '0', timed: '0',
    daily: {} as Record<string, { date: string; returnedAtomic: string; successfulUnusedAtomic: string;
      failedReturnedAtomic: string; timeoutReturnedAtomic: string }> };
}
type RefundAggregate = ReturnType<typeof emptyRefundAggregate>;
function accumulateRefund(aggregate: RefundAggregate, row: FinancialFact, now: number): void {
    const totals = aggregate.totals;
    const returned = BigInt(row.returned); totals.returnedAtomic = (BigInt(totals.returnedAtomic) + returned).toString();
    const key = row.kind === 'timeout_refund' ? 'timeoutReturnedAtomic' : row.outcome === 'completed' ? 'unusedSuccessAtomic'
      : ['failed', 'cancelled', 'timed_out'].includes(row.outcome) ? 'failedReturnedAtomic' : 'unclassifiedReturnedAtomic';
    totals[key] = (BigInt(totals[key]) + returned).toString();
    if (row.kind === 'timeout_refund') ++totals.timeoutRefunds;
    else { ++totals.settledRuns; if (row.outcome === 'completed') ++totals.successfulRuns;
      else if (['failed', 'cancelled', 'timed_out'].includes(row.outcome)) { ++totals.failedRuns; if (returned > 0n) ++totals.failedWithReturn; } }
    if (returned > 0n) {
      const elapsed = BigInt(Date.parse(row.returnedAt) - Date.parse(row.openedAt));
      if (elapsed >= 0n) {
        aggregate.durationMs = (BigInt(aggregate.durationMs) + elapsed).toString();
        aggregate.timed = (BigInt(aggregate.timed) + 1n).toString();
        totals.meanReturnSeconds = (BigInt(aggregate.durationMs) / BigInt(aggregate.timed) / 1000n).toString();
      }
    }
    if (Date.parse(row.returnedAt) >= now - 90 * 86400000) {
      const date = row.returnedAt.slice(0, 10), day = aggregate.daily[date] ?? { date, returnedAtomic: '0',
        successfulUnusedAtomic: '0', failedReturnedAtomic: '0', timeoutReturnedAtomic: '0' };
      day.returnedAtomic = (BigInt(day.returnedAtomic) + returned).toString();
      if (key === 'unusedSuccessAtomic') day.successfulUnusedAtomic = (BigInt(day.successfulUnusedAtomic) + returned).toString();
      if (key === 'failedReturnedAtomic') day.failedReturnedAtomic = (BigInt(day.failedReturnedAtomic) + returned).toString();
      if (key === 'timeoutReturnedAtomic') day.timeoutReturnedAtomic = (BigInt(day.timeoutReturnedAtomic) + returned).toString();
      aggregate.daily[date] = day;
    }
}
export function refundSnapshot(scan: FinancialScan, source: Pick<FinancialHistorySource, 'chainId' | 'token' | 'escrow'>,
  period: '24h' | '7d' | 'all') {
  const aggregate = scan.refunds[period];
  const state = scan.state === 'ready' && aggregate.totals.settledRuns + aggregate.totals.timeoutRefunds === 0 ? 'no_data' : scan.state;
  return { state, asOf: scan.asOf, chainId: source.chainId, token: source.token, escrow: source.escrow,
    period, periodEndsAt: scan.startedAt, totals: aggregate.totals, chartWindowDays: 90,
    coverage: { scope: 'controller-recorded confirmed history', candidates: scan.candidates, verified: scan.verified,
      excluded: scan.excluded, complete: scan.complete, notes: scan.notes },
    daily: Object.values(aggregate.daily).sort((a, b) => a.date.localeCompare(b.date)) };
}
