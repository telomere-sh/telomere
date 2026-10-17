import { createHash, createHmac } from 'node:crypto';
import { cystStorageUnavailable, validateCiphertextScope, verifyCiphertext,
  type ReviewedCiphertextStore, type ReviewedCystDestination } from './replicated.js';
import { Problem } from '../common.js';

export interface S3Credentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
export interface S3CiphertextOptions {
  endpoint: string; bucket: string; region: string; failureDomain: string; reviewed: true; credentials: S3Credentials;
  allowInsecureLoopback?: boolean; timeoutMs?: number; fetch?: typeof fetch; now?: () => Date;
}
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Uint8Array, value: string) => createHmac('sha256', key).update(value).digest();
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
function checkedCredentials(credentials: S3Credentials): S3Credentials {
  if (!credentials || !/^[A-Za-z0-9_-]{2,128}$/.test(credentials.accessKeyId)
    || !/^[\x21-\x7e]{16,256}$/.test(credentials.secretAccessKey)
    || credentials.sessionToken !== undefined && !/^[\x21-\x7e]{20,8192}$/.test(credentials.sessionToken)) throw new Error('Invalid storage credentials');
  return { ...credentials };
}
/** Single-chunk signed-payload SigV4. Kept independently testable against AWS's published GET/PUT vectors. */
export function signS3Request(input: { method: 'GET' | 'PUT' | 'HEAD'; url: URL; region: string; credentials: S3Credentials;
  date: Date; headers?: Readonly<Record<string, string>>; body?: Uint8Array }): Record<string, string> {
  const credentials = checkedCredentials(input.credentials);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.region) || !Number.isFinite(input.date.getTime())
    || input.url.username || input.url.password || input.url.hash) throw new Error('Invalid storage signing scope');
  const date = input.date.toISOString().replace(/[:-]|\.\d{3}/g, ''); const day = date.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    const name = key.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name) || /[\r\n]/.test(value) || headers[name] !== undefined
      || ['authorization', 'host', 'x-amz-date', 'x-amz-content-sha256', 'x-amz-security-token'].includes(name)) throw new Error('Invalid storage signing headers');
    headers[name] = value.trim().replace(/\s+/g, ' ');
  }
  headers.host = input.url.host; headers['x-amz-date'] = date; headers['x-amz-content-sha256'] = sha(input.body ?? new Uint8Array());
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
  const names = Object.keys(headers).sort(); const signed = names.join(';');
  const canonicalHeaders = names.map(name => name + ':' + headers[name] + '\n').join('');
  // Object paths are already canonical encoded absolute paths; do not normalize repeated slashes or double-encode percent signs.
  const query = [...input.url.searchParams.entries()].map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0).map(([key, value]) => key + '=' + value).join('&');
  const canonicalPath = input.url.pathname.split('/').map(segment => encode(decodeURIComponent(segment))).join('/');
  const canonical = [input.method, canonicalPath, query, canonicalHeaders, signed, headers['x-amz-content-sha256']].join('\n');
  const scope = day + '/' + input.region + '/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha(canonical)].join('\n');
  const dateKey = hmac('AWS4' + credentials.secretAccessKey, day), regionKey = hmac(dateKey, input.region), serviceKey = hmac(regionKey, 's3'), key = hmac(serviceKey, 'aws4_request');
  try {
    const signature = hmac(key, stringToSign).toString('hex');
    headers.authorization = 'AWS4-HMAC-SHA256 Credential=' + credentials.accessKeyId + '/' + scope + ',SignedHeaders=' + signed + ',Signature=' + signature;
    return headers;
  } finally { dateKey.fill(0); regionKey.fill(0); serviceKey.fill(0); key.fill(0); }
}
export function cystObjectKey(owner: string, digest: string): string {
  validateCiphertextScope(owner, digest, 17);
  return 'cysts/v1/' + sha('telomere-cyst-blob:' + owner + ':' + digest) + '.blob';
}
function metadata(owner: string, digest: string, expectedBytes: number): Record<string, string> {
  return { 'x-amz-meta-telomere-version': '1', 'x-amz-meta-telomere-owner': sha('telomere-cyst-owner:' + owner),
    'x-amz-meta-telomere-sha256': digest, 'x-amz-meta-telomere-bytes': String(expectedBytes) };
}

