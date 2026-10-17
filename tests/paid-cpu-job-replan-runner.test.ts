import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { addressSchema, canonical, hashJson } from '../src/common.js';
import { PaidCpuJobReplanRunner, PAID_CPU_JOB_REPLAN_SCHEMA,
  type PaidCpuJobReplanRunnerOptions } from '../src/agents/paid-cpu-job-replan-runner.js';
import { PaidLifecycleClientVaultV3 } from '../src/agents/paid-lifecycle-vault-v3.js';
import { Ed25519Identity, hostMessageHash, leaseSchema } from '../src/host-kit/protocol.js';
import { paidPreemptionNoticeSchema, paidPreemptionOptInSchema } from '../src/host-kit/sessions/paid-preemption-protocol.js';
import { platformVaultRuntimeConfigSchema } from '../src/platform-runtime/vault-client.js';
import type { PlatformRuntimeRun } from '../src/platform-runtime/client.js';
import { platformPreparedSchema, platformWorkloadHash } from '../src/platform-runtime/types.js';
import { paidCpuJobInputSchema, paidCpuJobIntentHash, paidCpuJobSchema, type PaidCpuJob } from '../src/scheduling/paid-job-types.js';
import { planCpuReplacement } from '../src/scheduling/cpu-replacement.js';
import { TelomereApiError } from '../src/sdk/transport.js';

const h = (digit: string): `0x${string}` => `0x${digit.repeat(64)}`;
const otherAddress = addressSchema.parse('0x' + '1'.repeat(40));
type Journal = PaidCpuJobReplanRunnerOptions['journal'];

