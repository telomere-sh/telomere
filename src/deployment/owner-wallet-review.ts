import { createHash } from 'node:crypto';
import { constants, lstatSync, readFileSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import solc from 'solc';
import { encodeDeployData, getContractAddress, keccak256, type PublicClient } from 'viem';
import type { ContractArtifact } from '../../scripts/compile-contracts.js';
import { legacyDeploymentPlanDigest } from '../../scripts/deployment-approval.js';
import { verifyReviewedBaseUsdc } from '../../scripts/base-usdc-deployment.js';
import { baseMainnetUsdc } from '../chain/chains.js';
import { incomeStrictJson } from '../selection/income-endpoints/json.js';
import { ownerWalletFeeBudget } from './owner-wallet-fees.js';
import { ownerWalletPlanSchema, ownerWalletReviewSchema, ownerWalletTrustSchema,
  type OwnerWalletPlan, type OwnerWalletReview, type OwnerWalletTrust } from './owner-wallet-types.js';

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
function requireFact(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
async function bounded(path: string, maximum: number): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  requireFact(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n
    && before.size <= BigInt(maximum), 'Deployment input must be a bounded single-link regular file');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await file.stat({ bigint: true }), data = await file.readFile(), after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    requireFact([actual, after, named].every(value => value.isFile() && value.nlink === 1n && value.dev === before.dev
      && value.ino === before.ino && value.size === before.size && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs)
      && data.length === Number(before.size), 'Deployment input changed while reading');
    return data;
  } finally { await file.close(); }
}
export interface FrozenOwnerWalletDeployment {
  readonly plan: OwnerWalletPlan;
  readonly trust: OwnerWalletTrust;
  assertUnchanged(): Promise<void>;
}

/** Pure validation: no wallet, provider, key or filesystem mutation. */
export function validateOwnerWalletPlan(raw: unknown, rawTrust: unknown, artifact: ContractArtifact): OwnerWalletPlan {
  const plan = ownerWalletPlanSchema.parse(raw), trust = ownerWalletTrustSchema.parse(rawTrust);
  requireFact(same(plan.transaction.from, trust.owner) && same(plan.quoteSigner, trust.signer)
    && same(plan.receiptSigner, trust.signer) && same(plan.treasury, trust.treasury)
    && !same(trust.signer, trust.owner), 'Deployment roles differ from the explicit owner and dedicated signer review');
  requireFact(same(plan.reviewedAsset.address, baseMainnetUsdc), 'Deployment requires native Base mainnet USDC');
  requireFact(same(legacyDeploymentPlanDigest(plan), plan.reviewDigest) && same(plan.reviewDigest, trust.reviewDigest),
    'Deployment review digest changed');
  requireFact(artifact.contractName === 'TelomereRunEscrow' && artifact.compiler === plan.compiler
    && same(keccak256(artifact.bytecode), plan.artifactBytecodeHash)
    && (artifact.deployedBytecode.length - 2) / 2 <= 24_576, 'Compiled deployment artifact changed');
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode,
    args: [baseMainnetUsdc, trust.signer, trust.signer, trust.treasury] });
  requireFact((data.length - 2) / 2 <= 49_152 && same(data, plan.transaction.data)
    && same(keccak256(data), plan.creationCodeHash), 'Deployment constructor or exact creation bytes changed');
  requireFact(same(getContractAddress({ from: trust.owner, nonce: BigInt(plan.transaction.nonce) }), plan.predictedEscrowAddress),
    'Deployment CREATE address changed');
  return freeze(plan);
}

/** Compile only the reviewed legacy source in memory. Unlike the ordinary build,
 * this helper never creates or replaces contracts/artifacts. */
