import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { canonical, hashJson, randomId } from '../src/common.js';
import { HostMeterVerifier } from '../src/host-kit/meter.js';
import { Ed25519Identity, hostMessageHash, hostTickSchema, leaseSchema } from '../src/host-kit/protocol.js';
import { platformQuoteSchema, platformQuoteTypes, typedPlatformQuote } from '../src/platform-runtime/types.js';
import { platformV2DelegationSchema, platformV2DelegationTypedData, preparePlatformV2EvidenceCore,
  type PlatformV2HistoricalAuthority } from '../src/receipts/platform-v2.js';
import { PLATFORM_V2_MANIFEST_MAX_BYTES, PlatformV2EvidencePublisher, PlatformV2PublicationJournal,
  PlatformV2PublishedEvidenceReader, platformV2PublicationKeys, platformV2PublicationRows,
  type PlatformV2PublicationStore } from '../src/receipts/platform-v2-publication.js';
import { openStore } from '../src/store.js';

const owner = '0x1111111111111111111111111111111111111111';
const scope = { chainId: 31337, escrow: '0x2222222222222222222222222222222222222222',
  hostRegistry: '0x3333333333333333333333333333333333333333' } as const;
const issuedAt = 1_700_000_000_000;
class MemoryStore implements PlatformV2PublicationStore {
  readonly objects = new Map<string, Uint8Array>();
  puts = 0; reads = 0; loseNextWrite = false;
  constructor(readonly identity: string, readonly failureDomain: string) {}
  async putImmutable(key: string, bytes: Uint8Array, options: { signal: AbortSignal; maxBytes: number }) {
    options.signal.throwIfAborted(); this.puts++;
    if (bytes.byteLength > options.maxBytes) throw new Error('too large');
    const saved = this.objects.get(key);
    if (saved && !Buffer.from(saved).equals(Buffer.from(bytes))) throw new Error('immutable conflict');
    this.objects.set(key, Uint8Array.from(bytes));
    if (this.loseNextWrite) { this.loseNextWrite = false; throw new Error('response lost after commit'); }
  }
  async get(key: string, options: { signal: AbortSignal; maxBytes: number }) {
    options.signal.throwIfAborted(); this.reads++;
    const value = this.objects.get(key);
    return value ? Uint8Array.from(value) : undefined;
  }
}
const destinations = () => [new MemoryStore('store-a', 'domain-a'), new MemoryStore('store-b', 'domain-b')] as const;

async function fixture() {
  const controller = new Ed25519Identity(), host = new Ed25519Identity(), signer = privateKeyToAccount(randomId());
  const image = `registry.example/cpu@sha256:${'a'.repeat(64)}`, runId = randomId();
  const quote = platformQuoteSchema.parse({ runId, leashId: randomId(), hostId: randomId(), payer: owner,
    hwClass: 0, regionHash: randomId(), imageHash: keccak256(toHex(image.split('@')[1]!)), workloadHash: randomId(),
    maxSeconds: 20, pricePerSecond: '100', inferencePrice: '0', quoteExpiry: issuedAt / 1000 + 10 });
  const quoteSignature = await signer.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '1',
    chainId: scope.chainId, verifyingContract: scope.escrow }, types: platformQuoteTypes,
    primaryType: 'PlatformQuote', message: typedPlatformQuote(quote) });
  const lease = controller.sign('lease', leaseSchema.parse({ version: 1, hostKey: host.publicKey, runId, owner,
    image, argv: ['/app/run', 'PRIVATE_ARGV'], stdin: 'PRIVATE_STDIN', issuedAt, expiresAt: issuedAt + 20_000,
    maxSeconds: 20, nonce: randomId() }));
  const body = platformV2DelegationSchema.parse({ version: 2, ...scope, runId, hostId: quote.hostId,
    hostKey: host.publicKey, controllerKey: controller.publicKey, quoteHash: hashJson(quote),
    signedLeaseHash: hostMessageHash(lease), meterLeaseHash: hostMessageHash({ body: lease.body, signature: '' }),
    leaseIssuedAtMs: issuedAt, leaseExpiresAtMs: issuedAt + 20_000, maxSeconds: 20, nonce: randomId() });
  const delegation = { body, signature: await signer.signTypedData(platformV2DelegationTypedData(body)) };
  const meter = new HostMeterVerifier(lease.body, controller, () => issuedAt + 1_000);
  const tick = host.sign('tick', hostTickSchema.parse({ version: 1, hostKey: host.publicKey, runId, owner,
    leaseHash: meter.leaseHash, sequence: 0, timestamp: issuedAt + 1_000, elapsedMs: 1_000, cpuMs: 100,
    state: 'EXITED', previousHash: null, heartbeat: null, gpuUtil: 0, gpuMemoryBytes: 0, powerWatts: 0 }));
  const ack = meter.accept(tick);
  const historical: PlatformV2HistoricalAuthority = { ...scope, quoteSigner: signer.address, runId, hostId: quote.hostId,
    hostKey: host.publicKey as Hex, payer: owner, leashId: quote.leashId, hwClass: 0, regionHash: quote.regionHash,
    imageHash: quote.imageHash, workloadHash: quote.workloadHash, pricePerSecond: '100', inferencePrice: '0',
    quoteExpiry: quote.quoteExpiry, maxSeconds: 20, openedAt: issuedAt / 1000, cutoff: issuedAt / 1000 + 20 };
  const salt = randomId();
  const prepared = await preparePlatformV2EvidenceCore({ quote, quoteSignature, delegation, lease,
    ticks: [tick], acknowledgments: [ack], endedAt: issuedAt / 1000 + 1, billableSeconds: 0,
    inferenceCharge: '0', status: 'completed', output: 'PRIVATE_OUTPUT', outputSalt: salt }, historical);
  return { ...prepared, opening: { transactionHash: randomId(), blockHash: randomId(), blockNumber: 123n, logIndex: 2 }, salt };
}

