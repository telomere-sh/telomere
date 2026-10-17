import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileNosanaLedger } from '../src/suppliers/nosana-ledger.js';
import { FileSupplierLedger } from '../src/suppliers/ledger.js';
import { FileSupplierSharedReserve } from '../src/suppliers/shared-reserve.js';
import { NosanaReader, nosanaJobSchema, nosanaMarketSchema, type NosanaJob, type NosanaMarket,
  type NosanaReadClient } from '../src/suppliers/nosana-reader.js';
import { NosanaSupplierService, type ApprovedNosanaRun,
  type NosanaTreasurySnapshot } from '../src/suppliers/nosana-service.js';

const owner = '0x1111111111111111111111111111111111111111', runId = ('0x' + 'a'.repeat(64)) as `0x${string}`;
const payer = 'A'.repeat(43), marketAddress = 'B'.repeat(43), node = 'C'.repeat(43);
const otherNode = 'D'.repeat(43), jobAddress = 'E'.repeat(43), cid = 'Qm' + 'a'.repeat(44);
const now = 1_800_000_000_000, timeStart = Math.floor(now / 1000) - 1000;
const input = { owner, runId, jobAddress };
const job = (): NosanaJob => ({ address: jobAddress, state: 1, market: marketAddress, node,
  payer, ipfsJob: cid, price: 100, timeout: 3600, timeStart, timeEnd: 0 });
const market = (): NosanaMarket => ({ address: marketAddress, type: 'PREMIUM', name: 'NVIDIA 4090' });
// Fields captured from unauthenticated public GETs on 2026-10-12. The full job
// response also contains potentially sensitive jobDefinition and jobResult data.
const actualPublicJobFixture = {
  address: 'Afc5QH6M17XpStiND3Pu5C2CCMoq9UJcu83Bn9vufumw', state: 1,
  market: 'RXP7JK8MTY4uPJng4UjC9ZJdDDSG6wGr8pvVf3mwgXF',
  node: 'DG14eXuQqsx7BCkZdUdjXPHGq7Z82b5bfp9VkW44rY1x',
  payer: 'credFgXCGH3JFUT6WEKF6tJitxrXhSCM2VEqF7GE6pt',
  ipfsJob: 'QmZPu3Qq8eUpME3NrieQ1YFWrQm2xsyD4E4AMx3e3CuR85',
  price: 35, timeout: 86400, timeStart: 1791837486, timeEnd: 0,
};
const actualPublicMarketFixture = {
  address: 'RXP7JK8MTY4uPJng4UjC9ZJdDDSG6wGr8pvVf3mwgXF',
  type: 'PREMIUM', name: 'NVIDIA 3070',
};
const approved = (): ApprovedNosanaRun => ({ owner, runId, hardwareClass: 'gpu', active: true,
  maxSeconds: 3600, maxSpendUsdcMicros: '2000000', openedAtSeconds: timeStart,
  expiresAtSeconds: timeStart + 3600, solanaPayer: payer,
  market: marketAddress, ipfsJob: cid });

