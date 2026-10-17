import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { LARGE_CYST_CHUNK_BYTES, LargeCystPrivateStore, type LargeCystHeader,
  type LargeCystManifest } from '../src/cysts/large-checkpoints.js';
import { cystQuotaPolicySchema } from '../src/cysts/quota-types.js';
import { admissionHash } from '../src/host-kit/admission.js';
import { dockerHostScope } from '../src/host-kit/hosted.js';
import { hostBinding, hostRuns, openHostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, hostMessageHash, signedAckSchema, signedLeaseSchema,
  signedTickSchema } from '../src/host-kit/protocol.js';
import { fingerprintPlatformDatabase, restorePlatformHostFiles, snapshotPlatformHost,
  verifyPaidDockerInventory, verifyPlatformHostFiles, verifyPlatformHostSemantic, verifyPlatformLargeShadowLocal,
  verifyPlatformSignedJournal, verifySmallCystOwnerQuotas } from '../src/operator/platform-backup.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const work = resolve('.local', 'tests', `platform-backup-${randomUUID()}`);
afterEach(async () => { if (work.startsWith(resolve('.local', 'tests') + '\\') || work.startsWith(resolve('.local', 'tests') + '/')) {
  await rm(work, { recursive: true, force: true });
} });

describe('paid stopped-state backup boundaries', () => {
  it('rejects every paid Docker namespace, including a malformed session label', async () => {
    const dockerHost = 'unix:///var/run/docker.sock';
    const labels = ['telomere.managed', 'telomere.hostkit', 'telomere.session'];
    for (const present of labels) {
      const queried: string[] = [];
      const command = async (binary: string, args: string[]): Promise<string> => {
        expect(binary).toBe('docker');
        expect(args.slice(0, 5)).toEqual(['--host', dockerHost, 'ps', '--all', '--filter']);
        expect(args.slice(6)).toEqual(['--format', '{{.ID}}']);
        const marker = args[5]!;
        queried.push(marker);
        return marker === `label=${present}` ? 'container-id' : '';
      };
      await expect(verifyPaidDockerInventory(dockerHost, command)).rejects.toThrow('Paid Docker Cells remain');
      expect(queried).toContain(`label=${present}`);
      expect(queried.every(marker => !marker.endsWith('=true'))).toBe(true);
    }
    const queried: string[] = [];
    await verifyPaidDockerInventory(dockerHost, async (_binary, args) => {
      queried.push(args[5]!); return '';
    });
    expect(queried).toEqual(labels.map(marker => `label=${marker}`));
  });

  it('rejects small Cyst owner accounting that differs from stored ciphertext metadata', () => {
    const owner = `0x${'1'.repeat(40)}`, other = `0x${'2'.repeat(40)}`;
    const records = [{ owner, ciphertext_bytes: 41 }, { owner, ciphertext_bytes: 57 }];
    const correct = [{ owner, used_bytes: 98, checkpoints: 2 }, { owner: other, used_bytes: 0, checkpoints: 0 }];
    expect(() => verifySmallCystOwnerQuotas(records, correct)).not.toThrow();
    expect(() => verifySmallCystOwnerQuotas(records, [{ ...correct[0]!, used_bytes: 97 }])).toThrow();
    expect(() => verifySmallCystOwnerQuotas(records, [{ ...correct[0]!, checkpoints: 1 }])).toThrow();
    expect(() => verifySmallCystOwnerQuotas(records, [])).toThrow();
  });

  it('requires an explicit quota2 policy for expanded paid-backup owners and retains the 32 MiB byte cap', () => {
    const owner = `0x${'1'.repeat(40)}`;
    const quotaPolicy = cystQuotaPolicySchema.parse({ version: 2, kind: 'telomere-cyst-quota-v2',
      maxOwnerCheckpoints: 4096, maxOwnerBytes: 33554432 });
    const records = Array.from({ length: 513 }, () => ({ owner, ciphertext_bytes: 17 }));
    const owners = [{ owner, used_bytes: 17 * 513, checkpoints: 513 }];
    expect(() => verifySmallCystOwnerQuotas(records, owners)).toThrow('exceeds the reviewed profile');
    expect(() => verifySmallCystOwnerQuotas(records, owners, { quotaPolicy })).not.toThrow();
    expect(() => verifySmallCystOwnerQuotas(records, owners,
      { quotaPolicy: JSON.parse(JSON.stringify({ ...quotaPolicy, maxOwnerBytes: 67108864 })) })).toThrow();
    const full = Array.from({ length: 4096 }, () => ({ owner, ciphertext_bytes: 17 }));
    expect(() => verifySmallCystOwnerQuotas(full, [{ owner, used_bytes: full.length * 17, checkpoints: full.length }], { quotaPolicy })).not.toThrow();
    const oversized = Array.from({ length: 17 }, () => ({ owner, ciphertext_bytes: 2_097_168 }));
    expect(() => verifySmallCystOwnerQuotas(oversized, [{ owner, used_bytes: oversized.length * 2_097_168, checkpoints: 17 }], { quotaPolicy }))
      .toThrow('exceeds the reviewed profile');
    expect(() => verifySmallCystOwnerQuotas([{ owner, ciphertext_bytes: 2_097_169 }],
      [{ owner, used_bytes: 2_097_169, checkpoints: 1 }], { quotaPolicy })).toThrow('Invalid small Cyst size');
  });

  it('scans a real sealed local large Cyst and rejects corrupt shadow files or excess quota', async () => {
    const root = join(work, 'large-shadow');
    await mkdir(work, { recursive: true, mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    const id = `0x${'a'.repeat(64)}`, owner = `0x${'1'.repeat(40)}`, agent = `0x${'2'.repeat(40)}`;
    const topologySha256 = 'e'.repeat(64);
    const limits = { globalMaxBytes: 16 * 1024 * 1024, ownerMaxBytes: 8 * 1024 * 1024 };
    const header: LargeCystHeader = { version: 1, algorithm: 'xchacha20-poly1305-chunked', id, owner, agent,
      applicationSchema: 'test/v1', plaintextBytes: LARGE_CYST_CHUNK_BYTES, chunkBytes: LARGE_CYST_CHUNK_BYTES,
      chunkCount: 1, sourceMac: 'b'.repeat(64), keyCommitment: 'c'.repeat(64) };
    const part = Buffer.alloc(LARGE_CYST_CHUNK_BYTES + 40, 7);
    const manifest: LargeCystManifest = { header, parts: [{ index: 0, bytes: part.length, sha256: sha256(part) }],
      mac: 'd'.repeat(64) };
    const store = new LargeCystPrivateStore(root, limits);
    await store.initialize();
    try {
      await store.assertRemoteTopology(topologySha256);
      await store.begin(header); await store.putPart(id, 0, part); await store.commit(manifest);
      await store.reserveRemoteCommit(id); await store.sealRemoteCommit(id);
    } finally { await store.close(); }
    const checkpoint = join(root, id.slice(2));
    const valid = await verifyPlatformLargeShadowLocal(root, topologySha256, limits);
    expect(valid.records).toHaveLength(1);
    expect(valid.records[0]!.manifest).toEqual(manifest);
    expect(valid.bytes).toBe(part.length);
    await writeFile(join(checkpoint, 'unexpected'), 'x', { mode: 0o600 });
    await expect(verifyPlatformLargeShadowLocal(root, topologySha256, limits)).rejects.toThrow();
    await rm(join(checkpoint, 'unexpected'));
    const headerPath = join(checkpoint, 'header.json'), savedHeader = await readFile(headerPath);
    await rm(headerPath);
    await expect(verifyPlatformLargeShadowLocal(root, topologySha256, limits)).rejects.toThrow();
    await writeFile(headerPath, savedHeader, { mode: 0o600 });
    const partPath = join(checkpoint, 'part-000000.bin');
    await writeFile(partPath, Buffer.alloc(part.length, 9));
    await expect(verifyPlatformLargeShadowLocal(root, topologySha256, limits)).rejects.toThrow();
    await writeFile(partPath, part);
    await expect(verifyPlatformLargeShadowLocal(root, topologySha256,
      { ...limits, globalMaxBytes: 4 * 1024 * 1024 + 40 })).rejects.toThrow();
    if (process.platform === 'linux') {
      await chmod(partPath, 0o400);
      await expect(verifyPlatformLargeShadowLocal(root, topologySha256, limits)).rejects.toThrow();
    }
  });

  it('restores a private HostKit PGlite copy and rejects missing/altered host files', async () => {
    await mkdir(work, { recursive: true, mode: 0o700 });
    const source = join(work, 'source'), backup = join(work, 'backup'), scratch = join(work, 'scratch');
    const controller = new Ed25519Identity(), host = await openHostJournal(source);
    const hostKey = host.identity.publicKey;
    const hostId = `0x${'a'.repeat(64)}`;
    const runId = `0x${'c'.repeat(64)}`;
    const owner = `0x${'d'.repeat(40)}`;
    const scope = dockerHostScope({ hostKey, controlKey: controller.publicKey,
      isolation: 'gvisor', socketPath: '/var/run/docker.sock' });
    await host.db.insert(hostBinding).values({ slot: 'cpu1', scopeHash: admissionHash(scope), scope });
    const lease = signedLeaseSchema.parse(controller.sign('lease', { version: 1, hostKey, runId, owner,
      image: `node@sha256:${'e'.repeat(64)}`, argv: ['node'], issuedAt: 1, expiresAt: 100_000,
      maxSeconds: 10, nonce: `0x${'f'.repeat(64)}` }));
    const leaseHash = hostMessageHash(lease), leaseBodyHash = hostMessageHash({ body: lease.body, signature: '' });
    const tick = signedTickSchema.parse(host.identity.sign('tick', { version: 1, hostKey, runId, owner, leaseHash: leaseBodyHash,
      sequence: 0, timestamp: 5000, elapsedMs: 5000, cpuMs: 100, state: 'EXITED' as const,
      previousHash: null, heartbeat: null, gpuUtil: 0, gpuMemoryBytes: 0, powerWatts: 0 }));
    const ack = signedAckSchema.parse(controller.sign('ack', { version: 1, hostKey, runId, leaseHash: leaseBodyHash, sequence: 0,
      tickHash: hostMessageHash(tick), acceptedAt: 5001, billableSeconds: 5, billableDelta: 5, fault: false }));
    await host.db.insert(hostRuns).values({ runId, owner, leaseHash, lease, state: 'completed',
      ticks: [tick], acks: [ack], billableSeconds: 5, cleanupConfirmed: true });
    await host.close();
    if (process.platform === 'linux') {
      const journal = join(source, 'journal');
      await chmod(journal, 0o755);
      const nested = await readdir(journal, { recursive: true });
      let pgliteFile: string | undefined;
      for (const name of nested) {
        if ((await lstat(join(journal, name))).isFile()) { pgliteFile = name; break; }
      }
      expect(pgliteFile).toBeDefined();
      await chmod(join(journal, pgliteFile!), 0o644);
    }
    const files = await snapshotPlatformHost(source, backup);
    expect(files.files.some(item => item.path === 'host-ed25519.pem')).toBe(true);
    expect(files.files.some(item => item.path.startsWith('journal/'))).toBe(true);
    expect(files.directories.some(item => item.startsWith('journal/'))).toBe(true);
    await restorePlatformHostFiles(backup, scratch, files);
    const controllerRow = { run_id: runId, host_id: hostId, lease_hash: leaseHash, cleanup_confirmed: 1, lease,
      ticks: [tick], acknowledgments: [ack] };
    const database = { query: async () => ({ rows: [controllerRow] }) } as never;
    expect(await verifyPlatformHostSemantic(scratch, hostId, hostKey,
      controller.publicKey, scope, database)).toEqual({ hostRuns: 1, paidSessions: 0, controllerLeases: 1 });
    const changed = { query: async () => ({ rows: [{ ...controllerRow, lease_hash: `0x${'0'.repeat(64)}` }] }) } as never;
    await expect(verifyPlatformHostSemantic(scratch, hostId, hostKey, controller.publicKey, scope, changed)).rejects.toThrow();
    const incomplete = { query: async () => ({ rows: [{ ...controllerRow, acknowledgments: [] }] }) } as never;
    await expect(verifyPlatformHostSemantic(scratch, hostId, hostKey, controller.publicKey, scope, incomplete)).rejects.toThrow();
    await expect(verifyPlatformHostSemantic(scratch, hostId, hostKey,
      `0x${'b'.repeat(64)}`, scope, database)).rejects.toThrow();
    const tampered = await openHostJournal(scratch);
    await tampered.db.update(hostBinding).set({ scopeHash: '0'.repeat(64) });
    await tampered.close();
    await expect(verifyPlatformHostSemantic(scratch, hostId, hostKey,
      controller.publicKey, scope, database)).rejects.toThrow();
    const empty = files.directories.find(item => !files.files.some(file => file.path.startsWith(item + '/')));
    expect(empty).toBeDefined();
    await rm(join(backup, ...empty!.split('/')), { recursive: true });
    await expect(verifyPlatformHostFiles(backup, files)).rejects.toThrow();
    await mkdir(join(backup, ...empty!.split('/')), { recursive: true, mode: 0o700 });
    await mkdir(join(backup, 'unexpected-empty'), { mode: 0o700 });
    await expect(verifyPlatformHostFiles(backup, files)).rejects.toThrow();
    await rm(join(backup, 'unexpected-empty'), { recursive: true });
    await writeFile(join(backup, 'host-ed25519.pem'), 'tampered');
    await expect(verifyPlatformHostFiles(backup, files)).rejects.toThrow();
    if (process.platform === 'linux') {
      await chmod(join(source, 'host-ed25519.pem'), 0o644);
      await expect(snapshotPlatformHost(source, join(work, 'bad-key-backup'))).rejects.toThrow();
    }
  }, 120_000);

  it('fingerprints every public table and validates the original signed transaction bytes', async () => {
    const client = new PGlite();
    try {
      for (const name of ['platform_runs', 'platform_host_leases', 'platform_transaction_journal',
        'platform_receipt_batches', 'platform_receipt_entries', 'cysts', 'cyst_owners']) {
        await client.exec(`CREATE TABLE ${name} (id text PRIMARY KEY, payload jsonb)`);
      }
      // The real journal has a richer schema; this exercise proves the parser
      // checks a signed serialized transaction, not just a saved row checksum.
      await client.exec('DROP TABLE platform_transaction_journal');
      await client.exec(`CREATE TABLE platform_transaction_journal (
        key text PRIMARY KEY, chain_id integer, sender text, "to" text, data text, raw text, hash text, nonce integer)`);
      const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
      const to = `0x${'2'.repeat(40)}` as const;
      const raw = await account.signTransaction({ chainId: 31337, nonce: 0, to, data: '0x', value: 0n,
        gas: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
      await client.query(`INSERT INTO platform_transaction_journal(key,chain_id,sender,"to",data,raw,hash,nonce)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, ['settle:test', 31337, account.address, to, '0x', raw, keccak256(raw), 0]);
      const pg = client as never;
      const before = await fingerprintPlatformDatabase(pg);
      expect(before.map(item => item.name)).toContain('platform_transaction_journal');
      expect(await verifyPlatformSignedJournal(pg, 31337)).toBe(1);
      await client.query('UPDATE platform_transaction_journal SET hash=$1', [`0x${'0'.repeat(64)}`]);
      await expect(verifyPlatformSignedJournal(pg, 31337)).rejects.toThrow('Signed journal');
      expect(await fingerprintPlatformDatabase(pg)).not.toEqual(before);
    } finally { await client.close(); }
  });
});
