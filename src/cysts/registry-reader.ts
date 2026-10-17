import { createPublicClient, http, keccak256, parseAbi } from 'viem';
import { cystRegistryAbi, cystRegistryHashSchema, cystRegistryPinsSchema, cystRegistrySnapshotSchema,
  type CystRegistryPins, type CystRegistryReader, type CystRegistrySnapshot } from './registry-types.js';

const selectionAbi = parseAbi([
  'struct Agent { uint256 identityId; address owner; address agentWallet; address vault; bytes32 leashId; bytes32 parent; bytes32 family; bytes32 cystHash; uint64 enteredAt; uint64 dormantAt; uint64 diedAt; uint64 lastPaidRun; uint64 lastActivationAt; uint64 deathAt; uint256 lifetimeIncome; uint256 lifetimeBurn; uint256 lifetimeSubsidy; uint256 lifetimeIncomeFees; uint8 livingChildren; uint8 status; bool frozen; }',
  'function getAgent(bytes32 agentId) view returns (Agent)',
  'function agentWalletAgent(address wallet) view returns (bytes32)',
]);
export class CystRegistryUnknownAgentError extends Error {
  constructor() { super('Cyst agent is not registered'); this.name = 'CystRegistryUnknownAgentError'; }
}
async function boundedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  // Aborting fetch alone does not reliably settle an already-open body on every Node/RPC stack.
  // Race headers and each read against the same retained deadline, and explicitly cancel cleanup.
  const deadline = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      reject(new Error('Cyst registry RPC request cancelled or timed out'));
      controller.abort(); void reader?.cancel().catch(() => undefined);
    };
    timer = setTimeout(cancel, 10_000);
  });
  const external = init?.signal;
  if (external?.aborted) cancel(); else external?.addEventListener('abort', cancel, { once: true });
  try {
    const response = await Promise.race([fetch(input, { ...init, redirect: 'error', signal: controller.signal }), deadline]);
    if (!response.ok || Number(response.headers.get('content-length') ?? '0') > 262_144) {
      void response.body?.cancel().catch(() => undefined); throw new Error('Cyst registry RPC response rejected');
    }
    reader = response.body?.getReader(); if (!reader) throw new Error('Cyst registry RPC response missing');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const item = await Promise.race([reader.read(), deadline]); if (item.done) break;
      size += item.value.byteLength;
      if (size > 262_144) { void reader.cancel().catch(() => undefined); throw new Error('Cyst registry RPC response limit'); }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    // Validate the text before handing a bounded JSON-RPC response to viem.
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return new Response(body, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  } finally {
    clearTimeout(timer); external?.removeEventListener('abort', cancel);
    controller.abort(); reader?.releaseLock();
  }
}

