import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeFunctionResult, keccak256, parseAbi, toFunctionSelector, toHex, type Hex } from 'viem';
import { z } from 'zod';
import { RpcCystRegistryReader } from '../src/cysts/registry-reader.js';
import { cystRegistryPinsSchema } from '../src/cysts/registry-types.js';

const owner = '0x1111111111111111111111111111111111111111';
const agentWallet = '0x2222222222222222222222222222222222222222';
const vault = '0x3333333333333333333333333333333333333333';
const registryAddress = '0x4444444444444444444444444444444444444444';
const selectionAddress = '0x5555555555555555555555555555555555555555';
const hash = (label: string) => keccak256(toHex(label));
const zero: Hex = `0x${'0'.repeat(64)}`;
const agentId = hash('independent-reader-agent'), headHash = hash('head-100');
const confirmedHash = hash('fork-A-height-99'), otherHash = hash('fork-B-height-99');
const checkpointA = hash('checkpoint-only-on-fork-A'), checkpointB = hash('checkpoint-only-on-fork-B');
const registryCode: Hex = '0x60006000', selectionCode: Hex = '0x60016000';
const secret = 'rpc-provider-private-sentinel';
const pins = cystRegistryPinsSchema.parse({ chainId: 31337, registryAddress,
  registryCodeHash: keccak256(registryCode), selectionRegistryAddress: selectionAddress,
  selectionRegistryCodeHash: keccak256(selectionCode), confirmations: 1 });

// Independent wire vectors describe the contracts without calling production plan builders.
const registryAbi = parseAbi([
  'struct Cyst { bytes32 cystHash; uint64 sizeBytes; bytes32 storageRef; uint64 revision; uint64 committedAt; bool retired; }',
  'function selectionRegistry() view returns (address)',
  'function MAX_CYST_BYTES() view returns (uint64)',
  'function latest(bytes32 agentId) view returns (Cyst)',
]);
const selectionAbi = parseAbi([
  'struct Agent { uint256 identityId; address owner; address agentWallet; address vault; bytes32 leashId; bytes32 parent; bytes32 family; bytes32 cystHash; uint64 enteredAt; uint64 dormantAt; uint64 diedAt; uint64 lastPaidRun; uint64 lastActivationAt; uint64 deathAt; uint256 lifetimeIncome; uint256 lifetimeBurn; uint256 lifetimeSubsidy; uint256 lifetimeIncomeFees; uint8 livingChildren; uint8 status; bool frozen; }',
  'function getAgent(bytes32 agentId) view returns (Agent)',
  'function agentWalletAgent(address wallet) view returns (bytes32)',
]);
const agent = { identityId: 1n, owner, agentWallet, vault, leashId: zero, parent: zero, family: zero, cystHash: zero,
  enteredAt: 1n, dormantAt: 0n, diedAt: 0n, lastPaidRun: 0n, lastActivationAt: 1n, deathAt: 0n,
  lifetimeIncome: 0n, lifetimeBurn: 0n, lifetimeSubsidy: 0n, lifetimeIncomeFees: 0n, livingChildren: 0, status: 1, frozen: false } as const;
const requestSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]),
  method: z.string(), params: z.array(z.unknown()).default([]) }).strict();
type RpcRequest = z.infer<typeof requestSchema>;
type Mode = 'normal' | 'divergent' | 'unsupported' | 'reorg' | 'head-drop' | 'initial-depth'
  | 'oversized-header' | 'oversized-stream' | 'stalled' | 'rpc-error' | 'http-error' | 'invalid-utf8';
const blockRefSchema = z.object({ blockHash: z.string(), requireCanonical: z.literal(true) }).strict();

function block(number: bigint, blockHash: Hex) {
  return { number: toHex(number), hash: blockHash, parentHash: zero, nonce: '0x0000000000000000', sha3Uncles: zero,
    logsBloom: '0x' + '00'.repeat(256), transactionsRoot: zero, stateRoot: zero, receiptsRoot: zero, miner: owner,
    difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x0', gasLimit: '0x0', gasUsed: '0x0',
    timestamp: '0x1', transactions: [], uncles: [] };
}

