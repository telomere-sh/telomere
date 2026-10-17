import { keccak256, parseAbi, type Hex, type PublicClient } from 'viem';
import { sameAddress } from '../common.js';
import { platformFeeDiscountBpsSchema, type PlatformPins } from '../platform-runtime/types.js';

const abi = parseAbi(['function staking() view returns (address)', 'function token() view returns (address)',
  'function economicsVersion() view returns (uint16)', 'function decimals() view returns (uint8)',
  'function paymentToken() view returns (address)', 'function feeRouter() view returns (address)',
  'function feeRouterCodeHash() view returns (bytes32)', 'function stakers() view returns (address)',
  'function discountVaultRegistry() view returns (address)', 'function discountVaultRegistryCodeHash() view returns (bytes32)',
  'function escrow() view returns (address)',
  'function vaultImplementation() view returns (address)', 'function registry() view returns (address)',
  'function runDiscountBps(bytes32) view returns (uint16)']);

/** Historical immutable economics scope, independent of present token holdings. */
export async function checkPlatformEconomicsAt(client: PublicClient, pins: PlatformPins, blockHash: Hex): Promise<void> {
  const profile = pins.financialProfile;
  if (!profile) return;
  const state = { blockHash, requireCanonical: true } as const;
  for (const [address, expected] of [[profile.stakingAddress, profile.stakingCodeHash],
    [profile.utilityTokenAddress, profile.utilityTokenCodeHash]] as const) {
    const code = await client.getCode({ address, ...state });
    if (!code || code === '0x' || keccak256(code) !== expected) throw new Error('Economics-v2 utility or staking historical code pin changed');
  }
  const [staking, utilityToken, decimals, version, paymentToken, rewardRouter, rewardRouterHash, stakers] = await Promise.all([
    client.readContract({ address: pins.escrowAddress, abi, functionName: 'staking', ...state }),
    client.readContract({ address: profile.stakingAddress, abi, functionName: 'token', ...state }),
    client.readContract({ address: profile.utilityTokenAddress, abi, functionName: 'decimals', ...state }),
    client.readContract({ address: pins.feeRouterAddress, abi, functionName: 'economicsVersion', ...state }),
    client.readContract({ address: profile.stakingAddress, abi, functionName: 'paymentToken', ...state }),
    client.readContract({ address: profile.stakingAddress, abi, functionName: 'feeRouter', ...state }),
    client.readContract({ address: profile.stakingAddress, abi, functionName: 'feeRouterCodeHash', ...state }),
    client.readContract({ address: pins.feeRouterAddress, abi, functionName: 'stakers', ...state }),
  ]);
  if (!sameAddress(staking, profile.stakingAddress) || !sameAddress(utilityToken, profile.utilityTokenAddress)
    || decimals !== 18 || version !== 2 || !sameAddress(paymentToken, pins.tokenAddress)
    || !sameAddress(rewardRouter, pins.feeRouterAddress) || rewardRouterHash !== pins.feeRouterCodeHash
    || !sameAddress(stakers, profile.stakingAddress)) throw new Error('Economics-v2 historical deployment relationship differs');
  const [actualRegistry, actualRegistryHash] = await Promise.all([
    client.readContract({ address: pins.escrowAddress, abi, functionName: 'discountVaultRegistry', ...state }),
    client.readContract({ address: pins.escrowAddress, abi, functionName: 'discountVaultRegistryCodeHash', ...state }),
  ]);
  const configured = profile.discountVaultRegistry;
  if (!configured) {
    if (!sameAddress(actualRegistry, '0x0000000000000000000000000000000000000000')
      || actualRegistryHash !== `0x${'0'.repeat(64)}`) throw new Error('Economics-v2 unreviewed discount factory is configured');
  } else {
    const [code, registryToken, registryEscrow, implementation, implementationCode, implementationToken, implementationEscrow,
      implementationRegistry] = await Promise.all([
      client.getCode({ address: configured.address, ...state }),
      client.readContract({ address: configured.address, abi, functionName: 'token', ...state }),
      client.readContract({ address: configured.address, abi, functionName: 'escrow', ...state }),
      client.readContract({ address: configured.address, abi, functionName: 'vaultImplementation', ...state }),
      client.getCode({ address: configured.implementationAddress, ...state }),
      client.readContract({ address: configured.implementationAddress, abi, functionName: 'token', ...state }),
      client.readContract({ address: configured.implementationAddress, abi, functionName: 'escrow', ...state }),
      client.readContract({ address: configured.implementationAddress, abi, functionName: 'registry', ...state }),
    ]);
    if (!sameAddress(actualRegistry, configured.address) || actualRegistryHash !== configured.codeHash
      || !code || code === '0x' || keccak256(code) !== configured.codeHash
      || !sameAddress(registryToken, pins.tokenAddress) || !sameAddress(registryEscrow, pins.escrowAddress)
      || !sameAddress(implementation, configured.implementationAddress) || !implementationCode || implementationCode === '0x'
      || keccak256(implementationCode) !== configured.implementationCodeHash || !sameAddress(implementationToken, pins.tokenAddress)
      || !sameAddress(implementationEscrow, pins.escrowAddress) || !sameAddress(implementationRegistry, configured.address)) {
      throw new Error('Economics-v2 historical discount factory differs from reviewed pins');
    }
  }
}

export async function readPlatformFeeDiscount(client: PublicClient, pins: PlatformPins, runId: Hex, blockHash: Hex) {
  if (!pins.financialProfile) return 0;
  await checkPlatformEconomicsAt(client, pins, blockHash);
  return platformFeeDiscountBpsSchema.parse(await client.readContract({ address: pins.escrowAddress, abi,
    functionName: 'runDiscountBps', args: [runId], blockHash, requireCanonical: true }));
}
