import { z } from 'zod';

export const solanaAddressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const nosanaCidSchema = z.string().min(32).max(128).regex(/^[A-Za-z0-9]+$/);
export const nosanaJobSchema = z.object({
  address: solanaAddressSchema, state: z.number().int().min(0).max(3),
  market: solanaAddressSchema, node: solanaAddressSchema, payer: solanaAddressSchema,
  ipfsJob: nosanaCidSchema, price: z.number().int().positive().safe(),
  timeout: z.number().int().positive().max(30 * 86400),
  timeStart: z.number().int().nonnegative().safe(), timeEnd: z.number().int().nonnegative().safe(),
}).passthrough();
export const nosanaMarketSchema = z.object({ address: solanaAddressSchema,
  type: z.enum(['PREMIUM', 'COMMUNITY']), name: z.string().min(1).max(256),
}).passthrough();
export type NosanaJob = z.infer<typeof nosanaJobSchema>;
export type NosanaMarket = z.infer<typeof nosanaMarketSchema>;

/** Fixed Nosana API origin, bounded GET-only HTTP transport. No wallet, signature, or mutation method. */
export class NosanaReader {
  private readonly origin = 'https://api.nosana.com';
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly apiKey?: string) {
    if (apiKey !== undefined && (!apiKey || apiKey.length > 1024 || /[\r\n]/.test(apiKey)))
      throw new Error('Nosana API key is invalid');
  }
  private async get(path: string): Promise<unknown> {
    const response = await this.fetchImpl(this.origin + path, { method: 'GET', redirect: 'error',
      headers: this.apiKey ? { authorization: 'Bearer ' + this.apiKey, accept: 'application/json' }
        : { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Nosana GET failed (${response.status})`);
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json'))
      throw new Error('Nosana response is not JSON');
    if (!response.body) throw new Error('Nosana response is empty');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > 1_048_576) throw new Error('Nosana response exceeds size limit');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))) as unknown;
  }
  async job(address: string): Promise<NosanaJob> {
    const id = solanaAddressSchema.parse(address);
    const job = nosanaJobSchema.parse(await this.get('/jobs/' + id));
    if (job.address !== id) throw new Error('Nosana job identity mismatch');
    return job;
  }
  async market(address: string): Promise<NosanaMarket> {
    const id = solanaAddressSchema.parse(address);
    const market = nosanaMarketSchema.parse(await this.get('/api/markets/' + id));
    if (market.address !== id) throw new Error('Nosana market identity mismatch');
    return market;
  }
}

export interface NosanaReadClient {
  job(address: string): Promise<NosanaJob>;
  market(address: string): Promise<NosanaMarket>;
}
