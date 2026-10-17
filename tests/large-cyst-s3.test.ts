import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LARGE_CYST_CHUNK_BYTES, LARGE_CYST_MAX_PART_BYTES,
  type LargeCystHeader, type LargeCystManifest } from '../src/cysts/large-checkpoints.js';
import { S3LargeCystStore, type S3LargeCystOptions } from '../src/cysts/large-s3.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const credentials = { accessKeyId: 'LARGELOCALTESTACCESS001', secretAccessKey: 'large-local-test-secret-123456789',
  sessionToken: 'large-local-test-session-token-123456789' };
const id = '0x' + 'a'.repeat(64);
const owner = '0x' + '1'.repeat(40);
const agent = '0x' + '2'.repeat(40);
const header: LargeCystHeader = { version: 1, algorithm: 'xchacha20-poly1305-chunked', id, owner, agent,
  applicationSchema: 'test/v1', plaintextBytes: 3, chunkBytes: LARGE_CYST_CHUNK_BYTES,
  chunkCount: 1, sourceMac: 'b'.repeat(64), keyCommitment: 'c'.repeat(64) };
const part = Buffer.alloc(43, 7);
const manifest: LargeCystManifest = { header, parts: [{ index: 0, bytes: part.length, sha256: sha256(part) }], mac: 'd'.repeat(64) };
interface StoredObject { body: Buffer; metadata: Record<string, string> }
interface Request { method: string; path: string; signed: boolean; conditional: boolean; bytes: number }

class LoopbackS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly requests: Request[] = [];
  readonly timers = new Set<ReturnType<typeof setTimeout>>();
  readonly server: Server;
  endpoint = '';
  failPut = false;
  failGet = false;
  ignoreCondition = false;
  redirect = false;
  slowHeaders = false;
  stallBody = false;
  extraChunk = false;
  shortBody = false;
  tamperKind: 'header' | 'manifest' | 'part' | 'canary' | undefined;
  tamperMetadata = false;

  constructor() {
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => res.destroy()); });
  }
  async start(): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    this.endpoint = `http://127.0.0.1:${address.port}`;
  }
  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
  private later(action: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); action(); }, 1000);
    this.timers.add(timer);
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let count = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk as Buffer);
      count += bytes.length;
      if (count > LARGE_CYST_MAX_PART_BYTES) { res.writeHead(413).end(); return; }
      chunks.push(bytes);
    }
    const body = Buffer.concat(chunks);
    const path = req.url ?? '/', method = req.method ?? 'GET';
    const signed = typeof req.headers.authorization === 'string'
      && req.headers.authorization.startsWith('AWS4-HMAC-SHA256 Credential=' + credentials.accessKeyId + '/')
      && req.headers['x-amz-content-sha256'] === sha256(body)
      && req.headers['x-amz-security-token'] === credentials.sessionToken;
    this.requests.push({ method, path, signed, conditional: req.headers['if-none-match'] === '*', bytes: body.length });
    if (!signed) { res.writeHead(403).end(); return; }
    if (!/^\/large-bucket\/large-cysts\/v1\/(?:[a-f0-9]{64}\/(?:header\.json|manifest\.json|part-[0-9]{6}\.bin)|_connectivity\/probe\.bin)$/.test(path)) {
      res.writeHead(404).end(); return;
    }
    if (this.redirect) { res.writeHead(307, { Location: this.endpoint + '/credential-trap' }).end(); return; }
    if (this.slowHeaders) { this.later(() => { if (!res.destroyed) res.writeHead(503).end(); }); return; }
    if (method === 'PUT') {
      if (this.failPut) { res.writeHead(503).end(); return; }
      if (req.headers['if-none-match'] !== '*' || req.headers['content-length'] !== String(body.length)) {
        res.writeHead(400).end(); return;
      }
      if (this.objects.has(path) && !this.ignoreCondition) { res.writeHead(412).end(); return; }
      const metadata: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (name.startsWith('x-amz-meta-') && typeof value === 'string') metadata[name] = value;
      }
      this.objects.set(path, { body, metadata });
      res.writeHead(201).end(); return;
    }
    if (method !== 'GET') { res.writeHead(405).end(); return; }
    if (this.failGet) { res.writeHead(503).end(); return; }
    const saved = this.objects.get(path);
    if (!saved) { res.writeHead(404).end(); return; }
    const type = path.endsWith('probe.bin') ? 'canary'
      : path.endsWith('header.json') ? 'header' : path.endsWith('manifest.json') ? 'manifest' : 'part';
    const headers: Record<string, string> = { ...saved.metadata, 'content-type': 'application/octet-stream' };
    let bytes = Buffer.from(saved.body);
    if (this.tamperKind === type) bytes[0] = (bytes[0] ?? 0) ^ 1;
    if (this.tamperMetadata && this.tamperKind === type) headers['x-amz-meta-telomere-large-id'] = '0'.repeat(64);
    if (!this.extraChunk && !this.shortBody) headers['content-length'] = String(bytes.length);
    res.writeHead(200, headers);
    if (this.stallBody) { res.write(bytes.subarray(0, 1)); this.later(() => { if (!res.destroyed) res.end(bytes.subarray(1)); }); return; }
    if (this.extraChunk && type === 'part') { res.write(bytes); res.end(Buffer.from([9])); return; }
    if (this.shortBody) bytes = bytes.subarray(0, bytes.length - 1);
    res.end(bytes);
  }
}

