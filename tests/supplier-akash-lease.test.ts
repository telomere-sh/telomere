import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AkashConsoleLeaseWriter, type AkashBid, type AkashDeployment, type AkashLeaseWriteClient,
  type AkashProvider, type AkashReadClient, type AkashSettings } from '../src/suppliers/akash-console.js';
import { FileSupplierLedger } from '../src/suppliers/ledger.js';
import { FileNosanaLedger } from '../src/suppliers/nosana-ledger.js';
import { SupplierService, type ApprovedSupplierRun, type TreasurySnapshot } from '../src/suppliers/service.js';
import { FileSupplierSharedReserve } from '../src/suppliers/shared-reserve.js';

const owner = '0x1111111111111111111111111111111111111111';
const runId = '0x' + 'a'.repeat(64);
const akashOwner = 'akash1' + 'o'.repeat(38);
const providerAddress = 'akash1' + 'p'.repeat(38);
const now = 1_800_000_000_000;
const input = { owner, runId, akashOwner, dseq: '1234567', gseq: 1, oseq: 1,
  plannedSeconds: 1800, maxSpendUsdcMicros: '2000000' };
const bid = (): AkashBid => ({ id: { owner: akashOwner, dseq: input.dseq,
  gseq: 1, oseq: 1, provider: providerAddress }, state: 'open',
price: { denom: 'uact', amount: '90' } });
const provider = (): AkashProvider => ({ owner: providerAddress, isOnline: true,
  isAudited: true, isValidVersion: true, uptime30d: 0.98 });
const deployment = (activeLease = false): AkashDeployment => ({ deployment: {
  id: { owner: akashOwner, dseq: input.dseq }, state: 'active', hash: 'pinned-manifest-hash' },
leases: activeLease ? [{ id: { owner: akashOwner, dseq: input.dseq, gseq: 1, oseq: 1,
  provider: providerAddress }, state: 'active', price: { denom: 'uact', amount: '90' } }] : [] });
const settings = (started = false): AkashSettings => ({ dseq: input.dseq, autoTopUpEnabled: true,
  runtimeLimitHours: 1, runtimeEndsAt: started ? new Date(now + 3_600_000).toISOString() : null });

