import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { canonical, hashJson } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import type { ClientLifelineControl } from '../src/agents/lifeline.js';
import { HttpAgentLifecycleControl } from '../src/agents/http-client.js';
import { createPaidOwnerLifeline } from '../src/agents/paid-owner-lifeline.js';
import { PaidLifecycleClientVaultV3 } from '../src/agents/paid-lifecycle-vault-v3.js';
import type { PaidLifecycleClientVault } from '../src/agents/paid-lifecycle-runner.js';
import { PAID_LIFELINE_FUNDING_SCHEMA, PaidLifelineReservations, paidLifelineFundingPolicySchema,
  type PaidLifelineFundingPort } from '../src/agents/paid-lifeline-reservations.js';
import { PAID_AGENT_POLICY } from '../src/agents/types.js';
import { frameworkComputeProfileSchema, type DurableVaultCompute } from '../src/integrations/durable-vault-compute.js';
import type { PlatformRuntimeRun } from '../src/platform-runtime/client.js';
import { CYST_CAPABILITIES } from '../src/cysts/types.js';
import { CystClient } from '../src/sdk/cysts.js';
import { ApiTransport } from '../src/sdk/transport.js';

const h = (digit: string) => '0x' + digit.repeat(64);
type Journal = Pick<PaidLifecycleClientVault, 'scope' | 'claim' | 'read' | 'exclusiveOperation'>;
async function harness(journalFactory?: (scope: Journal['scope']) => Journal) {
  // Keep parsing strict while using only the exact reviewed fixture profile.
  const raw = JSON.parse(await readFile(resolve('python/tests/fixtures/platform-typescript.json'), 'utf8')) as {
    vaultConfig: { pins: unknown; vaultPins: unknown; binding: unknown } };
  const profile = frameworkComputeProfileSchema.parse({ baseUrl: 'http://127.0.0.1:3280',
    pins: raw.vaultConfig.pins, vaultPins: raw.vaultConfig.vaultPins, binding: raw.vaultConfig.binding });
  const owner = profile.binding.owner.toLowerCase(), agent = profile.binding.agentWallet.toLowerCase();
  const policy = paidLifelineFundingPolicySchema.parse({ version: 1, owner, agent, computeProfileHash: hashJson(profile),
    imageDigest: 'sha256:' + 'a'.repeat(64), maxCommands: 8, leaseSeconds: 90, regions: ['eu-test'],
    maxReservationCeiling: '10000', maxReservedUnits: '20000', maxReservations: 3, notBefore: 1000, expiresAt: 10000 });
  const scope = { owner, agent, applicationSchema: PAID_LIFELINE_FUNDING_SCHEMA }, records = new Map<string, unknown>();
  let lock = Promise.resolve();
  const memory: Journal = { scope, read: async key => records.get(key), claim: async (key, value) => {
    if (records.has(key) && canonical(records.get(key)) !== canonical(value)) throw new Error('immutable');
    records.set(key, structuredClone(value));
  }, exclusiveOperation: async (_kind, action) => {
    const before = lock; let release!: () => void; lock = new Promise<void>(done => { release = done; });
    await before; try { return await action(); } finally { release(); }
  } };
  let journal = journalFactory?.(scope) ?? memory, now = 2000;
  const state = { agent: { owner, agent, version: 0, mode: 'full', currentRunId: h('a'), checkpointId: h('b'), killedAt: null as string | null },
    intent: null as unknown, policy: PAID_AGENT_POLICY };
  const control = { get: async () => structuredClone(state) as unknown as Awaited<ReturnType<ClientLifelineControl['get']>> };
  let seq = 0;
  const prepared = new Map<string, { runId: string; ceiling: string; expiresAt: number }>();
  const prepare = vi.fn(async (id: string) => {
    if (!prepared.has(id)) prepared.set(id, { runId: h(String(++seq)), ceiling: '10000', expiresAt: now + 30 });
    return { ...prepared.get(id)!, operationId: id, phase: 'wallet_required' as const, requiresWallet: true as const,
      transaction: { chainId: profile.pins.chainId, to: profile.binding.vault, data: '0x1234', value: '0' as const },
      binding: profile.binding, hostId: h('c'), workloadHash: h('d') };
  });
  const run = (id: string, hash: string) => ({ id: prepared.get(id)!.runId, ceiling: '10000', admissionTx: hash, status: 'running' } as PlatformRuntimeRun);
  const admit = vi.fn(async (id: string, hash: string) => run(id, hash));
  const status = vi.fn(async (id: string) => run(id, h('e')));
  const compute = { profile, prepare, admit, status } as unknown as Pick<DurableVaultCompute, 'profile' | 'prepare' | 'admit' | 'status'>;
  const broadcasts = new Map<string, string>();
  let anchor: Awaited<ReturnType<PaidLifelineFundingPort['anchor']>> = null;
  const wallet: PaidLifelineFundingPort = { lookup: vi.fn(async id => broadcasts.get(id) ?? null),
    anchor: vi.fn(async () => anchor),
    submit: vi.fn(async (_plan, id, approval) => {
      anchor = { index: approval.index, ledgerHash: approval.ledgerHash, totalReserved: approval.totalReserved };
      broadcasts.set(id, h('e')); return h('e'); }) };
  const create = (canFund?: () => Promise<boolean>) => new PaidLifelineReservations({ policy, compute, journal, control, wallet, nowSeconds: () => now,
    ...(canFund === undefined ? {} : { canFund }) });
  return { policy, records, state, prepare, admit, status, wallet, broadcasts, owner, agent, create, compute, control,
    setNow: (value: number) => { now = value; }, setJournal: (value: Journal) => { journal = value; } };
}