/** Narrow path-style S3 ciphertext adapter: GET and conditional immutable PUT only, no listing, deletion or redirects. */
export class S3CiphertextStorage implements ReviewedCiphertextStore {
  readonly destination: ReviewedCystDestination;
  #credentials: S3Credentials; #endpoint: URL; #timeoutMs: number; #fetch: typeof fetch; #now: () => Date; #initialized = false;
  constructor(options: S3CiphertextOptions) {
    let endpoint: URL;
    try { endpoint = new URL(options.endpoint); } catch { throw new Error('Invalid reviewed storage endpoint'); }
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname);
    if (options.reviewed !== true || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/'
      || endpoint.protocol !== 'https:' && !(options.allowInsecureLoopback === true && loopback && endpoint.protocol === 'http:')
      || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) || options.bucket.includes('..')
      || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.region) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.failureDomain)) throw new Error('Invalid reviewed storage destination');
    const timeout = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 60_000) throw new Error('Storage timeout must be between 10 and 60000 milliseconds');
    this.#credentials = checkedCredentials(options.credentials); this.#endpoint = endpoint; this.#timeoutMs = timeout;
    this.#fetch = options.fetch ?? fetch; this.#now = options.now ?? (() => new Date());
    this.destination = Object.freeze({ endpoint: endpoint.origin, bucket: options.bucket, region: options.region, failureDomain: options.failureDomain, reviewed: true });
  }
  async initialize(): Promise<void> { this.#initialized = true; }
  toJSON(): ReviewedCystDestination { return this.destination; }
  private async request(method: 'GET' | 'PUT', owner: string, digest: string, expectedBytes: number, body?: Uint8Array): Promise<Response> {
    if (!this.#initialized) throw cystStorageUnavailable(); validateCiphertextScope(owner, digest, expectedBytes);
    const url = new URL('/' + this.destination.bucket + '/' + cystObjectKey(owner, digest), this.#endpoint);
    const extra = method === 'PUT' ? { ...metadata(owner, digest, expectedBytes), 'content-type': 'application/octet-stream',
      'content-length': String(expectedBytes), 'if-none-match': '*' } : {};
    try {
      const headers = signS3Request({ method, url, region: this.destination.region, credentials: this.#credentials,
        date: this.#now(), headers: extra, ...(body === undefined ? {} : { body }) });
      return await this.#fetch(url, { method, headers, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs),
        ...(body === undefined ? {} : { body: Uint8Array.from(body).buffer }) });
    } catch { throw cystStorageUnavailable(); }
  }
  async read(owner: string, digest: string, expectedBytes: number): Promise<Uint8Array | undefined> {
    const response = await this.request('GET', owner, digest, expectedBytes);
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return undefined; }
    if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); throw cystStorageUnavailable(); }
    const expected = metadata(owner, digest, expectedBytes);
    for (const [name, value] of Object.entries(expected)) if (response.headers.get(name) !== value) {
      await response.body?.cancel().catch(() => undefined); throw new Problem(503, 'cyst_integrity_failed', 'Checkpoint ciphertext metadata failed its integrity check.');
    }
    const length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding');
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) !== expectedBytes) || encoding !== null && encoding !== 'identity') {
      await response.body?.cancel().catch(() => undefined); throw new Problem(503, 'cyst_integrity_failed', 'Checkpoint ciphertext length failed its integrity check.');
    }
    const reader = response.body?.getReader(); if (!reader) throw cystStorageUnavailable();
    const bytes = new Uint8Array(expectedBytes); let offset = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        if (part.value.byteLength > expectedBytes - offset) { await reader.cancel(); throw new Error('size'); }
        bytes.set(part.value, offset); offset += part.value.byteLength;
      }
      if (offset !== expectedBytes) throw new Error('size'); verifyCiphertext(owner, digest, bytes, expectedBytes); return bytes;
    } catch { throw new Problem(503, 'cyst_integrity_failed', 'Checkpoint ciphertext failed its integrity check.'); }
    finally { reader.releaseLock(); }
  }
  async put(owner: string, digest: string, value: Uint8Array): Promise<void> {
    if (!(value instanceof Uint8Array)) throw cystStorageUnavailable(); validateCiphertextScope(owner, digest, value.byteLength);
    const bytes = Uint8Array.from(value); verifyCiphertext(owner, digest, bytes);
    const response = await this.request('PUT', owner, digest, bytes.byteLength, bytes);
    await response.body?.cancel().catch(() => undefined);
    if (response.status !== 200 && response.status !== 201 && response.status !== 204 && response.status !== 412) throw cystStorageUnavailable();
    // A 412 is an idempotent retry only if the existing immutable object has the exact owner/size/hash.
    const stored = await this.read(owner, digest, bytes.byteLength); if (!stored) throw cystStorageUnavailable();
  }
}
