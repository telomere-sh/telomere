import { beforeAll, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, custom, decodeFunctionData, domainSeparator,
  encodeFunctionResult, getAddress, getContractAddress, http, keccak256, parseAbi, parseEther, zeroAddress, zeroHash,
  type Address, type Hex } from 'viem';
import { z } from 'zod';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileContracts, projectRoot, type ContractArtifact } from '../scripts/compile-contracts.js';
import { startLocalChain } from '../scripts/local-chain.js';
import { baseMainnet, baseMainnetUsdc, baseSepoliaUsdc, localChain } from '../src/chain/chains.js';
import { buildPlatformDeploymentPlan } from '../src/deployment/platform-plan.js';
import { buildPlatformPaymentDeploymentPlan, platformPaymentDeploymentPlanSchema,
  publicPaymentDeploymentProfileSchema, type PaymentDeploymentProfile } from '../src/deployment/platform-payment-plan.js';
import { readPaymentDeploymentReference, verifyPaymentDeploymentDependencies,
  verifyPaymentDeploymentPlanState } from '../src/deployment/platform-payment-preflight.js';
import { CPU_PERMIT2, CPU_UPTO_PROXY } from '../src/payments/cpu-reservation-types.js';
import { SPEND_PERMISSION_MANAGER, SPEND_PERMISSION_TYPEHASH } from '../src/payments/spend-permission-types.js';
import { compileSpendPermissionFixtures } from './fixtures/platform-spend-permission.js';
import { compileX402CpuFixtures } from './fixtures/platform-x402-cpu.js';