describe('CystRegistry independent canonical reads over actual bounded HTTP JSON-RPC', () => {
  let api: Server, origin: string, mode: Mode, headReads: number, legacyReads: number;
  const requests: RpcRequest[] = [], blockReads = new Map<string, number>();

  function success(response: ServerResponse, request: RpcRequest, result: unknown): void {
    response.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  }
  function failure(response: ServerResponse, request: RpcRequest): void {
    response.end(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32602, message: secret + ': unsupported or noncanonical block reference' } }));
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const query = requestSchema.parse(JSON.parse(body)); requests.push(query);
    response.setHeader('Content-Type', 'application/json');
    if (mode === 'oversized-header') {
      response.setHeader('Content-Length', '262145'); response.end('{}'); return;
    }
    if (mode === 'oversized-stream') {
      response.write('x'.repeat(131_072)); response.write('x'.repeat(131_073)); response.end(); return;
    }
    if (mode === 'stalled') { response.write('{'); return; }
    if (mode === 'rpc-error') { failure(response, query); return; }
    if (mode === 'http-error') { response.statusCode = 500; response.end(secret); return; }
    if (mode === 'invalid-utf8') { response.end(Buffer.from([0xff, 0xfe])); return; }
    if (query.method === 'eth_blockNumber') {
      headReads++;
      success(response, query, mode === 'initial-depth' ? '0x0' : mode === 'head-drop' && headReads > 1 ? '0x63' : '0x64');
      return;
    }
    if (query.method === 'eth_chainId') { success(response, query, '0x7a69'); return; }
    if (query.method === 'eth_getBlockByNumber') {
      const tag = z.string().parse(query.params[0]), count = (blockReads.get(tag) ?? 0) + 1;
      blockReads.set(tag, count);
      if (tag === '0x64') success(response, query, block(100n, headHash));
      else if (tag === '0x63') success(response, query, block(99n, mode === 'reorg' && count > 1 ? otherHash : confirmedHash));
      else failure(response, query);
      return;
    }
    if (query.method !== 'eth_call' && query.method !== 'eth_getCode') { failure(response, query); return; }
    const reference = blockRefSchema.safeParse(query.params[1]);
    if (!reference.success) {
      legacyReads++;
      if (mode !== 'divergent') { failure(response, query); return; }
    } else if (reference.data.blockHash !== confirmedHash && reference.data.blockHash !== headHash
      || query.method === 'eth_call' && reference.data.blockHash !== confirmedHash) {
      failure(response, query); return;
    }
    if (mode === 'unsupported') { failure(response, query); return; }
    if (query.method === 'eth_getCode') {
      const address = z.string().parse(query.params[0]).toLowerCase();
      success(response, query, address === registryAddress ? registryCode : address === selectionAddress ? selectionCode : '0x');
      return;
    }
    const call = z.object({ to: z.string(), data: z.string() }).passthrough().parse(query.params[0]);
    const selector = call.data.slice(0, 10);
    if (selector === toFunctionSelector('selectionRegistry()')) {
      success(response, query, encodeFunctionResult({ abi: registryAbi, functionName: 'selectionRegistry', result: selectionAddress }));
    } else if (selector === toFunctionSelector('MAX_CYST_BYTES()')) {
      success(response, query, encodeFunctionResult({ abi: registryAbi, functionName: 'MAX_CYST_BYTES', result: 2_147_483_648n }));
    } else if (selector === toFunctionSelector('getAgent(bytes32)')) {
      success(response, query, encodeFunctionResult({ abi: selectionAbi, functionName: 'getAgent', result: agent }));
    } else if (selector === toFunctionSelector('agentWalletAgent(address)')) {
      success(response, query, encodeFunctionResult({ abi: selectionAbi, functionName: 'agentWalletAgent', result: agentId }));
    } else if (selector === toFunctionSelector('latest(bytes32)')) {
      // A number-based read can hit the divergent replica. A canonical A hash always resolves A state.
      success(response, query, encodeFunctionResult({ abi: registryAbi, functionName: 'latest', result: {
        cystHash: reference.success ? checkpointA : checkpointB, sizeBytes: 17n, storageRef: hash('locator-A'),
        revision: 1n, committedAt: 1n, retired: false } }));
    } else failure(response, query);
  }

  beforeAll(async () => {
    api = createServer((request, response) => { void handle(request, response).catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      response.end('{}');
    }); });
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const address = api.address(); if (!address || typeof address === 'string') throw new Error('Missing reader RPC address');
    origin = 'http://127.0.0.1:' + address.port;
  });
  beforeEach(() => { mode = 'normal'; headReads = 0; legacyReads = 0; requests.length = 0; blockReads.clear(); });
  afterAll(async () => { api?.closeAllConnections(); if (api) await new Promise<void>(resolve => api.close(() => resolve())); });
  const reader = () => new RpcCystRegistryReader({ rpcUrl: origin + '/private/' + secret, pins });

  it('pins every contract call and both current/historical code inventories to canonical block hashes', async () => {
    const snapshot = await reader().snapshot(agentId);
    expect(snapshot.current).toMatchObject({ cystHash: checkpointA, revision: '1', block: { number: '99', hash: confirmedHash } });
    const contractCalls = requests.filter(query => query.method === 'eth_call');
    expect(contractCalls).toHaveLength(5);
    for (const query of contractCalls) expect(query.params[1]).toEqual({ blockHash: confirmedHash, requireCanonical: true });
    const codeCalls = requests.filter(query => query.method === 'eth_getCode');
    expect(codeCalls).toHaveLength(4);
    expect(codeCalls.filter(query => blockRefSchema.parse(query.params[1]).blockHash === headHash)).toHaveLength(2);
    expect(codeCalls.filter(query => blockRefSchema.parse(query.params[1]).blockHash === confirmedHash)).toHaveLength(2);
    for (const query of codeCalls) expect(blockRefSchema.parse(query.params[1]).requireCanonical).toBe(true);
    expect(legacyReads).toBe(0);
    expect(blockReads.get('0x63')).toBeGreaterThanOrEqual(2);
  });

  it('never labels a divergent number-based fork checkpoint with the canonical anchor hash', async () => {
    mode = 'divergent';
    const snapshot = await reader().snapshot(agentId);
    expect(snapshot.current.block.hash).toBe(confirmedHash);
    expect(snapshot.current.cystHash).toBe(checkpointA);
    expect(snapshot.current.cystHash).not.toBe(checkpointB);
    expect(legacyReads).toBe(0);
  });

  it('fails closed when the RPC does not support canonical EIP-1898 references', async () => {
    mode = 'unsupported';
    await expect(reader().check()).rejects.toThrow('Cyst registry deployment unavailable or unreviewed');
    await expect(reader().snapshot(agentId)).rejects.toThrow('Cyst registry state unavailable or unreviewed');
    expect(legacyReads).toBe(0);
    expect(requests.filter(query => query.method === 'eth_call' || query.method === 'eth_getCode').length).toBeGreaterThan(0);
  });

  it.each(['reorg', 'head-drop'] as const)('rejects %s during the final canonical and confirmation-depth recheck', async value => {
    mode = value;
    await expect(reader().snapshot(agentId)).rejects.toThrow('Cyst registry state unavailable or unreviewed');
    expect(headReads).toBeGreaterThanOrEqual(2);
    expect(blockReads.get('0x63')).toBeGreaterThanOrEqual(2);
  });

  it('rejects an initially insufficient confirmation depth before any state/code requests', async () => {
    mode = 'initial-depth';
    await expect(reader().snapshot(agentId)).rejects.toThrow('Cyst registry state unavailable or unreviewed');
    expect(requests.map(query => query.method)).toEqual(['eth_blockNumber']);
  });

  it.each(['oversized-header', 'oversized-stream', 'rpc-error', 'http-error', 'invalid-utf8'] as const)
    ('bounds and redacts a %s RPC response', async value => {
      mode = value;
      let received: unknown;
      try { await reader().snapshot(agentId); } catch (error) { received = error; }
      expect(received).toBeInstanceOf(Error);
      expect(String(received)).toBe('Error: Cyst registry state unavailable or unreviewed');
      expect(String(received)).not.toContain(secret);
      expect(String(received)).not.toContain(origin);
    });

  it('aborts an unfinished RPC response and returns a redacted failure within the transport deadline', async () => {
    mode = 'stalled';
    const started = Date.now();
    await expect(reader().snapshot(agentId)).rejects.toThrow('Cyst registry state unavailable or unreviewed');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(requests.map(query => query.method)).toEqual(['eth_blockNumber']);
  }, 20_000);
});
