import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import solc from 'solc';
import { createTestClient, createWalletClient, encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, http,
  keccak256, parseEther, zeroAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileContracts, type ContractArtifact } from '../../scripts/compile-contracts.js';
import { startLocalChain } from '../../scripts/local-chain.js';
import { localChain } from '../../src/chain/chains.js';
import { platformPinsSchema } from '../../src/platform-runtime/types.js';
import { typedSpendPermission, type SpendPermission } from '../../src/payments/spend-permissions.js';

export function compileSpendPermissionFixtures(): Record<string, ContractArtifact> {
  const artifacts = compileContracts(['PlatformSpendPermissionEscrowV1.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol']);
  // REASON: pinned, checked-in official compiler output uses the same artifact
  // schema as compileContracts; deployment installs its real constructor immutables.
  artifacts.SpendPermissionManager = JSON.parse(readFileSync(new URL('./spend-permissions/SpendPermissionManager.compiled.json', import.meta.url), 'utf8')) as ContractArtifact;
  const manager = artifacts.SpendPermissionManager;
  const referenceText = readFileSync(new URL('./spend-permissions/reference-input.json', import.meta.url), 'utf8');
  // REASON: retained solc input and provenance are test-only source artifacts;
  // every referenced source digest and the entire compiler output are checked.
  const reference = JSON.parse(referenceText) as { sources: Record<string, { content: string }> };
  const provenance = JSON.parse(readFileSync(new URL('./spend-permissions/provenance.json', import.meta.url), 'utf8')) as {
    compiler: string; files: Record<string, string> };
  for (const [path, digest] of Object.entries(provenance.files)) {
    const content = reference.sources[path]?.content;
    if (content === undefined || createHash('sha256').update(content).digest('hex') !== digest) throw new Error('Pinned official Manager source changed: ' + path);
  }
  // REASON: deterministic compiler output is checked against the reviewed
  // actual official artifact before any test deploys it.
  const rebuilt = JSON.parse(solc.compile(referenceText)) as { errors?: { severity: string }[]; contracts?: Record<string,
    Record<string, { abi: ContractArtifact['abi']; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  const upstream = rebuilt.contracts?.['src/SpendPermissionManager.sol']?.SpendPermissionManager;
  if (rebuilt.errors?.some(error => error.severity === 'error') || !upstream || manager.compiler !== solc.version()
    || provenance.compiler !== solc.version() || manager.bytecode !== '0x' + upstream.evm.bytecode.object
    || manager.deployedBytecode !== '0x' + upstream.evm.deployedBytecode.object || JSON.stringify(manager.abi) !== JSON.stringify(upstream.abi)) {
    throw new Error('Official SpendPermissionManager artifact differs from its pinned source compilation');
  }
  const name = 'TestSpendFundingAccount.sol';
  const input = { language: 'Solidity', sources: { [name]: { content: readFileSync(new URL('./spend-permissions/' + name, import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
  // REASON: solc JSON is inspected before conversion to the project's local artifact.
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as { errors?: { severity: string; formattedMessage: string }[];
    contracts?: Record<string, Record<string, { abi: ContractArtifact['abi']; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  const failures = output.errors?.filter(error => error.severity === 'error') ?? [];
  if (failures.length) throw new Error(failures.map(error => error.formattedMessage).join('\n'));
  const contract = output.contracts?.[name]?.TestSpendFundingAccount;
  if (!contract) throw new Error('Disposable account executor did not compile');
  artifacts.TestSpendFundingAccount = { contractName: 'TestSpendFundingAccount', compiler: solc.version(), abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`, deployedBytecode: `0x${contract.evm.deployedBytecode.object}` };
  return artifacts;
}

/** Real official Manager bytecode and distinct generated EOA/controller roles.
 * No existing escrow credit, public chain or production smart account is used. */
export async function deploySpendPermissionRuntime(hostKey: Hex, artifacts: Record<string, ContractArtifact>) {
  const local = await startLocalChain();
  const keys = { owner: generatePrivateKey(), signer: generatePrivateKey(), host: generatePrivateKey(), fundOwner: generatePrivateKey() };
  const accounts = { owner: privateKeyToAccount(keys.owner), signer: privateKeyToAccount(keys.signer),
    host: privateKeyToAccount(keys.host), fundOwner: privateKeyToAccount(keys.fundOwner) };
  const transport = http(local.rpcUrl, { retryCount: 0 });
  const test = createTestClient({ chain: localChain, mode: 'anvil', transport });
  for (const account of Object.values(accounts)) await test.setBalance({ address: account.address, value: parseEther('10') });
  const owner = createWalletClient({ account: accounts.owner, chain: localChain, transport });
  const host = createWalletClient({ account: accounts.host, chain: localChain, transport });
  const fundOwner = createWalletClient({ account: accounts.fundOwner, chain: localChain, transport });
  const artifact = (name: string) => { const value = artifacts[name]; if (!value) throw new Error('Missing spend-permission artifact: ' + name); return value; };
  const confirmed = async (hash: Promise<Hex>) => {
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await hash });
    if (receipt.status !== 'success') throw new Error('Disposable spend-permission transaction reverted'); return receipt;
  };
  const deploy = async (name: string, args: readonly unknown[] = []): Promise<Address> => {
    const value = artifact(name), receipt = await confirmed(owner.deployContract({ abi: value.abi, bytecode: value.bytecode, args }));
    if (!receipt.contractAddress) throw new Error('Spend-permission contract address missing'); return getAddress(receipt.contractAddress);
  };
  try {
    const tokenAddress = await deploy('MockToken');
    const signerSetAddress = await deploy('SignerSet', [accounts.owner.address, accounts.signer.address]);
    const receiptRootAddress = await deploy('ReceiptRoot', [signerSetAddress]);
    const manager = await deploy('SpendPermissionManager', [zeroAddress, zeroAddress]);
    const fundingAccount = await deploy('TestSpendFundingAccount', [accounts.fundOwner.address, manager]);
    const codeHash = async (address: Address) => { const code = await local.publicClient.getCode({ address }); if (!code) throw new Error('Runtime code missing'); return keccak256(code); };
    const managerCodeHash = await codeHash(manager);
    const nonce = await local.publicClient.getTransactionCount({ address: accounts.owner.address });
    const expectedEscrow = getContractAddress({ from: accounts.owner.address, nonce: BigInt(nonce + 2) });
    const hostRegistryAddress = await deploy('HostRegistry', [tokenAddress, expectedEscrow, accounts.owner.address, accounts.owner.address, receiptRootAddress]);
    const feeRouterAddress = await deploy('FeeRouter', [tokenAddress, expectedEscrow, accounts.owner.address, accounts.owner.address, accounts.owner.address, accounts.owner.address]);
    const escrowAddress = await deploy('PlatformSpendPermissionEscrowV1', [{ token: tokenAddress, quoteSigner: accounts.signer.address,
      receiptRoot: receiptRootAddress, hostRegistry: hostRegistryAddress, feeRouter: feeRouterAddress, guardian: accounts.owner.address }, manager, managerCodeHash]);
    if (escrowAddress.toLowerCase() !== expectedEscrow.toLowerCase()) throw new Error('Escrow prediction changed');
    await confirmed(owner.writeContract({ address: tokenAddress, abi: artifact('MockToken').abi, functionName: 'faucet', args: [accounts.host.address, 300_000_000n] }));
    await confirmed(host.writeContract({ address: tokenAddress, abi: artifact('MockToken').abi, functionName: 'approve', args: [hostRegistryAddress, 300_000_000n] }));
    await confirmed(host.writeContract({ address: hostRegistryAddress, abi: artifact('HostRegistry').abi, functionName: 'register', args: [hostKey, 0, `0x${'0'.repeat(64)}`, 300_000_000n, false] }));
    const hostId = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [31337n, hostRegistryAddress, accounts.host.address, hostKey]));
    await confirmed(owner.writeContract({ address: tokenAddress, abi: artifact('MockToken').abi, functionName: 'faucet', args: [fundingAccount, 100_000_000n] }));
    const pins = platformPinsSchema.parse({ chainId: 31337, escrowAddress, tokenAddress, tokenCodeHash: await codeHash(tokenAddress),
      reviewedTokenKind: 'immutable', quoteSigner: accounts.signer.address, receiptRootAddress, hostRegistryAddress, feeRouterAddress,
      escrowCodeHash: await codeHash(escrowAddress), receiptRootCodeHash: await codeHash(receiptRootAddress), hostRegistryCodeHash: await codeHash(hostRegistryAddress),
      feeRouterCodeHash: await codeHash(feeRouterAddress), spendPermissionProfile: { kind: 'base_spend_permission_v1', managerAddress: manager, managerCodeHash } });
    const permissionAction = async (action: 'approve' | 'revoke', permission: SpendPermission) => confirmed(fundOwner.writeContract({ address: fundingAccount,
      abi: artifact('TestSpendFundingAccount').abi, functionName: 'execute', args: [manager, 0n,
        encodeFunctionData({ abi: artifact('SpendPermissionManager').abi, functionName: action, args: [typedSpendPermission(permission)] })] }));
    return { local, test, accounts, keys, owner, host, fundOwner, pins, hostId, manager, managerCodeHash, fundingAccount, artifact, confirmed, deploy, permissionAction,
      async close() { await local.close(); } };
  } catch (error) { await local.close(); throw error; }
}
