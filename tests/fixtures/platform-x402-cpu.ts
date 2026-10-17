import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import solc from 'solc';
import { createTestClient, createWalletClient, encodeAbiParameters, getContractAddress, http, keccak256, parseEther,
  type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileContracts, projectRoot, type ContractArtifact } from '../../scripts/compile-contracts.js';
import { startLocalChain } from '../../scripts/local-chain.js';
import { localChain } from '../../src/chain/chains.js';
import { platformPinsSchema, type PlatformPins } from '../../src/platform-runtime/types.js';


export function compileX402CpuFixtures(): Record<string, ContractArtifact> {
  const artifacts=compileContracts(['PlatformX402EscrowV1.sol','HostRegistry.sol','ReceiptRoot.sol','FeeRouter.sol']);
  const root=resolve(projectRoot,'tests/fixtures/x402-reference');
  const provenance=JSON.parse(readFileSync(resolve(root,'provenance.json'),'utf8')) as {files:{path:string;sha256:string}[];compiled:{path:string;sha256:string}};
  for(const file of [...provenance.files,provenance.compiled]) if(createHash('sha256').update(readFileSync(resolve(root,file.path))).digest('hex')!==file.sha256) throw new Error('Official x402 fixture changed: '+file.path);
  const permit=JSON.parse(readFileSync(resolve(root,provenance.compiled.path),'utf8')) as ContractArtifact;
  artifacts.Permit2=permit;
  const names=['x402/contracts/evm/src/x402UptoPermit2Proxy.sol','LocalReceiveToken.sol'];
  const input={language:'Solidity',sources:Object.fromEntries(names.map(name=>[name,{content:readFileSync(name==='LocalReceiveToken.sol'?resolve(projectRoot,'tests/fixtures/x402-cpu',name):resolve(root,name),'utf8')}])),settings:{optimizer:{enabled:true,runs:200},evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
  const output=JSON.parse(solc.compile(JSON.stringify(input),{import:(name:string)=>{
    if(name.includes('..')) return {error:'Unsupported import'};
    if(name.startsWith('@openzeppelin/contracts/')) return {contents:readFileSync(resolve(projectRoot,'node_modules',name),'utf8')};
    if(name.startsWith('x402/contracts/evm/src/')) return {contents:readFileSync(resolve(root,name),'utf8')};
    return {error:'Unsupported import'};
  }})) as {errors?:{severity:string;formattedMessage:string}[];contracts?:Record<string,Record<string,{abi:ContractArtifact['abi'];evm:{bytecode:{object:string};deployedBytecode:{object:string}}}>>};
  const failures=output.errors?.filter(row=>row.severity==='error')??[];
  if(failures.length) throw new Error(failures.map(row=>row.formattedMessage).join('\n'));
  for(const name of names) for(const [contractName,value] of Object.entries(output.contracts?.[name]??{})) artifacts[contractName]={contractName,compiler:solc.version(),abi:value.abi,bytecode:`0x${value.evm.bytecode.object}`,deployedBytecode:`0x${value.evm.deployedBytecode.object}`};
  return artifacts;
}

/** Disposable generated accounts and real contracts; never a public-network deployment. */
export async function deployX402CpuRuntime(hostKey: Hex, suppliedArtifacts?: Record<string, ContractArtifact>) {
  const artifacts = suppliedArtifacts ?? compileX402CpuFixtures();
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
    const tokenAddress = await deploy('LocalReceiveToken');
    const signerSetAddress = await deploy('SignerSet', [accounts.owner.address, accounts.signer.address]);
    const receiptRootAddress = await deploy('ReceiptRoot', [signerSetAddress]);
    const permit2 = await deploy('Permit2');
    const proxy = await deploy('x402UptoPermit2Proxy',[permit2]);
    const codeHash = async (address: Address) => { const code = await local.publicClient.getCode({ address }); if (!code) throw new Error('Runtime code missing'); return keccak256(code); };
    const permit2CodeHash=await codeHash(permit2), proxyCodeHash=await codeHash(proxy);
    const next = await local.publicClient.getTransactionCount({ address: accounts.owner.address });
    const expectedEscrow = getContractAddress({ from: accounts.owner.address, nonce: BigInt(next + 2) });
    const hostRegistryAddress = await deploy('HostRegistry', [tokenAddress, expectedEscrow, accounts.owner.address, accounts.owner.address, receiptRootAddress]);
    const feeRouterAddress = await deploy('FeeRouter', [tokenAddress, expectedEscrow, accounts.owner.address,
      accounts.owner.address, accounts.owner.address, accounts.owner.address]);
    const escrowAddress = await deploy('PlatformX402EscrowV1', [{ token: tokenAddress, quoteSigner: accounts.signer.address,
      receiptRoot: receiptRootAddress, hostRegistry: hostRegistryAddress, feeRouter: feeRouterAddress, guardian: accounts.owner.address },permit2,permit2CodeHash,proxy,proxyCodeHash]);
    if (escrowAddress.toLowerCase() !== expectedEscrow.toLowerCase()) throw new Error('Local platform address prediction changed');
    await confirmed(owner.writeContract({ address: tokenAddress, abi: artifact('LocalReceiveToken').abi, functionName: 'faucet', args: [accounts.host.address, 300_000_000n] }));
    await confirmed(host.writeContract({ address: tokenAddress, abi: artifact('LocalReceiveToken').abi, functionName: 'approve', args: [hostRegistryAddress, 300_000_000n] }));
    await confirmed(host.writeContract({ address: hostRegistryAddress, abi: artifact('HostRegistry').abi, functionName: 'register',
      args: [hostKey, 0, `0x${'0'.repeat(64)}`, 300_000_000n, false] }));
    const hostId = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
      [31337n, hostRegistryAddress, accounts.host.address, hostKey]));
    await confirmed(owner.writeContract({ address: tokenAddress, abi: artifact('LocalReceiveToken').abi, functionName: 'faucet', args: [accounts.owner.address, 1_000_000n] }));
    await confirmed(owner.writeContract({address:tokenAddress,abi:artifact('LocalReceiveToken').abi,functionName:'approve',args:[permit2,1_000_000n]}));
    const pins: PlatformPins = platformPinsSchema.parse({ chainId: 31337, escrowAddress, tokenAddress, tokenCodeHash: await codeHash(tokenAddress),
      reviewedTokenKind: 'immutable', quoteSigner: accounts.signer.address,
      receiptRootAddress, hostRegistryAddress, feeRouterAddress, escrowCodeHash: await codeHash(escrowAddress),
      receiptRootCodeHash: await codeHash(receiptRootAddress), hostRegistryCodeHash: await codeHash(hostRegistryAddress), feeRouterCodeHash: await codeHash(feeRouterAddress), x402CpuProfile:{kind:'x402_cpu_v1',permit2Address:permit2,permit2CodeHash,proxyAddress:proxy,proxyCodeHash,tokenName:'Local Receive Fixture',tokenVersion:'1'} });
    return { local, artifacts, keys, accounts, owner, host, permit2, proxy, pins, hostId, test, confirmed, artifact,
      async close() { await local.close(); } };
  } catch (error) { await local.close(); throw error; }
}
