import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import solc from 'solc';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWalletClient, decodeEventLog, encodeAbiParameters, http, keccak256, maxUint256,
  parseEther, parseTransaction, toHex, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileContracts, projectRoot, type ContractArtifact } from '../scripts/compile-contracts.js';
import { localChain } from '../src/chain/chains.js';
import { EIP3009_TYPES, type PaymentChain } from '../src/payments/gateway.js';
import { EvmVaultIncomeChain, validateVaultIncomeReceipt, type VaultIncomePins } from '../src/payments/vault-income-chain.js';
import { createFacilitatorRoutes } from '../src/payments/routes.js';
import { X402PaymentService } from '../src/payments/service.js';
import { paymentJournal } from '../src/payments/schema.js';
import { requestBinding, type PaymentPayload } from '../src/payments/protocol.js';
import { openStore } from '../src/store.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

type Account = ReturnType<typeof privateKeyToAccount>;
type Agent = { owner: Address; agentWallet: Address; vault: Address; family: Hex; status: number; frozen: boolean;
  lifetimeIncome: bigint; lifetimeIncomeFees: bigint; lifetimeSubsidy: bigint };
type Authorization = { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };
const id = (value: string) => keccak256(toHex(value));
const scope = { classMask: 3n, sealedOnly: false, imageAllowRoot: toHex(0, { size: 32 }), regionAllowRoot: toHex(0, { size: 32 }) };
const referenceDomain = id('TelomerePlatformVaultIncomeEip3009V1');

