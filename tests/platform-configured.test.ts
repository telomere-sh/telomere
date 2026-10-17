import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex } from 'viem';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';
import { configuredPlatformRuntime } from '../src/platform-runtime/configured.js';
import { Ed25519Identity } from '../src/host-kit/protocol.js';
import { baseSepoliaUsdc } from '../src/chain/chains.js';

// Configuration boundary tests only. No RPC calls and no claim these fixture pins are deployed contracts.
describe('reviewed platform configuration and private file boundaries', () => {
  let directory: string, configFile: string, signerFile: string, controlFile: string;
  let store: Awaited<ReturnType<typeof openStore>>;
  const legacyKey = generatePrivateKey(), dedicatedKey = generatePrivateKey(), ownerKey = generatePrivateKey();
  const legacySigner = privateKeyToAccount(legacyKey).address, dedicatedSigner = privateKeyToAccount(dedicatedKey).address;
  const key = keccak256(toHex('configured-host')), hostId = keccak256(toHex('configured-host-id'));
  const image = `example/cpu@sha256:${'1'.repeat(64)}`;
  const environment = () => ({ MODE: 'demo', DATA_DIR: ':memory:', RPC_URL: 'http://127.0.0.1:1',
    ESCROW_ADDRESS: '0x1111111111111111111111111111111111111111', TOKEN_ADDRESS: '0x2222222222222222222222222222222222222222',
    SIGNER_PRIVATE_KEY: legacyKey, DEMO_PRIVATE_KEY: ownerKey, PLATFORM_RUNTIME_CONFIG: configFile });
  const reviewed = () => ({ pins: { chainId: 31337, escrowAddress: '0x3333333333333333333333333333333333333333',
    tokenAddress: '0x2222222222222222222222222222222222222222', tokenCodeHash: key,
    reviewedTokenKind: 'immutable' as const, quoteSigner: dedicatedSigner,
    receiptRootAddress: '0x4444444444444444444444444444444444444444', hostRegistryAddress: '0x5555555555555555555555555555555555555555',
    feeRouterAddress: '0x6666666666666666666666666666666666666666', escrowCodeHash: key, receiptRootCodeHash: key, hostRegistryCodeHash: key, feeRouterCodeHash: key },
    signerKeyFile: signerFile, hosts: [{ hostId, hostKey: key, hardwareClass: 'cpu', region: 'fixture',
      image, imageDigest: `sha256:${'1'.repeat(64)}`, sealed: false, lane: 'standard', pricePerSecond: '100', reliabilityBps: 10000,
      strikes: 0, stake: '300000000', availableAt: 0, url: 'https://host.example', controlPemFile: controlFile }] });
  async function save(value: unknown = reviewed()) { await writeFile(configFile, JSON.stringify(value), { mode: 0o600 }); }
  const configure = () => configuredPlatformRuntime(store.db, loadConfig(environment()), legacySigner);
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'platform-private-config-'));
    configFile = join(directory, 'reviewed.json'); signerFile = join(directory, 'dedicated.key'); controlFile = join(directory, 'control.pem');
    await writeFile(signerFile, dedicatedKey + '\n', { mode: 0o600 });
    await writeFile(controlFile, new Ed25519Identity().exportPrivatePem(), { mode: 0o600 }); await save();
    store = await openStore({ DATA_DIR: ':memory:' });
  });
  afterEach(async () => {
    await store.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('platform-private-config-')) throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  it('loads actual private files with a dedicated signer and strips endpoint/key paths from runtime capacity', async () => {
    const value = await configure(); expect(value?.bridge.account.address).toBe(dedicatedSigner);
    expect(value?.hosts).toHaveLength(1); expect(value?.hosts[0]).not.toHaveProperty('url'); expect(value?.hosts[0]).not.toHaveProperty('controlPemFile');
  });
  it('does not read configuration or contact RPC when the runtime is disabled', async () => {
    const { PLATFORM_RUNTIME_CONFIG: _path, ...environmentWithoutPlatform } = environment();
    expect(await configuredPlatformRuntime(store.db, loadConfig(environmentWithoutPlatform), legacySigner)).toBeUndefined();
  });
  it('constructs the opt-in v2 issuer from two reviewed destinations without writing stores or exposing credentials', async () => {
    const firstCredentials = join(directory, 'evidence-first.json'), secondCredentials = join(directory, 'evidence-second.json');
    const credentials = { accessKeyId: 'FIXTURE_ACCESS_ID', secretAccessKey: 'fixture-secret-value-123456789' };
    await writeFile(firstCredentials, JSON.stringify(credentials), { mode: 0o600 });
    await writeFile(secondCredentials, JSON.stringify(credentials), { mode: 0o600 });
    const receiptV2 = { enabled: true, minConfirmations: 1, stores: [
      { identity: 'evidence-first', failureDomain: 'provider-first', endpoint: 'https://first.example',
        bucket: 'evidence-first', region: 'us-east-1', credentialsFile: firstCredentials },
      { identity: 'evidence-second', failureDomain: 'provider-second', endpoint: 'https://second.example',
        bucket: 'evidence-second', region: 'us-west-1', credentialsFile: secondCredentials },
    ] };
    await writeFile(configFile, JSON.stringify({ ...reviewed(), receiptV2 }), { mode: 0o600 });
    const configured = await configure();
    expect(configured?.v2Receipts?.publisher.enabled).toBe(true);
    expect(configured?.v2Receipts?.publishedEvidence).toBe(configured?.v2Receipts?.publisher);
    expect(JSON.stringify(configured?.hosts)).not.toContain('credential');
    for (const changed of [
      { ...receiptV2, stores: [receiptV2.stores[0], { ...receiptV2.stores[1], identity: 'evidence-first' }] },
      { ...receiptV2, stores: [receiptV2.stores[0], { ...receiptV2.stores[1], failureDomain: 'provider-first' }] },
      { ...receiptV2, stores: [receiptV2.stores[0], { ...receiptV2.stores[1], endpoint: 'https://first.example', bucket: 'evidence-first' }] },
    ]) {
      await writeFile(configFile, JSON.stringify({ ...reviewed(), receiptV2: changed }), { mode: 0o600 });
      await expect(configure()).rejects.toThrow('distinct reviewed storage');
    }
    await writeFile(configFile, JSON.stringify({ ...reviewed(),
      hosts: [{ ...reviewed().hosts[0], sessionEnabled: true }], receiptV2 }), { mode: 0o600 });
    await expect(configure()).rejects.toThrow('one-shot CPU');
    await writeFile(configFile, JSON.stringify({ ...reviewed(), receiptV2 }), { mode: 0o600 });
    await link(firstCredentials, join(directory, 'credentials-hardlink'));
    await expect(configure()).rejects.toThrow('private regular file');
  });
  it('rejects reuse of either the legacy escrow or legacy signer', async () => {
    const escrow = reviewed(); escrow.pins.escrowAddress = environment().ESCROW_ADDRESS; await save(escrow);
    await expect(configure()).rejects.toThrow('dedicated signer');
    const signer = reviewed(); signer.pins.quoteSigner = legacySigner; await save(signer);
    await expect(configure()).rejects.toThrow('dedicated signer');
  });
  it('rejects a different configured chain and a key that differs from the reviewed signer', async () => {
    const wrongChain = reviewed(); wrongChain.pins.chainId = 84532; wrongChain.pins.tokenAddress = baseSepoliaUsdc;
    Reflect.set(wrongChain.pins, 'reviewedTokenKind', 'circle_proxy');
    Reflect.set(wrongChain.pins, 'assetImplementation', { address: wrongChain.pins.hostRegistryAddress, codeHash: key });
    await save(wrongChain);
    await expect(configure()).rejects.toThrow('configured chain');
    await save(); await writeFile(signerFile, legacyKey, { mode: 0o600 });
    await expect(configure()).rejects.toThrow('quote signer differs');
  });
  it('rejects duplicate configured hosts and collision with the legacy independently scheduled host', async () => {
    const duplicate = reviewed(); duplicate.hosts.push({ ...duplicate.hosts[0]! }); await save(duplicate);
    await expect(configure()).rejects.toThrow('hosts must be distinct');
    await save();
    const config = loadConfig({ ...environment(), CPU_MODE: 'hostkit', CPU_IMAGE: image,
      HOST_KIT_URL: 'https://host.example', HOST_KIT_HOST_KEY: key, HOST_KIT_CONTROL_PEM: controlFile });
    await expect(configuredPlatformRuntime(store.db, config, legacySigner)).rejects.toThrow('cannot share');
  });
  for (const kind of ['configuration', 'signer', 'control'] as const) it(`rejects hardlinked ${kind} files`, async () => {
    const target = kind === 'configuration' ? configFile : kind === 'signer' ? signerFile : controlFile;
    await link(target, join(directory, 'extra-link'));
    await expect(configure()).rejects.toThrow('private regular file');
  });
  for (const kind of ['configuration', 'signer', 'control'] as const) it(`enforces bounded ${kind} file bytes`, async () => {
    const target = kind === 'configuration' ? configFile : kind === 'signer' ? signerFile : controlFile;
    await writeFile(target, 'x'.repeat(kind === 'configuration' ? 65_537 : kind === 'signer' ? 81 : 1025), { mode: 0o600 });
    await expect(configure()).rejects.toThrow('private regular file');
  });
  it('rejects a directory used as a private configuration file', async () => {
    const directoryConfig = join(directory, 'directory-config'); await mkdir(directoryConfig);
    await expect(configuredPlatformRuntime(store.db, loadConfig({ ...environment(), PLATFORM_RUNTIME_CONFIG: directoryConfig }), legacySigner)).rejects.toThrow('private regular file');
  });
  it.runIf(process.platform !== 'win32')('rejects POSIX symlinked key files and group-readable private files', async () => {
    const keyLink = join(directory, 'key-link'); await symlink(signerFile, keyLink);
    await save({ ...reviewed(), signerKeyFile: keyLink }); await expect(configure()).rejects.toThrow('private regular file');
    await save(); await chmod(controlFile, 0o640); await expect(configure()).rejects.toThrow('private regular file');
  });
});
