import { describe, expect, it } from 'vitest';
import { verifyTypedData } from 'viem';
import { createChainGateway } from '../src/chain/gateway.js';
import { quoteTypedData } from '../src/chain/typed-data.js';

const escrowAddress = '0x1111111111111111111111111111111111111111' as const;
const tokenAddress = '0x2222222222222222222222222222222222222222' as const;
const options = { chainId: 31337, rpcUrl: 'http://127.0.0.1:1', escrowAddress, tokenAddress };

describe('legacy local-only chain convenience gateway', () => {
  it.each([8453, 84532, 4663, 46630])('refuses chain %s before constructing a signer or contacting RPC', chainId => {
    expect(() => createChainGateway({ ...options, chainId, privateKey: '0x' })).toThrow('restricted to disposable');
  });
  it.each(['https://rpc.example.com', 'http://user:password@127.0.0.1:1', 'http://127.0.0.1:1/#fragment'])(
    'refuses a remote or ambiguous local RPC %s', rpcUrl => {
      expect(() => createChainGateway({ ...options, rpcUrl })).toThrow('restricted to disposable');
    });
  it('keeps local typed signing bound to its disposable chain without any RPC call', async () => {
    const gateway = createChainGateway({ ...options, privateKey: `0x${'11'.repeat(32)}` });
    const quote = { runId: `0x${'aa'.repeat(32)}` as const, leashId: `0x${'bb'.repeat(32)}` as const,
      payer: tokenAddress, workloadHash: `0x${'cc'.repeat(32)}` as const, maxSeconds: 1n,
      pricePerSecond: 100n, inferencePrice: 0n, quoteExpiry: 30_000n };
    const signature = await gateway.signQuote(quote);
    expect(gateway.account).toBeDefined();
    expect(await verifyTypedData({ ...quoteTypedData(31337, escrowAddress, quote),
      address: gateway.account!.address, signature })).toBe(true);
    expect(await verifyTypedData({ ...quoteTypedData(8453, escrowAddress, quote),
      address: gateway.account!.address, signature })).toBe(false);
  });
});
