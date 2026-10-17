import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeDeployData, keccak256, getContractAddress } from 'viem';
import { assertDeploymentJournalMatchesPlan, submitDeployment } from '../scripts/submit-deployment.js';
import { legacyDeploymentPlanDigest } from '../scripts/deployment-approval.js';
import { compileContracts } from '../scripts/compile-contracts.js';
import { startLocalChain } from '../scripts/local-chain.js';
import { baseSepoliaUsdc } from '../src/chain/chains.js';

describe('Base public deployment gates before signing or broadcast', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>;
  let proxy: Server;
  let proxyUrl: string;
  let chainId = 84532;
  let broadcasts = 0;
  const keys = { deployer: generatePrivateKey(), operator: generatePrivateKey(), treasury: generatePrivateKey() };
  const accounts = { deployer: privateKeyToAccount(keys.deployer), operator: privateKeyToAccount(keys.operator),
    treasury: privateKeyToAccount(keys.treasury) };
  const originalDirectory = process.cwd();
  let directory: string;
  let plan: Record<string, unknown>;
  beforeAll(async () => {
    local = await startLocalChain();
    proxy = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        void (async () => {
          const rpc = JSON.parse(body);
          if (rpc.method.startsWith('eth_send')) broadcasts++;
          if (rpc.method === 'eth_chainId') {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: '0x' + chainId.toString(16) }));
            return;
          }
          const result = await fetch(local.rpcUrl, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body });
          response.setHeader('Content-Type', 'application/json'); response.end(await result.text());
        })().catch(() => { response.statusCode = 500; response.end(); });
      });
    });
    await new Promise<void>(resolvePromise => proxy.listen(0, '127.0.0.1', resolvePromise));
    const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('Proxy unavailable');
    proxyUrl = 'http://127.0.0.1:' + address.port;
    await mkdir('.local', { recursive: true }); directory = await mkdtemp(resolve('.local/deploy-test-'));
    await mkdir(resolve(directory, '.local'));
    const artifact = compileContracts(['TelomereRunEscrow.sol']).TelomereRunEscrow;
    if (!artifact) throw new Error('Artifact missing');
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode,
      args: [baseSepoliaUsdc, accounts.operator.address, accounts.operator.address, accounts.treasury.address] });
    const block = await local.publicClient.getBlock();
    plan = { schemaVersion: 2, chainId: 84532, referenceBlock: block.number.toString(), referenceHash: block.hash,
      quoteSigner: accounts.operator.address, receiptSigner: accounts.operator.address,
      treasury: accounts.treasury.address,
      reviewedAsset: { kind: 'circle_proxy', address: baseSepoliaUsdc, proxyCodeHash: keccak256('0x6001'),
        implementation: { address: accounts.treasury.address, codeHash: keccak256('0x6002') },
        name: 'USDC', symbol: 'USDC', decimals: 6, version: '2' },
      predictedEscrowAddress: getContractAddress({ from: accounts.deployer.address, nonce: 0n }),
      creationCodeHash: keccak256(data),
      transaction: { from: accounts.deployer.address, to: null, value: '0', data, nonce: 0, gas: '3500000' } };
    plan.reviewDigest = legacyDeploymentPlanDigest(plan);
    await savePlan();
  });
  afterAll(async () => {
    process.chdir(originalDirectory);
    await new Promise<void>(resolvePromise => proxy?.close(() => resolvePromise())); await local?.close();
  });
  async function savePlan() {
    await writeFile(resolve(directory, '.local/deployment-plan-base-sepolia.json'), JSON.stringify(plan));
  }
  function approval() { return `84532:${plan.predictedEscrowAddress}:${plan.reviewDigest}`; }
  async function run(approvalValue: boolean | string = false, network = 'base-sepolia') {
    process.chdir(directory);
    try { await submitDeployment({ DEPLOYER_PRIVATE_KEY: keys.deployer, SIGNER_PRIVATE_KEY: keys.operator,
      RPC_URL: proxyUrl, ...(approvalValue ? { TELOMERE_DEPLOY_BROADCAST: typeof approvalValue === 'string' ? approvalValue : approval() } : {}) }, network); }
    finally { process.chdir(originalDirectory); }
  }
  it('requires an explicit network and exact per-plan broadcast phrase', async () => {
    await expect(run(false, '')).rejects.toThrow('Explicit --network');
    await expect(run()).rejects.toThrow('broadcast is disabled');
    expect(broadcasts).toBe(0);
    await expect(access(resolve(directory, '.local/deployment-transaction-base-sepolia.json'))).rejects.toThrow();
  });
  it('rejects old chain and noncanonical token before touching the RPC', async () => {
    const original = structuredClone(plan);
    plan.chainId = 46630; await savePlan();
    await expect(run(true)).rejects.toThrow();
    plan = structuredClone(original);
    (plan.reviewedAsset as Record<string, unknown>).address = accounts.treasury.address;
    plan.reviewDigest = legacyDeploymentPlanDigest(plan);
    await savePlan();
    await expect(run(true)).rejects.toThrow('another chain or token');
    plan = original; await savePlan();
    expect(broadcasts).toBe(0);
  });
  it('rejects stale approval when treasury and creation bytes change but CREATE address stays the same', async () => {
    const original = structuredClone(plan), staleApproval = approval();
    const treasury = privateKeyToAccount(generatePrivateKey()).address;
    const artifact = compileContracts(['TelomereRunEscrow.sol']).TelomereRunEscrow;
    if (!artifact) throw new Error('Artifact missing');
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode,
      args: [baseSepoliaUsdc, accounts.operator.address, accounts.operator.address, treasury] });
    plan.treasury = treasury;
    plan.creationCodeHash = keccak256(data);
    plan.transaction = { ...(plan.transaction as object), data };
    plan.reviewDigest = legacyDeploymentPlanDigest(plan);
    expect(plan.predictedEscrowAddress).toBe(original.predictedEscrowAddress);
    expect(plan.reviewDigest).not.toBe(original.reviewDigest);
    await savePlan();
    await expect(run(staleApproval)).rejects.toThrow('broadcast is disabled');
    expect(broadcasts).toBe(0);
    plan = original; await savePlan();
  });
  it('binds a retained signed journal to the same plan digest and exact creation bytes', async () => {
    const original = structuredClone(plan), transaction = plan.transaction as { data: `0x${string}` };
    const raw = await accounts.deployer.signTransaction({ type: 'eip1559', chainId: 84532, nonce: 0,
      gas: 3_500_000n, data: transaction.data, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    const journal = { raw, hash: keccak256(raw), creationCodeHash: plan.creationCodeHash,
      reviewDigest: plan.reviewDigest };
    await expect(assertDeploymentJournalMatchesPlan(journal as Parameters<typeof assertDeploymentJournalMatchesPlan>[0],
      plan as Parameters<typeof assertDeploymentJournalMatchesPlan>[1], accounts.deployer.address)).resolves.toBeUndefined();
    plan.treasury = privateKeyToAccount(generatePrivateKey()).address;
    plan.reviewDigest = legacyDeploymentPlanDigest(plan);
    await expect(assertDeploymentJournalMatchesPlan(journal as Parameters<typeof assertDeploymentJournalMatchesPlan>[0],
      plan as Parameters<typeof assertDeploymentJournalMatchesPlan>[1], accounts.deployer.address)).rejects.toThrow('journal differs');
    plan = original;
    const otherRaw = await accounts.deployer.signTransaction({ type: 'eip1559', chainId: 84532, nonce: 0,
      gas: 3_500_000n, data: '0x6000', maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    await expect(assertDeploymentJournalMatchesPlan({ ...journal, raw: otherRaw, hash: keccak256(otherRaw) } as Parameters<typeof assertDeploymentJournalMatchesPlan>[0],
      plan as Parameters<typeof assertDeploymentJournalMatchesPlan>[1], accounts.deployer.address)).rejects.toThrow('journal differs');
  });
  it('rejects RPC chain mismatch before any signature or broadcast', async () => {
    chainId = 1;
    await expect(run(true)).rejects.toThrow('RPC chain differs');
    expect(broadcasts).toBe(0);
    await expect(access(resolve(directory, '.local/deployment-transaction-base-sepolia.json'))).rejects.toThrow();
  });
});