let artifacts: Record<string, ContractArtifact>;
beforeAll(() => {
  artifacts = { ...compileSpendPermissionFixtures(), ...compileX402CpuFixtures(),
    ...compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol']) };
}, 120_000);
const hash = `0x${'1'.repeat(64)}` as const;
function roles(account: Address, token: Address, signer = account) {
  return { deployer: account, token, governance: account, initialReceiptSigner: signer,
    quoteSigner: signer, guardian: account, penaltyTreasury: account, workAllocator: account,
    treasury: account, stakers: account, buyAndBurn: account };
}
function artifact(name: string) {
  const value = artifacts[name]; if (!value) throw new Error('Fixture artifact missing: ' + name); return value;
}

for (const kind of ['base_spend_permission_v1', 'x402_cpu_v1'] as const) {
  it(`deploys all five exact unsigned ${kind} CREATE steps with real official dependencies and domain/controller bindings`, async () => {
    const local = await startLocalChain();
    try {
      const deployer = privateKeyToAccount(generatePrivateKey()), signer = privateKeyToAccount(generatePrivateKey());
      const transport = http(local.rpcUrl, { retryCount: 0 });
      const test = createTestClient({ chain: localChain, mode: 'anvil', transport });
      const wallet = createWalletClient({ chain: localChain, account: deployer, transport });
      await test.setBalance({ address: deployer.address, value: parseEther('10') });
      const deploy = async (name: string, args: readonly unknown[] = []): Promise<Address> => {
        const value = artifact(name);
        const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: value.abi,
          bytecode: value.bytecode, args }) });
        if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Dependency deployment failed');
        return getAddress(receipt.contractAddress);
      };
      const codeHash = async (address: Address) => {
        const code = await local.publicClient.getCode({ address });
        if (!code || code === '0x') throw new Error('Dependency code missing'); return keccak256(code);
      };
      const token = await deploy(kind === 'x402_cpu_v1' ? 'LocalReceiveToken' : 'MockToken');
      let paymentProfile: PaymentDeploymentProfile;
      if (kind === 'base_spend_permission_v1') {
        const manager = await deploy('SpendPermissionManager', [zeroAddress, zeroAddress]);
        paymentProfile = { kind, managerAddress: manager, managerCodeHash: await codeHash(manager) };
      } else {
        const permit2 = await deploy('Permit2');
        const proxy = await deploy('x402UptoPermit2Proxy', [permit2]);
        paymentProfile = { kind, permit2Address: permit2, permit2CodeHash: await codeHash(permit2),
          proxyAddress: proxy, proxyCodeHash: await codeHash(proxy), tokenName: 'Local Receive Fixture', tokenVersion: '1' };
      }
      // Disposable Anvil's finalized tag may lag these newly created fixtures;
      // the public-only CLI finalized boundary is exercised separately below.
      const block = await local.publicClient.getBlock();
      await verifyPaymentDeploymentDependencies(local.publicClient, { chainId: 31337, token, paymentProfile, blockHash: block.hash });
      const nonceBefore = await local.publicClient.getTransactionCount({ address: deployer.address });
      const bad = paymentProfile.kind === 'base_spend_permission_v1' ? { ...paymentProfile, managerCodeHash: hash }
        : { ...paymentProfile, proxyCodeHash: hash };
      await expect(verifyPaymentDeploymentDependencies(local.publicClient,
        { chainId: 31337, token, paymentProfile: bad, blockHash: block.hash })).rejects.toThrow('differs');
      expect(await local.publicClient.getTransactionCount({ address: deployer.address })).toBe(nonceBefore);
      if (paymentProfile.kind === 'x402_cpu_v1') {
        await expect(verifyPaymentDeploymentDependencies(local.publicClient, { chainId: 31337, token,
          paymentProfile: { ...paymentProfile, tokenVersion: '2' }, blockHash: block.hash })).rejects.toThrow('differs');
        const otherPermit = await deploy('Permit2');
        const anotherProxy = await deploy('x402UptoPermit2Proxy', [otherPermit]);
        const latest = await local.publicClient.getBlock();
        await expect(verifyPaymentDeploymentDependencies(local.publicClient, { chainId: 31337, token,
          paymentProfile: { ...paymentProfile, proxyAddress: anotherProxy, proxyCodeHash: await codeHash(anotherProxy) },
          blockHash: latest.hash })).rejects.toThrow('differs');
      }
      const reference = await local.publicClient.getBlock();
      const firstNonce = BigInt(await local.publicClient.getTransactionCount({ address: deployer.address }));
      const input = { chainId: 31337, referenceBlock: reference.number, referenceHash: reference.hash,
        tokenCodeHash: await codeHash(token), firstNonce, roles: roles(deployer.address, token, signer.address), artifacts, paymentProfile };
      const plan = buildPlatformPaymentDeploymentPlan(input);
      const historical = buildPlatformDeploymentPlan(input);
      expect(plan.schemaVersion).toBe(3); expect(historical.schemaVersion).toBe(2);
      const finalName = kind === 'base_spend_permission_v1' ? 'PlatformSpendPermissionEscrowV1' : 'PlatformX402EscrowV1';
      expect(plan.steps.map(step => step.contract)).toEqual(['SignerSet', 'ReceiptRoot', 'HostRegistry', 'FeeRouter', finalName]);
      expect(plan.addresses).not.toHaveProperty('PlatformRunEscrow');
      expect(JSON.stringify(plan)).not.toContain('PlatformRunEscrow');
      for (const [index, step] of plan.steps.entries()) {
        if (index < 4) {
          const { runtimeTemplateHash: _hash, runtimeTemplateBytes: _bytes, ...original } = step;
          expect(original).toEqual(historical.steps[index]);
        }
        expect(step.predictedAddress).toBe(getContractAddress({ from: deployer.address, nonce: firstNonce + BigInt(index) }));
        expect(step.bytecodeHash).toBe(keccak256(artifact(step.contract).bytecode));
        expect(step.creationCodeHash).toBe(keccak256(step.transaction.data));
        expect(step.runtimeTemplateHash).toBe(keccak256(artifact(step.contract).deployedBytecode));
        expect(step.runtimeTemplateBytes).toBeLessThanOrEqual(24_576);
        expect(step.transaction).toMatchObject({ from: deployer.address, to: null, value: '0', nonce: step.nonce });
      }
      expect(await local.publicClient.getTransactionCount({ address: deployer.address })).toBe(Number(firstNonce));
      expect(() => platformPaymentDeploymentPlanSchema.parse({ ...plan,
        quoteDomain: { ...plan.quoteDomain, version: kind === 'x402_cpu_v1' ? '3' : '4' } })).toThrow('disagree');
      expect(() => platformPaymentDeploymentPlanSchema.parse({ ...plan, steps: plan.steps.map((step, index) =>
        index === 4 ? { ...step, nonce: '0' } : step) })).toThrow('disagree');
      for (const step of plan.steps) {
        const txHash = await wallet.sendTransaction({ to: null, data: step.transaction.data,
          nonce: Number(step.transaction.nonce), value: BigInt(step.transaction.value) });
        const receipt = await local.publicClient.waitForTransactionReceipt({ hash: txHash });
        expect(receipt.status).toBe('success');
        expect(receipt.contractAddress?.toLowerCase()).toBe(step.predictedAddress.toLowerCase());
        const tx = await local.publicClient.getTransaction({ hash: txHash });
        expect(tx.input).toBe(step.transaction.data); expect(tx.nonce).toBe(Number(step.nonce));
      }
      const read = (name: string, functionName: string) => {
        const step = plan.steps.find(item => item.contract === name);
        if (!step) throw new Error('Planned step missing');
        return local.publicClient.readContract({ address: step.predictedAddress, abi: artifact(name).abi, functionName });
      };
      const escrow = plan.steps[4]!.predictedAddress;
      expect(await read('SignerSet', 'governance')).toBe(deployer.address);
      expect(await read('ReceiptRoot', 'signerSet')).toBe(plan.addresses.SignerSet);
      expect(await read('HostRegistry', 'controller')).toBe(escrow);
      expect(await read('HostRegistry', 'evidenceRoot')).toBe(plan.addresses.ReceiptRoot);
      expect(await read('FeeRouter', 'controller')).toBe(escrow);
      expect(await read('FeeRouter', 'workAllocator')).toBe(deployer.address);
      expect(await read(finalName, 'token')).toBe(token);
      expect(await read(finalName, 'quoteSigner')).toBe(signer.address);
      expect(await read(finalName, 'guardian')).toBe(deployer.address);
      expect(await read(finalName, 'receiptRoot')).toBe(plan.addresses.ReceiptRoot);
      expect(await read(finalName, 'hostRegistry')).toBe(plan.addresses.HostRegistry);
      expect(await read(finalName, 'feeRouter')).toBe(plan.addresses.FeeRouter);
      expect(await read(finalName, 'eip712Domain')).toEqual(['0x0f', 'TelomerePlatformEscrow', kind === 'base_spend_permission_v1' ? '3' : '4',
        31337n, escrow, zeroHash, []]);
      expect(domainSeparator({ domain: plan.quoteDomain })).not.toBe(domainSeparator({ domain: { ...plan.quoteDomain, version: '1' } }));
      if (paymentProfile.kind === 'base_spend_permission_v1') {
        expect(await read(finalName, 'spendPermissionManager')).toBe(paymentProfile.managerAddress);
        expect(await read(finalName, 'spendPermissionManagerCodeHash')).toBe(paymentProfile.managerCodeHash);
      } else {
        expect(await read(finalName, 'permit2')).toBe(paymentProfile.permit2Address);
        expect(await read(finalName, 'permit2CodeHash')).toBe(paymentProfile.permit2CodeHash);
        expect(await read(finalName, 'x402UptoProxy')).toBe(paymentProfile.proxyAddress);
        expect(await read(finalName, 'x402UptoProxyCodeHash')).toBe(paymentProfile.proxyCodeHash);
      }
    } finally { await local.close(); }
  }, 120_000);
}

