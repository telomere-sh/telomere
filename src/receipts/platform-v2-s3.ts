import { z } from 'zod';
import { signS3Request, type S3Credentials } from '../cysts/s3.js';
import { PLATFORM_V2_CORE_MAX_BYTES } from './platform-v2.js';
import type { PlatformV2PublicationStore } from './platform-v2-publication.js';

const name = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const bucket = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
  .refine(value => !value.includes('..') && !/^\d+\.\d+\.\d+\.\d+$/.test(value));
const region = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
function endpointOrigin(value: string, allowDevelopment = false): string {
  if (value.length > 2048) throw new Error('Invalid reviewed Platform v2 storage endpoint');
  const endpoint = new URL(value), loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/'
    || endpoint.protocol !== 'https:' && !(allowDevelopment && loopback && endpoint.protocol === 'http:')) {
    throw new Error('Invalid reviewed Platform v2 storage endpoint');
  }
  return endpoint.origin;
}
const publicEndpoint = z.string().url().refine(value => {
  try { endpointOrigin(value); return true; } catch { return false; }
}, 'A reviewed HTTPS storage origin is required').transform(value => endpointOrigin(value));
/** Public config contains a private-file reference, never inline storage credentials. */
export const platformV2S3StoreConfigSchema = z.object({ identity: name, failureDomain: name,
  endpoint: publicEndpoint, bucket, region,
  credentialsFile: z.string().min(1).max(4096).refine(value => !value.includes('\0')),
}).strict();
export type PlatformV2S3StoreConfig = z.infer<typeof platformV2S3StoreConfigSchema>;
export type PlatformV2S3EvidenceOptions = Omit<PlatformV2S3StoreConfig, 'credentialsFile'> & {
  credentials: S3Credentials; reviewed: true; allowDevelopment?: boolean;
  timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => Date;
};
const credentialsSchema = z.object({ accessKeyId: z.string().regex(/^[A-Za-z0-9_-]{2,128}$/),
  secretAccessKey: z.string().regex(/^[\x21-\x7e]{16,256}$/),
  sessionToken: z.string().regex(/^[\x21-\x7e]{20,8192}$/).optional(),
}).strict();
const keyPattern = /^v2\/0x[0-9a-f]{64}\/(?:0x[0-9a-f]{64}\/core\.json|runs\/0x[0-9a-f]{64}\/manifest\.json)$/;
type OperationOptions = { signal: AbortSignal; maxBytes: number };
const unavailable = () => new Error('Platform v2 evidence storage is unavailable or failed its integrity check');
function checkedOperation(key: string, options: OperationOptions): void {
  if (!keyPattern.test(key) || !Number.isSafeInteger(options.maxBytes)
    || options.maxBytes < 1 || options.maxBytes > PLATFORM_V2_CORE_MAX_BYTES
    || !(options.signal instanceof AbortSignal)) throw unavailable();
  options.signal.throwIfAborted();
}
async function cancel(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Narrow S3 transport: exact evidence keys, bounded GET and conditional PUT only.
 * Conditional writes do not establish Object Lock or an independent bucket policy. */
export class PlatformV2S3EvidenceStore implements PlatformV2PublicationStore {
  readonly identity: string;
  readonly failureDomain: string;
  readonly destination: Readonly<{ identity: string; failureDomain: string; endpoint: string;
    bucket: string; region: string; reviewed: true }>;
  #credentials: S3Credentials;
  #endpoint: URL;
  #timeoutMs: number;
  #fetch: typeof fetch;
  #now: () => Date;
  constructor(options: PlatformV2S3EvidenceOptions) {
    try {
      if (options.reviewed !== true) throw unavailable();
      this.identity = name.parse(options.identity); this.failureDomain = name.parse(options.failureDomain);
      const origin = endpointOrigin(options.endpoint, options.allowDevelopment === true);
      this.#endpoint = new URL(origin);
      this.#timeoutMs = options.timeoutMs ?? 10_000;
      if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 30_000) throw unavailable();
      const parsedCredentials = credentialsSchema.parse(options.credentials);
      this.#credentials = Object.freeze({ accessKeyId: parsedCredentials.accessKeyId,
        secretAccessKey: parsedCredentials.secretAccessKey,
        ...(parsedCredentials.sessionToken === undefined ? {} : { sessionToken: parsedCredentials.sessionToken }) });
      this.#fetch = options.fetchImpl ?? fetch; this.#now = options.now ?? (() => new Date());
      this.destination = Object.freeze({ identity: this.identity, failureDomain: this.failureDomain,
        endpoint: origin, bucket: bucket.parse(options.bucket), region: region.parse(options.region), reviewed: true });
    } catch { throw new Error('Invalid reviewed Platform v2 storage configuration'); }
  }
  toJSON() { return this.destination; }
  private signal(parent: AbortSignal): AbortSignal {
    return AbortSignal.any([parent, AbortSignal.timeout(this.#timeoutMs)]);
  }
  private async request(method: 'GET' | 'PUT', key: string, signal: AbortSignal, bytes?: Uint8Array): Promise<Response> {
    signal.throwIfAborted();
    const url = new URL(`/${this.destination.bucket}/${key}`, this.#endpoint);
    const headers = signS3Request({ method, url, region: this.destination.region, credentials: this.#credentials,
      date: this.#now(), headers: method === 'PUT' ? { 'if-none-match': '*', 'content-type': 'application/json',
        'content-length': String(bytes?.byteLength ?? 0) } : { 'accept-encoding': 'identity' },
      ...(bytes ? { body: bytes } : {}) });
    return this.#fetch(url, { method, headers, redirect: 'error', signal,
      ...(bytes ? { body: Uint8Array.from(bytes).buffer } : {}) });
  }
  private async read(key: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | undefined> {
    const response = await this.request('GET', key, signal);
    if (response.status === 404) { await cancel(response); return undefined; }
    if (response.status !== 200) { await cancel(response); throw unavailable(); }
    const length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding');
    if (length !== null && (!/^[1-9][0-9]{0,5}$/.test(length) || BigInt(length) > BigInt(maxBytes))
      || encoding !== null && encoding !== 'identity') { await cancel(response); throw unavailable(); }
    const reader = response.body?.getReader();
    if (!reader) throw unavailable();
    const bytes = new Uint8Array(maxBytes); let offset = 0;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void reader.cancel().catch(() => undefined);
        reject(unavailable());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await Promise.race([reader.read(), aborted]);
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0 || part.value.byteLength > maxBytes - offset) {
          await reader.cancel().catch(() => undefined); throw unavailable();
        }
        bytes.set(part.value, offset); offset += part.value.byteLength;
      }
      if (offset === 0 || length !== null && BigInt(length) !== BigInt(offset)) throw unavailable();
      signal.throwIfAborted();
      return bytes.slice(0, offset);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
  }
  async get(key: string, options: OperationOptions): Promise<Uint8Array | undefined> {
    try {
      checkedOperation(key, options);
      return await this.read(key, options.maxBytes, this.signal(options.signal));
    } catch { throw unavailable(); }
  }
  async putImmutable(key: string, value: Uint8Array, options: OperationOptions): Promise<void> {
    try {
      checkedOperation(key, options);
      if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > options.maxBytes) throw unavailable();
      const bytes = Uint8Array.from(value), signal = this.signal(options.signal);
      const response = await this.request('PUT', key, signal, bytes);
      await cancel(response);
      if (![200, 201, 204, 412].includes(response.status)) throw unavailable();
      const saved = await this.read(key, bytes.byteLength, signal);
      if (!(saved instanceof Uint8Array) || !Buffer.from(saved).equals(Buffer.from(bytes))) throw unavailable();
    } catch { throw unavailable(); }
  }
}
