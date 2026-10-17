import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { addressSchema, canonical, hashJson } from '../src/common.js';
import { PaidCpuJobFinishRunner, PAID_CPU_JOB_FINISH_SCHEMA,
  type PaidCpuJobFinishRunnerOptions } from '../src/agents/paid-cpu-job-finish-runner.js';
import { PaidLifecycleClientVaultV3 } from '../src/agents/paid-lifecycle-vault-v3.js';
import { platformVaultRuntimeConfigSchema } from '../src/platform-runtime/vault-client.js';
import type { PlatformRuntimeRun } from '../src/platform-runtime/client.js';
import { platformPreparedSchema, platformWorkloadHash } from '../src/platform-runtime/types.js';
import { paidCpuJobInputSchema, paidCpuJobIntentHash, paidCpuJobSchema, type PaidCpuJob } from '../src/scheduling/paid-job-types.js';
import { TelomereApiError } from '../src/sdk/transport.js';

const h = (digit: string): `0x${string}` => `0x${digit.repeat(64)}`;
type Journal = PaidCpuJobFinishRunnerOptions['journal'];
async function harness(journalFactory?: (scope: Journal['scope']) => Journal) {
  const raw: unknown = JSON.parse(await readFile(resolve('python/tests/fixtures/platform-typescript.json'), 'utf8'));
  if (!raw || typeof raw !== 'object' || !('vaultConfig' in raw) || !('vault' in raw)
    || !raw.vault || typeof raw.vault !== 'object' || !('prepared' in raw.vault)) throw new Error('Fixture missing');
  const config = platformVaultRuntimeConfigSchema.parse(raw.vaultConfig), fixture = platformPreparedSchema.parse(raw.vault.prepared);
  const input = paidCpuJobInputSchema.parse({ protocol: 'telomere-paid-cpu-job-v1', leashId: config.binding.leashId,
    task: { kind: 'session', imageDigest: 'sha256:' + 'a'.repeat(64), maxCommands: 8 }, workSeconds: 90,
    deadline: 2000, maxSpend: '30000', regions: ['test-one'], lanes: ['standard'] });
  const jobId = h('1'), sourceRunId = fixture.quote.runId;
  const intentHash = paidCpuJobIntentHash(jobId, config.binding, input, 1000, config.pins);
  const quoteInput = { leashId: input.leashId, task: input.task, maxSeconds: input.workSeconds,
    deadline: input.deadline, maxSpend: input.maxSpend, regions: input.regions,
    cpuScheduling: { version: 1 as const, lane: 'standard' as const, job: { jobId, intentHash, targetHostId: fixture.quote.hostId } } };
  const prepared = platformPreparedSchema.parse({ ...fixture, input: quoteInput, ceiling: '9810',
    quote: { ...fixture.quote, maxSeconds: 90, pricePerSecond: '100', quoteExpiry: 1100, workloadHash: platformWorkloadHash(quoteInput) } });
  const original = paidCpuJobSchema.parse({ protocol: 'telomere-paid-cpu-job-v1', id: jobId,
    owner: config.binding.owner, vault: config.binding.vault, intentHash, binding: config.binding,
    input, createdAt: 1000, phase: 'active', runIds: [sourceRunId], currentRunId: sourceRunId,
    proposal: null, approvalHash: null, charged: '0', outstandingLiability: prepared.ceiling,
    cancellationReason: null, prepared, fundsReserved: false, funding: 'external-wallet-required', stopAndRefundRequired: false });
  const state: { job: PaidCpuJob; source: PlatformRuntimeRun } = { job: structuredClone(original),
    source: { id: sourceRunId, status: 'running', quote: prepared.quote, ceiling: prepared.ceiling,
      admissionTx: h('7'), settlementTx: null, result: null, settlement: null, charged: null, refund: null, errorCode: null } };
  const records = new Map<string, unknown>(); let operation = Promise.resolve();
  const scope = { owner: config.binding.owner.toLowerCase(), agent: config.binding.agentWallet.toLowerCase(),
    applicationSchema: PAID_CPU_JOB_FINISH_SCHEMA };
  const memory: Journal = { scope, read: async key => structuredClone(records.get(key)), claim: async (key, value) => {
    if (records.has(key) && canonical(records.get(key)) !== canonical(value)) throw new Error('immutable record');
    records.set(key, structuredClone(value));
  }, exclusiveOperation: async (_key, callback) => {
    const result = operation.then(callback); operation = result.then(() => undefined, () => undefined); return result;
  } };
  let journal = journalFactory?.(scope) ?? memory;
  const client = { config: vi.fn(async () => structuredClone(config)), cpuJob: vi.fn(async () => structuredClone(state.job)),
    get: vi.fn(async () => structuredClone(state.source)), finishCpuJob: vi.fn(async (_id: string, body: unknown) => {
      if (!body || typeof body !== 'object' || !('expectedSourceRunId' in body)
        || body.expectedSourceRunId !== state.job.currentRunId) throw new TelomereApiError(409, 'paid_cpu_job_source_changed');
      if (state.job.phase !== 'active' && state.job.phase !== 'finished') throw new TelomereApiError(409, 'paid_cpu_job_phase');
      state.job = paidCpuJobSchema.parse({ ...state.job, phase: 'finished', prepared: null }); return structuredClone(state.job);
    }) };
  const create = (extra: Partial<PaidCpuJobFinishRunnerOptions> = {}) => new PaidCpuJobFinishRunner({
    job: original, applicationCompletionHash: h('c'), client, journal, ...extra });
  const settle = () => {
    state.source = { ...state.source, status: 'completed', settlementTx: h('a'), charged: '1000', refund: '8810',
      result: { status: 'cancelled' }, settlement: { runId: sourceRunId, endedAt: 1040, billableSeconds: 10,
        inferenceCharge: '0', receiptHash: h('8') } };
    state.job.charged = '1000'; state.job.outstandingLiability = '0';
  };
  return { config, original, sourceRunId, state, client, records, journal, create, settle,
    setJournal: (value: Journal) => { journal = value; } };
}