it('the actual CLI rejects local networks, missing and ambiguous profiles before RPC with sanitized phase output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-payment-cli-'));
  const path = join(directory, 'reviewed-profile.json');
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/prepare-platform-payment-deployment.ts', ...args],
      { cwd: projectRoot, windowsHide: true, env: { ...process.env,
        RPC_URL: 'http://127.0.0.1:1/NEVER_PRINT_PRIVATE_RPC_SENTINEL' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout = (stdout + String(value)).slice(-8192); });
    child.stderr.on('data', value => { stderr = (stderr + String(value)).slice(-8192); });
    child.once('error', reject); child.once('exit', code => done({ code, stdout, stderr }));
  });
  try {
    await writeFile(path, '{"schemaVersion":3,"schemaVersion":3}');
    for (const args of [['--network', 'local'], ['--network', 'base-mainnet'],
      ['--network', 'base-mainnet', '--public-profile', resolve(path)]]) {
      const result = await run(args);
      expect(result.code).toBe(1); expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({ status: 'platform_payment_deployment_plan_failed', phase: 'arguments' });
      expect(result.stderr).not.toContain('NEVER_PRINT');
    }
  } finally {
    // Only files created by this test are removed, using exact paths.
    await unlink(path); await rmdir(directory);
  }
}, 30_000);

