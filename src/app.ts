import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import type { Logger } from 'pino';
import { decodeFunctionData, type Address } from 'viem';
import { Auth } from './auth.js';
import { Service } from './service.js';
import { Problem, addressSchema, bytes32Schema, signatureSchema, moneySchema, quoteInputSchema, sameAddress } from './common.js';
import { tokenAbi, escrowAbi } from './chain/abi.js';
import { chainForId } from './chain/chains.js';
import type { Operations } from './operations.js';
import type { CystService } from './cysts/service.js';
import { createCystRoutes } from './cysts/routes.js';
import { createLargeCystRoutes } from './cysts/large-routes.js';
import { createLargeCystPublicationRoutes } from './cysts/large-publication-routes.js';
import type { LargeCystPublicationService } from './cysts/large-publication-service.js';
import type { LargeCystStore } from './cysts/large-checkpoints.js';
import { createCystRegistryRoutes } from './cysts/registry-routes.js';
import type { CystRegistryService } from './cysts/registry-service.js';
import { CYST_CAPABILITIES } from './cysts/types.js';
import { DeadlineService } from './scheduling/service.js';
import { createSchedulingRoutes } from './scheduling/routes.js';
import { createAgentRoutes } from './agents/routes.js';
import { createReceiptRoutes } from './receipts/routes.js';
import { createPlatformPresentedMeterRoutes } from './receipts/platform-presented-meter-routes.js';
import { createPlatformV2Routes } from './receipts/platform-v2-routes.js';
import type { ControllerPlatform } from './platform.js';
import { createSelectionRoutes } from './selection/routes.js';
import { createSelectionDatasetRoutes } from './selection/dataset.js';
import { createSelectionReputationRoutes } from './selection/reputation.js';
import type { PlatformRuntimeService } from './platform-runtime/service.js';
import { createPlatformRuntimeRoutes } from './platform-runtime/routes.js';
import { createPlatformPublicFinancialRoutes } from './platform-runtime/public-financial-routes.js';
import { PlatformPublicFinancialReader } from './platform-runtime/public-financial.js';
import { createPlatformVaultRuntimeRoutes } from './platform-runtime/vault-routes.js';
import { createPaidCpuJobRoutes } from './scheduling/paid-job-routes.js';
import { PaidCpuJobService } from './scheduling/paid-jobs.js';
import type { PlatformVaultRuntimeService } from './platform-runtime/vault-service.js';
import { createIncomeEndpointRoutes } from './selection/income-endpoints/routes.js';
import type { IncomeEndpointService } from './selection/income-endpoints/service.js';
import type { ConfiguredVaultIncome } from './payments/vault-income-configured.js';
import { createVaultIncomeAdminRoutes, createVaultIncomePublicRoutes, VAULT_INCOME_ADMIN_PATH } from './payments/vault-income-routes.js';
import type { AkashControllerReadiness } from './suppliers/controller-readiness.js';
import { createAkashReadinessRoutes } from './suppliers/controller-routes.js';
import { createTreasuryTopUpRoutes } from './treasury/routes.js';
import type { TreasuryTopUpService } from './treasury/service.js';
import type { PaidCystInputService } from './platform-runtime/paid-cyst-input.js';
import { createPaidCystInputRoutes } from './platform-runtime/paid-cyst-input-routes.js';
import type { Website } from './website.js';

