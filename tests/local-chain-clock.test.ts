import { expect, it } from 'vitest';
import { createTestClient, http } from 'viem';
import { localChain } from '../src/chain/chains.js';
import { startLocalChain } from '../scripts/local-chain.js';

it('rejects invalid fixture timestamps before starting an EVM', async () => {
  for (const timestamp of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(startLocalChain({ timestamp })).rejects.toThrow('positive safe integer');
  }
});
it('pins local EVM time independently of the host clock', async () => {
  const local = await startLocalChain({ timestamp: 1_700_000_000 });
  try {
    expect((await local.publicClient.getBlock()).timestamp).toBe(1_700_000_000n);
    const test = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl) });
    await test.setNextBlockTimestamp({ timestamp: 1_700_000_001n }); await test.mine({ blocks: 1 });
    expect((await local.publicClient.getBlock()).timestamp).toBe(1_700_000_001n);
  } finally { await local.close(); }
});
