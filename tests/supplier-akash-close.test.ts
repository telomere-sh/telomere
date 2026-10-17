import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AkashConsoleDeploymentCloser, type AkashDeployment, type AkashDeploymentCloseClient,
  type AkashReadClient } from '../src/suppliers/akash-console.js';
import { FileSupplierLedger } from '../src/suppliers/ledger.js';
import { FileNosanaLedger } from '../src/suppliers/nosana-ledger.js';
import { SupplierService, type ApprovedSupplierRun, type TreasurySnapshot } from '../src/suppliers/service.js';
import { FileSupplierSharedReserve } from '../src/suppliers/shared-reserve.js';

const owner = '0x1111111111111111111111111111111111111111';
const runId = '0x' + 'a'.repeat(64);
const akashOwner = 'akash1' + 'o'.repeat(38);
const provider = 'akash1' + 'p'.repeat(38);
const dseq = '1234567';
const now = 1_800_000_000_000;
const input = { owner, runId, akashOwner, dseq, gseq: 1, oseq: 1,
  plannedSeconds: 1800, maxSpendUsdcMicros: '2000000' };
const deployment = (state: 'empty' | 'active' | 'closed' = 'empty'): AkashDeployment => ({
  deployment: { id: { owner: akashOwner, dseq }, state: state === 'closed' ? 'closed' : 'active',
    hash: 'pinned-manifest-hash' },
  leases: state === 'empty' ? [] : [{ id: { owner: akashOwner, dseq, gseq: 1, oseq: 1, provider },
    state: state === 'closed' ? 'closed' : 'active', price: { denom: 'uact', amount: '90' } }],
});