async function harness(journalFactory?: (scope: Journal['scope']) => Journal) {
  const raw: unknown = JSON.parse(await readFile(resolve('python/tests/fixtures/platform-typescript.json'), 'utf8'));
  if (!raw || typeof raw !== 'object' || !('vaultConfig' in raw) || !('vault' in raw)
    || !raw.vault || typeof raw.vault !== 'object' || !('prepared' in raw.vault)) throw new Error('Fixture missing');
  const config = platformVaultRuntimeConfigSchema.parse(raw.vaultConfig);
  const originalPrepared = platformPreparedSchema.parse(raw.vault.prepared);
  const input = paidCpuJobInputSchema.parse({ protocol: 'telomere-paid-cpu-job-v1', leashId: config.binding.leashId,
    task: { kind: 'session', imageDigest: 'sha256:' + 'a'.repeat(64), maxCommands: 8 }, workSeconds: 90,
    deadline: 2000, maxSpend: '30000', regions: ['test-one'], lanes: ['standard', 'interruptible'],
    interruptibleConsent: { minimumNoticeSeconds: 30 } });
  const jobId = h('1'), sourceRunId = originalPrepared.quote.runId;
  const intentHash = paidCpuJobIntentHash(jobId, config.binding, input, 1000, config.pins);
  const quoteInput = { leashId: input.leashId, task: input.task, maxSeconds: input.workSeconds,
    deadline: input.deadline, maxSpend: input.maxSpend, regions: input.regions,
    cpuScheduling: { version: 1 as const, lane: 'interruptible' as const, interruptibleConsent: input.interruptibleConsent!,
      job: { jobId, intentHash, targetHostId: originalPrepared.quote.hostId } } };
  const prepared = platformPreparedSchema.parse({ ...originalPrepared, input: quoteInput, ceiling: '9810',
    quote: { ...originalPrepared.quote, maxSeconds: 90, pricePerSecond: '100', quoteExpiry: 1100,
      workloadHash: platformWorkloadHash(quoteInput) } });
  const original = paidCpuJobSchema.parse({ protocol: 'telomere-paid-cpu-job-v1', id: jobId,
    owner: config.binding.owner, vault: config.binding.vault, intentHash, binding: config.binding,
    input, createdAt: 1000, phase: 'active', runIds: [sourceRunId], currentRunId: sourceRunId,
    proposal: null, approvalHash: null, charged: '0', outstandingLiability: prepared.ceiling,
    cancellationReason: null, prepared, fundsReserved: false, funding: 'external-wallet-required', stopAndRefundRequired: false });
  const controller = new Ed25519Identity(), host = new Ed25519Identity();
  const lease = controller.sign('lease', leaseSchema.parse({ version: 1, hostKey: host.publicKey, owner: original.vault,
    runId: sourceRunId, image: 'fixture/session@sha256:' + 'a'.repeat(64), argv: ['/usr/local/bin/node', '/opt/telomere/session-init.mjs'],
    maxSeconds: 90, issuedAt: 1000000, expiresAt: 1090000, nonce: h('2') }));
  const optIn = paidPreemptionOptInSchema.parse(controller.sign('paid-preemption-optin', {
    domain: 'telomere-paid-preemption-optin/v1', version: 1, hostKey: host.publicKey, owner: original.vault,
    runId: sourceRunId, leaseHash: hostMessageHash(lease), image: lease.body.image,
    nonce: h('3'), issuedAt: 1000000, expiresAt: 1090000 }));
  const notice = paidPreemptionNoticeSchema.parse(host.sign('paid-preemption', {
    domain: 'telomere-paid-preemption/v1', version: 1, hostKey: host.publicKey, owner: original.vault,
    runId: sourceRunId, leaseHash: hostMessageHash(lease), image: lease.body.image,
    noticeId: h('4'), optInHash: hostMessageHash(optIn), issuedAt: 1005000, interruptAt: 1035000, reason: 'capacity' }));
  const evidence = { hostId: prepared.quote.hostId, controllerKey: controller.publicKey,
    leaseHash: hostMessageHash(lease), lease, notice, optIn, terminalTick: null };
  const capture = { protocol: 'telomere-paid-preemption-capture-v1' as const, sourceRunId,
    sourceHostId: prepared.quote.hostId, sourceLeaseHash: evidence.leaseHash, notice,
    checkpointOperationId: 'cyst-hook-' + '5'.repeat(64), checkpointId: h('6'), checkpointCompletedAtMs: 1010000,
    maxSpend: input.maxSpend, deadline: input.deadline };
  const state: { job: PaidCpuJob; source: PlatformRuntimeRun; notice: boolean } = { job: structuredClone(original), notice: false,
    source: { id: sourceRunId, status: 'running', quote: prepared.quote, ceiling: prepared.ceiling,
      admissionTx: h('7'), settlementTx: null, result: null, settlement: null, charged: null, refund: null, errorCode: null } };
  const records = new Map<string, unknown>();
  let operation = Promise.resolve();
  const scope = { owner: config.binding.owner.toLowerCase(), agent: config.binding.agentWallet.toLowerCase(),
    applicationSchema: PAID_CPU_JOB_REPLAN_SCHEMA };
  const memory: Journal = { scope, read: async key => structuredClone(records.get(key)), claim: async (key, value) => {
    if (records.has(key) && canonical(records.get(key)) !== canonical(value)) throw new Error('immutable record');
    records.set(key, structuredClone(value));
  }, exclusiveOperation: async (_key, callback) => {
    const result = operation.then(callback); operation = result.then(() => undefined, () => undefined); return result;
  } };
  let journal = journalFactory?.(scope) ?? memory;
  const uniqueRequests = new Map<string, unknown>();
  const client = {
    config: vi.fn(async () => structuredClone(config)),
    cpuJob: vi.fn(async () => structuredClone(state.job)),
    get: vi.fn(async () => structuredClone(state.source)),
    preemptionNotice: vi.fn(async () => {
      if (!state.notice) throw new TelomereApiError(404, 'paid_preemption_notice_not_found');
      return structuredClone(evidence);
    }),
    replanCpuJob: vi.fn(async (_jobId: string, rawInput: unknown, key: string) => {
      if (uniqueRequests.has(key)) {
        if (canonical(uniqueRequests.get(key)) !== canonical(rawInput)) throw new Error('changed replay');
        return structuredClone(state.job);
      }
      if (!rawInput || typeof rawInput !== 'object' || !('expectedSourceRunId' in rawInput)
        || rawInput.expectedSourceRunId !== state.job.currentRunId) throw new TelomereApiError(409, 'paid_cpu_job_source_changed');
      if (state.job.phase !== 'active') throw new TelomereApiError(409, 'paid_cpu_job_phase');
      uniqueRequests.set(key, structuredClone(rawInput));
      const planned = planCpuReplacement({ jobId, original: { hardwareClasses: ['cpu'], images: [input.task.imageDigest],
        regions: input.regions, sealedOnly: false, lanes: input.lanes, seconds: input.workSeconds,
        maxSpend: input.maxSpend, deadline: input.deadline, now: 1000 }, source: { runId: sourceRunId,
        hostId: prepared.quote.hostId, quoteHash: hashJson(prepared.quote), ceiling: prepared.ceiling }, now: 1040,
        remainingSeconds: 40, restoreSeconds: 10, checkpointHash: hashJson({ checkpointId: capture.checkpointId }),
        sourceCleanupConfirmed: true, sourceSettlement: { receiptHash: h('8'), charged: '1000', refund: '8810', confirmed: true },
        priorCharged: '0', outstandingLiability: '0' }, [{ hostId: h('9'), hardwareClass: 'cpu', region: 'test-one',
        imageDigest: input.task.imageDigest, sealed: false, lane: 'standard', pricePerSecond: '101', reliabilityBps: 10000,
        strikes: 0, stake: '0', availableAt: 1040 }]);
      if (planned.action !== 'proposal') throw new Error('Fixture replacement missing');
      state.job = paidCpuJobSchema.parse({ ...state.job, phase: 'awaiting_owner', proposal: planned.proposal, prepared: null });
      return structuredClone(state.job);
    }),
  };
  const handoff = { capture: vi.fn(async () => structuredClone(capture)) };
  const create = (extra: Partial<PaidCpuJobReplanRunnerOptions> = {}) => new PaidCpuJobReplanRunner({
    job: original, remainingSeconds: 40, restoreSeconds: 10, client, handoff, journal, ...extra });
  const settle = () => {
    state.source = { ...state.source, status: 'completed', settlementTx: h('a'), charged: '1000', refund: '8810',
      result: { status: 'cancelled' }, settlement: { runId: sourceRunId, endedAt: 1040, billableSeconds: 10,
        inferenceCharge: '0', receiptHash: h('8') } };
    state.job.charged = '1000'; state.job.outstandingLiability = '0';
  };
  return { config, original, sourceRunId, client, handoff, state, capture, records, journal, create, settle, uniqueRequests,
    setJournal: (value: Journal) => { journal = value; } };
}

