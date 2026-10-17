import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CYST_CAPABILITIES } from '../src/cysts/types.js';
import { ReplicatedCystStorage } from '../src/cysts/replicated.js';
import { cystObjectKey, S3CiphertextStorage, signS3Request, type S3CiphertextOptions, type S3Credentials } from '../src/cysts/s3.js';
import { decryptCheckpoint, encryptCheckpoint } from '../src/sdk/cysts.js';

const owner = '0x1111111111111111111111111111111111111111', foreign = '0x2222222222222222222222222222222222222222';
const credentials = { accessKeyId: 'LOCALTESTACCESS000001', secretAccessKey: 'fixture-only-storage-secret-123456789', sessionToken: 'fixture-only-session-token-123456789' };
const date = new Date('2026-10-09T10:00:00Z');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
interface StoredObject { body: Buffer; metadata: Record<string, string> }
interface RequestSummary { method: string; path: string; authenticated: boolean; conditional: boolean; bytes: number }

/** Independent server-side verifier: never imports or calls the production signer. */
function verifySignature(req: IncomingMessage, body: Buffer, expected: S3Credentials, region: string): boolean {
  const authorization = req.headers.authorization ?? '';
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(authorization);
  if (!match || match[1] !== expected.accessKeyId || match[3] !== region) return false;
  const names = match[4]!.split(';');
  if (names.join(';') !== [...new Set(names)].sort().join(';') || !['host', 'x-amz-date', 'x-amz-content-sha256'].every(name => names.includes(name))) return false;
  if (req.headers['x-amz-content-sha256'] !== sha(body) || req.headers['x-amz-security-token'] !== expected.sessionToken) return false;
  for (const name of Object.keys(req.headers)) if (name.startsWith('x-amz-') && !names.includes(name)) return false;
  const timestamp = req.headers['x-amz-date']; if (typeof timestamp !== 'string' || !timestamp.startsWith(match[2]!)) return false;
  const canonicalHeaders = names.map(name => {
    const value = req.headers[name]; return typeof value === 'string' ? name + ':' + value.trim().replace(/\s+/g, ' ') + '\n' : '';
  }).join('');
  const path = req.url ?? '/'; if (path.includes('?')) return false;
  const canonical = [req.method, path, '', canonicalHeaders, names.join(';'), sha(body)].join('\n');
  const scope = match[2] + '/' + region + '/s3/aws4_request';
  const toSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha(canonical)].join('\n');
  const mac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
  const key = mac(mac(mac(mac('AWS4' + expected.secretAccessKey, match[2]!), region), 's3'), 'aws4_request');
  const actual = mac(key, toSign), supplied = Buffer.from(match[5]!, 'hex'); return timingSafeEqual(actual, supplied);
}
class SignedS3Fixture {
  server: Server; endpoint = ''; readonly objects = new Map<string, StoredObject>(); readonly requests: RequestSummary[] = [];
  failPut = false; failGet = false; redirect = false; redirectTarget = ''; tamperBytes = false; tamperMetadata = false;
  oversizeDeclared = false; oversizeChunked = false; shortBody = false; stallBody = false; slowHeaders = false;
  readonly timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(readonly region: string, readonly auth = credentials) {
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => { res.destroy(); }); });
  }
  async start() { await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    this.endpoint = 'http://127.0.0.1:' + address.port;
  }
  async close() { for (const timer of this.timers) clearTimeout(timer); this.server.closeAllConnections(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
  private later(action: () => void) { const timer = setTimeout(() => { this.timers.delete(timer); action(); }, 2000); this.timers.add(timer); }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of req) { const bytes = Buffer.from(chunk as Buffer); length += bytes.byteLength; if (length > CYST_CAPABILITIES.maxCiphertextBytes) { res.writeHead(413); res.end(); return; } chunks.push(bytes); }
    const body = Buffer.concat(chunks), path = req.url ?? '/', method = req.method ?? 'GET';
    const authenticated = verifySignature(req, body, this.auth, this.region);
    this.requests.push({ method, path, authenticated, conditional: req.headers['if-none-match'] === '*', bytes: body.byteLength });
    if (!authenticated) { res.writeHead(403); res.end('Access denied'); return; }
    if (!/^\/checkpoint-bucket\/cysts\/v1\/[0-9a-f]{64}\.blob$/.test(path)) { res.writeHead(404); res.end(); return; }
    if (this.redirect) { res.writeHead(307, { Location: this.redirectTarget }); res.end(); return; }
    if (this.slowHeaders) { this.later(() => { res.writeHead(503); res.end(); }); return; }
    if (method === 'PUT') {
      if (this.failPut) { res.writeHead(503); res.end(this.auth.secretAccessKey + ':' + this.auth.sessionToken); return; }
      if (req.headers['if-none-match'] !== '*') { res.writeHead(400); res.end(); return; }
      if (this.objects.has(path)) { res.writeHead(412); res.end(); return; }
      const metadata: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) if (name.startsWith('x-amz-meta-') && typeof value === 'string') metadata[name] = value;
      this.objects.set(path, { body, metadata }); res.writeHead(200); res.end(); return;
    }
    if (method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (this.failGet) { res.writeHead(503); res.end(); return; }
    const object = this.objects.get(path); if (!object) { res.writeHead(404); res.end(); return; }
    const headers: Record<string, string> = { ...object.metadata, 'Content-Type': 'application/octet-stream' };
    let value = Buffer.from(object.body);
    if (this.tamperBytes) value[0] = (value[0] ?? 0) ^ 1;
    if (this.tamperMetadata) headers['x-amz-meta-telomere-owner'] = '00'.repeat(32);
    if (this.oversizeDeclared) headers['Content-Length'] = String(2 ** 31);
    else if (!this.oversizeChunked && !this.shortBody) headers['Content-Length'] = String(value.byteLength);
    res.writeHead(200, headers);
    if (this.stallBody) { res.write(value.subarray(0, 1)); this.later(() => res.end(value.subarray(1))); return; }
    if (this.oversizeChunked) { res.write(value); res.end(Buffer.from([0])); return; }
    if (this.shortBody) value = value.subarray(0, value.byteLength - 1);
    res.end(value);
  }
}
const options = (fixture: SignedS3Fixture, extra: Partial<S3CiphertextOptions> = {}): S3CiphertextOptions => ({ endpoint: fixture.endpoint,
  bucket: 'checkpoint-bucket', region: fixture.region, failureDomain: 'fixture-' + fixture.region, reviewed: true,
  credentials, allowInsecureLoopback: true, now: () => date, timeoutMs: 500, ...extra });

