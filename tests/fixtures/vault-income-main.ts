import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import solc from 'solc';
import { keccak256, parseEther, type Abi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileContracts, projectRoot } from '../../scripts/compile-contracts.js';
import { unusedLocalPort } from '../../scripts/local-chain.js';
import { loadConfig } from '../../src/config.js';
import { vaultIncomeProfileSchema } from '../../src/payments/vault-income-configured.js';
import { deployPlatformRuntime } from './platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './platform-vault-runtime.js';

/** Disposable fixture permission setup; production only reads and verifies permissions. */
export async function secureVaultIncomeTestFile(path: string, content: string) {
  await writeFile(path, content, { mode: 0o600 });
  if (process.platform !== 'win32') { await chmod(path, 0o600); return; }
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p=$env:TELOMERE_VAULT_INCOME_TEST_FILE; $s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object System.Security.AccessControl.FileSecurity; $a.SetOwner($s); $a.SetAccessRuleProtection($true,$false); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','Allow'); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a; Write-Output 'secured'";
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['psmodulepath', 'telomere_vault_income_test_file'].includes(name.toLowerCase())));
  const result = await promisify(execFile)(resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...inherited, TELOMERE_VAULT_INCOME_TEST_FILE: path,
      PSModulePath: resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules') },
      windowsHide: true, timeout: 10_000, maxBuffer: 1024 });
  if (result.stdout.trim() !== 'secured') throw new Error('Disposable private file permission setup failed');
}

export async function deployVaultIncomeMainFixture() {
  const source = readFileSync(resolve(projectRoot, 'tests/fixtures/x402-reference/LocalEip3009Token.sol'), 'utf8');
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'LocalEip3009Token.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } }), {
    import: (path: string) => path.startsWith('@openzeppelin/contracts/') && !path.includes('..')
      ? { contents: readFileSync(resolve(projectRoot, 'node_modules', path), 'utf8') } : { error: 'Unsupported local dependency' },
  })) as { errors?: { severity: string }[]; contracts: Record<string, Record<string,
    { abi: Abi; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  if (output.errors?.some(value => value.severity === 'error')) throw new Error('Disposable EIP-3009 token compilation failed');
  const token = output.contracts['LocalEip3009Token.sol']?.LocalEip3009Token;
  if (!token) throw new Error('Disposable EIP-3009 token missing');
  const artifacts = compileContracts(['TelomereRunEscrow.sol', 'PlatformSelectionRegistry.sol', 'PlatformAgentVault.sol',
    'PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
  artifacts.MockToken = { contractName: 'LocalEip3009Token', compiler: solc.version(), abi: token.abi,
    bytecode: `0x${token.evm.bytecode.object}`, deployedBytecode: `0x${token.evm.deployedBytecode.object}` };
  artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
  const local = await deployPlatformRuntime(keccak256('0x1234'), artifacts);
  try {
    const vault = await deployPlatformVault(local), facilitatorKey = generatePrivateKey(), payer = privateKeyToAccount(generatePrivateKey());
    const facilitator = privateKeyToAccount(facilitatorKey);
    for (const account of [facilitator, payer]) await local.test.setBalance({ address: account.address, value: parseEther('10') });
    await local.confirmed(local.owner.writeContract({ address: local.pins.tokenAddress, abi: token.abi, functionName: 'faucet', args: [payer.address, 1_000_000n] }));
    const escrow = local.artifact('TelomereRunEscrow');
    const receipt = await local.confirmed(local.owner.deployContract({ abi: escrow.abi, bytecode: escrow.bytecode,
      args: [local.pins.tokenAddress, local.accounts.signer.address, local.accounts.signer.address, local.accounts.owner.address] }));
    if (!receipt.contractAddress) throw new Error('Disposable main escrow missing');
    await local.test.mine({ blocks: 3 });
    return { ...local, vault, facilitator, facilitatorKey, payer, legacyEscrow: receipt.contractAddress, agentId: vault.agentId as Hex };
  } catch (error) { await local.close(); throw error; }
}
export async function vaultIncomeMainConfig(fixture: Awaited<ReturnType<typeof deployVaultIncomeMainFixture>>, directory: string) {
  const port = await unusedLocalPort(), profilePath = resolve(directory, 'vault-income.json'), keyPath = resolve(directory, 'facilitator.key');
  const config = loadConfig({ MODE: 'demo', CHAIN_ID: '31337', RPC_URL: fixture.local.rpcUrl, DATA_DIR: resolve(directory, 'db'),
    ESCROW_ADDRESS: fixture.legacyEscrow, TOKEN_ADDRESS: fixture.pins.tokenAddress, SIGNER_PRIVATE_KEY: fixture.keys.signer,
    DEMO_PRIVATE_KEY: fixture.keys.owner, HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: 'http://127.0.0.1:' + port,
    CPU_MODE: 'demo', CYSTS_ENABLED: 'false', LOG_LEVEL: 'error', VAULT_INCOME_CONFIG: profilePath });
  const code = await fixture.local.publicClient.getCode({ address: fixture.pins.tokenAddress });
  if (!code) throw new Error('Disposable token code missing');
  const profile = vaultIncomeProfileSchema.parse({ pins: { chainId: 31337, asset: fixture.pins.tokenAddress, tokenCodeHash: keccak256(code),
    payTo: fixture.vault.agent.vault, facilitator: fixture.facilitator.address, reviewedTokenKind: 'immutable', confirmations: 1,
    exact: { reviewedEip3009: true, name: 'Local EIP3009 Fixture', version: '1' }, selection: { chainId: 31337,
      selectionRegistryAddress: fixture.vault.registryAddress, selectionRegistryCodeHash: fixture.vault.pins.registryCodeHash,
      vaultImplementationAddress: fixture.vault.implementationAddress, vaultImplementationCodeHash: fixture.vault.pins.implementationCodeHash,
      confirmations: 1 }, agentId: fixture.agentId, treasury: fixture.accounts.outsider.address }, facilitatorKeyFile: keyPath,
    resourceUrl: config.PUBLIC_ORIGIN + '/x402/vault-income', grossAmount: '101', localFixture: true });
  await secureVaultIncomeTestFile(keyPath, fixture.facilitatorKey);
  await secureVaultIncomeTestFile(profilePath, JSON.stringify(profile));
  return { config, profile, profilePath, keyPath };
}
