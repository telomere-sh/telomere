import { asc, eq, sql } from 'drizzle-orm';
import { createPublicClient, createWalletClient, decodeFunctionData, defineChain, encodeFunctionData, getAddress, http, keccak256,
  parseAbi, parseEventLogs, parseTransaction, recoverTransactionAddress, toHex, TransactionReceiptNotFoundError,
  type Address, type Hex, type TransactionReceipt, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { bytes32Schema, canonical, hashJson, Problem } from '../common.js';
import type { Database } from '../store.js';
import { PlatformTransactions } from '../platform-runtime/transactions.js';
import { platformTransactionJournal } from '../platform-runtime/schema.js';
import type { SelectionIndexer } from './indexer.js';
import { SelectionReputation } from './reputation.js';
import { createSelectionReputationTargetReader, SelectionReputationPlanner, selectionReputationFeedbackAbi,
  type SelectionReputationTargetProfile } from './reputation-feedback.js';
import { erc1967ImplementationSlot, verifySelectionReputationImplementations } from './reputation-deployment.js';
import { selectionReputationPublications, selectionReputationPublisherBinding, selectionReputationPublisherDDL,
  type SelectionReputationPublicationPlan } from './reputation-publisher-schema.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => getAddress(value).toLowerCase());
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const units = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(value => BigInt(value) < 2n ** 256n);
const planSchema = z.object({ agentId: hash, identityId: units, originalOwner: address, summaryHash: hash, sourceHeight: units,
  feedbackHash: hash, feedbackURI: z.string().min(1).max(44_000), feedbackContent: z.string().min(1).max(32_768),
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(100_000) }).strict();
export const selectionReputationPublisherAbi = parseAbi([
  'function revokeFeedback(uint256 agentId,uint64 feedbackIndex)',
  'function getLastIndex(uint256 agentId,address clientAddress) view returns(uint64)',
  'function readFeedback(uint256 agentId,address clientAddress,uint64 feedbackIndex) view returns(int128 value,uint8 valueDecimals,string tag1,string tag2,bool isRevoked)',
  'event NewFeedback(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,int128 value,uint8 valueDecimals,string indexed indexedTag1,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)',
  'event FeedbackRevoked(uint256 indexed agentId,address indexed clientAddress,uint64 indexed feedbackIndex)',
]);
const permissionAbi = parseAbi([
  'function identityRegistry() view returns(address)', 'function getIdentityRegistry() view returns(address)',
  'function ownerOf(uint256) view returns(address)', 'function getApproved(uint256) view returns(address)',
  'function isApprovedForAll(address,address) view returns(bool)',
]);
const unavailable = () => new Problem(503, 'selection_reputation_publication_unavailable', 'Canonical reputation publication evidence is unavailable; retain the original journal and retry.');
const recovery = () => new Problem(409, 'selection_reputation_republication_requires_review', 'Restored death evidence has a revocation intent; an operator must review its original transaction before republishing.');
const existingFeedback = () => new Problem(409, 'selection_reputation_existing_feedback_requires_review',
  'The dedicated publisher has prior feedback outside its canonically revoked journal history; operator review is required.');
const transferred = () => new Problem(409, 'selection_reputation_identity_owner_changed',
  'The identity NFT owner differs from the canonical Selection birth owner; publication remains stopped after cleanup.');
const permissionChanged = () => new Problem(409, 'selection_reputation_publisher_permission_changed',
  'The publisher became the identity owner or an approved operator; publication remains stopped after cleanup.');
const reviewCodes = new Set(['selection_reputation_republication_requires_review', 'selection_reputation_original_intent_unresolved',
  'selection_reputation_existing_feedback_requires_review', 'selection_reputation_identity_owner_changed',
  'selection_reputation_publisher_permission_changed',
  'platform_nonce_pending', 'platform_nonce_consumed']);
function reviewProblem(error: unknown): error is Problem { return error instanceof Problem && reviewCodes.has(error.code); }
type Publication = typeof selectionReputationPublications.$inferSelect;
type Snapshot = Awaited<ReturnType<SelectionReputation['page']>>;
type Death = Snapshot['summaries'][number];

/** One deadline covers both RPC headers and the entire bounded response body. */
function boundedFetch(fetcher: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('Reputation publication RPC deadline')); controller.abort(); void reader?.cancel().catch(() => undefined); }, timeoutMs);
    });
    const abort = () => { controller.abort(); void reader?.cancel().catch(() => undefined); };
    if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await Promise.race([fetcher(input, { ...init, redirect: 'error', signal: controller.signal }), deadline]);
      if (!response.ok || Number(response.headers.get('content-length') ?? '0') > 8 * 1024 * 1024) {
        void response.body?.cancel().catch(() => undefined); throw unavailable();
      }
      reader = response.body?.getReader(); if (!reader) throw unavailable();
      const parts: Uint8Array[] = []; let length = 0;
      while (true) { const part = await Promise.race([reader.read(), deadline]); if (part.done) break;
        length += part.value.byteLength; if (length > 8 * 1024 * 1024) throw unavailable(); parts.push(part.value); }
      return new Response(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)),
        { status: response.status, headers: { 'Content-Type': 'application/json' } });
    } finally { clearTimeout(timer); init?.signal?.removeEventListener('abort', abort); controller.abort(); reader?.releaseLock(); }
  };
}