function localArtifacts(): Record<string, ContractArtifact> {
  const tokenSource = readFileSync(resolve(projectRoot, 'tests/fixtures/x402-reference/LocalEip3009Token.sol'), 'utf8');
  const identitySource = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
contract LocalVaultIncomeIdentity {
    mapping(uint256 => address) public ownerOf;
    constructor() { require(block.chainid == 31337); }
    function register(uint256 identity, address owner) external {
        require(owner != address(0) && ownerOf[identity] == address(0)); ownerOf[identity] = owner;
    }
}`;
  const faultSource = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {LocalEip3009Token} from "./LocalEip3009Token.sol";
// Disposable delta/fee failure switches. Canonical authorization implementation is inherited unchanged.
contract LocalVaultIncomeFaultToken is LocalEip3009Token {
    uint8 public fault; address public faultVault;
    function setFault(uint8 mode, address target) external { fault = mode; faultVault = target; }
    function _update(address from, address to, uint256 value) internal override {
        if (fault == 2 && from == faultVault && to != address(0)) { super._update(from, to, value - 1); return; }
        super._update(from, to, value);
        if (fault == 1 && from != address(0) && to == faultVault) super._update(to, address(0), 1);
    }
}`;
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: {
    'LocalEip3009Token.sol': { content: tokenSource }, 'LocalVaultIncomeIdentity.sol': { content: identitySource },
    'LocalVaultIncomeFaultToken.sol': { content: faultSource },
  }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } }), {
    import: (path: string) => path.startsWith('@openzeppelin/contracts/') && !path.includes('..')
      ? { contents: readFileSync(resolve(projectRoot, 'node_modules', path), 'utf8') } : { error: 'Unsupported local import' },
  })) as { errors?: { severity: string; formattedMessage: string }[]; contracts: Record<string,
    Record<string, { abi: Abi; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  const errors = output.errors?.filter(error => error.severity === 'error') ?? [];
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  const artifacts = compileContracts();
  for (const name of ['LocalEip3009Token', 'LocalVaultIncomeIdentity', 'LocalVaultIncomeFaultToken']) {
    const value = output.contracts[`${name}.sol`]?.[name]; if (!value) throw new Error('Missing local income artifact');
    const artifact: ContractArtifact = { contractName: name, compiler: solc.version(), abi: value.abi,
      bytecode: `0x${value.evm.bytecode.object}`, deployedBytecode: `0x${value.evm.deployedBytecode.object}` };
    artifacts[name] = artifact;
    // The existing disposable platform fixture accepts an equivalent faucet/approve ERC20 ABI.
    // Its real escrow, host and Selection contracts all bind this actual EIP-3009 token.
    if (name === 'LocalVaultIncomeFaultToken') artifacts.MockToken = artifact;
  }
  return artifacts;
}

describe('atomic original-payer exact EIP-3009 Vault income', () => {
  let deployed: Awaited<ReturnType<typeof deployPlatformRuntime>>, snapshot: Hex;
  let controller: Account, guardian: Account, treasury: Account, parentKey: Account, childKey: Account, unrelatedKey: Account;
  let registry: Address, identity: Address;
  let store: Awaited<ReturnType<typeof openStore>> | undefined, directory: string | undefined;
  const resource = { url: 'https://local-income.example/service' }, binding = requestBinding('POST', resource.url, Buffer.from('local-resource'));
  const owner = () => deployed.accounts.owner, payer = () => deployed.accounts.outsider;
  const wallet = (account: Account) => createWalletClient({ account, chain: localChain, transport: http(deployed.local.rpcUrl, { retryCount: 0 }) });
  const token = () => deployed.pins.tokenAddress;
  async function write(address: Address, name: string, functionName: string, args: readonly unknown[] = [], account = owner()) {
    return deployed.confirmed(wallet(account).writeContract({ address, abi: deployed.artifact(name).abi, functionName, args }));
  }
  async function read<T>(address: Address, name: string, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return await deployed.local.publicClient.readContract({ address, abi: deployed.artifact(name).abi, functionName, args }) as T;
  }
  async function deploy(name: string, args: readonly unknown[] = []): Promise<Address> {
    const value = deployed.artifact(name), receipt = await deployed.confirmed(wallet(owner()).deployContract({ abi: value.abi, bytecode: value.bytecode, args }));
    if (!receipt.contractAddress) throw new Error('Missing local income deployment'); return receipt.contractAddress;
  }
  const now = async () => (await deployed.local.publicClient.getBlock()).timestamp;
  const balance = (address: Address) => read<bigint>(token(), 'LocalEip3009Token', 'balanceOf', [address]);
  const getAgent = (agentId: Hex) => read<Agent>(registry, 'PlatformSelectionRegistry', 'getAgent', [agentId]);
  async function enter(identityId = 1n, agentWallet = parentKey.address) {
    await write(registry, 'PlatformSelectionRegistry', 'enter', [{ identityId, agentWallet, maxPerHour: 20_000_000n,
      maxPerDay: 200_000_000n, expiry: await now() + 365n * 86_400n, cystHash: id(`income-cyst-${identityId}`), endowment: 50_000_000n, scope }]);
    const agentId = await read<Hex>(registry, 'PlatformSelectionRegistry', 'identityAgent', [identityId]);
    return { agentId, ...await getAgent(agentId) };
  }
  async function authorize(vault: Address, account = payer(), overrides: Partial<Authorization> = {}) {
    const time = await now();
    const authorization: Authorization = { from: account.address, to: vault, value: 1_000_001n,
      validAfter: time - 1n, validBefore: time + 240n, nonce: id(`income-nonce-${Math.random()}`), ...overrides };
    const signature = await account.signTypedData({ domain: { name: 'Local EIP3009 Fixture', version: '1', chainId: 31337, verifyingContract: token() },
      types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message: authorization });
    const vByte = Number.parseInt(signature.slice(130, 132), 16);
    return { authorization, signature, args: [authorization.from, authorization.value, authorization.validAfter, authorization.validBefore,
      authorization.nonce, vByte < 27 ? vByte + 27 : vByte, `0x${signature.slice(2, 66)}`, `0x${signature.slice(66, 130)}`] };
  }
  const reference = (auth: Authorization) => keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
    [referenceDomain, 31337n, token(), auth.to, auth.from, auth.nonce]));
  async function adapter(agent: { agentId: Hex; vault: Address }, confirmations = 1) {
    await deployed.test.mine({ blocks: confirmations + 1 });
    const hash = async (address: Address) => { const code = await deployed.local.publicClient.getCode({ address });
      if (!code) throw new Error('Missing local income code'); return keccak256(code); };
    const implementation = await read<Address>(registry, 'PlatformSelectionRegistry', 'vaultImplementation');
    const pins: VaultIncomePins = { chainId: 31337, asset: token(), tokenCodeHash: await hash(token()), payTo: agent.vault,
      facilitator: deployed.accounts.signer.address, reviewedTokenKind: 'immutable', confirmations,
      exact: { reviewedEip3009: true, name: 'Local EIP3009 Fixture', version: '1' }, agentId: agent.agentId, treasury: treasury.address,
      selection: { chainId: 31337, selectionRegistryAddress: registry, selectionRegistryCodeHash: await hash(registry),
        vaultImplementationAddress: implementation, vaultImplementationCodeHash: await hash(implementation), confirmations } };
    return new EvmVaultIncomeChain(deployed.local.publicClient, wallet(deployed.accounts.signer), pins, { rpcUrl: deployed.local.rpcUrl });
  }
  async function payment(service: X402PaymentService, agent: { vault: Address }, account = payer(), amount = '1000001'): Promise<PaymentPayload> {
    const required = await service.challenge({ resource, requestHash: binding, amount, scheme: 'exact' }), accepted = required.accepts[0]!;
    const signed = await authorize(agent.vault, account, { value: BigInt(amount), nonce: accepted.extra.telomere.nonce });
    const auth = signed.authorization;
    return { x402Version: 2, resource, accepted, payload: { signature: signed.signature, authorization: { from: auth.from, to: auth.to,
      value: auth.value.toString(), validAfter: auth.validAfter.toString(), validBefore: auth.validBefore.toString(), nonce: auth.nonce } } };
  }
  async function service(chain: PaymentChain, dataDir = ':memory:') {
    store = await openStore({ DATA_DIR: dataDir });
    const result = new X402PaymentService(store.db, chain, () => localClock);
    await result.initialize(); return result;
  }
  let localClock = 0;
  const wrap = (chain: PaymentChain, overrides: Partial<PaymentChain>): PaymentChain => ({ pins: chain.pins,
    verify: chain.verify.bind(chain), prepare: chain.prepare.bind(chain), broadcast: chain.broadcast.bind(chain), inspect: chain.inspect.bind(chain), ...overrides });

  beforeAll(async () => {
    deployed = await deployPlatformRuntime(id('vault-income-host'), localArtifacts());
    [controller, guardian, treasury, parentKey, childKey, unrelatedKey] = Array.from({ length: 6 }, () => privateKeyToAccount(generatePrivateKey())) as
      [Account, Account, Account, Account, Account, Account];
    for (const account of [controller, guardian, treasury, parentKey, childKey, unrelatedKey]) await deployed.test.setBalance({ address: account.address, value: parseEther('10') });
    identity = await deploy('LocalVaultIncomeIdentity');
    const utility = await deploy('TlmrToken', [owner().address, parseEther('1000000')]), staking = await deploy('TlmrStaking', [utility]);
    registry = await deploy('PlatformSelectionRegistry', [{ token: token(), escrow: deployed.pins.escrowAddress, controller: controller.address,
      guardian: guardian.address, identityRegistry: identity, staking, treasury: treasury.address, entryFee: 1_000_000n, vaultFloor: 1_000_000n }]);
    for (const identityId of [1n, 2n, 3n]) await write(identity, 'LocalVaultIncomeIdentity', 'register', [identityId, owner().address]);
    for (const account of [owner(), payer(), controller, treasury, parentKey, childKey, unrelatedKey]) {
      await write(token(), 'LocalEip3009Token', 'faucet', [account.address, 1_000_000_000n]);
    }
    await write(token(), 'LocalEip3009Token', 'approve', [registry, maxUint256]);
    snapshot = await deployed.test.snapshot();
  }, 90_000);
  beforeEach(async () => { await deployed.test.revert({ id: snapshot }); snapshot = await deployed.test.snapshot(); localClock = Number(await now()) * 1000; });
  afterEach(async () => { await store?.close(); store = undefined;
    if (directory) {
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-vault-income-')) throw new Error('Unsafe disposable income fixture path');
      await rm(target, { recursive: true, force: true }); directory = undefined;
    } });
  afterAll(async () => { await deployed?.close(); });

  it('classifies the signed external payer, charges exact rounded fee and conserves gross/net/fee atomically', async () => {
    const agent = await enter(), auth = await authorize(agent.vault), ref = reference(auth.authorization);
    const before = { payer: await balance(payer().address), vault: await balance(agent.vault), treasury: await balance(treasury.address) };
    expect(await read(agent.vault, 'PlatformAgentVault', 'incomeAuthorizationRef', [payer().address, auth.authorization.nonce])).toBe(ref);
    const receipt = await write(agent.vault, 'PlatformAgentVault', 'receiveFundsWithAuthorization', auth.args, controller);
    const updated = await getAgent(agent.agentId);
    expect(updated.lifetimeIncome).toBe(1_000_001n); expect(updated.lifetimeIncomeFees).toBe(10_001n); expect(updated.lifetimeSubsidy).toBe(50_000_000n);
    expect(before.payer - await balance(payer().address)).toBe(1_000_001n);
    expect(await balance(agent.vault) - before.vault).toBe(990_000n);
    expect(await balance(treasury.address) - before.treasury).toBe(10_001n);
    expect(await read(agent.vault, 'PlatformAgentVault', 'usedIncomeAuthorization', [ref])).toBe(true);
    expect(await read(token(), 'LocalEip3009Token', 'authorizationState', [payer().address, auth.authorization.nonce])).toBe(true);
    const incomes = receipt.logs.filter(log => log.address.toLowerCase() === registry.toLowerCase()).map(log =>
      decodeEventLog({ abi: deployed.artifact('PlatformSelectionRegistry').abi, data: log.data, topics: log.topics }));
    expect(incomes).toMatchObject([{ eventName: 'Income', args: { agentId: agent.agentId, source: payer().address,
      amount: 1_000_001n, fee: 10_001n, paymentRef: ref } }]);
    await expect(write(agent.vault, 'PlatformAgentVault', 'receiveFundsWithAuthorization', auth.args)).rejects.toThrow();
    expect((await getAgent(agent.agentId)).lifetimeIncome).toBe(1_000_001n);
    for (const name of ['PlatformAgentVault', 'PlatformSelectionRegistry']) expect((deployed.artifact(name).deployedBytecode.length - 2) / 2).toBeLessThanOrEqual(24_576);
  });
  it('applies the managed cap after the EIP-3009 income fee and preserves an over-cap authorization on revert', async () => {
    const cap = 2_500_000_000n;
    await write(token(), 'LocalEip3009Token', 'faucet', [owner().address, cap]);
    const agent = await enter();
    await write(token(), 'LocalEip3009Token', 'transfer', [agent.vault, cap - 50_000_000n - 99n]);
    const atCap = await authorize(agent.vault, payer(), { value: 100n });
    await write(agent.vault, 'PlatformAgentVault', 'receiveFundsWithAuthorization', atCap.args, controller);
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(cap);
    expect((await getAgent(agent.agentId)).lifetimeIncome).toBe(100n);
    expect((await getAgent(agent.agentId)).lifetimeIncomeFees).toBe(1n);
    const overCap = await authorize(agent.vault, payer(), { value: 2n });
    const ref = reference(overCap.authorization), payerBefore = await balance(payer().address);
    await expect(write(agent.vault, 'PlatformAgentVault', 'receiveFundsWithAuthorization', overCap.args, controller)).rejects.toThrow();
    expect(await read(token(), 'LocalEip3009Token', 'authorizationState', [payer().address, overCap.authorization.nonce])).toBe(false);
    expect(await read(agent.vault, 'PlatformAgentVault', 'usedIncomeAuthorization', [ref])).toBe(false);
    expect(await balance(payer().address)).toBe(payerBefore);
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(cap);
    expect((await getAgent(agent.agentId)).lifetimeIncome).toBe(100n);
  });
  it.each(['owner', 'agent', 'controller', 'treasury', 'child'] as const)('preserves %s original-payer exclusions even when an outsider relays', async source => {
    const agent = await enter();
    if (source === 'child') await write(registry, 'PlatformSelectionRegistry', 'spawn', [agent.agentId, 2n,
      childKey.address, 5_000_000n, await now() + 300n * 86_400n]);
    const account = source === 'owner' ? owner() : source === 'agent' ? parentKey : source === 'controller' ? controller
      : source === 'treasury' ? treasury : childKey;
    const auth = await authorize(agent.vault, account), before = await balance(agent.vault);
    await write(agent.vault, 'PlatformAgentVault', 'receiveFundsWithAuthorization', auth.args, payer());
    expect(await getAgent(agent.agentId)).toMatchObject({ lifetimeIncome: 0n, lifetimeIncomeFees: 0n, lifetimeSubsidy: 51_000_001n });
    expect(await balance(agent.vault) - before).toBe(1_000_001n);
  });
  it('counts an unrelated registered agent payer as external income', async () => {
    const agent = await enter(); await enter(3n, unrelatedKey.address);
    const auth = await authorize(agent.vault, unrelatedKey);
    await write(agent.vault, 'PlatformAgentVault', 'receiveFundsWithAuthorization', auth.args);
    expect(await getAgent(agent.agentId)).toMatchObject({ lifetimeIncome: 1_000_001n, lifetimeIncomeFees: 10_001n, lifetimeSubsidy: 50_000_000n });
  });
  it.each(['incoming delta', 'fee delta'] as const)('rolls back transfer, authorization, reference and classification on invalid %s', async failure => {
    const agent = await enter(), auth = await authorize(agent.vault), before = { payer: await balance(payer().address),
      vault: await balance(agent.vault), treasury: await balance(treasury.address) };
    await write(token(), 'LocalVaultIncomeFaultToken', 'setFault', [failure === 'incoming delta' ? 1 : 2, agent.vault]);
    await expect(write(agent.vault, 'PlatformAgentVault', 'receiveFundsWithAuthorization', auth.args)).rejects.toThrow();
    expect(await balance(payer().address)).toBe(before.payer); expect(await balance(agent.vault)).toBe(before.vault);
    expect(await balance(treasury.address)).toBe(before.treasury);
    expect(await read(token(), 'LocalEip3009Token', 'authorizationState', [payer().address, auth.authorization.nonce])).toBe(false);
    expect(await read(agent.vault, 'PlatformAgentVault', 'usedIncomeAuthorization', [reference(auth.authorization)])).toBe(false);
    expect(await getAgent(agent.agentId)).toMatchObject({ lifetimeIncome: 0n, lifetimeIncomeFees: 0n, lifetimeSubsidy: 50_000_000n });
  });
  it.each(['frozen', 'dormant', 'killed'] as const)('preserves incoming classification while %s', async state => {
    const agent = await enter();
    if (state === 'frozen') await write(registry, 'PlatformSelectionRegistry', 'setFrozen', [agent.agentId, true, 'disposable evidence', id('freeze')], guardian);
    if (state === 'killed') await write(agent.vault, 'PlatformAgentVault', 'killLeash');
    if (state === 'dormant') {
      await write(agent.vault, 'PlatformAgentVault', 'ownerWithdraw', [50_000_000n]);
      await deployed.test.increaseTime({ seconds: 86_401 }); await deployed.test.mine({ blocks: 1 });
      await write(registry, 'PlatformSelectionRegistry', 'declareDormant', [agent.agentId]);
    }
    const auth = await authorize(agent.vault);
    await write(agent.vault, 'PlatformAgentVault', 'receiveFundsWithAuthorization', auth.args);
    expect(await getAgent(agent.agentId)).toMatchObject({ lifetimeIncome: 1_000_001n, lifetimeIncomeFees: 10_001n,
      status: state === 'dormant' ? 2 : 1, frozen: state === 'frozen' });
  });
  it.each(['zero', 'overflow', 'wrong signer', 'wrong destination', 'future', 'expired'] as const)('rejects %s without transfer, nonce consumption or reference residue', async failure => {
    const agent = await enter(), time = await now();
    const auth = await authorize(agent.vault, payer(), failure === 'zero' ? { value: 0n } : failure === 'overflow' ? { value: 2n ** 96n }
      : failure === 'wrong destination' ? { to: owner().address } : failure === 'future' ? { validAfter: time + 60n }
        : failure === 'expired' ? { validBefore: time - 1n } : {});
    if (failure === 'wrong signer') auth.args[0] = owner().address;
    const before = { payer: await balance(payer().address), vault: await balance(agent.vault) };
    await expect(write(agent.vault, 'PlatformAgentVault', 'receiveFundsWithAuthorization', auth.args)).rejects.toThrow();
    expect(await balance(payer().address)).toBe(before.payer); expect(await balance(agent.vault)).toBe(before.vault);
    expect(await read(token(), 'LocalEip3009Token', 'authorizationState', [payer().address, auth.authorization.nonce])).toBe(false);
    expect(await read(agent.vault, 'PlatformAgentVault', 'usedIncomeAuthorization', [reference({ ...auth.authorization, to: agent.vault })])).toBe(false);
  });
  it('rolls back token authorization and all balances when Dead rejects classification', async () => {
    const agent = await enter();
    await write(agent.vault, 'PlatformAgentVault', 'ownerWithdraw', [50_000_000n]);
    await deployed.test.increaseTime({ seconds: 3 * 86_400 + 1 }); await deployed.test.mine({ blocks: 1 });
    await write(registry, 'PlatformSelectionRegistry', 'declareDormant', [agent.agentId]);
    await deployed.test.increaseTime({ seconds: 30 * 86_400 + 1 }); await deployed.test.mine({ blocks: 1 });
    await write(registry, 'PlatformSelectionRegistry', 'declareDeath', [agent.agentId]);
    expect((await getAgent(agent.agentId)).status).toBe(3);
    const auth = await authorize(agent.vault), before = await balance(payer().address);
    await expect(write(agent.vault, 'PlatformAgentVault', 'receiveFundsWithAuthorization', auth.args)).rejects.toThrow();
    expect(await balance(payer().address)).toBe(before); expect(await balance(agent.vault)).toBe(0n);
    expect(await read(token(), 'LocalEip3009Token', 'authorizationState', [payer().address, auth.authorization.nonce])).toBe(false);
    expect(await read(agent.vault, 'PlatformAgentVault', 'usedIncomeAuthorization', [reference(auth.authorization)])).toBe(false);
  });
  it('leaves direct token front-run donations unclassified and refuses to classify the consumed authorization', async () => {
    const agent = await enter(), auth = await authorize(agent.vault), before = await balance(agent.vault);
    await write(token(), 'LocalEip3009Token', 'transferWithAuthorization', [auth.authorization.from, auth.authorization.to,
      ...auth.args.slice(1)], controller);
    expect(await balance(agent.vault) - before).toBe(1_000_001n);
    await expect(write(agent.vault, 'PlatformAgentVault', 'receiveFundsWithAuthorization', auth.args)).rejects.toThrow();
    expect(await getAgent(agent.agentId)).toMatchObject({ lifetimeIncome: 0n, lifetimeIncomeFees: 0n, lifetimeSubsidy: 50_000_000n });
    expect(await read(agent.vault, 'PlatformAgentVault', 'usedIncomeAuthorization', [reference(auth.authorization)])).toBe(false);
  });
  it('preserves a parent signer exclusion when paying the separate child Vault', async () => {
    const parent = await enter();
    await write(registry, 'PlatformSelectionRegistry', 'spawn', [parent.agentId, 2n, childKey.address, 5_000_000n, await now() + 300n * 86_400n]);
    const childId = await read<Hex>(registry, 'PlatformSelectionRegistry', 'identityAgent', [2n]), child = await getAgent(childId);
    const auth = await authorize(child.vault, parentKey);
    await write(child.vault, 'PlatformAgentVault', 'receiveFundsWithAuthorization', auth.args, payer());
    expect(await getAgent(childId)).toMatchObject({ lifetimeIncome: 0n, lifetimeIncomeFees: 0n, lifetimeSubsidy: 6_000_001n });
  });
  it('uses actual authenticated facilitator HTTP and read-only verify before atomic exact classification', async () => {
    const agent = await enter(), chain = await adapter(agent), payments = await service(chain), input = await payment(payments, agent);
    const app = createFacilitatorRoutes(payments, context => context.req.header('authorization') === 'Bearer disposable-income-resource');
    const body = JSON.stringify({ x402Version: 2, paymentPayload: input, paymentRequirements: input.accepted });
    const before = { payer: await balance(payer().address), vault: await balance(agent.vault), treasury: await balance(treasury.address),
      nonce: await deployed.local.publicClient.getTransactionCount({ address: chain.pins.facilitator }) };
    const verified = await app.request('/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(verified.status).toBe(200); expect(await verified.json()).toMatchObject({ isValid: true, payer: payer().address });
    expect(await balance(agent.vault)).toBe(before.vault); expect(await store!.db.select().from(paymentJournal)).toHaveLength(0);
    const denied = await app.request('/settle', { method: 'POST', headers: { 'content-type': 'application/json' }, body }); expect(denied.status).toBe(401);
    const settled = await app.request('/settle', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer disposable-income-resource' }, body });
    expect(settled.status).toBe(200); const response = await settled.json(); expect(response).toMatchObject({ success: true, amount: '1000001' });
    expect(before.payer - await balance(payer().address)).toBe(1_000_001n); expect(await balance(agent.vault) - before.vault).toBe(990_000n);
    expect(await balance(treasury.address) - before.treasury).toBe(10_001n);
    expect(await deployed.local.publicClient.getTransactionCount({ address: chain.pins.facilitator })).toBe(before.nonce + 1);
    expect(await getAgent(agent.agentId)).toMatchObject({ lifetimeIncome: 1_000_001n, lifetimeIncomeFees: 10_001n });
    expect(await payments.settle(input, { amount: '1000001', requestHash: binding })).toEqual(response);
  });
  it('returns successful owner subsidy payment without claiming Selection income', async () => {
    const agent = await enter(), chain = await adapter(agent), payments = await service(chain), input = await payment(payments, agent, owner());
    expect(await payments.settle(input, { amount: '1000001', requestHash: binding })).toMatchObject({ success: true });
    expect(await getAgent(agent.agentId)).toMatchObject({ lifetimeIncome: 0n, lifetimeIncomeFees: 0n, lifetimeSubsidy: 51_000_001n });
  });
  it('persists exact signed bytes before send and recovers ambiguous broadcast after filesystem PGlite reopen', async () => {
    const agent = await enter(), chain = await adapter(agent);
    directory = await mkdtemp(join(tmpdir(), 'telomere-vault-income-'));
    let committedRaw: Hex | undefined, broadcasted = false;
    const beforeSend = wrap(chain, { broadcast: async raw => { committedRaw = raw; throw new Error('Disposable before-send outage'); } });
    const first = await service(beforeSend, directory), input = await payment(first, agent), response = await first.settle(input, { amount: '1000001', requestHash: binding });
    expect(response).toMatchObject({ success: false, errorReason: 'settlement_pending' });
    const [journal] = await store!.db.select().from(paymentJournal); expect(journal?.state).toBe('prepared'); expect(journal?.raw).toBe(committedRaw);
    await store!.close(); store = undefined;
    const interrupted = wrap(chain, { broadcast: async raw => {
      expect(raw).toBe(committedRaw); await chain.broadcast(raw); broadcasted = true; throw new Error('Disposable ambiguous send');
    }, inspect: async (...args) => { if (broadcasted) throw new Error('Disposable RPC outage'); return chain.inspect(...args); } });
    const ambiguous = await service(interrupted, directory);
    expect(await ambiguous.settle(input, { amount: '1000001', requestHash: binding })).toMatchObject({ success: false, transaction: response.transaction });
    await store!.close(); store = undefined;
    const recovered = await service(chain, directory), settled = await recovered.settle(input, { amount: '1000001', requestHash: binding });
    expect(settled).toMatchObject({ success: true, transaction: response.transaction });
    expect((await store!.db.select().from(paymentJournal))[0]).toMatchObject({ state: 'settled', raw: committedRaw, hash: response.transaction });
    expect((await getAgent(agent.agentId)).lifetimeIncome).toBe(1_000_001n);
  }, 30_000);
  it('keeps the original prepared hash and reports direct-token front-run as reconciliation required', async () => {
    const agent = await enter(), chain = await adapter(agent), paused = wrap(chain, { broadcast: async () => { throw new Error('Disposable before-send outage'); } });
    const payments = await service(paused), input = await payment(payments, agent);
    const first = await payments.settle(input, { amount: '1000001', requestHash: binding }); expect(first.success).toBe(false);
    const [journal] = await store!.db.select().from(paymentJournal); if (!journal?.raw || !journal.hash || journal.nonce === null) throw new Error('Missing prepared fixture');
    if (!('authorization' in input.payload)) throw new Error('Missing exact fixture');
    const auth = input.payload.authorization, sig = input.payload.signature;
    await write(token(), 'LocalEip3009Token', 'transferWithAuthorization', [auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce,
      Number.parseInt(sig.slice(130, 132), 16), `0x${sig.slice(2, 66)}`, `0x${sig.slice(66, 130)}`], controller);
    await expect(chain.inspect({ raw: journal.raw as Hex, hash: journal.hash as Hex, nonce: journal.nonce }, input, '1000001'))
      .rejects.toMatchObject({ code: 'income_authorization_reconciliation_required' });
    expect(await payments.settle(input, { amount: '1000001', requestHash: binding })).toMatchObject({ success: false,
      transaction: first.transaction, errorReason: 'income_authorization_reconciliation_required' });
    expect((await store!.db.select().from(paymentJournal))[0]).toMatchObject({ state: 'prepared', raw: journal.raw, hash: journal.hash });
    expect((await getAgent(agent.agentId)).lifetimeIncome).toBe(0n);
  });
  it('does not adopt atomic ingress relayed under a different outer transaction hash', async () => {
    const agent = await enter(), chain = await adapter(agent), payments = await service(wrap(chain, { broadcast: async () => { throw new Error('Before send'); } }));
    const input = await payment(payments, agent); await payments.settle(input, { amount: '1000001', requestHash: binding });
    const [journal] = await store!.db.select().from(paymentJournal); if (!journal?.raw || !journal.hash || journal.nonce === null) throw new Error('Missing prepared fixture');
    if (!('authorization' in input.payload)) throw new Error('Missing exact fixture');
    const auth = input.payload.authorization, sig = input.payload.signature;
    const relayed = await write(agent.vault, 'PlatformAgentVault', 'receiveFundsWithAuthorization', [auth.from, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce,
      Number.parseInt(sig.slice(130, 132), 16), `0x${sig.slice(2, 66)}`, `0x${sig.slice(66, 130)}`], controller);
    expect(relayed.transactionHash).not.toBe(journal.hash); expect((await getAgent(agent.agentId)).lifetimeIncome).toBe(1_000_001n);
    await expect(chain.inspect({ raw: journal.raw as Hex, hash: journal.hash as Hex, nonce: journal.nonce }, input, '1000001'))
      .rejects.toMatchObject({ code: 'income_authorization_reconciliation_required' });
    expect((await store!.db.select().from(paymentJournal))[0]?.hash).toBe(journal.hash);
  });
  it.each(['direct-token', 'alternate-vault-relay'] as const)('reconciles later %s consumption after its own canonical low-gas revert without returning cached failure', async route => {
    const agent = await enter(), chain = await adapter(agent), lowGas = wrap(chain, { prepare: async (input, amount) => {
      const prepared = await chain.prepare(input, amount), original = parseTransaction(prepared.raw);
      const raw = await wallet(deployed.accounts.signer).signTransaction({ chain: localChain, type: 'eip1559', to: agent.vault,
        data: original.data ?? '0x', nonce: prepared.nonce, gas: 30_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n });
      return { raw, hash: keccak256(raw), nonce: prepared.nonce };
    } });
    const payments = await service(lowGas), input = await payment(payments, agent);
    const failed = await payments.settle(input, { amount: '1000001', requestHash: binding });
    expect(failed).toMatchObject({ success: false, errorReason: 'transaction_reverted' });
    const [journal] = await store!.db.select().from(paymentJournal);
    if (!journal?.raw || !journal.hash || journal.nonce === null || !('authorization' in input.payload)) throw new Error('Missing reverted fixture');
    expect((await deployed.local.publicClient.getTransactionReceipt({ hash: journal.hash as Hex })).status).toBe('reverted');
    const auth = input.payload.authorization, sig = input.payload.signature;
    expect(await read(token(), 'LocalEip3009Token', 'authorizationState', [auth.from, auth.nonce])).toBe(false);
    const args = [auth.from, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce,
      Number.parseInt(sig.slice(130, 132), 16), `0x${sig.slice(2, 66)}`, `0x${sig.slice(66, 130)}`];
    if (route === 'direct-token') await write(token(), 'LocalEip3009Token', 'transferWithAuthorization', [auth.from, auth.to, ...args.slice(1)], controller);
    else await write(agent.vault, 'PlatformAgentVault', 'receiveFundsWithAuthorization', args, controller);
    expect(await read(token(), 'LocalEip3009Token', 'authorizationState', [auth.from, auth.nonce])).toBe(true);
    await expect(chain.inspect({ raw: journal.raw as Hex, hash: journal.hash as Hex, nonce: journal.nonce }, input, '1000001'))
      .rejects.toMatchObject({ code: 'income_authorization_reconciliation_required' });
    await expect(payments.settle(input, { amount: '1000001', requestHash: binding }))
      .rejects.toMatchObject({ code: 'income_authorization_reconciliation_required' });
    expect((await store!.db.select().from(paymentJournal))[0]).toMatchObject({ state: 'reverted', raw: journal.raw, hash: journal.hash });
    expect((await getAgent(agent.agentId)).lifetimeIncome).toBe(route === 'direct-token' ? 0n : 1_000_001n);
  });

  it('downgrades cached financial success after a real reorg and only recovers the original raw hash', async () => {
    const agent = await enter(), chain = await adapter(agent), payments = await service(chain), input = await payment(payments, agent), before = await balance(agent.vault);
    const fork = await deployed.test.snapshot(), first = await payments.settle(input, { amount: '1000001', requestHash: binding }); expect(first.success).toBe(true);
    const [journal] = await store!.db.select().from(paymentJournal); expect(journal?.state).toBe('settled');
    await deployed.test.revert({ id: fork }); expect(await balance(agent.vault)).toBe(before);
    const downgraded = await payments.settle(input, { amount: '1000001', requestHash: binding });
    expect(downgraded).toMatchObject({ success: false, transaction: first.transaction, errorReason: 'settlement_pending' });
    expect((await store!.db.select().from(paymentJournal))[0]).toMatchObject({ state: 'prepared', raw: journal?.raw, hash: journal?.hash });
    const recovered = await payments.settle(input, { amount: '1000001', requestHash: binding }); expect(recovered).toMatchObject({ success: true, transaction: first.transaction });
    expect((await getAgent(agent.agentId)).lifetimeIncome).toBe(1_000_001n);
  });
  it('keeps receipt with insufficient depth pending, then accepts only the original canonical transaction', async () => {
    const agent = await enter(), chain = await adapter(agent, 2), payments = await service(chain), input = await payment(payments, agent);
    const first = await payments.settle(input, { amount: '1000001', requestHash: binding }); expect(first).toMatchObject({ success: false, errorReason: 'settlement_pending' });
    await deployed.test.mine({ blocks: 1 });
    expect(await payments.settle(input, { amount: '1000001', requestHash: binding })).toMatchObject({ success: true, transaction: first.transaction });
  });
  it.each(['settled', 'reverted'] as const)('rejects lost final confirmation depth during actual %s receipt inspection', async state => {
    const agent = await enter(), chain = await adapter(agent, 2), payments = await service(chain), input = await payment(payments, agent);
    const prepared = await chain.prepare(input, '1000001');
    if (state === 'reverted') { await deployed.test.increaseTime({ seconds: 241 }); await deployed.test.mine({ blocks: 1 }); }
    await chain.broadcast(prepared.raw);
    const receipt = await deployed.local.publicClient.waitForTransactionReceipt({ hash: prepared.hash });
    expect(receipt.status).toBe(state === 'settled' ? 'success' : 'reverted');
    const shallow = await deployed.test.snapshot(); await deployed.test.mine({ blocks: 1 });
    let armed = true;
    const racedClient = deployed.local.publicClient.extend(client => ({
      getBlockNumber: async (args?: Parameters<typeof client.getBlockNumber>[0]) => {
        const actual = await client.getBlockNumber(args);
        if (armed) { armed = false; await deployed.test.revert({ id: shallow }); }
        return actual;
      },
    }));
    const raced = new EvmVaultIncomeChain(racedClient, wallet(deployed.accounts.signer), chain.pins, { rpcUrl: deployed.local.rpcUrl });
    expect(await raced.inspect(prepared, input, '1000001')).toBe('pending');
    expect((await deployed.local.publicClient.getBlock({ blockNumber: receipt.blockNumber })).hash).toBe(receipt.blockHash);
    expect(await deployed.local.publicClient.getBlockNumber({ cacheTime: 0 })).toBe(receipt.blockNumber);
  });
  it.each(['hash', 'nonce', 'payment nonce', 'payment amount', 'signer'] as const)('rejects %s corruption of signed journal evidence', async failure => {
    const agent = await enter(), chain = await adapter(agent), payments = await service(chain), input = await payment(payments, agent), prepared = await chain.prepare(input, '1000001');
    let checked = input;
    if (failure === 'hash') prepared.hash = id('wrong-journal-hash');
    if (failure === 'nonce') prepared.nonce += 1;
    if (failure === 'payment nonce') { if (!('authorization' in input.payload)) throw new Error('Missing exact fixture');
      const nonce = id('wrong-bound-authorization');
      checked = { ...input, accepted: { ...input.accepted, extra: { ...input.accepted.extra,
        telomere: { ...input.accepted.extra.telomere, nonce } } },
      payload: { ...input.payload, authorization: { ...input.payload.authorization, nonce } } }; }
    if (failure === 'payment amount') { if (!('authorization' in input.payload)) throw new Error('Missing exact fixture');
      checked = { ...input, payload: { ...input.payload, authorization: { ...input.payload.authorization, value: '1000002' } } }; }
    if (failure === 'signer') {
      const original = parseTransaction(prepared.raw);
      prepared.raw = await wallet(controller).signTransaction({ chain: localChain, type: 'eip1559', to: agent.vault,
        data: original.data ?? '0x', nonce: prepared.nonce, gas: 1_000_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n });
      prepared.hash = keccak256(prepared.raw);
    }
    await expect(chain.inspect(prepared, checked, checked.accepted.amount)).rejects.toMatchObject({ code: failure === 'payment amount'
      ? 'payment_terms_mismatch' : 'income_journal_transaction_mismatch' });
    expect((await getAgent(agent.agentId)).lifetimeIncome).toBe(0n);
  });
  it('accepts equivalent uppercase signature bytes through signed journal and receipt verification', async () => {
    const agent = await enter(), chain = await adapter(agent), payments = await service(chain), input = await payment(payments, agent);
    input.payload.signature = `0x${input.payload.signature.slice(2).toUpperCase()}`;
    expect(await payments.verify(input, binding)).toMatchObject({ isValid: true });
    expect(await payments.settle(input, { amount: '1000001', requestHash: binding })).toMatchObject({ success: true });
    expect((await getAgent(agent.agentId)).lifetimeIncome).toBe(1_000_001n);
  });
  it.each(['reference', 'source', 'fee', 'treasury', 'missing classification', 'duplicate classification', 'removed'] as const)
    ('rejects %s spoofing of an actual mined receipt', async failure => {
      const agent = await enter(), chain = await adapter(agent), payments = await service(chain), input = await payment(payments, agent);
      const prepared = await chain.prepare(input, '1000001'); await chain.broadcast(prepared.raw);
      const receipt = await deployed.local.publicClient.waitForTransactionReceipt({ hash: prepared.hash });
      expect(() => validateVaultIncomeReceipt(receipt, input, chain.pins)).not.toThrow();
      const logs = [...receipt.logs], registryIndex = logs.findIndex(log => log.address.toLowerCase() === registry.toLowerCase()), vaultIndex = logs.findIndex(log => log.address.toLowerCase() === agent.vault.toLowerCase());
      if (failure === 'missing classification') logs.splice(registryIndex, 1);
      else if (failure === 'duplicate classification') logs.push(logs[registryIndex]!);
      else if (failure === 'removed') logs[registryIndex] = { ...logs[registryIndex]!, removed: true };
      else if (failure === 'source') {
        logs[registryIndex] = { ...logs[registryIndex]!, topics: [id('Income(bytes32,uint96,uint96,address,bytes32)'), agent.agentId, toHex(BigInt(owner().address), { size: 32 })] };
      } else if (failure === 'treasury') {
        const index = logs.findIndex(log => log.address.toLowerCase() === token().toLowerCase() && log.topics[2]?.slice(-40).toLowerCase() === treasury.address.slice(2).toLowerCase());
        logs[index] = { ...logs[index]!, topics: [id('Transfer(address,address,uint256)'), toHex(BigInt(agent.vault), { size: 32 }), toHex(BigInt(owner().address), { size: 32 })] };
      } else {
        logs[vaultIndex] = { ...logs[vaultIndex]!, data: encodeAbiParameters([{ type: 'uint96' }, { type: 'uint96' }, { type: 'bytes32' }],
          [1_000_001n, failure === 'fee' ? 10_000n : 10_001n, failure === 'reference' ? id('wrong-income-reference')
            : reference({ from: payer().address, to: agent.vault, value: 1_000_001n, validAfter: 0n, validBefore: 0n,
              nonce: 'authorization' in input.payload ? input.payload.authorization.nonce : id('impossible') })]) };
      }
      const tampered: TransactionReceipt = { ...receipt, logs };
      expect(() => validateVaultIncomeReceipt(tampered, input, chain.pins)).toThrowError(expect.objectContaining({ code: 'income_receipt_mismatch' }));
    });
  it.each(['treasury', 'token', 'registry code', 'implementation code', 'agent', 'chain', 'upto'] as const)('refuses %s profile mismatch before journal or token mutation', async failure => {
    const agent = await enter(), valid = await adapter(agent), pins: VaultIncomePins = { ...structuredClone(valid.pins) }, payments = await service(valid), input = await payment(payments, agent);
    if (failure === 'treasury') pins.treasury = owner().address;
    if (failure === 'token') pins.asset = owner().address;
    if (failure === 'registry code') pins.selection.selectionRegistryCodeHash = id('wrong-registry-code');
    if (failure === 'implementation code') pins.selection.vaultImplementationCodeHash = id('wrong-implementation-code');
    if (failure === 'agent') pins.agentId = id('unknown-agent');
    if (failure === 'chain') pins.selection.chainId = 1;
    if (failure === 'upto') Object.assign(pins, { upto: { name: 'not-supported' } });
    const checked = async () => { const chain = new EvmVaultIncomeChain(deployed.local.publicClient, wallet(deployed.accounts.signer), pins, { rpcUrl: deployed.local.rpcUrl }); await chain.verify(input, input.accepted); };
    await expect(checked()).rejects.toThrow(); expect(await store!.db.select().from(paymentJournal)).toHaveLength(0);
    expect((await getAgent(agent.agentId)).lifetimeIncome).toBe(0n);
  });
});
