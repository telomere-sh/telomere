import { Hono } from 'hono';
import { z } from 'zod';
import type { FinancialHistory, FinancialScan } from './financial-history.js';

export type PricePeriod = '1h' | '24h' | '7d';
const WINDOWS: Record<PricePeriod, number> = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };
const MAX_LEVELS = 10000;
const HARDWARE = ['CPU', 'RTX', 'A100', 'H100', 'H200', 'B200'] as const;
type State = 'ready' | 'no_data' | 'partial' | 'unavailable';
type Rational = { numerator: string; denominator: '1' | '2' };
type PriceRow = { hardware: typeof HARDWARE[number]; profile: 'operator-signed-cpu' | null; lane: null;
  state: State; sampleCount: string | null; p10Atomic: string | null; medianAtomic: Rational | null; p90Atomic: string | null };
type History = Pick<FinancialHistory, 'snapshot' | 'facts' | 'source'>;

function emptyRows(state: State): PriceRow[] {
  return HARDWARE.map(hardware => ({ hardware, profile: hardware === 'CPU' ? 'operator-signed-cpu' : null,
    lane: null, state: hardware === 'CPU' ? state : 'no_data',
    sampleCount: hardware === 'CPU' && ['partial', 'unavailable'].includes(state) ? null : '0',
    p10Atomic: null, medianAtomic: null, p90Atomic: null }));
}

/** Every qualifying settlement counts once, independent of runtime or charged total. */
export async function settledPriceBoard(history: History, period: PricePeriod) {
  let scan: FinancialScan | undefined;
  let rows = emptyRows('unavailable');
  let state: State = 'unavailable';
  let reason = 'The confirmed history snapshot is unavailable. Retry later.';
  const exclusions = { zeroBillable: '0', unknownHardware: '0', missingRecordedPrice: '0' };
  try {
    scan = await history.snapshot();
    if (!scan.complete || !['ready', 'no_data'].includes(scan.state)) {
      state = scan.state === 'partial' ? 'partial' : 'unavailable'; rows = emptyRows(state);
      reason = state === 'partial' ? 'History verification is in progress. Price statistics wait for a complete snapshot.'
        : 'Confirmed history is unavailable. Price statistics are withheld.';
    } else {
      const end = Date.parse(scan.startedAt), start = end - WINDOWS[period];
      if (!Number.isFinite(end)) throw new Error('Invalid snapshot time');
      const levels = new Map<bigint, bigint>();
      let count = 0n, visited = 0n, overflow = false;
      for await (const fact of history.facts()) {
        ++visited;
        const returnedAt = Date.parse(fact.returnedAt);
        if (!Number.isFinite(returnedAt)) throw new Error('Invalid settlement time');
        if (fact.kind !== 'settlement' || returnedAt < start || returnedAt > end) continue;
        if (!Number.isSafeInteger(fact.billableSeconds) || fact.billableSeconds < 0) throw new Error('Invalid billable duration');
        if (fact.billableSeconds === 0) { exclusions.zeroBillable = (BigInt(exclusions.zeroBillable) + 1n).toString(); continue; }
        if (fact.hardware !== 'CPU') { exclusions.unknownHardware = (BigInt(exclusions.unknownHardware) + 1n).toString(); continue; }
        if (fact.pricePerSecond === null) { exclusions.missingRecordedPrice = (BigInt(exclusions.missingRecordedPrice) + 1n).toString(); continue; }
        if (!/^\d{1,100}$/.test(fact.pricePerSecond)) throw new Error('Invalid recorded price');
        const price = BigInt(fact.pricePerSecond); ++count;
        if (!overflow) {
          if (!levels.has(price) && levels.size >= MAX_LEVELS) { overflow = true; levels.clear(); }
          else levels.set(price, (levels.get(price) ?? 0n) + 1n);
        }
      }
      const after = await history.snapshot();
      if (!after.complete || after.generation !== scan.generation || !['ready', 'no_data'].includes(after.state)
        || visited !== BigInt(scan.verified)) throw new Error('History changed or is incomplete');
      if (overflow) {
        reason = 'More than 10,000 distinct recorded prices exceed the exact quantile limit. No samples were silently truncated.';
      } else {
        state = count ? 'ready' : 'no_data'; rows = emptyRows(state);
        reason = count ? 'Complete confirmed snapshot. These are recorded settlement prices, not current offers.'
          : 'No qualifying CPU settlement samples in this period. Other hardware has no recorded price source.';
        if (count) {
          const sorted = [...levels].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
          const atRank = (rank: bigint): bigint => {
            let cumulative = 0n;
            for (const [price, frequency] of sorted) { cumulative += frequency; if (cumulative >= rank) return price; }
            throw new Error('Invalid quantile rank');
          };
          const even = count % 2n === 0n;
          const median = even ? atRank(count / 2n) + atRank(count / 2n + 1n) : atRank((count + 1n) / 2n);
          rows[0] = { hardware: 'CPU', profile: 'operator-signed-cpu', lane: null, state: 'ready', sampleCount: count.toString(),
            p10Atomic: atRank((count + 9n) / 10n).toString(), p90Atomic: atRank((count * 9n + 9n) / 10n).toString(),
            medianAtomic: even && median % 2n ? { numerator: median.toString(), denominator: '2' }
              : { numerator: (even ? median / 2n : median).toString(), denominator: '1' } };
        }
      }
    }
  } catch {
    state = 'unavailable'; rows = emptyRows(state);
    reason = 'History changed or a source read failed. Retry for a complete confirmed snapshot.';
  }
  return { state, reason, period, asOf: scan?.asOf ?? null, periodEndsAt: scan?.startedAt ?? null,
    periodStartsAt: scan && Number.isFinite(Date.parse(scan.startedAt)) ? new Date(Date.parse(scan.startedAt) - WINDOWS[period]).toISOString() : null,
    source: { scope: 'controller-recorded confirmed history', chainId: history.source.chainId,
      token: history.source.token, escrow: history.source.escrow },
    unit: 'USDC per billable second', tokenDecimals: 6,
    method: { sample: 'One verified settlement with positive billable seconds and a recorded CPU price.',
      p10: 'nearest-rank', p90: 'nearest-rank', median: 'exact middle value or arithmetic mean of the two middle values',
      window: 'inclusive returnedAt bounds ending at the snapshot start', maximumDistinctPrices: MAX_LEVELS },
    coverage: { complete: Boolean(scan?.complete) && state !== 'unavailable', candidates: scan?.candidates ?? null,
      verified: scan?.verified ?? null, excluded: scan?.excluded ?? null, exclusions,
      notes: scan?.notes ?? [], scope: 'CPU prices recorded by the operator-signed CPU profile; lane is not recorded. GPU rows have no source.' }, rows };
}

export function createPriceBoardRoutes(history: History) {
  const routes = new Hono();
  routes.get('/prices', async context => {
    context.header('Cache-Control', 'no-store');
    const params = new URL(context.req.url).searchParams;
    const query = z.object({ period: z.enum(['1h', '24h', '7d']).default('24h') }).strict().safeParse(Object.fromEntries(params));
    if (!query.success || params.size > 1) return context.json({ error: { code: 'price_query', message: 'Choose one period: 1h, 24h or 7d.' } }, 422);
    return context.json(await settledPriceBoard(history, query.data.period));
  });
  return routes;
}
