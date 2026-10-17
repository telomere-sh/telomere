import { encodeDeployData, getAddress, getContractAddress, keccak256, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { ContractArtifact } from '../../scripts/compile-contracts.js';
import { baseUsdcForChainId } from '../chain/chains.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => getAddress(value));
export const platformDeploymentRolesSchema = z.object({
  deployer: address, token: address, governance: address, initialReceiptSigner: address,
  quoteSigner: address, guardian: address, penaltyTreasury: address,
  workAllocator: address, treasury: address, stakers: address, buyAndBurn: address,
}).strict();
export type PlatformDeploymentRoles = z.output<typeof platformDeploymentRolesSchema>;

const contracts = ['SignerSet', 'ReceiptRoot', 'HostRegistry', 'FeeRouter', 'PlatformRunEscrow'] as const;
export type PlatformDeploymentContract = typeof contracts[number];
export type PlatformDeploymentStep = {
  contract: PlatformDeploymentContract; predictedAddress: Address; nonce: string;
  compiler: string; bytecodeHash: Hex; creationCodeHash: Hex;
  transaction: { from: Address; to: null; value: '0'; data: Hex; nonce: string };
};
export type PlatformDeploymentPlan = {
  schemaVersion: 2; chainId: 31337 | 8453 | 84532; referenceBlock: string; referenceHash: Hex;
  tokenCodeHash: Hex; deployer: Address; firstNonce: string;
  reviewedAsset: { kind: 'local_mock'; address: Address; codeHash: Hex } | {
    kind: 'circle_proxy'; address: Address; proxyCodeHash: Hex;
    implementation: { address: Address; codeHash: Hex };
    name: 'USD Coin' | 'USDC'; symbol: 'USDC'; decimals: 6; version: '2';
  };
  addresses: Record<PlatformDeploymentContract, Address>;
  roles: PlatformDeploymentRoles; steps: PlatformDeploymentStep[];
  status: 'unsigned; recheck nonce, roles and code before each submission';
};

/** Pure unsigned CREATE plan. No provider, key, wallet, or transaction sender is accepted. */
export function buildPlatformDeploymentPlan(input: {
  chainId: number; referenceBlock: bigint; referenceHash: Hex; tokenCodeHash: Hex;
  firstNonce: bigint; roles: unknown; artifacts: Record<string, ContractArtifact>;
  implementationPins?: { address: Address; codeHash: Hex };
}): PlatformDeploymentPlan {
  if (![31337, 8453, 84532].includes(input.chainId) || input.referenceBlock < 0n
    || input.firstNonce < 0n || !/^0x[0-9a-fA-F]{64}$/.test(input.referenceHash)
    || !/^0x[0-9a-fA-F]{64}$/.test(input.tokenCodeHash) || /^0x0{64}$/i.test(input.tokenCodeHash)) {
    throw new Error('Platform deployment reference or nonce is invalid');
  }
  const roles = platformDeploymentRolesSchema.parse(input.roles);
  if (Object.values(roles).some(value => /^0x0{40}$/i.test(value))) {
    throw new Error('Platform deployment roles must be explicit nonzero addresses');
  }
  const publicAsset = baseUsdcForChainId(input.chainId);
  let reviewedAsset: PlatformDeploymentPlan['reviewedAsset'];
  if (publicAsset) {
    if (roles.token.toLowerCase() !== publicAsset.toLowerCase()) {
      throw new Error('Platform deployment requires the canonical Base native USDC address');
    }
    const pins = input.implementationPins;
    if (!pins || !/^0x[0-9a-fA-F]{64}$/.test(pins.codeHash) || /^0x0{64}$/i.test(pins.codeHash)) {
      throw new Error('Platform deployment requires reviewed Circle proxy implementation pins');
    }
    const implementation = address.parse(pins.address);
    if (/^0x0{40}$/i.test(implementation)) {
      throw new Error('Platform deployment requires reviewed Circle proxy implementation pins');
    }
    reviewedAsset = { kind: 'circle_proxy', address: publicAsset,
      proxyCodeHash: input.tokenCodeHash, implementation: { address: implementation, codeHash: pins.codeHash },
      name: input.chainId === 8453 ? 'USD Coin' : 'USDC', symbol: 'USDC', decimals: 6, version: '2' };
  } else {
    if (input.implementationPins) throw new Error('Local mock token must not carry public implementation pins');
    reviewedAsset = { kind: 'local_mock', address: roles.token, codeHash: input.tokenCodeHash };
  }
  const addresses = Object.fromEntries(contracts.map((name, index) => [name,
    getContractAddress({ from: roles.deployer, nonce: input.firstNonce + BigInt(index) })])) as
    Record<PlatformDeploymentContract, Address>;
  const args: Record<PlatformDeploymentContract, readonly unknown[]> = {
    SignerSet: [roles.governance, roles.initialReceiptSigner],
    ReceiptRoot: [addresses.SignerSet],
    HostRegistry: [roles.token, addresses.PlatformRunEscrow, roles.guardian,
      roles.penaltyTreasury, addresses.ReceiptRoot],
    FeeRouter: [roles.token, addresses.PlatformRunEscrow, roles.workAllocator,
      roles.treasury, roles.stakers, roles.buyAndBurn],
    PlatformRunEscrow: [{ token: roles.token, quoteSigner: roles.quoteSigner,
      receiptRoot: addresses.ReceiptRoot, hostRegistry: addresses.HostRegistry,
      feeRouter: addresses.FeeRouter, guardian: roles.guardian }],
  };
  const steps = contracts.map((name, index): PlatformDeploymentStep => {
    const artifact = input.artifacts[name];
    if (!artifact || artifact.contractName !== name || !/^0x[0-9a-fA-F]+$/.test(artifact.bytecode)
      || artifact.bytecode.length < 4) throw new Error(`Platform deployment artifact ${name} is missing`);
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [...args[name]] });
    const nonce = (input.firstNonce + BigInt(index)).toString();
    return { contract: name, predictedAddress: addresses[name], nonce, compiler: artifact.compiler,
      bytecodeHash: keccak256(artifact.bytecode), creationCodeHash: keccak256(data),
      transaction: { from: roles.deployer, to: null, value: '0', data, nonce } };
  });
  return { schemaVersion: 2, chainId: input.chainId as 31337 | 8453 | 84532,
    referenceBlock: input.referenceBlock.toString(),
    referenceHash: input.referenceHash, tokenCodeHash: input.tokenCodeHash,
    reviewedAsset, deployer: roles.deployer, firstNonce: input.firstNonce.toString(), addresses, roles, steps,
    status: 'unsigned; recheck nonce, roles and code before each submission' };
}
