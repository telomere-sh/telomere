import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../store.js';
import { addressSchema, bytes32Schema, sameAddress } from '../common.js';
import { Ed25519Identity } from '../host-kit/protocol.js';
import { HostKitClient } from '../host-kit/client.js';
import { PlatformBridge } from './bridge.js';
import { PlatformHostExecutor } from './host-executor.js';
import { platformHostSchema, platformPinsSchema } from './types.js';
import { baseUsdcForChainId } from '../chain/chains.js';
import { PlatformVaultBridge, platformVaultConfigSchema } from './vault.js';
import { PlatformV2AdmissionJournal } from '../receipts/platform-v2-admission.js';
import { PlatformV2EvidenceJournal } from '../receipts/platform-v2-journal.js';
import { PlatformV2EvidencePublisher, PlatformV2PublicationJournal } from '../receipts/platform-v2-publication.js';
import { PlatformV2ReceiptIssuer } from '../receipts/platform-v2-issuer.js';
import { PlatformV2S3EvidenceStore, platformV2S3StoreConfigSchema } from '../receipts/platform-v2-s3.js';

const configuredSchema = z.object({ pins: platformPinsSchema, signerKeyFile: z.string().min(1), vaults: platformVaultConfigSchema.optional(),
  nearInference: z.literal(true).optional(),
  receiptV2: z.object({ enabled: z.literal(true), minConfirmations: z.number().int().min(1).max(128).default(12),
    stores: z.tuple([platformV2S3StoreConfigSchema, platformV2S3StoreConfigSchema]) }).strict().optional(),
  hosts: z.array(platformHostSchema.extend({ url: z.string().url(), controlPemFile: z.string().min(1) }).strict()).min(1).max(16) }).strict();
const credentialsSchema = z.object({ accessKeyId: z.string().min(1).max(256), secretAccessKey: z.string().min(1).max(4096),
  sessionToken: z.string().min(1).max(8192).optional() }).strict();
async function privateText(path: string, maximum: number): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum
    || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Platform private configuration is not a bounded private regular file');
  return readFile(path, 'utf8');
}
/** Only operator-reviewed endpoints and dedicated local key files are accepted. */
export async function configuredPlatformRuntime(db: Database, config: Config, legacySigner: string) {
  if (!config.PLATFORM_RUNTIME_CONFIG) return undefined;
  const reviewed = configuredSchema.parse(JSON.parse(await privateText(config.PLATFORM_RUNTIME_CONFIG, 65_536)));
  if (reviewed.pins.spendPermissionProfile && (reviewed.vaults || reviewed.receiptV2 || reviewed.nearInference)) {
    throw new Error('Spend permission domain3 requires an EOA-only CPU receipt-v1 profile');
  }
  if (reviewed.pins.x402CpuProfile && (reviewed.vaults || reviewed.receiptV2 || reviewed.nearInference)) {
    throw new Error('X402 CPU domain4 requires an EOA-only one-shot CPU receipt-v1 profile');
  }
  if (reviewed.pins.chainId !== config.CHAIN_ID || sameAddress(reviewed.pins.escrowAddress, config.ESCROW_ADDRESS)
    || sameAddress(reviewed.pins.quoteSigner, addressSchema.parse(legacySigner))) {
    throw new Error('Platform runtime requires its own reviewed escrow and dedicated signer on the configured chain');
  }
  if (config.MODE !== 'demo' && reviewed.pins.tokenAddress.toLowerCase() !== baseUsdcForChainId(config.CHAIN_ID)?.toLowerCase()) throw new Error('Platform Base requires canonical Circle USDC');
  const signerPrivateKey = bytes32Schema.parse((await privateText(reviewed.signerKeyFile, 80)).trim());
  const clients = new Map<string, HostKitClient>();
  for (const host of reviewed.hosts) {
    if (clients.has(host.hostId) || config.CPU_MODE === 'hostkit' && host.hostKey === config.HOST_KIT_HOST_KEY) {
      throw new Error('Platform hosts must be distinct and cannot share an independently scheduled legacy Host Kit');
    }
    const identity = new Ed25519Identity(await privateText(host.controlPemFile, 1024));
    clients.set(host.hostId, new HostKitClient(host.url, host.hostKey, identity));
  }
  const bridge = new PlatformBridge(db, { pins: reviewed.pins, rpcUrl: config.RPC_URL, signerPrivateKey });
  const hosts = reviewed.hosts.map(({ url: _url, controlPemFile: _file, ...host }) => host);
  const vaults = reviewed.vaults ? new PlatformVaultBridge(bridge, reviewed.vaults) : undefined;
  await vaults?.check();
  let admission: PlatformV2AdmissionJournal | undefined;
  let v2Receipts: PlatformV2ReceiptIssuer | undefined;
  if (reviewed.receiptV2) {
    const [first, second] = reviewed.receiptV2.stores;
    if (hosts.some(host => host.sessionEnabled === true) || first.identity === second.identity
      || first.failureDomain === second.failureDomain
      || new URL(first.endpoint).origin === new URL(second.endpoint).origin
        && first.bucket === second.bucket) {
      throw new Error('Platform v2 requires exclusive one-shot CPU hosts and two distinct reviewed storage destinations');
    }
    if (config.MODE !== 'demo' && reviewed.receiptV2.minConfirmations < 12) {
      throw new Error('Public Platform v2 requires at least twelve canonical confirmations');
    }
    const createStore = async (destination: z.infer<typeof platformV2S3StoreConfigSchema>) => {
      const { credentialsFile, ...publicDestination } = destination;
      const raw = credentialsSchema.parse(JSON.parse(await privateText(credentialsFile, 16_384)));
      const credentials = { accessKeyId: raw.accessKeyId, secretAccessKey: raw.secretAccessKey,
        ...(raw.sessionToken === undefined ? {} : { sessionToken: raw.sessionToken }) };
      return new PlatformV2S3EvidenceStore({ ...publicDestination, credentials, reviewed: true });
    };
    const stores = [await createStore(first), await createStore(second)] as const;
    const scope = { chainId: bridge.pins.chainId, escrow: bridge.pins.escrowAddress,
      hostRegistry: bridge.pins.hostRegistryAddress };
    admission = new PlatformV2AdmissionJournal(db, bridge, true);
    const evidence = new PlatformV2EvidenceJournal(db, scope.chainId, scope.escrow, scope.hostRegistry);
    const publication = new PlatformV2PublicationJournal(db, scope);
    const publisher = new PlatformV2EvidencePublisher(publication, stores, { enabled: true });
    v2Receipts = new PlatformV2ReceiptIssuer(db, bridge, admission, evidence, publisher, reviewed.receiptV2.minConfirmations);
  }
  return { bridge, hosts, executor: new PlatformHostExecutor(db, clients, admission), vaults, v2Receipts,
    nearInference: reviewed.nearInference === true };
}
