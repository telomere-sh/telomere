import { encodeDeployData, getAddress, getContractAddress, keccak256, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { ContractArtifact } from '../../scripts/compile-contracts.js';
import { baseUsdcForChainId } from '../chain/chains.js';
import { nativeBaseUsdcName } from '../payments/circle-usdc.js';
import { CPU_PERMIT2, CPU_UPTO_PROXY } from '../payments/cpu-reservation-types.js';
import { SPEND_PERMISSION_MANAGER } from '../payments/spend-permission-types.js';
import { buildPlatformDeploymentPlan, platformDeploymentRolesSchema, type PlatformDeploymentPlan } from './platform-plan.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value => !/^0x0{40}$/i.test(value))
  .transform(value => getAddress(value));
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).refine(value => !/^0x0{64}$/i.test(value))
  .transform(value => value.toLowerCase() as Hex);
const bytes = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).transform(value => value as Hex);
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/).max(78);
const implementation = z.object({ address, codeHash: hash }).strict();
export const paymentDeploymentProfileSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('base_spend_permission_v1'), managerAddress: address, managerCodeHash: hash }).strict(),
  z.object({ kind: z.literal('x402_cpu_v1'), permit2Address: address, permit2CodeHash: hash,
    proxyAddress: address, proxyCodeHash: hash, tokenName: z.string().min(1).max(100),
    tokenVersion: z.string().min(1).max(30) }).strict(),
]);
export type PaymentDeploymentProfile = z.infer<typeof paymentDeploymentProfileSchema>;
export const publicPaymentDeploymentProfileSchema = z.object({ schemaVersion: z.literal(3),
  chainId: z.union([z.literal(8453), z.literal(84532)]), expectedTokenCodeHash: hash,
  implementationPins: implementation, roles: platformDeploymentRolesSchema,
  paymentProfile: paymentDeploymentProfileSchema }).strict().superRefine((value, context) => {
  try {
    checkPaymentDeploymentProfile(value.chainId, value.paymentProfile);
    if (Object.values(value.roles).some(role => /^0x0{40}$/i.test(role))
      || value.roles.token.toLowerCase() !== baseUsdcForChainId(value.chainId)!.toLowerCase()) {
      throw new Error('Public roles or token differ');
    }
  }
  catch { context.addIssue({ code: 'custom', message: 'Unsupported public payment deployment profile' }); }
});
export type PublicPaymentDeploymentProfile = z.infer<typeof publicPaymentDeploymentProfileSchema>;

const commonNames = ['SignerSet', 'ReceiptRoot', 'HostRegistry', 'FeeRouter'] as const;
const finalNames = ['PlatformSpendPermissionEscrowV1', 'PlatformX402EscrowV1'] as const;
const contractName = z.enum([...commonNames, ...finalNames]);
const stepSchema = z.object({ contract: contractName, predictedAddress: address, nonce: uint,
  compiler: z.string().min(1).max(200), bytecodeHash: hash, creationCodeHash: hash,
  runtimeTemplateHash: hash, runtimeTemplateBytes: z.number().int().positive().max(24_576),
  transaction: z.object({ from: address, to: z.null(), value: z.literal('0'), data: bytes.refine(value =>
    (value.length - 2) / 2 <= 49_152, 'Payment deployment initcode exceeds EVM limit'), nonce: uint }).strict() }).strict();
