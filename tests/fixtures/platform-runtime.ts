import { createTestClient, createWalletClient, encodeAbiParameters, getContractAddress, http, keccak256, parseEther,
  type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileContracts, type ContractArtifact } from '../../scripts/compile-contracts.js';
import { startLocalChain } from '../../scripts/local-chain.js';
import { localChain } from '../../src/chain/chains.js';
import type { PlatformPins } from '../../src/platform-runtime/types.js';

/** Disposable generated accounts and real contracts; never a public-network deployment. */
export async function deployPlatformRuntime(hostKey: Hex, suppliedArtifacts?: Record<string, ContractArtifact>) {
  const artifacts = suppliedArtifacts ?? compileContracts();
  const local = await startLocalChain();
  const keys = { owner: generatePrivateKey(), signer: generatePrivateKey(), host: generatePrivateKey(), outsider: generatePrivateKey() };
  const accounts = { owner: privateKeyToAccount(keys.owner), signer: privateKeyToAccount(keys.signer),
    host: privateKeyToAccount(keys.host), outsider: privateKeyToAccount(keys.outsider) };
  const transport = http(local.rpcUrl, { retryCount: 0 });
  const test = createTestClient({ chain: localChain, mode: 'anvil', transport });
  for (const account of Object.values(accounts)) await test.setBalance({ address: account.address, value: parseEther('10') });
  const owner = createWalletClient({ account: accounts.owner, chain: localChain, transport });
  const host = createWalletClient({ account: accounts.host, chain: localChain, transport });
  const artifact = (name: string) => { const value = artifacts[name]; if (!value) throw new Error('Missing local platform artifact'); return value; };
  const confirmed = async (hash: Promise<Hex>) => {
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await hash });
    if (receipt.status !== 'success') throw new Error('Disposable platform transaction reverted'); return receipt;
  };
  const deploy = async (name: string, args: readonly unknown[] = []): Promise<Address> => {
    const value = artifact(name), receipt = await confirmed(owner.deployContract({ abi: value.abi, bytecode: value.bytecode, args }));
    if (!receipt.contractAddress) throw new Error('Local platform deployment address missing'); return receipt.contractAddress;
  };
  try {
    const tokenAddress = await deploy('MockToken');
    const signerSetAddress = await deploy('SignerSet', [accounts.owner.address, accounts.signer.address]);
    const receiptRootAddress = await deploy('ReceiptRoot', [signerSetAddress]);
    const next = await local.publicClient.getTransactionCount({ address: accounts.owner.address });
    const expectedEscrow = getContractAddress({ from: accounts.owner.address, nonce: BigInt(next + 2) });
    const hostRegistryAddress = await deploy('HostRegistry', [tokenAddress, expectedEscrow, accounts.owner.address, accounts.owner.address, receiptRootAddress]);
    const feeRouterAddress = await deploy('FeeRouter', [tokenAddress, expectedEscrow, accounts.owner.address,
      accounts.owner.address, accounts.owner.address, accounts.owner.address]);
    const escrowAddress = await deploy('PlatformRunEscrow', [{ token: tokenAddress, quoteSigner: accounts.signer.address,
      receiptRoot: receiptRootAddress, hostRegistry: hostRegistryAddress, feeRouter: feeRouterAddress, guardian: accounts.owner.address }]);
    if (escrowAddress.toLowerCase() !== expectedEscrow.toLowerCase()) throw new Error('Local platform address prediction changed');
    await confirmed(owner.writeContract({ address: tokenAddress, abi: artifact('MockToken').abi, functionName: 'faucet', args: [accounts.host.address, 300_000_000n] }));
    await confirmed(host.writeContract({ address: tokenAddress, abi: artifact('MockToken').abi, functionName: 'approve', args: [hostRegistryAddress, 300_000_000n] }));
    await confirmed(host.writeContract({ address: hostRegistryAddress, abi: artifact('HostRegistry').abi, functionName: 'register',
      args: [hostKey, 0, `0x${'0'.repeat(64)}`, 300_000_000n, false] }));
    const hostId = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
      [31337n, hostRegistryAddress, accounts.host.address, hostKey]));
    await confirmed(owner.writeContract({ address: tokenAddress, abi: artifact('MockToken').abi, functionName: 'faucet', args: [accounts.owner.address, 1_000_000n] }));
    await confirmed(owner.writeContract({ address: tokenAddress, abi: artifact('MockToken').abi, functionName: 'approve', args: [escrowAddress, 1_000_000n] }));
    await confirmed(owner.writeContract({ address: escrowAddress, abi: artifact('PlatformRunEscrow').abi, functionName: 'deposit', args: [1_000_000n] }));
    const codeHash = async (address: Address) => { const code = await local.publicClient.getCode({ address }); if (!code) throw new Error('Local runtime code missing'); return keccak256(code); };
    const pins: PlatformPins = { chainId: 31337, escrowAddress, tokenAddress, tokenCodeHash: await codeHash(tokenAddress),
      reviewedTokenKind: 'immutable', quoteSigner: accounts.signer.address,
      receiptRootAddress, hostRegistryAddress, feeRouterAddress, escrowCodeHash: await codeHash(escrowAddress),
      receiptRootCodeHash: await codeHash(receiptRootAddress), hostRegistryCodeHash: await codeHash(hostRegistryAddress), feeRouterCodeHash: await codeHash(feeRouterAddress) };
    return { local, artifacts, keys, accounts, owner, host, pins, hostId, test, confirmed, artifact,
      async close() { await local.close(); } };
  } catch (error) { await local.close(); throw error; }
}
