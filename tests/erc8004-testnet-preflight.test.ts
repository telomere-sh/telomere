import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import { createReadOnlyRpc } from '../scripts/erc8004-testnet-preflight.js';
import { probeErc8004Testnet, type ReadOnlyErc8004Rpc } from '../scripts/erc8004-testnet-probe.js';

const identityCode = '0x60016000' as Hex;
const reputationCode = '0x60026000' as Hex;
const identityImplementationCode = '0x60036000' as Hex;
const reputationImplementationCode = '0x60046000' as Hex;
const identity = '0x1111111111111111111111111111111111111111' as Address;
const reputation = '0x2222222222222222222222222222222222222222' as Address;
const identityImplementation = '0x3333333333333333333333333333333333333333' as Address;
const reputationImplementation = '0x4444444444444444444444444444444444444444' as Address;
const owner = '0x5555555555555555555555555555555555555555' as Address;
const head = 133800010n;
const anchorHash = `0x${'a'.repeat(64)}` as Hex;
const historicalHash = '0xeabd25353444b167061be6432f1b7ccacfe8b95989a4520190b0efbec87867fd' as Hex;
const addr = (value: Address) => encodeAbiParameters([{ type: 'address' }], [value]);
const version = encodeAbiParameters([{ type: 'string' }], ['2.0.0']);
const candidate = { chainId: 46630, upstreamCommit: 'test-source',
  identity: { proxy: identity, proxyCodeHash: keccak256(identityCode), implementation: identityImplementation,
    implementationCodeHash: keccak256(identityImplementationCode), owner, version: '2.0.0' },
  reputation: { proxy: reputation, proxyCodeHash: keccak256(reputationCode), implementation: reputationImplementation,
    implementationCodeHash: keccak256(reputationImplementationCode), owner, version: '2.0.0' } } as const;

function fixture(changes: {
  wrongChain?: boolean; wrongImplementation?: boolean; wrongImplementationCode?: boolean;
  wrongLink?: boolean; reorg?: boolean; historicalState?: boolean;
} = {}): ReadOnlyErc8004Rpc {
  let anchorReads = 0;
  return { async request(method, params) {
    if (method === 'eth_chainId') return changes.wrongChain ? '0x1' : '0xb626';
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'latest') return { number: `0x${head.toString(16)}`, hash: anchorHash };
      if (params[0] === `0x${(head - 3n).toString(16)}`) {
        anchorReads++;
        return { number: `0x${(head - 3n).toString(16)}`,
          hash: changes.reorg && anchorReads > 1 ? `0x${'b'.repeat(64)}` : anchorHash };
      }
      if (params[0] === `0x${(133666836n).toString(16)}`) {
        return { number: `0x${(133666836n).toString(16)}`, hash: historicalHash };
      }
    }
    if (method === 'eth_getCode') {
      if (params[0] === identity) return identityCode;
      if (params[0] === reputation) return reputationCode;
      if (params[0] === identityImplementation) {
        return changes.wrongImplementationCode ? '0x60056000' : identityImplementationCode;
      }
      if (params[0] === reputationImplementation) return reputationImplementationCode;
    }
    if (method === 'eth_getStorageAt') {
      const pinned = params[2] as { blockHash: Hex };
      if (pinned.blockHash === historicalHash) {
        if (!changes.historicalState) throw new Error('historical state unavailable');
        return `0x${'0'.repeat(64)}`;
      }
      if (params[0] === identity) return addr(changes.wrongImplementation ? reputationImplementation : identityImplementation);
      if (params[0] === reputation) return addr(reputationImplementation);
    }
    if (method === 'eth_call') {
      const call = params[0] as { to: Address; data: Hex };
      if (call.data === '0xbc4d861b') return addr(changes.wrongLink ? reputation : identity);
      if (call.data === '0x8da5cb5b') return addr(owner);
      if (call.to === identity || call.to === reputation) return version;
    }
    throw new Error(`Unexpected read-only RPC call: ${method}`);
  } };
}

describe('ERC-8004 Robinhood testnet read-only preflight', () => {
  it('binds both proxy and implementation hashes, owner, version and identity link at one canonical block', async () => {
    const result = await probeErc8004Testnet(fixture({ historicalState: true }), candidate);
    expect(result.status).toBe('candidate_matches_observed_chain');
    expect(result.anchor.number).toBe((head - 3n).toString());
    expect(result.identity.implementationCodeHash).toBe(candidate.identity.implementationCodeHash);
    expect(result.reputationIdentityRegistry).toBe(identity);
    expect(result.historicalStateAvailable).toBe(true);
    expect(result.publisherEnabled).toBe(false);
    expect(result.readyForPublicPublication).toBe(false);
  });

  it('reports a missing archive state without elevating observed code to launch readiness', async () => {
    const result = await probeErc8004Testnet(fixture(), candidate);
    expect(result.historicalStateAvailable).toBe(false);
    expect(result.readyForPublicPublication).toBe(false);
  });

  it('fails closed on implementation slot or bytecode changes even if proxy code is unchanged', async () => {
    await expect(probeErc8004Testnet(fixture({ wrongImplementation: true }), candidate)).rejects.toThrow();
    await expect(probeErc8004Testnet(fixture({ wrongImplementationCode: true }), candidate)).rejects.toThrow('implementation code');
  });

  it('rejects wrong chain, reputation identity link and anchor reorg', async () => {
    await expect(probeErc8004Testnet(fixture({ wrongChain: true }), candidate)).rejects.toThrow('chain');
    await expect(probeErc8004Testnet(fixture({ wrongLink: true }), candidate)).rejects.toThrow('identity link');
    await expect(probeErc8004Testnet(fixture({ reorg: true }), candidate)).rejects.toThrow('anchor');
  });

  it('restricts transport to HTTPS and read-only JSON-RPC methods', async () => {
    expect(() => createReadOnlyRpc('http://example.test/')).toThrow('HTTPS');
    const rpc = createReadOnlyRpc('https://example.test/', async () => { throw new Error('fetch should not run'); });
    await expect(rpc.request('eth_sendRawTransaction' as never, [])).rejects.toThrow('read-only');
  });
});