const commonAddresses = { SignerSet: address, ReceiptRoot: address, HostRegistry: address, FeeRouter: address };
const assetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local_mock'), address, codeHash: hash }).strict(),
  z.object({ kind: z.literal('circle_proxy'), address, proxyCodeHash: hash, implementation,
    name: z.enum(['USD Coin', 'USDC']), symbol: z.literal('USDC'), decimals: z.literal(6), version: z.literal('2') }).strict(),
]);
export const platformPaymentDeploymentPlanSchema = z.object({ schemaVersion: z.literal(3),
  chainId: z.union([z.literal(31337), z.literal(8453), z.literal(84532)]), referenceBlock: uint,
  referenceHash: hash, tokenCodeHash: hash, deployer: address, firstNonce: uint,
  reviewedAsset: assetSchema, roles: platformDeploymentRolesSchema, paymentProfile: paymentDeploymentProfileSchema,
  quoteDomain: z.object({ name: z.literal('TelomerePlatformEscrow'), version: z.enum(['3', '4']),
    chainId: z.number().int(), verifyingContract: address }).strict(),
  addresses: z.union([z.object({ ...commonAddresses, PlatformSpendPermissionEscrowV1: address }).strict(),
    z.object({ ...commonAddresses, PlatformX402EscrowV1: address }).strict()]),
  steps: z.array(stepSchema).length(5),
  reviewStatus: z.literal('operator_supplied_pins; no automatic provenance approval'),
  status: z.literal('unsigned; recheck nonce, roles and code before each submission'),
}).strict().superRefine((value, context) => {
  const final = value.paymentProfile.kind === 'base_spend_permission_v1' ? finalNames[0] : finalNames[1];
  const addresses: Partial<Record<z.infer<typeof contractName>, Address>> = value.addresses;
  const expected = [...commonNames, final];
  let profileValid = false;
  try { checkPaymentDeploymentProfile(value.chainId, value.paymentProfile); profileValid = true; } catch { /* Schema issue below. */ }
  const asset = value.reviewedAsset;
  const assetValid = asset.address === value.roles.token && (value.chainId === 31337
    ? asset.kind === 'local_mock' && asset.codeHash === value.tokenCodeHash
    : asset.kind === 'circle_proxy' && asset.proxyCodeHash === value.tokenCodeHash
      && asset.name === nativeBaseUsdcName(value.chainId)
      && asset.address.toLowerCase() === baseUsdcForChainId(value.chainId)!.toLowerCase());
  const valid = profileValid && assetValid && value.deployer === value.roles.deployer
    && Object.values(value.roles).every(role => !/^0x0{40}$/i.test(role))
    && BigInt(value.firstNonce) <= 2n ** 64n - 6n
    && value.quoteDomain.version === (final === finalNames[0] ? '3' : '4')
    && value.quoteDomain.chainId === value.chainId && value.quoteDomain.verifyingContract === addresses[final]
    && value.steps.every((step, index) => step.contract === expected[index]
      && step.predictedAddress === addresses[step.contract]
      && step.predictedAddress === getContractAddress({ from: value.deployer, nonce: BigInt(value.firstNonce) + BigInt(index) })
      && step.nonce === (BigInt(value.firstNonce) + BigInt(index)).toString()
      && step.transaction.nonce === step.nonce && step.transaction.from === value.deployer
      && keccak256(step.transaction.data) === step.creationCodeHash);
  if (!valid) context.addIssue({ code: 'custom', message: 'Payment plan domain, steps or addresses disagree' });
});
export type PlatformPaymentDeploymentPlan = z.infer<typeof platformPaymentDeploymentPlanSchema>;

/** Pure profile validation. Local addresses are accepted only for explicit chain31337 fixtures. */
export function checkPaymentDeploymentProfile(chainId: number, raw: unknown): PaymentDeploymentProfile {
  const profile = paymentDeploymentProfileSchema.parse(raw);
  if (![31337, 8453, 84532].includes(chainId)) throw new Error('Unsupported payment deployment network');
  if (chainId !== 31337) {
    const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
    if (profile.kind === 'base_spend_permission_v1') {
      if (!same(profile.managerAddress, SPEND_PERMISSION_MANAGER)) throw new Error('Canonical Base SpendPermissionManager is required');
    } else if (!same(profile.permit2Address, CPU_PERMIT2) || !same(profile.proxyAddress, CPU_UPTO_PROXY)
      || profile.tokenName !== nativeBaseUsdcName(chainId) || profile.tokenVersion !== '2') {
      throw new Error('Canonical Permit2, Upto proxy and Base USDC domain are required');
    }
  }
  return profile;
}