describe('operator-gated Akash Console lease submission', () => {
  let dir: string, ledger: FileSupplierLedger, sharedReserve: FileSupplierSharedReserve;
  let reader: { providers: ReturnType<typeof vi.fn>; bids: ReturnType<typeof vi.fn>;
    deployment: ReturnType<typeof vi.fn>; settings: ReturnType<typeof vi.fn> };
  let writer: { createLease: ReturnType<typeof vi.fn> };
  let approval: ReturnType<typeof vi.fn>, treasury: ReturnType<typeof vi.fn>;
  const service = (enabled = true, withWriter = true) => new SupplierService({ ledger, sharedReserve,
    akash: reader as unknown as AkashReadClient,
    ...(withWriter ? { leaseWriter: writer as unknown as AkashLeaseWriteClient } : {}),
    approvedRun: approval as unknown as (owner: string, runId: string) => Promise<ApprovedSupplierRun>,
    treasurySnapshot: treasury as unknown as () => Promise<TreasurySnapshot>,
    policy: { approvedProviders: [providerAddress], maxBlocksPerHour: 7200,
      inventoryBufferBps: 300, maxOpenReservedUsdcMicros: '10000000', leaseCreationEnabled: enabled },
    now: () => now });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'telomere-akash-lease-'));
    ledger = new FileSupplierLedger(join(dir, 'supplier.json'));
    sharedReserve = new FileSupplierSharedReserve({ lockPath: join(dir, 'shared.lock'), akash: ledger,
      nosana: new FileNosanaLedger(join(dir, 'nosana.json')), maxOpenReservedUsdcMicros: '10000000' });
    await sharedReserve.akash.initializeFresh(); await sharedReserve.nosana.initializeFresh(); await sharedReserve.initializeFresh();
    reader = { providers: vi.fn(async () => [provider()]), bids: vi.fn(async () => [bid()]),
      deployment: vi.fn(async () => deployment()), settings: vi.fn(async () => settings()) };
    writer = { createLease: vi.fn(async () => deployment(true)) };
    approval = vi.fn(async () => ({ owner, runId, hardwareClass: 'cpu', active: true,
      maxSeconds: 7200, maxSpendUsdcMicros: '2000000', expiresAtMs: now + 3_900_000 }));
    treasury = vi.fn(async () => ({ availableUact: '2000000',
      usdcMicrosPerMillionUact: '2000000', asOfMs: now, source: 'trusted-operator-quote' }));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('persists the one-way intent before the exact POST and observes the lease later', async () => {
    const planned = await service().plan(input, 'run-1');
    expect(planned.reservation.leaseCreationEnabled).toBe(true);
    let durableState: string | undefined;
    writer.createLease.mockImplementation(async () => {
      durableState = (await new FileSupplierLedger(join(dir, 'supplier.json')).read()).records[0]?.state;
      return deployment(true);
    });
    const result = await service().activate(owner, planned.reservation.id);
    expect(durableState).toBe('lease_submission_pending');
    expect(writer.createLease).toHaveBeenCalledExactlyOnceWith({ dseq: input.dseq, gseq: 1,
      oseq: 1, provider: providerAddress });
    expect(result.reservation.state).toBe('lease_submission_pending');
    expect(result.reservation.billableSeconds).toBe(0);
    await expect(service().activate(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_lease_already_attempted' });
    reader.deployment.mockResolvedValue(deployment(true));
    reader.settings.mockResolvedValue(settings(true));
    const active = await service().reconcile(owner, planned.reservation.id);
    expect(active.state).toBe('active');
    expect(active.meterEligible).toBe(false);
    expect(writer.createLease).toHaveBeenCalledTimes(1);
  });

  it('keeps an uncertain POST outcome durable across restart and never retries it', async () => {
    const planned = await service().plan(input, 'run-1');
    writer.createLease.mockRejectedValueOnce(new Error('connection reset after send'));
    await expect(service().activate(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_lease_outcome_unknown' });
    expect((await ledger.read()).records[0]?.state).toBe('lease_submission_pending');
    expect((await service().reconcile(owner, planned.reservation.id)).state).toBe('lease_submission_pending');
    await expect(service().activate(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_lease_already_attempted' });
    reader.deployment.mockResolvedValue(deployment(true));
    reader.settings.mockResolvedValue(settings(true));
    expect((await service().reconcile(owner, planned.reservation.id)).state).toBe('active');
    expect(writer.createLease).toHaveBeenCalledTimes(1);
  });

  it('refuses cancellation once lease submission is durably pending', async () => {
    const planned = await service().plan(input, 'run-1');
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const sent = new Promise<void>(resolve => { entered = resolve; });
    writer.createLease.mockImplementation(async () => { entered(); await hold; return deployment(true); });
    const activation = service().activate(owner, planned.reservation.id);
    await sent;
    expect((await ledger.read()).records[0]?.state).toBe('lease_submission_pending');
    await expect(service().cancelPlanned(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_cancellation_unsafe' });
    expect((await ledger.read()).records[0]?.reservedUsdcMicros).toBe(planned.reservation.reservedUsdcMicros);
    release();
    await activation;
    await expect(service().cancelPlanned(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_cancellation_unsafe' });
  });

  it('fails before spending if disabled, run expiry is too short, or the bid changes', async () => {
    const planned = await service().plan(input, 'run-1');
    await expect(service(false).activate(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_lease_creation_disabled' });
    await expect(service(true, false).activate(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_lease_creation_disabled' });
    approval.mockResolvedValueOnce({ owner, runId, hardwareClass: 'cpu', active: true,
      maxSeconds: 7200, maxSpendUsdcMicros: '2000000', expiresAtMs: now + 3_700_000 });
    await expect(service().activate(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_run_invalid' });
    reader.bids.mockResolvedValueOnce([{ ...bid(), price: { denom: 'uact', amount: '91' } }]);
    await expect(service().activate(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_bid_unavailable' });
    expect(writer.createLease).not.toHaveBeenCalled();
    expect((await ledger.read()).records[0]?.state).toBe('planned');
  });

  it('does not reserve a one-hour Console lease for a shorter approved run', async () => {
    approval.mockResolvedValueOnce({ owner, runId, hardwareClass: 'cpu', active: true,
      maxSeconds: 1800, maxSpendUsdcMicros: '2000000' });
    await expect(service().plan(input, 'short-run'))
      .rejects.toMatchObject({ code: 'supplier_deployment_invalid' });
    expect((await ledger.read()).records).toHaveLength(0);
    expect(writer.createLease).not.toHaveBeenCalled();
  });

  it('rejects changed deployment, stale quote, and reduced credits before POST', async () => {
    const planned = await service().plan(input, 'run-1');
    reader.deployment.mockResolvedValueOnce({ ...deployment(), deployment: {
      ...deployment().deployment, hash: 'changed-hash' } });
    await expect(service().activate(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_deployment_invalid' });
    treasury.mockResolvedValueOnce({ availableUact: '2000000',
      usdcMicrosPerMillionUact: '3000000', asOfMs: now, source: 'rate-moved' });
    await expect(service().activate(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_treasury_stale' });
    treasury.mockResolvedValueOnce({ availableUact: '1',
      usdcMicrosPerMillionUact: '2000000', asOfMs: now, source: 'credits-fell' });
    await expect(service().activate(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_treasury_insufficient' });
    expect(writer.createLease).not.toHaveBeenCalled();
    expect((await ledger.read()).records[0]?.state).toBe('planned');
  });

  it('retains the reserve when a successful POST returns changed lease terms', async () => {
    const planned = await service().plan(input, 'run-1');
    const changed = deployment(true);
    changed.leases[0]!.price.amount = '91';
    writer.createLease.mockResolvedValue(changed);
    await expect(service().activate(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_lease_outcome_unknown' });
    expect((await ledger.read()).records[0]?.state).toBe('lease_submission_pending');
    expect((await service().get(owner, planned.reservation.id)).refundConfirmed).toBe(false);
  });
});

describe('Akash Console lease POST transport', () => {
  it('sends one documented bid with no caller manifest and parses the deployment envelope', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: deployment(true) }),
      { headers: { 'content-type': 'application/json' } }));
    const writer = new AkashConsoleLeaseWriter('private-test-key', fetchMock as typeof fetch);
    const result = await writer.createLease({ dseq: input.dseq, gseq: 1, oseq: 1, provider: providerAddress });
    expect(result.leases).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://console-api.akash.network/v1/leases');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual(expect.objectContaining({ 'x-api-key': 'private-test-key' }));
    expect(JSON.parse(init.body as string)).toEqual({ leases: [{ dseq: input.dseq, gseq: 1,
      oseq: 1, provider: providerAddress }] });
  });

  it('rejects malformed input, HTTP errors, and oversized responses', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 502,
      headers: { 'content-type': 'application/json' } }));
    const writer = new AkashConsoleLeaseWriter('private-test-key', fetchMock as typeof fetch);
    await expect(writer.createLease({ dseq: '../escape', gseq: 1, oseq: 1, provider: providerAddress }))
      .rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(writer.createLease({ dseq: input.dseq, gseq: 1, oseq: 1, provider: providerAddress }))
      .rejects.toThrow('lease POST failed (502)');
    const large = vi.fn(async () => new Response('x'.repeat(1_048_577),
      { headers: { 'content-type': 'application/json' } }));
    await expect(new AkashConsoleLeaseWriter('private-test-key', large as typeof fetch)
      .createLease({ dseq: input.dseq, gseq: 1, oseq: 1, provider: providerAddress }))
      .rejects.toThrow('size limit');
  });
});