it('serializes concurrent owner polls and never spends refunds as renewed funding approval', async () => {
  const f = await harness(), first = f.create(), second = f.create();
  const results = await Promise.all([first.approvedTarget(f.owner, f.agent), second.approvedTarget(f.owner, f.agent)]);
  expect(results).toEqual([h('1'), h('1')]); expect(f.wallet.submit).toHaveBeenCalledTimes(1);
  f.state.agent.version++; f.state.agent.currentRunId = h('1');
  expect(await first.approvedTarget(f.owner, f.agent, 'lean')).toBe(h('2'));
  f.state.agent.version++; f.state.agent.currentRunId = h('2');
  expect(await first.approvedTarget(f.owner, f.agent, 'torpor')).toBeUndefined();
  expect(f.wallet.submit).toHaveBeenCalledTimes(2);
  expect([...f.records.values()].filter(value => typeof value === 'object' && value && 'totalReserved' in value)
    .map(value => (value as { totalReserved: string }).totalReserved)).toEqual(['10000', '20000', '20000']);
});

it('retains an ambiguous broadcast across actual encrypted vault reopen and reconciles the original operation only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-funding-v3-')), masterKey = randomBytes(32);
  let vault: PaidLifecycleClientVaultV3 | undefined;
  const open = (scope: Journal['scope']) => vault = new PaidLifecycleClientVaultV3({ directory, masterKey, ...scope,
    policy: { version: 3, buckets: 64, maxRecordsPerBucket: 512, maxEncodedRecordBytes: 32768, maxJournalBytes: 1073741824 } });
  try {
    const f = await harness(open); let originalId = '';
    vi.mocked(f.wallet.submit).mockImplementationOnce(async (_plan, id) => { originalId = id; throw new Error('lost broadcast acknowledgement'); });
    expect(await f.create().approvedTarget(f.owner, f.agent)).toBeUndefined();
    vault!.close(); f.setJournal(open({ owner: f.owner, agent: f.agent, applicationSchema: PAID_LIFELINE_FUNDING_SCHEMA }));
    f.state.agent.version++;
    expect(await f.create().approvedTarget(f.owner, f.agent, 'lean')).toBeUndefined();
    expect(f.wallet.submit).toHaveBeenCalledTimes(1); expect(f.prepare).toHaveBeenCalledTimes(1);
    f.broadcasts.set(originalId, h('e'));
    // Changed lifecycle context retires the funded reservation without admission.
    expect(await f.create().approvedTarget(f.owner, f.agent, 'lean')).toBeUndefined(); expect(f.admit).not.toHaveBeenCalled();
    expect((await f.create().inventory())[0]).toMatchObject({ runId: h('1'), transactionHash: h('e'), attempted: true, state: 'retired', reserved: '10000' });
    expect(await f.create().approvedTarget(f.owner, f.agent, 'lean')).toBe(h('2'));
    expect(f.wallet.submit).toHaveBeenCalledTimes(2);
  } finally {
    vault?.close(); masterKey.fill(0);
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('telomere-funding-v3-')) throw new Error('Unsafe funding test cleanup');
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

it('replays one admission after response loss without another wallet submit', async () => {
  const f = await harness(), original = f.admit.getMockImplementation()!;
  f.admit.mockImplementationOnce(async (...args) => { await original(...args); throw new Error('lost admission response'); });
  await expect(f.create().approvedTarget(f.owner, f.agent)).rejects.toThrow('lost admission');
  expect(await f.create().approvedTarget(f.owner, f.agent)).toBe(h('1'));
  expect(f.admit).toHaveBeenCalledTimes(2); expect(f.wallet.submit).toHaveBeenCalledTimes(1);
  expect(f.admit.mock.calls[0]).toEqual(f.admit.mock.calls[1]);
});

