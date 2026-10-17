import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AkashConsoleReader, type AkashReadClient, type AkashBid,
  type AkashDeployment, type AkashProvider, type AkashSettings } from '../src/suppliers/akash-console.js';
import { FileSupplierLedger } from '../src/suppliers/ledger.js';
import { FileNosanaLedger } from '../src/suppliers/nosana-ledger.js';
import { SupplierService, type ApprovedSupplierRun, type TreasurySnapshot } from '../src/suppliers/service.js';
import { FileSupplierSharedReserve } from '../src/suppliers/shared-reserve.js';

const owner = '0x1111111111111111111111111111111111111111';
const runId = '0x' + 'a'.repeat(64);
const akashOwner = 'akash1' + 'o'.repeat(38);
const providerA = 'akash1' + 'a'.repeat(38);
const providerB = 'akash1' + 'b'.repeat(38);
const now = 1_800_000_000_000;
const input = { owner, runId, akashOwner, dseq: '1234567', gseq: 1, oseq: 1,
  plannedSeconds: 1800, maxSpendUsdcMicros: '2000000' };
const bid = (provider: string, amount: string): AkashBid => ({ id: {
  owner: akashOwner, dseq: input.dseq, gseq: 1, oseq: 1, provider },
  state: 'open', price: { denom: 'uact', amount } });
const provider = (address: string): AkashProvider => ({ owner: address, isOnline: true,
  isAudited: true, isValidVersion: true, uptime30d: 0.98 });
const deployment = (): AkashDeployment => ({ deployment: {
  id: { owner: akashOwner, dseq: input.dseq }, state: 'active', hash: 'manifest-hash' }, leases: [] });
const settings = (): AkashSettings => ({ dseq: input.dseq, autoTopUpEnabled: true,
  runtimeLimitHours: 1, runtimeEndsAt: null });

