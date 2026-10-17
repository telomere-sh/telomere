import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { buildPlatformPaymentDeploymentPlan, publicPaymentDeploymentProfileSchema } from '../src/deployment/platform-payment-plan.js';
import { readPaymentDeploymentReference, verifyPaymentDeploymentPlanState } from '../src/deployment/platform-payment-preflight.js';
import { incomeStrictJson } from '../src/selection/income-endpoints/json.js';
import { baseChainIdForNetwork, publicBaseClient, safeDeploymentRpcUrl } from './base-usdc-deployment.js';
import { compileContracts, projectRoot } from './compile-contracts.js';

// This separate version never imports a wallet, private key or transaction sender.
let phase = 'arguments';
try {
  const { values } = parseArgs({ options: { network: { type: 'string' }, 'public-profile': { type: 'string' } },
    strict: true, allowPositionals: false });
  const chainId = baseChainIdForNetwork(values.network);
  const path = z.string().min(1).max(4096).parse(values['public-profile']);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 2 || stat.size > 16_384) {
    throw new Error('Invalid public payment deployment profile file');
  }
  const profile = publicPaymentDeploymentProfileSchema.parse(incomeStrictJson(await readFile(path, 'utf8')));
  if (profile.chainId !== chainId) throw new Error('Reviewed network differs');
  phase = 'network';
  const client = publicBaseClient(chainId, safeDeploymentRpcUrl(chainId, process.env.RPC_URL));
  const { block, firstNonce } = await readPaymentDeploymentReference(client, profile);
  phase = 'artifacts';
  const finalSource = profile.paymentProfile.kind === 'base_spend_permission_v1'
    ? 'PlatformSpendPermissionEscrowV1.sol' : 'PlatformX402EscrowV1.sol';
  const artifacts = compileContracts(['ReceiptRoot.sol', 'HostRegistry.sol', 'FeeRouter.sol', 'PlatformRunEscrow.sol', finalSource]);
  const plan = buildPlatformPaymentDeploymentPlan({ chainId, referenceBlock: block.number, referenceHash: block.hash,
    tokenCodeHash: profile.expectedTokenCodeHash, firstNonce, roles: profile.roles, artifacts,
    implementationPins: profile.implementationPins, paymentProfile: profile.paymentProfile });
  phase = 'recheck';
  await verifyPaymentDeploymentPlanState(client, profile, plan, artifacts);
  phase = 'output';
  const directory = resolve(projectRoot, '.local');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || process.platform !== 'win32' && (directoryStat.mode & 0o077) !== 0) throw new Error('Private plan directory is unsafe');
  const suffix = chainId === 8453 ? 'base-mainnet' : 'base-sepolia';
  const output = resolve(directory, `platform-payment-deployment-v3-${profile.paymentProfile.kind}-${suffix}.json`);
  await writeFile(output, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: plan.status, schemaVersion: plan.schemaVersion,
    profile: profile.paymentProfile.kind, chainId, referenceBlock: plan.referenceBlock, firstNonce: plan.firstNonce,
    addresses: plan.addresses, output }) + '\n');
} catch {
  // Untrusted RPC/profile exceptions may contain private URLs; do not print their content.
  process.stderr.write(JSON.stringify({ status: 'platform_payment_deployment_plan_failed', phase }) + '\n');
  process.exitCode = 1;
}