const options = (fixture: LoopbackS3, override: Partial<S3LargeCystOptions> = {}): S3LargeCystOptions => ({
  endpoint: fixture.endpoint, bucket: 'large-bucket', region: 'us-east-1', failureDomain: 'fixture-region-one',
  reviewed: true, credentials, allowInsecureLoopback: true,
  timeoutMs: 10_000, now: () => new Date('2026-10-13T00:00:00Z'), ...override,
});

describe('S3 large Cyst immutable object adapter', () => {
  let fixture: LoopbackS3, store: S3LargeCystStore;
  beforeEach(async () => {
    fixture = new LoopbackS3(); await fixture.start();
    store = new S3LargeCystStore(options(fixture)); await store.initialize();
  });
  afterEach(async () => { await fixture.close(); });

  it('probes one stable immutable canary with signed conditional PUT and exact GET on restart', async () => {
    const canary = [...fixture.objects.keys()].find(path => path.endsWith('/_connectivity/probe.bin'));
    expect(canary).toBeDefined();
    expect(fixture.objects.size).toBe(1);
    expect(fixture.requests.map(request => request.method)).toEqual(['PUT', 'PUT', 'GET']);
    expect(fixture.requests.every(request => request.signed && (request.method !== 'PUT' || request.conditional))).toBe(true);
    await store.initialize();
    expect(fixture.requests).toHaveLength(3);
    const restarted = new S3LargeCystStore(options(fixture)); await restarted.initialize();
    expect(fixture.requests.map(request => request.method)).toEqual(['PUT', 'PUT', 'GET', 'PUT', 'PUT', 'GET']);
    expect(fixture.objects.size).toBe(1);
    expect(fixture.objects.get(canary!)?.body.toString('utf8')).toBe('telomere.large-cyst.s3.connectivity.v1\n');
    const concurrent = new S3LargeCystStore(options(fixture));
    await Promise.all([concurrent.initialize(), concurrent.initialize()]);
    expect(fixture.requests.map(request => request.method)).toEqual([
      'PUT', 'PUT', 'GET', 'PUT', 'PUT', 'GET', 'PUT', 'PUT', 'GET',
    ]);
    expect(fixture.objects.size).toBe(1);
  });

  it('supports a permanently read-only operator audit without PUT on success or failure', async () => {
    const readonly = new S3LargeCystStore(options(fixture));
    const start = fixture.requests.length;
    await readonly.initializeReadOnly();
    expect(fixture.requests.slice(start).map(request => request.method)).toEqual(['GET']);
    expect(fixture.requests.slice(start).every(request => request.signed)).toBe(true);
    await expect(readonly.initialize()).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(readonly.begin(header)).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(fixture.requests.slice(start).map(request => request.method)).toEqual(['GET']);

    fixture.tamperKind = 'canary';
    const corrupt = new S3LargeCystStore(options(fixture));
    await expect(corrupt.initializeReadOnly()).rejects.toMatchObject({ code: 'integrity_failed' });
    expect(fixture.requests.slice(start).map(request => request.method)).toEqual(['GET', 'GET']);
  });

  it('cannot race read-only initialization into a live conditional PUT', async () => {
    const readonly = new S3LargeCystStore(options(fixture));
    const start = fixture.requests.length;
    fixture.stallBody = true;
    const probe = readonly.initializeReadOnly();
    await expect(readonly.initialize()).rejects.toMatchObject({ code: 'storage_unavailable' });
    await probe;
    expect(fixture.requests.slice(start).map(request => request.method)).toEqual(['GET']);
  });

  it('rejects a provider that ignores the immutable PUT precondition', async () => {
    fixture.objects.clear(); fixture.ignoreCondition = true;
    const untrusted = new S3LargeCystStore(options(fixture));
    const before = fixture.requests.length;
    await expect(untrusted.initialize()).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(fixture.requests.slice(before).map(request => request.method)).toEqual(['PUT', 'PUT']);
    expect(fixture.objects.size).toBe(1);
    await expect(untrusted.header(id)).rejects.toMatchObject({ code: 'storage_unavailable' });
    fixture.ignoreCondition = false;
    await untrusted.initialize();
    expect(fixture.objects.size).toBe(1);
  });

  it('fails startup on bad credentials, wrong bucket and unreachable endpoint', async () => {
    const wrongCredentials = new S3LargeCystStore(options(fixture,
      { credentials: { ...credentials, accessKeyId: 'WRONGACCESS0000001' } }));
    await expect(wrongCredentials.initialize()).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(wrongCredentials.header(id)).rejects.toMatchObject({ code: 'storage_unavailable' });
    const wrongBucket = new S3LargeCystStore(options(fixture, { bucket: 'other-bucket' }));
    await expect(wrongBucket.initialize()).rejects.toMatchObject({ code: 'storage_unavailable' });
    const unreachable = new S3LargeCystStore(options(fixture,
      { endpoint: 'http://127.0.0.1:1', timeoutMs: 100 }));
    await expect(unreachable.initialize()).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(fixture.objects.size).toBe(1);
  });

  it('fails closed on a tampered canary and retries the same key after recovery', async () => {
    fixture.tamperKind = 'canary'; fixture.tamperMetadata = true;
    const restarted = new S3LargeCystStore(options(fixture));
    await expect(restarted.initialize()).rejects.toMatchObject({ code: 'integrity_failed' });
    await expect(restarted.header(id)).rejects.toMatchObject({ code: 'storage_unavailable' });
    fixture.tamperKind = undefined; fixture.tamperMetadata = false;
    const canary = [...fixture.objects.keys()].find(path => path.endsWith('/_connectivity/probe.bin'))!;
    const object = fixture.objects.get(canary)!;
    const original = Buffer.from(object.body);
    object.body = Buffer.from(original); object.body[0] = (object.body[0] ?? 0) ^ 1;
    object.metadata['x-amz-meta-telomere-large-sha256'] = sha256(object.body);
    await expect(restarted.initialize()).rejects.toMatchObject({ code: 'storage_unavailable' });
    object.body = original;
    object.metadata['x-amz-meta-telomere-large-sha256'] = sha256(original);
    await restarted.initialize();
    expect(fixture.objects.size).toBe(1);
  });

  it('refuses canary write/read outages and can retry after an unknown PUT outcome', async () => {
    const restarted = new S3LargeCystStore(options(fixture));
    fixture.failPut = true;
    await expect(restarted.initialize()).rejects.toMatchObject({ code: 'storage_unavailable' });
    fixture.failPut = false; fixture.failGet = true;
    await expect(restarted.initialize()).rejects.toMatchObject({ code: 'storage_unavailable' });
    fixture.failGet = false;
    await restarted.initialize();
    expect(fixture.objects.size).toBe(1);
  });

  it('writes each scoped object conditionally and reads it back before acknowledging commit', async () => {
    expect(await store.header(id)).toBeUndefined();
    await store.begin(header); await store.putPart(id, 0, part); await store.commit(manifest);
    expect(await store.header(id)).toEqual(header);
    expect(await store.part(id, 0)).toEqual(part);
    expect(await store.manifest(id)).toEqual(manifest);
    expect(fixture.objects.size).toBe(4);
    expect(fixture.requests.every(request => request.signed && (request.method !== 'PUT' || request.conditional))).toBe(true);
    expect(fixture.requests.filter(request => request.method === 'PUT')).toHaveLength(5);
    for (const path of fixture.objects.keys()) {
      expect(path).not.toContain(id); expect(path).not.toContain(owner);
    }
  });

  it('propagates publication cancellation into an in-flight signed GET body', async () => {
    await store.begin(header); await store.putPart(id, 0, part); await store.commit(manifest);
    fixture.stallBody = true;
    const controller = new AbortController();
    const started = Date.now();
    const read = store.part(id, 0, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort(new Error('publication cancelled'));
    await expect(read).rejects.toThrow('publication cancelled');
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('allows exact 412 retries after restart but rejects conflicting immutable content', async () => {
    await store.begin(header); await store.putPart(id, 0, part); await store.commit(manifest);
    const restarted = new S3LargeCystStore(options(fixture)); await restarted.initialize();
    await restarted.begin(header); await restarted.putPart(id, 0, part); await restarted.commit(manifest);
    expect(fixture.objects.size).toBe(4);
    await expect(restarted.begin({ ...header, agent: owner })).rejects.toMatchObject({ code: 'conflict' });
    await expect(restarted.putPart(id, 0, Buffer.alloc(part.length, 8))).rejects.toMatchObject({ code: 'conflict' });
    await expect(restarted.commit({ ...manifest, mac: 'e'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('never commits an absent or digest-mismatched part', async () => {
    await store.begin(header);
    await expect(store.commit(manifest)).rejects.toMatchObject({ code: 'incomplete' });
    await store.putPart(id, 0, part);
    await expect(store.commit({ ...manifest, parts: [{ ...manifest.parts[0]!, sha256: '0'.repeat(64) }] }))
      .rejects.toMatchObject({ code: 'integrity_failed' });
    expect(await store.manifest(id)).toBeUndefined();
  });

  it('rejects noncanonical JSON even when the remote metadata matches those bytes', async () => {
    await store.begin(header);
    const path = [...fixture.objects.keys()].find(value => value.endsWith('header.json'))!;
    const object = fixture.objects.get(path)!;
    object.body = Buffer.from(JSON.stringify(header) + '\n');
    object.metadata['x-amz-meta-telomere-large-sha256'] = sha256(object.body);
    object.metadata['x-amz-meta-telomere-large-bytes'] = String(object.body.length);
    await expect(store.header(id)).rejects.toMatchObject({ code: 'integrity_failed' });
  });

  it('rejects a noncanonical manifest and an altered committed part', async () => {
    await store.begin(header); await store.putPart(id, 0, part); await store.commit(manifest);
    const manifestPath = [...fixture.objects.keys()].find(path => path.endsWith('manifest.json'))!;
    const saved = fixture.objects.get(manifestPath)!;
    saved.body = Buffer.from(JSON.stringify(manifest) + ' ');
    saved.metadata['x-amz-meta-telomere-large-sha256'] = sha256(saved.body);
    saved.metadata['x-amz-meta-telomere-large-bytes'] = String(saved.body.length);
    await expect(store.manifest(id)).rejects.toMatchObject({ code: 'integrity_failed' });
    saved.body = Buffer.from(JSON.stringify({ ...manifest, header: { ...header, agent: owner } }));
    saved.metadata['x-amz-meta-telomere-large-sha256'] = sha256(saved.body);
    saved.metadata['x-amz-meta-telomere-large-bytes'] = String(saved.body.length);
    await expect(store.manifest(id)).rejects.toMatchObject({ code: 'integrity_failed' });
    saved.body = Buffer.from(JSON.stringify(manifest));
    saved.metadata['x-amz-meta-telomere-large-sha256'] = sha256(saved.body);
    saved.metadata['x-amz-meta-telomere-large-bytes'] = String(saved.body.length);
    const partPath = [...fixture.objects.keys()].find(path => path.endsWith('part-000000.bin'))!;
    const altered = fixture.objects.get(partPath)!;
    altered.body = Buffer.alloc(part.length, 8);
    altered.metadata['x-amz-meta-telomere-large-sha256'] = sha256(altered.body);
    await expect(store.part(id, 0)).rejects.toMatchObject({ code: 'integrity_failed' });
  });

  it('bounds a full 4 MiB + 40 part, rejects extra chunked bytes and tampered metadata', async () => {
    const largeHeader = { ...header, plaintextBytes: LARGE_CYST_CHUNK_BYTES };
    const largePart = Buffer.alloc(LARGE_CYST_MAX_PART_BYTES, 4);
    await store.begin(largeHeader); await store.putPart(id, 0, largePart);
    const saved = await store.part(id, 0);
    expect(saved?.length).toBe(LARGE_CYST_MAX_PART_BYTES);
    expect(sha256(saved!)).toBe(sha256(largePart));
    fixture.extraChunk = true;
    await expect(store.part(id, 0)).rejects.toMatchObject({ code: 'integrity_failed' });
    fixture.extraChunk = false; fixture.tamperKind = 'part'; fixture.tamperMetadata = true;
    await expect(store.part(id, 0)).rejects.toMatchObject({ code: 'integrity_failed' });
  }, 90_000);

  it('rejects truncated objects, remote errors and redirects without a second request', async () => {
    await store.begin(header); await store.putPart(id, 0, part);
    fixture.shortBody = true;
    await expect(store.part(id, 0)).rejects.toMatchObject({ code: 'integrity_failed' });
    fixture.shortBody = false; fixture.failGet = true;
    await expect(store.header(id)).rejects.toMatchObject({ code: 'storage_unavailable' });
    fixture.failGet = false; fixture.redirect = true;
    const before = fixture.requests.length;
    await expect(store.header(id)).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(fixture.requests).toHaveLength(before + 1);
  });

  it('times out both response headers and a stalled response body', async () => {
    const short = new S3LargeCystStore(options(fixture, { timeoutMs: 100 })); await short.initialize();
    fixture.slowHeaders = true;
    await expect(short.header(id)).rejects.toMatchObject({ code: 'storage_unavailable' });
    fixture.slowHeaders = false; await store.begin(header);
    fixture.stallBody = true;
    await expect(short.header(id)).rejects.toMatchObject({ code: 'storage_unavailable' });
  });

  it('keeps credentials out of errors and serialization and rejects unreviewed destinations', async () => {
    fixture.failPut = true;
    let error: unknown;
    try { await store.begin(header); } catch (caught) { error = caught; }
    for (const value of [String(error), JSON.stringify(store), inspect(store)]) {
      expect(value).not.toContain(credentials.secretAccessKey);
      expect(value).not.toContain(credentials.sessionToken);
      expect(value).not.toContain(credentials.accessKeyId);
    }
    expect(() => new S3LargeCystStore({ ...options(fixture), reviewed: false as true })).toThrow();
    expect(() => new S3LargeCystStore({ ...options(fixture), endpoint: 'http://example.org/' })).toThrow();
    expect(() => new S3LargeCystStore({ ...options(fixture), endpoint: 'https://user:password@example.org/' })).toThrow();
  });
});
