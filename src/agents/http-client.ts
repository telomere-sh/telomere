import { z } from 'zod';
import { CYST_CAPABILITIES, cystIdSchema, cystMetadataSchema } from '../cysts/types.js';
import { CystClient } from '../sdk/cysts.js';
import { ApiTransport } from '../sdk/transport.js';
import type { ClientLifelineControl } from './lifeline.js';
import type { AgentLifecycleService } from './service.js';
import { agentAddressSchema, agentModeSchema, intentIdSchema, POLICY, PAID_AGENT_POLICY, unitsSchema } from './types.js';
import { evaluateMetabolismV2, metabolismV2EvaluationFields } from './metabolism-v2.js';
import { hashJson } from '../common.js';

const date = z.string().datetime();
const agentSchema = z.object({ owner: agentAddressSchema, agent: agentAddressSchema, version: z.number().int().nonnegative(),
  mode: agentModeSchema, currentRunId: cystIdSchema.nullable(), checkpointId: cystIdSchema.nullable(),
  leaseUntil: date.nullable(), wakeAt: date.nullable(), killedAt: date.nullable(), createdAt: date, updatedAt: date }).strict();
const economicEvaluationSchema = z.object({ mode: agentModeSchema, balance: unitsSchema, trailing24hBurn: unitsSchema,
  runwaySeconds: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable() }).strict();
const economicEvaluationV2Schema = economicEvaluationSchema.extend(metabolismV2EvaluationFields).superRefine((value, context) => {
  try {
    if (hashJson(evaluateMetabolismV2(value.balance, value.trailing24hBurn, value.pricing)) !== hashJson(value)) {
      context.addIssue({ code: 'custom', message: 'Current-rate Metabolism facts differ from the exact profile decision' });
    }
  } catch { context.addIssue({ code: 'custom', message: 'Current-rate Metabolism pricing is inconsistent' }); }
});
const intentSchema = z.object({ id: intentIdSchema, owner: agentAddressSchema, agent: agentAddressSchema, idemKey: z.string(), requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(['migrate', 'sleep', 'wake', 'profile', 'kill', 'rollover']), phase: z.enum(['checkpoint', 'stop', 'attach', 'resume', 'profile', 'done']),
  targetMode: agentModeSchema, sourceRunId: cystIdSchema.nullable(), targetRunId: cystIdSchema.nullable(),
  checkpointId: cystIdSchema.nullable(), checkpointSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  targetLeaseUntil: date.nullable(), version: z.number().int().nonnegative(), createdAt: date, updatedAt: date,
  metabolismVersion: z.literal(2).optional(), metabolismEvaluation: economicEvaluationV2Schema.optional() }).strict()
  .superRefine((intent, context) => {
    if ((intent.metabolismVersion === 2) !== (intent.metabolismEvaluation !== undefined)
      || intent.metabolismEvaluation && intent.metabolismEvaluation.mode !== intent.targetMode && intent.kind !== 'sleep') {
      context.addIssue({ code: 'custom', message: 'Lifecycle Metabolism version or selected mode changed' });
    }
  }).transform(value => {
    const { metabolismVersion, metabolismEvaluation, ...original } = value;
    return { ...original, ...(metabolismVersion === 2 ? { metabolismVersion: 2 as const, metabolismEvaluation: metabolismEvaluation! } : {}) };
  });
const legacyPolicySchema = z.object({ trailingBurnSeconds: z.literal(POLICY.trailingBurnSeconds), maximumLeaseSeconds: z.literal(POLICY.maximumLeaseSeconds),
  rollBeforeSeconds: z.literal(POLICY.rollBeforeSeconds), maximumAgentsPerOwner: z.literal(POLICY.maximumAgentsPerOwner), applicationStateOnly: z.literal(true) }).strict();
