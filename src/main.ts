import { serve } from '@hono/node-server';
import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, type Config } from './config.js';
import { chainForId } from './chain/chains.js';
import { bindControllerChain } from './chain/controller-binding.js';
import { openStore } from './store.js';
import { ChainBridge } from './bridge.js';
import { Auth } from './auth.js';
import { Service } from './service.js';
import { Worker } from './worker.js';
import { createApp } from './app.js';
import { loadWebsite } from './website.js';
import { createDemoCpuExecutor, createDockerCpuExecutor } from './runtime/index.js';
import { configuredNearProvider } from './providers/configured.js';
import { createOperations } from './operations.js';
import { getNearProviderReadiness } from './providers/index.js';
import { configuredCysts } from './cysts/configured.js';
import { readCystQuotaPolicy } from './cysts/quota.js';
import { configuredLargeCysts, type ConfiguredLargeCystStore } from './cysts/large-configured.js';
import { LargeCystQuotaShadowStore } from './cysts/large-quota-shadow.js';
import { RpcCystRegistryReader } from './cysts/registry-reader.js';
import { LargeCystPublicationService } from './cysts/large-publication-service.js';
import { configuredCystRegistry } from './cysts/registry-configured.js';
import type { CystRegistryService } from './cysts/registry-service.js';
import { createControllerPlatform, type ControllerPlatform } from './platform.js';
import { configuredHostKit } from './host-kit/configured.js';
import { createTelomereMcpHttp } from './mcp/http.js';
import { TelomereClient } from './sdk/client.js';
import { eq, sql } from 'drizzle-orm';
import { controllerHostRuns } from './host-kit/controller-schema.js';
import { configuredPlatformRuntime } from './platform-runtime/configured.js';
import { PlatformRuntimeService } from './platform-runtime/service.js';
import { platformHostLeases, platformRuns } from './platform-runtime/schema.js';
import { PlatformReceiptService } from './receipts/platform-service.js';
import { PlatformVaultRuntimeService } from './platform-runtime/vault-service.js';
import { PlatformRuntimeClient } from './platform-runtime/client.js';
import { PlatformVaultRuntimeClient } from './platform-runtime/vault-client.js';
import { createPlatformMcpServer } from './mcp/platform.js';
import { configuredIncomeEndpoints } from './selection/income-endpoints/configured.js';
import type { IncomeEndpointService } from './selection/income-endpoints/service.js';
import { configuredVaultIncome, type ConfiguredVaultIncome } from './payments/vault-income-configured.js';
import { configuredTreasuryTopUps } from './treasury/configured.js';
import { retainedFinancialSigners } from './treasury/signer-isolation.js';
import type { TreasuryTopUpService } from './treasury/service.js';
import { PaidCystInputService } from './platform-runtime/paid-cyst-input.js';
import { configuredSelectionReputationPublisher } from './selection/reputation-publisher-configured.js';
import type { SelectionReputationPublisher } from './selection/reputation-publisher.js';
import { configuredAkashReadiness, type AkashControllerReadiness } from './suppliers/controller-readiness.js';

