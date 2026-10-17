import { LARGE_CYST_MAX_PART_BYTES, largeCystPartBytes, parseLargeCystHeader,
  parseLargeCystManifest, type LargeCystHeader, type LargeCystManifest, type LargeCystStore } from '../cysts/large-checkpoints.js';
import { cystIdSchema } from '../cysts/types.js';

function endpoint(value: string): string {
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password
    || !['https:', 'http:'].includes(url.protocol)
    || url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Use an HTTPS origin or loopback HTTP for the large Cyst client');
  }
  return url.origin;
}
async function boundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding !== 'identity') throw new Error('Compressed large Cyst response refused');
  const declared = response.headers.get('content-length');
  if (declared && (!/^(0|[1-9][0-9]{0,9})$/.test(declared) || Number(declared) > maxBytes)) {
    throw new Error('Large Cyst response exceeds the byte limit');
  }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Large Cyst response body missing');
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      if (item.value.length > maxBytes - total) throw new Error('Large Cyst response exceeds the byte limit');
      chunks.push(item.value); total += item.value.length;
    }
    if (declared && total !== Number(declared)) throw new Error('Large Cyst response length changed');
    return Buffer.concat(chunks, total);
  } finally { try { await reader.cancel(); } catch { /* Response already complete. */ } }
}
function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { throw new Error('Invalid large Cyst JSON response'); }
}

/** Node-only owner-side adapter (it sets an explicit Cookie and Origin header).
 * The recovery key and plaintext remain with save/restore;
 * this client transfers only headers, ciphertext parts and manifests.
 */
export class LargeCystHttpStore implements LargeCystStore {
  private readonly origin: string;
  private readonly sessionToken: string;
  private readonly fetcher: typeof fetch;
  private readonly headers = new Map<string, LargeCystHeader>();
  constructor(options: { baseUrl: string; sessionToken: string; fetchImpl?: typeof fetch }) {
    this.origin = endpoint(options.baseUrl);
    if (!/^[0-9a-f]{64}$/.test(options.sessionToken)) throw new Error('Invalid owner session');
    this.sessionToken = options.sessionToken;
    this.fetcher = options.fetchImpl ?? fetch;
  }
  private async request(path: string, method: 'GET' | 'POST' | 'PUT', body: Uint8Array | object | undefined,
    maxResponseBytes: number): Promise<{ status: number; bytes: Buffer }> {
    const binary = body instanceof Uint8Array;
    const headers = new Headers();
    if (method !== 'GET') {
      headers.set('Origin', this.origin);
      headers.set('Content-Type', binary ? 'application/octet-stream' : 'application/json');
    }
    headers.set('Cookie', 'telomere_session=' + this.sessionToken);
    const signal = AbortSignal.timeout(60_000);
    const response = await this.fetcher(this.origin + '/api/cysts-large' + path, {
      method, headers, credentials: 'include', redirect: 'error', cache: 'no-store', signal,
      ...(body === undefined ? {} : { body: binary ? Uint8Array.from(body) : JSON.stringify(body) }),
    });
    if (![200, 201].includes(response.status)) {
      await response.body?.cancel();
      if (response.status === 404 || response.status === 409) return { status: response.status, bytes: Buffer.alloc(0) };
      throw new Error('Large Cyst request failed with HTTP ' + response.status);
    }
    return { status: response.status, bytes: await boundedResponse(response, maxResponseBytes) };
  }
  async begin(input: LargeCystHeader): Promise<void> {
    const header = parseLargeCystHeader(input);
    const result = await this.request('', 'POST', header, 2048);
    if (result.status !== 201 || JSON.stringify(parseLargeCystHeader(parseJson(result.bytes))) !== JSON.stringify(header)) {
      throw new Error('Large Cyst header upload was not acknowledged exactly');
    }
    this.headers.set(header.id, header);
  }
  async header(id: string): Promise<LargeCystHeader | undefined> {
    const checked = cystIdSchema.parse(id), result = await this.request('/' + checked + '/header', 'GET', undefined, 2048);
    if (result.status === 404) return undefined;
    const value = parseLargeCystHeader(parseJson(result.bytes));
    if (value.id !== checked) throw new Error('Large Cyst header ID changed');
    this.headers.set(checked, value); return value;
  }
  async putPart(id: string, index: number, bytes: Uint8Array): Promise<void> {
    const checked = cystIdSchema.parse(id), header = this.headers.get(checked) ?? await this.header(checked);
    if (!header || bytes.length !== largeCystPartBytes(header, index)) throw new Error('Invalid large Cyst part');
    const result = await this.request('/' + checked + '/parts/' + index, 'PUT', bytes, 256);
    if (result.status !== 201 || JSON.stringify(parseJson(result.bytes)) !== JSON.stringify({ index, bytes: bytes.length })) {
      throw new Error('Large Cyst part upload was not acknowledged exactly');
    }
  }
  async part(id: string, index: number): Promise<Buffer | undefined> {
    const checked = cystIdSchema.parse(id), header = this.headers.get(checked) ?? await this.header(checked);
    if (!header) return undefined;
    const expected = largeCystPartBytes(header, index);
    const result = await this.request('/' + checked + '/parts/' + index, 'GET', undefined,
      Math.min(expected, LARGE_CYST_MAX_PART_BYTES));
    if (result.status === 404) return undefined;
    if (result.bytes.length !== expected) throw new Error('Large Cyst part length changed');
    return result.bytes;
  }
  async commit(input: LargeCystManifest): Promise<void> {
    const manifest = parseLargeCystManifest(input), id = manifest.header.id;
    const result = await this.request('/' + id + '/commit', 'POST', manifest, 131_072);
    if (result.status !== 200 || JSON.stringify(parseLargeCystManifest(parseJson(result.bytes))) !== JSON.stringify(manifest)) {
      throw new Error('Large Cyst manifest commit was not acknowledged exactly');
    }
  }
  async manifest(id: string): Promise<LargeCystManifest | undefined> {
    const checked = cystIdSchema.parse(id), result = await this.request('/' + checked + '/manifest', 'GET', undefined, 131_072);
    if (result.status === 409 || result.status === 404) return undefined;
    const value = parseLargeCystManifest(parseJson(result.bytes));
    if (value.header.id !== checked) throw new Error('Large Cyst manifest ID changed');
    return value;
  }
}