describe('Akash supplier planning and durable reconciliation', () => {
  let path: string, dir: string, ledger: FileSupplierLedger, sharedReserve: FileSupplierSharedReserve;
  let remote: { providers: ReturnType<typeof vi.fn>; bids: ReturnType<typeof vi.fn>;
    deployment: ReturnType<typeof vi.fn>; settings: ReturnType<typeof vi.fn> };
  let treasury: ReturnType<typeof vi.fn>;
  let approval: ReturnType<typeof vi.fn>;
  const service = () => new SupplierService({ ledger, sharedReserve, akash: remote as unknown as AkashReadClient,
    approvedRun: approval as unknown as (owner: string, runId: string) => Promise<ApprovedSupplierRun>,
    treasurySnapshot: treasury as unknown as () => Promise<TreasurySnapshot>, policy: { approvedProviders: [providerA, providerB],
      maxBlocksPerHour: 7200, inventoryBufferBps: 300, maxOpenReservedUsdcMicros: '10000000' },
    now: () => now });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'telomere-supplier-'));
    path = join(dir, 'journal.json'); ledger = new FileSupplierLedger(path);
    sharedReserve = new FileSupplierSharedReserve({ lockPath: join(dir, 'shared.lock'), akash: ledger,
      nosana: new FileNosanaLedger(join(dir, 'nosana.json')), maxOpenReservedUsdcMicros: '10000000' });
    await sharedReserve.akash.initializeFresh(); await sharedReserve.nosana.initializeFresh(); await sharedReserve.initializeFresh();
    remote = { providers: vi.fn(async () => [provider(providerA), provider(providerB)]),
      bids: vi.fn(async () => [bid(providerA, '100'), bid(providerB, '90')]),
      deployment: vi.fn(async () => deployment()), settings: vi.fn(async () => settings()) };
    treasury = vi.fn(async () => ({ availableUact: '2000000',
      usdcMicrosPerMillionUact: '2000000', asOfMs: now, source: 'operator-pinned-rate' }));
    approval = vi.fn(async (ownerValue: string, runIdValue: string) => ({ owner: ownerValue, runId: runIdValue,
      hardwareClass: 'cpu', active: true, maxSeconds: 3600, maxSpendUsdcMicros: '2000000' }));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('chooses the least expensive approved live bid, pins a bounded quote, and survives restart', async () => {
    const first = await service().plan(input, 'run-1');
    expect(first.replayed).toBe(false);
    expect(first.reservation.provider).toBe(providerB);
    expect(first.reservation.reservedUact).toBe('667440');
    expect(first.reservation.reservedUsdcMicros).toBe('1334880');
    expect(first.reservation.leaseCreationEnabled).toBe(false);
    expect(first.reservation.billableSeconds).toBe(0);
    const reopened = new FileSupplierLedger(path);
    expect((await reopened.read()).records[0]?.id).toBe(first.reservation.id);
    remote.bids.mockRejectedValueOnce(new Error('network offline'));
    expect((await service().plan(input, 'run-1')).replayed).toBe(true);
    expect(remote.bids).toHaveBeenCalledTimes(1);
  });

  it('plans the observed fractional uact price exactly, keeps its reserve after reopen, and compares equivalent lease text', async () => {
    remote.bids.mockResolvedValue([bid(providerA, '4'), bid(providerB, '3.983040000000000000')]);
    const first = await service().plan(input, 'fractional');
    expect(first.reservation.provider).toBe(providerB);
    expect(first.reservation.pricePerBlockUact).toBe('3.98304');
    expect(first.reservation.reservedUact).toBe('29539');
    expect(first.reservation.reservedUsdcMicros).toBe('59078');
    const reopened = new FileSupplierLedger(path);
    expect((await reopened.read()).records[0]?.pricePerBlockUact).toBe('3.98304');
    const active = deployment();
    active.leases = [{ id: { owner: akashOwner, dseq: input.dseq, gseq: 1, oseq: 1, provider: providerB },
      state: 'active', price: { denom: 'uact', amount: '3.983040000000000000' } }];
    remote.deployment.mockResolvedValue(active);
    remote.settings.mockResolvedValue({ ...settings(), runtimeEndsAt: new Date(now + 100_000).toISOString() });
    expect((await service().reconcile(owner, first.reservation.id)).state).toBe('active');
    active.leases[0]!.price.amount = '3.98305';
    expect((await service().reconcile(owner, first.reservation.id)).state).toBe('quarantined');
    expect((await reopened.read()).records[0]?.reservedUact).toBe('29539');
  });

  it('rejects a noncanonical fractional journal price after disk reopen', async () => {
    remote.bids.mockResolvedValue([bid(providerB, '3.983040000000000000')]);
    await service().plan(input, 'fractional');
    const original = JSON.parse(await readFile(path, 'utf8')) as { records: Array<{ pricePerBlockUact: string }> };
    original.records[0]!.pricePerBlockUact = '3.983040000000000000';
    await writeFile(path, JSON.stringify(original));
    await expect(new FileSupplierLedger(path).read()).rejects.toThrow();
  });

  it('rejects changed idempotency payload and a second reservation for one run', async () => {
    await service().plan(input, 'run-1');
    await expect(service().plan({ ...input, plannedSeconds: 1801 }, 'run-1')).rejects.toMatchObject({ code: 'supplier_idempotency_conflict' });
    await expect(service().plan(input, 'run-2')).rejects.toMatchObject({ code: 'supplier_quota' });
  });

  it('fails closed on stale inventory, insufficient projected budget and unbounded deployment', async () => {
    treasury.mockResolvedValueOnce({ availableUact: '2000000', usdcMicrosPerMillionUact: '2000000',
      asOfMs: now - 61_000, source: 'old' });
    await expect(service().plan(input, 'stale')).rejects.toMatchObject({ code: 'supplier_treasury_stale' });
    await expect(service().plan({ ...input, maxSpendUsdcMicros: '1000000' }, 'budget'))
      .rejects.toMatchObject({ code: 'supplier_budget_exceeded' });
    remote.settings.mockResolvedValueOnce({ ...settings(), runtimeLimitHours: null });
    await expect(service().plan(input, 'unbounded')).rejects.toMatchObject({ code: 'supplier_deployment_invalid' });
    expect((await ledger.read()).records).toHaveLength(0);
  });

  it('rejects a representable but unreservable fractional price before journaling', async () => {
    remote.bids.mockResolvedValue([bid(providerB, '999999999999999999999999999999.9')]);
    await expect(service().plan(input, 'overflow')).rejects.toMatchObject({ code: 'supplier_budget_exceeded' });
    expect((await ledger.read()).records).toHaveLength(0);
  });

  it('requires an authoritative active CPU run before reading the provider market', async () => {
    approval.mockResolvedValueOnce({ owner, runId, hardwareClass: 'cpu', active: false,
      maxSeconds: 3600, maxSpendUsdcMicros: '2000000' });
    await expect(service().plan(input, 'inactive')).rejects.toMatchObject({ code: 'supplier_run_invalid' });
    expect(remote.bids).not.toHaveBeenCalled();
    approval.mockResolvedValueOnce({ owner, runId, hardwareClass: 'cpu', active: true,
      maxSeconds: 100, maxSpendUsdcMicros: '2000000' });
    await expect(service().plan(input, 'duration')).rejects.toMatchObject({ code: 'supplier_run_invalid' });
  });

  it('requires a pre-approved audited provider and prevents duplicate external deployment reservation', async () => {
    remote.providers.mockResolvedValueOnce([provider(providerA), { ...provider(providerB), isAudited: false }]);
    const first = await service().plan(input, 'first');
    expect(first.reservation.provider).toBe(providerA);
    const other = { ...input, owner: '0x2222222222222222222222222222222222222222', runId: '0x' + 'b'.repeat(64) };
    await expect(service().plan(other, 'second')).rejects.toMatchObject({ code: 'supplier_deployment_reserved' });
  });

  it('reserves inventory across distinct deployments and rejects oversubscription', async () => {
    treasury.mockResolvedValue({ availableUact: '1000000', usdcMicrosPerMillionUact: '2000000',
      asOfMs: now, source: 'operator-pinned-rate' });
    await service().plan(input, 'first');
    const other = { ...input, owner: '0x2222222222222222222222222222222222222222',
      runId: '0x' + 'b'.repeat(64), dseq: '1234568' };
    remote.bids.mockImplementation(async (dseqValue: string) => [
      { ...bid(providerA, '100'), id: { ...bid(providerA, '100').id, dseq: dseqValue } },
      { ...bid(providerB, '90'), id: { ...bid(providerB, '90').id, dseq: dseqValue } },
    ]);
    remote.deployment.mockImplementation(async (dseqValue: string) => ({ ...deployment(),
      deployment: { ...deployment().deployment, id: { owner: akashOwner, dseq: dseqValue } } }));
    remote.settings.mockImplementation(async (dseqValue: string) => ({ ...settings(), dseq: dseqValue }));
    await expect(service().plan(other, 'second')).rejects.toMatchObject({ code: 'supplier_treasury_insufficient' });
  });

  it('cancels only an unsubmitted plan, releases local inventory, and keeps its replay tombstone', async () => {
    treasury.mockResolvedValue({ availableUact: '700000', usdcMicrosPerMillionUact: '2000000',
      asOfMs: now, source: 'operator-pinned-rate' });
    const first = await service().plan(input, 'first');
    expect(first.reservation.reserveHeldUsdcMicros).toBe('1334880');
    const canceled = await service().cancelPlanned(owner, first.reservation.id);
    expect(canceled.replayed).toBe(false);
    expect(canceled.reservation.state).toBe('canceled_unsubmitted');
    expect(canceled.reservation.reserveHeldUact).toBe('0');
    expect(canceled.reservation.reserveHeldUsdcMicros).toBe('0');
    expect(canceled.reservation.reservedUsdcMicros).toBe('1334880');
    expect((await service().cancelPlanned(owner, first.reservation.id)).replayed).toBe(true);
    const restarted = new FileSupplierLedger(path);
    expect((await restarted.read()).records[0]?.state).toBe('canceled_unsubmitted');
    expect((await service().plan(input, 'first')).reservation.state).toBe('canceled_unsubmitted');
    await expect(service().plan(input, 'new-key')).rejects.toMatchObject({ code: 'supplier_quota' });
    const other = { ...input, owner: '0x2222222222222222222222222222222222222222',
      runId: '0x' + 'b'.repeat(64), dseq: '1234568' };
    remote.bids.mockImplementation(async (dseqValue: string) => [
      { ...bid(providerB, '90'), id: { ...bid(providerB, '90').id, dseq: dseqValue } },
    ]);
    remote.deployment.mockImplementation(async (dseqValue: string) => ({ ...deployment(),
      deployment: { ...deployment().deployment, id: { owner: akashOwner, dseq: dseqValue } } }));
    remote.settings.mockImplementation(async (dseqValue: string) => ({ ...settings(), dseq: dseqValue }));
    expect((await service().plan(other, 'second')).reservation.state).toBe('planned');
    const readsBefore = remote.deployment.mock.calls.length;
    expect((await service().reconcile(owner, first.reservation.id)).state).toBe('canceled_unsubmitted');
    expect(remote.deployment.mock.calls.length).toBe(readsBefore);
  });

  it('refuses to release a planned reserve if the pinned deployment has acquired an external lease', async () => {
    const first = await service().plan(input, 'first');
    const changed = deployment();
    changed.leases = [{ id: { owner: akashOwner, dseq: input.dseq, gseq: 1, oseq: 1, provider: providerB },
      state: 'active', price: { denom: 'uact', amount: '90' } }];
    remote.deployment.mockResolvedValueOnce(changed);
    await expect(service().cancelPlanned(owner, first.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_cancellation_unsafe' });
    expect((await ledger.read()).records[0]?.state).toBe('planned');
    expect((await service().get(owner, first.reservation.id)).reserveHeldUsdcMicros).toBe('1334880');
  });

  it('observes the exact external lease and then retains funds after closure without billing', async () => {
    const planned = await service().plan(input, 'run-1');
    const observed = deployment();
    observed.leases = [{ id: { owner: akashOwner, dseq: input.dseq, gseq: 1, oseq: 1, provider: providerB },
      state: 'active', price: { denom: 'uact', amount: '90' } }];
    remote.deployment.mockResolvedValue(observed);
    remote.settings.mockResolvedValue({ ...settings(), runtimeEndsAt: new Date(now + 100_000).toISOString() });
    const active = await service().reconcile(owner, planned.reservation.id);
    expect(active.state).toBe('active');
    expect(active.meterEligible).toBe(false);
    observed.leases[0]!.state = 'closed';
    const closed = await service().reconcile(owner, planned.reservation.id);
    expect(closed.state).toBe('closed_unsettled');
    expect(closed.reservedUact).toBe(planned.reservation.reservedUact);
    expect(closed.refundConfirmed).toBe(false);
    expect((await new FileSupplierLedger(path).read()).records[0]?.state).toBe('closed_unsettled');
  });

  it('quarantines a changed provider or missing active lease and never releases its reserve', async () => {
    const planned = await service().plan(input, 'run-1');
    const observed = deployment();
    observed.leases = [{ id: { owner: akashOwner, dseq: input.dseq, gseq: 1, oseq: 1, provider: providerA },
      state: 'active', price: { denom: 'uact', amount: '90' } }];
    remote.deployment.mockResolvedValue(observed);
    const quarantined = await service().reconcile(owner, planned.reservation.id);
    expect(quarantined.state).toBe('quarantined');
    expect(quarantined.reason).toBe('external_identity_or_terms_changed');
    remote.deployment.mockResolvedValue(deployment());
    expect((await service().reconcile(owner, planned.reservation.id)).state).toBe('quarantined');
  });

  it('quarantines an active lease that vanishes from the external deployment response', async () => {
    const planned = await service().plan(input, 'run-1');
    const observed = deployment();
    observed.leases = [{ id: { owner: akashOwner, dseq: input.dseq, gseq: 1, oseq: 1, provider: providerB },
      state: 'active', price: { denom: 'uact', amount: '90' } }];
    remote.deployment.mockResolvedValueOnce(observed).mockResolvedValueOnce(deployment());
    remote.settings.mockResolvedValue({ ...settings(), runtimeEndsAt: new Date(now + 100_000).toISOString() });
    expect((await service().reconcile(owner, planned.reservation.id)).state).toBe('active');
    const lost = await service().reconcile(owner, planned.reservation.id);
    expect(lost.state).toBe('quarantined');
    expect(lost.reason).toBe('lease_status_ambiguous');
    expect(lost.reservedUact).toBe(planned.reservation.reservedUact);
  });

  it('quarantines a runtime limit that was extended after admission', async () => {
    const planned = await service().plan(input, 'run-1');
    remote.settings.mockResolvedValue({ ...settings(), runtimeLimitHours: 2 });
    const changed = await service().reconcile(owner, planned.reservation.id);
    expect(changed.state).toBe('quarantined');
    expect(changed.reason).toBe('external_identity_or_terms_changed');
  });
});

