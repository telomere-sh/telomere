import { createPublicClient, http, keccak256, parseAbi } from 'viem';
import { incomeAddressSchema, incomeBindingSchema, incomeBlockSchema, incomeEndpointPinsSchema, incomeHashSchema,
  type IncomeBlock, type IncomeEndpointPins, type IncomeEndpointReader, type IncomeSnapshot } from './types.js';
import { incomeStrictJson } from './json.js';

const selectionAbi = parseAbi([
  'struct Agent { uint256 identityId; address owner; address agentWallet; address vault; bytes32 leashId; bytes32 parent; bytes32 family; bytes32 cystHash; uint64 enteredAt; uint64 dormantAt; uint64 diedAt; uint64 lastPaidRun; uint64 lastActivationAt; uint64 deathAt; uint256 lifetimeIncome; uint256 lifetimeBurn; uint256 lifetimeSubsidy; uint256 lifetimeIncomeFees; uint8 livingChildren; uint8 status; bool frozen; }',
  'function getAgent(bytes32) view returns (Agent)', 'function agentWalletAgent(address) view returns (bytes32)',
  'function vaultAgent(address) view returns (bytes32)', 'function vaultImplementation() view returns(address)',
  'function token() view returns(address)', 'function escrow() view returns(address)',
  'function controller() view returns(address)', 'function treasury() view returns(address)',
]);
const vaultAbi = parseAbi(['function token() view returns(address)', 'function escrow() view returns(address)',
  'function controller() view returns(address)', 'function registry() view returns(address)', 'function treasury() view returns(address)',
  'function owner() view returns(address)', 'function agentWallet() view returns(address)', 'function agentId() view returns(bytes32)']);
const equal = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
export class IncomeEndpointUnknownAgentError extends Error {
  constructor() { super('Income endpoint agent is not registered'); this.name = 'IncomeEndpointUnknownAgentError'; }
}
async function rpcFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, abort: () => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(new Error('Income endpoint RPC deadline')); controller.abort(); void reader?.cancel().catch(() => undefined); };
    timer = setTimeout(abort, 10_000);
  });
  if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await Promise.race([fetch(input, { ...init, redirect: 'error', signal: controller.signal }), deadline]);
    if (!response.ok || Number(response.headers.get('content-length') ?? '0') > 262_144) {
      void response.body?.cancel().catch(() => undefined); throw new Error('Income endpoint RPC response');
    }
    reader = response.body?.getReader(); if (!reader) throw new Error('Income endpoint RPC body');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const item = await Promise.race([reader.read(), deadline]); if (item.done) break;
      size += item.value.byteLength; if (size > 262_144) throw new Error('Income endpoint RPC limit'); chunks.push(item.value); }
    const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); incomeStrictJson(body);
    return new Response(body, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  } finally { clearTimeout(timer); init?.signal?.removeEventListener('abort', abort); controller.abort(); reader?.releaseLock(); }
}

