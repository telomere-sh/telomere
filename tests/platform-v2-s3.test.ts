import { describe, expect, it } from 'vitest';
import { PlatformV2S3EvidenceStore, platformV2S3StoreConfigSchema,
  type PlatformV2S3EvidenceOptions } from '../src/receipts/platform-v2-s3.js';

const scope = `0x${'a'.repeat(64)}`, digest = `0x${'b'.repeat(64)}`, runId = `0x${'c'.repeat(64)}`;
const coreKey = `v2/${scope}/${digest}/core.json`, manifestKey = `v2/${scope}/runs/${runId}/manifest.json`;
const credentials = { accessKeyId: 'fixture-access-key', secretAccessKey: 'fixture-secret-key-abcdefghijklmnop',
  sessionToken: 'fixture-session-token-abcdefghijklmnop' };
const fixed: Omit<PlatformV2S3EvidenceOptions, 'fetchImpl'> = { identity: 'reviewed-a', failureDomain: 'region-a',
  endpoint: 'http://127.0.0.1:9', bucket: 'evidence-a', region: 'us-east-1', credentials,
  reviewed: true, allowDevelopment: true, now: () => new Date('2026-10-14T00:00:00.000Z') };
const operation = (maxBytes = 1024) => ({ maxBytes, signal: new AbortController().signal });
const data = Buffer.from('{"public":"evidence"}');
function fixture() {
  const objects = new Map<string, Uint8Array>(), requests: { method: string; url: string; headers: Headers; redirect: RequestRedirect | undefined }[] = [];
  let loseResponse = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', headers = new Headers(init?.headers);
    requests.push({ method, url: url.toString(), headers, redirect: init?.redirect });
    if (method === 'PUT') {
      expect(headers.get('if-none-match')).toBe('*');
      if (objects.has(url.pathname)) return new Response(null, { status: 412 });
      if (!(init?.body instanceof ArrayBuffer)) throw new Error('unexpected body');
      objects.set(url.pathname, new Uint8Array(init.body.slice(0)));
      if (loseResponse) { loseResponse = false; throw new Error(`lost response ${credentials.secretAccessKey}`); }
      return new Response(null, { status: 201 });
    }
    if (method !== 'GET') throw new Error('unexpected operation');
    const bytes = objects.get(url.pathname);
    return bytes ? new Response(Uint8Array.from(bytes), { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
      : new Response(null, { status: 404 });
  };
  return { objects, requests, fetchImpl, loseNextResponse: () => { loseResponse = true; } };
}

describe('reviewed S3 Platform v2 public evidence transport', () => {
  it('validates fixed HTTPS config and never serializes inline credentials', () => {
    const parsed = platformV2S3StoreConfigSchema.parse({ identity: fixed.identity, failureDomain: fixed.failureDomain,
      endpoint: 'https://s3.example/', bucket: fixed.bucket, region: fixed.region, credentialsFile: '/private/evidence-key.json' });
    expect(parsed.endpoint).toBe('https://s3.example');
    for (const endpoint of ['http://s3.example', fixed.endpoint, 'https://user:password@s3.example',
      'https://s3.example/?query=1', 'https://s3.example/#fragment', 'https://s3.example/path']) {
      expect(platformV2S3StoreConfigSchema.safeParse({ ...parsed, endpoint }).success).toBe(false);
      expect(() => new PlatformV2S3EvidenceStore({ ...fixed, endpoint, allowDevelopment: false })).toThrow('configuration');
    }
    expect(() => new PlatformV2S3EvidenceStore({ ...fixed, endpoint: 'http://s3.example', allowDevelopment: true })).toThrow('configuration');
    expect(platformV2S3StoreConfigSchema.safeParse({ ...parsed, credentials }).success).toBe(false);
    const json = JSON.stringify(new PlatformV2S3EvidenceStore(fixed));
    for (const secret of [credentials.accessKeyId, credentials.secretAccessKey, credentials.sessionToken]) expect(json).not.toContain(secret);
    expect(JSON.parse(json)).toMatchObject({ endpoint: fixed.endpoint, bucket: fixed.bucket, identity: fixed.identity });
  });

  it('signs conditional writes and readbacks, accepting only byte-exact immutable412 retries', async () => {
    const server = fixture(), store = new PlatformV2S3EvidenceStore({ ...fixed, fetchImpl: server.fetchImpl });
    await store.putImmutable(coreKey, data, operation());
    await store.putImmutable(coreKey, data, operation());
    expect(server.requests.map(request => request.method)).toEqual(['PUT', 'GET', 'PUT', 'GET']);
    for (const request of server.requests) {
      expect(request.redirect).toBe('error');
      expect(request.url).toBe(`${fixed.endpoint}/${fixed.bucket}/${coreKey}`);
      expect(request.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
      expect(request.headers.get('x-amz-date')).toBe('20261014T000000Z');
      expect(request.headers.get('x-amz-content-sha256')).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(server.requests[0]!.headers.get('authorization')).toContain('if-none-match');
    const changed = Uint8Array.from(data); changed[changed.length - 2] = 49;
    await expect(store.putImmutable(coreKey, changed, operation())).rejects.toThrow('integrity');
    expect(await store.get(coreKey, operation())).toEqual(Uint8Array.from(data));
    expect(await store.get(manifestKey, operation())).toBeUndefined();
  });

  it('recovers after server commit and lost response by replaying identical keys and bytes', async () => {
    const server = fixture(), store = new PlatformV2S3EvidenceStore({ ...fixed, fetchImpl: server.fetchImpl });
    server.loseNextResponse();
    await expect(store.putImmutable(manifestKey, data, operation())).rejects.toThrow('storage is unavailable');
    expect(server.objects.size).toBe(1);
    await store.putImmutable(manifestKey, data, operation());
    expect(server.objects.size).toBe(1);
    expect(server.requests.map(request => request.method)).toEqual(['PUT', 'PUT', 'GET']);
  });

  it('rejects paths, oversized writes and invalid bounds before any request', async () => {
    const server = fixture(), store = new PlatformV2S3EvidenceStore({ ...fixed, fetchImpl: server.fetchImpl });
    for (const key of ['other/private.json', `${coreKey}/../secret`, coreKey.replace('v2/', 'v1/'),
      coreKey.replace('/core.json', '/private.json'), `${manifestKey}?endpoint=evil`, coreKey.toUpperCase()]) {
      await expect(store.get(key, operation())).rejects.toThrow();
      await expect(store.putImmutable(key, data, operation())).rejects.toThrow();
    }
    for (const maxBytes of [0, 262145, -1, 1.5]) await expect(store.get(coreKey, operation(maxBytes))).rejects.toThrow();
    await expect(store.putImmutable(coreKey, data, operation(1))).rejects.toThrow();
    expect(server.requests).toHaveLength(0);
  });

  it('rejects non-200 GET statuses, redirects, encoded and oversized metadata before streaming', async () => {
    for (const response of [new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
      new Response(null, { status: 403 }), new Response(data, { headers: { 'content-encoding': 'gzip' } }),
      new Response(data, { headers: { 'content-length': '262145' } }),
      new Response(data, { headers: { 'content-length': '99999999999999999999999' } }),
      new Response(data, { headers: { 'content-length': '01' } })]) {
      const store = new PlatformV2S3EvidenceStore({ ...fixed, fetchImpl: async () => response });
      await expect(store.get(coreKey, operation())).rejects.toThrow('integrity');
    }
  });

  it('limits streamed objects even without content-length and checks declared exact byte count', async () => {
    let cancelled = 0;
    const oversized = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(5));
    }, cancel() { cancelled++; } });
    const store = new PlatformV2S3EvidenceStore({ ...fixed, fetchImpl: async () => new Response(oversized) });
    await expect(store.get(coreKey, operation(8))).rejects.toThrow('integrity');
    expect(cancelled).toBe(1);
    const short = new PlatformV2S3EvidenceStore({ ...fixed,
      fetchImpl: async () => new Response(data, { headers: { 'content-length': String(data.byteLength + 1) } }) });
    await expect(short.get(coreKey, operation())).rejects.toThrow('integrity');
    const unlabelled = new PlatformV2S3EvidenceStore({ ...fixed, fetchImpl: async () => new Response(data) });
    expect(await unlabelled.get(coreKey, operation(data.byteLength))).toEqual(Uint8Array.from(data));
  });

  it('rejects successful PUT acknowledgements unless their readback has the exact submitted bytes', async () => {
    for (const status of [200, 201, 204, 412]) {
      const fetchImpl: typeof fetch = async (_input, init) => init?.method === 'PUT'
        ? new Response(null, { status }) : new Response(Buffer.from('wrong'));
      const store = new PlatformV2S3EvidenceStore({ ...fixed, fetchImpl });
      await expect(store.putImmutable(coreKey, data, operation())).rejects.toThrow('integrity');
    }
  });

  it('honours cancellation before request, while awaiting response, and while streaming', async () => {
    const server = fixture(), store = new PlatformV2S3EvidenceStore({ ...fixed, fetchImpl: server.fetchImpl });
    const stopped = new AbortController(); stopped.abort();
    await expect(store.get(coreKey, { signal: stopped.signal, maxBytes: 1024 })).rejects.toThrow();
    expect(server.requests).toHaveLength(0);
    let responseCancelled = 0;
    const awaiting: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { responseCancelled++; reject(new Error('cancelled')); }, { once: true });
    });
    await expect(new PlatformV2S3EvidenceStore({ ...fixed, fetchImpl: awaiting, timeoutMs: 15 }).get(coreKey, operation())).rejects.toThrow();
    expect(responseCancelled).toBe(1);
    let streamCancelled = 0;
    const streaming: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { streamCancelled++; },
    }));
    await expect(new PlatformV2S3EvidenceStore({ ...fixed, fetchImpl: streaming, timeoutMs: 15 }).get(coreKey, operation())).rejects.toThrow();
    expect(streamCancelled).toBe(1);
  });

  it('keeps storage and response errors redacted', async () => {
    const store = new PlatformV2S3EvidenceStore({ ...fixed, fetchImpl: async () => { throw new Error(credentials.secretAccessKey); } });
    let message = '';
    try { await store.get(coreKey, operation()); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain('storage is unavailable');
    expect(message).not.toContain(credentials.secretAccessKey);
  });
});