/** Read-only RPC authority supplied independently of the API origin. Never signs or submits a transaction. */
export class RpcCystRegistryReader implements CystRegistryReader {
  readonly pins: CystRegistryPins;
  private readonly public;
  constructor(options: { rpcUrl: string; pins: CystRegistryPins }) {
    this.pins = Object.freeze(cystRegistryPinsSchema.parse(options.pins));
    const url = new URL(options.rpcUrl);
    if (url.username || url.password || url.hash || url.protocol !== 'https:'
      && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('Use a reviewed HTTPS or loopback Cyst registry RPC');
    }
    this.public = createPublicClient({ transport: http(url.toString(), { retryCount: 0, timeout: 10_000, fetchFn: boundedFetch }),
      cacheTime: 0 });
  }
  private async anchor() {
    const head = await this.public.getBlockNumber({ cacheTime: 0 });
    if (head < BigInt(this.pins.confirmations)) throw new Error('Cyst registry confirmation depth unavailable');
    const height = head - BigInt(this.pins.confirmations);
    const [chain, currentBlock, block] = await Promise.all([
      this.public.getChainId(), this.public.getBlock({ blockNumber: head }), this.public.getBlock({ blockNumber: height }),
    ]);
    if (currentBlock.number !== head || block.number !== height) throw new Error('Cyst registry block height differs');
    const hash = cystRegistryHashSchema.parse(block.hash), headHash = cystRegistryHashSchema.parse(currentBlock.hash);
    // EIP-1898 binds state to the exact canonical block, including across RPC replicas during a reorg.
    // A provider without this support fails closed; block-number fallback would lose that binding.
    const [registryCode, selectionCode, selection, maximum, historicalCode, historicalSelectionCode] = await Promise.all([
      this.public.getCode({ address: this.pins.registryAddress, blockHash: headHash, requireCanonical: true }),
      this.public.getCode({ address: this.pins.selectionRegistryAddress, blockHash: headHash, requireCanonical: true }),
      this.public.readContract({ address: this.pins.registryAddress, abi: cystRegistryAbi, functionName: 'selectionRegistry', blockHash: hash, requireCanonical: true }),
      this.public.readContract({ address: this.pins.registryAddress, abi: cystRegistryAbi, functionName: 'MAX_CYST_BYTES', blockHash: hash, requireCanonical: true }),
      this.public.getCode({ address: this.pins.registryAddress, blockHash: hash, requireCanonical: true }),
      this.public.getCode({ address: this.pins.selectionRegistryAddress, blockHash: hash, requireCanonical: true }),
    ]);
    if (chain !== this.pins.chainId || !registryCode || registryCode === '0x' || !selectionCode || selectionCode === '0x'
      || keccak256(registryCode) !== this.pins.registryCodeHash || keccak256(selectionCode) !== this.pins.selectionRegistryCodeHash) {
      throw new Error('Cyst registry deployment pins differ');
    }
    if (selection.toLowerCase() !== this.pins.selectionRegistryAddress.toLowerCase() || maximum !== 2_147_483_648n
      || !historicalCode || !historicalSelectionCode || keccak256(historicalCode) !== this.pins.registryCodeHash
      || keccak256(historicalSelectionCode) !== this.pins.selectionRegistryCodeHash) throw new Error('Cyst registry confirmed deployment differs');
    return { height, hash };
  }
  private async canonical(anchor: { height: bigint; hash: string }): Promise<void> {
    const [block, head] = await Promise.all([this.public.getBlock({ blockNumber: anchor.height }), this.public.getBlockNumber({ cacheTime: 0 })]);
    if (block.number !== anchor.height || block.hash !== anchor.hash || head < anchor.height + BigInt(this.pins.confirmations)) throw new Error('Cyst registry canonical block changed');
  }
  async check(): Promise<void> {
    try { const anchor = await this.anchor(); await this.canonical(anchor); }
    catch { throw new Error('Cyst registry deployment unavailable or unreviewed'); }
  }
  async snapshot(value: string): Promise<CystRegistrySnapshot> {
    const agentId = cystRegistryHashSchema.parse(value);
    try {
      const anchor = await this.anchor();
      const [agent, current] = await Promise.all([
        this.public.readContract({ address: this.pins.selectionRegistryAddress, abi: selectionAbi, functionName: 'getAgent', args: [agentId], blockHash: anchor.hash, requireCanonical: true }),
        this.public.readContract({ address: this.pins.registryAddress, abi: cystRegistryAbi, functionName: 'latest', args: [agentId], blockHash: anchor.hash, requireCanonical: true }),
      ]);
      if (agent.status === 0) throw new CystRegistryUnknownAgentError();
      const registeredId = await this.public.readContract({ address: this.pins.selectionRegistryAddress,
        abi: selectionAbi, functionName: 'agentWalletAgent', args: [agent.agentWallet], blockHash: anchor.hash, requireCanonical: true });
      if (registeredId !== agentId) throw new Error('Cyst agent key binding differs');
      await this.canonical(anchor);
      return cystRegistrySnapshotSchema.parse({ binding: { agentId, owner: agent.owner, agentWallet: agent.agentWallet,
        vault: agent.vault, status: agent.status, frozen: agent.frozen }, current: { agentId,
        cystHash: current.cystHash, sizeBytes: current.sizeBytes.toString(), storageRef: current.storageRef,
        revision: current.revision.toString(), committedAt: current.committedAt.toString(), retired: current.retired,
        block: { number: anchor.height.toString(), hash: anchor.hash } } });
    } catch (error) {
      if (error instanceof CystRegistryUnknownAgentError) throw error;
      throw new Error('Cyst registry state unavailable or unreviewed');
    }
  }
}
