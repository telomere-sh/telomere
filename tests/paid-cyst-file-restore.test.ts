import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { keccak256, type Hex } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { AgentCurrentCystPaidFileRestore } from '../src/agents/agent-current-cyst-file-restore.js';
import { Auth } from '../src/auth.js';
import { canonical, Problem, randomId } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import { generateLargeCystId, LargeCystPrivateStore, saveLargeCystFile } from '../src/cysts/large-checkpoints.js';
import { largeCystRegistryDescriptor, largeCystRegistryMatches } from '../src/cysts/large-registry.js';
import { RpcCystRegistryReader } from '../src/cysts/registry-reader.js';
import { cystRegistryPinsSchema } from '../src/cysts/registry-types.js';
import { createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { createHostedHostKit, createDockerHostedHostKit } from '../src/host-kit/hosted.js';
import { hostSessions, openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity } from '../src/host-kit/protocol.js';
import { LocalSessionFixtureBackend, sessionContainerName } from '../src/host-kit/sessions/backends.js';
import { PaidHostSessionAgent } from '../src/host-kit/sessions/paid-agent.js';
import { PaidCystInputSpool } from '../src/host-kit/sessions/cyst-input-spool.js';
import { CYST_INPUT_PATH } from '../src/host-kit/sessions/cyst-input-protocol.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PaidCystInputService } from '../src/platform-runtime/paid-cyst-input.js';
import { createPaidCystInputRoutes } from '../src/platform-runtime/paid-cyst-input-routes.js';
import { createPlatformRuntimeRoutes } from '../src/platform-runtime/routes.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { platformHostSchema } from '../src/platform-runtime/types.js';
import { PlatformVaultBridge } from '../src/platform-runtime/vault.js';
import { PlatformVaultRuntimeClient } from '../src/platform-runtime/vault-client.js';
import { PlatformVaultRuntimeService } from '../src/platform-runtime/vault-service.js';
import { createPlatformVaultRuntimeRoutes } from '../src/platform-runtime/vault-routes.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';
import { captureDeclaredStateBundle } from '../src/sdk/declared-state-bundle.js';
import { DECLARED_STATE_CELL_DIRECTORY } from '../src/cysts/declared-state-protocol.js';
import { generateCystWrappingIdentity, wrapCystRecoveryKey } from '../src/sdk/cyst-key-wrap.js';
import { PaidCystInputClient } from '../src/sdk/paid-cyst-input.js';
import { openStore } from '../src/store.js';
import { executeCommand } from '../src/runtime/command.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

const socket = process.env.TELOMERE_ACCEPTANCE_GVISOR_SOCKET;
const actualImage = process.env.TELOMERE_ACCEPTANCE_GVISOR_IMAGE;
const declaredStateCell = process.env.TELOMERE_ACCEPTANCE_DECLARED_STATE_CELL === '1';
if (Boolean(socket) !== Boolean(actualImage) || socket && (process.platform !== 'linux'
  || !/^\/run\/telomere-[a-z0-9-]+\/docker\.sock$/.test(socket))) throw new Error('Use the explicitly isolated Linux acceptance daemon and image together');
if (declaredStateCell && !socket) throw new Error('Declared-state Cell acceptance requires the actual isolated gVisor profile');
const maxBytes = 8 * 1024 * 1024, image = actualImage ?? 'fixture/session@sha256:' + 'a'.repeat(64);
const imageDigest = platformHostSchema.shape.imageDigest.parse(image.split('@').at(-1));
const node = socket ? '/usr/local/bin/node' : process.execPath;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function stream(value: Uint8Array) { let offset = 0; return new ReadableStream<Uint8Array>({ pull(controller) {
  if (offset === value.length) { controller.close(); return; } const end = Math.min(value.length, offset + 65_536);
  controller.enqueue(value.subarray(offset, end)); offset = end;
} }); }
describe('declared multi-chunk current Cyst into an actual locally paid CPU application', () => {
  let artifacts: Record<string, ContractArtifact>, root: string;
  let local: Awaited<ReturnType<typeof deployPlatformRuntime>>, vault: Awaited<ReturnType<typeof deployPlatformVault>>;
  let database: Awaited<ReturnType<typeof openStore>>, journal: HostJournal;
  let hosted: ReturnType<typeof createHostedHostKit>, paid: PaidHostSessionAgent, spool: PaidCystInputSpool;
  let hostServer: Server, apiServer: Server, privateVault: CystCheckpointFileVault | undefined;
  let restore: AgentCurrentCystPaidFileRestore | undefined;
  let encryptedStore: LargeCystPrivateStore | undefined;
  beforeAll(() => { artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol',
    'MockToken.sol', 'PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol', 'TlmrToken.sol', 'TlmrStaking.sol', 'CystRegistry.sol']);
    artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact(); }, 90_000);
  afterEach(async () => {
    await restore?.dispose().catch(() => undefined); restore = undefined; privateVault?.close(); privateVault = undefined;
    await paid?.close().catch(() => undefined); await hosted?.close().catch(() => undefined); await spool?.close().catch(() => undefined);
    for (const server of [apiServer, hostServer]) if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await journal?.close(); await database?.close(); await local?.close(); await encryptedStore?.close(); encryptedStore = undefined;
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function setup() {
    root = await mkdtemp(join(tmpdir(), 'paid-cyst-file-')); const cells = join(root, 'cells'); await mkdir(cells, { mode: 0o700 });
    spool = await PaidCystInputSpool.open({ directory: join(root, 'host-input'), maxInputBytes: maxBytes,
      globalBytes: maxBytes, maxOperations: 4, minimumFreeBytes: 0 });
    journal = await openHostJournal(':memory:'); const control = new Ed25519Identity();
    const backend = new LocalSessionFixtureBackend(cells, 'test-fixture-only', { cystInputs: spool });
    hosted = socket ? createDockerHostedHostKit({ journal, controlKey: control.publicKey, reviewedImages: new Set([image]),
      isolation: 'gvisor', socketPath: socket, cystInputs: spool }) : createHostedHostKit({ journal, runtime: new LocalProcessFixtureRuntime('test-fixture-only'), backend,
      controlKey: control.publicKey, reviewedImages: new Set([image]), scope: { version: 1, hostKey: journal.identity.publicKey,
        controlKey: control.publicKey, isolation: 'local_process_fixture', runtime: canonical(['fixture-file-runtime', root]),
        sessionBackend: backend.identity }, inventory: async () => [] });
    await hosted.initialize(); paid = new PaidHostSessionAgent(journal, hosted.sessions, control.publicKey); await paid.initialize();
    hostServer = createServer(getRequestListener(createHostKitRoutes(hosted.agent, paid).fetch));
    await new Promise<void>(resolve => hostServer.listen(0, '127.0.0.1', resolve));
    const hostAddress = hostServer.address(); if (!hostAddress || typeof hostAddress === 'string') throw new Error('Missing host port');
    let afterUpload: (() => Promise<void>) | undefined;
    const hostClient = new HostKitClient('http://127.0.0.1:' + hostAddress.port, journal.identity.publicKey, control, !socket,
      async (...args) => {
        const response = await fetch(...args);
        if (response.ok && args[1]?.method === 'PUT' && String(args[0]).includes('/cyst-inputs/') && afterUpload) {
          const action = afterUpload; afterUpload = undefined; await action();
        }
        return response;
      });
    local = await deployPlatformRuntime(journal.identity.publicKey as Hex, artifacts); vault = await deployPlatformVault(local);
    database = await openStore({ DATA_DIR: join(root, 'db') });
    const bridge = new PlatformBridge(database.db, { pins: local.pins, rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
    const vaults = new PlatformVaultBridge(bridge, vault.pins);
    const host = platformHostSchema.parse({ hostId: local.hostId, hostKey: journal.identity.publicKey, hardwareClass: 'cpu',
      region: 'local-test', image, imageDigest, sealed: false, lane: 'standard', sessionEnabled: true, cystInputMaxBytes: maxBytes,
      pricePerSecond: '100', reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    let service: PlatformRuntimeService;
    const receipts = new PlatformReceiptService(database.db, { chainId: 31337, escrowAddress: local.pins.escrowAddress,
      receiptRootAddress: local.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => service.canSeal(hour) });
    const executor = new PlatformHostExecutor(database.db, new Map([[host.hostId, hostClient]]));
    service = new PlatformRuntimeService(database.db, bridge, [host], executor, receipts, vaults, undefined, undefined, { cystInputsEnabled: true });
    const vaultService = new PlatformVaultRuntimeService(service, vaults); await service.initialize();
    const cystArtifact = local.artifact('CystRegistry');
    const deployed = await local.confirmed(local.owner.deployContract({ abi: cystArtifact.abi, bytecode: cystArtifact.bytecode, args: [vault.registryAddress] }));
    if (!deployed.contractAddress) throw new Error('No local CystRegistry');
    const code = await local.local.publicClient.getCode({ address: deployed.contractAddress }); if (!code) throw new Error('No CystRegistry code');
    const pins = cystRegistryPinsSchema.parse({ chainId: 31337, registryAddress: deployed.contractAddress, registryCodeHash: keccak256(code),
      selectionRegistryAddress: vault.registryAddress, selectionRegistryCodeHash: vault.pins.registryCodeHash, confirmations: 0 });
    const reader = new RpcCystRegistryReader({ rpcUrl: local.local.rpcUrl, pins });
    const ingress = new PaidCystInputService({ runtime: service, vaults, executor, registryReader: reader });
    const app = new Hono(); let auth: Auth, origin: string;
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input', detail: error.message },
      error instanceof Problem ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 422 : 503));
    app.use('/api/*', async (context, next) => { if (['POST', 'PUT'].includes(context.req.method) && context.req.header('origin') !== origin) {
      throw new Problem(403, 'origin_mismatch', 'Exact origin required'); } await next(); });
    const principal = (context: Parameters<Parameters<typeof createPaidCystInputRoutes>[1]>[0]) => auth.owner(getCookie(context, 'telomere_session'));
    app.get('/api/me', async context => context.json({ address: await principal(context), demo: false }));
    app.route('/api/platform', createPlatformRuntimeRoutes(service, principal));
    app.route('/api/platform', createPlatformVaultRuntimeRoutes(vaultService, principal));
    app.route('/api/platform', createPaidCystInputRoutes(ingress, principal));
    apiServer = createServer(getRequestListener(app.fetch)); await new Promise<void>(resolve => apiServer.listen(0, '127.0.0.1', resolve));
    const address = apiServer.address(); if (!address || typeof address === 'string') throw new Error('Missing app port');
    origin = 'http://127.0.0.1:' + address.port;
    auth = new Auth(database.db, loadConfig({ DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin, RPC_URL: local.local.rpcUrl,
      SIGNER_PRIVATE_KEY: local.keys.signer, DEMO_PRIVATE_KEY: local.keys.owner, ESCROW_ADDRESS: local.pins.escrowAddress, TOKEN_ADDRESS: local.pins.tokenAddress }));
    const agentToken = await auth.session(vault.account.address), ownerToken = await auth.session(local.accounts.owner.address);
    const sdk = new PlatformVaultRuntimeClient({ baseUrl: origin, pins: local.pins, vaultPins: vault.pins,
      vault: vault.agent.vault, sessionToken: agentToken });
    const binary = new PaidCystInputClient({ baseUrl: origin, vault: vault.agent.vault, sessionToken: agentToken, client: sdk });
    return { bridge, vaultService, service, executor, reader, pins, cystArtifact, registry: deployed.contractAddress,
      sdk, binary, hostClient, origin, ownerToken, agentToken, onHostStaged: (action: () => Promise<void>) => { afterUpload = action; } };
  }
  for (const profile of ['file', 'declared-directory'] as const) {
  it.skipIf(profile === 'declared-directory' && !declaredStateCell)(`restores ${profile} state through encrypted multi-chunk Cyst, real Vault payment and one application command`, async () => {
    const context = await setup(), owner = local.accounts.owner.address, agent = vault.account.address, agentId = vault.agentId as Hex;
    let source = Buffer.alloc(4 * 1024 * 1024 + 257, 0x41); source.write('counter=71\n');
    const sourcePath = join(root, 'source-state.bin');
    if (profile === 'declared-directory') {
      const tree = join(root, 'declared-source'); await mkdir(tree, { mode: 0o700 });
      await mkdir(join(tree, 'nested'), { mode: 0o700 }); await mkdir(join(tree, 'empty'), { mode: 0o700 });
      await writeFile(join(tree, 'counter.json'), '{"counter":71}', { mode: 0o600 });
      await writeFile(join(tree, 'nested', 'memory.txt'), 'persistent agent memory\n', { mode: 0o600 });
      await writeFile(join(tree, 'padding.bin'), source, { mode: 0o600 });
      const captured = await captureDeclaredStateBundle({ sourceDirectory: tree, destinationPath: sourcePath });
      expect(captured.manifest.directories).toEqual(['empty', 'nested']); expect(captured.manifest.files).toHaveLength(3);
      source = await readFile(captured.path); expect(captured.sha256).toBe(hash(source));
    } else await writeFile(sourcePath, source, { mode: 0o600 });
    const largeDirectory = join(root, 'encrypted'); await mkdir(largeDirectory, { mode: 0o700 });
    const large = new LargeCystPrivateStore(largeDirectory, { globalMaxBytes: maxBytes, ownerMaxBytes: maxBytes }); encryptedStore = large; await large.initialize();
    const checkpointId = generateLargeCystId(), recoveryKey = randomBytes(32), masterKey = randomBytes(32);
    const ownerIdentity = await generateCystWrappingIdentity(), agentIdentity = await generateCystWrappingIdentity();
    const scope = { owner, agent, applicationSchema: 'declared-counter-file.v1' };
    const wrapped = await wrapCystRecoveryKey(recoveryKey, { owner, agent, checkpointId },
      { ownerPublicKey: ownerIdentity.publicKey, agentPublicKey: agentIdentity.publicKey });
    const manifest = await saveLargeCystFile({ store: large, sourcePath, id: checkpointId, scope, recoveryKey,
      wrappedKey: { bundle: wrapped, ownerIdentity, agentPublicKey: agentIdentity.publicKey } }); recoveryKey.fill(0);
    const checkpoint = largeCystRegistryDescriptor(manifest);
    await local.confirmed(vault.wallet.writeContract({ address: context.registry, abi: context.cystArtifact.abi, functionName: 'commitChecked',
      args: [agentId, checkpoint.cystHash, BigInt(checkpoint.sizeBytes), checkpoint.storageRef, 0n] }));
    const privateDirectory = join(root, 'journal'); await mkdir(privateDirectory, { mode: 0o700 });
    privateVault = new CystCheckpointFileVault({ directory: privateDirectory, masterKey });
    const store = { resolveCurrent: async () => { await context.reader.check(); const snapshot = await context.reader.snapshot(agentId);
      if (!largeCystRegistryMatches(snapshot.current, checkpoint)) throw new Error('Current Cyst changed');
      return { checkpointId, checkpoint, manifest, binding: snapshot.binding, current: snapshot.current, pins: context.pins }; },
      part: (id: string, index: number) => large.part(id, index) };
    // Local-process fixture explicitly maps the declared path to its trusted test
    // spool directory. Only the separate actual gVisor cohort proves a mount.
    const program = `const fs=require('node:fs'),crypto=require('node:crypto');
const [agentId,targetRunId,checkpointId,revision,operationId,plaintextSha256,inputPath]=process.argv.slice(1);
if(inputPath!==${JSON.stringify(CYST_INPUT_PATH)})throw Error('path');
const source=${socket ? 'inputPath' : JSON.stringify(spool.directory) + "+require('node:path').sep+'run-'+targetRunId.slice(2)+require('node:path').sep+'ready'+require('node:path').sep+'state.bin'"};
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
const receipt=JSON.parse(input),bytes=fs.readFileSync(source);
if(bytes.length!==receipt.plaintextBytes||crypto.createHash('sha256').update(bytes).digest('hex')!==plaintextSha256)throw Error('state');
if(!bytes.subarray(0,11).equals(Buffer.from('counter=71\\n')))throw Error('application state');
${socket ? "if(process.getuid()===0)throw Error('root workload');let denied=false;try{fs.appendFileSync(source,'x')}catch(error){denied=['EROFS','EACCES','EPERM'].includes(error.code)}if(!denied)throw Error('readonly mount');const temp=fs.statfsSync('/tmp');if(temp.blocks*temp.bsize>16777216)throw Error('scratch limit');" : ''}
fs.writeFileSync('restored-counter.json',JSON.stringify({counter:71,sourceBytes:bytes.length}),{flag:'wx',mode:0o600});
fs.appendFileSync('restore-calls.log','1');process.stdout.write(JSON.stringify(receipt));});`;
    const options = { owner, agent, agentId, applicationSchema: scope.applicationSchema, operationId: 'actual-file-restore',
      directory: join(root, 'prepared'), imageDigest, maxCommands: 4,
      restoreArgvPrefix: profile === 'declared-directory' ? [node, '/opt/telomere/declared-state-cell.cjs'] : [node, '-e', program],
      reader: context.reader, store, identity: agentIdentity, client: context.sdk, input: context.binary,
      journal: privateVault, maxBytes, minimumFreeBytes: 0 };
    restore = new AgentCurrentCystPaidFileRestore(options);
    const nonceBefore = await local.local.publicClient.getTransactionCount({ address: agent });
    let preparedFile = await restore.prepare();
    expect(preparedFile.descriptor.plaintextBytes).toBe(source.length);
    expect(preparedFile.descriptor.plaintextSha256).toBe(hash(source));
    expect(await local.local.publicClient.getTransactionCount({ address: agent })).toBe(nonceBefore);
    expect((await context.sdk.config()).capacity[0]?.cystInputMaxBytes).toBe(maxBytes);
    let prepared = await context.sdk.quote({ leashId: vault.agent.leashId, task: preparedFile.task,
      maxSeconds: 60, deadline: await context.bridge.now() + 300, maxSpend: '10000' }, 'large-cyst-paid-quote');
    const opened = await local.confirmed(vault.wallet.sendTransaction({ to: prepared.transaction.to, data: prepared.transaction.data as Hex, value: 0n }));
    await context.sdk.admit({ runId: prepared.quote.runId, transactionHash: opened.transactionHash }, 'large-cyst-paid-admit');
    let running = context.service.drain();
    for (let attempt = 0; attempt < 100; attempt++) { try { await context.executor.events(prepared.quote.runId, -1, 8); break; } catch { await sleep(100); } }
    const evidence = await context.sdk.sessionLease(prepared.quote.runId);
    expect(evidence.lease.body.stdin).toContain(preparedFile.descriptor.plaintextSha256);
    if (socket) {
      const inspected = await executeCommand('docker', ['--host', 'unix://' + socket, 'inspect', '--format',
        '{"runtime":{{json .HostConfig.Runtime}},"memory":{{json .HostConfig.Memory}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"network":{{json .HostConfig.NetworkMode}},"mounts":{{json .Mounts}}}',
        sessionContainerName(journal.identity.publicKey, prepared.quote.runId)], { signal: AbortSignal.timeout(10_000), maxOutputBytes: 8192 });
      expect(inspected.exitCode).toBe(0);
      const state = JSON.parse(inspected.stdout); expect(state).toMatchObject({ runtime: 'runsc', memory: 268435456, readOnly: true, network: 'none' });
      expect(state.mounts).toEqual(expect.arrayContaining([expect.objectContaining({ Destination: '/run/telomere-cyst', RW: false })]));
    }
    let binaryPut = 0;
    const checkedBinary = new PaidCystInputClient({ baseUrl: context.origin, vault: vault.agent.vault, sessionToken: context.agentToken,
      client: context.sdk, fetchImpl: async (...args) => { if (args[1]?.method === 'PUT') binaryPut++; return fetch(...args); } });
    const wrongSource = join(root, 'wrong-file.bin'); await writeFile(wrongSource, Buffer.alloc(source.length, 7), { mode: 0o600 });
    await expect(checkedBinary.uploadFile(prepared.quote.runId, preparedFile.descriptor, wrongSource)).rejects.toThrow('declared digest');
    expect(binaryPut).toBe(0);
    expect(() => new PaidCystInputClient({ baseUrl: 'http://127.0.0.1:1', vault: vault.agent.vault, sessionToken: context.agentToken,
      client: context.sdk })).toThrow('same reviewed origin');
    context.onHostStaged(async () => { await local.confirmed(vault.guardianWallet.writeContract({ address: vault.registryAddress,
      abi: local.artifact('PlatformSelectionRegistry').abi, functionName: 'setFrozen', args: [agentId, true, 'test staged policy change', randomId()] })); });
    await expect(restore.restore(prepared.quote.runId)).rejects.toThrow('Paid file request failed with HTTP');
    const readyDirectory = join(spool.directory, 'run-' + prepared.quote.runId.slice(2), 'ready');
    // The live policy monitor is allowed to have already removed the Cell.
    // Both outcomes prove that no declared plaintext became visible.
    const readyNames = await readdir(readyDirectory).catch(error => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    });
    expect(readyNames).toEqual([]);
    expect((await journal.db.select().from(hostSessions)).find(row => row.sessionId === prepared.quote.runId)?.record?.commands).toHaveLength(0);
    // Keep the guardian freeze in place until the real monitor stops and cleans
    // the negative run. A frozen paid session never becomes runnable again.
    await running;
    const negative = { prepared, run: await context.sdk.get(prepared.quote.runId) };
    expect(negative.run.status).toBe('receipt_pending');
    const negativeRecord = (await journal.db.select().from(hostSessions)).find(row => row.sessionId === prepared.quote.runId)?.record;
    expect(negativeRecord).toMatchObject({ cleanupConfirmed: true, commands: [] });
    expect(await readdir(join(spool.directory, 'run-' + prepared.quote.runId.slice(2)))).not.toContain('ready');
    await restore.dispose();
    await local.confirmed(vault.guardianWallet.writeContract({ address: vault.registryAddress,
      abi: local.artifact('PlatformSelectionRegistry').abi, functionName: 'setFrozen', args: [agentId, false, 'test reviewed resume', randomId()] }));
    const positiveOptions = { ...options, operationId: 'actual-file-success', directory: join(root, 'prepared-success') };
    restore = new AgentCurrentCystPaidFileRestore(positiveOptions);
    preparedFile = await restore.prepare();
    prepared = await context.sdk.quote({ leashId: vault.agent.leashId, task: preparedFile.task,
      maxSeconds: 60, deadline: await context.bridge.now() + 300, maxSpend: '10000' }, 'large-cyst-positive-quote');
    const positiveOpened = await local.confirmed(vault.wallet.sendTransaction({ to: prepared.transaction.to, data: prepared.transaction.data as Hex, value: 0n }));
    await context.sdk.admit({ runId: prepared.quote.runId, transactionHash: positiveOpened.transactionHash }, 'large-cyst-positive-admit');
    running = context.service.drain();
    for (let attempt = 0; attempt < 100; attempt++) { try { await context.executor.events(prepared.quote.runId, -1, 8); break; } catch { await sleep(100); } }
    // A successful HostKit upload whose response is lost leaves the original
    // paid run staged. Its next HTTP PUT must consume and verify duplicate bytes.
    context.onHostStaged(async () => { throw new Error('lost completed HostKit upload response'); });
    await expect(restore.restore(prepared.quote.runId)).rejects.toThrow('Paid file request failed with HTTP');
    const incoming = join(spool.directory, 'run-' + prepared.quote.runId.slice(2), 'incoming.bin');
    const staged = await lstat(incoming, { bigint: true });
    expect((await context.binary.status(prepared.quote.runId, preparedFile.descriptor)).body.state).toBe('staged');
    let raced = false;
    const readyRace = new PaidCystInputClient({ baseUrl: context.origin, vault: vault.agent.vault, sessionToken: context.agentToken, client: context.sdk,
      fetchImpl: async (...args) => {
        const response = await fetch(...args);
        if (!raced && args[1]?.method === 'GET' && String(args[0]).endsWith('/inputs/' + preparedFile.descriptor.operationId)) {
          const status = await response.clone().json() as { body?: { state?: string } };
          if (status.body?.state === 'staged') {
            raced = true; await context.binary.uploadFile(prepared.quote.runId, preparedFile.descriptor, join(root, 'prepared-success', 'state.bin'));
          }
        }
        return response;
      } });
    expect((await readyRace.uploadFile(prepared.quote.runId, preparedFile.descriptor, join(root, 'prepared-success', 'state.bin'))).body.committed).toBe(true);
    expect(raced).toBe(true);
    const publishedPath = join(spool.directory, 'run-' + prepared.quote.runId.slice(2), 'ready', 'state.bin');
    const published = await lstat(publishedPath, { bigint: true });
    expect([published.ino, published.size, published.mtimeNs]).toEqual([staged.ino, staged.size, staged.mtimeNs]);
    const positiveLease = await context.sdk.sessionLease(prepared.quote.runId);
    expect((await context.hostClient.cystInputUpload(positiveLease.lease, stream(source), new AbortController().signal)).body.committed).toBe(true);
    const wrongDuplicate = await fetch(context.origin + '/api/platform/vaults/' + vault.agent.vault + '/runs/' + prepared.quote.runId + '/inputs/' + preparedFile.descriptor.operationId,
      { method: 'PUT', headers: { Cookie: 'telomere_session=' + context.agentToken, Origin: context.origin,
        'Content-Type': 'application/octet-stream', 'Content-Length': String(source.length), 'Idempotency-Key': preparedFile.descriptor.operationId },
      body: Buffer.alloc(source.length, 5) });
    expect(wrongDuplicate.status).toBe(422); await wrongDuplicate.arrayBuffer();
    expect((await readFile(publishedPath)).equals(source)).toBe(true);
    let lose = true;
    const lossy = new PlatformVaultRuntimeClient({ baseUrl: context.origin, pins: local.pins, vaultPins: vault.pins,
      vault: vault.agent.vault, sessionToken: context.agentToken, fetch: async (url, init) => {
        const response = await fetch(url, init); if (lose && init?.method === 'POST' && String(url).endsWith('/commands')) {
          lose = false; await response.arrayBuffer(); throw new Error('lost applied-file response'); } return response; } });
    restore = new AgentCurrentCystPaidFileRestore({ ...positiveOptions, client: lossy });
    await expect(restore.restore(prepared.quote.runId)).rejects.toThrow('lost applied-file response');
    privateVault.close(); privateVault = new CystCheckpointFileVault({ directory: privateDirectory, masterKey }); masterKey.fill(0);
    restore = new AgentCurrentCystPaidFileRestore({ ...positiveOptions, journal: privateVault });
    expect((await restore.restore(prepared.quote.runId)).plaintextSha256).toBe(hash(source));
    expect(lose).toBe(false);
    const hostRecord = (await journal.db.select().from(hostSessions)).find(row => row.sessionId === prepared.quote.runId)?.record;
    expect(hostRecord?.commands).toHaveLength(1);
    expect(Buffer.byteLength(hostRecord?.commands[0]?.command.stdin ?? '')).toBeLessThan(1024);
    const verifyProgram = profile === 'declared-directory'
      ? `const fs=require('node:fs'),path=require('node:path'),root=${JSON.stringify(DECLARED_STATE_CELL_DIRECTORY + '/actual-file-success')};
const state=JSON.parse(fs.readFileSync(path.join(root,'counter.json'),'utf8'));
if(state.counter!==71||fs.readFileSync(path.join(root,'nested/memory.txt'),'utf8')!=='persistent agent memory\\n'||!fs.statSync(path.join(root,'empty')).isDirectory())throw Error('declared directory state');
if(fs.statSync(path.join(root,'padding.bin')).size!==4194561)throw Error('declared payload size');
if(process.getuid()===0)throw Error('root workload');
state.counter++;fs.writeFileSync(path.join(root,'counter.json'),JSON.stringify(state));
fs.appendFileSync(path.join(root,'nested/memory.txt'),'resumed');
process.stdout.write(JSON.stringify({counter:state.counter,sourceBytes:${source.length}}));`
      : "const fs=require('node:fs'),state=JSON.parse(fs.readFileSync('restored-counter.json','utf8'));if(state.counter!==71||fs.readFileSync('restore-calls.log','utf8')!=='1')throw Error('restore replay');state.counter++;fs.writeFileSync('restored-counter.json',JSON.stringify(state));process.stdout.write(JSON.stringify(state));";
    const appState = await context.sdk.command(prepared.quote.runId, { commandId: 'verify-restored-counter', argv: [node, '-e', verifyProgram] });
    expect(JSON.parse(appState.stdout)).toEqual({ counter: 72, sourceBytes: source.length });
    expect(await readdir(join(spool.directory, 'run-' + prepared.quote.runId.slice(2), 'ready'))).toEqual(['state.bin']);
    await sleep(11_000);
    await local.confirmed(local.owner.sendTransaction({ ...(await context.vaultService.stopPlan(owner, vault.agent.vault, prepared.quote.runId)), value: 0n }));
    await running;
    const pending = await context.sdk.get(prepared.quote.runId); expect(pending.status).toBe('receipt_pending');
    expect(pending.settlement?.billableSeconds).toBeGreaterThan(0);
    expect(await readdir(join(spool.directory, 'run-' + prepared.quote.runId.slice(2)))).not.toContain('ready');
    expect((await readFile(join(root, 'prepared-success', 'state.bin'))).equals(source)).toBe(true);
    const hourClosed = BigInt((Math.floor(pending.settlement!.endedAt / 3600) + 1) * 3600);
    await local.test.setNextBlockTimestamp({ timestamp: hourClosed }); await local.test.mine({ blocks: 1 }); await context.service.drain();
    const final = await context.sdk.get(prepared.quote.runId), base = BigInt(final.settlement!.billableSeconds) * 100n;
    expect(final.status).toBe('completed'); expect(final.charged).toBe((base + (base * 900n + 9999n) / 10000n).toString());
    expect(BigInt(final.charged!) + BigInt(final.refund!)).toBe(BigInt(prepared.ceiling));
    const negativeFinal = await context.sdk.get(negative.prepared.quote.runId);
    expect(negativeFinal.status).toBe('completed');
    expect(BigInt(negativeFinal.charged!) + BigInt(negativeFinal.refund!)).toBe(BigInt(negative.prepared.ceiling));
    await restore.dispose();
    expect(await readdir(join(root, 'prepared-success'))).toEqual(['.operation']);
    const replay = await restore.restore(prepared.quote.runId); expect(replay.plaintextSha256).toBe(hash(source));
    expect((await journal.db.select().from(hostSessions)).find(row => row.sessionId === prepared.quote.runId)?.record?.commands).toHaveLength(2);
    if (socket) {
      const owned = await executeCommand('docker', ['--host', 'unix://' + socket, 'ps', '--all', '--filter', 'label=telomere.host_key=' + journal.identity.publicKey,
        '--format', '{{.ID}}'], { signal: AbortSignal.timeout(10_000), maxOutputBytes: 8192 });
      expect(owned.exitCode).toBe(0); expect(owned.stdout.trim()).toBe('');
    }
  }, 150_000);
  }
});
