import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createWalletClient, encodeDeployData, getContractAddress, http, keccak256,
  parseTransaction, recoverTransactionAddress, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { bytes32Schema, addressSchema } from '../src/common.js';
import { baseUsdcForChainId, baseMainnet, baseSepolia } from '../src/chain/chains.js';
import { escrowAbi } from '../src/chain/abi.js';
import { baseChainIdForNetwork, publicBaseClient, safeDeploymentRpcUrl,
  verifyReviewedBaseUsdc } from './base-usdc-deployment.js';
import { compileContracts } from './compile-contracts.js';
import { legacyDeploymentPlanDigest } from './deployment-approval.js';

const envSchema = z.object({ DEPLOYER_PRIVATE_KEY: bytes32Schema, SIGNER_PRIVATE_KEY: bytes32Schema });
const planSchema = z.object({ schemaVersion: z.literal(2), chainId: z.union([z.literal(8453), z.literal(84532)]),
  referenceBlock: z.string().regex(/^\d+$/), referenceHash: bytes32Schema,
  quoteSigner: addressSchema, receiptSigner: addressSchema, treasury: addressSchema,
  creationCodeHash: bytes32Schema, predictedEscrowAddress: addressSchema, reviewDigest: bytes32Schema,
  reviewedAsset: z.object({ kind: z.literal('circle_proxy'), address: addressSchema, proxyCodeHash: bytes32Schema,
    implementation: z.object({ address: addressSchema, codeHash: bytes32Schema }),
    name: z.enum(['USD Coin', 'USDC']), symbol: z.literal('USDC'), decimals: z.literal(6), version: z.literal('2') }),
  transaction: z.object({ from: addressSchema, to: z.null(), value: z.literal('0'),
    data: z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/), nonce: z.number().int().nonnegative(),
    gas: z.string().regex(/^\d+$/) }),
});
const journalSchema = z.object({ raw: z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/), hash: bytes32Schema,
  creationCodeHash: bytes32Schema, reviewDigest: bytes32Schema }).strict();

/** Refuse a retained transaction if its signed bytes belong to any other reviewed plan. */
export async function assertDeploymentJournalMatchesPlan(journal: z.infer<typeof journalSchema>,
  plan: z.infer<typeof planSchema>, deployerAddress: `0x${string}`): Promise<void> {
  const raw = journal.raw as `0x${string}`;
  const decoded = parseTransaction(raw);
  if (journal.hash.toLowerCase() !== keccak256(raw).toLowerCase()
    || journal.reviewDigest.toLowerCase() !== plan.reviewDigest.toLowerCase()
    || journal.creationCodeHash.toLowerCase() !== plan.creationCodeHash.toLowerCase()
    || decoded.chainId !== plan.chainId || decoded.to || (decoded.value ?? 0n) !== 0n
    || decoded.data?.toLowerCase() !== plan.transaction.data.toLowerCase()
    || decoded.nonce !== plan.transaction.nonce || decoded.gas !== BigInt(plan.transaction.gas)
    || (await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })).toLowerCase()
      !== deployerAddress.toLowerCase()) throw new Error('Deployment journal differs from reviewed plan');
}

