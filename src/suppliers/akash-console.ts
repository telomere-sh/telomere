import { z } from 'zod';
import { akashRemotePriceSchema } from './akash-price.js';

const address = z.string().regex(/^akash1[0-9a-z]{20,90}$/);
const dseq = z.string().regex(/^[1-9][0-9]{0,19}$/);
const quantity = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const sequence = z.number().int().positive().safe();
const bidSequence = z.number().int().nonnegative().max(0xffff_ffff);

export const akashAddressSchema = address;
export const akashDseqSchema = dseq;
export const akashQuantitySchema = quantity;

const bidSchema = z.object({
  bid: z.object({
    id: z.object({ owner: address, dseq, gseq: sequence, oseq: sequence, provider: address,
      bseq: bidSequence.optional() }),
    state: z.string().min(1).max(32),
    price: z.object({ denom: z.string().min(1).max(64), amount: akashRemotePriceSchema }),
  }),
});
const providerSchema = z.object({ owner: address, isOnline: z.boolean(), isAudited: z.boolean(),
  isValidVersion: z.boolean(), uptime30d: z.number().min(0).max(1),
  stats: z.object({ gpu: z.object({ available: z.number().nonnegative() }).optional() }).optional(),
});
const leaseSchema = z.object({
  id: z.object({ owner: address, dseq, gseq: sequence, oseq: sequence, provider: address }),
  state: z.string().min(1).max(32),
  price: z.object({ denom: z.string().min(1).max(64), amount: akashRemotePriceSchema }),
});
const deploymentSchema = z.object({ data: z.object({
  deployment: z.object({ id: z.object({ owner: address, dseq }),
    state: z.string().min(1).max(32), hash: z.string().min(1).max(256) }),
  leases: z.array(leaseSchema).max(64),
}) });
const settingsSchema = z.object({ data: z.object({
  dseq, autoTopUpEnabled: z.boolean(),
  runtimeLimitHours: z.number().int().positive().max(24 * 30).nullable(),
  runtimeEndsAt: z.string().datetime({ offset: true }).nullable(),
}) });

export type AkashBid = z.infer<typeof bidSchema>['bid'];
export type AkashProvider = z.infer<typeof providerSchema>;
export type AkashDeployment = z.infer<typeof deploymentSchema>['data'];
export type AkashSettings = z.infer<typeof settingsSchema>['data'];
const leaseRequestSchema = z.object({ dseq, gseq: sequence, oseq: sequence, provider: address }).strict();
export type AkashLeaseRequest = z.infer<typeof leaseRequestSchema>;

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) throw new Error('Akash Console response is not JSON');
  const maxBytes = 1_048_576, chunks: Uint8Array[] = [];
  let length = 0;
  if (!response.body) throw new Error('Akash Console returned an empty response');
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) throw new Error('Akash Console response exceeds size limit');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))) as unknown;
}

/** Restricted to the Akash Console host and GET endpoints. It contains no mutation method. */
export class AkashConsoleReader {
  private readonly base = 'https://console-api.akash.network';
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {
    if (!apiKey || apiKey.length > 1024 || /[\r\n]/.test(apiKey)) throw new Error('Akash API key is required for lease reads');
  }

  private async get(path: string, authenticated: boolean): Promise<unknown> {
    const response = await this.fetchImpl(this.base + path, { method: 'GET', redirect: 'error',
      headers: authenticated ? { 'x-api-key': this.apiKey, accept: 'application/json' } : { accept: 'application/json' },
      signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Akash Console GET failed (${response.status})`);
    return boundedJson(response);
  }

  async providers(addresses: string[]): Promise<AkashProvider[]> {
    const approved = z.array(address).min(1).max(64).parse(addresses);
    const results: AkashProvider[] = [];
    for (let offset = 0; offset < approved.length; offset += 4) {
      const batch = approved.slice(offset, offset + 4);
      results.push(...await Promise.all(batch.map(async item => {
        const provider = providerSchema.parse(await this.get('/v1/providers/' + item, false));
        if (provider.owner !== item) throw new Error('Akash provider identity changed');
        return provider;
      })));
    }
    return results;
  }
  async bids(id: string): Promise<AkashBid[]> {
    const value = z.object({ data: z.array(bidSchema).max(200) }).parse(await this.get(
      '/v1/bids?dseq=' + dseq.parse(id), true));
    return value.data.map(item => item.bid);
  }
  async deployment(id: string): Promise<AkashDeployment> {
    return deploymentSchema.parse(await this.get('/v1/deployments/' + dseq.parse(id), true)).data;
  }
  async settings(id: string): Promise<AkashSettings> {
    return settingsSchema.parse(await this.get('/v2/deployment-settings/' + dseq.parse(id), true)).data;
  }
}

export interface AkashReadClient {
  providers(addresses: string[]): Promise<AkashProvider[]>;
  bids(dseq: string): Promise<AkashBid[]>;
  deployment(dseq: string): Promise<AkashDeployment>;
  settings(dseq: string): Promise<AkashSettings>;
}

/** Separate, opt-in mutation client. A call can spend Console credits; callers must journal first. */
export class AkashConsoleLeaseWriter {
  private readonly base = 'https://console-api.akash.network';
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {
    if (!apiKey || apiKey.length > 1024 || /[\r\n]/.test(apiKey)) throw new Error('Akash API key is required for lease creation');
  }
  async createLease(value: AkashLeaseRequest): Promise<AkashDeployment> {
    const lease = leaseRequestSchema.parse(value);
    const response = await this.fetchImpl(this.base + '/v1/leases', { method: 'POST', redirect: 'error',
      headers: { 'x-api-key': this.apiKey, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ leases: [lease] }), signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Akash Console lease POST failed (${response.status})`);
    return deploymentSchema.parse(await boundedJson(response)).data;
  }
}

export interface AkashLeaseWriteClient {
  createLease(lease: AkashLeaseRequest): Promise<AkashDeployment>;
}

const closeResponseSchema = z.object({ data: z.object({ success: z.literal(true) }) });

/** Separate opt-in Console deployment closure transport. A DELETE can return after the chain settles. */
export class AkashConsoleDeploymentCloser {
  private readonly base = 'https://console-api.akash.network';
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {
    if (!apiKey || apiKey.length > 1024 || /[\r\n]/.test(apiKey)) throw new Error('Akash API key is required for deployment closure');
  }
  async closeDeployment(id: string): Promise<void> {
    const response = await this.fetchImpl(this.base + '/v1/deployments/' + dseq.parse(id), {
      method: 'DELETE', redirect: 'error',
      headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Akash Console deployment DELETE failed (${response.status})`);
    closeResponseSchema.parse(await boundedJson(response));
  }
}

export interface AkashDeploymentCloseClient {
  closeDeployment(dseq: string): Promise<void>;
}