export async function startPilot(config: Config) {
  const logger = pino({ level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.cookie', 'privateKey', 'apiKey', 'raw'] });
  const website = await loadWebsite('./dist/website');
  const bridge = new ChainBridge(config); await bridge.check();
  const near = configuredNearProvider(config);
  const store = await openStore(config);
  const prepareExecutors = async () => {
    try {
      await bindControllerChain(store.db, config, bridge.account.address);
      await bridge.verifyJournalArchive(store.db);
      const quotaPolicy = config.CYSTS_QUOTA_POLICY_PATH && config.CYSTS_QUOTA_POLICY_SHA256
        ? await readCystQuotaPolicy(config.CYSTS_QUOTA_POLICY_PATH, config.CYSTS_QUOTA_POLICY_SHA256) : undefined;
      return { cpu: config.CPU_MODE === 'hostkit' ? await configuredHostKit(store.db, config)
        : config.CPU_MODE === 'docker' ? createDockerCpuExecutor({ image: config.CPU_IMAGE }) : createDemoCpuExecutor(),
      cysts: await configuredCysts(store.db, config, quotaPolicy ? { quotaPolicy } : {}),
      fullPlatform: await configuredPlatformRuntime(store.db, config, bridge.account.address) };
    } catch (error) { await store.close(); throw error; }
  };
  const { cpu, cysts, fullPlatform } = await prepareExecutors();
  const auth = new Auth(store.db, config);
  const nearReadiness = () => getNearProviderReadiness(near);
  const service = new Service(store.db, bridge, config, !!near, nearReadiness);
  const worker = new Worker(store.db, bridge, cpu, near, logger);
  let platform: ControllerPlatform;
  let platformRuntime: PlatformRuntimeService | undefined;
  let cystRegistry: CystRegistryService | undefined;
  let incomeEndpoints: IncomeEndpointService | undefined;
  let vaultIncome: ConfiguredVaultIncome | undefined;
  let reputationPublisher: SelectionReputationPublisher | undefined;
  let largeCysts: ConfiguredLargeCystStore | undefined;
  let largePublication: LargeCystPublicationService | undefined;
  let akashReadiness: AkashControllerReadiness | undefined;
  let treasuryTopUps: TreasuryTopUpService | undefined;
  let paidCystInputs: PaidCystInputService | undefined;
  try {
  if (fullPlatform) {
    if (fullPlatform.nearInference && (!near || config.NEAR_VERIFICATION_MODE !== 'enclave_verified'
      || !config.NEAR_MODEL || !config.NEAR_ATTESTATION_POLICY_SHA256)) {
      throw new Error('Platform NEAR inference requires the reviewed verified provider configuration');
    }
    const platformNear = fullPlatform.nearInference && near && config.NEAR_MODEL && config.NEAR_ATTESTATION_POLICY_SHA256
      ? { provider: near, config: { model: config.NEAR_MODEL, maxTokens: config.MAX_TOKENS,
        policySha256: config.NEAR_ATTESTATION_POLICY_SHA256, inferencePrice: config.INFERENCE_FIXED_PRICE },
        billingOperator: fullPlatform.bridge.account.address, maxProviderSeconds: 30 } : undefined;
    const receipts = new PlatformReceiptService(store.db, { chainId: fullPlatform.bridge.pins.chainId,
      escrowAddress: fullPlatform.bridge.pins.escrowAddress, receiptRootAddress: fullPlatform.bridge.pins.receiptRootAddress,
      publicClient: fullPlatform.bridge.public, submitTransaction: (key, to, data) => fullPlatform.bridge.transactions.submit(key, to, data),
      canSeal: hour => platformRuntime?.canSeal(hour) ?? Promise.resolve(false) });
    platformRuntime = new PlatformRuntimeService(store.db, fullPlatform.bridge, fullPlatform.hosts, fullPlatform.executor,
      receipts, fullPlatform.vaults, platformNear, fullPlatform.v2Receipts, { cystInputsEnabled: config.PAID_CYST_INPUTS_ENABLED });
  }
    platform = createControllerPlatform(service, cysts, platformRuntime);
    await platform.initialize();
    if (config.REPUTATION_PUBLISHER_CONFIG) {
      if (!platform.selection || !platform.selectionReputation) throw new Error('Reputation publisher requires canonical Selection indexing');
      reputationPublisher = await configuredSelectionReputationPublisher(store.db, platform.selectionReputation, platform.selection, {
        configurationFile: config.REPUTATION_PUBLISHER_CONFIG, rpcUrl: config.RPC_URL, chainId: config.CHAIN_ID,
        mode: config.MODE, financialSigners: [bridge.account.address,
          ...(fullPlatform ? [fullPlatform.bridge.account.address] : []),
          ...(config.DEMO_PRIVATE_KEY ? [privateKeyToAccount(config.DEMO_PRIVATE_KEY).address] : [])],
      });
      if (!reputationPublisher) throw new Error('Reputation publisher configuration is unavailable');
      platform.attachReputationPublisher(reputationPublisher);
    }
    await cysts?.initialize();
    largeCysts = await configuredLargeCysts(config);
    if (largeCysts?.readOnly) logger.warn('large_cysts_read_only_remote_unavailable');
    cystRegistry = await configuredCystRegistry(cysts, config);
    if (config.PAID_CYST_INPUTS_ENABLED) {
      if (!platformRuntime?.vaults || !fullPlatform || !cystRegistry
        || !fullPlatform.hosts.some(host => host.hardwareClass === 'cpu' && host.sessionEnabled === true
          && !host.sealed && host.cystInputMaxBytes !== undefined)) {
        throw new Error('Paid Cyst input requires the reviewed Vault runtime, canonical registry and a declared file-capable CPU host');
      }
      paidCystInputs = new PaidCystInputService({ runtime: platformRuntime, vaults: platformRuntime.vaults,
        executor: fullPlatform.executor, registryReader: new RpcCystRegistryReader({ pins: cystRegistry.pins, rpcUrl: config.RPC_URL }) });
    }
    if (largeCysts instanceof LargeCystQuotaShadowStore && !largeCysts.readOnly && cystRegistry) {
      largePublication = new LargeCystPublicationService(store.db, largeCysts,
        new RpcCystRegistryReader({ pins: cystRegistry.pins, rpcUrl: config.RPC_URL }));
      await largePublication.initialize();
    }
    incomeEndpoints = await configuredIncomeEndpoints(config, store.db);
    akashReadiness = await configuredAkashReadiness(config, service);
    vaultIncome = await configuredVaultIncome(config, store.db, [
      ...(fullPlatform ? [fullPlatform.bridge.account.address] : []),
      ...(reputationPublisher ? [reputationPublisher.profile.publisherAddress] : []),
    ]);
    treasuryTopUps = await configuredTreasuryTopUps(config, [bridge.account.address,
      ...(fullPlatform ? [fullPlatform.bridge.account.address] : []),
      ...(reputationPublisher ? [reputationPublisher.profile.publisherAddress] : []),
      ...(vaultIncome ? [vaultIncome.profile.pins.facilitator] : []),
      ...(config.DEMO_PRIVATE_KEY ? [privateKeyToAccount(config.DEMO_PRIVATE_KEY).address] : []),
      ...(config.TREASURY_TOPUP_CONFIG ? await retainedFinancialSigners(store.db, config.CHAIN_ID) : []),
    ]);
    if ('cleanupOrphans' in cpu) await cpu.cleanupOrphans();
    else if ((await store.db.select({ runId: controllerHostRuns.runId }).from(controllerHostRuns)
      .where(eq(controllerHostRuns.cleanupConfirmed, false)).limit(1)).length) {
      throw new Error('Unconfirmed Host Kit leases require their original configured host before recovery');
    }
    await worker.recover(true);
    if (platformRuntime) await platformRuntime.initialize();
    else if ((await store.db.select({ runId: platformHostLeases.runId }).from(platformHostLeases)
      .where(eq(platformHostLeases.cleanupConfirmed, 0)).limit(1)).length) {
      throw new Error('Unconfirmed platform leases require their original reviewed platform configuration');
    }
    if (!platformRuntime && (await store.db.select({ id: platformRuns.id }).from(platformRuns)
      .where(sql`${platformRuns.vaultBinding} IS NOT NULL AND (${platformRuns.status} NOT IN ('completed','refunded') OR ${platformRuns.vaultSyncTx} IS NULL)`)
      .limit(1)).length) throw new Error('Unresolved Vault runs require their original reviewed platform configuration');
  } catch (error) { await Promise.allSettled([largePublication?.close(), largeCysts?.close(), store.close()]); throw error; }
  const createMcpClient = (sessionToken: string) => new TelomereClient({ baseUrl: config.PUBLIC_ORIGIN, sessionToken,
    pins: { chainId: chainForId(config.CHAIN_ID).id, escrowAddress: config.ESCROW_ADDRESS,
      tokenAddress: config.TOKEN_ADDRESS, receiptSigner: bridge.account.address,
      ...(config.TOKEN_CODE_HASH ? { tokenCodeHash: config.TOKEN_CODE_HASH } : {}),
      ...(config.TOKEN_IMPLEMENTATION_ADDRESS && config.TOKEN_IMPLEMENTATION_CODE_HASH
        ? { assetImplementation: { address: config.TOKEN_IMPLEMENTATION_ADDRESS, codeHash: config.TOKEN_IMPLEMENTATION_CODE_HASH } } : {}) } });
  const mcpHttp = createTelomereMcpHttp({ publicOrigin: config.PUBLIC_ORIGIN, auth, createClient: createMcpClient });
  const platformVaultPins = fullPlatform?.vaults?.config;
  const platformMcpHttp = fullPlatform ? createTelomereMcpHttp({ publicOrigin: config.PUBLIC_ORIGIN, auth,
    extendedToolTimeout: { name: 'telomere_platform_session_command', timeoutMs: 140_000 },
    createClient: createMcpClient, createServer: (_client, sessionToken) => createPlatformMcpServer({
      client: new PlatformRuntimeClient({ baseUrl: config.PUBLIC_ORIGIN, sessionToken, pins: fullPlatform.bridge.pins }),
      ...(platformVaultPins ? { createVaultClient: (vault: string) => new PlatformVaultRuntimeClient({
        baseUrl: config.PUBLIC_ORIGIN, sessionToken, pins: fullPlatform.bridge.pins, vaultPins: platformVaultPins, vault }) } : {}),
    }) }) : undefined;
  const platformVaultRuntime = platformRuntime?.vaults ? new PlatformVaultRuntimeService(platformRuntime, platformRuntime.vaults) : undefined;
  const app = createApp(service, auth, logger, './dist/public', createOperations(store.db, worker, config, !!near, nearReadiness), cysts, platform, mcpHttp, platformRuntime, platformVaultRuntime, platformMcpHttp, cystRegistry, incomeEndpoints, vaultIncome, largeCysts, largePublication, akashReadiness, treasuryTopUps, paidCystInputs, website);
  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST });
  try {
    await new Promise<void>((resolveListening, reject) => {
      const ready = () => { server.off('error', failed); resolveListening(); };
      const failed = (error: Error) => { server.off('listening', ready); reject(error); };
      if (server.listening) resolveListening();
      else { server.once('listening', ready); server.once('error', failed); }
    });
  } catch (error) {
    await Promise.allSettled([mcpHttp.close(), platformMcpHttp?.close(), largePublication?.close(), largeCysts?.close(), store.close()]);
    throw error;
  }
  worker.start();
  const maintenance = platform.start(logger);
  const platformMaintenance = platformRuntime?.start(logger);
  logger.info({ mode: config.MODE, chainId: config.CHAIN_ID, cpuMode: config.CPU_MODE, nearConfigured: !!near, port: config.PORT }, 'pilot_started');
  let closed = false;
  return { app, service, bridge, worker, platform, platformRuntime, platformVaultRuntime, cystRegistry, incomeEndpoints,
    vaultIncome, reputationPublisher, largePublication, treasuryTopUps, paidCystInputs, async close(): Promise<void> {
    if (closed) return; closed = true;
    const stopped = await Promise.allSettled([worker.stop(), platformMaintenance?.close(), mcpHttp.close(), platformMcpHttp?.close(), largePublication?.close()]);
    const closeHttp = new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
    const shutdown = await Promise.allSettled([closeHttp, maintenance.close()]);
    const storage = await Promise.allSettled([largeCysts?.close(), store.close()]);
    const failed = [...stopped, ...shutdown, ...storage].find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    logger.info('pilot_stopped');
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (existsSync('.env')) loadEnvFile('.env');
    const pilot = await startPilot(loadConfig(process.env));
    let stopping = false;
    const shutdown = () => {
      if (stopping) return; stopping = true;
      const deadline = setTimeout(() => process.exit(1), 30000).unref();
      pilot.close().then(() => { clearTimeout(deadline); process.exit(0); }).catch(() => process.exit(1));
    };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } catch (error) { pino().error({ errorCode: error instanceof Error ? error.name : 'unknown' }, 'startup_failed'); process.exitCode = 1; }
}
