import solc from 'solc';
import { createWalletClient, http, keccak256, maxUint256, parseEther, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { localChain } from '../../src/chain/chains.js';
import type { ContractArtifact } from '../../scripts/compile-contracts.js';
import type { deployPlatformRuntime } from './platform-runtime.js';

type Fixture = Awaited<ReturnType<typeof deployPlatformRuntime>>;
export type VaultAgent = { owner: Address; agentWallet: Address; vault: Address; leashId: Hex; lifetimeBurn: bigint };

/** Disposable ERC721 ownerOf adapter. It deliberately makes no canonical ERC-8004 claim. */
export function platformVaultIdentityArtifact(): ContractArtifact {
  const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
contract PlatformRuntimeIdentityFixture {
  mapping(uint256 => address) public ownerOf;
  constructor() { require(block.chainid == 31337, "local fixture only"); }
  function register(uint256 id, address owner) external {
    require(owner != address(0) && ownerOf[id] == address(0), "fixture identity"); ownerOf[id] = owner;
  }
}`;
  // REASON: solc's untyped JSON boundary is narrowed to its declared output schema.
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'RuntimeIdentity.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } }))) as {
      errors?: { severity: string; formattedMessage: string }[];
      contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>>;
    };
  const errors = compiled.errors?.filter(value => value.severity === 'error') ?? [];
  if (errors.length) throw new Error(errors.map(value => value.formattedMessage).join('\n'));
  const value = compiled.contracts['RuntimeIdentity.sol']?.PlatformRuntimeIdentityFixture;
  if (!value) throw new Error('Disposable identity fixture did not compile');
  return { contractName: 'PlatformRuntimeIdentityFixture', compiler: solc.version(), abi: value.abi,
    bytecode: `0x${value.evm.bytecode.object}`, deployedBytecode: `0x${value.evm.deployedBytecode.object}` };
}

export async function deployPlatformVault(local: Fixture) {
  const account = privateKeyToAccount(generatePrivateKey()), guardian = privateKeyToAccount(generatePrivateKey());
  for (const item of [account, guardian]) await local.test.setBalance({ address: item.address, value: parseEther('10') });
  const wallet = createWalletClient({ account, chain: localChain, transport: http(local.local.rpcUrl, { retryCount: 0 }) });
  const guardianWallet = createWalletClient({ account: guardian, chain: localChain, transport: http(local.local.rpcUrl, { retryCount: 0 }) });
  async function deploy(name: string, args: readonly unknown[] = []): Promise<Address> {
    const artifact = local.artifact(name), receipt = await local.confirmed(local.owner.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args }));
    if (!receipt.contractAddress) throw new Error('Disposable vault fixture address missing'); return receipt.contractAddress;
  }
  async function write(address: Address, name: string, functionName: string, args: readonly unknown[] = []) {
    return local.confirmed(local.owner.writeContract({ address, abi: local.artifact(name).abi, functionName, args }));
  }
  const identity = await deploy('PlatformRuntimeIdentityFixture');
  const utility = await deploy('TlmrToken', [local.accounts.owner.address, parseEther('1000000')]);
  const staking = await deploy('TlmrStaking', [utility]);
  const registryAddress = await deploy('PlatformSelectionRegistry', [{ token: local.pins.tokenAddress, escrow: local.pins.escrowAddress,
    controller: local.accounts.signer.address, guardian: guardian.address, identityRegistry: identity,
    staking, treasury: local.accounts.outsider.address, entryFee: 100n, vaultFloor: 100n }]);
  await write(identity, 'PlatformRuntimeIdentityFixture', 'register', [1n, local.accounts.owner.address]);
  await write(local.pins.tokenAddress, 'MockToken', 'faucet', [local.accounts.owner.address, 1_000_100n]);
  await write(local.pins.tokenAddress, 'MockToken', 'approve', [registryAddress, maxUint256]);
  await write(registryAddress, 'PlatformSelectionRegistry', 'enter', [{ identityId: 1n, agentWallet: account.address,
    maxPerHour: 100_000n, maxPerDay: 1_000_000n, expiry: (await local.local.publicClient.getBlock()).timestamp + 86_400n,
    cystHash: `0x${'1'.repeat(64)}`, endowment: 1_000_000n,
    scope: { classMask: 1n, sealedOnly: false, imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}` } }]);
  const agentId = await local.local.publicClient.readContract({ address: registryAddress, abi: local.artifact('PlatformSelectionRegistry').abi,
    functionName: 'identityAgent', args: [1n] });
  // REASON: ABI is loaded from the real Solidity compilation, so viem cannot infer these dynamic output types.
  const agent = await local.local.publicClient.readContract({ address: registryAddress, abi: local.artifact('PlatformSelectionRegistry').abi,
    functionName: 'getAgent', args: [agentId] }) as VaultAgent;
  // REASON: The compiled factory getter returns an EVM address.
  const implementationAddress = await local.local.publicClient.readContract({ address: registryAddress,
    abi: local.artifact('PlatformSelectionRegistry').abi, functionName: 'vaultImplementation' }) as Address;
  const hash = async (address: Address) => {
    const code = await local.local.publicClient.getCode({ address }); if (!code) throw new Error('Disposable vault runtime code missing'); return keccak256(code);
  };
  return { account, wallet, guardianWallet, agentId, agent, registryAddress, implementationAddress,
    pins: { registryAddress, registryCodeHash: await hash(registryAddress), implementationAddress, implementationCodeHash: await hash(implementationAddress) } };
}