/** An explicit network and exact per-plan broadcast phrase are required even when keys are present. */
export async function submitDeployment(env: NodeJS.ProcessEnv, network: string | undefined): Promise<void> {
  const chainId = baseChainIdForNetwork(network);
  const rawPlan = JSON.parse(await readFile(`.local/deployment-plan-${network}.json`, 'utf8')) as Record<string, unknown>;
  const plan = planSchema.parse(rawPlan);
  if (legacyDeploymentPlanDigest(rawPlan).toLowerCase() !== plan.reviewDigest.toLowerCase()) {
    throw new Error('Deployment plan digest differs from its reviewed contents');
  }
  if (plan.chainId !== chainId || plan.reviewedAsset.address.toLowerCase()
    !== baseUsdcForChainId(chainId)!.toLowerCase()
    || plan.reviewedAsset.name !== (chainId === 8453 ? 'USD Coin' : 'USDC')) {
    throw new Error('Deployment plan is for another chain or token');
  }
  const approvalPhrase = `${chainId}:${plan.predictedEscrowAddress}:${plan.reviewDigest}`;
  if (env.TELOMERE_DEPLOY_BROADCAST !== approvalPhrase) {
    throw new Error('Public deployment broadcast is disabled until this exact plan is explicitly approved');
  }
  const config = envSchema.parse(env);
  const deployer = privateKeyToAccount(config.DEPLOYER_PRIVATE_KEY);
  const operator = privateKeyToAccount(config.SIGNER_PRIVATE_KEY);
  if (plan.transaction.from.toLowerCase() !== deployer.address.toLowerCase()
    || plan.quoteSigner.toLowerCase() !== operator.address.toLowerCase()
    || plan.receiptSigner.toLowerCase() !== operator.address.toLowerCase()) {
    throw new Error('Wallet keys differ from reviewed deployment roles');
  }
  if (getContractAddress({ from: deployer.address, nonce: BigInt(plan.transaction.nonce) }).toLowerCase()
    !== plan.predictedEscrowAddress.toLowerCase()) {
    throw new Error('Predicted deployment address does not match deployer nonce');
  }
  const artifact = compileContracts(['TelomereRunEscrow.sol']).TelomereRunEscrow;
  if (!artifact) throw new Error('Escrow artifact missing');
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode,
    args: [plan.reviewedAsset.address, plan.quoteSigner, plan.receiptSigner, plan.treasury] });
  if (keccak256(data).toLowerCase() !== plan.creationCodeHash.toLowerCase()
    || data.toLowerCase() !== plan.transaction.data.toLowerCase()) {
    throw new Error('Source or constructor changed; prepare a new deployment plan');
  }
  const rpcUrl = safeDeploymentRpcUrl(chainId, env.RPC_URL);
  const client = publicBaseClient(chainId, rpcUrl);
  if ((await client.getBlock({ blockNumber: BigInt(plan.referenceBlock) })).hash.toLowerCase()
    !== plan.referenceHash.toLowerCase()) throw new Error('Reviewed reference block is no longer canonical');
  await verifyReviewedBaseUsdc(client, chainId, plan.reviewedAsset.proxyCodeHash,
    plan.reviewedAsset.implementation);
  const wallet = createWalletClient({ chain: chainId === 8453 ? baseMainnet : baseSepolia,
    account: deployer, transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }) });
  const journalPath = `.local/deployment-transaction-${network}.json`;
  let journal: z.infer<typeof journalSchema> | undefined;
  try { journal = journalSchema.parse(JSON.parse(await readFile(journalPath, 'utf8'))); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (!journal) {
    if (await client.getTransactionCount({ address: deployer.address, blockTag: 'pending' }) !== plan.transaction.nonce) {
      throw new Error('Deployer nonce changed; prepare a new deployment plan');
    }
    const request = await wallet.prepareTransactionRequest({ data, nonce: plan.transaction.nonce,
      gas: BigInt(plan.transaction.gas) });
    const fee = request.maxFeePerGas ?? request.gasPrice;
    if (!fee || !request.gas) throw new Error('Unable to price deployment gas');
    if (await client.getBalance({ address: deployer.address }) < fee * request.gas) {
      throw new Error('Deployer requires Base ETH before this transaction can be submitted');
    }
    const raw = request.maxFeePerGas !== undefined && request.maxPriorityFeePerGas !== undefined
      ? await deployer.signTransaction({ type: 'eip1559', chainId, nonce: plan.transaction.nonce,
        gas: BigInt(plan.transaction.gas), data, maxFeePerGas: request.maxFeePerGas,
        maxPriorityFeePerGas: request.maxPriorityFeePerGas })
      : await deployer.signTransaction({ type: 'legacy', chainId, nonce: plan.transaction.nonce,
        gas: BigInt(plan.transaction.gas), data, gasPrice: request.gasPrice! });
    journal = { raw, hash: keccak256(raw), creationCodeHash: plan.creationCodeHash,
      reviewDigest: plan.reviewDigest };
    await writeFile(journalPath, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  // A journal may be replayed only for the entire reviewed plan and its exact signed creation bytes.
  const raw = journal.raw as `0x${string}`;
  await assertDeploymentJournalMatchesPlan(journal, plan, deployer.address);
  try { await client.sendRawTransaction({ serializedTransaction: raw }); }
  catch { /* A known or uncertain submission is resolved using the deterministic hash. */ }
  const receipt = await client.waitForTransactionReceipt({ hash: journal.hash, confirmations: 1, timeout: 60_000 });
  if (receipt.status !== 'success' || receipt.contractAddress?.toLowerCase()
    !== plan.predictedEscrowAddress.toLowerCase()) throw new Error('Deployment reverted or contract address differs');
  if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) {
    throw new Error('Deployment block is no longer canonical');
  }
  const token = await client.readContract({ address: receipt.contractAddress, abi: escrowAbi, functionName: 'token' });
  const signer = await client.readContract({ address: receipt.contractAddress, abi: escrowAbi,
    functionName: 'receiptSigner' });
  if (token.toLowerCase() !== plan.reviewedAsset.address.toLowerCase()
    || signer.toLowerCase() !== operator.address.toLowerCase()) throw new Error('Deployed contract roles do not match');
  const deployment = { chainId, escrowAddress: receipt.contractAddress, tokenAddress: token,
    operator: operator.address, transactionHash: journal.hash,
    blockNumber: receipt.blockNumber.toString(), checkedAt: new Date().toISOString(),
    status: 'deployed; acceptance still required' };
  await writeFile(`.local/deployment-${network}.json`, JSON.stringify(deployment, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify(deployment, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { network: { type: 'string' } }, strict: true, allowPositionals: false });
    await submitDeployment(process.env, values.network);
  } catch {
    process.stderr.write('Deployment submission failed. Review the selected plan, wallet and RPC.\n');
    process.exitCode = 1;
  }
}