describe('Nosana read-only supplier admission', () => {
  let dir: string, path: string, ledger: FileNosanaLedger, sharedReserve: FileSupplierSharedReserve;
  let clock: number;
  let remote: { job: ReturnType<typeof vi.fn>; market: ReturnType<typeof vi.fn> };
  let approval: ReturnType<typeof vi.fn>, treasury: ReturnType<typeof vi.fn>;
  const service = () => new NosanaSupplierService({ ledger, sharedReserve,
    reader: remote as unknown as NosanaReadClient,
    approvedRun: approval as unknown as (owner: string, runId: string) => Promise<ApprovedNosanaRun>,
    treasurySnapshot: treasury as unknown as () => Promise<NosanaTreasurySnapshot>,
    policy: { approvedNodes: [node], approvedMarkets: [marketAddress], maxNosBaseUnitsPerSecond: '200',
    inventoryBufferBps: 300, maxOpenReservedUsdcMicros: '3000000' }, now: () => clock });
  beforeEach(async () => {
    clock = now;
    dir = await mkdtemp(join(tmpdir(), 'telomere-nosana-')); path = join(dir, 'journal.json');
    ledger = new FileNosanaLedger(path);
    sharedReserve = new FileSupplierSharedReserve({ lockPath: join(dir, 'shared.lock'),
      akash: new FileSupplierLedger(join(dir, 'akash.json')), nosana: ledger,
      maxOpenReservedUsdcMicros: '3000000' });
    await sharedReserve.akash.initializeFresh(); await sharedReserve.nosana.initializeFresh(); await sharedReserve.initializeFresh();
    remote = { job: vi.fn(async () => job()), market: vi.fn(async () => market()) };
    approval = vi.fn(async () => approved());
    treasury = vi.fn(async () => ({ availableNosBaseUnits: '1000000',
      usdcMicrosPerMillionNosBaseUnits: '2000000', asOfMs: now, source: 'NOS/USDC direct oracle' }));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('pins approved node, payer, workload and direct NOS-to-USDC reserve durably', async () => {
    const first = await service().admit(input, 'nosana-1');
    expect(first.replayed).toBe(false);
    expect(first.reservation.state).toBe('active_observed');
    expect(first.reservation.reservedNosBaseUnits).toBe('370800');
    expect(first.reservation.reservedUsdcMicros).toBe('741600');
    expect(first.reservation.quoteSource).toBe('NOS/USDC direct oracle');
    expect(first.reservation.meterEligible).toBe(false);
    expect(first.reservation.billableSeconds).toBe(0);
    expect((await new FileNosanaLedger(path).read()).records[0]?.jobAddress).toBe(jobAddress);
    remote.job.mockRejectedValueOnce(new Error('offline'));
    expect((await service().admit(input, 'nosana-1')).replayed).toBe(true);
    expect(remote.job).toHaveBeenCalledTimes(1);
  });

  it('rejects changed idempotency key payload and reserves each job once', async () => {
    await service().admit(input, 'same');
    await expect(service().admit({ ...input, jobAddress: otherNode }, 'same'))
      .rejects.toMatchObject({ code: 'nosana_idempotency_conflict' });
    const anotherOwner = { ...input, owner: '0x2222222222222222222222222222222222222222',
      runId: '0x' + 'b'.repeat(64) };
    approval.mockResolvedValue({ ...approved(), owner: anotherOwner.owner, runId: anotherOwner.runId });
    await expect(service().admit(anotherOwner, 'other')).rejects.toMatchObject({ code: 'nosana_job_reserved' });
  });

  it('fails before external reads when GPU approval is inactive or points to another market', async () => {
    approval.mockResolvedValueOnce({ ...approved(), active: false });
    await expect(service().admit(input, 'inactive')).rejects.toMatchObject({ code: 'nosana_run_invalid' });
    expect(remote.job).not.toHaveBeenCalled();
    approval.mockResolvedValueOnce({ ...approved(), market: otherNode });
    await expect(service().admit(input, 'market')).rejects.toMatchObject({ code: 'nosana_run_invalid' });
    approval.mockResolvedValueOnce({ ...approved(), expiresAtSeconds: timeStart + 3601 });
    await expect(service().admit(input, 'unbounded-window')).rejects.toMatchObject({ code: 'nosana_run_invalid' });
    expect(remote.job).not.toHaveBeenCalled();
  });

  it('requires the indexed job to fit within the canonical funded run window', async () => {
    approval.mockResolvedValueOnce({ ...approved(), openedAtSeconds: timeStart + 1,
      expiresAtSeconds: timeStart + 3601 });
    await expect(service().admit(input, 'pre-open-job')).rejects.toMatchObject({ code: 'nosana_job_invalid' });
    approval.mockResolvedValueOnce({ ...approved(), expiresAtSeconds: timeStart + 3599 });
    await expect(service().admit(input, 'past-expiry-job')).rejects.toMatchObject({ code: 'nosana_job_invalid' });
    approval.mockResolvedValueOnce({ ...approved(), expiresAtSeconds: Math.floor(now / 1000) });
    await expect(service().admit(input, 'expired-run')).rejects.toMatchObject({ code: 'nosana_run_invalid' });
    expect((await ledger.read()).records).toHaveLength(0);
  });

  it('refuses an approval that expires while the remote job is being read', async () => {
    approval.mockResolvedValueOnce({ ...approved(), expiresAtSeconds: Math.floor(now / 1000) + 2 });
    remote.job.mockImplementationOnce(async () => { clock += 3000; return { ...job(), timeout: 1002 }; });
    await expect(service().admit(input, 'expiry-race')).rejects.toMatchObject({ code: 'nosana_run_invalid' });
    expect((await ledger.read()).records).toHaveLength(0);
  });

  it('rejects queued, unapproved-node, wrong-payer, changed-CID, or community jobs', async () => {
    remote.job.mockResolvedValueOnce({ ...job(), state: 0, node: '1'.repeat(32), timeStart: 0 });
    await expect(service().admit(input, 'queued')).rejects.toMatchObject({ code: 'nosana_job_invalid' });
    remote.job.mockResolvedValueOnce({ ...job(), node: otherNode });
    await expect(service().admit(input, 'node')).rejects.toMatchObject({ code: 'nosana_job_invalid' });
    remote.job.mockResolvedValueOnce({ ...job(), payer: otherNode });
    await expect(service().admit(input, 'payer')).rejects.toMatchObject({ code: 'nosana_job_invalid' });
    remote.job.mockResolvedValueOnce({ ...job(), ipfsJob: 'Qm' + 'b'.repeat(44) });
    await expect(service().admit(input, 'image')).rejects.toMatchObject({ code: 'nosana_job_invalid' });
    remote.market.mockResolvedValueOnce({ ...market(), type: 'COMMUNITY' });
    await expect(service().admit(input, 'community')).rejects.toMatchObject({ code: 'nosana_job_invalid' });
    expect((await ledger.read()).records).toHaveLength(0);
  });

  it('rejects stale direct FX, high price, run budget overflow and insufficient NOS inventory', async () => {
    treasury.mockResolvedValueOnce({ availableNosBaseUnits: '1000000',
      usdcMicrosPerMillionNosBaseUnits: '2000000', asOfMs: now - 61_000, source: 'old' });
    await expect(service().admit(input, 'stale')).rejects.toMatchObject({ code: 'nosana_treasury_stale' });
    remote.job.mockResolvedValueOnce({ ...job(), price: 201 });
    await expect(service().admit(input, 'price')).rejects.toMatchObject({ code: 'nosana_job_invalid' });
    approval.mockResolvedValueOnce({ ...approved(), maxSpendUsdcMicros: '700000' });
    await expect(service().admit(input, 'budget')).rejects.toMatchObject({ code: 'nosana_budget_exceeded' });
    treasury.mockResolvedValueOnce({ availableNosBaseUnits: '300000',
      usdcMicrosPerMillionNosBaseUnits: '2000000', asOfMs: now, source: 'low' });
    await expect(service().admit(input, 'inventory')).rejects.toMatchObject({ code: 'nosana_treasury_insufficient' });
  });

  it('rejects an unsafe price even when an alternate reader bypasses its own schema', async () => {
    remote.job.mockResolvedValueOnce({ ...job(), price: Number.MAX_SAFE_INTEGER + 1 });
    await expect(service().admit(input, 'unsafe-price')).rejects.toThrow();
    expect((await ledger.read()).records).toHaveLength(0);
  });

  it('observes completed job but retains the reserve and confirms no refund or billable seconds', async () => {
    const first = await service().admit(input, 'nosana-1');
    remote.job.mockResolvedValue({ ...job(), state: 2, timeEnd: timeStart + 900 });
    const closed = await service().reconcile(owner, first.reservation.id);
    expect(closed.state).toBe('closed_unsettled');
    expect(closed.reservedNosBaseUnits).toBe(first.reservation.reservedNosBaseUnits);
    expect(closed.refundConfirmed).toBe(false);
    expect(closed.billableSeconds).toBe(0);
    expect((await new FileNosanaLedger(path).read()).records[0]?.state).toBe('closed_unsettled');
  });

  it('quarantines node reassignment, identity change and regression after completion', async () => {
    const first = await service().admit(input, 'nosana-1');
    remote.job.mockResolvedValueOnce({ ...job(), node: otherNode });
    const changed = await service().reconcile(owner, first.reservation.id);
    expect(changed.state).toBe('quarantined');
    expect(changed.reason).toBe('external_identity_or_terms_changed');
    remote.job.mockResolvedValue(job());
    expect((await service().reconcile(owner, first.reservation.id)).state).toBe('quarantined');
  });

  it('quarantines a terminal state without a confirmed end time', async () => {
    const first = await service().admit(input, 'nosana-1');
    remote.job.mockResolvedValue({ ...job(), state: 3, timeEnd: 0 });
    expect((await service().reconcile(owner, first.reservation.id)).reason).toBe('terminal_time_unconfirmed');
  });

  it('quarantines a terminal time beyond the job timeout or in the future', async () => {
    const first = await service().admit(input, 'nosana-1');
    clock = (timeStart + 4000) * 1000;
    remote.job.mockResolvedValueOnce({ ...job(), state: 2, timeEnd: timeStart + 3601 });
    const overrun = await service().reconcile(owner, first.reservation.id);
    expect(overrun.state).toBe('quarantined');
    expect(overrun.reason).toBe('terminal_time_unconfirmed');
    expect(overrun.reservedNosBaseUnits).toBe(first.reservation.reservedNosBaseUnits);
    const secondInput = { ...input, runId: '0x' + 'b'.repeat(64), jobAddress: otherNode };
    clock = now;
    approval.mockResolvedValueOnce({ ...approved(), runId: secondInput.runId });
    remote.job.mockResolvedValueOnce({ ...job(), address: otherNode });
    const second = await service().admit(secondInput, 'nosana-2');
    remote.job.mockResolvedValue({ ...job(), address: otherNode, state: 2, timeEnd: Math.floor(now / 1000) + 1 });
    expect((await service().reconcile(owner, second.reservation.id)).reason).toBe('terminal_time_unconfirmed');
  });

  it('keeps the persisted observation unchanged on remote failure', async () => {
    const first = await service().admit(input, 'nosana-1');
    remote.job.mockRejectedValue(new Error('indexer down'));
    await expect(service().reconcile(owner, first.reservation.id)).rejects.toThrow('indexer down');
    expect((await ledger.read()).records[0]?.version).toBe(0);
  });
});

describe('Nosana fixed-origin GET reader', () => {
  it('accepts selected fields from actual public job and market responses', async () => {
    expect(nosanaJobSchema.parse(actualPublicJobFixture).price).toBe(35);
    expect(nosanaMarketSchema.parse(actualPublicMarketFixture).type).toBe('PREMIUM');
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes('/api/markets/') ? actualPublicMarketFixture : actualPublicJobFixture),
    { headers: { 'content-type': 'application/json' } }));
    const reader = new NosanaReader(fetchMock as typeof fetch);
    expect((await reader.job(actualPublicJobFixture.address)).market).toBe(actualPublicMarketFixture.address);
    expect((await reader.market(actualPublicMarketFixture.address)).name).toBe('NVIDIA 3070');
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://api.nosana.com/jobs/' + actualPublicJobFixture.address,
      'https://api.nosana.com/api/markets/' + actualPublicMarketFixture.address,
    ]);
  });
  it('rejects an unsafe JSON price before bigint conversion or admission', async () => {
    const unsafePrice = Number.MAX_SAFE_INTEGER + 1;
    expect(nosanaJobSchema.safeParse({ ...actualPublicJobFixture, price: unsafePrice }).success).toBe(false);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ...actualPublicJobFixture, price: unsafePrice }),
      { headers: { 'content-type': 'application/json' } }));
    await expect(new NosanaReader(fetchMock as typeof fetch).job(actualPublicJobFixture.address)).rejects.toThrow();
  });
  it('parses live-shaped job and market records from only fixed read paths', async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/api/markets/') ? market() : job()),
      { headers: { 'content-type': 'application/json' } }));
    const reader = new NosanaReader(fetchMock as typeof fetch);
    expect((await reader.job(jobAddress)).node).toBe(node);
    expect((await reader.market(marketAddress)).type).toBe('PREMIUM');
    expect(fetchMock).toHaveBeenCalledWith('https://api.nosana.com/jobs/' + jobAddress,
      expect.objectContaining({ method: 'GET', redirect: 'error' }));
    expect(fetchMock).toHaveBeenCalledWith('https://api.nosana.com/api/markets/' + marketAddress,
      expect.objectContaining({ method: 'GET', redirect: 'error' }));
    await expect(reader.job('../wrong')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('rejects identity mismatch, non-JSON, oversize and unavailable HTTP', async () => {
    const wrong = vi.fn(async () => new Response(JSON.stringify({ ...job(), address: otherNode }),
      { headers: { 'content-type': 'application/json' } }));
    await expect(new NosanaReader(wrong as typeof fetch).job(jobAddress)).rejects.toThrow('identity mismatch');
    const html = vi.fn(async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }));
    await expect(new NosanaReader(html as typeof fetch).job(jobAddress)).rejects.toThrow('not JSON');
    const large = vi.fn(async () => new Response('x'.repeat(1_048_577),
      { headers: { 'content-type': 'application/json' } }));
    await expect(new NosanaReader(large as typeof fetch).job(jobAddress)).rejects.toThrow('size limit');
    const unavailable = vi.fn(async () => new Response('', { status: 503 }));
    await expect(new NosanaReader(unavailable as typeof fetch).job(jobAddress)).rejects.toThrow('GET failed (503)');
  });
});