const cookie = 'telomere_session';
export function createApp(service: Service, auth: Auth, logger: Logger, publicRoot = './dist/public', operations?: (owner?: Address) => Promise<Operations>, cysts?: CystService, platform?: ControllerPlatform,
  mcpHttp?: { handle(request: Request): Promise<Response> }, platformRuntime?: PlatformRuntimeService, platformVaultRuntime?: PlatformVaultRuntimeService,
  platformMcpHttp?: { handle(request: Request): Promise<Response> }, cystRegistry?: CystRegistryService, incomeEndpoints?: IncomeEndpointService, vaultIncome?: ConfiguredVaultIncome,
  largeCysts?: LargeCystStore, largePublication?: LargeCystPublicationService, akashReadiness?: AkashControllerReadiness,
  treasuryTopUps?: TreasuryTopUpService, paidCystInputs?: Pick<PaidCystInputService, 'status' | 'upload'>, website?: Website) {
  const app = new Hono();
  const rateBuckets = new Map<string, { count: number; expires: number }>();
  let demoQueue = Promise.resolve();
  async function requireDispatchReady(): Promise<void> {
    const snapshot = await operations?.();
    if (snapshot && ['quarantined', 'faulted', 'stopped'].includes(snapshot.worker.state)) {
      throw new Problem(503, 'controller_unavailable', 'New work is paused until the operator restores the controller. Existing funds and refund actions remain available.');
    }
  }
  async function serialDemo<T>(operation: () => Promise<T>): Promise<T> {
    const result = demoQueue.then(operation, operation);
    demoQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  const strictHeaders = secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
    connectSrc: ["'self'", service.config.MODE === 'demo' ? service.config.RPC_URL : chainForId(service.config.CHAIN_ID).rpcUrls.default.http[0]],
    imgSrc: ["'self'", 'data:'], frameAncestors: ["'none'"] } });
  app.use('*', async (context, next) => {
    await strictHeaders(context, next);
    const policy = website?.policyFor(context.req.raw);
    if (policy) context.header('Content-Security-Policy', policy);
  });
  app.use('/api/*', (context, next) => {
    // Platform and registry mutations enforce their own streamed bounds and five-second deadlines.
    // Buffering first here would hide an unfinished body from that deadline.
    if (context.req.path === '/api/platform' || context.req.path.startsWith('/api/platform/')) return next();
    if (context.req.path === '/api/cyst-registry' || context.req.path.startsWith('/api/cyst-registry/')) return next();
    if (context.req.path === '/api/cysts-large-registry' || context.req.path.startsWith('/api/cysts-large-registry/')) return next();
    if (context.req.path === '/api/cysts-large' || context.req.path.startsWith('/api/cysts-large/')) return next();
    if (context.req.path === '/api/selection/income-endpoints' || context.req.path.startsWith('/api/selection/income-endpoints/')) return next();
    if (context.req.path === VAULT_INCOME_ADMIN_PATH || context.req.path.startsWith(VAULT_INCOME_ADMIN_PATH + '/')) return next();
    if (context.req.path === '/api/treasury/topups' || context.req.path.startsWith('/api/treasury/topups/')) return next();
    return bodyLimit({ maxSize: cysts && (context.req.path === '/api/cysts' || context.req.path.startsWith('/api/cysts/'))
    ? CYST_CAPABILITIES.maxUploadBodyBytes : 196608,
    onError: limited => limited.json({ type: 'about:blank', title: 'payload_too_large', status: 413,
      detail: 'Request body exceeds the endpoint limit.' }, 413, { 'Content-Type': 'application/problem+json' }) })(context, next);
  });
  const rateLimit: MiddlewareHandler = async (context, next) => {
    // The pilot is single-instance. No client supplied forwarding headers are trusted.
    let identity = 'local-test';
    try { identity = getConnInfo(context).remote.address ?? 'unknown'; } catch { /* In-process tests have no Node socket. */ }
    const publicFinancial = context.req.path.startsWith('/api/platform/public/');
    const key = identity + (context.req.path.startsWith('/api/auth') ? ':auth' : publicFinancial ? ':public-financial' : ':api');
    const now = Date.now();
    if (rateBuckets.size > 10000) for (const [id, entry] of rateBuckets) if (entry.expires < now) rateBuckets.delete(id);
    if (rateBuckets.size > 10000 && !rateBuckets.has(key)) throw new Problem(429, 'rate_limit', 'Try again in a minute.');
    let entry = rateBuckets.get(key);
    if (!entry || entry.expires < now) { entry = { count: 0, expires: now + 60000 }; rateBuckets.set(key, entry); }
    if (++entry.count > (key.endsWith(':auth') ? 30 : publicFinancial ? 6 : 240)) throw new Problem(429, 'rate_limit', 'Too many requests. Try again in a minute.');
    await next();
  };
  app.use('/api/*', rateLimit);
  app.use('/x402/vault-income', rateLimit);
  app.use('/mcp', rateLimit);
  app.use('/mcp/platform', rateLimit);
  app.use('/api/*', async (context, next) => {
    if (!['GET', 'HEAD'].includes(context.req.method)) {
      if (context.req.header('origin') !== service.config.PUBLIC_ORIGIN) throw new Problem(403, 'origin_mismatch', 'This request must originate from the Telomere interface.');
      const isLargePart = /^\/api\/cysts-large\/0x[a-f0-9]{64}\/parts\/(0|[1-9][0-9]{0,2})$/.test(context.req.path)
        && context.req.method === 'PUT';
      const isPaidCystInput = paidCystInputs !== undefined && context.req.method === 'PUT'
        && /^\/api\/platform\/vaults\/0x[a-f0-9]{40}\/runs\/0x[a-f0-9]{64}\/inputs\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/i.test(context.req.path);
      if (isLargePart || isPaidCystInput) {
        if (context.req.header('content-type') !== 'application/octet-stream') throw new Problem(400, 'binary_required', 'Send application/octet-stream.');
      } else if (!context.req.header('content-type')?.startsWith('application/json')) throw new Problem(400, 'json_required', 'Send application/json.');
    }
    await next();
    context.header('Cache-Control', 'no-store');
    logger.info({ method: context.req.method, path: context.req.path, status: context.res.status }, 'request');
  });
  app.onError((error, context) => {
    const known = error instanceof Problem;
    const status = known ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 422 : 503;
    if (!known && status === 503) logger.error({ errorCode: error.name }, 'request_failed');
    return context.json({ type: 'about:blank', title: known ? error.code : status === 422 ? 'invalid_input' : 'service_unavailable', status,
      detail: known ? error.message : status === 422 ? 'Check the request fields.' : 'The service is temporarily unavailable.' }, status, { 'Content-Type': 'application/problem+json' });
  });
  app.get('/health/live', context => context.json({ status: 'ok' }));
  if (platformRuntime) app.route('/api/platform/public', createPlatformPublicFinancialRoutes(new PlatformPublicFinancialReader(platformRuntime.bridge, 12,
    runId => platformRuntime.cpuLaneAttribution(runId))));
  if (platformRuntime) app.route('/api/platform/public/presented-meter', createPlatformPresentedMeterRoutes(
    platformRuntime.bridge.pins, service.config.RPC_URL));
  if (platformRuntime) app.route('/api/platform/public/v2', createPlatformV2Routes(platformRuntime.bridge,
    platformRuntime.publicV2ConfirmationDepth(), undefined, platformRuntime.publicV2EvidenceReader()));
  if (platformRuntime) app.route('/api/platform', createPlatformRuntimeRoutes(platformRuntime,
    context => auth.owner(getCookie(context, cookie)), platformRuntime.bridge.pins.x402CpuProfile
      ? { x402ResourceUrl: service.config.PUBLIC_ORIGIN + '/api/platform/cells' } : {}));
  if (platformVaultRuntime) app.route('/api/platform', createPlatformVaultRuntimeRoutes(platformVaultRuntime, context => auth.owner(getCookie(context, cookie))));
  if (platformVaultRuntime) app.route('/api/platform', createPaidCpuJobRoutes(new PaidCpuJobService(platformVaultRuntime.runtime),
    context => auth.owner(getCookie(context, cookie))));
  if (paidCystInputs) app.route('/api/platform', createPaidCystInputRoutes(paidCystInputs,
    context => auth.owner(getCookie(context, cookie))));
  if (cystRegistry) app.route('/api/cyst-registry', createCystRegistryRoutes(cystRegistry, context => auth.owner(getCookie(context, cookie))));
  if (incomeEndpoints) app.route('/api/selection/income-endpoints', createIncomeEndpointRoutes(incomeEndpoints, context => auth.owner(getCookie(context, cookie))));
  if (akashReadiness) app.route('/api/suppliers/akash', createAkashReadinessRoutes(akashReadiness, context => auth.owner(getCookie(context, cookie))));
  if (treasuryTopUps) app.route('/api/treasury/topups', createTreasuryTopUpRoutes(treasuryTopUps,
    context => auth.owner(getCookie(context, cookie))));
  if (vaultIncome) {
    app.route('/', createVaultIncomePublicRoutes(vaultIncome));
    app.route(VAULT_INCOME_ADMIN_PATH, createVaultIncomeAdminRoutes(vaultIncome, context => auth.owner(getCookie(context, cookie))));
  }
  if (mcpHttp) app.all('/mcp', context => mcpHttp.handle(context.req.raw));
  if (platformMcpHttp) app.all('/mcp/platform', context => platformMcpHttp.handle(context.req.raw));
  app.get('/health/ready', async context => {
    await service.bridge.check();
    await vaultIncome?.check();
    largePublication?.check();
    const snapshot = await operations?.();
    if (snapshot && ['quarantined', 'faulted', 'stopped'].includes(snapshot.worker.state)) return context.json({ status: 'unavailable', worker: snapshot.worker.state }, 503);
    const publisher = platform?.reputationPublisherReadiness();
    if (publisher && publisher.state !== 'ready') return context.json({ status: 'unavailable', publisher }, 503);
    return context.json({ status: 'ready', ...(snapshot ? { worker: snapshot.worker.state } : {}) });
  });
  app.get('/api/operations', async context => {
    const owner = await auth.owner(getCookie(context, cookie));
    if (!operations) throw new Problem(503, 'operations_unavailable', 'Controller status is unavailable.');
    return context.json(await operations(owner));
  });
  app.get('/api/config', async context => { const nearReadiness = await service.nearReadiness(); return context.json({ mode: service.config.MODE,
    chain: { id: service.config.CHAIN_ID, name: service.bridge.chain.name,
      rpcUrl: service.config.MODE === 'demo' ? service.config.RPC_URL : chainForId(service.config.CHAIN_ID).rpcUrls.default.http[0],
      ...(service.config.MODE !== 'demo' ? { explorerUrl: chainForId(service.config.CHAIN_ID).blockExplorers?.default.url } : {}) },
    token: { address: service.config.TOKEN_ADDRESS, symbol: service.config.MODE === 'demo' ? 'TEST' : 'USDC', decimals: 6,
      ...(service.config.TOKEN_CODE_HASH ? { codeHash: service.config.TOKEN_CODE_HASH } : {}),
      ...(service.config.TOKEN_IMPLEMENTATION_ADDRESS && service.config.TOKEN_IMPLEMENTATION_CODE_HASH
        ? { implementation: { address: service.config.TOKEN_IMPLEMENTATION_ADDRESS, codeHash: service.config.TOKEN_IMPLEMENTATION_CODE_HASH } } : {}) },
    escrowAddress: service.config.ESCROW_ADDRESS, receiptSigner: service.bridge.account.address,
    prices: { cpuPerSecond: service.config.CPU_PRICE_PER_SECOND, inferenceFixed: service.config.INFERENCE_FIXED_PRICE, maxSeconds: 120, maxTokens: service.config.MAX_TOKENS },
    nearAvailable: service.nearAvailable && nearReadiness.state === 'ready', nearReadiness, cpuMode: service.config.CPU_MODE,
    workload: { nearModel: service.config.NEAR_MODEL ?? null }, cystsAvailable: Boolean(cysts),
    largeCystsAvailable: Boolean(largeCysts),
    largeCystsReplicated: Boolean(service.config.CYSTS_LARGE_REPLICATION_CONFIG),
    largeCystsWritable: Boolean(largeCysts && !('readOnly' in largeCysts && largeCysts.readOnly)),
    cystRegistryAvailable: Boolean(cystRegistry), incomeEndpointsAvailable: Boolean(incomeEndpoints), vaultIncomeAvailable: Boolean(vaultIncome),
    platform: { agentLifecycle: Boolean(platform?.agents), agentRuntimeScope: platform?.agentRuntimeScope ?? null,
      hourlyReceipts: Boolean(platform), mcpStreamableHttp: Boolean(mcpHttp),
      receiptRootAddress: service.config.RECEIPT_ROOT_ADDRESS ?? null, maximumActiveLeaseSeconds: 120,
      checkpointKind: 'encrypted-application-state', deadlineEnforcement: 'operator-signed-zero-charge-on-missed-deadline' } }); });
  if (cysts) app.route('/api/cysts', createCystRoutes(cysts, context => auth.owner(getCookie(context, cookie))));
  if (largeCysts) app.route('/api/cysts-large', createLargeCystRoutes(largeCysts, context => auth.owner(getCookie(context, cookie))));
  if (largePublication) app.route('/api/cysts-large-registry', createLargeCystPublicationRoutes(largePublication,
    context => auth.owner(getCookie(context, cookie))));
  if (platform?.agents) app.route('/api/agents', createAgentRoutes(platform.agents, context => auth.owner(getCookie(context, cookie))));
  if (platform) app.route('/api/receipt-batches', createReceiptRoutes(platform.receipts, context => auth.owner(getCookie(context, cookie)), platform.receiptReader));
  if (platform?.selection) app.route('/api/selection', createSelectionRoutes(platform.selection, context => auth.owner(getCookie(context, cookie))));
  if (platform?.selectionDataset) app.route('/api/selection', createSelectionDatasetRoutes(platform.selectionDataset));
  if (platform?.selectionReputation) app.route('/api/selection', createSelectionReputationRoutes(platform.selectionReputation));
  app.route('/api/jobs', createSchedulingRoutes(new DeadlineService(service), context => auth.owner(getCookie(context, cookie))));
  app.post('/api/auth/challenge', async context => {
    const { address } = z.object({ address: addressSchema }).strict().parse(await context.req.json());
    return context.json(await auth.challenge(address));
  });
  app.post('/api/auth/verify', async context => {
    const input = z.object({ address: addressSchema, nonce: z.string().regex(/^[a-f0-9]{48}$/), signature: signatureSchema }).strict().parse(await context.req.json());
    const token = await auth.verify(input.address, input.nonce, input.signature);
    setCookie(context, cookie, token, { httpOnly: true, sameSite: 'Strict', secure: service.config.PUBLIC_ORIGIN.startsWith('https:'), path: '/', maxAge: 8 * 3600 });
    return context.json({ address: input.address, demo: false });
  });
  app.post('/api/auth/demo', async context => {
    const demo = service.bridge.demo;
    if (service.config.MODE !== 'demo' || !demo) throw new Problem(404, 'not_found', 'Not found.');
    const token = await auth.session(demo.account.address);
    setCookie(context, cookie, token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 8 * 3600 });
    return context.json({ address: demo.account.address, demo: true });
  });
  app.post('/api/auth/logout', async context => { await auth.logout(getCookie(context, cookie)); deleteCookie(context, cookie); return context.json({ ok: true }); });
  app.get('/api/me', async context => {
    const owner = await auth.owner(getCookie(context, cookie));
    return context.json({ address: owner, demo: !!service.bridge.demo && sameAddress(owner, service.bridge.demo.account.address) });
  });
  app.get('/api/balance', async context => context.json(await service.balance(await auth.owner(getCookie(context, cookie)))));
  app.get('/api/leashes', async context => context.json(await service.listLeashes(await auth.owner(getCookie(context, cookie)))));
  app.post('/api/leashes', async context => {
    const owner = await auth.owner(getCookie(context, cookie));
    const input = z.object({ agent: addressSchema.optional(), maxPerHour: moneySchema, maxPerDay: moneySchema, expiry: z.number().int().positive() }).strict().parse(await context.req.json());
    return context.json(await service.createLeash(owner, input.agent ?? owner, BigInt(input.maxPerHour), BigInt(input.maxPerDay), BigInt(input.expiry)), 201);
  });
  app.post('/api/leashes/:id/kill', async context => {
    const owner = await auth.owner(getCookie(context, cookie)); const id = bytes32Schema.parse(context.req.param('id'));
    if (!sameAddress((await service.bridge.leash(id)).owner, owner)) throw new Problem(404, 'not_found', 'Budget not found.');
    return context.json({ transaction: service.bridge.killTransaction(id) });
  });
  app.post('/api/leashes/:id/update', async context => {
    const owner = await auth.owner(getCookie(context, cookie)); const id = bytes32Schema.parse(context.req.param('id'));
    const input = z.object({ maxPerHour: moneySchema, maxPerDay: moneySchema, expiry: z.number().int().safe().positive() }).strict().parse(await context.req.json());
    return context.json(await service.updateLeash(owner, id, BigInt(input.maxPerHour), BigInt(input.maxPerDay), BigInt(input.expiry)));
  });
  app.post('/api/quotes', async context => {
    const owner = await auth.owner(getCookie(context, cookie));
    await requireDispatchReady();
    const idemKey = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(context.req.header('Idempotency-Key'));
    return context.json(await service.quote(owner, quoteInputSchema.parse(await context.req.json()), idemKey), 201);
  });
  app.post('/api/runs', async context => {
    const owner = await auth.owner(getCookie(context, cookie));
    await requireDispatchReady();
    const input = z.object({ runId: bytes32Schema, txHash: bytes32Schema }).strict().parse(await context.req.json());
    return context.json(await service.admit(owner, input.runId, input.txHash), 202);
  });
  app.get('/api/runs', async context => context.json(await service.listRuns(await auth.owner(getCookie(context, cookie)))));
  app.get('/api/runs/:id', async context => {
    const job = await service.requireJob(await auth.owner(getCookie(context, cookie)), bytes32Schema.parse(context.req.param('id')));
    const run = await service.bridge.run(bytes32Schema.parse(job.id));
    return context.json({ ...service.publicJob(job), ...(run.status === 1 ? { refundAt: Number(run.openedAt) + Number(run.maxSeconds) + 21600 } : {}) });
  });
  app.post('/api/runs/:id/stop', async context => {
    await service.requireJob(await auth.owner(getCookie(context, cookie)), context.req.param('id'));
    return context.json({ transaction: service.bridge.stopTransaction(bytes32Schema.parse(context.req.param('id'))) });
  });
  app.post('/api/runs/:id/refund', async context => {
    await service.requireJob(await auth.owner(getCookie(context, cookie)), context.req.param('id'));
    return context.json({ transaction: service.bridge.refundTransaction(bytes32Schema.parse(context.req.param('id'))) });
  });
  app.get('/api/transactions/deposit', async context => { await auth.owner(getCookie(context, cookie)); return context.json({ transactions: service.bridge.depositTransactions(BigInt(moneySchema.parse(context.req.query('amount')))) }); });
  app.get('/api/transactions/withdraw', async context => { await auth.owner(getCookie(context, cookie)); return context.json({ transaction: service.bridge.withdrawTransaction(BigInt(moneySchema.parse(context.req.query('amount')))) }); });
  app.post('/api/receipts/verify', async context => {
    await auth.owner(getCookie(context, cookie));
    const { receipt } = z.object({ receipt: z.unknown() }).strict().parse(await context.req.json());
    return context.json(await service.verifyReceipt(receipt));
  });
  async function requireDemo(owner: Address) {
    const demo = service.bridge.demo;
    if (service.config.MODE !== 'demo' || !demo || !sameAddress(owner, demo.account.address)) throw new Problem(403, 'demo_disabled', 'Demo signing is disabled.');
    return demo;
  }
  app.post('/api/demo/fund', async context => serialDemo(async () => {
    const owner = await auth.owner(getCookie(context, cookie)), demo = await requireDemo(owner);
    const hash = await service.bridge.wallet.writeContract({ address: service.config.TOKEN_ADDRESS, abi: tokenAbi, functionName: 'faucet', args: [owner, 10_000_000n] });
    await service.bridge.public.waitForTransactionReceipt({ hash });
    for (const tx of service.bridge.depositTransactions(10_000_000n)) {
      const txHash = await demo.sendTransaction({ ...tx, value: 0n }); await service.bridge.public.waitForTransactionReceipt({ hash: txHash });
    }
    return context.json(await service.balance(owner));
  }));
  app.post('/api/demo/transaction', async context => serialDemo(async () => {
    const owner = await auth.owner(getCookie(context, cookie)), demo = await requireDemo(owner);
    const input = z.object({ to: addressSchema, data: z.string().regex(/^0x[a-fA-F0-9]*$/).max(8192), value: z.literal('0x0').optional() }).strict().parse(await context.req.json());
    const isToken = sameAddress(input.to, service.config.TOKEN_ADDRESS), isEscrow = sameAddress(input.to, service.config.ESCROW_ADDRESS);
    if (!isToken && !isEscrow) throw new Problem(403, 'demo_target', 'Demo transactions are restricted to pilot contracts.');
    // REASON: calldata is a validated hex string; viem decodes against only the local pilot ABI.
    const data = input.data as `0x${string}`;
    const decoded = decodeFunctionData({ abi: isToken ? tokenAbi : escrowAbi, data });
    if (isToken && decoded.functionName !== 'approve') throw new Problem(403, 'demo_method', 'Only token approvals are supported.');
    if (isEscrow && !['deposit', 'withdraw', 'createLeash', 'updateLeash', 'killLeash', 'openRun', 'requestStop', 'refundRun'].includes(decoded.functionName)) throw new Problem(403, 'demo_method', 'Unsupported demo transaction.');
    const hash = await demo.sendTransaction({ to: input.to, data, value: 0n });
    const receipt = await service.bridge.public.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Problem(409, 'transaction_failed', 'Transaction reverted.');
    return context.json({ txHash: hash });
  }));
  app.get('/app.js', serveStatic({ path: publicRoot + '/app.js' }));
  app.get('/styles.css', serveStatic({ path: publicRoot + '/styles.css' }));
  app.get('/console', serveStatic({ path: publicRoot + '/index.html' }));
  app.get('/console/', serveStatic({ path: publicRoot + '/index.html' }));
  if (website) app.all('*', async context => await website.handle(context.req.raw) ?? context.notFound());
  else app.get('/', serveStatic({ path: publicRoot + '/index.html' }));
  app.notFound(context => context.json({ detail: 'Not found.' }, 404));
  return app;
}
