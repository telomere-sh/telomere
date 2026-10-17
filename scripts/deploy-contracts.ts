import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { encodeDeployData, getAddress, getContractAddress, keccak256 } from 'viem';
import { z } from 'zod';
import { baseChainIdForNetwork, hashSchema, implementationPinsSchema, publicBaseClient,
  safeDeploymentRpcUrl, verifyReviewedBaseUsdc } from './base-usdc-deployment.js';
import { compileContracts, projectRoot } from './compile-contracts.js';
import { legacyDeploymentPlanDigest } from './deployment-approval.js';

// Legacy single-escrow plan, kept for compatibility. The Platform five-contract plan is prepared separately.
// This command only prepares unsigned bytes; it never imports a wallet or broadcasts.
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value => !/^0x0{40}$/i.test(value))
  .transform(value => getAddress(value));
const profileSchema = z.object({
  chainId: z.union([z.literal(8453), z.literal(84532)]),
  expectedTokenCodeHash: hashSchema,
  implementationPins: implementationPinsSchema,
  deployer: addressSchema, operator: addressSchema, receiptSigner: addressSchema, treasury: addressSchema,
}).strict();

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { network: { type: 'string' }, 'public-profile': { type: 'string' } },
    strict: true, allowPositionals: false });
  const chainId = baseChainIdForNetwork(values.network);
  const profilePath = z.string().min(1).max(4096).parse(values['public-profile']);
  const stat = await lstat(profilePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) {
    throw new Error('A regular bounded reviewed public profile is required');
  }
  const profile = profileSchema.parse(JSON.parse(await readFile(profilePath, 'utf8')));
  if (profile.chainId !== chainId) throw new Error('Chosen network differs from reviewed profile');
  const rpcUrl = safeDeploymentRpcUrl(chainId, process.env.RPC_URL);
  const client = publicBaseClient(chainId, rpcUrl);
  const { asset, block } = await verifyReviewedBaseUsdc(client, chainId,
    profile.expectedTokenCodeHash, profile.implementationPins);
  const [deployerCode, pendingNonce, blockNonce, gasPrice, nativeBalance, relayBalance] = await Promise.all([
    client.getCode({ address: profile.deployer, blockHash: block.hash, requireCanonical: true }),
    client.getTransactionCount({ address: profile.deployer, blockTag: 'pending' }),
    client.getTransactionCount({ address: profile.deployer, blockNumber: block.number }),
    client.getGasPrice(),
    client.getBalance({ address: profile.deployer, blockNumber: block.number }),
    client.getBalance({ address: profile.receiptSigner, blockNumber: block.number }),
  ]);
  if (deployerCode && deployerCode !== '0x' || pendingNonce !== blockNonce) {
    throw new Error('Deployment requires an EOA with a stable pending nonce');
  }
  const predictedEscrowAddress = getContractAddress({ from: profile.deployer, nonce: BigInt(pendingNonce) });
  const occupied = await client.getCode({ address: predictedEscrowAddress,
    blockHash: block.hash, requireCanonical: true });
  if (occupied && occupied !== '0x') throw new Error('Predicted escrow address is occupied');
  const artifact = compileContracts(['TelomereRunEscrow.sol']).TelomereRunEscrow;
  if (!artifact) throw new Error('Escrow artifact missing');
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode,
    args: [asset, profile.operator, profile.receiptSigner, profile.treasury] });
  let gas: bigint | undefined;
  let estimationMode = 'unmodified RPC estimate';
  try { gas = await client.estimateGas({ account: profile.deployer, data }); }
  catch {
    // Read-only balance override; it cannot credit the actual deployer.
    if (nativeBalance === 0n) {
      try {
        gas = await client.estimateGas({ account: profile.deployer, data,
          stateOverride: [{ address: profile.deployer, balance: 10n ** 18n }] });
        estimationMode = 'read-only balance override; deployer remains unfunded';
      } catch { estimationMode = 'unavailable; fund deployer and refresh'; }
    } else estimationMode = 'unavailable; inspect before signing';
  }
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) {
    throw new Error('Reference block changed during deployment preparation');
  }
  const gasLimit = gas === undefined ? null : gas * 120n / 100n + 1n;
  const bufferedCost = gasLimit === null ? null : gasLimit * gasPrice;
  const plan = { schemaVersion: 2, mode: 'unsigned-base-usdc-legacy-escrow', chainId,
    referenceBlock: block.number.toString(), referenceHash: block.hash,
    reviewedAsset: { kind: 'circle_proxy', address: asset, proxyCodeHash: profile.expectedTokenCodeHash,
      implementation: profile.implementationPins,
      name: chainId === 8453 ? 'USD Coin' : 'USDC', symbol: 'USDC', decimals: 6, version: '2' },
    quoteSigner: profile.operator, receiptSigner: profile.receiptSigner, treasury: profile.treasury,
    predictedEscrowAddress,
    compiler: artifact.compiler, creationCodeHash: keccak256(data), artifactBytecodeHash: keccak256(artifact.bytecode),
    transaction: { from: profile.deployer, to: null, data, value: '0', nonce: pendingNonce,
      gas: gasLimit?.toString() ?? null, gasPrice: gasPrice.toString() },
    estimate: { gas: gas?.toString() ?? null, mode: estimationMode, gasLimitBufferPercent: 20 },
    funding: { nativeBalance: nativeBalance.toString(), bufferedCost: bufferedCost?.toString() ?? null,
      sufficientForEstimate: bufferedCost !== null && nativeBalance >= bufferedCost,
      relayNativeBalance: relayBalance.toString() },
    status: 'prepared; no transaction submitted' };
  const reviewedPlan = { ...plan, reviewDigest: legacyDeploymentPlanDigest(plan) };
  const output = resolve(projectRoot, '.local', `deployment-plan-${values.network}.json`);
  await mkdir(resolve(projectRoot, '.local'), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(reviewedPlan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: plan.status, chainId, token: asset,
    estimatedGas: gas?.toString() ?? null, sufficientForEstimate: plan.funding.sufficientForEstimate,
    predictedEscrowAddress: plan.predictedEscrowAddress, reviewDigest: reviewedPlan.reviewDigest, output }) + '\n');
}

main().catch(() => {
  // RPC URLs may include provider credentials. Never echo caught errors or private profile contents.
  process.stderr.write(JSON.stringify({ status: 'deployment_plan_failed' }) + '\n');
  process.exitCode = 1;
});
