import { describe, expect, it, vi } from 'vitest';
import { AkashConsoleEscrowObserver, observeAkashEscrow } from '../src/suppliers/akash-escrow-observation.js';
import type { SupplierRecord } from '../src/suppliers/ledger.js';

const owner = 'akash1' + 'o'.repeat(38), provider = 'akash1' + 'p'.repeat(38), now = 1_800_000_000_000;
const record: SupplierRecord = {
  id: ('0x' + 'a'.repeat(64)) as `0x${string}`, owner: ('0x' + '1'.repeat(40)) as `0x${string}`,
  runId: ('0x' + 'b'.repeat(64)) as `0x${string}`,
  idemKey: 'accounting-case', requestHash: ('0x' + 'c'.repeat(64)) as `0x${string}`, akashOwner: owner,
  dseq: '1234567', gseq: 1, oseq: 1, provider, deploymentHash: 'pinned-manifest',
  pricePerBlockUact: '3.98304', runtimeHours: 1, reservedUact: '800000', reservedUsdcMicros: '1600000',
  quoteSource: 'operator', quoteAsOfMs: now, usdcMicrosPerMillionUact: '2000000',
  maxBlocksPerHour: 7200, state: 'active', version: 1, createdAt: now, updatedAt: now,
  lastObservedAt: now, reason: null,
};
function response() {
  return { data: {
    deployment: { id: { owner, dseq: record.dseq }, state: 'active', hash: record.deploymentHash },
    leases: [{ id: { owner, dseq: record.dseq, gseq: 1, oseq: 1, provider }, state: 'active',
      price: { denom: 'uact', amount: '3.983040000000000000' } }],
    escrow_account: { id: { scope: 'deployment', xid: `${owner}/${record.dseq}` }, state: {
      owner, state: 'open', settled_at: '100',
      funds: [{ denom: 'uact', amount: '-0.000000000000000001' },
        { denom: 'uact', amount: '1000000.000000000000000002' }],
      transferred: [{ denom: 'uact', amount: '2.000000000000000001' },
        { denom: 'uact', amount: '0.000000000000000001' }], deposits: [],
    } },
  } };
}

describe('Akash escrow observation without financial settlement', () => {
  it('retains the last fractional micro-unit, sums duplicate uact coins and reports only observed transfer delta', () => {
    const first = observeAkashEscrow(response(), record, undefined, now);
    expect(first).toMatchObject({ fundsUactAtoms: '1000000000000000000000001',
      transferredUactAtoms: '2000000000000000002', transferredDeltaUactAtoms: null,
      settlementConfirmed: false, reserveReleaseEligible: false, settledAtHeight: '100' });
    const nextResponse = response();
    nextResponse.data.escrow_account.state.settled_at = '101';
    nextResponse.data.escrow_account.state.transferred = [{ denom: 'uact', amount: '2.000000000000000003' }];
    const next = observeAkashEscrow(nextResponse, record, first, now + 1000);
    expect(next.transferredDeltaUactAtoms).toBe('1');
    expect(next.settlementConfirmed).toBe(false);
  });

  it('can inspect a pinned closed deployment but never interprets it as a refund', () => {
    const closed = response();
    closed.data.deployment.state = 'closed';
    expect(() => observeAkashEscrow(closed, record, undefined, now)).toThrow(/still lists an active lease/);
    closed.data.leases[0]!.state = 'closed';
    closed.data.escrow_account.state.state = 'closed';
    const observation = observeAkashEscrow(closed, record, undefined, now);
    expect(observation).toMatchObject({ deploymentState: 'closed', leaseState: 'closed',
      escrowState: 'closed', settlementConfirmed: false, reserveReleaseEligible: false });
    closed.data.leases = [];
    expect(observeAkashEscrow(closed, record, undefined, now).leaseState).toBe('not_listed');
    closed.data.escrow_account.state.state = 'overdrawn';
    expect(observeAkashEscrow(closed, record, undefined, now).escrowState).toBe('overdrawn');
  });

  it('rejects identity changes, an unpinned active lease, unsupported denoms and amount regression', () => {
    const changed = response(); changed.data.deployment.hash = 'different';
    expect(() => observeAkashEscrow(changed, record)).toThrow(/identity or manifest/);
    const wrongEscrow = response(); wrongEscrow.data.escrow_account.id.xid = `${owner}/1234568`;
    expect(() => observeAkashEscrow(wrongEscrow, record)).toThrow(/identity or manifest/);
    const noLease = response(); noLease.data.leases = [];
    expect(() => observeAkashEscrow(noLease, record)).toThrow(/no pinned active lease/);
    const changedPrice = response(); changedPrice.data.leases[0]!.price.amount = '101';
    expect(() => observeAkashEscrow(changedPrice, record)).toThrow(/identity or price/);
    const otherCoin = response(); otherCoin.data.escrow_account.state.transferred[0]!.denom = 'uusdc';
    expect(() => observeAkashEscrow(otherCoin, record)).toThrow(/unsupported denomination/);
    const first = observeAkashEscrow(response(), record, undefined, now);
    const lower = response(); lower.data.escrow_account.state.transferred = [{ denom: 'uact', amount: '1' }];
    expect(() => observeAkashEscrow(lower, record, first, now + 1000)).toThrow(/regressed/);
    const staleHeight = response(); staleHeight.data.escrow_account.state.settled_at = '99';
    expect(() => observeAkashEscrow(staleHeight, record, first, now + 1000)).toThrow(/regressed/);
    expect(() => observeAkashEscrow(response(), { ...record, id: ('0x' + 'd'.repeat(64)) as `0x${string}` }, first))
      .toThrow(/another reservation/);
  });

  it('rejects invalid chain precision instead of rounding monetary data', () => {
    const invalid = response();
    invalid.data.escrow_account.state.funds[0]!.amount = '0.0000000000000000001';
    expect(() => observeAkashEscrow(invalid, record)).toThrow();
  });

  it('uses only one pinned bounded GET and never exposes a credential in transport errors', async () => {
    const key = 'private-credential-canary';
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(response()), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const observation = await new AkashConsoleEscrowObserver(key, fetch).observe(record);
    expect(observation.transferredUactAtoms).toBe('2000000000000000002');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe('https://console-api.akash.network/v1/deployments/1234567');
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: {
      'x-api-key': key, accept: 'application/json',
    } });
    const failing = vi.fn<typeof globalThis.fetch>(async () => { throw new Error(key); });
    await expect(new AkashConsoleEscrowObserver(key, failing).observe(record))
      .rejects.toThrow('Akash escrow observation unavailable');
    await expect(new AkashConsoleEscrowObserver(key, failing).observe(record))
      .rejects.not.toThrow(key);
    const oversized = vi.fn<typeof globalThis.fetch>(async () => new Response('x'.repeat(1_048_577), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await expect(new AkashConsoleEscrowObserver(key, oversized).observe(record))
      .rejects.toThrow('Akash escrow observation unavailable');
  });
});