export interface SelectionReputationPublisherOptions {
  /** Loading a key alone never authorizes publication. */
  authorised: true; profile: SelectionReputationTargetProfile; rpcUrl: string; signerPrivateKey: Hex;
  /** Actual application signer addresses, supplied by the composition root. */
  financialSigners: readonly string[]; confirmations?: number; maxPublications?: number;
  timeoutMs?: number; fetch?: typeof fetch;
}

/** Opt-in, durable ERC-8004 death publication. No HTTP route can invoke it.
 * A revoked summary is never automatically republished; restoration requires review.
 */
export class SelectionReputationPublisher {
  readonly planner: SelectionReputationPlanner;
  readonly profile: SelectionReputationPlanner['profile'];
  private readonly rpc;
  private readonly transactions: PlatformTransactions;
  private readonly confirmations: number;
  private readonly maximum: number;
  private readonly binding: string;
  private readonly source: SelectionIndexer['profile'];
  private readonly sourceIndexKey: string;
  #initializing: Promise<void> | undefined;
  #maintaining: Promise<{ published: number; revoked: number; retracted: number }> | undefined;

  constructor(private readonly db: Database, private readonly feed: SelectionReputation, indexer: SelectionIndexer,
    options: SelectionReputationPublisherOptions) {
    if (options.authorised !== true) throw new Error('Reputation publication requires explicit operator authorization');
    this.planner = new SelectionReputationPlanner(feed, options.profile,
      createSelectionReputationTargetReader(options.rpcUrl, { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }));
    this.profile = this.planner.profile;
    this.source = Object.freeze({ ...indexer.profile }); this.sourceIndexKey = indexer.indexKey;
    const financialSigners = z.array(address).min(1).max(32).parse(options.financialSigners).sort();
    const account = privateKeyToAccount(bytes32Schema.parse(options.signerPrivateKey));
    if (account.address.toLowerCase() !== this.profile.publisherAddress || financialSigners.includes(this.profile.publisherAddress)
      || this.profile.deploymentKind === 'direct' && this.profile.chainId !== 31337
      || this.profile.chainId !== indexer.profile.chainId || !indexer.profile.registryCodeHash) {
      throw new Error('Reputation requires a dedicated publisher and pinned source on the same reviewed chain');
    }
    const url = new URL(options.rpcUrl), loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)
      || this.profile.chainId === 31337 && !loopback) throw new Error('Reputation publication RPC requires HTTPS or a disposable loopback chain');
    this.confirmations = z.number().int().min(0).max(10_000).parse(options.confirmations ?? 1);
    if (this.profile.chainId !== 31337 && this.confirmations < 1) throw new Error('Public reputation requires confirmed receipts');
    if (this.profile.chainId !== 31337 && this.source.confirmations < 1) throw new Error('Public reputation requires confirmed source evidence');
    this.maximum = z.number().int().min(1).max(4096).parse(options.maxPublications ?? 1024);
    const timeout = z.number().int().min(10).max(60_000).parse(options.timeoutMs ?? 10_000);
    const transport = http(url.href, { retryCount: 0, timeout, fetchFn: boundedFetch(options.fetch ?? fetch, timeout), maxResponseBodySize: 8 * 1024 * 1024 });
    const chain = defineChain({ id: this.profile.chainId, name: 'Telomere reviewed reputation target',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url.href] } } });
    this.rpc = createPublicClient({ cacheTime: 0, chain, transport });
    this.transactions = new PlatformTransactions(db, this.rpc, createWalletClient({ account, chain, transport }), this.profile.chainId);
    this.binding = canonical({ version: 1, target: this.profile, source: this.source, financialSigners,
      confirmations: this.confirmations, maximum: this.maximum });
  }

  async initialize(): Promise<void> {
    if (!this.#initializing) this.#initializing = this.bind();
    try { await this.#initializing; } catch (error) { this.#initializing = undefined; throw error; }
  }
  private async bind(): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(728419149)`);
      for (const statement of selectionReputationPublisherDDL.split(';').map(value => value.trim()).filter(Boolean)) await tx.execute(sql.raw(statement));
      const [saved] = await tx.select().from(selectionReputationPublisherBinding).where(eq(selectionReputationPublisherBinding.id, 1));
      if (!saved) {
        const rows = await tx.select().from(selectionReputationPublications).limit(1);
        if (rows.length) throw new Error('Unbound reputation publication history requires operator review');
        await tx.insert(selectionReputationPublisherBinding).values({ id: 1, profileHash: hashJson(this.binding), profile: this.binding });
      } else if (saved.profile !== this.binding || saved.profileHash !== hashJson(this.binding)) {
        throw new Error('Reputation publisher database belongs to another immutable profile');
      }
    });
  }

  /** Read-only status never returns transaction bytes, keys or RPC locations. */
  async status() {
    await this.initialize();
    const rows = await this.db.select().from(selectionReputationPublications).orderBy(asc(selectionReputationPublications.summaryHash)).limit(this.maximum + 1);
    if (rows.length > this.maximum) throw unavailable();
    return { enabled: true as const, publisher: this.profile.publisherAddress, chainId: this.profile.chainId,
      publications: rows.map(row => ({ summaryHash: row.summaryHash, state: row.state, feedbackHash: row.plan.feedbackHash,
        transactionHash: row.transactionHash, feedbackIndex: row.feedbackIndex, revokeTransactionHash: row.revokeTransactionHash })) };
  }

  async maintain(): Promise<{ published: number; revoked: number; retracted: number }> {
    if (this.#maintaining) return this.#maintaining;
    this.#maintaining = this.work();
    try { return await this.#maintaining; } finally { this.#maintaining = undefined; }
  }
  private async snapshot(): Promise<{ index: Snapshot['index']; deaths: Map<string, Death> }> {
    const first = await this.feed.page({ limit: 100 }), deaths = new Map(first.summaries.map(value => [value.summary.agentId, value]));
    if (first.index.indexKey !== this.sourceIndexKey || first.index.chainId !== this.source.chainId
      || first.index.registryAddress !== this.source.registryAddress || first.index.confirmations !== this.source.confirmations) throw unavailable();
    let cursor = first.nextCursor;
    // Every page retains the first canonical index revision; a mid-snapshot sync fails closed.
    for (let pages = 1; cursor && pages < 11; pages++) {
      const next = await this.feed.page({ limit: 100, cursor });
      if (next.index.revision !== first.index.revision || next.index.blockHash !== first.index.blockHash) throw unavailable();
      for (const death of next.summaries) { if (deaths.has(death.summary.agentId)) throw unavailable(); deaths.set(death.summary.agentId, death); }
      cursor = next.nextCursor;
    }
    if (cursor || deaths.size !== first.pagination.totalRowsInSnapshot || deaths.size > this.source.maxVaults) throw unavailable();
    const [chain, head, anchor] = await Promise.all([this.rpc.getChainId(), this.rpc.getBlockNumber(),
      this.rpc.getBlock({ blockNumber: BigInt(first.index.indexedThrough) })]);
    if (chain !== this.source.chainId || head < BigInt(this.source.confirmations)
      || BigInt(first.index.indexedThrough) !== head - BigInt(this.source.confirmations) || anchor.hash !== first.index.blockHash) throw unavailable();
    return { index: first.index, deaths };
  }
  private async work() {
    try {
      await this.initialize();
      const [binding] = await this.db.select().from(selectionReputationPublisherBinding).where(eq(selectionReputationPublisherBinding.id, 1));
      if (binding?.profile !== this.binding || binding.profileHash !== hashJson(this.binding)) throw unavailable();
      const snapshot = await this.snapshot();
      // Empty death feeds still need live proxy and implementation evidence before readiness can turn green.
      await this.verifyDeploymentAt(BigInt(snapshot.index.indexedThrough), snapshot.index.blockHash as Hex);
      const head = await this.rpc.getBlock({ blockTag: 'latest' });
      await this.verifyDeploymentAt(head.number, head.hash);
      const rows = await this.db.select().from(selectionReputationPublications)
        .orderBy(asc(selectionReputationPublications.summaryHash)).limit(this.maximum + 1);
      if (rows.length > this.maximum) throw unavailable();
      let published = 0, revoked = 0, retracted = 0;
      const unresolvedAgents = new Set<string>(), unsafeAgents = new Map<string, Problem>();
      let reviewError: Problem | undefined;
      // Resolve old source generations before admitting any replacement feedback.
      for (const row of rows) {
        const plan = this.checkedPlan(row), current = snapshot.deaths.get(plan.agentId);
        if (current?.feedbackHash === plan.summaryHash) {
          const origin = await this.feed.origin(plan.agentId);
          if (origin.feedbackHash !== plan.summaryHash || origin.owner !== plan.originalOwner
            || origin.index.revision !== snapshot.index.revision || origin.index.blockHash !== snapshot.index.blockHash) throw unavailable();
          const target = await this.currentTarget(plan.identityId);
          if (target.owner === plan.originalOwner && target.independent) continue;
          const result = await this.retract(row, true);
          revoked += result === 'revoked' ? 1 : 0; retracted += result === 'retracted' ? 1 : 0;
          const reason = target.owner !== plan.originalOwner ? transferred() : permissionChanged();
          unsafeAgents.set(plan.agentId, reason); reviewError ??= reason; continue;
        }
        if (BigInt(snapshot.index.indexedThrough) < BigInt(plan.sourceHeight)) throw unavailable();
        const result = await this.retract(row); revoked += result === 'revoked' ? 1 : 0; retracted += result === 'retracted' ? 1 : 0;
        if (!await this.observed(plan, 'publish', this.hex(plan.data)) && await this.hasIntent(plan, 'publish')) unresolvedAgents.add(plan.agentId);
      }
      const existing = new Set(rows.map(row => row.summaryHash));
      for (const death of snapshot.deaths.values()) {
        try {
          const unsafe = unsafeAgents.get(death.summary.agentId); if (unsafe) throw unsafe;
          if (unresolvedAgents.has(death.summary.agentId)) throw new Problem(409, 'selection_reputation_original_intent_unresolved',
            'An earlier source generation has an unresolved original feedback intent; retain its signed bytes for operator reconciliation.');
          const prepared = await this.planner.prepare(death.summary.agentId);
          if (prepared.deathSummaryHash !== death.feedbackHash) throw unavailable();
          const plan: SelectionReputationPublicationPlan = { agentId: death.summary.agentId, identityId: death.summary.identityId,
            originalOwner: prepared.originalOwner,
            summaryHash: death.feedbackHash, sourceHeight: death.summary.evidence.deathBlock, feedbackHash: prepared.feedbackHash,
            feedbackURI: prepared.feedbackURI, feedbackContent: prepared.feedbackContent, data: prepared.data };
          if (!existing.has(plan.summaryHash)) {
            if (existing.size >= this.maximum) throw unavailable();
            await this.db.insert(selectionReputationPublications).values({ summaryHash: plan.summaryHash, plan, state: 'prepared' }).onConflictDoNothing();
            existing.add(plan.summaryHash);
          }
          const [row] = await this.db.select().from(selectionReputationPublications).where(eq(selectionReputationPublications.summaryHash, plan.summaryHash));
          if (!row || canonical(this.checkedPlan(row)) !== canonical(plan)) throw unavailable();
          if (await this.publish(row)) published++;
        } catch (error) {
          // A per-agent review requirement cannot suppress other safe, independent identities.
          // Canonical source, deployment, database and RPC failures still abort the whole cycle.
          if (!reviewProblem(error)) throw error; reviewError ??= error;
        }
      }
      if (reviewError) throw reviewError;
      return { published, revoked, retracted };
    } catch (error) {
      if (reviewProblem(error)) throw error;
      throw unavailable();
    }
  }

  private checkedPlan(row: Publication): SelectionReputationPublicationPlan {
    const plan = planSchema.parse(row.plan);
    if (row.summaryHash !== plan.summaryHash || plan.originalOwner === '0x' + '00'.repeat(20)
      || keccak256(toHex(plan.feedbackContent)) !== plan.feedbackHash
      || plan.feedbackURI !== 'data:application/json;base64,' + Buffer.from(plan.feedbackContent).toString('base64')) throw unavailable();
    // The content is independently rebuilt from the canonical feed before any publication.
    const content = z.object({ agentRegistry: z.string(), agentId: z.number().int().safe().nonnegative(), clientAddress: z.string(),
      createdAt: z.string(), value: z.number().int().safe().nonnegative(), valueDecimals: z.literal(0), tag1: z.literal('lifespan'),
      tag2: z.literal('telomere.death.v1'), endpoint: z.literal(''), summary: z.record(z.unknown()) }).strict().parse(JSON.parse(plan.feedbackContent));
    if (canonical(content) !== plan.feedbackContent || content.agentId.toString() !== plan.identityId
      || content.agentRegistry !== `eip155:${this.profile.chainId}:${this.profile.identityAddress}`
      || content.clientAddress !== `eip155:${this.profile.chainId}:${this.profile.publisherAddress}`
      || hashJson(content.summary) !== plan.summaryHash || content.summary.agentId !== plan.agentId
      || content.summary.identityId !== plan.identityId || content.summary.lifespanSeconds !== content.value.toString()) throw unavailable();
    const evidence = z.object({ deathBlock: units, chainId: z.number().int(), registryAddress: address,
      diedAtSeconds: units }).passthrough().parse(content.summary.evidence);
    if (evidence.deathBlock !== plan.sourceHeight || evidence.chainId !== this.source.chainId || evidence.registryAddress !== this.source.registryAddress
      || BigInt(evidence.diedAtSeconds) > 253_402_300_799n
      || content.createdAt !== new Date(Number(evidence.diedAtSeconds) * 1000).toISOString()) throw unavailable();
    const decoded = decodeFunctionData({ abi: selectionReputationFeedbackAbi, data: this.hex(plan.data) });
    if (decoded.functionName !== 'giveFeedback' || canonical(decoded.args) !== canonical([
      BigInt(plan.identityId), BigInt(content.value), 0, 'lifespan', 'telomere.death.v1', '', plan.feedbackURI, plan.feedbackHash,
    ])) throw unavailable();
    return plan;
  }
  private hex(value: string): Hex {
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw unavailable();
    // REASON: the boundary above validates the viem hex representation.
    return value as Hex;
  }
  private target(): Address {
    // REASON: SelectionReputationPlanner validates and freezes this reviewed profile.
    return this.profile.reputationAddress as Address;
  }
  private key(plan: SelectionReputationPublicationPlan, action: 'publish' | 'revoke'): string { return `reputation:${action}:${plan.summaryHash.slice(2)}`; }
  private revokeData(plan: SelectionReputationPublicationPlan, feedbackIndex: bigint) {
    return encodeFunctionData({ abi: selectionReputationPublisherAbi, functionName: 'revokeFeedback', args: [BigInt(plan.identityId), feedbackIndex] });
  }

  private async currentTarget(identityId: string): Promise<{ number: bigint; hash: Hex; lastIndex: bigint; owner: string; independent: boolean }> {
    const profile = this.profile, before = await this.rpc.getBlock({ blockTag: 'latest' });
    const pinned = { blockHash: before.hash, requireCanonical: true } as const;
    // REASON: the frozen reviewed profile and SelectionIndexer boundary validate addresses.
    const identity = profile.identityAddress as Address, publisher = profile.publisherAddress as Address,
      source = this.source.registryAddress as Address;
    const [chain, identityCode, reputationCode, sourceCode, sourceIdentity, targetIdentity, owner, approved, lastIndex, implementations] = await Promise.all([
      this.rpc.getChainId(), this.rpc.getCode({ address: identity, ...pinned }), this.rpc.getCode({ address: this.target(), ...pinned }),
      this.rpc.getCode({ address: source, ...pinned }),
      this.rpc.readContract({ address: source, abi: permissionAbi, functionName: 'identityRegistry', ...pinned }),
      this.rpc.readContract({ address: this.target(), abi: permissionAbi, functionName: 'getIdentityRegistry', ...pinned }),
      this.rpc.readContract({ address: identity, abi: permissionAbi, functionName: 'ownerOf', args: [BigInt(identityId)], ...pinned }),
      this.rpc.readContract({ address: identity, abi: permissionAbi, functionName: 'getApproved', args: [BigInt(identityId)], ...pinned }),
      this.rpc.readContract({ address: this.target(), abi: selectionReputationPublisherAbi, functionName: 'getLastIndex', args: [BigInt(identityId), publisher], ...pinned }),
      verifySelectionReputationImplementations(profile,
        address => this.rpc.getStorageAt({ address, slot: erc1967ImplementationSlot, ...pinned }),
        address => this.rpc.getCode({ address, ...pinned })),
    ]);
    const operator = await this.rpc.readContract({ address: identity, abi: permissionAbi, functionName: 'isApprovedForAll', args: [owner, publisher], ...pinned });
    const after = await this.rpc.getBlock({ blockNumber: before.number });
    if (chain !== profile.chainId || after.hash !== before.hash || !identityCode || !reputationCode || !sourceCode
      || identityCode === '0x' || reputationCode === '0x' || sourceCode === '0x'
      || keccak256(identityCode) !== profile.identityCodeHash || keccak256(reputationCode) !== profile.reputationCodeHash
      || keccak256(sourceCode) !== this.source.registryCodeHash || sourceIdentity.toLowerCase() !== profile.identityAddress
      || targetIdentity.toLowerCase() !== profile.identityAddress || owner === '0x' + '00'.repeat(20)
      || profile.deploymentKind === 'erc1967' && (implementations.identityImplementationAddress !== profile.identityImplementationAddress
        || implementations.reputationImplementationAddress !== profile.reputationImplementationAddress)) throw unavailable();
    return { number: before.number, hash: before.hash, lastIndex, owner: owner.toLowerCase(),
      independent: ![owner.toLowerCase(), approved.toLowerCase()].includes(profile.publisherAddress) && !operator };
  }

  /** Pin deployment state at the indexed source, current head and transaction receipt blocks. */
  private async verifyDeploymentAt(blockNumber: bigint, blockHash: Hex): Promise<void> {
    const pinned = { blockHash, requireCanonical: true } as const;
    const identity = this.profile.identityAddress as Address, source = this.source.registryAddress as Address;
    const [block, identityCode, reputationCode, sourceCode, sourceIdentity, targetIdentity] = await Promise.all([
      this.rpc.getBlock({ blockNumber }), this.rpc.getCode({ address: identity, ...pinned }),
      this.rpc.getCode({ address: this.target(), ...pinned }),
      this.rpc.getCode({ address: source, ...pinned }),
      this.rpc.readContract({ address: source, abi: permissionAbi, functionName: 'identityRegistry', ...pinned }),
      this.rpc.readContract({ address: this.target(), abi: permissionAbi, functionName: 'getIdentityRegistry', ...pinned }),
      verifySelectionReputationImplementations(this.profile,
        address => this.rpc.getStorageAt({ address, slot: erc1967ImplementationSlot, ...pinned }),
        address => this.rpc.getCode({ address, ...pinned })),
    ]);
    if (block.hash !== blockHash || !identityCode || !reputationCode || !sourceCode
      || identityCode === '0x' || reputationCode === '0x' || sourceCode === '0x'
      || keccak256(identityCode) !== this.profile.identityCodeHash || keccak256(reputationCode) !== this.profile.reputationCodeHash
      || keccak256(sourceCode) !== this.source.registryCodeHash
      || sourceIdentity.toLowerCase() !== this.profile.identityAddress
      || targetIdentity.toLowerCase() !== this.profile.identityAddress) throw unavailable();
  }

  /** Receipt-block ownership is separate from current ownership; a transfer may be reversed before observation. */
  private async receiptIdentity(plan: SelectionReputationPublicationPlan, receipt: TransactionReceipt): Promise<{ owner: string; independent: boolean }> {
    const pinned = { blockHash: receipt.blockHash, requireCanonical: true } as const;
    const identity = this.profile.identityAddress as Address;
    try {
      const owner = await this.rpc.readContract({ address: identity, abi: permissionAbi, functionName: 'ownerOf',
        args: [BigInt(plan.identityId)], ...pinned });
      const [approved, operator, block] = await Promise.all([
        this.rpc.readContract({ address: identity, abi: permissionAbi, functionName: 'getApproved', args: [BigInt(plan.identityId)], ...pinned }),
        this.rpc.readContract({ address: identity, abi: permissionAbi, functionName: 'isApprovedForAll',
          args: [owner, this.profile.publisherAddress as Address], ...pinned }),
        this.rpc.getBlock({ blockNumber: receipt.blockNumber }),
      ]);
      if (block.hash !== receipt.blockHash || !address.safeParse(owner).success || !address.safeParse(approved).success) throw unavailable();
      return { owner: owner.toLowerCase(),
        independent: ![owner.toLowerCase(), approved.toLowerCase()].includes(this.profile.publisherAddress) && !operator };
    } catch { throw unavailable(); }
  }

  /** Observation never rebroadcasts an orphaned source's original signed bytes. */
  private async observed(plan: SelectionReputationPublicationPlan, action: 'publish' | 'revoke', data: Hex): Promise<TransactionReceipt | undefined> {
    const [journal] = await this.db.select().from(platformTransactionJournal).where(eq(platformTransactionJournal.key, this.key(plan, action)));
    if (!journal) return undefined;
    const digest = bytes32Schema.parse(journal.hash), raw = this.hex(journal.raw);
    // REASON: hex validation above plus transaction parsing validates persisted locally signed bytes.
    const serialized = raw as TransactionSerialized, parsed = parseTransaction(serialized);
    if (journal.chainId !== this.profile.chainId || journal.sender !== this.profile.publisherAddress || journal.to !== this.profile.reputationAddress
      || journal.data !== data.toLowerCase() || keccak256(raw) !== digest || parsed.chainId !== this.profile.chainId
      || parsed.nonce !== journal.nonce || parsed.to?.toLowerCase() !== this.profile.reputationAddress || parsed.data?.toLowerCase() !== data.toLowerCase()
      || (parsed.value ?? 0n) !== 0n || (await recoverTransactionAddress({ serializedTransaction: serialized })).toLowerCase() !== this.profile.publisherAddress) throw unavailable();
    let receipt: TransactionReceipt;
    try { receipt = await this.rpc.getTransactionReceipt({ hash: digest }); }
    catch (error) { if (error instanceof TransactionReceiptNotFoundError) return undefined; throw unavailable(); }
    if (receipt.transactionHash !== digest || receipt.to?.toLowerCase() !== this.profile.reputationAddress
      || receipt.from.toLowerCase() !== this.profile.publisherAddress || receipt.status !== 'success') throw unavailable();
    const [block, head] = await Promise.all([this.rpc.getBlock({ blockNumber: receipt.blockNumber }), this.rpc.getBlockNumber()]);
    if (block.hash !== receipt.blockHash || head < receipt.blockNumber + BigInt(this.confirmations)) throw unavailable();
    await this.verifyDeploymentAt(receipt.blockNumber, receipt.blockHash);
    return receipt;
  }

  private async feedback(plan: SelectionReputationPublicationPlan, receipt: TransactionReceipt, expectedRevoked: boolean, requireLatestActive = true) {
    const events = parseEventLogs({ abi: selectionReputationPublisherAbi, eventName: 'NewFeedback', logs: receipt.logs, strict: true })
      .filter(event => event.address.toLowerCase() === this.profile.reputationAddress);
    if (events.length !== 1) throw unavailable();
    const event = events[0]!, value = event.args, parsed = decodeFunctionData({ abi: selectionReputationFeedbackAbi, data: this.hex(plan.data) });
    if (value.agentId !== BigInt(plan.identityId) || value.clientAddress.toLowerCase() !== this.profile.publisherAddress
      || value.feedbackIndex <= 0n || value.value !== parsed.args[1] || value.valueDecimals !== 0 || value.indexedTag1 !== keccak256(toHex('lifespan'))
      || value.tag1 !== 'lifespan' || value.tag2 !== 'telomere.death.v1' || value.endpoint !== ''
      || value.feedbackURI !== plan.feedbackURI || value.feedbackHash !== plan.feedbackHash) throw unavailable();
    const anchor = await this.currentTarget(plan.identityId), pinned = { blockHash: anchor.hash, requireCanonical: true } as const;
    // REASON: the profile schema proves the publisher's address representation.
    const publisher = this.profile.publisherAddress as Address;
    const [last, live] = await Promise.all([
      this.rpc.readContract({ address: this.target(), abi: selectionReputationPublisherAbi, functionName: 'getLastIndex', args: [BigInt(plan.identityId), publisher], ...pinned }),
      this.rpc.readContract({ address: this.target(), abi: selectionReputationPublisherAbi, functionName: 'readFeedback', args: [BigInt(plan.identityId), publisher, value.feedbackIndex], ...pinned }),
    ]);
    if (last < value.feedbackIndex || !expectedRevoked && requireLatestActive && last !== value.feedbackIndex
      || live[0] !== value.value || live[1] !== 0 || live[2] !== value.tag1 || live[3] !== value.tag2 || live[4] !== expectedRevoked
      || (await this.rpc.getBlock({ blockNumber: anchor.number })).hash !== anchor.hash
      || (await this.rpc.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw unavailable();
    return value.feedbackIndex;
  }
  private async hasIntent(plan: SelectionReputationPublicationPlan, action: 'publish' | 'revoke') {
    return (await this.db.select({ key: platformTransactionJournal.key }).from(platformTransactionJournal)
      .where(eq(platformTransactionJournal.key, this.key(plan, action))).limit(1)).length > 0;
  }
  private async publication(row: Publication, plan: SelectionReputationPublicationPlan, receipt: TransactionReceipt, index: bigint) {
    if (row.transactionHash && (row.transactionHash !== receipt.transactionHash || row.feedbackIndex !== index.toString())) throw unavailable();
    await this.db.update(selectionReputationPublications).set({ state: 'published', transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, feedbackIndex: index.toString() })
      .where(eq(selectionReputationPublications.summaryHash, plan.summaryHash));
  }
  private async freshIntentAllowed(plan: SelectionReputationPublicationPlan, lastIndex: bigint): Promise<void> {
    if (lastIndex === 0n) return;
    const rows = await this.db.select().from(selectionReputationPublications).limit(this.maximum + 1);
    if (rows.length > this.maximum) throw existingFeedback();
    const previous = rows.filter(row => row.summaryHash !== plan.summaryHash && row.plan.identityId === plan.identityId);
    if (BigInt(previous.length) !== lastIndex) throw existingFeedback();
    const indexes = new Set<string>();
    for (const row of previous) {
      const earlier = this.checkedPlan(row);
      if (row.state !== 'revoked' || !row.feedbackIndex || !units.safeParse(row.feedbackIndex).success) throw existingFeedback();
      const index = BigInt(row.feedbackIndex);
      if (index < 1n || index > lastIndex || indexes.has(row.feedbackIndex)) throw existingFeedback(); indexes.add(row.feedbackIndex);
      const original = await this.observed(earlier, 'publish', this.hex(earlier.data));
      const revoked = await this.observed(earlier, 'revoke', this.revokeData(earlier, index));
      if (!original || !revoked) throw existingFeedback();
      await this.confirmRevocation(row, earlier, original, revoked, index);
    }
  }
  private async publish(row: Publication): Promise<boolean> {
    const plan = this.checkedPlan(row);
    if (row.state === 'revoked' || await this.hasIntent(plan, 'revoke')) throw recovery();
    const known = await this.observed(plan, 'publish', this.hex(plan.data));
    if (known) {
      const index = await this.feedback(plan, known, false);
      const [death, origin] = await Promise.all([this.feed.death(plan.agentId), this.feed.origin(plan.agentId)]);
      if (death.feedbackHash !== plan.summaryHash || origin.feedbackHash !== plan.summaryHash || origin.owner !== plan.originalOwner
        || death.index.revision !== origin.index.revision || death.index.blockHash !== origin.index.blockHash) throw unavailable();
      const [target, atReceipt] = await Promise.all([this.currentTarget(plan.identityId), this.receiptIdentity(plan, known)]);
      if (target.owner !== plan.originalOwner || atReceipt.owner !== plan.originalOwner || !target.independent || !atReceipt.independent) {
        await this.retract(row, true);
        throw target.owner !== plan.originalOwner || atReceipt.owner !== plan.originalOwner ? transferred() : permissionChanged();
      }
      await this.publication(row, plan, known, index);
      return row.state !== 'published' || row.blockHash !== known.blockHash;
    }
    const current = await this.planner.prepare(plan.agentId);
    if (current.deathSummaryHash !== plan.summaryHash || current.data !== plan.data || current.feedbackHash !== plan.feedbackHash
      || current.originalOwner !== plan.originalOwner) throw unavailable();
    const target = await this.currentTarget(plan.identityId);
    if (target.owner !== plan.originalOwner) throw transferred();
    if (!target.independent) throw unavailable();
    const originalIntent = await this.hasIntent(plan, 'publish');
    if (!originalIntent) await this.freshIntentAllowed(plan, target.lastIndex);
    const finalTarget = await this.currentTarget(plan.identityId);
    if (finalTarget.owner !== plan.originalOwner) throw transferred();
    if (!finalTarget.independent) throw unavailable();
    if (!originalIntent && finalTarget.lastIndex !== target.lastIndex) throw existingFeedback();
    // Full confirmed-head coverage and the exact death are re-read last, before even signing/rebroadcasting.
    if ((await this.snapshot()).deaths.get(plan.agentId)?.feedbackHash !== plan.summaryHash) throw unavailable();
    const origin = await this.feed.origin(plan.agentId);
    if (origin.feedbackHash !== plan.summaryHash || origin.owner !== plan.originalOwner) throw unavailable();
    await this.transactions.submit(this.key(plan, 'publish'), this.target(), this.hex(plan.data));
    const receipt = await this.observed(plan, 'publish', this.hex(plan.data)); if (!receipt) throw unavailable();
    const index = await this.feedback(plan, receipt, false);
    if ((await this.feed.death(plan.agentId)).feedbackHash !== plan.summaryHash) throw unavailable();
    const [observedTarget, atReceipt] = await Promise.all([this.currentTarget(plan.identityId), this.receiptIdentity(plan, receipt)]);
    if (observedTarget.owner !== plan.originalOwner || atReceipt.owner !== plan.originalOwner
      || !observedTarget.independent || !atReceipt.independent) {
      await this.retract(row, true);
      throw observedTarget.owner !== plan.originalOwner || atReceipt.owner !== plan.originalOwner ? transferred() : permissionChanged();
    }
    await this.publication(row, plan, receipt, index); return true;
  }

  private async retract(row: Publication, ownershipDrift = false): Promise<'revoked' | 'retracted' | undefined> {
    const plan = this.checkedPlan(row);
    const receipt = await this.observed(plan, 'publish', this.hex(plan.data));
    if (!receipt) {
      // The original nonce may remain unresolved; never replace, cancel or replay it for an absent death.
      if (row.state !== 'retracted') {
        await this.db.update(selectionReputationPublications).set({ state: 'retracted' }).where(eq(selectionReputationPublications.summaryHash, plan.summaryHash));
        return 'retracted';
      }
      return undefined;
    }
    const events = parseEventLogs({ abi: selectionReputationPublisherAbi, eventName: 'NewFeedback', logs: receipt.logs, strict: true })
      .filter(event => event.address.toLowerCase() === this.profile.reputationAddress);
    if (events.length !== 1) throw unavailable(); const index = events[0]!.args.feedbackIndex;
    const revokeData = this.revokeData(plan, index), knownRevoke = await this.observed(plan, 'revoke', revokeData);
    if (knownRevoke) { await this.confirmRevocation(row, plan, receipt, knownRevoke, index); return row.state === 'revoked' ? undefined : 'revoked'; }
    await this.feedback(plan, receipt, false, false);
    const target = await this.currentTarget(plan.identityId);
    const current = await this.snapshot(), death = current.deaths.get(plan.agentId);
    const atReceipt = ownershipDrift && target.owner === plan.originalOwner && target.independent
      ? await this.receiptIdentity(plan, receipt) : undefined;
    const unsafeIdentity = ownershipDrift && (target.owner !== plan.originalOwner || !target.independent
      || atReceipt?.owner !== plan.originalOwner || !atReceipt?.independent);
    if (BigInt(current.index.indexedThrough) < BigInt(plan.sourceHeight)
      || death?.feedbackHash === plan.summaryHash && !unsafeIdentity) throw unavailable();
    await this.transactions.submit(this.key(plan, 'revoke'), this.target(), revokeData);
    const revoked = await this.observed(plan, 'revoke', revokeData); if (!revoked) throw unavailable();
    await this.confirmRevocation(row, plan, receipt, revoked, index); return 'revoked';
  }
  private async confirmRevocation(row: Publication, plan: SelectionReputationPublicationPlan, original: TransactionReceipt,
    receipt: TransactionReceipt, index: bigint): Promise<void> {
    const events = parseEventLogs({ abi: selectionReputationPublisherAbi, eventName: 'FeedbackRevoked', logs: receipt.logs, strict: true })
      .filter(event => event.address.toLowerCase() === this.profile.reputationAddress);
    if (events.length !== 1 || events[0]!.args.agentId !== BigInt(plan.identityId)
      || events[0]!.args.clientAddress.toLowerCase() !== this.profile.publisherAddress || events[0]!.args.feedbackIndex !== index) throw unavailable();
    if (await this.feedback(plan, original, true) !== index) throw unavailable();
    if (row.revokeTransactionHash && row.revokeTransactionHash !== receipt.transactionHash) throw unavailable();
    await this.db.update(selectionReputationPublications).set({ state: 'revoked', transactionHash: original.transactionHash,
      blockNumber: original.blockNumber.toString(), blockHash: original.blockHash, feedbackIndex: index.toString(),
      revokeTransactionHash: receipt.transactionHash, revokeBlockNumber: receipt.blockNumber.toString(), revokeBlockHash: receipt.blockHash })
      .where(eq(selectionReputationPublications.summaryHash, plan.summaryHash));
  }
}