it('rechecks kill and approval expiry immediately before broadcast', async () => {
  const f = await harness();
  vi.mocked(f.wallet.lookup).mockImplementation(async () => { f.state.agent.killedAt = '2026-10-14T00:00:00Z'; return null; });
  expect(await f.create().approvedTarget(f.owner, f.agent)).toBeUndefined(); expect(f.wallet.submit).not.toHaveBeenCalled();
  const expired = await harness(); expired.setNow(9990);
  expect(await expired.create().approvedTarget(expired.owner, expired.agent)).toBeUndefined(); expect(expired.prepare).not.toHaveBeenCalled();
});

it.each(['kill', 'pending intent', 'context change', 'approval expiry', 'quote expiry'] as const)
('rechecks %s after asynchronous storage preflight and keeps the wallet untouched', async change => {
  const f = await harness();
  let entered!: () => void, release!: () => void;
  const preflightStarted = new Promise<void>(resolve => { entered = resolve; });
  const preflight = new Promise<boolean>(resolve => { release = () => resolve(true); });
  const canFund = vi.fn(async () => { entered(); return preflight; });
  const adapter = f.create(canFund), funding = adapter.approvedTarget(f.owner, f.agent);
  await preflightStarted;
  expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.wallet.submit).not.toHaveBeenCalled();
  if (change === 'kill') f.state.agent.killedAt = '2026-10-15T00:00:00Z';
  if (change === 'pending intent') f.state.intent = { kind: 'kill' };
  if (change === 'context change') f.state.agent.version++;
  if (change === 'approval expiry') f.setNow(f.policy.expiresAt - f.policy.leaseSeconds - 5);
  if (change === 'quote expiry') f.setNow(2026);
  release();
  expect(await funding).toBeUndefined();
  expect(f.wallet.submit).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
  expect(await adapter.inventory()).toMatchObject([{ state: 'retired', attempted: false }]);
});

