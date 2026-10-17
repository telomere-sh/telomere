import { createPublicClient, encodeFunctionData, http, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { canonical, Problem } from '../common.js';
import type { SelectionReputation } from './reputation.js';
import { erc1967ImplementationSlot, selectionReputationTargetProfileSchema, verifySelectionReputationImplementations,
  type ReviewedSelectionReputationTargetProfile, type SelectionReputationTargetProfile, type SelectionReputationImplementationState } from './reputation-deployment.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
const nonzeroAddress = address.refine(value => value !== '0x' + '00'.repeat(20));
export type { SelectionReputationTargetProfile } from './reputation-deployment.js';
type Profile = ReviewedSelectionReputationTargetProfile;
type Death = Awaited<ReturnType<SelectionReputation['death']>>;
export interface SelectionReputationTargetState { chainId: number; blockHash: string; identityAddress: string;
  reputationIdentityAddress: string; identityCodeHash: string; reputationCodeHash: string;
  owner: string; approvedAddress: string; approvedForAll: boolean; implementations: SelectionReputationImplementationState }
export interface SelectionReputationTargetReader {
  state(profile: Profile, death: Death): Promise<SelectionReputationTargetState>;
}
export const selectionReputationFeedbackAbi = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);
const targetAbi = parseAbi([
  'function identityRegistry() view returns(address)', 'function getIdentityRegistry() view returns(address)',
  'function ownerOf(uint256) view returns(address)', 'function getApproved(uint256) view returns(address)',
  'function isApprovedForAll(address,address) view returns(bool)',
]);
const unavailable = () => new Problem(503, 'selection_reputation_target_unavailable', 'Reviewed reputation target evidence is unavailable or changed.');

function boundedFetch(fetcher: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, abort: () => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
      abort = () => { reject(new Error('Reputation RPC deadline')); controller.abort(); void reader?.cancel().catch(() => undefined); };
      timer = setTimeout(abort, timeoutMs);
    });
    if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await Promise.race([fetcher(input, { ...init, redirect: 'error', signal: controller.signal }), deadline]);
      if (!response.ok || Number(response.headers.get('content-length') ?? '0') > 8 * 1024 * 1024) {
        void response.body?.cancel().catch(() => undefined); throw new Error('Reputation RPC response');
      }
      reader = response.body?.getReader(); if (!reader) throw new Error('Reputation RPC body');
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const item = await Promise.race([reader.read(), deadline]); if (item.done) break;
        size += item.value.byteLength; if (size > 8 * 1024 * 1024) throw new Error('Reputation RPC limit'); chunks.push(item.value); }
      return new Response(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
        { status: response.status, headers: { 'Content-Type': 'application/json' } });
    } finally { clearTimeout(timer); init?.signal?.removeEventListener('abort', abort); controller.abort(); reader?.releaseLock(); }
  };
}

/** Read-only historical target checks. No accounts, simulation, nonce, gas or broadcast methods. */
export function createSelectionReputationTargetReader(rpcUrl: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): SelectionReputationTargetReader {
  const url = new URL(rpcUrl);
  if (url.username || url.password || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
    throw new Error('Use HTTPS or a disposable loopback reputation RPC');
  }
  const timeoutMs = z.number().int().min(10).max(60_000).parse(options.timeoutMs ?? 10_000);
  const client = createPublicClient({ cacheTime: 0, transport: http(url.href, { retryCount: 0, timeout: timeoutMs,
    fetchFn: boundedFetch(options.fetch ?? fetch, timeoutMs), maxResponseBodySize: 8 * 1024 * 1024,
    methods: { include: ['eth_chainId', 'eth_getBlockByNumber', 'eth_blockNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call'] } }) });
  return { state: async (profile, death) => {
    try {
      const blockNumber = BigInt(death.index.indexedThrough), identityId = BigInt(death.summary.identityId);
      // REASON: the profile and index boundary schemas prove the address representation.
      const identity = profile.identityAddress as Address, reputation = profile.reputationAddress as Address,
        registry = death.index.registryAddress as Address, publisher = profile.publisherAddress as Address;
      // REASON: the canonical feed validates the indexed hash; EIP-1898 pins every state read to that exact block.
      const state = { blockHash: death.index.blockHash as Hex, requireCanonical: true } as const;
      const [chainId, before, head, identityCode, reputationCode, sourceIdentity, targetIdentity, owner, approved] = await Promise.all([
        client.getChainId(), client.getBlock({ blockNumber }), client.getBlockNumber(),
        client.getCode({ address: identity, ...state }), client.getCode({ address: reputation, ...state }),
        client.readContract({ address: registry, abi: targetAbi, functionName: 'identityRegistry', ...state }),
        client.readContract({ address: reputation, abi: targetAbi, functionName: 'getIdentityRegistry', ...state }),
        client.readContract({ address: identity, abi: targetAbi, functionName: 'ownerOf', args: [identityId], ...state }),
        client.readContract({ address: identity, abi: targetAbi, functionName: 'getApproved', args: [identityId], ...state }),
      ]);
      const [approvedForAll, implementations] = await Promise.all([
        client.readContract({ address: identity, abi: targetAbi, functionName: 'isApprovedForAll', args: [owner, publisher], ...state }),
        verifySelectionReputationImplementations(profile,
          address => client.getStorageAt({ address, slot: erc1967ImplementationSlot, ...state }),
          address => client.getCode({ address, ...state })),
      ]);
      const after = await client.getBlock({ blockNumber });
      if (before.hash !== death.index.blockHash || after.hash !== before.hash || head < blockNumber + BigInt(death.index.confirmations)
        || !identityCode || identityCode === '0x' || !reputationCode || reputationCode === '0x') throw unavailable();
      return { chainId, blockHash: after.hash, identityAddress: sourceIdentity.toLowerCase(), reputationIdentityAddress: targetIdentity.toLowerCase(),
        identityCodeHash: keccak256(identityCode), reputationCodeHash: keccak256(reputationCode), owner: owner.toLowerCase(),
        approvedAddress: approved.toLowerCase(), approvedForAll, implementations };
    } catch { throw unavailable(); }
  } };
}

