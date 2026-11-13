import { Hono, type Context } from 'hono';
import { Problem, addressSchema } from '../common.js';
import { evaluateMetabolism, unitsSchema, type AgentMode } from '../agents/types.js';
import type { FinancialHistory, FinancialScan } from './financial-history.js';

type Anchor = NonNullable<FinancialScan['anchor']>;
export type RunwayHistory = Pick<FinancialHistory, 'snapshot' | 'facts' | 'source'>;
export type RunwayReport = {
  state: 'ready' | 'no_data' | 'partial' | 'unavailable'; owner: string; asOf: string;
  chainId: number; token: string; escrow: string; anchor: Anchor | null;
  budgetScope: string; periodStartsAt: string; periodEndsAt: string;
  coverage: { scope: string; complete: boolean; notes: string[] };
  estimate: null | { availableAtomic: string; trailing24hChargedAtomic: string; ownerFacts: number;
    settledRuns24h: number; mode: AgentMode; runwaySeconds: string | null;
    runwayHours: { numerator: string; denominator: string } | null; zeroSpend: boolean };
};

/** Read-only owner escrow estimate; it never selects hardware or changes agent policy. */
export class RunwayReader {
  constructor(private readonly history: RunwayHistory,
    private readonly readAvailableBalance: (owner: string, anchor: Anchor) => Promise<string>) {}
  async read(rawOwner: string): Promise<RunwayReport> {
    const owner = addressSchema.parse(rawOwner).toLowerCase();
    const scan = await this.history.snapshot();
    const end = Date.parse(scan.startedAt);
    const report: RunwayReport = {
      state: scan.state, owner, asOf: scan.asOf, anchor: scan.anchor,
      chainId: this.history.source.chainId, token: this.history.source.token, escrow: this.history.source.escrow,
      budgetScope: 'Owner available compute escrow; excludes SelectionVault and reserved balances',
      periodStartsAt: new Date(end - 86_400_000).toISOString(), periodEndsAt: scan.startedAt,
      coverage: { scope: this.history.source.scope, complete: scan.complete,
        notes: [...scan.notes, 'Estimate from confirmed controller-recorded settlement charges in the trailing 24 hours. Timeout refunds are excluded. This is not a hardware or agent policy decision.'] },
      estimate: null,
    };
    if (!scan.complete || !scan.anchor || !['ready', 'no_data'].includes(scan.state)) {
      report.state = scan.state === 'unavailable' ? 'unavailable' : 'partial';
      return report;
    }
    try {
      let burn = 0n, ownerFacts = 0, settledRuns24h = 0;
      for await (const row of this.history.facts(owner)) {
        // Defense in depth: a source filtering regression must never include a second owner's spend.
        if (row.payer.toLowerCase() !== owner) continue;
        const time = Date.parse(row.returnedAt);
        if (!Number.isFinite(time)) throw new Error('Malformed settlement timestamp');
        ++ownerFacts;
        if (row.kind === 'settlement' && time >= end - 86_400_000 && time <= end) {
          burn += BigInt(unitsSchema.parse(row.charged)); ++settledRuns24h;
        }
      }
      const available = unitsSchema.parse(await this.readAvailableBalance(owner, scan.anchor));
      const latest = await this.history.snapshot();
      if (latest.generation !== scan.generation || !latest.complete || latest.anchor?.hash !== scan.anchor.hash
        || latest.anchor.height !== scan.anchor.height || !await this.history.source.canonical(scan.anchor)) {
        throw new Error('The confirmed history anchor changed');
      }
      if (!ownerFacts) { report.state = 'no_data'; return report; }
      const evaluated = evaluateMetabolism(available, burn.toString());
      const zeroBalance = BigInt(available) === 0n;
      report.state = 'ready';
      report.estimate = { availableAtomic: available, trailing24hChargedAtomic: burn.toString(), ownerFacts,
        settledRuns24h, mode: evaluated.mode, runwaySeconds: zeroBalance ? '0' : evaluated.runwaySeconds,
        runwayHours: zeroBalance ? { numerator: '0', denominator: '1' }
          : burn === 0n ? null : { numerator: (BigInt(available) * 24n).toString(), denominator: burn.toString() },
        zeroSpend: burn === 0n };
      return report;
    } catch {
      report.state = 'unavailable'; report.coverage.complete = false;
      report.coverage.notes.push('Balance or canonical history verification changed or is unavailable. Estimate withheld; refresh to retry.');
      return report;
    }
  }
}

/** Mount at /api/insights. Owner comes only from the signed session, never a query. */
export function createRunwayRoutes(history: RunwayHistory,
  readAvailableBalance: (owner: string, anchor: Anchor) => Promise<string>,
  ownerResolver: (context: Context) => Promise<string>) {
  const routes = new Hono(), reader = new RunwayReader(history, readAvailableBalance);
  routes.get('/runway', async context => {
    context.header('Cache-Control', 'private, no-store');
    context.header('Vary', 'Cookie, X-Telomere-Owner');
    const owner = addressSchema.parse(await ownerResolver(context)).toLowerCase();
    if (new URL(context.req.url).searchParams.size) throw new Problem(422, 'runway_query', 'Runway does not accept query parameters.');
    const expectedOwner = context.req.header('X-Telomere-Owner');
    if (!expectedOwner || expectedOwner.toLowerCase() !== owner) throw new Problem(409, 'owner_changed', 'The signed session changed. Refresh your account.');
    const report = await reader.read(owner);
    if ((await ownerResolver(context)).toLowerCase() !== owner) throw new Problem(409, 'owner_changed', 'The signed session changed. Refresh your account.');
    return context.json(report);
  });
  return routes;
}