describe('reviewed immutable two-destination ciphertext replication', () => {
  let primary: SignedS3Fixture, secondary: SignedS3Fixture, a: S3CiphertextStorage, b: S3CiphertextStorage, storage: ReplicatedCystStorage;
  const bytes = new TextEncoder().encode('encrypted-ciphertext-fixture-with-authentication-tag'), digest = sha(bytes);
  beforeEach(async () => {
    primary = new SignedS3Fixture('us-east-1'); secondary = new SignedS3Fixture('eu-west-1'); await primary.start(); await secondary.start();
    a = new S3CiphertextStorage(options(primary)); b = new S3CiphertextStorage(options(secondary)); storage = new ReplicatedCystStorage([a, b]); await storage.initialize();
  });
  afterEach(async () => { await primary.close(); await secondary.close(); });

  it('matches AWS published SigV4 GET and signed-payload PUT reference signatures', () => {
    const example = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
    const get = signS3Request({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), region: 'us-east-1',
      credentials: example, date: new Date('2013-05-24T00:00:00Z'), headers: { range: 'bytes=0-9' } });
    expect(get.authorization).toContain('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    const put = signS3Request({ method: 'PUT', url: new URL('https://examplebucket.s3.amazonaws.com/test%24file.text'), region: 'us-east-1',
      credentials: example, date: new Date('2013-05-24T00:00:00Z'), headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      body: new TextEncoder().encode('Welcome to Amazon S3.') });
    expect(put.authorization).toContain('Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });
  it('requires both independently authenticated durable replicas before acknowledging the upload', async () => {
    await storage.put(owner, digest, bytes);
    for (const fixture of [primary, secondary]) {
      expect(fixture.objects.size).toBe(1); expect(fixture.requests.every(request => request.authenticated)).toBe(true);
      expect(fixture.requests.filter(request => request.method === 'PUT').every(request => request.conditional)).toBe(true);
      const saved = [...fixture.objects.values()][0]!; expect(saved.body).toEqual(Buffer.from(bytes));
      expect(saved.metadata['x-amz-meta-telomere-bytes']).toBe(String(bytes.byteLength));
      expect([...fixture.objects.keys()][0]).not.toContain(owner); expect([...fixture.objects.keys()][0]).not.toContain(digest);
    }
    expect(await storage.read(owner, digest, bytes.byteLength)).toEqual(bytes);
  });
  it('retains a partial upload as unavailable and completes the original immutable retry after a new adapter starts', async () => {
    secondary.failPut = true; await expect(storage.put(owner, digest, bytes)).rejects.toThrow('unavailable');
    expect(primary.objects.size).toBe(1); expect(secondary.objects.size).toBe(0);
    secondary.failPut = false; const restarted = new ReplicatedCystStorage([new S3CiphertextStorage(options(primary)), new S3CiphertextStorage(options(secondary))]);
    await restarted.initialize(); await restarted.put(owner, digest, bytes); expect(primary.objects.size).toBe(1); expect(secondary.objects.size).toBe(1);
    expect(primary.requests.filter(request => request.method === 'PUT')).toHaveLength(2);
    expect(await restarted.read(owner, digest, bytes.byteLength)).toEqual(bytes);
  });
  it('does not confuse a verified partial-upload fallback with full replication durability', async () => {
    secondary.failPut = true; await expect(storage.put(owner, digest, bytes)).rejects.toThrow('unavailable');
    expect(await storage.read(owner, digest, bytes.byteLength)).toEqual(bytes);
    expect(await storage.isDurable(owner, digest, bytes.byteLength)).toBe(false);
    secondary.failPut = false; secondary.failGet = true;
    expect(await storage.read(owner, digest, bytes.byteLength)).toEqual(bytes);
    expect(await storage.isDurable(owner, digest, bytes.byteLength)).toBe(false);
    secondary.failGet = false; expect(await storage.isDurable(owner, digest, bytes.byteLength)).toBe(true);
    expect(secondary.objects.size).toBe(1);
  });
  it('accepts an immutable 412 retry only after exact ciphertext and scope verification', async () => {
    await a.put(owner, digest, bytes); const path = [...primary.objects.keys()][0]!;
    await a.put(owner, digest, bytes); expect(primary.objects.size).toBe(1);
    const saved = primary.objects.get(path)!; saved.body[0] = (saved.body[0] ?? 0) ^ 1;
    await expect(a.put(owner, digest, bytes)).rejects.toThrow('integrity'); expect(primary.objects.size).toBe(1);
  });
  it('falls back to a verified second replica and repairs only a confirmed missing first object', async () => {
    await storage.put(owner, digest, bytes); primary.objects.clear();
    const read = await storage.readDetailed(owner, digest, bytes.byteLength);
    expect(read.bytes).toEqual(bytes); expect(read.replicas).toEqual(['missing', 'verified']); expect(read.repairs).toEqual(['verified', 'not-needed']);
    expect(primary.objects.size).toBe(1); expect(await a.read(owner, digest, bytes.byteLength)).toEqual(bytes);
  });
  it('serves a verified copy during a replica outage and reports failed repair without discarding healthy data', async () => {
    await storage.put(owner, digest, bytes); primary.failGet = true;
    const degraded = await storage.readDetailed(owner, digest, bytes.byteLength); expect(degraded.bytes).toEqual(bytes); expect(degraded.replicas).toEqual(['unavailable', 'verified']);
    primary.failGet = false; primary.objects.clear(); primary.failPut = true;
    const repair = await storage.readDetailed(owner, digest, bytes.byteLength); expect(repair.bytes).toEqual(bytes); expect(repair.repairs[0]).toBe('failed');
  });
  it('never repairs or overwrites an existing corrupted or foreign-metadata object', async () => {
    await storage.put(owner, digest, bytes); primary.tamperBytes = true;
    const before = primary.requests.filter(request => request.method === 'PUT').length;
    const read = await storage.readDetailed(owner, digest, bytes.byteLength); expect(read.bytes).toEqual(bytes); expect(read.replicas[0]).toBe('invalid');
    expect(read.repairs[0]).toBe('not-needed'); expect(primary.requests.filter(request => request.method === 'PUT')).toHaveLength(before);
    secondary.tamperMetadata = true; await expect(storage.read(owner, digest, bytes.byteLength)).rejects.toThrow('unavailable');
  });
  it('distinguishes two confirmed absences from an unknown replica outage', async () => {
    expect(await storage.read(owner, digest, bytes.byteLength)).toBeUndefined();
    primary.failGet = true; await expect(storage.read(owner, digest, bytes.byteLength)).rejects.toThrow('unavailable');
  });
  it('rejects redirects without forwarding signed credentials or ciphertext to another endpoint', async () => {
    primary.redirect = true; primary.redirectTarget = secondary.endpoint + '/credential-trap';
    await expect(a.put(owner, digest, bytes)).rejects.toThrow('unavailable'); expect(secondary.requests).toHaveLength(0);
    expect(primary.requests).toHaveLength(1);
  });
  it.each(['oversizeDeclared', 'oversizeChunked', 'shortBody', 'tamperMetadata', 'tamperBytes'] as const)('rejects %s with bounded reads', async flag => {
    await a.put(owner, digest, bytes); primary[flag] = true;
    await expect(a.read(owner, digest, bytes.byteLength)).rejects.toThrow('integrity');
  });
  it('bounds both header waits and stalled response bodies and never automatically retries', async () => {
    const short = new S3CiphertextStorage(options(primary, { timeoutMs: 40 })); await short.initialize();
    primary.slowHeaders = true; const before = primary.requests.length;
    const started = Date.now(); await expect(short.read(owner, digest, bytes.byteLength)).rejects.toThrow('unavailable'); expect(Date.now() - started).toBeLessThan(1500);
    expect(primary.requests).toHaveLength(before + 1);
    primary.slowHeaders = false; await a.put(owner, digest, bytes); primary.stallBody = true;
    await expect(short.read(owner, digest, bytes.byteLength)).rejects.toThrow('integrity');
  });
  it('does not expose access/secret/session credentials in errors, serialization or inspection', async () => {
    primary.failPut = true;
    let error: unknown; try { await a.put(owner, digest, bytes); } catch (caught) { error = caught; }
    for (const value of [String(error), JSON.stringify(a), inspect(a)]) {
      expect(value).not.toContain(credentials.secretAccessKey); expect(value).not.toContain(credentials.sessionToken); expect(value).not.toContain(credentials.accessKeyId);
    }
    expect(primary.requests).toHaveLength(1);
  });
  it('refuses unreviewed/duplicate failure domains and invalid scope before any network request', async () => {
    expect(() => new S3CiphertextStorage(options(primary, { reviewed: false as true }))).toThrow('reviewed');
    expect(() => new S3CiphertextStorage(options(primary, { endpoint: 'http://external.invalid', allowInsecureLoopback: true }))).toThrow('reviewed');
    expect(() => new S3CiphertextStorage(options(primary, { endpoint: primary.endpoint + '/path' }))).toThrow('reviewed');
    expect(() => new S3CiphertextStorage(options(primary, { endpoint: 'https://user:password@example.invalid' }))).toThrow('reviewed');
    expect(() => new ReplicatedCystStorage([a, a])).toThrow('distinct');
    const sameRegion = new S3CiphertextStorage(options(secondary, { region: primary.region })); expect(() => new ReplicatedCystStorage([a, sameRegion])).toThrow('distinct');
    await expect(a.read('../owner', digest, bytes.byteLength)).rejects.toThrow('unavailable');
    await expect(a.put(owner, digest, new Uint8Array(16))).rejects.toThrow('unavailable');
    await expect(a.read(owner, digest, CYST_CAPABILITIES.maxCiphertextBytes + 1)).rejects.toThrow('unavailable');
    expect(primary.requests).toHaveLength(0);
  });
  it('keeps owners in different internal namespaces and replicates/restores actual opaque application ciphertext', async () => {
    const checkpoint = await encryptCheckpoint(new TextEncoder().encode('private application counter=87'), { owner, applicationSchema: 'counter.v1' });
    const ciphertext = Buffer.from(checkpoint.envelope.ciphertext, 'base64'); await storage.put(owner, checkpoint.envelope.sha256, ciphertext);
    expect(cystObjectKey(owner, checkpoint.envelope.sha256)).not.toBe(cystObjectKey(foreign, checkpoint.envelope.sha256));
    expect(await storage.read(foreign, checkpoint.envelope.sha256, ciphertext.byteLength)).toBeUndefined(); primary.objects.clear();
    const downloaded = await storage.read(owner, checkpoint.envelope.sha256, ciphertext.byteLength); expect(downloaded).toBeDefined();
    const restored = await decryptCheckpoint({ ...checkpoint.envelope, ciphertext: Buffer.from(downloaded!).toString('base64') }, checkpoint.recoveryKey);
    expect(new TextDecoder().decode(restored)).toBe('private application counter=87');
    for (const fixture of [primary, secondary]) for (const object of fixture.objects.values()) expect(object.body.toString()).not.toContain('counter=87');
    checkpoint.recoveryKey.fill(0); restored.fill(0);
  });
  it('accepts the published maximum ciphertext size and rejects a single extra byte before HTTP', async () => {
    // Several real 2 MiB signed PUT/GET transfers need a larger fixture allowance on a loaded CI machine.
    // Keep production byte/integrity bounds unchanged and keep timeout-adversary tests on their short deadlines.
    const large = new ReplicatedCystStorage([new S3CiphertextStorage(options(primary, { timeoutMs: 5000 })),
      new S3CiphertextStorage(options(secondary, { timeoutMs: 5000 }))]); await large.initialize();
    const maximum = new Uint8Array(CYST_CAPABILITIES.maxCiphertextBytes); maximum[0] = 1;
    const maximumDigest = sha(maximum); await large.put(owner, maximumDigest, maximum);
    const restored = await large.read(owner, maximumDigest, maximum.byteLength); expect(restored?.byteLength).toBe(maximum.byteLength);
    expect(restored && sha(restored)).toBe(maximumDigest);
    const before = [primary.requests.length, secondary.requests.length];
    await expect(large.put(owner, maximumDigest, new Uint8Array(maximum.byteLength + 1))).rejects.toThrow('unavailable');
    expect([primary.requests.length, secondary.requests.length]).toEqual(before);
  }, 30000);
});