/** Prepares an unsigned lifespan feedback with the complete exact death summary.
 * It does not publish, persist signed bytes, choose an economic score or claim finality.
 */
export class SelectionReputationPlanner {
  readonly profile: Profile;
  constructor(private readonly feed: SelectionReputation, profile: SelectionReputationTargetProfile, private readonly reader: SelectionReputationTargetReader) {
    this.profile = Object.freeze(selectionReputationTargetProfileSchema.parse(profile));
  }
  async prepare(agentId: string) {
    const death = await this.feed.death(agentId), profile = this.profile;
    if (profile.chainId !== death.index.chainId || profile.deploymentKind === 'direct' && profile.chainId !== 31337) throw unavailable();
    const origin = await this.feed.origin(agentId);
    if (origin.feedbackHash !== death.feedbackHash || origin.index.revision !== death.index.revision
      || origin.index.blockHash !== death.index.blockHash || !nonzeroAddress.safeParse(origin.owner).success) throw unavailable();
    let state: SelectionReputationTargetState;
    try { state = await this.reader.state(profile, death); } catch { throw unavailable(); }
    if (state.chainId !== profile.chainId || state.blockHash !== death.index.blockHash || state.identityAddress !== profile.identityAddress
      || state.reputationIdentityAddress !== profile.identityAddress || state.identityCodeHash !== profile.identityCodeHash
      || state.reputationCodeHash !== profile.reputationCodeHash || !nonzeroAddress.safeParse(state.owner).success
      || !address.safeParse(state.approvedAddress).success || typeof state.approvedForAll !== 'boolean'
      || (profile.deploymentKind === 'direct' && (state.implementations?.identityImplementationAddress !== null
        || state.implementations?.reputationImplementationAddress !== null))
      || (profile.deploymentKind === 'erc1967' && (state.implementations?.identityImplementationAddress !== profile.identityImplementationAddress
        || state.implementations?.identityImplementationCodeHash !== profile.identityImplementationCodeHash
        || state.implementations?.reputationImplementationAddress !== profile.reputationImplementationAddress
        || state.implementations?.reputationImplementationCodeHash !== profile.reputationImplementationCodeHash))) throw unavailable();
    if (state.owner.toLowerCase() !== origin.owner) throw new Problem(409, 'selection_reputation_identity_owner_changed',
      'The identity NFT owner differs from the canonical Selection birth owner.');
    if ([address.parse(state.owner), address.parse(state.approvedAddress)].includes(profile.publisherAddress) || state.approvedForAll) {
      throw new Problem(422, 'selection_reputation_self_feedback', 'Reputation publisher must be independent of the identity owner and its approved operators.');
    }
    // ERC-8004's example JSON uses numeric agentId/value. Do not round its uint256/int128 fields in JSON.
    const identityId = BigInt(death.summary.identityId), lifespan = BigInt(death.summary.lifespanSeconds), diedAt = BigInt(death.summary.evidence.diedAtSeconds);
    if (identityId > BigInt(Number.MAX_SAFE_INTEGER) || lifespan > BigInt(Number.MAX_SAFE_INTEGER) || diedAt > 253_402_300_799n) {
      throw new Problem(422, 'selection_reputation_json_range', 'The feedback file cannot represent these registry values as exact JSON numbers.');
    }
    const feedback = { agentRegistry: `eip155:${profile.chainId}:${profile.identityAddress}`, agentId: Number(identityId),
      clientAddress: `eip155:${profile.chainId}:${profile.publisherAddress}`, createdAt: new Date(Number(diedAt) * 1000).toISOString(),
      value: Number(lifespan), valueDecimals: 0, tag1: 'lifespan', tag2: 'telomere.death.v1', endpoint: '', summary: death.summary };
    const content = canonical(feedback), feedbackHash = keccak256(toHex(content)), feedbackURI = 'data:application/json;base64,' + Buffer.from(content).toString('base64');
    const data = encodeFunctionData({ abi: selectionReputationFeedbackAbi, functionName: 'giveFeedback',
      args: [identityId, lifespan, 0, feedback.tag1, feedback.tag2, '', feedbackURI, feedbackHash] });
    const current = await this.feed.death(agentId), currentOrigin = await this.feed.origin(agentId);
    if (current.feedbackHash !== death.feedbackHash || current.index.revision !== death.index.revision
      || current.index.blockHash !== death.index.blockHash || currentOrigin.owner !== origin.owner
      || currentOrigin.feedbackHash !== current.feedbackHash || currentOrigin.index.revision !== current.index.revision
      || currentOrigin.index.blockHash !== current.index.blockHash) throw unavailable();
    return { state: 'unsigned' as const, chainId: profile.chainId, from: profile.publisherAddress, to: profile.reputationAddress, value: '0', data,
      feedbackHash, feedbackURI, feedbackContent: content, originalOwner: origin.owner, deathSummaryHash: death.feedbackHash, index: death.index,
      coverage: death.coverage, numericSignal: 'lifespan-seconds' as const, publicationConfirmed: false as const };
  }
}
