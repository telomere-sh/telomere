import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, toHex, type Hex } from 'viem';
import { CystRegistryClient } from '../src/cysts/registry-client.js';
import { CYST_CAPABILITIES, cystMetadataSchema, type CystEnvelope, type CystMetadata } from '../src/cysts/types.js';
import { cystRegistryAddressSchema, cystRegistryCommitPreparedSchema, cystRegistryConfigSchema, cystRegistryPinsSchema,
  cystRegistryDownloadSchema, cystRegistryRetirePreparedSchema, cystRegistrySnapshotSchema, cystRegistryVerificationSchema,
  type CystRegistryPins, type CystRegistryReader, type CystRegistrySnapshot } from '../src/cysts/registry-types.js';
import { encryptCheckpoint } from '../src/sdk/cysts.js';
import { ApiTransport } from '../src/sdk/transport.js';

const owner = '0x' + '11'.repeat(20), agent = '0x' + '22'.repeat(20), vault = '0x' + '33'.repeat(20);
const outsider = '0x' + '66'.repeat(20), ownerToken = 'a'.repeat(64), agentToken = 'b'.repeat(64), outsiderToken = 'c'.repeat(64);
const agentId = keccak256(toHex('actual-selection-bytes32-identity'));
const zero: Hex = `0x${'0'.repeat(64)}`;
const pins = cystRegistryPinsSchema.parse({ chainId: 31337, confirmations: 0,
  registryAddress: '0x' + '44'.repeat(20), registryCodeHash: keccak256('0x60006000'),
  selectionRegistryAddress: '0x' + '55'.repeat(20), selectionRegistryCodeHash: keccak256('0x60016000') });
// Independent viem vectors use literal ABI definitions, not the production plan builders.
const vectorAbi = parseAbi([
  'function commitChecked(bytes32 agentId,bytes32 cystHash,uint64 sizeBytes,bytes32 storageRef,uint64 expectedRevision)',
  'function retireChecked(bytes32 agentId,uint64 expectedRevision)',
  'function commit(bytes32 agentId,bytes32 cystHash,uint64 sizeBytes,bytes32 storageRef)',
]);

