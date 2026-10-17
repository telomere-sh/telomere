import { encodeFunctionData, keccak256, type Hex } from 'viem';
import { z } from 'zod';

const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase());
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/).transform(value => BigInt(value)).refine(value => value <= 2n ** 63n - 1n);
const logSchema = z.object({ address, blockHash: hash, blockNumber: quantity, transactionHash: hash,
  logIndex: quantity.refine(value => value <= 2n ** 31n - 1n).transform(Number), topics: z.array(hash).min(1).max(4),
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(8194), removed: z.literal(false).optional() }).passthrough();
export interface SelectionBlock { height: bigint; hash: string; parentHash: string; timestamp: bigint }
export interface SelectionLog { address: string; blockHash: string; height: bigint; transactionHash: string; logIndex: number; topics: readonly Hex[]; data: Hex }
export interface SelectionReader {
  chainId(): Promise<number>; head(): Promise<bigint>; block(height: bigint): Promise<SelectionBlock>;
  logs(from: bigint, to: bigint, addresses: readonly string[]): Promise<SelectionLog[]>;
  codeHash(address: string): Promise<string>;
  spendableBalance(vault: string, at: bigint): Promise<string>;
}
export function createSelectionReader(rpcUrl: string, options: { timeoutMs?: number; fetch?: typeof fetch } = {}): SelectionReader {
  let url: URL; try { url = new URL(rpcUrl); } catch { throw new Error('Invalid Selection RPC origin'); }
  if (url.username || url.password || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('Use HTTPS or a disposable loopback Selection RPC');
  const timeout = options.timeoutMs ?? 10_000; if (!Number.isInteger(timeout) || timeout < 10 || timeout > 60_000) throw new Error('Invalid Selection RPC timeout');
  let sequence = 0; const fetcher = options.fetch ?? fetch;
  async function request(method: string, params: unknown[]): Promise<unknown> {
    const id = ++sequence;
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    // Retain one deadline for headers and all body reads. A custom fetch/body
    // may not observe abort, and cancellation itself must not hold this request.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Selection RPC deadline'));
        controller.abort(); void reader?.cancel().catch(() => undefined);
      }, timeout);
    });
    try {
      const response = await Promise.race([fetcher(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: controller.signal }), deadline]);
      if (!response.ok || Number(response.headers.get('content-length') ?? '0') > 8 * 1024 * 1024) { void response.body?.cancel().catch(() => undefined); throw new Error('response'); }
      reader = response.body?.getReader(); if (!reader) throw new Error('body'); const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const part = await Promise.race([reader.read(), deadline]); if (part.done) break; size += part.value.byteLength;
        if (size > 8 * 1024 * 1024) { void reader.cancel().catch(() => undefined); throw new Error('limit'); } chunks.push(part.value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
      const parsed = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(id), result: z.unknown() }).strict().parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (!Object.hasOwn(parsed, 'result')) throw new Error('missing result'); return parsed.result;
    } catch { throw new Error('Selection RPC request failed'); }
    finally { clearTimeout(timer); controller.abort(); reader?.releaseLock(); }
  }
  const hex = (value: bigint) => '0x' + value.toString(16);
  return {
    chainId: async () => Number(quantity.parse(await request('eth_chainId', []))),
    head: async () => quantity.parse(await request('eth_blockNumber', [])),
    block: async height => { const value = z.object({ number: quantity, hash, parentHash: hash, timestamp: quantity }).passthrough().parse(await request('eth_getBlockByNumber', [hex(height), false]));
      if (value.number !== height) throw new Error('Selection RPC changed requested block'); return { height, hash: value.hash, parentHash: value.parentHash, timestamp: value.timestamp }; },
    logs: async (from, to, addresses) => {
      const values = z.array(logSchema).max(5000).parse(await request('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), address: addresses }]));
      return values.map(value => ({ address: value.address, blockHash: value.blockHash, height: value.blockNumber, transactionHash: value.transactionHash,
        logIndex: value.logIndex, topics: value.topics as Hex[], data: value.data as Hex }));
    },
    codeHash: async contract => { const code = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(131074).parse(await request('eth_getCode', [address.parse(contract), 'latest'])); return keccak256(code as Hex); },
    spendableBalance: async (vault, at) => {
      const data = encodeFunctionData({ abi: [{ type: 'function', name: 'spendableBalance', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }], functionName: 'spendableBalance' });
      const value = z.string().regex(/^0x[0-9a-fA-F]{64}$/).parse(await request('eth_call', [{ to: address.parse(vault), data }, hex(at)])); return BigInt(value).toString();
    },
  };
}