it('retains explicit application completion, waits for original finances, then source-fences finish without any other authority', async () => {
  const f = await harness();
  expect(await f.create().runOnce()).toMatchObject({ state: 'waiting_source', applicationCompletionHash: h('c') });
  expect(f.client.finishCpuJob).not.toHaveBeenCalled();
  const declaration = [...f.records.entries()].find(([key]) => key.endsWith(':original'))?.[1];
  expect(declaration).toMatchObject({ intentHash: f.original.intentHash, sourceRunId: f.sourceRunId, applicationCompletionHash: h('c') });
  f.settle(); // Financial status cancelled does not declare success; the owner already explicitly declared completion.
  expect(await f.create().tick()).toMatchObject({ state: 'finished', job: { phase: 'finished' } });
  expect(f.client.finishCpuJob).toHaveBeenCalledWith(f.original.id, { expectedSourceRunId: f.sourceRunId });
  expect(Object.keys(f.client).sort()).toEqual(['config', 'cpuJob', 'finishCpuJob', 'get']);
});

it('serializes concurrent finish callers and retains the same original request on finished replay', async () => {
  const f = await harness(); f.settle();
  expect((await Promise.all([f.create().runOnce(), f.create().runOnce(), f.create().runOnce()])).map(value => value.state))
    .toEqual(['finished', 'finished', 'finished']);
  expect(new Set(f.client.finishCpuJob.mock.calls.map(call => canonical(call))).size).toBe(1);
  expect([...f.records.keys()].filter(key => key.endsWith(':request'))).toHaveLength(1);
});

it.each(['before commit', 'after commit'] as const)('reconciles a lost response %s with the exact original request', async when => {
  const f = await harness(); f.settle(); const finish = f.client.finishCpuJob.getMockImplementation()!;
  f.client.finishCpuJob.mockImplementationOnce(async (...args) => {
    if (when === 'after commit') await finish(...args); throw new Error('lost finish response');
  });
  await expect(f.create().runOnce()).rejects.toThrow('lost finish response');
  expect(await f.create().runOnce()).toMatchObject({ state: 'finished' });
  expect(f.client.finishCpuJob.mock.calls[0]).toEqual(f.client.finishCpuJob.mock.calls[1]);
});

