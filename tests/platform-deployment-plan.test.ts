import { beforeAll, describe, expect, it } from 'vitest';
import { createTestClient, createWalletClient, getContractAddress, http, keccak256, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { startLocalChain } from '../scripts/local-chain.js';
import { baseMainnetUsdc, baseSepoliaUsdc, localChain } from '../src/chain/chains.js';
import { buildPlatformDeploymentPlan } from '../src/deployment/platform-plan.js';

describe('unsigned paid-platform deployment plan', () => {
  let artifacts: Record<string, ContractArtifact>;
  beforeAll(() => { artifacts = compileContracts(['ReceiptRoot.sol', 'HostRegistry.sol',
    'FeeRouter.sol', 'PlatformRunEscrow.sol', 'MockToken.sol']); }, 90_000);

  it('deploys the exact five predicted CREATE addresses and constructor bindings on disposable Anvil', async () => {
    const local = await startLocalChain();
    try {
      const deployer = privateKeyToAccount(generatePrivateKey());
      const signer = privateKeyToAccount(generatePrivateKey());
      const transport = http(local.rpcUrl, { retryCount: 0 });
      const test = createTestClient({ chain: localChain, mode: 'anvil', transport });
      const wallet = createWalletClient({ chain: localChain, account: deployer, transport });
      await test.setBalance({ address: deployer.address, value: parseEther('5') });
      const tokenTx = await wallet.deployContract({ abi: artifacts.MockToken!.abi,
        bytecode: artifacts.MockToken!.bytecode });
      const tokenReceipt = await local.publicClient.waitForTransactionReceipt({ hash: tokenTx });
      expect(tokenReceipt.status).toBe('success');
      const token = tokenReceipt.contractAddress!;
      const firstNonce = BigInt(await local.publicClient.getTransactionCount({ address: deployer.address }));
      const block = await local.publicClient.getBlock();
      const tokenCode = await local.publicClient.getCode({ address: token, blockNumber: block.number });
      const roles = { deployer: deployer.address, token, governance: deployer.address,
        initialReceiptSigner: signer.address, quoteSigner: signer.address,
        guardian: deployer.address, penaltyTreasury: deployer.address,
        workAllocator: deployer.address, treasury: deployer.address,
        stakers: deployer.address, buyAndBurn: deployer.address };
      const plan = buildPlatformDeploymentPlan({ chainId: 31337, referenceBlock: block.number,
        referenceHash: block.hash, tokenCodeHash: keccak256(tokenCode!), firstNonce, roles, artifacts });
      expect(plan.steps.map(step => step.contract)).toEqual([
        'SignerSet', 'ReceiptRoot', 'HostRegistry', 'FeeRouter', 'PlatformRunEscrow']);
      for (const [index, step] of plan.steps.entries()) {
        expect(step.predictedAddress).toBe(getContractAddress({ from: deployer.address,
          nonce: firstNonce + BigInt(index) }));
        expect(step.creationCodeHash).toBe(keccak256(step.transaction.data));
        expect(step.transaction.nonce).toBe((firstNonce + BigInt(index)).toString());
        const hash = await wallet.sendTransaction({ data: step.transaction.data });
        const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
        expect(receipt.status).toBe('success');
        expect(receipt.contractAddress?.toLowerCase()).toBe(step.predictedAddress.toLowerCase());
      }
      const read = (contract: keyof typeof plan.addresses, functionName: string) =>
        local.publicClient.readContract({ address: plan.addresses[contract],
          abi: artifacts[contract]!.abi, functionName: functionName as never });
      expect(await read('SignerSet', 'governance')).toBe(deployer.address);
      expect(await read('ReceiptRoot', 'signerSet')).toBe(plan.addresses.SignerSet);
      expect(await read('HostRegistry', 'controller')).toBe(plan.addresses.PlatformRunEscrow);
      expect(await read('HostRegistry', 'evidenceRoot')).toBe(plan.addresses.ReceiptRoot);
      expect(await read('FeeRouter', 'controller')).toBe(plan.addresses.PlatformRunEscrow);
      expect(await read('PlatformRunEscrow', 'hostRegistry')).toBe(plan.addresses.HostRegistry);
      expect(await read('PlatformRunEscrow', 'feeRouter')).toBe(plan.addresses.FeeRouter);
      expect(await read('PlatformRunEscrow', 'quoteSigner')).toBe(signer.address);
      expect(await read('PlatformRunEscrow', 'MAX_RUN_CEILING')).toBe(250_000_000n);
    } finally { await local.close(); }
  }, 90_000);

  it('rejects zero roles, invalid references and a missing constructor artifact', () => {
    const account = privateKeyToAccount(generatePrivateKey()).address;
    const roles = { deployer: account, token: account, governance: account, initialReceiptSigner: account,
      quoteSigner: account, guardian: account, penaltyTreasury: account, workAllocator: account,
      treasury: account, stakers: account, buyAndBurn: account };
    const input = { chainId: 31337, referenceBlock: 1n, referenceHash: `0x${'1'.repeat(64)}` as Hex,
      tokenCodeHash: `0x${'2'.repeat(64)}` as Hex, firstNonce: 0n, roles, artifacts };
    expect(() => buildPlatformDeploymentPlan({ ...input,
      roles: { ...roles, guardian: `0x${'0'.repeat(40)}` } })).toThrow('nonzero');
    expect(() => buildPlatformDeploymentPlan({ ...input, firstNonce: -1n })).toThrow('reference');
    expect(() => buildPlatformDeploymentPlan({ ...input,
      artifacts: { ...artifacts, PlatformRunEscrow: undefined! } })).toThrow('missing');
    expect(() => buildPlatformDeploymentPlan({ ...input, chainId: 46630 })).toThrow('reference');
    expect(() => buildPlatformDeploymentPlan({ ...input, chainId: 1 })).toThrow('reference');
    const sepolia = { ...input, chainId: 84532, roles: { ...roles, token: baseSepoliaUsdc } };
    expect(() => buildPlatformDeploymentPlan({ ...sepolia })).toThrow('implementation pins');
    expect(() => buildPlatformDeploymentPlan({ ...sepolia,
      implementationPins: { address: account, codeHash: `0x${'0'.repeat(64)}` as Hex } })).toThrow('implementation pins');
    const pin = { address: account, codeHash: `0x${'3'.repeat(64)}` as Hex };
    const sepoliaPlan = buildPlatformDeploymentPlan({ ...sepolia, implementationPins: pin });
    expect(sepoliaPlan.schemaVersion).toBe(2);
    expect(sepoliaPlan.reviewedAsset).toMatchObject({ kind: 'circle_proxy',
      address: baseSepoliaUsdc, name: 'USDC', version: '2', implementation: pin });
    const mainnet = buildPlatformDeploymentPlan({ ...input, chainId: 8453,
      roles: { ...roles, token: baseMainnetUsdc }, implementationPins: pin });
    expect(mainnet.reviewedAsset).toMatchObject({ address: baseMainnetUsdc, name: 'USD Coin' });
    expect(() => buildPlatformDeploymentPlan({ ...sepolia, roles })).toThrow('canonical Base native USDC');
    expect(() => buildPlatformDeploymentPlan({ ...input, implementationPins: pin })).toThrow('Local mock');
  });
});