export function compileOwnerWalletArtifact(projectDirectory: string): { artifact: ContractArtifact; inputs: ReadonlyMap<string, string> } {
  const root = resolve(projectDirectory), inputs = new Map<string, string>();
  function source(path: string): string {
    const meta = lstatSync(path);
    requireFact(meta.isFile() && !meta.isSymbolicLink() && meta.nlink === 1 && meta.size > 0 && meta.size <= 2_097_152,
      'Compiler input must be a bounded regular file');
    const data = readFileSync(path); inputs.set(path, sha(data)); return new TextDecoder('utf-8', { fatal: true }).decode(data);
  }
  const input = { language: 'Solidity', sources: { 'contracts/TelomereRunEscrow.sol': { content: source(join(root, 'contracts/TelomereRunEscrow.sol')) } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
  const output: unknown = JSON.parse(solc.compile(JSON.stringify(input), { import: name => {
    if (!name.startsWith('@openzeppelin/contracts/') || name.includes('..') || name.includes('\\')) return { error: 'Unsupported compiler import' };
    const target = resolve(root, 'node_modules', name), allowed = resolve(root, 'node_modules/@openzeppelin/contracts') + sep;
    if (!target.startsWith(allowed)) return { error: 'Unsupported compiler path' };
    try { return { contents: source(target) }; } catch { return { error: 'Compiler input unavailable' }; }
  } }));
  // REASON: solc JSON is inspected at the closed compiler boundary before its ABI/hex is used by viem.
  const parsed = output as { errors?: { severity: string }[]; contracts?: Record<string, Record<string,
    { abi: ContractArtifact['abi']; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  requireFact(!parsed.errors?.some(error => error.severity === 'error'), 'Legacy contract compilation failed');
  const result = parsed.contracts?.['contracts/TelomereRunEscrow.sol']?.TelomereRunEscrow;
  requireFact(result && Array.isArray(result.abi) && /^[a-fA-F0-9]+$/.test(result.evm.bytecode.object)
    && /^[a-fA-F0-9]+$/.test(result.evm.deployedBytecode.object), 'Legacy compiler artifact unavailable');
  inputs.set(join(root, 'package-lock.json'), sha(readFileSync(join(root, 'package-lock.json'))));
  return { artifact: { contractName: 'TelomereRunEscrow', compiler: solc.version(), abi: result.abi,
    bytecode: `0x${result.evm.bytecode.object}`, deployedBytecode: `0x${result.evm.deployedBytecode.object}` }, inputs };
}

export async function loadFrozenOwnerWalletDeployment(planPath: string, rawTrust: unknown, projectDirectory: string): Promise<FrozenOwnerWalletDeployment> {
  const trust = freeze(ownerWalletTrustSchema.parse(rawTrust)), absolute = resolve(planPath), bytes = await bounded(absolute, 131_072);
  requireFact(sha(bytes) === trust.planSha256, 'Frozen deployment plan file changed');
  const compiled = compileOwnerWalletArtifact(projectDirectory);
  const plan = validateOwnerWalletPlan(incomeStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), trust, compiled.artifact);
  return Object.freeze({ plan, trust, async assertUnchanged() {
    requireFact(sha(await bounded(absolute, 131_072)) === trust.planSha256, 'Frozen deployment plan file changed');
    for (const [path, hash] of compiled.inputs) requireFact(sha(await bounded(path, 2_097_152)) === hash, 'Frozen compiler input changed');
  } });
}

/** Read-only public RPC validation. No financial sender or signing port exists. */
export async function reviewOwnerWalletDeployment(frozen: FrozenOwnerWalletDeployment, client: PublicClient,
  nowMs = Date.now()): Promise<OwnerWalletReview> {
  await frozen.assertUnchanged();
  const { plan, trust } = frozen;
  requireFact(Number.isSafeInteger(nowMs) && nowMs > 0 && await client.getChainId() === 8453, 'Expected Base mainnet chain 8453');
  const original = await client.getBlock({ blockNumber: BigInt(plan.referenceBlock) });
  requireFact(same(original.hash, plan.referenceHash), 'Original reviewed block is no longer canonical');
  const { block } = await verifyReviewedBaseUsdc(client, 8453, plan.reviewedAsset.proxyCodeHash, plan.reviewedAsset.implementation);
  const state = { blockHash: block.hash, requireCanonical: true } as const;
  const [ownerCode, targetCode, pendingNonce, blockNonce, balance, fees] = await Promise.all([
    client.getCode({ address: trust.owner, ...state }), client.getCode({ address: plan.predictedEscrowAddress, ...state }),
    client.getTransactionCount({ address: trust.owner, blockTag: 'pending' }),
    client.getTransactionCount({ address: trust.owner, blockNumber: block.number }),
    client.getBalance({ address: trust.owner, blockNumber: block.number }), client.estimateFeesPerGas({ chain: null, type: 'eip1559' }),
  ]);
  requireFact((!ownerCode || ownerCode === '0x') && (!targetCode || targetCode === '0x'), 'Owner must remain an EOA and CREATE address must remain vacant');
  requireFact(pendingNonce === plan.transaction.nonce && blockNonce === plan.transaction.nonce, 'Owner nonce changed or has a pending transaction');
  let estimated: bigint, balanceOverrideUsed = false;
  try { estimated = await client.estimateGas({ account: trust.owner, data: plan.transaction.data, value: 0n, nonce: plan.transaction.nonce }); }
  catch (error) {
    if (balance !== 0n) throw error;
    estimated = await client.estimateGas({ account: trust.owner, data: plan.transaction.data, value: 0n, nonce: plan.transaction.nonce,
      stateOverride: [{ address: trust.owner, balance: 10n ** 18n }] });
    balanceOverrideUsed = true;
  }
  const limit = estimated * 120n / 100n + 1n, maxFee = fees.maxFeePerGas, priority = fees.maxPriorityFeePerGas;
  requireFact(estimated > 0n && limit <= BigInt(trust.maxGas) && typeof maxFee === 'bigint' && maxFee > 0n
    && maxFee <= BigInt(trust.maxFeePerGasWei) && typeof priority === 'bigint' && priority >= 0n && priority <= maxFee,
  'Fresh gas estimate exceeds the reviewed bounds');
  const feeBudget = await ownerWalletFeeBudget(client, state, plan, limit, maxFee, priority);
  requireFact(BigInt(feeBudget.totalGasBudgetWei) <= BigInt(trust.maxTotalGasBudgetWei), 'Fresh total Base fee estimate exceeds the reviewed budget');
  const [canonical, latestNonce, finalPending] = await Promise.all([
    client.getBlock({ blockNumber: block.number }), client.getTransactionCount({ address: trust.owner, blockTag: 'latest' }),
    client.getTransactionCount({ address: trust.owner, blockTag: 'pending' }),
  ]);
  requireFact(same(canonical.hash, block.hash) && latestNonce === plan.transaction.nonce && finalPending === plan.transaction.nonce,
    'Canonical snapshot or owner nonce changed during review');
  await frozen.assertUnchanged();
  return freeze(ownerWalletReviewSchema.parse({ schemaVersion: 1, status: !balanceOverrideUsed && balance >= BigInt(feeBudget.totalGasBudgetWei) ? 'ready_for_owner_wallet' : 'awaiting_base_eth',
    reviewedAtMs: nowMs, expiresAtMs: nowMs + 30_000, referenceBlock: block.number.toString(), referenceHash: block.hash,
    plan, trust, gas: { estimated: estimated.toString(), limit: limit.toString(), maxFeePerGasWei: maxFee.toString(),
      maxPriorityFeePerGasWei: priority.toString(), l2GasBudgetWei: (limit * maxFee).toString(), ...feeBudget,
      nativeBalanceWei: balance.toString(), balanceOverrideUsed }, transactionsSent: 0, ownerKeysLoaded: false }));
}