it('preflights both actual quota2 upload clients and stops funding if either lacks checkpoint headroom', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-owner-lifeline-')), masterKey = randomBytes(32);
  const journals: PaidLifecycleClientVaultV3[] = [];
  const privatePolicy = { version: 3, buckets: 64, maxRecordsPerBucket: 512, maxEncodedRecordBytes: 32768,
    maxJournalBytes: 1073741824 } as const;
  try {
    const f = await harness(scope => {
      const journal = new PaidLifecycleClientVaultV3({ directory: join(directory, 'funding'), masterKey, ...scope, policy: privatePolicy });
      journals.push(journal); return journal;
    });
    f.policy.maxReservedUnits = '30000';
    const applicationSchema = 'owner-lifeline-test', lifecycleVault = new PaidLifecycleClientVaultV3({
      directory: join(directory, 'lifecycle'), masterKey, owner: f.owner, agent: f.agent, applicationSchema, policy: privatePolicy });
    journals.push(lifecycleVault);
    const capabilities = { ...CYST_CAPABILITIES, maxOwnerCheckpoints: 4096,
      quotaPolicy: { version: 2, kind: 'telomere-cyst-quota-v2', maxOwnerCheckpoints: 4096, maxOwnerBytes: CYST_CAPABILITIES.maxOwnerBytes } };
    const usage = [{ checkpoints: 4092, bytes: CYST_CAPABILITIES.maxOwnerBytes - 4 * 4112 }, { checkpoints: 0, bytes: 0 }];
    const requests: { client: number; header: string | null }[] = [];
    const transport = (client: number) => new ApiTransport('http://127.0.0.1:3280', { fetch: async (url, options) => {
      expect(String(url)).toBe('http://127.0.0.1:3280/api/cysts');
      requests.push({ client, header: new Headers(options?.headers).get('X-Telomere-Cyst-Quota') });
      return Response.json({ checkpoints: [], usage: usage[client], capabilities });
    } });
    const lifecycleTransport = transport(0), cadenceTransport = transport(1);
    const control = new HttpAgentLifecycleControl(lifecycleTransport, { metabolismVersion: 2, cystQuotaVersion: 2 });
    vi.spyOn(control, 'get').mockImplementation(f.control.get);
    const cysts = new CystClient(cadenceTransport, { quotaVersion: 2 });
    const unused = async (): Promise<never> => { throw new Error('Unexpected owner runner execution in funding preflight'); };
    type Options = Parameters<typeof createPaidOwnerLifeline>[0];
    const options: Options = { runner: { owner: f.owner, agent: f.agent, applicationSchema, imageDigest: f.policy.imageDigest,
      client: { config: unused, get: unused, sessionLease: unused, command: unused, sessionEvents: unused, stopPlan: unused },
      // The chain and cadence journal are not used until a lifecycle tick; this test exercises only the composition's funding callback.
      chain: {} as Options['runner']['chain'], stopPort: { submit: unused, lookup: unused },
      checkpointArgvPrefix: ['/checkpoint'], restoreArgvPrefix: ['/restore'] },
      control, lifecycleVault, compute: f.compute as DurableVaultCompute,
      funding: { policy: f.policy, journal: journals[0]!, wallet: f.wallet, nowSeconds: () => 2000 },
      cadence: { cysts, journal: { exclusive: unused } } };
    expect(() => createPaidOwnerLifeline({ ...options, control: new HttpAgentLifecycleControl(lifecycleTransport) })).toThrow('explicit quota2');
    expect(() => createPaidOwnerLifeline({ ...options, cadence: { ...options.cadence, cysts: new CystClient(cadenceTransport) } })).toThrow('explicit quota2');
    const { reservations } = createPaidOwnerLifeline(options);
    // Three count slots are insufficient even when byte storage is empty.
    usage[0] = { checkpoints: 4093, bytes: 0 };
    expect(await reservations.approvedTarget(f.owner, f.agent)).toBeUndefined();
    expect(f.wallet.submit).not.toHaveBeenCalled();
    // A different cadence client must also have the full four-checkpoint byte reserve.
    usage[0] = { checkpoints: 4092, bytes: CYST_CAPABILITIES.maxOwnerBytes - 4 * 4112 };
    usage[1] = { checkpoints: 0, bytes: CYST_CAPABILITIES.maxOwnerBytes - 4 * 4112 + 1 };
    expect(await reservations.approvedTarget(f.owner, f.agent, 'lean')).toBeUndefined();
    expect(f.wallet.submit).not.toHaveBeenCalled();
    usage[1] = { checkpoints: 4092, bytes: CYST_CAPABILITIES.maxOwnerBytes - 4 * 4112 };
    expect(await reservations.approvedTarget(f.owner, f.agent, 'torpor')).toBe(h('3'));
    expect(f.wallet.submit).toHaveBeenCalledTimes(1);
    expect(requests).toEqual(Array.from({ length: 3 }, () => [{ client: 0, header: '2' }, { client: 1, header: '2' }]).flat());
  } finally {
    for (const journal of journals) journal.close(); masterKey.fill(0);
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('telomere-owner-lifeline-')) throw new Error('Unsafe owner test cleanup');
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

it('blocks funding when the wallet retained a newer accepted budget than the restored owner journal', async () => {
  const f = await harness();
  expect(await f.create().approvedTarget(f.owner, f.agent)).toBe(h('1'));
  // Emulate restoring an older private backup while the wallet journal survives.
  f.records.clear(); f.state.agent.version++;
  await expect(f.create().approvedTarget(f.owner, f.agent, 'lean')).rejects.toThrow('different recovery points');
  expect(f.wallet.submit).toHaveBeenCalledTimes(1);
});

it('requires explicit operator quota path/hash and preserves the default512 profile', () => {
  const base = { MODE: 'demo', DATA_DIR: ':memory:', CYSTS_DIR: 'C:/private/cysts', ESCROW_ADDRESS: '0x' + '1'.repeat(40),
    TOKEN_ADDRESS: '0x' + '2'.repeat(40), SIGNER_PRIVATE_KEY: h('3'), DEMO_PRIVATE_KEY: h('4') };
  expect(loadConfig(base).CYSTS_QUOTA_POLICY_PATH).toBeUndefined();
  expect(() => loadConfig({ ...base, CYSTS_QUOTA_POLICY_PATH: 'C:/private/quota.json' })).toThrow('quota');
  expect(() => loadConfig({ ...base, CYSTS_ENABLED: 'false', CYSTS_QUOTA_POLICY_PATH: 'C:/private/quota.json', CYSTS_QUOTA_POLICY_SHA256: 'a'.repeat(64) })).toThrow('quota');
  expect(loadConfig({ ...base, CYSTS_ENABLED: 'true', CYSTS_QUOTA_POLICY_PATH: 'C:/private/quota.json', CYSTS_QUOTA_POLICY_SHA256: '0x' + 'A'.repeat(64) }).CYSTS_QUOTA_POLICY_SHA256).toBe('a'.repeat(64));
});