function checkedArtifact(artifacts: Record<string, ContractArtifact>, name: string): ContractArtifact {
  const artifact = artifacts[name];
  if (!artifact || artifact.contractName !== name || !artifact.compiler || !Array.isArray(artifact.abi)
    || !bytes.safeParse(artifact.bytecode).success || !bytes.safeParse(artifact.deployedBytecode).success
    || artifact.bytecode.length < 4 || artifact.deployedBytecode.length < 4
    || (artifact.deployedBytecode.length - 2) / 2 > 24_576 || (artifact.bytecode.length - 2) / 2 > 49_152) {
    throw new Error('Payment deployment artifact is missing, invalid or exceeds EVM limits: ' + name);
  }
  return artifact;
}

/** Version3 is separate from historical v1 deployment plans. No provider or sender is accepted. */
export function buildPlatformPaymentDeploymentPlan(input: {
  chainId: number; referenceBlock: bigint; referenceHash: Hex; tokenCodeHash: Hex; firstNonce: bigint;
  roles: unknown; artifacts: Record<string, ContractArtifact>; implementationPins?: { address: Address; codeHash: Hex };
  paymentProfile: unknown;
}): PlatformPaymentDeploymentPlan {
  if (input.firstNonce < 0n || input.firstNonce > 2n ** 64n - 6n) throw new Error('Payment deployment reference nonce is invalid');
  const profile = checkPaymentDeploymentProfile(input.chainId, input.paymentProfile);
  const final = profile.kind === 'base_spend_permission_v1' ? finalNames[0] : finalNames[1];
  for (const name of [...commonNames, final]) checkedArtifact(input.artifacts, name);
  // Reuse the reviewed reference/asset/roles/CREATE calculations and first four exact transactions.
  // The historical fifth step is discarded; its alias is never present in the new serialized plan.
  const baseline: PlatformDeploymentPlan = buildPlatformDeploymentPlan(input);
  const { PlatformRunEscrow: escrow, ...addresses } = baseline.addresses;
  const config = { token: baseline.roles.token, quoteSigner: baseline.roles.quoteSigner,
    receiptRoot: addresses.ReceiptRoot, hostRegistry: addresses.HostRegistry,
    feeRouter: addresses.FeeRouter, guardian: baseline.roles.guardian };
  const artifact = checkedArtifact(input.artifacts, final);
  const args = profile.kind === 'base_spend_permission_v1'
    ? [config, profile.managerAddress, profile.managerCodeHash]
    : [config, profile.permit2Address, profile.permit2CodeHash, profile.proxyAddress, profile.proxyCodeHash];
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  if ((data.length - 2) / 2 > 49_152) throw new Error('Payment deployment initcode exceeds EVM limit');
  const nonce = (input.firstNonce + 4n).toString();
  const runtime = (value: ContractArtifact) => ({ runtimeTemplateHash: keccak256(value.deployedBytecode),
    runtimeTemplateBytes: (value.deployedBytecode.length - 2) / 2 });
  const steps = [...baseline.steps.slice(0, 4).map(step => ({ ...step,
    ...runtime(checkedArtifact(input.artifacts, step.contract)) })),
  { contract: final, predictedAddress: escrow, nonce, compiler: artifact.compiler,
    bytecodeHash: keccak256(artifact.bytecode), creationCodeHash: keccak256(data), ...runtime(artifact),
    transaction: { from: baseline.deployer, to: null, value: '0', data, nonce } }];
  return platformPaymentDeploymentPlanSchema.parse({ ...baseline, schemaVersion: 3,
    addresses: { ...addresses, [final]: escrow }, paymentProfile: profile, steps,
    quoteDomain: { name: 'TelomerePlatformEscrow', version: profile.kind === 'base_spend_permission_v1' ? '3' : '4',
      chainId: baseline.chainId, verifyingContract: escrow },
    reviewStatus: 'operator_supplied_pins; no automatic provenance approval' });
}
