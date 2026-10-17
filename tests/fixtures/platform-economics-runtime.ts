import { createTestClient, createWalletClient, getContractAddress, http, keccak256, maxUint256, parseEther,
  type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startLocalChain } from '../../scripts/local-chain.js';
import type { ContractArtifact } from '../../scripts/compile-contracts.js';
import { localChain } from '../../src/chain/chains.js';
import { platformPinsSchema } from '../../src/platform-runtime/types.js';

/** Actual local economics deployment, preserving the existing Vault fixture's interface. */
export async function deployPlatformEconomicsRuntime(hostKeys: readonly [Hex, Hex], artifacts: Record<string, ContractArtifact>) {
  const local = await startLocalChain();
  const keys = { owner: generatePrivateKey(), signer: generatePrivateKey(), host: generatePrivateKey(), outsider: generatePrivateKey() };
  const accounts = { owner: privateKeyToAccount(keys.owner), signer: privateKeyToAccount(keys.signer),
    host: privateKeyToAccount(keys.host), outsider: privateKeyToAccount(keys.outsider) };
  const transport = http(local.rpcUrl, { retryCount: 0 });
  const test = createTestClient({ chain: localChain, mode: 'anvil', transport });
  const wallet = (account: typeof accounts.owner) => createWalletClient({ account, chain: localChain, transport });
  const owner = wallet(accounts.owner), host = wallet(accounts.host), signer = wallet(accounts.signer), secondHost = wallet(accounts.outsider);
  const artifact = (name: string) => { const value = artifacts[name]; if (!value) throw new Error('Missing economics fixture artifact ' + name); return value; };
  const confirmed = async (hash: Promise<Hex>) => {
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await hash });
    if (receipt.status !== 'success') throw new Error('Economics fixture transaction reverted'); return receipt;
  };
  const deploy = async (name: string, args: readonly unknown[] = []): Promise<Address> => {
    const code = artifact(name), receipt = await confirmed(owner.deployContract({ abi: code.abi, bytecode: code.bytecode, args }));
    if (!receipt.contractAddress) throw new Error('Economics fixture deployment missing'); return receipt.contractAddress;
  };
  const write = (address: Address, name: string, functionName: string, args: readonly unknown[] = [], sender = owner) =>
    confirmed(sender.writeContract({ address, abi: artifact(name).abi, functionName, args }));
  const codeHash = async (address: Address) => {
    const code = await local.publicClient.getCode({ address }); if (!code || code === '0x') throw new Error('Economics fixture code missing');
    return keccak256(code);
  };
  try {
    for (const account of Object.values(accounts)) await test.setBalance({ address: account.address, value: parseEther('10') });
    const tokenAddress = await deploy('MockToken');
    const utility = await deploy('TlmrBurnableToken', [accounts.signer.address, parseEther('1000000')]);
    const signerSetAddress = await deploy('SignerSet', [accounts.owner.address, accounts.signer.address]);
    const receiptRootAddress = await deploy('ReceiptRoot', [signerSetAddress]);
    const dex = await deploy('TestReviewedV3Router');
    const next = BigInt(await local.publicClient.getTransactionCount({ address: accounts.owner.address }));
    const predictedStaking = getContractAddress({ from: accounts.owner.address, nonce: next + 2n });
    const predictedBurner = getContractAddress({ from: accounts.owner.address, nonce: next + 3n });
    const predictedEscrow = getContractAddress({ from: accounts.owner.address, nonce: next + 4n });
    const hostRegistryAddress = await deploy('HostRegistry', [tokenAddress, predictedEscrow, accounts.owner.address, accounts.owner.address, receiptRootAddress]);
    const feeRouterAddress = await deploy('FeeRouterEconomicsV2', [tokenAddress, predictedEscrow, accounts.owner.address, accounts.owner.address, predictedStaking, predictedBurner]);
    const feeRouterCodeHash = await codeHash(feeRouterAddress);
    const staking = await deploy('TlmrRewardStaking', [utility, tokenAddress, feeRouterAddress, feeRouterCodeHash]);
    const burner = await deploy('TlmrBuyAndBurn', [{ paymentToken: tokenAddress, utilityToken: utility, feeRouter: feeRouterAddress,
      feeRouterCodeHash, swapRouter: dex, swapRouterCodeHash: await codeHash(dex), quoteSigner: accounts.signer.address,
      poolFee: 3000, maxPerSwap: 1000n, maxPerWeek: 2000n, maxQuoteLifetime: 300n }]);
    const escrowAddress = await deploy('PlatformRunEscrowEconomicsV2', [{ token: tokenAddress, quoteSigner: accounts.signer.address,
      receiptRoot: receiptRootAddress, hostRegistry: hostRegistryAddress, feeRouter: feeRouterAddress, guardian: accounts.owner.address }, staking]);
    if (staking.toLowerCase() !== predictedStaking.toLowerCase() || burner.toLowerCase() !== predictedBurner.toLowerCase()
      || escrowAddress.toLowerCase() !== predictedEscrow.toLowerCase()) throw new Error('Economics fixture predicted relations changed');
    const hostIds: Hex[] = [];
    for (const [index, sender] of [host, secondHost].entries()) {
      const hostKey = hostKeys[index]; if (!hostKey) throw new Error('Missing economics HostKit key');
      await write(tokenAddress, 'MockToken', 'faucet', [sender.account.address, 300_000_000n]);
      await write(tokenAddress, 'MockToken', 'approve', [hostRegistryAddress, maxUint256], sender);
      await write(hostRegistryAddress, 'HostRegistry', 'register', [hostKey, 0, `0x${'0'.repeat(64)}`, 300_000_000n, false], sender);
      // REASON: Dynamic ABI originates from actual contract compilation; operatorHost returns bytes32.
      hostIds.push(await local.publicClient.readContract({ address: hostRegistryAddress, abi: artifact('HostRegistry').abi,
        functionName: 'operatorHost', args: [sender.account.address] }) as Hex);
    }
    await write(tokenAddress, 'MockToken', 'faucet', [accounts.owner.address, 1_000_000n]);
    await write(tokenAddress, 'MockToken', 'approve', [escrowAddress, maxUint256]);
    await write(escrowAddress, 'PlatformRunEscrowEconomicsV2', 'deposit', [1_000_000n]);
    for (const account of [accounts.owner, accounts.host]) await write(utility, 'TlmrBurnableToken', 'transfer', [account.address, parseEther('1000')], signer);
    const pins = platformPinsSchema.parse({ chainId: 31337, escrowAddress, tokenAddress, quoteSigner: accounts.signer.address,
      receiptRootAddress, hostRegistryAddress, feeRouterAddress, reviewedTokenKind: 'immutable', tokenCodeHash: await codeHash(tokenAddress),
      escrowCodeHash: await codeHash(escrowAddress), receiptRootCodeHash: await codeHash(receiptRootAddress),
      hostRegistryCodeHash: await codeHash(hostRegistryAddress), feeRouterCodeHash,
      financialProfile: { kind: 'tlmr_economics_v2', stakingAddress: staking, stakingCodeHash: await codeHash(staking),
        utilityTokenAddress: utility, utilityTokenCodeHash: await codeHash(utility) } });
    const hostId = hostIds[0], secondHostId = hostIds[1]; if (!hostId || !secondHostId) throw new Error('Missing registered economics hosts');
    return { local, artifacts, keys, accounts, owner, host, signer, secondHost, pins, hostId, secondHostId, test, confirmed, artifact,
      utility, staking, burner, dex, write, codeHash, async close() { await local.close(); } };
  } catch (error) { await local.close(); throw error; }
}