it('autonomously captures one signed notice and requests one replacement after canonical source settlement', async () => {
  const f = await harness(), runner = f.create();
  expect(await runner.runOnce()).toMatchObject({ state: 'waiting_notice', sourceRunId: f.sourceRunId });
  expect(f.handoff.capture).not.toHaveBeenCalled(); expect(f.client.replanCpuJob).not.toHaveBeenCalled();
  f.state.notice = true;
  expect(await runner.tick()).toMatchObject({ state: 'waiting_source', checkpointId: f.capture.checkpointId });
  expect(f.handoff.capture).toHaveBeenCalledWith(f.sourceRunId, f.original.input.maxSpend, f.original.input.deadline);
  f.settle();
  expect(await runner.runOnce()).toMatchObject({ state: 'awaiting_owner', checkpointId: f.capture.checkpointId,
    decisionHash: f.state.job.proposal!.decisionHash });
  expect(f.client.replanCpuJob.mock.calls[0]?.[1]).toEqual({ expectedSourceRunId: f.sourceRunId,
    checkpointHash: hashJson({ checkpointId: f.capture.checkpointId }), remainingSeconds: 40, restoreSeconds: 10 });
  expect(await f.create().runOnce()).toMatchObject({ state: 'awaiting_owner' });
  expect(f.handoff.capture).toHaveBeenCalledTimes(1); expect(f.client.replanCpuJob).toHaveBeenCalledTimes(1);
  expect(Object.keys(f.client).sort()).toEqual(['config', 'cpuJob', 'get', 'preemptionNotice', 'replanCpuJob']);
});

it('serializes concurrent instances so a notice produces one capture and one proposal', async () => {
  const f = await harness(); f.state.notice = true; f.settle();
  const results = await Promise.all([f.create().runOnce(), f.create().runOnce(), f.create().runOnce()]);
  expect(results.map(result => result.state)).toEqual(['awaiting_owner', 'awaiting_owner', 'awaiting_owner']);
  expect(f.handoff.capture).toHaveBeenCalledTimes(1); expect(f.client.replanCpuJob).toHaveBeenCalledTimes(1);
});

it('reuses the durable handoff identity after a lost capture response', async () => {
  const f = await harness(); f.state.notice = true;
  f.handoff.capture.mockRejectedValueOnce(new Error('lost capture response after checkpoint commit'));
  await expect(f.create().runOnce()).rejects.toThrow('lost capture response');
  expect(await f.create().runOnce()).toMatchObject({ state: 'waiting_source', checkpointId: f.capture.checkpointId });
  expect(f.handoff.capture.mock.calls[0]).toEqual(f.handoff.capture.mock.calls[1]);
  expect(f.client.replanCpuJob).not.toHaveBeenCalled();
});

