import { createHash, timingSafeEqual } from 'node:crypto';
import { LARGE_CYST_MAX_PACKAGE_BYTES, LargeCystError, largeCystPartBytes,
  parseLargeCystHeader, parseLargeCystManifest, type LargeCystHeader,
  type LargeCystManifest, type LargeCystStore } from './large-checkpoints.js';
import { signS3Request, type S3Credentials } from './s3.js';
import { cystIdSchema } from './types.js';

const MAX_HEADER_BYTES = 2048;
const MAX_MANIFEST_BYTES = 131_072;
const CANARY_KEY = 'large-cysts/v1/_connectivity/probe.bin';
const CANARY_BYTES = Buffer.from('telomere.large-cyst.s3.connectivity.v1\n', 'utf8');
const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fail = (code: LargeCystError['code']): LargeCystError => new LargeCystError(code);
const canonical = (value: object): Buffer => Buffer.from(JSON.stringify(value), 'utf8');

export interface S3LargeCystOptions {
  endpoint: string;
  bucket: string;
  region: string;
  failureDomain: string;
  reviewed: true;
  credentials: S3Credentials;
  allowInsecureLoopback?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface ReviewedLargeCystDestination {
  endpoint: string;
  bucket: string;
  region: string;
  failureDomain: string;
  reviewed: true;
}

type ObjectKind = 'header' | 'manifest' | `part-${string}`;

function checkedCredentials(credentials: S3Credentials): S3Credentials {
  if (!credentials || !/^[A-Za-z0-9_-]{2,128}$/.test(credentials.accessKeyId)
    || !/^[\x21-\x7e]{16,256}$/.test(credentials.secretAccessKey)
    || credentials.sessionToken !== undefined && !/^[\x21-\x7e]{20,8192}$/.test(credentials.sessionToken)) {
    throw fail('storage_unavailable');
  }
  return { ...credentials };
}

function partKind(index: number): ObjectKind {
  if (!Number.isSafeInteger(index) || index < 0 || index > 999_999) throw fail('integrity_failed');
  return `part-${index.toString().padStart(6, '0')}`;
}

function objectPath(id: string, kind: ObjectKind): string {
  cystIdSchema.parse(id);
  const opaqueId = sha256('telomere.large-cyst.s3.v1\0' + id);
  return `large-cysts/v1/${opaqueId}/${kind}${kind.startsWith('part-') ? '.bin' : '.json'}`;
}

function metadata(id: string, kind: ObjectKind, bytes: Uint8Array): Record<string, string> {
  return {
    'x-amz-meta-telomere-large-version': '1',
    'x-amz-meta-telomere-large-id': sha256('telomere.large-cyst.s3.v1\0' + id),
    'x-amz-meta-telomere-large-kind': kind,
    'x-amz-meta-telomere-large-sha256': sha256(bytes),
    'x-amz-meta-telomere-large-bytes': String(bytes.byteLength),
  };
}

function canaryMetadata(bytes: Uint8Array): Record<string, string> {
  return {
    'x-amz-meta-telomere-large-version': '1',
    'x-amz-meta-telomere-large-id': sha256('telomere.large-cyst.s3.connectivity.v1'),
    'x-amz-meta-telomere-large-kind': 'canary',
    'x-amz-meta-telomere-large-sha256': sha256(bytes),
    'x-amz-meta-telomere-large-bytes': String(bytes.byteLength),
  };
}

/** One reviewed, immutable S3 destination. Replication is provided by LargeCystReplicatedStore. */
export class S3LargeCystStore implements LargeCystStore {
  readonly destination: ReviewedLargeCystDestination;
  #endpoint: URL;
  #credentials: S3Credentials;
  #timeoutMs: number;
  #fetch: typeof fetch;
  #now: () => Date;
  #initialized = false;
  #readOnly = false;
  #initializing: Promise<void> | undefined;