describe('opt-in immutable Platform v2 publication and independent retrieval', () => {
  let store: Awaited<ReturnType<typeof openStore>>;
  let journal: PlatformV2PublicationJournal;
  beforeAll(async () => { store = await openStore({ DATA_DIR: ':memory:' }); journal = new PlatformV2PublicationJournal(store.db, scope); await journal.initialize(); });
  afterAll(async () => { await store.close(); });

  it('writes no copies without explicit enablement, and rejects shared identities or domains', async () => {
    const value = await fixture(), copies = destinations();
    const disabled = new PlatformV2EvidencePublisher(journal, copies);
    await expect(disabled.publish(value.core, value.opening)).rejects.toThrow('disabled');
    expect(copies.map(copy => copy.puts)).toEqual([0, 0]);
    expect(await journal.get(value.core.quote.runId, copies)).toBeUndefined();
    expect(() => new PlatformV2PublishedEvidenceReader(scope, [copies[0], copies[0]])).toThrow('distinct');
    expect(() => new PlatformV2PublishedEvidenceReader(scope, [copies[0], new MemoryStore('store-b', 'domain-a')])).toThrow('distinct');
    expect(() => new PlatformV2PublishedEvidenceReader(scope, [copies[0], new MemoryStore('store-a', 'domain-b')])).toThrow('distinct');
  });

  it('publishes only canonical redacted core and matching manifest, re-reading both copies on each request', async () => {
    const value = await fixture(), copies = destinations(), publisher = new PlatformV2EvidencePublisher(journal, copies, { enabled: true });
    const result = await publisher.publish(value.core, value.opening);
    expect(result).toMatchObject({ configuredCopiesVerified: true, independentlyPublished: false,
      storageAssurance: 'two-operator-declared-domains', manifest: { opening: { blockNumber: '123' } } });
    expect(result.core).toEqual(value.core);
    expect(result.manifestDigest).toBe(hashJson(result.manifest));
    const keys = platformV2PublicationKeys(journal.scope, value.core.quote.runId, value.evidenceCoreDigest);
    expect(keys.core).toBe(`v2/${journal.scope}/${value.evidenceCoreDigest}/core.json`);
    for (const copy of copies) {
      expect(Buffer.from(copy.objects.get(keys.core)!).toString()).toBe(canonical(value.core));
      const publicBytes = [...copy.objects.values()].map(bytes => Buffer.from(bytes).toString()).join('');
      for (const privateValue of ['PRIVATE_ARGV', 'PRIVATE_STDIN', 'PRIVATE_OUTPUT', value.salt]) expect(publicBytes).not.toContain(privateValue);
    }
    const beforeReads = copies[0].reads;
    expect(await new PlatformV2PublishedEvidenceReader(scope, copies).retrieve(value.core.quote.runId,
      { expectedReceiptHash: value.receiptHash })).toEqual(result);
    expect(copies[0].reads).toBe(beforeReads + 2);
    await expect(publisher.retrieve(value.core.quote.runId, { expectedReceiptHash: randomId() })).rejects.toThrow('Both');
  });

  it('recovers a lost write response using exactly the original journalled bytes, without premature readiness', async () => {
    const value = await fixture(), copies = destinations(); copies[1].loseNextWrite = true;
    const publisher = new PlatformV2EvidencePublisher(journal, copies, { enabled: true });
    await expect(publisher.publish(value.core, value.opening)).rejects.toThrow('incomplete');
    const saved = await journal.get(value.core.quote.runId, copies);
    expect(saved?.manifest.receiptHash).toBe(value.receiptHash);
    await expect(publisher.retrieve(value.core.quote.runId)).rejects.toThrow('Both');
    const keys = platformV2PublicationKeys(journal.scope, value.core.quote.runId, value.evidenceCoreDigest);
    const firstBytes = Uint8Array.from(copies[1].objects.get(keys.core)!);
    expect((await publisher.publish(value.core, value.opening)).configuredCopiesVerified).toBe(true);
    expect(copies[1].objects.get(keys.core)).toEqual(firstBytes);
    expect((await publisher.publish(value.core, { ...value.opening, blockNumber: '123' })).manifest.receiptHash).toBe(value.receiptHash);
  });

  it('rejects changed core, opening and destination retries before any external mutation', async () => {
    const value = await fixture(), copies = destinations(), publisher = new PlatformV2EvidencePublisher(journal, copies, { enabled: true });
    await publisher.publish(value.core, value.opening);
    const puts = copies.map(copy => copy.puts);
    for (const change of [{ ...value.opening, transactionHash: randomId() }, { ...value.opening, blockHash: randomId() },
      { ...value.opening, blockNumber: 124n }, { ...value.opening, logIndex: 3 }]) {
      await expect(publisher.publish(value.core, change)).rejects.toThrow('conflicts');
    }
    await expect(publisher.publish({ ...value.core, outputCommitment: randomId() }, value.opening)).rejects.toThrow('conflicts');
    const replacements = [copies[0], new MemoryStore('store-c', 'domain-c')] as const;
    await expect(new PlatformV2EvidencePublisher(journal, replacements, { enabled: true }).publish(value.core, value.opening)).rejects.toThrow('destinations');
    expect(copies.map(copy => copy.puts)).toEqual(puts);
    expect(replacements[1].puts).toBe(0);
  });

  it('refuses missing, divergent, noncanonical and oversized stored copies without repairing them', async () => {
    const value = await fixture(), copies = destinations(), publisher = new PlatformV2EvidencePublisher(journal, copies, { enabled: true });
    const published = await publisher.publish(value.core, value.opening);
    const keys = platformV2PublicationKeys(journal.scope, value.core.quote.runId, value.evidenceCoreDigest);
    const originalCore = copies[1].objects.get(keys.core)!, originalManifest = copies[1].objects.get(keys.manifest)!;
    const puts = copies.map(copy => copy.puts);
    copies[1].objects.delete(keys.core);
    await expect(publisher.retrieve(value.core.quote.runId)).rejects.toThrow('Both');
    copies[1].objects.set(keys.core, Buffer.from(`${canonical(value.core)}\n`));
    await expect(publisher.retrieve(value.core.quote.runId)).rejects.toThrow('Both');
    copies[1].objects.set(keys.core, Buffer.from(canonical({ ...value.core, outputCommitment: randomId() })));
    await expect(publisher.retrieve(value.core.quote.runId)).rejects.toThrow('Both');
    copies[1].objects.set(keys.core, originalCore);
    copies[1].objects.set(keys.manifest, Buffer.from(canonical({ ...published.manifest,
      opening: { ...published.manifest.opening, blockHash: randomId() } })));
    await expect(publisher.retrieve(value.core.quote.runId)).rejects.toThrow('disagree');
    copies[1].objects.set(keys.manifest, Buffer.alloc(PLATFORM_V2_MANIFEST_MAX_BYTES + 1));
    await expect(publisher.retrieve(value.core.quote.runId)).rejects.toThrow('Both');
    copies[1].objects.set(keys.manifest, originalManifest);
    expect((await publisher.retrieve(value.core.quote.runId)).configuredCopiesVerified).toBe(true);
    expect(copies.map(copy => copy.puts)).toEqual(puts);
  });

  it('rejects private fields and foreign deployment scope before writing', async () => {
    const value = await fixture(), copies = destinations(), publisher = new PlatformV2EvidencePublisher(journal, copies, { enabled: true });
    await expect(publisher.publish({ ...value.core, lease: { argv: ['private'] } }, value.opening)).rejects.toThrow();
    await expect(publisher.publish({ ...value.core, delegation: { ...value.core.delegation,
      body: { ...value.core.delegation.body, chainId: 84532 } } }, value.opening)).rejects.toThrow('scope');
    await expect(publisher.publish(value.core, { ...value.opening, blockNumber: '0123' })).rejects.toThrow();
    expect(copies.map(copy => copy.puts)).toEqual([0, 0]);
  });

  it('persists exact immutable publication across disk reopen and detects durable corruption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telomere-v2-publication-')), value = await fixture(), copies = destinations();
    let disk = await openStore({ DATA_DIR: directory });
    try {
      let diskJournal = new PlatformV2PublicationJournal(disk.db, scope);
      await diskJournal.initialize();
      const published = await new PlatformV2EvidencePublisher(diskJournal, copies, { enabled: true }).publish(value.core, value.opening);
      await disk.close(); disk = await openStore({ DATA_DIR: directory });
      diskJournal = new PlatformV2PublicationJournal(disk.db, scope);
      await expect(diskJournal.get(value.core.quote.runId, copies)).rejects.toThrow('initialized');
      await diskJournal.initialize();
      expect((await diskJournal.get(value.core.quote.runId, copies))?.manifestDigest).toBe(published.manifestDigest);
      await expect(diskJournal.record(value.core, { ...value.opening, blockHash: randomId() }, copies)).rejects.toThrow('conflicts');
      await disk.db.update(platformV2PublicationRows).set({ coreText: `${canonical(value.core)}\n` })
        .where(eq(platformV2PublicationRows.runId, value.core.quote.runId));
      await expect(diskJournal.get(value.core.quote.runId, copies)).rejects.toThrow('canonical');
      await disk.db.update(platformV2PublicationRows).set({ coreText: canonical(value.core), manifestText: canonical({
        ...published.manifest, opening: { ...published.manifest.opening, blockHash: randomId() },
      }) }).where(eq(platformV2PublicationRows.runId, value.core.quote.runId));
      await expect(diskJournal.get(value.core.quote.runId, copies)).rejects.toThrow('manifest digest changed');
    } finally { await disk.close(); await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it('retains bounded operation slots after noncooperative timeouts until underlying calls settle', async () => {
    let calls = 0;
    const resolvePending: ((value: Uint8Array | undefined) => void)[] = [];
    const uncooperative = (identity: string, failureDomain: string): PlatformV2PublicationStore => ({ identity, failureDomain,
      putImmutable: async () => { throw new Error('should not write'); },
      get: async () => { calls++; return new Promise(resolve => resolvePending.push(resolve)); } });
    const reader = new PlatformV2PublishedEvidenceReader(scope,
      [uncooperative('a', 'a'), uncooperative('b', 'b')], { timeoutMs: 10 });
    const runId = randomId();
    await expect(reader.retrieve(runId)).rejects.toThrow('Both');
    await expect(reader.retrieve(runId)).rejects.toThrow('Both');
    await expect(reader.retrieve(runId)).rejects.toThrow('Both');
    expect(calls).toBe(4);
    for (const resolve of resolvePending) resolve(undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(reader.retrieve(runId)).rejects.toThrow('Both');
    expect(calls).toBe(6);
    for (const resolve of resolvePending) resolve(undefined);
  });

  it('cancels before admission without writing, and signals in-flight cooperative reads', async () => {
    const value = await fixture(), copies = destinations(), publisher = new PlatformV2EvidencePublisher(journal, copies, { enabled: true });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(publisher.publish(value.core, value.opening, { signal: cancelled.signal })).rejects.toThrow();
    expect(copies.map(copy => copy.puts)).toEqual([0, 0]);
    let aborted = 0;
    const cooperative = (identity: string, failureDomain: string): PlatformV2PublicationStore => ({ identity, failureDomain,
      putImmutable: async () => undefined,
      get: async (_key, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => { aborted++; reject(new Error('cancelled')); }, { once: true });
      }) });
    const reader = new PlatformV2PublishedEvidenceReader(scope, [cooperative('a', 'a'), cooperative('b', 'b')], { timeoutMs: 10 });
    await expect(reader.retrieve(value.core.quote.runId)).rejects.toThrow('Both');
    expect(aborted).toBe(2);
  });
});