it('reconciles the exact original server key after a committed replacement response is lost', async () => {
  const f = await harness(); f.state.notice = true; f.settle();
  const original = f.client.replanCpuJob.getMockImplementation()!;
  f.client.replanCpuJob.mockImplementationOnce(async (...args) => { await original(...args); throw new Error('lost replan response'); });
  await expect(f.create().runOnce()).rejects.toThrow('lost replan response');
  expect(await f.create().runOnce()).toMatchObject({ state: 'awaiting_owner' });
  expect(f.client.replanCpuJob).toHaveBeenCalledTimes(2); expect(f.uniqueRequests.size).toBe(1);
  expect(f.client.replanCpuJob.mock.calls[0]).toEqual(f.client.replanCpuJob.mock.calls[1]);
});

it('retries an uncommitted ambiguous replan with exactly the same source, body and operation key', async () => {
  const f = await harness(); f.state.notice = true; f.settle();
  f.client.replanCpuJob.mockRejectedValueOnce(new Error('network response unknown'));
  await expect(f.create().runOnce()).rejects.toThrow('network response unknown');
  expect(await f.create().runOnce()).toMatchObject({ state: 'awaiting_owner' });
  expect(f.client.replanCpuJob.mock.calls[0]).toEqual(f.client.replanCpuJob.mock.calls[1]);
  expect(f.handoff.capture).toHaveBeenCalledTimes(1);
});

it('does not adopt an identical manual proposal under another server key after an ambiguous request', async () => {
  const f = await harness(); f.state.notice = true; f.settle();
  f.client.replanCpuJob.mockRejectedValueOnce(new Error('request not accepted'));
  await expect(f.create().runOnce()).rejects.toThrow('request not accepted');
  const request = f.client.replanCpuJob.mock.calls[0]!;
  await f.client.replanCpuJob(request[0], request[1], 'different-manual-owner-key');
  await expect(f.create().runOnce()).rejects.toMatchObject({ code: 'paid_cpu_job_phase' });
  expect(f.client.replanCpuJob.mock.calls[2]).toEqual(request);
  expect([...f.records.keys()].some(key => key.endsWith(':accepted'))).toBe(false);
});

it.each(['receipt_pending', 'settling', 'reconciliation'] as const)('waits for original %s source without counting its anticipated refund', async status => {
  const f = await harness(); f.state.notice = true; f.settle(); f.state.source.status = status;
  expect(await f.create().runOnce()).toMatchObject({ state: 'waiting_source' });
  expect(f.client.replanCpuJob).not.toHaveBeenCalled();
});

it.each(['transaction', 'conservation', 'admission', 'liability'] as const)('refuses to replan while %s evidence is uncertain', async change => {
  const f = await harness(); f.state.notice = true; f.settle();
  if (change === 'transaction') f.state.source.settlementTx = null;
  if (change === 'conservation') f.state.source.refund = '0';
  if (change === 'admission') f.state.source.admissionTx = null;
  if (change === 'liability') f.state.job.outstandingLiability = '1';
  expect(await f.create().runOnce()).toMatchObject({ state: 'waiting_source' });
  expect(f.client.replanCpuJob).not.toHaveBeenCalled();
});

it('retains the same request when canonical source verification regresses before the server POST', async () => {
  const f = await harness(); f.state.notice = true; f.settle();
  f.client.replanCpuJob.mockRejectedValueOnce(new TelomereApiError(409, 'paid_cpu_source_pending'));
  expect(await f.create().runOnce()).toMatchObject({ state: 'waiting_source' });
  expect(await f.create().runOnce()).toMatchObject({ state: 'awaiting_owner' });
  expect(f.client.replanCpuJob.mock.calls[0]).toEqual(f.client.replanCpuJob.mock.calls[1]);
});

it.each(['current source', 'intent', 'workload', 'proposal'] as const)('leaves a changed %s to its current owner without capture or replan', async change => {
  const f = await harness(); f.state.notice = true;
  if (change === 'current source') { f.state.job.currentRunId = h('b'); f.state.job.runIds.push(h('b')); }
  if (change === 'intent') f.state.job.intentHash = h('b');
  if (change === 'workload') f.state.job.input.deadline++;
  if (change === 'proposal') f.state.job.phase = 'approved';
  expect(await f.create().runOnce()).toMatchObject({ state: 'superseded' });
  expect(f.handoff.capture).not.toHaveBeenCalled(); expect(f.client.replanCpuJob).not.toHaveBeenCalled();
});

