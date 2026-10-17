import { describe, expect, it, vi } from 'vitest';
import { AkashChainExactBidReader, verifyAkashExactBid,
  type AkashExactBidExpectation } from '../src/suppliers/akash-exact-bid.js';
import { akashPriceAtoms, canonicalAkashPrice, reservedAkashUact } from '../src/suppliers/akash-price.js';

const expected: AkashExactBidExpectation = { owner: `akash1${'o'.repeat(38)}`,
  dseq: '1234567', gseq: 1, oseq: 1, provider: `akash1${'p'.repeat(38)}`,
  bseq: 0, pricePerBlockUact: '90' };
const chainBid = () => ({ bid: { id: { owner: expected.owner, dseq: expected.dseq,
  gseq: '1', oseq: '1', provider: expected.provider, bseq: '0' },
  state: 'open', price: { denom: 'uact', amount: '90' } } });
const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' },
});

describe('read-only Akash exact BidID preflight', () => {
  it('confirms only the pinned unit price, without claiming a lifetime spend bound', () => {
    expect(verifyAkashExactBid(chainBid(), expected)).toEqual({
      bidId: { owner: expected.owner, dseq: expected.dseq, gseq: 1, oseq: 1,
        provider: expected.provider, bseq: 0 },
      pricePerBlockUact: '90', unitPriceConfirmed: true, totalSpendBoundOnChain: false,
    });
    const fixedDecimal = chainBid(); fixedDecimal.bid.price.amount = '90.000000000000000000';
    expect(verifyAkashExactBid(fixedDecimal, expected).unitPriceConfirmed).toBe(true);
    const fractional = chainBid(); fractional.bid.price.amount = '3.983040000000000000';
    expect(verifyAkashExactBid(fractional, { ...expected, pricePerBlockUact: '3.98304' }))
      .toMatchObject({ pricePerBlockUact: '3.98304', totalSpendBoundOnChain: false });
  });

  it('projects fractional prices in exact atoms and rounds the whole-uact hold upward', () => {
    expect(akashPriceAtoms('3.983040000000000000')).toBe(3_983_040_000_000_000_000n);
    expect(canonicalAkashPrice('3.983040000000000000')).toBe('3.98304');
    expect(reservedAkashUact('3.98304', 7200n, 300n)).toBe(29_539n);
    expect(reservedAkashUact('0.000000000000000001', 1n, 0n)).toBe(1n);
    expect(reservedAkashUact('999999999999999999999999999999', 1n, 0n))
      .toBe(999999999999999999999999999999n);
    for (const invalid of ['0', '0.000000000000000000', '3.9830400000000000001',
      '1e2', '-1', '00.1', '1.', '1000000000000000000000000000000']) {
      expect(() => canonicalAkashPrice(invalid)).toThrow();
    }
  });

  it('fails on changed owner, deployment, order, provider, bseq, price, denom, or state', () => {
    const changes: Array<(value: ReturnType<typeof chainBid>) => void> = [
      value => { value.bid.id.owner = `akash1${'x'.repeat(38)}`; },
      value => { value.bid.id.dseq = '1234568'; },
      value => { value.bid.id.gseq = '2'; },
      value => { value.bid.id.oseq = '2'; },
      value => { value.bid.id.provider = `akash1${'x'.repeat(38)}`; },
      value => { value.bid.id.bseq = '1'; },
      value => { value.bid.price.amount = '91'; },
      value => { value.bid.price.denom = 'uakt'; },
      value => { value.bid.state = 'active'; },
    ];
    for (const change of changes) {
      const value = chainBid(); change(value);
      expect(() => verifyAkashExactBid(value, expected)).toThrow();
    }
    const missingSequence = chainBid();
    delete (missingSequence.bid.id as Partial<typeof missingSequence.bid.id>).bseq;
    expect(() => verifyAkashExactBid(missingSequence, expected)).toThrow();
    const fractional = chainBid(); fractional.bid.price.amount = '90.5';
    expect(() => verifyAkashExactBid(fractional, expected)).toThrow();
    const excessPrecision = chainBid(); excessPrecision.bid.price.amount = '90.0000000000000000001';
    expect(() => verifyAkashExactBid(excessPrecision, expected)).toThrow();
    expect(() => verifyAkashExactBid(chainBid(), { ...expected, pricePerBlockUact: '90.0' })).toThrow();
  });

  it('queries the full BidID against a pinned Akash chain ID using GET only', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      if (url.endsWith('/node_info')) return json({ default_node_info: { network: 'akashnet-2' } });
      return json(chainBid());
    }) as unknown as typeof fetch;
    const reader = new AkashChainExactBidReader('https://akash-node.example/', 'akashnet-2', fetchImpl);
    const { pricePerBlockUact: _price, ...id } = expected;
    expect(verifyAkashExactBid(await reader.getBid(id), expected).unitPriceConfirmed).toBe(true);
    const calls = vi.mocked(fetchImpl).mock.calls;
    expect(calls).toHaveLength(2);
    const bidUrl = new URL(String(calls[1]?.[0]));
    expect(bidUrl.pathname).toBe('/akash/market/v1beta5/bids/info');
    expect(Object.fromEntries(bidUrl.searchParams)).toEqual({ 'id.owner': expected.owner,
      'id.dseq': expected.dseq, 'id.gseq': '1', 'id.oseq': '1',
      'id.provider': expected.provider, 'id.bseq': '0' });
  });

  it('blocks wrong chain or a response that fails closed before any bid query', async () => {
    const fetchImpl = vi.fn(async () => json({ default_node_info: { network: 'other-chain' } })) as unknown as typeof fetch;
    const reader = new AkashChainExactBidReader('https://akash-node.example/', 'akashnet-2', fetchImpl);
    const { pricePerBlockUact: _price, ...id } = expected;
    await expect(reader.getBid(id)).rejects.toThrow(/chain ID/);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
    expect(() => new AkashChainExactBidReader('http://akash-node.example/', 'akashnet-2'))
      .toThrow(/HTTPS/);
  });
});
