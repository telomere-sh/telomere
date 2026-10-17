import { z } from 'zod';
import { akashAddressSchema, akashDseqSchema } from './akash-console.js';
import { akashCanonicalPriceSchema, akashRemotePriceSchema, sameAkashPrice } from './akash-price.js';

const sequence = z.number().int().positive().max(0xffff_ffff);
const bidSequence = z.number().int().nonnegative().max(0xffff_ffff);
const sequenceFromChain = z.union([sequence, z.string().regex(/^[1-9][0-9]{0,9}$/)
  .transform(value => Number(value))]).pipe(sequence);
const bidSequenceFromChain = z.union([bidSequence, z.string().regex(/^(0|[1-9][0-9]{0,9})$/)
  .transform(value => Number(value))]).pipe(bidSequence);
export const akashExactBidIdSchema = z.object({
  owner: akashAddressSchema, dseq: akashDseqSchema,
  gseq: sequence, oseq: sequence, provider: akashAddressSchema, bseq: bidSequence,
}).strict();
export type AkashExactBidId = z.infer<typeof akashExactBidIdSchema>;

const chainBidSchema = z.object({ bid: z.object({
  id: z.object({ owner: akashAddressSchema, dseq: akashDseqSchema,
    gseq: sequenceFromChain, oseq: sequenceFromChain,
    provider: akashAddressSchema, bseq: bidSequenceFromChain }),
  state: z.literal('open'),
  price: z.object({ denom: z.literal('uact'), amount: akashRemotePriceSchema }),
}) });

export interface AkashExactBidExpectation extends AkashExactBidId {
  pricePerBlockUact: string;
}

export interface AkashExactBidProof {
  bidId: AkashExactBidId;
  pricePerBlockUact: string;
  unitPriceConfirmed: true;
  /** MsgCreateLease carries only BidID; lifetime spend and USDC are not on-chain limits. */
  totalSpendBoundOnChain: false;
}

/** Check the full immutable chain bid identity. This is only a unit-price preflight, never paid authorization. */
export function verifyAkashExactBid(raw: unknown, expectedValue: AkashExactBidExpectation): AkashExactBidProof {
  const { pricePerBlockUact, ...expectedId } = expectedValue;
  const expected = akashExactBidIdSchema.parse(expectedId);
  akashCanonicalPriceSchema.parse(pricePerBlockUact);
  const bid = chainBidSchema.parse(raw).bid;
  if (bid.id.owner !== expected.owner || bid.id.dseq !== expected.dseq
    || bid.id.gseq !== expected.gseq || bid.id.oseq !== expected.oseq
    || bid.id.provider !== expected.provider || bid.id.bseq !== expected.bseq
    || !sameAkashPrice(bid.price.amount, pricePerBlockUact)) {
    throw new Error('Akash exact chain bid identity or unit price changed');
  }
  return { bidId: expected, pricePerBlockUact, unitPriceConfirmed: true, totalSpendBoundOnChain: false };
}

export interface AkashExactBidReader {
  /** Return an untrusted chain query response for the exact full BidID. */
  getBid(id: AkashExactBidId): Promise<unknown>;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')
    || !response.body) throw new Error('Akash chain query unavailable');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 262_144) throw new Error('Akash chain query exceeds size limit');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) as unknown;
}

/** Read-only Akash gRPC-gateway queries. A reviewed HTTPS endpoint and chain ID are required. */
export class AkashChainExactBidReader implements AkashExactBidReader {
  private readonly origin: string;
  constructor(endpoint: string, private readonly chainId: string,
    private readonly fetchImpl: typeof fetch = fetch) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || !chainId || chainId.length > 128 || /[\r\n]/.test(chainId)) {
      throw new Error('Reviewed Akash HTTPS chain endpoint and chain ID are required');
    }
    this.origin = url.origin;
  }
  private async get(path: string): Promise<unknown> {
    const response = await this.fetchImpl(this.origin + path, { method: 'GET', cache: 'no-store',
      redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
    return boundedJson(response);
  }
  async getBid(value: AkashExactBidId): Promise<unknown> {
    const id = akashExactBidIdSchema.parse(value);
    const node = z.object({ default_node_info: z.object({ network: z.string() }) })
      .parse(await this.get('/cosmos/base/tendermint/v1beta1/node_info'));
    if (node.default_node_info.network !== this.chainId) throw new Error('Akash chain ID changed');
    const query = new URLSearchParams({ 'id.owner': id.owner, 'id.dseq': id.dseq,
      'id.gseq': String(id.gseq), 'id.oseq': String(id.oseq),
      'id.provider': id.provider, 'id.bseq': String(id.bseq) });
    return this.get('/akash/market/v1beta5/bids/info?' + query.toString());
  }
}
