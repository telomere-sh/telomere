import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestClient, http, keccak256, type Address, type Hex } from 'viem';
import { localChain } from '../src/chain/chains.js';
import { assertHistoricalCodeState } from '../src/payments/usdg-archive.js';
import { startLocalChain, type LocalChain } from '../scripts/local-chain.js';

const asset = '0x0000000000000000000000000000000000001234' as Address;
const originalCode = '0x6001600055' as Hex;
const changedCode = '0x6002600055' as Hex;

describe('historical RPC capability gate', () => {
  let local: LocalChain;
  let anchor: { number: bigint; hash: Hex; timestamp: bigint };
  beforeAll(async () => {
    local = await startLocalChain();
    const test = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl, { retryCount: 0 }) });
    await test.setCode({ address: asset, bytecode: originalCode });
    await test.mine({ blocks: 1 });
    const block = await local.publicClient.getBlock();
    anchor = { number: block.number, hash: block.hash, timestamp: block.timestamp };
    await test.mine({ blocks: 1 });
    await test.setCode({ address: asset, bytecode: changedCode });
    await test.mine({ blocks: 1 });
  }, 30_000);
  afterAll(async () => { await local?.close(); });

  it('reads the old canonical state by block hash after current code changes', async () => {
    expect(await local.publicClient.getCode({ address: asset })).toBe(changedCode);
    expect(await local.publicClient.getCode({ address: asset, blockHash: anchor.hash, requireCanonical: true })).toBe(originalCode);
    await expect(assertHistoricalCodeState(local.publicClient, { anchor, asset,
      codeHash: keccak256(originalCode), minimumAgeSeconds: 0n })).resolves.toBeUndefined();
  });

  it('refuses wrong anchor hash, old-code pin and unproven history depth', async () => {
    await expect(assertHistoricalCodeState(local.publicClient, { anchor: { ...anchor, hash: `0x${'a'.repeat(64)}` as Hex }, asset,
      codeHash: keccak256(originalCode), minimumAgeSeconds: 0n })).rejects.toThrow('anchor differs');
    await expect(assertHistoricalCodeState(local.publicClient, { anchor, asset,
      codeHash: keccak256(changedCode), minimumAgeSeconds: 0n })).rejects.toThrow('code is unavailable or changed');
    await expect(assertHistoricalCodeState(local.publicClient, { anchor, asset,
      codeHash: keccak256(originalCode), minimumAgeSeconds: 10_000n })).rejects.toThrow('retention horizon is unproven');
  });
});
