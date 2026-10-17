import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCurrentCystPaidFileRestore } from '../src/agents/agent-current-cyst-file-restore.js';
import { bytes32Schema } from '../src/common.js';
import { generateLargeCystId, LargeCystPrivateStore, saveLargeCystFile } from '../src/cysts/large-checkpoints.js';
import { largeCystRegistryDescriptor } from '../src/cysts/large-registry.js';
import { cystRegistryBindingSchema, cystRegistryPinsSchema, cystRegistryStateSchema,
  type CystRegistryReader } from '../src/cysts/registry-types.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';
import { generateCystWrappingIdentity, wrapCystRecoveryKey } from '../src/sdk/cyst-key-wrap.js';

const id = (digit: string) => bytes32Schema.parse('0x' + digit.repeat(64));
describe('agent private prepared-file expiry after process restart', () => {
  let root: string, encrypted: LargeCystPrivateStore | undefined;
  const opened: CystCheckpointFileVault[] = [], restorers: AgentCurrentCystPaidFileRestore[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const restore of restorers.splice(0)) await restore.dispose().catch(() => undefined);
    for (const journal of opened.splice(0)) journal.close();
    await encrypted?.close(); encrypted = undefined;
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('deletes expired authenticated plaintext before a changed-registry rejection, with no wallet or CPU calls', async () => {
    root = await mkdtemp(join(tmpdir(), 'paid-cyst-expired-cache-'));
    const encryptedDirectory = join(root, 'ciphertext'), privateDirectory = join(root, 'journal'), preparationDirectory = join(root, 'prepared');
    await mkdir(encryptedDirectory, { mode: 0o700 }); await mkdir(privateDirectory, { mode: 0o700 });
    encrypted = new LargeCystPrivateStore(encryptedDirectory, { globalMaxBytes: 8_388_608, ownerMaxBytes: 8_388_608 }); await encrypted.initialize();
    const owner = '0x' + '1'.repeat(40), agent = '0x' + '2'.repeat(40), vault = '0x' + '3'.repeat(40), agentId = id('a');
    const source = Buffer.from('private application state that must expire'), sourcePath = join(root, 'source.bin');
    await writeFile(sourcePath, source, { mode: 0o600 });
    const checkpointId = generateLargeCystId(), recoveryKey = randomBytes(32), masterKey = randomBytes(32);
    const ownerIdentity = await generateCystWrappingIdentity(), agentIdentity = await generateCystWrappingIdentity();
    const scope = { owner, agent, applicationSchema: 'private-expiry.v1' };
    const wrapped = await wrapCystRecoveryKey(recoveryKey, { owner, agent, checkpointId },
      { ownerPublicKey: ownerIdentity.publicKey, agentPublicKey: agentIdentity.publicKey });
    const manifest = await saveLargeCystFile({ store: encrypted, sourcePath, id: checkpointId, scope, recoveryKey,
      wrappedKey: { bundle: wrapped, ownerIdentity, agentPublicKey: agentIdentity.publicKey } }); recoveryKey.fill(0);
    const checkpoint = largeCystRegistryDescriptor(manifest);
    const pins = cystRegistryPinsSchema.parse({ chainId: 31337, registryAddress: '0x' + '4'.repeat(40), registryCodeHash: id('b'),
      selectionRegistryAddress: '0x' + '5'.repeat(40), selectionRegistryCodeHash: id('c'), confirmations: 0 });
    const binding = cystRegistryBindingSchema.parse({ agentId, owner, agentWallet: agent, vault, status: 1, frozen: false });
    let current = cystRegistryStateSchema.parse({ agentId, cystHash: checkpoint.cystHash, sizeBytes: String(checkpoint.sizeBytes),
      storageRef: checkpoint.storageRef, revision: '1', committedAt: '1', retired: false, block: { number: '10', hash: id('d') } });
    let restarted = false, observedEmptyBeforeRegistry = false, forbiddenCalls = 0;
    const preparedPath = join(preparationDirectory, 'state.bin');
    const reader: CystRegistryReader = { pins, check: async () => {
      if (restarted) {
        expect(await readdir(preparationDirectory)).toEqual(['.operation']); observedEmptyBeforeRegistry = true;
      }
    }, snapshot: async () => ({ binding, current }) };
    // A pinned-reader unit seam, not a chain/host acceptance. Real multipart
    // encryption, private disk storage and encrypted journal reopen are used.
    const store = { resolveCurrent: async () => ({ checkpointId, checkpoint, manifest, binding, current, pins }),
      part: (checkpointId: string, index: number, signal?: AbortSignal) => { signal?.throwIfAborted(); return encrypted!.part(checkpointId, index); } };
    const forbidden = async () => { forbiddenCalls++; throw new Error('Wallet, HTTP or CPU must not be used'); };
    const client = { origin: 'https://private-expiry.invalid', config: forbidden, get: forbidden, command: forbidden, sessionLease: forbidden };
    const input = { origin: client.origin, uploadFile: forbidden };
    let journal = new CystCheckpointFileVault({ directory: privateDirectory, masterKey }); opened.push(journal);
    const options = { owner, agent, agentId, applicationSchema: scope.applicationSchema, operationId: 'private-expiry',
      directory: preparationDirectory, imageDigest: 'sha256:' + 'e'.repeat(64), maxCommands: 2,
      restoreArgvPrefix: ['/usr/local/bin/node', '/opt/reviewed-restore.mjs'], reader, store, identity: agentIdentity,
      client, input, journal, maxBytes: 65_536, minimumFreeBytes: 0, plaintextTtlMs: 60_000 };
    const original = new AgentCurrentCystPaidFileRestore(options); restorers.push(original);
    const prepared = await original.prepare(); expect((await readFile(preparedPath)).equals(source)).toBe(true);
    // A new encrypted-journal owner models a restarted agent. The original
    // process timer is deliberately not used to remove its cache.
    journal.close(); journal = new CystCheckpointFileVault({ directory: privateDirectory, masterKey }); opened.push(journal); masterKey.fill(0);
    const recovered = new AgentCurrentCystPaidFileRestore({ ...options, journal }); restorers.push(recovered);
    current = { ...current, revision: '2', block: { number: '11', hash: id('f') } }; restarted = true;
    vi.spyOn(Date, 'now').mockReturnValue(prepared.expiresAt + 1);
    await expect(recovered.restore(id('9'))).rejects.toThrow('Original current Cyst or agent binding changed');
    expect(observedEmptyBeforeRegistry).toBe(true);
    expect(await readdir(preparationDirectory)).toEqual(['.operation']);
    await expect(readFile(preparedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(forbiddenCalls).toBe(0);
  });
});