describe('operator-gated Akash deployment closure', () => {
  let dir: string, ledger: FileSupplierLedger, sharedReserve: FileSupplierSharedReserve;
  let reader: { providers: ReturnType<typeof vi.fn>; bids: ReturnType<typeof vi.fn>;
    deployment: ReturnType<typeof vi.fn>; settings: ReturnType<typeof vi.fn> };
  let closeWriter: { closeDeployment: ReturnType<typeof vi.fn> };
  const service = (enabled = true, withWriter = true) => new SupplierService({ ledger, sharedReserve,
    akash: reader as unknown as AkashReadClient,
    ...(withWriter ? { closeWriter: closeWriter as unknown as AkashDeploymentCloseClient } : {}),
    approvedRun: async () => ({ owner, runId, hardwareClass: 'cpu', active: true, maxSeconds: 3600,
      maxSpendUsdcMicros: '2000000' }) as ApprovedSupplierRun,
    treasurySnapshot: async () => ({ availableUact: '2000000',
      usdcMicrosPerMillionUact: '2000000', asOfMs: now, source: 'trusted-operator-quote' }) as TreasurySnapshot,
    policy: { approvedProviders: [provider], maxBlocksPerHour: 7200,
      inventoryBufferBps: 300, maxOpenReservedUsdcMicros: '10000000', deploymentCloseEnabled: enabled },
    now: () => now });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'telomere-akash-close-'));
    ledger = new FileSupplierLedger(join(dir, 'supplier.json'));
    sharedReserve = new FileSupplierSharedReserve({ lockPath: join(dir, 'shared.lock'), akash: ledger,
      nosana: new FileNosanaLedger(join(dir, 'nosana.json')), maxOpenReservedUsdcMicros: '10000000' });
    await sharedReserve.akash.initializeFresh(); await sharedReserve.nosana.initializeFresh(); await sharedReserve.initializeFresh();
    reader = { providers: vi.fn(async () => [{ owner: provider, isOnline: true,
      isAudited: true, isValidVersion: true, uptime30d: 0.98 }]),
    bids: vi.fn(async () => [{ id: { owner: akashOwner, dseq, gseq: 1, oseq: 1, provider },
      state: 'open', price: { denom: 'uact', amount: '90' } }]),
    deployment: vi.fn(async () => deployment()),
    settings: vi.fn(async () => ({ dseq, autoTopUpEnabled: true, runtimeLimitHours: 1,
      runtimeEndsAt: null as string | null })) };
    closeWriter = { closeDeployment: vi.fn(async () => undefined) };
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function activeReservation() {
    const planned = await service().plan(input, 'run-1');
    reader.deployment.mockResolvedValue(deployment('active'));
    reader.settings.mockResolvedValue({ dseq, autoTopUpEnabled: true, runtimeLimitHours: 1,
      runtimeEndsAt: new Date(now + 3_600_000).toISOString() });
    expect((await service().reconcile(owner, planned.reservation.id)).state).toBe('active');
    return planned.reservation.id;
  }

  it('journals the one-way DELETE intent, observes closure later, and retains the full reserve', async () => {
    const id = await activeReservation();
    let stateAtDelete: string | undefined;
    closeWriter.closeDeployment.mockImplementation(async () => {
      stateAtDelete = (await new FileSupplierLedger(join(dir, 'supplier.json')).read()).records[0]?.state;
    });
    const closed = await service().requestClose(owner, id);
    expect(closed.submitted).toBe(true);
    expect(stateAtDelete).toBe('closure_submission_pending');
    expect(closed.reservation.reserveHeldUsdcMicros).toBe(closed.reservation.reservedUsdcMicros);
    expect(closeWriter.closeDeployment).toHaveBeenCalledExactlyOnceWith(dseq);
    expect((await service().reconcile(owner, id)).state).toBe('closure_submission_pending');
    await expect(service().requestClose(owner, id))
      .rejects.toMatchObject({ code: 'supplier_close_already_attempted' });
    reader.deployment.mockResolvedValue(deployment('closed'));
    const observed = await service().reconcile(owner, id);
    expect(observed.state).toBe('closed_unsettled');
    expect(observed.reserveHeldUsdcMicros).toBe(observed.reservedUsdcMicros);
    expect(observed.refundConfirmed).toBe(false);
    expect(observed.billableSeconds).toBe(0);
  });

  it('keeps an uncertain DELETE outcome across restart and never retries it', async () => {
    const id = await activeReservation();
    closeWriter.closeDeployment.mockRejectedValueOnce(new Error('connection reset after send'));
    await expect(service().requestClose(owner, id))
      .rejects.toMatchObject({ code: 'supplier_close_outcome_unknown' });
    expect((await new FileSupplierLedger(join(dir, 'supplier.json')).read()).records[0]?.state)
      .toBe('closure_submission_pending');
    await expect(service().requestClose(owner, id))
      .rejects.toMatchObject({ code: 'supplier_close_already_attempted' });
    expect(closeWriter.closeDeployment).toHaveBeenCalledTimes(1);
    reader.deployment.mockResolvedValue(deployment('closed'));
    expect((await service().reconcile(owner, id)).state).toBe('closed_unsettled');
  });

  it('refuses disabled, changed, or unobserved leases before DELETE', async () => {
    const planned = await service().plan(input, 'run-1');
    await expect(service().requestClose(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_close_already_attempted' });
    reader.deployment.mockResolvedValue(deployment('active'));
    reader.settings.mockResolvedValue({ dseq, autoTopUpEnabled: true, runtimeLimitHours: 1,
      runtimeEndsAt: new Date(now + 3_600_000).toISOString() });
    await service().reconcile(owner, planned.reservation.id);
    await expect(service(false).requestClose(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_deployment_close_disabled' });
    await expect(service(true, false).requestClose(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_deployment_close_disabled' });
    const changed = deployment('active');
    changed.leases[0]!.price.amount = '91';
    reader.deployment.mockResolvedValueOnce(changed);
    await expect(service().requestClose(owner, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_deployment_changed' });
    expect((await ledger.read()).records[0]?.state).toBe('active');
    expect(closeWriter.closeDeployment).not.toHaveBeenCalled();
  });
});

describe('Akash Console deployment DELETE transport', () => {
  it('sends only a fixed-host DELETE for a validated dseq', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { success: true } }),
      { headers: { 'content-type': 'application/json' } }));
    const writer = new AkashConsoleDeploymentCloser('private-test-key', fetchMock as typeof fetch);
    await writer.closeDeployment(dseq);
    expect(fetchMock).toHaveBeenCalledWith('https://console-api.akash.network/v1/deployments/' + dseq,
      expect.objectContaining({ method: 'DELETE', redirect: 'error',
        headers: expect.objectContaining({ 'x-api-key': 'private-test-key' }) }));
    await expect(writer.closeDeployment('../escape')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects HTTP failures, invalid success envelopes, and oversized responses', async () => {
    const error = vi.fn(async () => new Response('{}', { status: 503,
      headers: { 'content-type': 'application/json' } }));
    await expect(new AkashConsoleDeploymentCloser('private-test-key', error as typeof fetch)
      .closeDeployment(dseq)).rejects.toThrow('deployment DELETE failed (503)');
    const rejected = vi.fn(async () => new Response(JSON.stringify({ data: { success: false } }),
      { headers: { 'content-type': 'application/json' } }));
    await expect(new AkashConsoleDeploymentCloser('private-test-key', rejected as typeof fetch)
      .closeDeployment(dseq)).rejects.toThrow();
    const large = vi.fn(async () => new Response('x'.repeat(1_048_577),
      { headers: { 'content-type': 'application/json' } }));
    await expect(new AkashConsoleDeploymentCloser('private-test-key', large as typeof fetch)
      .closeDeployment(dseq)).rejects.toThrow('size limit');
  });
});