it('stops an old lost-response retry when the owner has already approved the successor', async () => {
  const f = await harness(); f.state.notice = true; f.settle();
  expect(await f.create().runOnce()).toMatchObject({ state: 'awaiting_owner' });
  f.state.job.currentRunId = h('b'); f.state.job.runIds.push(h('b')); f.state.job.phase = 'active';
  expect(await f.create().runOnce()).toMatchObject({ state: 'superseded' });
  expect(f.client.replanCpuJob).toHaveBeenCalledTimes(1); expect(f.handoff.capture).toHaveBeenCalledTimes(1);
});

it('passes a source fence when the owner advances immediately before replan', async () => {
  const f = await harness(); f.state.notice = true; f.settle();
  const original = f.client.replanCpuJob.getMockImplementation()!;
  f.client.replanCpuJob.mockImplementationOnce(async (...args) => {
    f.state.job.currentRunId = h('b'); f.state.job.runIds.push(h('b'));
    return original(...args);
  });
  expect(await f.create().runOnce()).toMatchObject({ state: 'superseded' });
  expect(f.state.job.phase).toBe('active'); expect(f.state.job.currentRunId).toBe(h('b'));
});

it('does not interpret a same-key server replay returning a successor as an owner proposal', async () => {
  const f = await harness(); f.state.notice = true; f.settle();
  f.client.replanCpuJob.mockImplementationOnce(async () => {
    f.state.job.currentRunId = h('b'); f.state.job.runIds.push(h('b')); return structuredClone(f.state.job);
  });
  expect(await f.create().runOnce()).toMatchObject({ state: 'superseded' });
});

it.each(['owner', 'vault', 'agent', 'chain'] as const)('rejects changed %s configuration before a checkpoint operation', async change => {
  const f = await harness();
  const config = structuredClone(f.config);
  if (change === 'owner') config.binding.owner = otherAddress;
  if (change === 'vault') config.binding.vault = otherAddress;
  if (change === 'agent') config.binding.agentWallet = otherAddress;
  if (change === 'chain') config.pins.escrowCodeHash = h('b');
  f.client.config.mockResolvedValue(config);
  await expect(f.create().runOnce()).rejects.toThrow('reviewed owner, agent Vault or chain');
  expect(f.handoff.capture).not.toHaveBeenCalled(); expect(f.client.replanCpuJob).not.toHaveBeenCalled();
});

it.each(['price', 'ceiling', 'owner', 'vault'] as const)('fences a changed %s in the retained source snapshot before application capture', async change => {
  const f = await harness(); f.state.notice = true;
  if (change === 'price') f.state.job.prepared!.quote.pricePerSecond = '999';
  if (change === 'ceiling') f.state.job.prepared!.ceiling = '999';
  if (change === 'owner') f.state.job.owner = otherAddress;
  if (change === 'vault') f.state.job.vault = otherAddress;
  expect(await f.create().runOnce()).toMatchObject({ state: 'superseded' });
  expect(f.handoff.capture).not.toHaveBeenCalled(); expect(f.client.replanCpuJob).not.toHaveBeenCalled();
});

it.each(['source', 'notice', 'budget', 'late', 'lease'] as const)('rejects a %s capture mismatch before retaining a replan request', async change => {
  const f = await harness(); f.state.notice = true; f.settle();
  const capture = structuredClone(f.capture);
  if (change === 'source') capture.sourceRunId = h('b');
  if (change === 'notice') capture.notice.body.noticeId = h('b');
  if (change === 'budget') capture.maxSpend = '40000';
  if (change === 'late') capture.checkpointCompletedAtMs = capture.notice.body.interruptAt + 1;
  if (change === 'lease') capture.sourceLeaseHash = h('b');
  f.handoff.capture.mockResolvedValue(capture);
  await expect(f.create().runOnce()).rejects.toThrow('checkpoint changed');
  expect(f.client.replanCpuJob).not.toHaveBeenCalled();
});

it('does not adopt a manually substituted checkpoint in the replacement response', async () => {
  const f = await harness(); f.state.notice = true; f.settle();
  const original = f.client.replanCpuJob.getMockImplementation()!;
  f.client.replanCpuJob.mockImplementationOnce(async (...args) => {
    const value = await original(...args); value.proposal!.checkpointHash = h('b'); return value;
  });
  await expect(f.create().runOnce()).rejects.toThrow('response changed its original checkpoint');
});