it('rejects hostile public/local profiles, zero pins, missing or mismatched artifacts before any transaction', () => {
  const account = privateKeyToAccount(generatePrivateKey()).address;
  const spm = { kind: 'base_spend_permission_v1', managerAddress: SPEND_PERMISSION_MANAGER, managerCodeHash: hash };
  const cpu = { kind: 'x402_cpu_v1', permit2Address: CPU_PERMIT2, permit2CodeHash: hash,
    proxyAddress: CPU_UPTO_PROXY, proxyCodeHash: hash, tokenName: 'USD Coin', tokenVersion: '2' };
  const input = { chainId: 31337, referenceBlock: 1n, referenceHash: hash, tokenCodeHash: hash,
    firstNonce: 7n, roles: roles(account, account), artifacts, paymentProfile: spm };
  expect(() => buildPlatformPaymentDeploymentPlan({ ...input, paymentProfile: { ...spm, managerCodeHash: zeroHash } })).toThrow();
  expect(() => buildPlatformPaymentDeploymentPlan({ ...input, paymentProfile: { ...spm, managerAddress: zeroAddress } })).toThrow();
  expect(() => buildPlatformPaymentDeploymentPlan({ ...input, paymentProfile: { ...spm, fallback: 'v1' } })).toThrow();
  expect(() => buildPlatformPaymentDeploymentPlan({ ...input, chainId: 1 })).toThrow('network');
  expect(() => buildPlatformPaymentDeploymentPlan({ ...input, chainId: 8453,
    roles: roles(account, baseMainnetUsdc), paymentProfile: { ...spm, managerAddress: account } })).toThrow('Canonical');
  expect(() => buildPlatformPaymentDeploymentPlan({ ...input, chainId: 8453, paymentProfile: cpu,
    roles: roles(account, account) })).toThrow('canonical Base native USDC');
  for (const change of [{ permit2Address: account }, { proxyAddress: account }, { tokenName: 'USDC' },
    { tokenVersion: '1' }, { permit2CodeHash: zeroHash }, { proxyCodeHash: zeroHash }]) {
    expect(() => buildPlatformPaymentDeploymentPlan({ ...input, chainId: 8453,
      roles: roles(account, baseMainnetUsdc), paymentProfile: { ...cpu, ...change } })).toThrow();
  }
  expect(() => buildPlatformPaymentDeploymentPlan({ ...input, roles: { ...input.roles, guardian: zeroAddress } })).toThrow('nonzero');
  expect(() => buildPlatformPaymentDeploymentPlan({ ...input, referenceHash: zeroHash })).toThrow();
  expect(() => buildPlatformPaymentDeploymentPlan({ ...input, firstNonce: -1n })).toThrow('reference');
  expect(() => buildPlatformPaymentDeploymentPlan({ ...input, firstNonce: 2n ** 64n - 5n })).toThrow('reference nonce');
  expect(buildPlatformPaymentDeploymentPlan({ ...input, firstNonce: 2n ** 64n - 6n }).steps[4]!.nonce).toBe((2n ** 64n - 2n).toString());
  const { PlatformSpendPermissionEscrowV1: _removed, ...missing } = artifacts;
  expect(() => buildPlatformPaymentDeploymentPlan({ ...input, artifacts: missing })).toThrow('missing');
  expect(() => buildPlatformPaymentDeploymentPlan({ ...input, artifacts: { ...artifacts,
    PlatformSpendPermissionEscrowV1: artifact('PlatformRunEscrow') } })).toThrow('invalid');
  expect(() => buildPlatformPaymentDeploymentPlan({ ...input, artifacts: { ...artifacts,
    PlatformSpendPermissionEscrowV1: { ...artifact('PlatformSpendPermissionEscrowV1'), deployedBytecode: `0x${'00'.repeat(24_577)}` as Hex } } })).toThrow('EVM limits');
  expect(() => buildPlatformPaymentDeploymentPlan({ ...input, artifacts: { ...artifacts,
    SignerSet: { ...artifact('SignerSet'), bytecode: `0x${'00'.repeat(49_152)}` as Hex } } })).toThrow('initcode exceeds EVM limit');
  for (const [chainId, token, tokenName] of [[8453, baseMainnetUsdc, 'USD Coin'], [84532, baseSepoliaUsdc, 'USDC']] as const) {
    for (const paymentProfile of [spm, { ...cpu, tokenName }]) {
      const profile = { schemaVersion: 3, chainId, expectedTokenCodeHash: hash,
        implementationPins: { address: account, codeHash: hash }, roles: roles(account, token), paymentProfile };
      expect(publicPaymentDeploymentProfileSchema.parse(profile)).toMatchObject({ chainId, paymentProfile });
      expect(() => publicPaymentDeploymentProfileSchema.parse({ ...profile, roles: roles(account, account) })).toThrow();
      const plan = buildPlatformPaymentDeploymentPlan({ ...input, chainId, roles: profile.roles,
        implementationPins: profile.implementationPins, paymentProfile });
      expect(plan.reviewedAsset).toMatchObject({ kind: 'circle_proxy', address: token, name: tokenName });
      expect(plan.reviewStatus).toContain('no automatic provenance approval');
      expect(() => publicPaymentDeploymentProfileSchema.parse({ ...profile, implementationPins: undefined })).toThrow();
    }
  }
});

