import { z } from 'zod';
import { Problem } from '../common.js';
import { selectionPublicJson, selectionPublicOrigin } from '../selection/public-http.js';
import { parseAgentEconomicsRequest, type AgentEconomicsRequest, type AgentEconomicsResponse } from './agent-economics.js';
const units = z.string().regex(/^(0|[1-9][0-9]{0,77})$/), hash = z.string().regex(/^0x[0-9a-f]{64}$/), day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const amounts = z.object({ incomeUnits: units, feeUnits: units, netIncomeUnits: units, burnUnits: units, subsidyUnits: units }).strict();
const ratio = <T extends 'seconds' | 'base-units-per-second'>(unit: T) => z.object({ numerator: units, denominator: units.refine(v => v !== '0'), unit: z.literal(unit) }).strict();
export const agentEconomicsReportSchema = z.object({ version: z.literal(1), state: z.enum(['ready', 'partial', 'stale', 'no_data']),
  source: z.literal('canonical-persisted-selection-events'), currency: z.literal('registry-token-base-units'), periodTime: z.literal('block-timestamp'),
  index: z.object({ indexKey: z.string().regex(/^[a-f0-9]{64}$/), chainId: z.number().int().positive(), registryAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    confirmations: z.number().int().min(3), indexedThrough: units, blockHash: hash, revision: z.number().int().nonnegative() }).strict(),
  asOfSeconds: units, period: z.object({ from: day, to: day, endExclusive: day }).strict(),
  coverage: z.object({ historyStartBlock: units, historyStartSeconds: units, partialStart: z.boolean(), partialEnd: z.boolean(),
    deploymentHistoryVerified: z.literal(false), stale: z.boolean(), staleAfterSeconds: z.literal(900), verifiedEarnedUnits: z.null(),
    earningsProvenance: z.literal('registry-classification-only'), unclassifiedTransfers: z.literal('excluded'), lifecycleTruncated: z.boolean() }).strict(),
  agent: z.object({ agentId: hash, parent: hash, family: hash, generation: z.number().int().nonnegative(), status: z.enum(['alive', 'dormant', 'dead']),
    frozen: z.boolean(), bornAt: units, dormantAt: units.nullable(), deathAt: units.nullable(), diedAt: units.nullable(), deathCause: hash.nullable(),
    livingChildren: z.number().int().min(0).max(3), lifetimeOffspring: z.number().int().nonnegative(), lifetime: amounts }).strict().nullable(),
  metrics: z.object({ spendableBalanceUnits: units, balanceAtBlock: units, trailing24hBurnUnits: units, trailing24hComplete: z.boolean(),
    metabolism: ratio('base-units-per-second').extend({ denominator: z.literal('86400') }).nullable(), runway: ratio('seconds').nullable(),
    runwayReason: z.enum(['estimated-from-settled-burn', 'no-observed-burn', 'incomplete-history', 'dead']) }).strict().nullable(),
  totals: amounts, daily: z.array(amounts.extend({ date: day }).strict()).max(366),
  lifecycle: z.array(z.object({ event: z.enum(['Birth', 'Dormant', 'Revived', 'Death']), timestampSeconds: units, transactionHash: hash,
    logIndex: z.number().int().nonnegative() }).strict()).max(1000),
}).strict();

/** The controller receives public whitelist fields only, without sharing either database or signing authority. */
export class RemoteAgentEconomics {
  private readonly origin: string;
  constructor(origin: string, private readonly chainId: number, private readonly options: { fetch?: typeof fetch } = {}) {
    this.origin = selectionPublicOrigin.parse(origin);
  }
  async get(input: AgentEconomicsRequest): Promise<AgentEconomicsResponse> {
    const request = parseAgentEconomicsRequest(input);
    try {
      const query = new URLSearchParams({ from: request.from, to: request.to });
      const report = agentEconomicsReportSchema.parse(await selectionPublicJson(this.origin,
        '/api/public/selection/agents/' + request.agentId + '?' + query.toString(), { ...this.options, timeoutMs: 35_000 }));
      if (report.index.chainId !== this.chainId || report.period.from !== request.from || report.period.to !== request.to
        || Date.parse(report.period.endExclusive) !== Date.parse(request.to) + 86_400_000
        || report.agent && report.agent.agentId !== request.agentId
        || report.metrics && report.metrics.balanceAtBlock !== report.index.indexedThrough
        || report.daily.length !== (Date.parse(request.to) - Date.parse(request.from)) / 86_400_000 + 1) throw new Error('Selection report binding changed');
      for (const total of [report.totals, ...report.daily, ...(report.agent ? [report.agent.lifetime] : [])]) {
        if (BigInt(total.feeUnits) > BigInt(total.incomeUnits) || BigInt(total.netIncomeUnits) !== BigInt(total.incomeUnits) - BigInt(total.feeUnits)) throw new Error('Selection amounts changed');
      }
      return report;
    } catch { throw new Problem(503, 'agent_economics_unavailable', 'Canonical agent evidence is unavailable. Retry after indexing.'); }
  }
}