it.each(['target price', 'financial charge'] as const)('rejects a changed %s beneath an unchanged accepted decision hash', async change => {
  const f = await harness(); f.state.notice = true; f.settle();
  expect(await f.create().runOnce()).toMatchObject({ state: 'awaiting_owner' });
  const acceptedHash = f.state.job.proposal!.decisionHash;
  if (change === 'target price') f.state.job.proposal!.target.pricePerSecond = '999';
  if (change === 'financial charge') f.state.job.proposal!.charged = '1';
  expect(f.state.job.proposal!.decisionHash).toBe(acceptedHash);
  expect(await f.create().runOnce()).toMatchObject({ state: 'superseded' });
  expect(f.client.replanCpuJob).toHaveBeenCalledTimes(1); expect(f.handoff.capture).toHaveBeenCalledTimes(1);
});

it('distinguishes the exact absent-notice code from auth, transport and unrelated missing-resource failures', async () => {
  const f = await harness();
  for (const error of [new TelomereApiError(404, 'platform_session_lease_missing'), new TelomereApiError(401, 'unauthorized'),
    new Error('transport unavailable')]) {
    f.client.preemptionNotice.mockRejectedValueOnce(error);
    await expect(f.create().runOnce()).rejects.toBe(error);
  }
  expect(f.handoff.capture).not.toHaveBeenCalled(); expect(f.client.replanCpuJob).not.toHaveBeenCalled();
});

it('binds remaining work and restore estimates across actual encrypted v3 journal reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-cpu-replan-')), masterKey = randomBytes(32);
  let vault: PaidLifecycleClientVaultV3 | undefined;
  const open = (scope: Journal['scope']) => vault = new PaidLifecycleClientVaultV3({ directory, masterKey, ...scope,
    policy: { version: 3, buckets: 64, maxRecordsPerBucket: 512, maxEncodedRecordBytes: 32768, maxJournalBytes: 1073741824 } });
  try {
    const f = await harness(open); f.state.notice = true;
    expect(await f.create().runOnce()).toMatchObject({ state: 'waiting_source' });
    vault!.close(); f.setJournal(open(f.journal.scope));
    await expect(f.create({ remainingSeconds: 41 }).runOnce()).rejects.toThrow('different original facts');
    f.settle(); expect(await f.create().runOnce()).toMatchObject({ state: 'awaiting_owner', checkpointId: f.capture.checkpointId });
    expect(f.handoff.capture).toHaveBeenCalledTimes(1); expect(f.client.replanCpuJob).toHaveBeenCalledTimes(1);
  } finally {
    vault?.close(); masterKey.fill(0);
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('telomere-cpu-replan-')) throw new Error('Unsafe CPU replan test cleanup');
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

it('rejects changed private journal scope or a work estimate beyond the original immutable job', async () => {
  const f = await harness();
  expect(() => f.create({ journal: { ...f.journal, scope: { ...f.journal.scope, agent: '0x' + '1'.repeat(40) } } })).toThrow('journal scope');
  expect(() => f.create({ remainingSeconds: 91, restoreSeconds: 10 })).toThrow('work estimate');
});

it('waits without overlapping cycles and aborts a long poll immediately without starting another cycle', async () => {
  const f = await harness(), abort = new AbortController();
  let seen!: () => void;
  const firstStatus = new Promise<void>(resolve => { seen = resolve; });
  const watching = f.create().watch({ signal: abort.signal, pollMs: 5000, onStatus: () => { seen(); } });
  await firstStatus; abort.abort();
  expect(await watching).toMatchObject({ state: 'aborted' }); expect(f.client.preemptionNotice).toHaveBeenCalledTimes(1);
  expect(f.handoff.capture).not.toHaveBeenCalled(); expect(f.client.replanCpuJob).not.toHaveBeenCalled();
});

it('returns the terminal proposal from explicit watch and refuses invalid polling intervals', async () => {
  const f = await harness(); f.state.notice = true; f.settle(); const signal = new AbortController().signal;
  expect(await f.create().watch({ signal, pollMs: 100 })).toMatchObject({ state: 'awaiting_owner' });
  await expect(f.create().watch({ signal, pollMs: 0 })).rejects.toThrow();
  const abort = new AbortController(); abort.abort();
  expect(await f.create().watch({ signal: abort.signal })).toMatchObject({ state: 'aborted' });
});