const policySchema = z.union([legacyPolicySchema, legacyPolicySchema.extend({
  maximumLeaseSeconds: z.literal(PAID_AGENT_POLICY.maximumLeaseSeconds), rollBeforeSeconds: z.literal(PAID_AGENT_POLICY.rollBeforeSeconds),
})]);
const flags = { rollDue: z.boolean(), scheduledWakeDue: z.boolean(), killed: z.boolean() };
const evaluationSchema = z.union([economicEvaluationSchema.extend(flags), z.object({ ...economicEvaluationSchema.shape,
  ...metabolismV2EvaluationFields, ...flags }).strict().superRefine((value, context) => {
  const { rollDue: _roll, scheduledWakeDue: _wake, killed: _killed, ...economic } = value;
  if (!economicEvaluationV2Schema.safeParse(economic).success) context.addIssue({ code: 'custom', message: 'Current-rate Metabolism facts are inconsistent' });
})]);
function assertScope(owner: string, agent: string, result: { agent: z.infer<typeof agentSchema>; intent?: z.infer<typeof intentSchema> | null }) {
  if (result.agent.owner !== owner || result.agent.agent !== agent || result.intent && (result.intent.owner !== owner || result.intent.agent !== agent)) {
    throw new Error('Lifecycle response changed owner or agent scope');
  }
}