/** Independent read-only Selection authority. It requires neither a CystRegistry nor a signing account. */
export class RpcIncomeEndpointReader implements IncomeEndpointReader {
  readonly pins: IncomeEndpointPins; readonly asset: string;
  private readonly client;
  constructor(options: { rpcUrl: string; pins: IncomeEndpointPins; asset: string }) {
    this.pins = Object.freeze(incomeEndpointPinsSchema.parse(options.pins)); this.asset = incomeAddressSchema.parse(options.asset);
    const rpc = new URL(options.rpcUrl);
    if (rpc.username || rpc.password || rpc.hash || rpc.protocol !== 'https:' && !(rpc.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(rpc.hostname))) {
      throw new Error('Use a reviewed HTTPS or loopback Selection RPC');
    }
    this.client = createPublicClient({ transport: http(rpc.href, { retryCount: 0, timeout: 10_000, fetchFn: rpcFetch }), cacheTime: 0 });
  }
  private async anchor() {
    const pins = this.pins, head = await this.client.getBlockNumber({ cacheTime: 0 });
    if (head < BigInt(pins.confirmations)) throw new Error('Income endpoint confirmation depth');
    const height = head - BigInt(pins.confirmations);
    const [chain, latest, block] = await Promise.all([this.client.getChainId(), this.client.getBlock({ blockNumber: head }), this.client.getBlock({ blockNumber: height })]);
    if (chain !== pins.chainId || latest.number !== head || block.number !== height) throw new Error('Income endpoint chain anchor');
    const hash = incomeHashSchema.parse(block.hash), latestHash = incomeHashSchema.parse(latest.hash);
    const state = { blockHash: hash, requireCanonical: true } as const;
    const implementation = pins.vaultImplementationAddress, registry = pins.selectionRegistryAddress;
    const [code, historicalCode, implCode, historicalImplCode, token, escrow, controller, treasury, actualImpl,
      implToken, implEscrow, implController, implRegistry, implTreasury] = await Promise.all([
      this.client.getCode({ address: registry, blockHash: latestHash, requireCanonical: true }), this.client.getCode({ address: registry, ...state }),
      this.client.getCode({ address: implementation, blockHash: latestHash, requireCanonical: true }), this.client.getCode({ address: implementation, ...state }),
      this.client.readContract({ address: registry, abi: selectionAbi, functionName: 'token', ...state }),
      this.client.readContract({ address: registry, abi: selectionAbi, functionName: 'escrow', ...state }),
      this.client.readContract({ address: registry, abi: selectionAbi, functionName: 'controller', ...state }),
      this.client.readContract({ address: registry, abi: selectionAbi, functionName: 'treasury', ...state }),
      this.client.readContract({ address: registry, abi: selectionAbi, functionName: 'vaultImplementation', ...state }),
      this.client.readContract({ address: implementation, abi: vaultAbi, functionName: 'token', ...state }),
      this.client.readContract({ address: implementation, abi: vaultAbi, functionName: 'escrow', ...state }),
      this.client.readContract({ address: implementation, abi: vaultAbi, functionName: 'controller', ...state }),
      this.client.readContract({ address: implementation, abi: vaultAbi, functionName: 'registry', ...state }),
      this.client.readContract({ address: implementation, abi: vaultAbi, functionName: 'treasury', ...state }),
    ]);
    if (!code || !historicalCode || !implCode || !historicalImplCode || keccak256(code) !== pins.selectionRegistryCodeHash
      || keccak256(historicalCode) !== pins.selectionRegistryCodeHash || keccak256(implCode) !== pins.vaultImplementationCodeHash
      || keccak256(historicalImplCode) !== pins.vaultImplementationCodeHash || !equal(token, this.asset)
      || !equal(actualImpl, implementation) || !equal(implToken, token) || !equal(implEscrow, escrow)
      || !equal(implController, controller) || !equal(implRegistry, registry) || !equal(implTreasury, treasury)) throw new Error('Income endpoint reviewed deployment differs');
    return { block: incomeBlockSchema.parse({ number: height.toString(), hash, timestamp: block.timestamp.toString() }), headHash: latestHash };
  }
  async canonical(value: IncomeBlock): Promise<void> {
    const anchor = incomeBlockSchema.parse(value), height = BigInt(anchor.number);
    const [chain, block, head] = await Promise.all([this.client.getChainId(), this.client.getBlock({ blockNumber: height }), this.client.getBlockNumber({ cacheTime: 0 })]);
    if (chain !== this.pins.chainId || block.number !== height || block.hash !== anchor.hash || block.timestamp.toString() !== anchor.timestamp
      || head < height + BigInt(this.pins.confirmations)) throw new Error('Income endpoint canonical history changed');
  }
  async check(): Promise<void> { const anchor = await this.anchor(); await this.canonical(anchor.block); }
  async snapshot(rawId: string): Promise<IncomeSnapshot> {
    const agentId = incomeHashSchema.parse(rawId), anchor = await this.anchor(), block = anchor.block;
    const state = { blockHash: block.hash, requireCanonical: true } as const;
    const agent = await this.client.readContract({ address: this.pins.selectionRegistryAddress, abi: selectionAbi, functionName: 'getAgent', args: [agentId], ...state });
    if (agent.status === 0) throw new IncomeEndpointUnknownAgentError();
    const [walletId, vaultId, code, currentCode, owner, wallet, cloneId] = await Promise.all([
      this.client.readContract({ address: this.pins.selectionRegistryAddress, abi: selectionAbi, functionName: 'agentWalletAgent', args: [agent.agentWallet], ...state }),
      this.client.readContract({ address: this.pins.selectionRegistryAddress, abi: selectionAbi, functionName: 'vaultAgent', args: [agent.vault], ...state }),
      this.client.getCode({ address: agent.vault, ...state }),
      this.client.getCode({ address: agent.vault, blockHash: anchor.headHash, requireCanonical: true }),
      this.client.readContract({ address: agent.vault, abi: vaultAbi, functionName: 'owner', ...state }),
      this.client.readContract({ address: agent.vault, abi: vaultAbi, functionName: 'agentWallet', ...state }),
      this.client.readContract({ address: agent.vault, abi: vaultAbi, functionName: 'agentId', ...state }),
    ]);
    const expectedCode = `0x363d3d373d3d3d363d73${this.pins.vaultImplementationAddress.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    if (walletId !== agentId || vaultId !== agentId || cloneId !== agentId || !code || !currentCode || !equal(code, expectedCode) || !equal(currentCode, expectedCode)
      || !equal(owner, agent.owner) || !equal(wallet, agent.agentWallet)) throw new Error('Income endpoint registered Vault differs');
    await this.canonical(block);
    return { binding: incomeBindingSchema.parse({ agentId, owner: agent.owner, agentWallet: agent.agentWallet, vault: agent.vault,
      status: agent.status, frozen: agent.frozen }), block };
  }
}
