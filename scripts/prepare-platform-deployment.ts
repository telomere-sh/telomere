import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { platformDeploymentRolesSchema, buildPlatformDeploymentPlan } from '../src/deployment/platform-plan.js';
import { baseUsdcForChainId } from '../src/chain/chains.js';
import { baseChainIdForNetwork, hashSchema, implementationPinsSchema, publicBaseClient,
  safeDeploymentRpcUrl, verifyReviewedBaseUsdc } from './base-usdc-deployment.js';
import { compileContracts, projectRoot } from './compile-contracts.js';

// Read-only preparation. This process never imports a wallet, signing key or transaction sender.
const profileSchema = z.object({
  chainId: z.union([z.literal(8453), z.literal(84532)]),
  expectedTokenCodeHash: hashSchema,
  implementationPins: implementationPinsSchema,
  roles: platformDeploymentRolesSchema,
}).strict();
let phase = 'arguments';
try {
  const { values } = parseArgs({ options: { network: { type: 'string' }, 'public-profile': { type: 'string' } },
    strict: true, allowPositionals: false });
  const selectedChainId = baseChainIdForNetwork(values.network);
  const profilePath = z.string().min(1).max(4096).parse(values['public-profile']);
  const profileStat = await lstat(profilePath);
  if (!profileStat.isFile() || profileStat.isSymbolicLink() || profileStat.nlink !== 1
    || profileStat.size > 8192) throw new Error('Invalid public deployment profile');
  const profile = profileSchema.parse(JSON.parse(await readFile(profilePath, 'utf8')));
  if (profile.chainId !== selectedChainId || profile.roles.token.toLowerCase()
    !== baseUsdcForChainId(selectedChainId)!.toLowerCase()) {
    throw new Error('Selected Base network or Circle native USDC address differs from reviewed profile');
  }
  phase = 'network';
  const client = publicBaseClient(selectedChainId,
    safeDeploymentRpcUrl(selectedChainId, process.env.RPC_URL));
  const { block } = await verifyReviewedBaseUsdc(client, selectedChainId,
    profile.expectedTokenCodeHash, profile.implementationPins);
  const [deployerCode, pendingNonce, blockNonce] = await Promise.all([
    client.getCode({ address: profile.roles.deployer, blockHash: block.hash, requireCanonical: true }),
    client.getTransactionCount({ address: profile.roles.deployer, blockTag: 'pending' }),
    client.getTransactionCount({ address: profile.roles.deployer, blockNumber: block.number }),
  ]);
  if (deployerCode && deployerCode !== '0x' || pendingNonce !== blockNonce
    || (await client.getBlock({ blockNumber: block.number })).hash !== block.hash) {
    throw new Error('Deployer code, nonce or reference block differs from reviewed profile');
  }
  phase = 'artifacts';
  const artifacts = compileContracts(['ReceiptRoot.sol', 'HostRegistry.sol', 'FeeRouter.sol', 'PlatformRunEscrow.sol']);
  const plan = buildPlatformDeploymentPlan({ chainId: selectedChainId, referenceBlock: block.number,
    referenceHash: block.hash, tokenCodeHash: profile.expectedTokenCodeHash, firstNonce: BigInt(blockNonce),
    implementationPins: profile.implementationPins, roles: profile.roles, artifacts });
  const occupied = await Promise.all(plan.steps.map(step => client.getCode({ address: step.predictedAddress,
    blockHash: block.hash, requireCanonical: true })));
  if (occupied.some(value => value && value !== '0x')
    || (await client.getBlock({ blockNumber: block.number })).hash !== block.hash) {
    throw new Error('A predicted address is occupied or reference state changed');
  }
  phase = 'output';
  const directory = resolve(projectRoot, '.local');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || process.platform !== 'win32' && (directoryStat.mode & 0o077) !== 0) {
    throw new Error('Private plan directory is unsafe');
  }
  const suffix = selectedChainId === 8453 ? 'base-mainnet' : 'base-sepolia';
  const output = resolve(directory, `platform-deployment-plan-${suffix}.json`);
  await writeFile(output, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: plan.status, chainId: selectedChainId,
    referenceBlock: plan.referenceBlock, firstNonce: plan.firstNonce,
    addresses: plan.addresses, output }) + '\n');
} catch {
  // RPC/profile errors may contain private endpoint URLs. Never print them.
  process.stderr.write(JSON.stringify({ status: 'platform_deployment_plan_failed', phase }) + '\n');
  process.exitCode = 1;
}
