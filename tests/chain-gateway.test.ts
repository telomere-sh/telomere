import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWalletClient, decodeFunctionData, getAddress, http, verifyTypedData, type Hex } from 'viem';
import { createChainGateway } from '../src/chain/gateway.js';
import { quoteTypedData } from '../src/chain/typed-data.js';
import { deployLocalContracts, startLocalChain } from '../scripts/local-chain.js';
import { escrowAbi, tokenAbi } from '../src/chain/abi.js';
import { localChain } from '../src/chain/chains.js';

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

describe('disposable gateway cash flow and deployment failures', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>;
  let deployed: Awaited<ReturnType<typeof deployLocalContracts>>;
  let gateway: ReturnType<typeof createChainGateway>;
  beforeAll(async () => {
    local = await startLocalChain({ timestamp: 1_700_000_000 });
    deployed = await deployLocalContracts(local);
    gateway = createChainGateway({ chainId: 31337, rpcUrl: local.rpcUrl,
      escrowAddress: deployed.escrowAddress, tokenAddress: deployed.tokenAddress, privateKey: deployed.keys.signer });
  }, 60_000);
  afterAll(async () => { vi.restoreAllMocks(); await local?.close(); });

  it('executes encoded deposit/reservation/settlement/withdraw and leaves no trapped funds', async () => {
    expect(await gateway.assertDeployment()).toMatchObject({ token: getAddress(deployed.tokenAddress), decimals: 6 });
    const wallet = createWalletClient({ chain: localChain, transport: http(local.rpcUrl), account: deployed.accounts.owner });
    async function send(data: Hex, to = deployed.escrowAddress) {
      return gateway.waitForTransaction(await wallet.sendTransaction({ to, data }));
    }
    await gateway.waitForTransaction(await wallet.writeContract({ address: deployed.tokenAddress,
      abi: tokenAbi, functionName: 'faucet', args: [deployed.accounts.owner.address, 1000n] }));
    await send(gateway.encodeApprove(1000n), deployed.tokenAddress); await send(gateway.encodeDeposit(1000n));
    const leashId = `0x${'dd'.repeat(32)}` as const, runId = `0x${'ee'.repeat(32)}` as const;
    const now = (await local.publicClient.getBlock()).timestamp;
    await send(gateway.encodeCreateLeash(leashId, deployed.accounts.owner.address, 1000n, 1000n, now + 50_000n));
    await send(gateway.encodeUpdateLeash(leashId, deployed.accounts.owner.address, 900n, 1000n, now + 50_000n));
    const quote = { runId, leashId, payer: deployed.accounts.owner.address, workloadHash: `0x${'ab'.repeat(32)}` as const,
      maxSeconds: 10n, pricePerSecond: 10n, inferencePrice: 0n, quoteExpiry: now + 600n };
    await send(gateway.encodeOpen(quote, await gateway.signQuote(quote)));
    expect(await gateway.getBalance(deployed.accounts.owner.address)).toBe(900n);
    expect((await gateway.getLeash(leashId)).pending).toBe(100n);
    expect(await gateway.getRefundAt(runId)).toBeGreaterThan(now);
    const settlement = { runId, billableSeconds: 1n, inferenceCharge: 0n, receiptHash: `0x${'cd'.repeat(32)}` as const };
    const signature = await gateway.signSettlement(settlement);
    expect(decodeFunctionData({ abi: escrowAbi, data: gateway.encodeSettle(settlement, signature) }).functionName).toBe('settleRun');
    await gateway.waitForTransaction(await gateway.submitSettlement(settlement, signature));
    expect((await gateway.getRun(runId)).status).toBe(2);
    expect(await gateway.getBalance(deployed.accounts.owner.address)).toBe(990n);
    expect(await gateway.getTokenBalance(deployed.accounts.treasury.address)).toBe(10n);
    await send(gateway.encodeKill(leashId));
    await send(gateway.encodeWithdraw(990n));
    expect(await gateway.getTokenBalance(deployed.accounts.owner.address)).toBe(990n);
    expect(await gateway.getTokenBalance(deployed.escrowAddress)).toBe(0n);
    expect(decodeFunctionData({ abi: escrowAbi, data: gateway.encodeRefund(runId) }).functionName).toBe('refundRun');
    expect(decodeFunctionData({ abi: escrowAbi, data: gateway.encodeStop(runId) }).functionName).toBe('requestStop');
  });

  it('rejects chain drift, wrong token/decimals/signers, reverted and noncanonical receipts', async () => {
    const plain = createChainGateway({ chainId: 31337, rpcUrl: local.rpcUrl,
      escrowAddress: deployed.escrowAddress, tokenAddress: deployed.tokenAddress });
    const settlement = { runId: `0x${'ef'.repeat(32)}` as const, billableSeconds: 0n,
      inferenceCharge: 0n, receiptHash: `0x${'ac'.repeat(32)}` as const };
    await expect(plain.signSettlement(settlement)).rejects.toThrow('not configured');
    await expect(plain.submitSettlement(settlement, '0x')).rejects.toThrow('not configured');
    await expect(plain.signQuote({ ...settlement, leashId: settlement.runId, payer: deployed.accounts.owner.address,
      workloadHash: settlement.runId, maxSeconds: 1n, pricePerSecond: 1n, inferencePrice: 0n, quoteExpiry: 1n })).rejects.toThrow('not configured');
    expect(await plain.assertDeployment()).toMatchObject({ decimals: 6 });
    const drift = vi.spyOn(gateway.publicClient, 'getChainId').mockResolvedValue(8453);
    await expect(gateway.assertDeployment()).rejects.toThrow('chain mismatch'); drift.mockRestore();
    const original = gateway.publicClient.readContract;
    for (const field of ['token', 'decimals', 'quoteSigner', 'receiptSigner'] as const) {
      const read = vi.spyOn(gateway.publicClient, 'readContract').mockImplementation(async args => {
        if (args.functionName === field) return field === 'decimals' ? 18 : deployed.accounts.outsider.address;
        return original(args);
      });
      await expect(gateway.assertDeployment()).rejects.toThrow(field === 'token' ? 'token mismatch'
        : field === 'decimals' ? 'six decimals' : 'signing identity');
      read.mockRestore();
    }
    const fake = { status: 'reverted' as const, blockNumber: 1n, blockHash: `0x${'01'.repeat(32)}` as const };
    const receipt = vi.spyOn(gateway.publicClient, 'waitForTransactionReceipt');
    // REASON: only the three receipt fields consumed by this boundary are read;
    // real full receipts and cash accounting are exercised in the preceding case.
    receipt.mockResolvedValue(fake as Awaited<ReturnType<typeof gateway.publicClient.waitForTransactionReceipt>>);
    await expect(gateway.waitForTransaction(settlement.runId)).rejects.toThrow('Transaction reverted');
    receipt.mockResolvedValue({ ...fake, status: 'success' } as Awaited<ReturnType<typeof gateway.publicClient.waitForTransactionReceipt>>);
    await expect(gateway.waitForTransaction(settlement.runId)).rejects.toThrow('not canonical');
    receipt.mockRestore();
  });
});