  constructor(options: S3LargeCystOptions) {
    let endpoint: URL;
    try { endpoint = new URL(options.endpoint); } catch { throw fail('storage_unavailable'); }
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname);
    if (options.reviewed !== true || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.pathname !== '/' || endpoint.protocol !== 'https:'
        && !(options.allowInsecureLoopback === true && loopback && endpoint.protocol === 'http:')
      || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) || options.bucket.includes('..')
      || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.region)
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.failureDomain)) throw fail('storage_unavailable');
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60_000) throw fail('storage_unavailable');
    this.#endpoint = endpoint;
    this.#credentials = checkedCredentials(options.credentials);
    this.#timeoutMs = timeoutMs;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.destination = Object.freeze({ endpoint: endpoint.origin, bucket: options.bucket,
      region: options.region, failureDomain: options.failureDomain, reviewed: true });
  }

  async initialize(): Promise<void> {
    if (this.#readOnly) throw fail('storage_unavailable');
    if (this.#initialized) return;
    if (this.#initializing) return this.#initializing;
    const task = (async () => {
      const response = await this.requestObject('PUT', CANARY_KEY, canaryMetadata(CANARY_BYTES), CANARY_BYTES, true);
      await response.body?.cancel().catch(() => undefined);
      if (![200, 201, 204, 412].includes(response.status)) throw fail('storage_unavailable');
      // A provider that ignores If-None-Match could silently overwrite both the
      // canary and checkpoint objects. Require an observed precondition failure.
      const conditional = await this.requestObject('PUT', CANARY_KEY, canaryMetadata(CANARY_BYTES), CANARY_BYTES, true);
      await conditional.body?.cancel().catch(() => undefined);
      if (conditional.status !== 412) throw fail('storage_unavailable');
      await this.probeCanary();
      this.#initialized = true;
    })();
    this.#initializing = task;
    try { await task; } finally { if (this.#initializing === task) this.#initializing = undefined; }
  }

  /** Allow an offline operator to audit existing immutable objects. This only
   * performs a signed GET of the pinned canary; it never exercises or claims
   * the conditional-write capability required by the live writer. */
  async initializeReadOnly(): Promise<void> {
    if (this.#initialized) {
      if (!this.#readOnly) throw fail('storage_unavailable');
      return;
    }
    if (this.#initializing) throw fail('storage_unavailable');
    // Set before the first await, so a concurrent initialize() cannot issue a
    // conditional PUT while the signed GET is still in flight.
    this.#readOnly = true;
    await this.probeCanary();
    this.#initialized = true;
  }

  /** Read-only signed GET of the immutable startup canary. This proves current
   * read access and object integrity, not that a later conditional PUT will work.
   */
  async probeCanary(): Promise<void> {
    const stored = await this.getObject(CANARY_KEY, CANARY_BYTES.byteLength, CANARY_BYTES.byteLength,
      canaryMetadata, true);
    if (!stored || !timingSafeEqual(stored, CANARY_BYTES)) throw fail('storage_unavailable');
  }
  toJSON(): ReviewedLargeCystDestination { return this.destination; }

  private async requestObject(method: 'GET' | 'PUT', key: string, objectMetadata?: Record<string, string>,
    body?: Uint8Array, probing = false, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted();
    if (method !== 'GET' && this.#readOnly) throw fail('storage_unavailable');
    if (!probing && !this.#initialized) throw fail('storage_unavailable');
    const url = new URL('/' + this.destination.bucket + '/' + key, this.#endpoint);
    const extra = body === undefined ? {} : { ...objectMetadata, 'content-type': 'application/octet-stream',
      'content-length': String(body.byteLength), 'if-none-match': '*' };
    try {
      const headers = signS3Request({ method, url, region: this.destination.region,
        credentials: this.#credentials, date: this.#now(), headers: extra,
        ...(body === undefined ? {} : { body }) });
      const response = await this.#fetch(url, { method, headers, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]) : AbortSignal.timeout(this.#timeoutMs),
        ...(body === undefined ? {} : { body: Uint8Array.from(body).buffer }) });
      if (response.redirected || response.url && response.url !== url.href) {
        await response.body?.cancel().catch(() => undefined); throw fail('storage_unavailable');
      }
      return response;
    } catch { signal?.throwIfAborted(); throw fail('storage_unavailable'); }
  }

  private request(method: 'GET' | 'PUT', id: string, kind: ObjectKind, body?: Uint8Array): Promise<Response> {
    return this.requestObject(method, objectPath(id, kind), body === undefined ? undefined : metadata(id, kind, body), body);
  }

  private async getObject(key: string, maxBytes: number, expectedBytes: number | undefined,
    expectedMetadata: (bytes: Uint8Array) => Record<string, string>, probing = false, signal?: AbortSignal): Promise<Buffer | undefined> {
    const response = await this.requestObject('GET', key, undefined, undefined, probing, signal);
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return undefined; }
    if (response.status !== 200 || response.headers.has('content-encoding')) {
      await response.body?.cancel().catch(() => undefined);
      throw fail(response.status === 200 ? 'integrity_failed' : 'storage_unavailable');
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maxBytes
      || expectedBytes !== undefined && Number(declared) !== expectedBytes)) {
      await response.body?.cancel().catch(() => undefined); throw fail('integrity_failed');
    }
    const reader = response.body?.getReader();
    if (!reader) throw fail('storage_unavailable');
    const parts: Buffer[] = [];
    let count = 0, complete = false;
    try {
      while (true) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try { result = await reader.read(); } catch { signal?.throwIfAborted(); throw fail('storage_unavailable'); }
        signal?.throwIfAborted();
        if (result.done) { complete = true; break; }
        if (result.value.byteLength > maxBytes - count) throw fail('integrity_failed');
        const copy = Buffer.from(result.value); parts.push(copy); count += copy.byteLength;
      }
    } finally {
      if (!complete) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (expectedBytes !== undefined && count !== expectedBytes || declared !== null && count !== Number(declared)) {
      throw fail('integrity_failed');
    }
    const bytes = Buffer.concat(parts, count);
    for (const [name, value] of Object.entries(expectedMetadata(bytes))) {
      if (response.headers.get(name) !== value) throw fail('integrity_failed');
    }
    return bytes;
  }

  private get(id: string, kind: ObjectKind, maxBytes: number, expectedBytes?: number, signal?: AbortSignal): Promise<Buffer | undefined> {
    return this.getObject(objectPath(id, kind), maxBytes, expectedBytes, bytes => metadata(id, kind, bytes), false, signal);
  }

  private async put(id: string, kind: ObjectKind, bytes: Uint8Array): Promise<void> {
    const snapshot = Uint8Array.from(bytes);
    const response = await this.request('PUT', id, kind, snapshot);
    await response.body?.cancel().catch(() => undefined);
    if (![200, 201, 204, 412].includes(response.status)) throw fail('storage_unavailable');
    const stored = await this.get(id, kind, snapshot.byteLength, snapshot.byteLength);
    if (!stored) throw fail('storage_unavailable');
    if (!timingSafeEqual(stored, snapshot)) throw fail('conflict');
  }

  async begin(input: LargeCystHeader): Promise<void> {
    const header = parseLargeCystHeader(input);
    const bytes = canonical(header);
    if (bytes.byteLength > MAX_HEADER_BYTES) throw fail('integrity_failed');
    await this.put(header.id, 'header', bytes);
  }

  async header(id: string, signal?: AbortSignal): Promise<LargeCystHeader | undefined> {
    cystIdSchema.parse(id);
    const bytes = await this.get(id, 'header', MAX_HEADER_BYTES, undefined, signal);
    if (!bytes) return undefined;
    try {
      const value = parseLargeCystHeader(JSON.parse(bytes.toString('utf8')));
      if (value.id !== id || !canonical(value).equals(bytes)) throw fail('integrity_failed');
      return value;
    } catch { throw fail('integrity_failed'); }
  }

  async putPart(id: string, index: number, bytes: Uint8Array): Promise<void> {
    const header = await this.header(id);
    if (!header) throw fail('incomplete');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== largeCystPartBytes(header, index)) {
      throw fail('integrity_failed');
    }
    await this.put(id, partKind(index), bytes);
  }

  private async readPart(header: LargeCystHeader, index: number, expectedDigest?: string, signal?: AbortSignal): Promise<Buffer | undefined> {
    const length = largeCystPartBytes(header, index);
    const bytes = await this.get(header.id, partKind(index), length, length, signal);
    if (bytes && expectedDigest !== undefined && sha256(bytes) !== expectedDigest) throw fail('integrity_failed');
    return bytes;
  }

  async part(id: string, index: number, signal?: AbortSignal): Promise<Buffer | undefined> {
    const header = await this.header(id, signal);
    if (!header) throw fail('incomplete');
    const manifest = await this.manifest(id, signal);
    return this.readPart(header, index, manifest?.parts[index]?.sha256, signal);
  }

  async commit(input: LargeCystManifest): Promise<void> {
    const manifest = parseLargeCystManifest(input);
    const header = await this.header(manifest.header.id);
    if (!header || !canonical(header).equals(canonical(manifest.header))) throw fail('conflict');
    const bytes = canonical(manifest);
    if (bytes.byteLength > MAX_MANIFEST_BYTES
      || manifest.parts.reduce((sum, part) => sum + part.bytes, bytes.byteLength + canonical(header).byteLength)
        > LARGE_CYST_MAX_PACKAGE_BYTES) throw fail('integrity_failed');
    for (const part of manifest.parts) {
      if (!await this.readPart(header, part.index, part.sha256)) throw fail('incomplete');
    }
    await this.put(header.id, 'manifest', bytes);
  }

  async manifest(id: string, signal?: AbortSignal): Promise<LargeCystManifest | undefined> {
    cystIdSchema.parse(id);
    const bytes = await this.get(id, 'manifest', MAX_MANIFEST_BYTES, undefined, signal);
    if (!bytes) return undefined;
    let value: LargeCystManifest;
    try {
      value = parseLargeCystManifest(JSON.parse(bytes.toString('utf8')));
      if (value.header.id !== id || !canonical(value).equals(bytes)
        || value.parts.reduce((sum, part) => sum + part.bytes, bytes.byteLength + canonical(value.header).byteLength)
          > LARGE_CYST_MAX_PACKAGE_BYTES) throw fail('integrity_failed');
    } catch { throw fail('integrity_failed'); }
    const storedHeader = await this.header(id, signal);
    if (!storedHeader || !canonical(storedHeader).equals(canonical(value.header))) throw fail('integrity_failed');
    return value;
  }
}