// Synthetic RPC transport verifies read-only public preflight boundaries; it is
// deliberately separate from the real official-bytecode Anvil deployments above.
const viewAbi = parseAbi(['function name() view returns(string)', 'function symbol() view returns(string)',
  'function version() view returns(string)', 'function decimals() view returns(uint8)',
  'function DOMAIN_SEPARATOR() view returns(bytes32)', 'function PERMIT2() view returns(address)',
  'function WITNESS_TYPE_STRING() view returns(string)', 'function SPEND_PERMISSION_TYPEHASH() view returns(bytes32)',
  'function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() view returns(bytes32)',
  'function eip712Domain() view returns(bytes1,string,string,uint256,address,bytes32,uint256[])']);
for (const kind of ['base_spend_permission_v1', 'x402_cpu_v1'] as const) {
  it(`fails closed on finalized reference, nonce, occupied address, asset and upstream changes for ${kind} without a sender`, async () => {
    const account = privateKeyToAccount(generatePrivateKey()).address;
    const implementation = privateKeyToAccount(generatePrivateKey()).address;
    const codes = { token: '0x6001', implementation: '0x6002', manager: '0x6003', permit: '0x6004', proxy: '0x6005' } as const;
    const paymentProfile: PaymentDeploymentProfile = kind === 'base_spend_permission_v1'
      ? { kind, managerAddress: SPEND_PERMISSION_MANAGER, managerCodeHash: keccak256(codes.manager) }
      : { kind, permit2Address: CPU_PERMIT2, permit2CodeHash: keccak256(codes.permit),
        proxyAddress: CPU_UPTO_PROXY, proxyCodeHash: keccak256(codes.proxy), tokenName: 'USD Coin', tokenVersion: '2' };
    const rawProfile = { schemaVersion: 3, chainId: 8453, expectedTokenCodeHash: keccak256(codes.token),
      implementationPins: { address: implementation, codeHash: keccak256(codes.implementation) },
      roles: roles(account, baseMainnetUsdc), paymentProfile };
    let bad = '';
    const advancedHash = `0x${'2'.repeat(64)}` as const;
    const requests: { method: string; params: unknown[] }[] = [];
    const client = createPublicClient({ chain: baseMainnet, cacheTime: 0, transport: custom({
      async request({ method, params }) {
        const args = z.array(z.unknown()).parse(params ?? []); requests.push({ method, params: args });
        if (method === 'eth_chainId') return bad === 'chain' ? '0x1' : '0x2105';
        if (method === 'eth_getBlockByNumber') {
          const advanced = ['finalizedAdvanced', 'originalReplaced', 'advancedOriginalToken'].includes(bad);
          const height = args[0] === 'finalized' ? advanced ? '0x2' : '0x1' : z.string().parse(args[0]);
          return { hash: bad === 'fork' && args[0] !== 'finalized' || bad === 'originalReplaced' && height === '0x1'
            ? zeroHash : height === '0x2' ? advancedHash : hash,
          number: height, timestamp: '0x60000000', transactions: [],
          gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x1', difficulty: '0x0', extraData: '0x',
          miner: zeroAddress, nonce: '0x0000000000000000', parentHash: zeroHash, sha3Uncles: zeroHash,
          receiptsRoot: zeroHash, stateRoot: zeroHash, transactionsRoot: zeroHash, logsBloom: '0x' + '00'.repeat(256),
          size: '0x1', uncles: [] };
        }
        if (method === 'eth_getTransactionCount') return bad === 'nonce' && args[1] === 'pending' ? '0x4' : '0x3';
        if (method === 'eth_getStorageAt') return bad === 'implementation' ? zeroHash : '0x' + '0'.repeat(24) + implementation.slice(2);
        if (method === 'eth_getCode') {
          const address = z.string().parse(args[0]).toLowerCase();
          if (address === baseMainnetUsdc.toLowerCase()) return bad === 'token'
            || bad === 'advancedOriginalToken' && z.object({ blockHash: z.string() }).parse(args.at(-1)).blockHash === hash
            ? '0x6009' : codes.token;
          if (address === implementation.toLowerCase()) return codes.implementation;
          if (address === SPEND_PERMISSION_MANAGER.toLowerCase()) return bad === 'upstreamCode' ? '0x6009' : codes.manager;
          if (address === CPU_PERMIT2.toLowerCase()) return codes.permit;
          if (address === CPU_UPTO_PROXY.toLowerCase()) return bad === 'upstreamCode' ? '0x6009' : codes.proxy;
          if (address === account.toLowerCase()) return bad === 'deployerCode' ? codes.token : '0x';
          return bad === 'occupied' ? codes.token : '0x';
        }
        if (method === 'eth_call') {
          const call = z.object({ to: z.string(), data: z.string().regex(/^0x/).transform(value => value as Hex) }).parse(args[0]);
          const decoded = decodeFunctionData({ abi: viewAbi, data: call.data });
          switch (decoded.functionName) {
            case 'name': return encodeFunctionResult({ abi: viewAbi, functionName: 'name', result: 'USD Coin' });
            case 'symbol': return encodeFunctionResult({ abi: viewAbi, functionName: 'symbol', result: 'USDC' });
            case 'version': return encodeFunctionResult({ abi: viewAbi, functionName: 'version', result: '2' });
            case 'decimals': return encodeFunctionResult({ abi: viewAbi, functionName: 'decimals', result: bad === 'decimals' ? 18 : 6 });
            case 'DOMAIN_SEPARATOR': return encodeFunctionResult({ abi: viewAbi, functionName: 'DOMAIN_SEPARATOR', result:
              bad === 'domain' ? zeroHash : domainSeparator({ domain: call.to.toLowerCase() === CPU_PERMIT2.toLowerCase()
                ? { name: 'Permit2', chainId: 8453, verifyingContract: CPU_PERMIT2 }
                : { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: baseMainnetUsdc } }) });
            case 'PERMIT2': return encodeFunctionResult({ abi: viewAbi, functionName: 'PERMIT2', result: bad === 'relationship' ? account : CPU_PERMIT2 });
            case 'WITNESS_TYPE_STRING': return encodeFunctionResult({ abi: viewAbi, functionName: 'WITNESS_TYPE_STRING', result:
              'Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,address facilitator,uint256 validAfter)' });
            case 'SPEND_PERMISSION_TYPEHASH': return encodeFunctionResult({ abi: viewAbi, functionName: 'SPEND_PERMISSION_TYPEHASH', result: SPEND_PERMISSION_TYPEHASH });
            case 'RECEIVE_WITH_AUTHORIZATION_TYPEHASH': return encodeFunctionResult({ abi: viewAbi,
              functionName: 'RECEIVE_WITH_AUTHORIZATION_TYPEHASH', result: keccak256(new TextEncoder().encode(
                'ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)')) });
            case 'eip712Domain': return encodeFunctionResult({ abi: viewAbi, functionName: 'eip712Domain', result:
              ['0x0f', 'Spend Permission Manager', bad === 'relationship' ? '2' : '1', 8453n, SPEND_PERMISSION_MANAGER, zeroHash, []] });
          }
        }
        throw new Error('Unexpected or write RPC method: ' + method);
      },
    }, { retryCount: 0 }) });
    const reference = await readPaymentDeploymentReference(client, rawProfile);
    const plan = buildPlatformPaymentDeploymentPlan({ chainId: 8453, referenceBlock: reference.block.number,
      referenceHash: reference.block.hash, firstNonce: reference.firstNonce, tokenCodeHash: rawProfile.expectedTokenCodeHash,
      roles: rawProfile.roles, artifacts, implementationPins: rawProfile.implementationPins, paymentProfile });
    await verifyPaymentDeploymentPlanState(client, rawProfile, plan, artifacts);
    for (const state of ['chain', 'fork', 'nonce', 'implementation', 'token', 'decimals', 'domain',
      'deployerCode', 'upstreamCode', 'relationship', 'occupied', 'originalReplaced', 'advancedOriginalToken']) {
      bad = state;
      await expect(verifyPaymentDeploymentPlanState(client, rawProfile, plan, artifacts)).rejects.toThrow();
    }
    bad = 'finalizedAdvanced';
    const beforeAdvance = requests.length;
    await expect(verifyPaymentDeploymentPlanState(client, rawProfile, plan, artifacts)).resolves.toBeUndefined();
    const advanceStates = requests.slice(beforeAdvance).filter(request => request.method === 'eth_getCode')
      .map(request => z.object({ blockHash: z.string() }).parse(request.params.at(-1)).blockHash);
    expect(advanceStates).toContain(hash); expect(advanceStates).toContain(advancedHash);
    bad = '';
    const changedPlan = { ...plan, tokenCodeHash: hash };
    await expect(verifyPaymentDeploymentPlanState(client, rawProfile, changedPlan, artifacts)).rejects.toThrow();
    const substitutedData = '0x60006000f3' as const;
    const substitutedPlan = platformPaymentDeploymentPlanSchema.parse({ ...plan,
      steps: plan.steps.map((step, index) => index === 4 ? { ...step, creationCodeHash: keccak256(substitutedData),
        transaction: { ...step.transaction, data: substitutedData } } : step) });
    await expect(verifyPaymentDeploymentPlanState(client, rawProfile, substitutedPlan, artifacts)).rejects.toThrow('trusted compiled');
    const detachedHash = platformPaymentDeploymentPlanSchema.parse({ ...plan,
      steps: plan.steps.map((step, index) => index === 4 ? { ...step, runtimeTemplateHash: hash, bytecodeHash: hash } : step) });
    await expect(verifyPaymentDeploymentPlanState(client, rawProfile, detachedHash, artifacts)).rejects.toThrow('trusted compiled');
    expect(requests.some(request => request.method.startsWith('eth_send') || request.method.startsWith('eth_sign'))).toBe(false);
    expect(requests.filter(request => request.method === 'eth_getBlockByNumber').some(request => request.params[0] === 'finalized')).toBe(true);
    const pinned = requests.filter(request => ['eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(request.method));
    for (const request of pinned) expect(request.params.at(-1)).toMatchObject({
      blockHash: expect.stringMatching(new RegExp('^(' + hash + '|' + advancedHash + ')$')), requireCanonical: true });
  }, 30_000);
}