describe('checked CystRegistry SDK over actual authenticated HTTP and independent viem vectors', () => {
  let api: Server, origin: string, checkpoint: CystMetadata, original: CystRegistrySnapshot, independent: CystRegistrySnapshot;
  let originalCheckpoint: CystMetadata, envelope: CystEnvelope, recoveryKey: Uint8Array, ciphertext: string;
  let mutate: (path: string, value: unknown) => unknown;
  let afterPlan: () => void, principalOverride: string | undefined, checkFailure: boolean, snapshotFailure: boolean, streamBlob: boolean;
  const calls: { path: string; method: string; body: unknown; key: string | undefined }[] = [];
  const posts = () => calls.filter(call => call.method === 'POST');
  const vectorRef = (item: CystMetadata) => keccak256(toHex(JSON.stringify(['telomere.cyst.locator', 1,
    item.version, item.algorithm, item.id, item.owner, item.agent, item.applicationSchema,
    item.plaintextBytes, item.nonce, item.sha256, item.ciphertextBytes])));
  const commitVector = (snapshot = independent) => ({ chainId: pins.chainId, from: snapshot.binding.agentWallet,
    to: pins.registryAddress, value: '0', data: encodeFunctionData({ abi: vectorAbi, functionName: 'commitChecked',
      args: [agentId, `0x${checkpoint.sha256}`, BigInt(checkpoint.ciphertextBytes), vectorRef(checkpoint), BigInt(snapshot.current.revision)] }) });
  const retireVector = (snapshot = independent) => ({ chainId: pins.chainId, from: snapshot.binding.agentWallet,
    to: pins.registryAddress, value: '0', data: encodeFunctionData({ abi: vectorAbi, functionName: 'retireChecked',
      args: [agentId, BigInt(snapshot.current.revision)] }) });
  const reader: CystRegistryReader = { pins,
    check: vi.fn(async () => { if (checkFailure) throw new Error('Independent deployment check failed'); }),
    snapshot: vi.fn(async () => { if (snapshotFailure) throw new Error('Independent canonical read failed'); return structuredClone(independent); }) };
  const client = (token = agentToken, readerValue = reader, pinValues: CystRegistryPins = pins) =>
    new CystRegistryClient({ baseUrl: origin, pins: pinValues, reader: readerValue, sessionToken: token });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url ?? '', method = request.method ?? 'GET', chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), body: unknown = bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined;
    calls.push({ path, method, body, key: typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : undefined });
    response.setHeader('Content-Type', 'application/json');
    const principal = principalOverride ?? (request.headers.cookie === 'telomere_session=' + ownerToken ? owner
      : request.headers.cookie === 'telomere_session=' + agentToken ? agent
        : request.headers.cookie === 'telomere_session=' + outsiderToken ? outsider : undefined);
    const deny = (status: number) => { response.statusCode = status; response.end('{"title":"fixture_denied"}'); };
    if (!principal) { deny(401); return; }
    if (method === 'POST' && (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json')) {
      deny(403); return;
    }
    let value: unknown;
    if (path === '/api/me') value = { address: principal, demo: false };
    else if (path === '/api/cyst-registry/config') value = { protocol: 'telomere-cyst-registry-v1', pins,
      storageRefVersion: 1, maxCheckpointBytes: CYST_CAPABILITIES.maxCiphertextBytes, maxRegistryBytes: 2_147_483_648 };
    else if (!path.startsWith('/api/cyst-registry/agents/' + agentId + '/')) { deny(404); return; }
    else if (path.endsWith('/latest') && method === 'GET') value = structuredClone(independent);
    else if (path === '/api/cyst-registry/agents/' + agentId + '/checkpoints/' + checkpoint.id + '/blob' && method === 'GET') {
      if (principal !== owner && principal !== agent) { deny(403); return; }
      value = { ...structuredClone(independent), checkpoint, ciphertext }; afterPlan();
    }
    else if (path.endsWith('/verify') && method === 'POST') value = { ...structuredClone(independent), checkpoint,
      matches: !independent.current.retired && independent.current.revision !== '0'
        && independent.current.cystHash === '0x' + checkpoint.sha256
        && independent.current.storageRef === vectorRef(checkpoint)
        && independent.current.sizeBytes === String(checkpoint.ciphertextBytes) };
    else if (method === 'POST' && (path.endsWith('/commit-plan') || path.endsWith('/retire-plan'))) {
      if (principal !== agent || !/^[a-zA-Z0-9_-]{8,128}$/.test(String(request.headers['idempotency-key'] ?? ''))) { deny(403); return; }
      value = path.endsWith('/commit-plan') ? { ...structuredClone(independent), checkpoint, transaction: commitVector() }
        : { ...structuredClone(independent), transaction: retireVector() };
      afterPlan();
    } else { deny(404); return; }
    const serialized = JSON.stringify(mutate(path, structuredClone(value)));
    if (streamBlob && path.endsWith('/blob')) {
      response.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      for (let offset = 0; offset < serialized.length; offset += 65_536) {
        if (!response.write(serialized.slice(offset, offset + 65_536))) await once(response, 'drain');
      }
      response.end();
    } else response.end(serialized);
  }

  beforeAll(async () => {
    const encrypted = await encryptCheckpoint(new TextEncoder().encode('Telomere checkpoint 🧬'),
      { owner, agent, applicationSchema: 'registry-test/v1' });
    envelope = encrypted.envelope; recoveryKey = encrypted.recoveryKey;
    const { ciphertext: _ciphertext, ...header } = encrypted.envelope;
    checkpoint = cystMetadataSchema.parse({ ...header,
      ciphertextBytes: encrypted.envelope.plaintextBytes + 16, state: 'ready', createdAt: '2026-10-12T10:00:00.000Z' });
    originalCheckpoint = structuredClone(checkpoint);
    original = cystRegistrySnapshotSchema.parse({ binding: { agentId, owner, agentWallet: agent, vault, status: 1, frozen: false },
      current: { agentId, cystHash: '0x' + checkpoint.sha256, sizeBytes: String(checkpoint.ciphertextBytes), storageRef: vectorRef(checkpoint),
        revision: '7', committedAt: '1791799200', retired: false, block: { number: '31', hash: keccak256(toHex('canonical-block-31')) } } });
    api = createServer((request, response) => { void handle(request, response).catch(() => { response.statusCode = 503; response.end('{}'); }); });
    // Full-size digest/equality checks can take longer than Node's default idle
    // socket timeout on the Linux acceptance machine.
    api.keepAliveTimeout = 60_000;
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const address = api.address(); if (!address || typeof address === 'string') throw new Error('Missing CystRegistry fixture HTTP address');
    origin = 'http://127.0.0.1:' + address.port;
  });
  beforeEach(() => { checkpoint = structuredClone(originalCheckpoint); ciphertext = envelope.ciphertext;
    independent = structuredClone(original); mutate = (_path, value) => value;
    calls.length = 0; afterPlan = () => {}; principalOverride = undefined; checkFailure = false; snapshotFailure = false; streamBlob = false; vi.clearAllMocks(); });
  afterAll(async () => { recoveryKey?.fill(0); api?.closeAllConnections(); if (api) await new Promise<void>(resolve => api.close(() => resolve())); });

  function alterCommit(change: (value: ReturnType<typeof cystRegistryCommitPreparedSchema.parse>) => void) {
    mutate = (path, raw) => { if (!path.endsWith('/commit-plan')) return raw;
      const value = cystRegistryCommitPreparedSchema.parse(raw); change(value); return value; };
  }

  it('binds actual bytes32 identity, encrypted metadata, CAS revision and exact unsigned viem calldata', async () => {
    const value = await client().commitPlan(agentId, checkpoint, 'checkpoint-commit');
    expect(value.transaction).toEqual(commitVector());
    expect(decodeFunctionData({ abi: vectorAbi, data: toHex(Buffer.from(value.transaction.data.slice(2), 'hex')) })).toEqual({ functionName: 'commitChecked',
      args: [agentId, '0x' + checkpoint.sha256, BigInt(checkpoint.ciphertextBytes), vectorRef(checkpoint), 7n] });
    expect(value.binding.agentId).not.toBe(value.checkpoint.agent); expect(value.transaction.from).toBe(agent);
    expect(value.transaction.from).not.toBe(vault); expect(Object.isFrozen(value.checkpoint)).toBe(true);
    expect(posts()).toEqual([{ path: '/api/cyst-registry/agents/' + agentId + '/commit-plan', method: 'POST',
      body: { checkpointId: checkpoint.id }, key: 'checkpoint-commit' }]);
    expect(calls.every(call => call.path === '/api/me' || call.path.startsWith('/api/cyst-registry/'))).toBe(true);
  });

  it('accepts a different API head only with identical substantive state and returns the independent block', async () => {
    mutate = (path, raw) => { if (!path.endsWith('/latest')) return raw;
      const value = cystRegistrySnapshotSchema.parse(raw); value.current.block = { number: '30', hash: keccak256(toHex('old-api-head')) }; return value; };
    const value = await client(ownerToken).latest(agentId);
    expect(value.current.block).toEqual(independent.current.block); expect(Object.isFrozen(value.current.block)).toBe(true);
  });

  it.each([ownerToken, agentToken])('independently verifies the original checkpoint for an authorized reader', async token => {
    const value = await client(token).verify(agentId, checkpoint);
    expect(value.matches).toBe(true); expect(value.current).toEqual(independent.current);
    expect(posts()).toEqual([{ path: '/api/cyst-registry/agents/' + agentId + '/verify', method: 'POST', body: { checkpointId: checkpoint.id }, key: undefined }]);
  });

  it('allows frozen/dormant preservation, rejects dead commits and keeps exact retirement available', async () => {
    independent.binding.status = 2; independent.binding.frozen = true;
    expect((await client().commitPlan(agentId, checkpoint, 'dormant-commit')).binding.status).toBe(2);
    independent.binding.status = 3; calls.length = 0;
    await expect(client().commitPlan(agentId, checkpoint, 'dead-commit')).rejects.toThrow('dead agent');
    expect(posts()).toHaveLength(0);
    const value = await client().retirePlan(agentId, '7', 'dead-retire');
    expect(value.transaction).toEqual(retireVector());
    expect(decodeFunctionData({ abi: vectorAbi, data: toHex(Buffer.from(value.transaction.data.slice(2), 'hex')) })).toEqual({ functionName: 'retireChecked', args: [agentId, 7n] });
  });

  it.each(['commit', 'retire'] as const)('refuses an owner session as substitute agent authority for %s before POST', async operation => {
    const value = client(ownerToken);
    await expect(operation === 'commit' ? value.commitPlan(agentId, checkpoint, 'owner-commit')
      : value.retirePlan(agentId, '7', 'owner-retire')).rejects.toThrow('not authorized');
    expect(posts()).toHaveLength(0);
  });

  it('refuses an unrelated principal for reads and does not treat an arbitrary checkpoint label as authority', async () => {
    await expect(client(outsiderToken).latest(agentId)).rejects.toThrow('not authorized');
    await expect(client().commitPlan(agentId, { ...checkpoint, agent: outsider }, 'foreign-label')).rejects.toThrow('authoritative Selection');
    await expect(client().commitPlan(agentId, { ...checkpoint, owner: outsider }, 'foreign-owner')).rejects.toThrow('authoritative Selection');
    expect(posts()).toHaveLength(0);
  });

  it.each(['id', 'owner', 'agent', 'sha256', 'nonce', 'applicationSchema', 'plaintextBytes', 'ciphertextBytes', 'createdAt'] as const)
    ('refuses server substitution of original checkpoint %s', async field => {
      alterCommit(value => {
        if (field === 'id') value.checkpoint.id = keccak256(toHex('different-checkpoint'));
        else if (field === 'owner' || field === 'agent') value.checkpoint[field] = outsider;
        else if (field === 'sha256') value.checkpoint.sha256 = '77'.repeat(32);
        else if (field === 'nonce') value.checkpoint.nonce = '88'.repeat(24);
        else if (field === 'applicationSchema') value.checkpoint.applicationSchema = 'substituted/v1';
        else if (field === 'plaintextBytes' || field === 'ciphertextBytes') value.checkpoint[field] += 1;
        else value.checkpoint.createdAt = '2026-10-12T10:00:01.000Z';
      });
      await expect(client().commitPlan(agentId, checkpoint, 'metadata-tamper')).rejects.toThrow('original checkpoint');
    });

  it.each(['chainId', 'from', 'to', 'value', 'trailing-data', 'unchecked-entrypoint'] as const)
    ('refuses substituted unsigned commit transaction %s', async field => {
      if (field === 'value') mutate = (path, raw) => path.endsWith('/commit-plan') ? { ...cystRegistryCommitPreparedSchema.parse(raw),
        transaction: { ...cystRegistryCommitPreparedSchema.parse(raw).transaction, value: '1' } } : raw;
      else alterCommit(value => {
        if (field === 'chainId') value.transaction.chainId += 1;
        else if (field === 'from' || field === 'to') value.transaction[field] = cystRegistryAddressSchema.parse(outsider);
        else if (field === 'trailing-data') value.transaction.data += '00';
        else value.transaction.data = encodeFunctionData({ abi: vectorAbi, functionName: 'commit',
          args: [agentId, `0x${checkpoint.sha256}`, BigInt(checkpoint.ciphertextBytes), vectorRef(checkpoint)] });
      });
      await expect(client().commitPlan(agentId, checkpoint, 'transaction-tamper')).rejects.toThrow();
    });

  it.each(['binding', 'hash', 'size', 'storageRef', 'revision', 'retired', 'committedAt'] as const)
    ('refuses an API latest %s different from the independent canonical state', async field => {
      mutate = (path, raw) => { if (!path.endsWith('/latest')) return raw;
        const value = cystRegistrySnapshotSchema.parse(raw);
        if (field === 'binding') value.binding.agentWallet = cystRegistryAddressSchema.parse(outsider);
        else if (field === 'hash') value.current.cystHash = keccak256(toHex('wrong-hash'));
        else if (field === 'size') value.current.sizeBytes = '1';
        else if (field === 'storageRef') value.current.storageRef = keccak256(toHex('wrong-locator'));
        else if (field === 'revision') value.current.revision = '6';
        else if (field === 'retired') value.current.retired = true;
        else value.current.committedAt = '1';
        return value; };
      await expect(client().latest(agentId)).rejects.toThrow('independent current state');
    });

  it('rejects a plan when the independent revision changes during the API request', async () => {
    afterPlan = () => { independent.current.revision = '8'; };
    await expect(client().commitPlan(agentId, checkpoint, 'revision-race')).rejects.toThrow('independent current state');
    independent = structuredClone(original);
    await expect(client().retirePlan(agentId, '7', 'retire-race')).rejects.toThrow('independent current state');
  });

  it('rechecks the authenticated principal after preparing a plan', async () => {
    afterPlan = () => { principalOverride = owner; };
    await expect(client().commitPlan(agentId, checkpoint, 'session-race')).rejects.toThrow('not authorized');
  });

  it('never promotes the API matches bit over independent retired state', async () => {
    independent.current.retired = true;
    expect((await client().verify(agentId, checkpoint)).matches).toBe(false);
    mutate = (path, raw) => path.endsWith('/verify') ? { ...cystRegistryVerificationSchema.parse(raw), matches: true } : raw;
    await expect(client().verify(agentId, checkpoint)).rejects.toThrow('independent result');
  });

  it('returns an independently checked absent entry and refuses invalid retirement revisions', async () => {
    independent.current = { ...independent.current, cystHash: zero, sizeBytes: '0', storageRef: zero,
      revision: '0', committedAt: '0', retired: false };
    expect((await client().latest(agentId)).current.revision).toBe('0');
    expect((await client().verify(agentId, checkpoint)).matches).toBe(false);
    await expect(client().retirePlan(agentId, '0', 'absent-retire')).rejects.toThrow('live checkpoint');
    independent = structuredClone(original);
    for (const revision of ['6', '18446744073709551616', '07']) {
      await expect(client().retirePlan(agentId, revision, 'invalid-revision')).rejects.toThrow();
    }
    independent.current.retired = true;
    await expect(client().retirePlan(agentId, '7', 'repeat-retire')).rejects.toThrow('live checkpoint');
    expect(posts().filter(call => call.path.endsWith('/retire-plan'))).toHaveLength(0);
  });

  it('rejects malformed expected checkpoint and operation inputs before transport', async () => {
    await expect(client().commitPlan(agentId, { ...checkpoint, state: 'pending' }, 'pending-checkpoint')).rejects.toThrow();
    await expect(client().commitPlan(agentId, { ...checkpoint, ciphertextBytes: checkpoint.ciphertextBytes + 1 }, 'invalid-length')).rejects.toThrow();
    await expect(client().commitPlan(zero, checkpoint, 'invalid-agent')).rejects.toThrow();
    await expect(client().commitPlan(agentId, checkpoint, 'bad key')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('checks every deployment pin and independent reader on each call without caching', async () => {
    const value = client(); await value.config();
    mutate = (path, raw) => path.endsWith('/config') ? { ...cystRegistryConfigSchema.parse(raw),
      pins: { ...pins, registryCodeHash: keccak256('0x60026000') } } : raw;
    await expect(value.config()).rejects.toThrow('reviewed pins');
    expect(reader.check).toHaveBeenCalledTimes(2);
    expect(() => client(agentToken, { ...reader, pins: { ...pins, confirmations: 1 } })).toThrow('exact reviewed pins');
    expect(() => client(agentToken, { ...reader, pins: { ...pins, selectionRegistryAddress: pins.registryAddress } })).toThrow();
  });

  it('fails closed when independent deployment or canonical state reading is unavailable', async () => {
    checkFailure = true;
    await expect(client().commitPlan(agentId, checkpoint, 'unavailable-check')).rejects.toThrow('deployment check failed');
    expect(posts()).toHaveLength(0); checkFailure = false; snapshotFailure = true;
    await expect(client().verify(agentId, checkpoint)).rejects.toThrow('canonical read failed');
    expect(posts()).toHaveLength(0);
  });

  it('refuses substituted retirement calldata even when its state and principal match', async () => {
    mutate = (path, raw) => { if (!path.endsWith('/retire-plan')) return raw;
      const value = cystRegistryRetirePreparedSchema.parse(raw); value.transaction.data = commitVector().data; return value; };
    await expect(client().retirePlan(agentId, '7', 'wrong-retirement')).rejects.toThrow('exact unsigned transaction');
  });

  it.each([ownerToken, agentToken])('downloads and locally restores the exact current checkpoint for an authorized principal', async token => {
    const value = client(token);
    expect(await value.download(agentId, checkpoint)).toEqual(envelope);
    const keyBefore = Uint8Array.from(recoveryKey);
    expect(new TextDecoder().decode(await value.restore(agentId, checkpoint, recoveryKey))).toBe('Telomere checkpoint 🧬');
    expect(recoveryKey).toEqual(keyBefore);
    await expect(value.restore(agentId, checkpoint, new Uint8Array(32))).rejects.toThrow();
    expect(posts()).toHaveLength(0);
    expect(calls.filter(call => call.path.endsWith('/blob'))).toHaveLength(3);
    expect(calls.every(call => call.body === undefined && call.key === undefined)).toBe(true);
  });

  it.each(['revision', 'retired', 'storageRef', 'hash'] as const)('rejects %s outside the current published live checkpoint before blob access', async field => {
    if (field === 'revision') independent.current.revision = '0';
    else if (field === 'retired') independent.current.retired = true;
    else if (field === 'storageRef') independent.current.storageRef = keccak256(toHex('unpublished-locator'));
    else independent.current.cystHash = keccak256(toHex('unpublished-ciphertext'));
    await expect(client().download(agentId, checkpoint)).rejects.toThrow('current published live');
    expect(calls.some(call => call.path.endsWith('/blob'))).toBe(false);
  });

  it('rejects an outsider session and owner/agent label substitution before private blob access', async () => {
    await expect(client(outsiderToken).download(agentId, checkpoint)).rejects.toThrow('not authorized');
    for (const field of ['owner', 'agent'] as const) {
      await expect(client().download(agentId, { ...checkpoint, [field]: outsider })).rejects.toThrow('authoritative Selection');
    }
    expect(calls.some(call => call.path.endsWith('/blob'))).toBe(false);
  });

  it.each(['id', 'owner', 'agent', 'applicationSchema', 'nonce', 'sha256', 'createdAt'] as const)
    ('rejects substituted download metadata %s against the original checkpoint', async field => {
      mutate = (path, raw) => { if (!path.endsWith('/blob')) return raw;
        const value = cystRegistryDownloadSchema.parse(raw);
        if (field === 'id') value.checkpoint.id = '0x' + 'ee'.repeat(32);
        else if (field === 'owner' || field === 'agent') value.checkpoint[field] = outsider;
        else if (field === 'applicationSchema') value.checkpoint.applicationSchema = 'changed/v1';
        else if (field === 'nonce') value.checkpoint.nonce = 'ee'.repeat(24);
        else if (field === 'sha256') value.checkpoint.sha256 = 'ee'.repeat(32);
        else value.checkpoint.createdAt = '2026-10-12T10:00:01.000Z';
        return value; };
      await expect(client().download(agentId, checkpoint)).rejects.toThrow('original current published checkpoint');
    });

  it.each(['malformed', 'noncanonical', 'wrong-digest', 'truncated'] as const)
    ('rejects %s downloaded ciphertext before plaintext restoration', async kind => {
      if (kind === 'malformed') ciphertext = '!' + envelope.ciphertext.slice(1);
      else if (kind === 'noncanonical') {
        // Change only unused base64 pad bits; permissive decoders return the
        // original bytes, but the canonical encoding must still be rejected.
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        const last = ciphertext.length - (ciphertext.endsWith('==') ? 3 : 2);
        const index = alphabet.indexOf(ciphertext[last]!);
        ciphertext = ciphertext.slice(0, last) + alphabet[index | 1]! + ciphertext.slice(last + 1);
        expect(Buffer.from(ciphertext, 'base64')).toEqual(Buffer.from(envelope.ciphertext, 'base64'));
      } else if (kind === 'wrong-digest') ciphertext = Buffer.alloc(checkpoint.ciphertextBytes).toString('base64');
      else ciphertext = Buffer.from(envelope.ciphertext, 'base64').subarray(1).toString('base64');
      await expect(client().download(agentId, checkpoint)).rejects.toThrow();
    });

  it.each(['revision', 'retired', 'owner', 'agent', 'session'] as const)('rejects a %s race after private blob response', async changed => {
    afterPlan = () => {
      if (changed === 'revision') independent.current.revision = '8';
      else if (changed === 'retired') independent.current.retired = true;
      else if (changed === 'owner') independent.binding.owner = cystRegistryAddressSchema.parse(outsider);
      else if (changed === 'agent') independent.binding.agentWallet = cystRegistryAddressSchema.parse(outsider);
      else principalOverride = outsider;
    };
    await expect(client().download(agentId, checkpoint)).rejects.toThrow();
    expect(calls.filter(call => call.path.endsWith('/blob'))).toHaveLength(1);
  });

  it('downloads a maximum-size checkpoint over actual bounded HTTP with independent digest and locator checks', async () => {
    const raw = Buffer.alloc(CYST_CAPABILITIES.maxCiphertextBytes, 42);
    checkpoint = cystMetadataSchema.parse({ ...checkpoint, plaintextBytes: CYST_CAPABILITIES.maxPlaintextBytes,
      ciphertextBytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') });
    ciphertext = raw.toString('base64');
    independent.current = { ...independent.current, cystHash: `0x${checkpoint.sha256}`,
      sizeBytes: String(raw.length), storageRef: vectorRef(checkpoint) };
    const value = await client().download(agentId, checkpoint);
    expect(Buffer.from(value.ciphertext, 'base64')).toEqual(raw);
    expect(calls.filter(call => call.path.endsWith('/blob'))).toHaveLength(1);
  });

  it('rejects a streamed blob response beyond the published maximum byte bound', async () => {
    streamBlob = true;
    ciphertext = 'A'.repeat(CYST_CAPABILITIES.maxUploadBodyBytes + 1);
    await expect(client().download(agentId, checkpoint)).rejects.toThrow('response_limit');
  });

  it.each([true, false])('cancels an oversized response without replacing the limit error when cancellation fails (header=%s)', async advertised => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(17)); },
      cancel() { cancelled = true; return Promise.reject(new Error('Cancellation fixture failure')); },
    });
    const transport = new ApiTransport(origin, { fetch: async () => new Response(body,
      { headers: advertised ? { 'Content-Length': '17' } : {} }) });
    await expect(transport.request('/api/cyst-registry/config', { maxResponseBytes: 16 })).rejects.toMatchObject({ code: 'response_limit' });
    expect(cancelled).toBe(true);
  });
});