it.each(['receipt_pending', 'settling', 'reconciliation', 'refunded'] as const)('does not finish the original %s source', async status => {
  const f = await harness(); f.settle(); f.state.source.status = status;
  expect(await f.create().runOnce()).toMatchObject({ state: 'waiting_source' }); expect(f.client.finishCpuJob).not.toHaveBeenCalled();
});

it.each(['transaction', 'admission', 'conservation', 'liability', 'receipt source'] as const)('waits when %s remains uncertain', async field => {
  const f = await harness(); f.settle();
  if (field === 'transaction') f.state.source.settlementTx = null;
  if (field === 'admission') f.state.source.admissionTx = null;
  if (field === 'conservation') f.state.source.refund = '0';
  if (field === 'liability') f.state.job.outstandingLiability = '1';
  if (field === 'receipt source') f.state.source.settlement!.runId = h('b');
  expect(await f.create().runOnce()).toMatchObject({ state: 'waiting_source' }); expect(f.client.finishCpuJob).not.toHaveBeenCalled();
});

it.each(['paid_cpu_source_pending', 'paid_cpu_cleanup_unconfirmed'] as const)('waits for the server original %s check using the same retained request', async code => {
  const f = await harness(); f.settle(); f.client.finishCpuJob.mockRejectedValueOnce(new TelomereApiError(409, code));
  expect(await f.create().runOnce()).toMatchObject({ state: 'waiting_source' });
  expect(await f.create().runOnce()).toMatchObject({ state: 'finished' });
  expect(f.client.finishCpuJob.mock.calls[0]).toEqual(f.client.finishCpuJob.mock.calls[1]);
});

it.each(['active', 'finished'] as const)('never finishes a successor which is already %s', async phase => {
  const f = await harness(); f.settle(); f.state.job.currentRunId = h('b'); f.state.job.runIds.push(h('b')); f.state.job.phase = phase;
  expect(await f.create().runOnce()).toMatchObject({ state: 'superseded' }); expect(f.client.finishCpuJob).not.toHaveBeenCalled();
});

it('passes the source fence when the owner advances between observation and POST', async () => {
  const f = await harness(); f.settle(); const finish = f.client.finishCpuJob.getMockImplementation()!;
  f.client.finishCpuJob.mockImplementationOnce(async (...args) => {
    f.state.job.currentRunId = h('b'); f.state.job.runIds.push(h('b')); return finish(...args);
  });
  expect(await f.create().runOnce()).toMatchObject({ state: 'superseded' }); expect(f.state.job.phase).toBe('active');
});

it('does not adopt another caller manual finish without its durable original request', async () => {
  const f = await harness(); f.settle(); f.state.job.phase = 'finished'; f.state.job.prepared = null;
  expect(await f.create().runOnce()).toMatchObject({ state: 'superseded' }); expect(f.client.finishCpuJob).not.toHaveBeenCalled();
});

it.each(['awaiting_owner', 'approved', 'cancelled'] as const)('leaves the original %s job to its owner', async phase => {
  const f = await harness(); f.settle(); f.state.job.phase = phase;
  expect(await f.create().runOnce()).toMatchObject({ state: phase === 'cancelled' ? 'cancelled' : 'superseded' });
  expect(f.client.finishCpuJob).not.toHaveBeenCalled();
});

it.each(['owner', 'agent', 'chain'] as const)('refuses changed %s configuration before a completion mutation', async field => {
  const f = await harness(), config = structuredClone(f.config); f.settle();
  if (field === 'owner') config.binding.owner = addressSchema.parse('0x' + '1'.repeat(40));
  if (field === 'agent') config.binding.agentWallet = addressSchema.parse('0x' + '1'.repeat(40));
  if (field === 'chain') config.pins.escrowCodeHash = h('b');
  f.client.config.mockResolvedValue(config);
  await expect(f.create().runOnce()).rejects.toThrow('reviewed owner, agent Vault or chain'); expect(f.client.finishCpuJob).not.toHaveBeenCalled();
});

it.each(['quote', 'ceiling'] as const)('refuses a changed original %s before completion', async field => {
  const f = await harness(); f.settle();
  if (field === 'quote') f.state.source.quote = { ...f.state.source.quote, pricePerSecond: '999' };
  if (field === 'ceiling') f.state.source.ceiling = '999';
  await expect(f.create().runOnce()).rejects.toThrow('source reservation changed'); expect(f.client.finishCpuJob).not.toHaveBeenCalled();
});

