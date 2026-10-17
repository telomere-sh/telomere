import { decodeAbiParameters, getAddress, isHex, keccak256, toFunctionSelector, type Address, type Hex } from 'viem';

// Candidate pins observed on Robinhood Chain Testnet on 2026-10-13. They are not
// an authorization to enable feedback publication or an implementation audit.
export const erc8004TestnetCandidate = {
  chainId: 46630,
  upstreamCommit: 'b9e466c250744a7e06b13dff9d3c2844ed64f825',
  identity: {
    proxy: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    proxyCodeHash: '0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41',
    implementation: '0x7274e874ca62410a93bd8bf61c69d8045e399c02',
    implementationCodeHash: '0xa5f9624ea85e45b3f4b8558581f03bfb3e6cefab278d7bf0500ec9bd065dc16f',
    owner: '0x547289319c3e6aedb179c0b8e8af0b5acd062603',
    version: '2.0.0',
  },
  reputation: {
    proxy: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    proxyCodeHash: '0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41',
    implementation: '0x16e0fa7f7c56b9a767e34b192b51f921be31da34',
    implementationCodeHash: '0x38602de97f1bd86f0a4729f7f3c0a78b1d27892e6eb581272cce5504a68fd00b',
    owner: '0x547289319c3e6aedb179c0b8e8af0b5acd062603',
    version: '2.0.0',
  },
} as const;

const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const historicalAnchor = {
  number: 133666836n,
  hash: '0xeabd25353444b167061be6432f1b7ccacfe8b95989a4520190b0efbec87867fd',
} as const;

type RegistryPin = {
  proxy: Address; proxyCodeHash: Hex; implementation: Address; implementationCodeHash: Hex;
  owner: Address; version: string;
};
type Candidate = { chainId: number; upstreamCommit: string; identity: RegistryPin; reputation: RegistryPin };
export type ReadOnlyErc8004Rpc = {
  request(method: 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getCode' | 'eth_getStorageAt' | 'eth_call',
    params: readonly unknown[]): Promise<unknown>;
};

function hex(value: unknown, bytes?: number): Hex {
  if (typeof value !== 'string' || !isHex(value) || (value.length - 2) % 2 !== 0
    || bytes !== undefined && value.length !== 2 + bytes * 2) throw new Error('Invalid ERC-8004 RPC hex');
  return value as Hex;
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error('Invalid ERC-8004 RPC quantity');
  }
  return BigInt(value);
}
function block(value: unknown): { number: bigint; hash: Hex } {
  if (!value || typeof value !== 'object' || !('number' in value) || !('hash' in value)) {
    throw new Error('Missing ERC-8004 RPC block');
  }
  return { number: quantity(value.number), hash: hex(value.hash, 32) };
}
function addressWord(value: unknown): Address {
  const word = hex(value, 32);
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(word)) throw new Error('Invalid ERC-8004 address word');
  return getAddress(`0x${word.slice(-40)}`);
}
function sameAddress(a: Address, b: Address) { return a.toLowerCase() === b.toLowerCase(); }
function sameHex(a: Hex, b: Hex) { return a.toLowerCase() === b.toLowerCase(); }

async function observedRegistry(rpc: ReadOnlyErc8004Rpc, pin: RegistryPin, anchor: { blockHash: Hex; requireCanonical: true }) {
  const [proxyCodeRaw, implementationWord, ownerRaw, versionRaw] = await Promise.all([
    rpc.request('eth_getCode', [pin.proxy, anchor]),
    rpc.request('eth_getStorageAt', [pin.proxy, implementationSlot, anchor]),
    rpc.request('eth_call', [{ to: pin.proxy, data: toFunctionSelector('owner()') }, anchor]),
    rpc.request('eth_call', [{ to: pin.proxy, data: toFunctionSelector('getVersion()') }, anchor]),
  ]);
  const proxyCode = hex(proxyCodeRaw), implementation = addressWord(implementationWord);
  const owner = addressWord(ownerRaw);
  const [version] = decodeAbiParameters([{ type: 'string' }], hex(versionRaw));
  if (proxyCode === '0x' || !sameHex(keccak256(proxyCode), pin.proxyCodeHash)
    || !sameAddress(implementation, pin.implementation)
    || !sameAddress(owner, pin.owner) || version !== pin.version) {
    throw new Error('ERC-8004 proxy, implementation, owner or version differs from candidate');
  }
  const implementationCode = hex(await rpc.request('eth_getCode', [implementation, anchor]));
  if (implementationCode === '0x' || !sameHex(keccak256(implementationCode), pin.implementationCodeHash)) {
    throw new Error('ERC-8004 implementation code differs from candidate');
  }
  return { proxy: pin.proxy, proxyCodeHash: keccak256(proxyCode), implementation,
    implementationCodeHash: keccak256(implementationCode), owner, version };
}

/** All state reads use EIP-1898's canonical block-hash parameter. This routine
 * never sends, signs, estimates, or simulates a transaction. */
export async function probeErc8004Testnet(rpc: ReadOnlyErc8004Rpc,
  expected: Candidate = erc8004TestnetCandidate) {
  const chainId = Number(quantity(await rpc.request('eth_chainId', [])));
  if (chainId !== expected.chainId || chainId !== 46630) throw new Error('Wrong ERC-8004 chain');
  const head = block(await rpc.request('eth_getBlockByNumber', ['latest', false]));
  if (head.number < 4n) throw new Error('Insufficient ERC-8004 block depth');
  const number = head.number - 3n;
  const first = block(await rpc.request('eth_getBlockByNumber', [`0x${number.toString(16)}`, false]));
  if (first.number !== number) throw new Error('Incorrect ERC-8004 anchor block');
  const anchor = { blockHash: first.hash, requireCanonical: true } as const;
  const identity = await observedRegistry(rpc, expected.identity, anchor);
  const reputation = await observedRegistry(rpc, expected.reputation, anchor);
  const identityLink = addressWord(await rpc.request('eth_call', [
    { to: expected.reputation.proxy, data: toFunctionSelector('getIdentityRegistry()') }, anchor]));
  const after = block(await rpc.request('eth_getBlockByNumber', [`0x${number.toString(16)}`, false]));
  if (after.number !== first.number || !sameHex(after.hash, first.hash)
    || !sameAddress(identityLink, expected.identity.proxy)) {
    throw new Error('ERC-8004 anchor or identity link changed');
  }
  let historicalStateAvailable = false;
  try {
    const old = block(await rpc.request('eth_getBlockByNumber', [`0x${historicalAnchor.number.toString(16)}`, false]));
    if (old.number !== historicalAnchor.number || !sameHex(old.hash, historicalAnchor.hash)) {
      throw new Error('ERC-8004 historical anchor changed');
    }
    hex(await rpc.request('eth_getStorageAt', [expected.reputation.proxy, implementationSlot,
      { blockHash: old.hash, requireCanonical: true }]), 32);
    historicalStateAvailable = true;
  } catch (error) {
    if (error instanceof Error && error.message === 'ERC-8004 historical anchor changed') throw error;
  }
  return { status: 'candidate_matches_observed_chain', chainId, upstreamCommit: expected.upstreamCommit,
    anchor: { number: first.number.toString(), hash: first.hash }, identity, reputation,
    reputationIdentityRegistry: identityLink, historicalStateAvailable,
    publisherEnabled: false, readyForPublicPublication: false } as const;
}