/** Uses the existing bounded HTTPS transport and authenticated cookie; this client never accepts signing keys. */
export class HttpAgentLifecycleControl implements ClientLifelineControl {
  private readonly cysts: CystClient;
  private readonly options: { metabolismVersion?: 2 | undefined; cystQuotaVersion?: 2 | undefined };
  constructor(private readonly transport: ApiTransport, options: { metabolismVersion?: 2; cystQuotaVersion?: 2 } = {}) {
    this.options = Object.freeze(z.object({ metabolismVersion: z.literal(2).optional(), cystQuotaVersion: z.literal(2).optional() }).strict().parse(options));
    this.cysts = new CystClient(transport, this.options.cystQuotaVersion === 2 ? { quotaVersion: 2 } : {});
  }
  get checkpointQuotaVersion(): 1 | 2 { return this.cysts.quotaVersion; }
  /** Check the exact Cyst client used by lifecycle uploads, rather than a
   * different transport that happened to negotiate a larger quota. */
  checkpointStorage() { return this.cysts.list(); }
  async register(ownerValue: string, agentValue: string, runId?: string): ReturnType<AgentLifecycleService['register']> {
    const owner = agentAddressSchema.parse(ownerValue), agent = agentAddressSchema.parse(agentValue);
    const result = z.object({ agent: agentSchema, replayed: z.boolean() }).strict().parse(await this.transport.request('/api/agents',
      { method: 'POST', body: { agent, ...(runId ? { runId: cystIdSchema.parse(runId) } : {}) } }));
    assertScope(owner, agent, result); return result;
  }
  async list(ownerValue: string): ReturnType<AgentLifecycleService['list']> {
    const owner = agentAddressSchema.parse(ownerValue);
    const result = z.object({ agents: z.array(agentSchema).max(POLICY.maximumAgentsPerOwner), policy: policySchema }).strict()
      .parse(await this.transport.request('/api/agents'));
    if (result.agents.some(agent => agent.owner !== owner)) throw new Error('Lifecycle list changed owner scope');
    return result;
  }
  async get(ownerValue: string, agentValue: string): ReturnType<AgentLifecycleService['get']> {
    const owner = agentAddressSchema.parse(ownerValue), agent = agentAddressSchema.parse(agentValue);
    const result = z.object({ agent: agentSchema, intent: intentSchema.nullable(), policy: policySchema }).strict()
      .parse(await this.transport.request('/api/agents/' + agent));
    assertScope(owner, agent, result); return result;
  }
  async evaluate(owner: string, agent: string, metabolismVersion?: 2): ReturnType<AgentLifecycleService['evaluate']> {
    z.literal(2).optional().parse(metabolismVersion);
    await this.get(owner, agent);
    const version = metabolismVersion ?? this.options.metabolismVersion;
    const result = evaluationSchema.parse(await this.transport.request('/api/agents/' + agentAddressSchema.parse(agent)
      + '/evaluation' + (version === 2 ? '?metabolismVersion=2' : '')));
    if (version === 2 && (!('metabolismVersion' in result) || result.metabolismVersion !== 2)) {
      throw new Error('Current-rate Metabolism response omitted its required version');
    }
    return result;
  }
  async plan(ownerValue: string, agentValue: string, input: unknown, idempotencyKey: string): ReturnType<AgentLifecycleService['plan']> {
    const owner = agentAddressSchema.parse(ownerValue), agent = agentAddressSchema.parse(agentValue);
    const body = this.options.metabolismVersion === 2 ? { ...z.record(z.unknown()).parse(input), metabolismVersion: 2 } : input;
    const requestedVersion = z.object({ metabolismVersion: z.literal(2).optional() }).passthrough().parse(body).metabolismVersion;
    const result = z.object({ agent: agentSchema, intent: intentSchema, replayed: z.boolean(), evaluation: evaluationSchema.nullable() }).strict()
      .parse(await this.transport.request('/api/agents/' + agent + '/transitions', { method: 'POST', body, idempotencyKey }));
    if (result.evaluation === null && result.intent.kind !== 'kill') throw new Error('Only owner kill may omit financial evaluation');
    if (requestedVersion === 2 && result.intent.kind !== 'kill'
      && (!result.evaluation || !('metabolismVersion' in result.evaluation) || result.evaluation.metabolismVersion !== 2
        || result.intent.metabolismVersion !== 2)) throw new Error('Current-rate Metabolism plan omitted its required version');
    assertScope(owner, agent, result); return result;
  }
  async acknowledge(ownerValue: string, intentId: string, expectedVersion: number, acknowledgment: unknown): ReturnType<AgentLifecycleService['acknowledge']> {
    const owner = agentAddressSchema.parse(ownerValue), id = intentIdSchema.parse(intentId);
    const result = z.object({ agent: agentSchema, intent: intentSchema }).strict().parse(await this.transport.request('/api/agents/intents/' + id + '/ack',
      { method: 'POST', body: { expectedVersion, acknowledgment } }));
    assertScope(owner, result.agent.agent, result);
    if (result.intent.id !== id) throw new Error('Lifecycle acknowledgment changed intent identifier');
    return result;
  }
  async validateExecution(owner: string, intentId: string, expectedVersion: number, phase: string): ReturnType<AgentLifecycleService['validateExecution']> {
    agentAddressSchema.parse(owner); const id = intentIdSchema.parse(intentId);
    const result = z.object({ valid: z.literal(true), operationId: z.literal(id + ':' + phase) }).strict().parse(await this.transport.request('/api/agents/intents/' + id + '/execution',
      { method: 'POST', body: { expectedVersion, phase } }));
    return result;
  }
  async upload(owner: string, envelope: Parameters<CystClient['upload']>[0], key: string) {
    if (envelope.owner !== agentAddressSchema.parse(owner)) throw new Error('Checkpoint owner differs from lifecycle owner');
    return this.cysts.upload(envelope, key);
  }
  async download(ownerValue: string, checkpointId: string) {
    const owner = agentAddressSchema.parse(ownerValue), id = cystIdSchema.parse(checkpointId);
    const result = z.object({ metadata: cystMetadataSchema, ciphertext: z.string().max(Math.ceil(CYST_CAPABILITIES.maxCiphertextBytes / 3) * 4) }).strict()
      .parse(await this.transport.request('/api/cysts/' + id + '/blob', { maxResponseBytes: CYST_CAPABILITIES.maxUploadBodyBytes,
        ...(this.options.cystQuotaVersion === 2 ? { cystQuotaVersion: 2 } : {}) }));
    if (result.metadata.owner !== owner || result.metadata.id !== id || result.metadata.state !== 'ready') throw new Error('Checkpoint download changed owner or identifier');
    return result;
  }
}