it('rejects a purported finished response which retains a liability', async () => {
  const f = await harness(); f.settle(); const finish = f.client.finishCpuJob.getMockImplementation()!;
  f.client.finishCpuJob.mockImplementationOnce(async (...args) => ({ ...await finish(...args), outstandingLiability: '1' }));
  await expect(f.create().runOnce()).rejects.toThrow('response changed');
  expect([...f.records.keys()].some(key => key.endsWith(':accepted'))).toBe(false);
});

it('binds the explicit completion hash across actual encrypted owner journal reopen and lost response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-cpu-finish-')), masterKey = randomBytes(32);
  let vault: PaidLifecycleClientVaultV3 | undefined;
  const open = (scope: Journal['scope']) => vault = new PaidLifecycleClientVaultV3({ directory, masterKey, ...scope,
    policy: { version: 3, buckets: 64, maxRecordsPerBucket: 512, maxEncodedRecordBytes: 32768, maxJournalBytes: 1073741824 } });
  try {
    const f = await harness(open); expect(await f.create().runOnce()).toMatchObject({ state: 'waiting_source' });
    vault!.close(); f.setJournal(open(f.journal.scope));
    await expect(f.create({ applicationCompletionHash: h('d') }).runOnce()).rejects.toThrow('different original facts');
    f.settle(); const finish = f.client.finishCpuJob.getMockImplementation()!;
    f.client.finishCpuJob.mockImplementationOnce(async (...args) => { await finish(...args); throw new Error('lost finish response'); });
    await expect(f.create().runOnce()).rejects.toThrow('lost finish response');
    vault!.close(); f.setJournal(open(f.journal.scope));
    expect(await f.create().runOnce()).toMatchObject({ state: 'finished' });
    expect(f.client.finishCpuJob.mock.calls[0]).toEqual(f.client.finishCpuJob.mock.calls[1]);
  } finally {
    vault?.close(); masterKey.fill(0);
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('telomere-cpu-finish-')) throw new Error('Unsafe CPU finish test cleanup');
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

it('rejects malformed declarations and incompatible original journal or active source', async () => {
  const f = await harness();
  expect(() => f.create({ applicationCompletionHash: 'done' })).toThrow();
  expect(() => f.create({ journal: { ...f.journal, scope: { ...f.journal.scope, applicationSchema: 'other/v1' } } })).toThrow('journal scope');
  expect(() => f.create({ job: { ...f.original, phase: 'finished' } })).toThrow('original active');
});

it('polls sequentially and aborts the waiting period without a finish or stop operation', async () => {
  const f = await harness(), abort = new AbortController(); let seen!: () => void;
  const first = new Promise<void>(resolve => { seen = resolve; });
  const watching = f.create().watch({ signal: abort.signal, pollMs: 5000, onStatus: () => { seen(); } });
  await first; abort.abort(); expect(await watching).toMatchObject({ state: 'aborted' });
  expect(f.client.get).toHaveBeenCalledTimes(1); expect(f.client.finishCpuJob).not.toHaveBeenCalled();
});

it('returns explicit watch completion, propagates auth errors and refuses invalid poll bounds', async () => {
  const f = await harness(); f.settle();
  f.client.finishCpuJob.mockRejectedValueOnce(new TelomereApiError(401, 'unauthorized'));
  await expect(f.create().runOnce()).rejects.toMatchObject({ status: 401 });
  expect(await f.create().watch({ signal: new AbortController().signal, pollMs: 100 })).toMatchObject({ state: 'finished' });
  await expect(f.create().watch({ signal: new AbortController().signal, pollMs: 0 })).rejects.toThrow();
  const abort = new AbortController(); abort.abort();
  expect(await f.create().watch({ signal: abort.signal })).toMatchObject({ state: 'aborted' });
  const request = [...f.records.entries()].find(([key]) => key.endsWith(':request'))?.[1];
  expect([...f.records.entries()].find(([key]) => key.endsWith(':accepted'))?.[1]).toMatchObject({ requestHash: hashJson(request) });
});