describe('Akash Console read-only transport', () => {
  const key = 'private-test-key';
  it('uses only fixed GET paths and parses documented envelopes', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init: unknown) => new Response(JSON.stringify({ data: [
      { bid: { ...bid(providerA, '100'), id: { ...bid(providerA, '100').id, bseq: 0 } } },
      { bid: bid(providerB, '3.983040000000000000') },
    ] }), { headers: { 'content-type': 'application/json' } }));
    const reader = new AkashConsoleReader(key, fetchMock as typeof fetch);
    const bids = await reader.bids('1234567');
    expect(bids.map(item => item.id.provider)).toEqual([providerA, providerB]);
    expect(bids[0]?.id.bseq).toBe(0);
    expect(bids[1]?.price.amount).toBe('3.983040000000000000');
    expect(fetchMock).toHaveBeenCalledWith('https://console-api.akash.network/v1/bids?dseq=1234567',
      expect.objectContaining({ method: 'GET', redirect: 'error', headers: expect.objectContaining({ 'x-api-key': key }) }));
    await expect(reader.bids('../leases')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized, non-JSON and HTTP error responses', async () => {
    const tooLarge = vi.fn(async () => new Response('x'.repeat(1_048_577), { headers: { 'content-type': 'application/json' } }));
    await expect(new AkashConsoleReader(key, tooLarge as typeof fetch).providers([providerA])).rejects.toThrow('size limit');
    const html = vi.fn(async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }));
    await expect(new AkashConsoleReader(key, html as typeof fetch).providers([providerA])).rejects.toThrow('not JSON');
    const invalidKey = vi.fn(async () => new Response('', { status: 401 }));
    await expect(new AkashConsoleReader(key, invalidKey as typeof fetch).deployment('1234567'))
      .rejects.toThrow('GET failed (401)');
  });
});
