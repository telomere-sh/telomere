import { domainSeparator, keccak256, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import type { ContractArtifact } from '../../scripts/compile-contracts.js';
import { baseUsdcForChainId } from '../chain/chains.js';
import { matchesCircleProxyPins, matchesNativeBaseUsdcMetadata } from '../payments/circle-usdc.js';
import { SPEND_PERMISSION_TYPEHASH } from '../payments/spend-permission-types.js';
import { buildPlatformPaymentDeploymentPlan, checkPaymentDeploymentProfile, publicPaymentDeploymentProfileSchema,
  platformPaymentDeploymentPlanSchema, type PlatformPaymentDeploymentPlan } from './platform-payment-plan.js';
import type { PublicPaymentDeploymentProfile } from './platform-payment-plan.js';

const managerAbi = parseAbi(['function SPEND_PERMISSION_TYPEHASH() view returns(bytes32)',
  'function eip712Domain() view returns(bytes1,string,string,uint256,address,bytes32,uint256[])']);
const proxyAbi = parseAbi(['function PERMIT2() view returns(address)', 'function WITNESS_TYPE_STRING() view returns(string)']);
const permitAbi = parseAbi(['function DOMAIN_SEPARATOR() view returns(bytes32)']);
const tokenAbi = parseAbi(['function decimals() view returns(uint8)', 'function name() view returns(string)',
  'function DOMAIN_SEPARATOR() view returns(bytes32)', 'function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() view returns(bytes32)']);
const witness = 'Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,address facilitator,uint256 validAfter)';
const receiveType = keccak256(new TextEncoder().encode('ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'));
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const nonemptyCode = (code: Hex | undefined, hash: Hex) => !!code && code !== '0x' && same(keccak256(code), hash);

/** Read-only upstream relationships at one exact state; chain31337 is only a test fixture. */
export async function verifyPaymentDeploymentDependencies(client: PublicClient, input: {
  chainId: number; token: Address; paymentProfile: unknown; blockHash: Hex;
}): Promise<void> {
  const profile = checkPaymentDeploymentProfile(input.chainId, input.paymentProfile);
  const state = { blockHash: input.blockHash, requireCanonical: true } as const;
  if (await client.getChainId() !== input.chainId) throw new Error('Payment deployment chain changed');
  if (input.chainId !== 31337 && !same(input.token, baseUsdcForChainId(input.chainId)!)) {
    throw new Error('Payment deployment requires canonical Base USDC');
  }
  if (await client.readContract({ address: input.token, abi: tokenAbi, functionName: 'decimals', ...state }) !== 6) {
    throw new Error('Payment deployment token decimals differ');
  }
  if (profile.kind === 'base_spend_permission_v1') {
    const [code, type, domain] = await Promise.all([
      client.getCode({ address: profile.managerAddress, ...state }),
      client.readContract({ address: profile.managerAddress, abi: managerAbi, functionName: 'SPEND_PERMISSION_TYPEHASH', ...state }),
      client.readContract({ address: profile.managerAddress, abi: managerAbi, functionName: 'eip712Domain', ...state }),
    ]);
    if (!nonemptyCode(code, profile.managerCodeHash) || type !== SPEND_PERMISSION_TYPEHASH || domain[0] !== '0x0f'
      || domain[1] !== 'Spend Permission Manager' || domain[2] !== '1' || domain[3] !== BigInt(input.chainId)
      || !same(domain[4], profile.managerAddress) || !/^0x0{64}$/i.test(domain[5]) || domain[6].length) {
      throw new Error('Reviewed Manager code, type or domain differs');
    }
  } else {
    const [permitCode, proxyCode, proxyPermit, proxyWitness, permitDomain, tokenDomain, tokenName, tokenType] = await Promise.all([
      client.getCode({ address: profile.permit2Address, ...state }), client.getCode({ address: profile.proxyAddress, ...state }),
      client.readContract({ address: profile.proxyAddress, abi: proxyAbi, functionName: 'PERMIT2', ...state }),
      client.readContract({ address: profile.proxyAddress, abi: proxyAbi, functionName: 'WITNESS_TYPE_STRING', ...state }),
      client.readContract({ address: profile.permit2Address, abi: permitAbi, functionName: 'DOMAIN_SEPARATOR', ...state }),
      client.readContract({ address: input.token, abi: tokenAbi, functionName: 'DOMAIN_SEPARATOR', ...state }),
      client.readContract({ address: input.token, abi: tokenAbi, functionName: 'name', ...state }),
      client.readContract({ address: input.token, abi: tokenAbi, functionName: 'RECEIVE_WITH_AUTHORIZATION_TYPEHASH', ...state }),
    ]);
    if (!nonemptyCode(permitCode, profile.permit2CodeHash) || !nonemptyCode(proxyCode, profile.proxyCodeHash)
      || !same(proxyPermit, profile.permit2Address) || proxyWitness !== witness || tokenType !== receiveType
      || tokenName !== profile.tokenName || permitDomain !== domainSeparator({ domain: { name: 'Permit2',
        chainId: input.chainId, verifyingContract: profile.permit2Address } })
      || tokenDomain !== domainSeparator({ domain: { name: profile.tokenName, version: profile.tokenVersion,
        chainId: input.chainId, verifyingContract: input.token } })) {
      throw new Error('Reviewed Permit2, proxy, witness or token domain differs');
    }
  }
}

async function verifyReviewedReferenceAt(client: PublicClient, profile: PublicPaymentDeploymentProfile,
  block: { number: bigint; hash: Hex }): Promise<bigint> {
  const state = { blockHash: block.hash, requireCanonical: true } as const;
  const [tokenCode, proxyMatches, metadataMatches, deployerCode, pendingNonce, blockNonce] = await Promise.all([
    client.getCode({ address: profile.roles.token, ...state }),
    matchesCircleProxyPins(client, profile.roles.token, profile.implementationPins, state),
    matchesNativeBaseUsdcMetadata(client, profile.chainId, profile.roles.token, state),
    client.getCode({ address: profile.roles.deployer, ...state }),
    client.getTransactionCount({ address: profile.roles.deployer, blockTag: 'pending' }),
    client.getTransactionCount({ address: profile.roles.deployer, blockNumber: block.number }),
  ]);
  if (!nonemptyCode(tokenCode, profile.expectedTokenCodeHash) || !proxyMatches || !metadataMatches
    || deployerCode && deployerCode !== '0x' || pendingNonce !== blockNonce) {
    throw new Error('Reviewed asset, deployer or nonce differs');
  }
  await verifyPaymentDeploymentDependencies(client, { chainId: profile.chainId, token: profile.roles.token,
    paymentProfile: profile.paymentProfile, blockHash: block.hash });
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('Finalized reference changed');
  return BigInt(blockNonce);
}

/** Public CLI boundary: explicit canonical native USDC and supplied upstream pins only. */
export async function readPaymentDeploymentReference(client: PublicClient, rawProfile: unknown) {
  const profile = publicPaymentDeploymentProfileSchema.parse(rawProfile);
  if (await client.getChainId() !== profile.chainId) throw new Error('Deployment RPC chain differs');
  // A finalized state is required; there is deliberately no latest/safe fallback.
  const block = await client.getBlock({ blockTag: 'finalized' });
  const firstNonce = await verifyReviewedReferenceAt(client, profile, block);
  return { profile, block, firstNonce };
}

/** Recheck immediately before saving; this function never sends a transaction. */
export async function verifyPaymentDeploymentPlanState(client: PublicClient, rawProfile: unknown,
  plan: PlatformPaymentDeploymentPlan, trustedArtifacts: Record<string, ContractArtifact>): Promise<void> {
  const checked = platformPaymentDeploymentPlanSchema.parse(plan);
  const reviewed = publicPaymentDeploymentProfileSchema.parse(rawProfile);
  // Structural schema hashes are declarations. Reconstruct from the caller's
  // trusted fresh compilation before treating any calldata/artifact label as bound.
  const expected = buildPlatformPaymentDeploymentPlan({ chainId: reviewed.chainId,
    referenceBlock: BigInt(checked.referenceBlock), referenceHash: checked.referenceHash,
    tokenCodeHash: reviewed.expectedTokenCodeHash, firstNonce: BigInt(checked.firstNonce),
    roles: reviewed.roles, implementationPins: reviewed.implementationPins,
    paymentProfile: reviewed.paymentProfile, artifacts: trustedArtifacts });
  if (JSON.stringify(checked) !== JSON.stringify(expected)) throw new Error('Payment plan differs from trusted compiled artifacts or profile');
  const { profile, block, firstNonce } = await readPaymentDeploymentReference(client, rawProfile);
  if (checked.chainId !== profile.chainId || checked.tokenCodeHash !== profile.expectedTokenCodeHash
    || JSON.stringify(checked.paymentProfile) !== JSON.stringify(profile.paymentProfile)
    || JSON.stringify(checked.roles) !== JSON.stringify(profile.roles)
    || checked.reviewedAsset.kind !== 'circle_proxy'
    || JSON.stringify(checked.reviewedAsset.implementation) !== JSON.stringify(profile.implementationPins)) {
    throw new Error('Payment plan differs from reviewed public profile');
  }
  const originalNumber = BigInt(checked.referenceBlock);
  const original = await client.getBlock({ blockNumber: originalNumber });
  // Normal finalized advancement is safe when the original anchor remains
  // canonical and the reviewed dependencies/nonce still agree at both states.
  if (block.number < originalNumber || original.hash !== checked.referenceHash || firstNonce.toString() !== checked.firstNonce
    || block.number === originalNumber && block.hash !== checked.referenceHash) {
    throw new Error('Payment plan original reference or nonce changed before save');
  }
  if (block.number !== originalNumber
    && (await verifyReviewedReferenceAt(client, profile, original)).toString() !== checked.firstNonce) {
    throw new Error('Payment plan original reference state differs');
  }
  const occupied = await Promise.all(plan.steps.map(step => client.getCode({ address: step.predictedAddress,
    blockHash: block.hash, requireCanonical: true })));
  if (occupied.some(code => code && code !== '0x') || (await client.getBlock({ blockNumber: block.number })).hash !== block.hash
    || (await client.getBlock({ blockNumber: originalNumber })).hash !== checked.referenceHash
    || BigInt(await client.getTransactionCount({ address: plan.deployer, blockTag: 'pending' })) !== firstNonce) {
    throw new Error('Payment deployment address occupied, nonce or reference changed');
  }
}
