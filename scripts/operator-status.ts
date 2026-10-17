import { parseArgs } from 'node:util';
import { createPublicClient, defineChain, http, TransactionReceiptNotFoundError } from 'viem';
import { z } from 'zod';
import { escrowAbi, tokenAbi } from '../src/chain/abi.js';
import { readProfile, publicProfile } from '../src/operator/profile.js';
import { databaseSnapshot } from '../src/operator/database.js';
import { classifyJournal } from '../src/operator/diagnostics.js';
import { observeLargeCystStorage } from '../src/operator/large-cyst-storage.js';
import { configuredNearProvider } from '../src/providers/configured.js';
import { getNearProviderReadiness } from '../src/providers/index.js';

let phase = 'arguments';
try {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, 'api-url': { type: 'string' } }, strict: true, allowPositionals: false });
  phase = 'profile';
  const config = await readProfile(z.string().min(1).parse(values['env-file']));
  const metadata = publicProfile(config);
  const nearReadiness = await getNearProviderReadiness(configuredNearProvider(config));
  const chain = defineChain({ id: config.CHAIN_ID, name: metadata.mode, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.RPC_URL] } } });
  const client = createPublicClient({ chain, transport: http(config.RPC_URL, { timeout: 10000, retryCount: 0 }) });
  phase = 'network';
  const actualChainId = await client.getChainId();
  if (actualChainId !== config.CHAIN_ID) throw new Error('Network mismatch');
  const [quoteSigner, receiptSigner, token, treasury, decimals, latestNonce, pendingNonce, balance] = await Promise.all([
    client.readContract({ address: config.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'quoteSigner' }),
    client.readContract({ address: config.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'receiptSigner' }),
    client.readContract({ address: config.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'token' }),
    client.readContract({ address: config.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'treasury' }),
    client.readContract({ address: config.TOKEN_ADDRESS, abi: tokenAbi, functionName: 'decimals' }),
    client.getTransactionCount({ address: metadata.signer, blockTag: 'latest' }),
    client.getTransactionCount({ address: metadata.signer, blockTag: 'pending' }), client.getBalance({ address: metadata.signer }) ]);
  const checks = { networkMatches: true, signerMatches: [quoteSigner, receiptSigner].every(value => value.toLowerCase() === metadata.signer.toLowerCase()),
    tokenMatches: token.toLowerCase() === config.TOKEN_ADDRESS.toLowerCase(), tokenHasSixDecimals: decimals === 6 };
  phase = 'database';
  const database = config.DATABASE_URL ? await databaseSnapshot(config.DATABASE_URL, latestNonce,
    !!config.PLATFORM_RUNTIME_CONFIG) : null;
  phase = 'journal';
  const diagnostics = [];
  for (const row of database?.journal.selected ?? []) {
    const run = await client.readContract({ address: config.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'getRun', args: [row.runId] });
    let receipt = null;
    try {
      const mined = await client.getTransactionReceipt({ hash: row.txHash });
      receipt = { status: mined.status, canonical: (await client.getBlock({ blockNumber: mined.blockNumber })).hash === mined.blockHash };
    } catch (error) { if (!(error instanceof TransactionReceiptNotFoundError)) throw error; }
    diagnostics.push({ ...row, runStatus: run.status, ...classifyJournal({ ...row, runStatus: run.status, chainNonce: latestNonce, receipt }) });
  }
  phase = 'controller';
  const apiUrl = z.string().url().parse(values['api-url'] ?? `http://${config.HOST === '::1' ? '[::1]' : config.HOST}:${config.PORT}`);
  const target = new URL(apiUrl);
  if (target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new Error('Invalid API origin');
  let controller: { status: string; worker?: string } = { status: 'unreachable' };
  try {
    const response = await fetch(new URL('/health/ready', apiUrl), { signal: AbortSignal.timeout(10000), redirect: 'error' });
    const body = z.object({ status: z.string().max(32), worker: z.string().max(32).optional() }).strip().parse(await response.json());
    controller = { status: response.ok ? body.status : 'unavailable', ...(body.worker ? { worker: body.worker } : {}) };
  } catch { /* An unavailable controller is part of the report, not proof of safe nonce reuse. */ }
  phase = 'storage';
  const storage = await observeLargeCystStorage(config, target);
  const { selected: _selected, ...journal } = database?.journal ?? { selected: [] };
  const output = { schemaVersion: 1, checkedAt: new Date().toISOString(), readOnly: true, ...metadata, near: { ...metadata.near, readiness: nearReadiness }, checks,
    chain: { actualChainId, quoteSigner, receiptSigner, treasury, latestNonce, pendingNonce, operatorGasBalanceWei: balance.toString() }, controller,
    storage,
    databaseStatus: database ? { controllerLockHeld: database.controllerLockHeld, counts: database.counts,
      oldestQueuedAt: database.oldestQueuedAt, oldestActiveUpdatedAt: database.oldestActiveUpdatedAt,
      platform: database.platform, journal, diagnostics, reconciliation: database.reconciliation,
      reconciliationTruncated: database.reconciliationTruncated, pendingReceipts: database.pendingReceipts,
      pendingReceiptsTruncated: database.pendingReceiptsTruncated } : { status: 'pglite_not_opened', reason: 'Read the running API; do not open its data directory as a second controller.' } };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  if (Object.values(checks).some(value => !value) || controller.status !== 'ready'
    || storage.status !== 'not_configured' && storage.status !== 'ready' || database && !database.controllerLockHeld
    || metadata.near.configured && nearReadiness.state !== 'ready'
    || diagnostics.some(item => item.kind !== 'settlement_mined') || database?.reconciliation.length || database?.pendingReceipts.length
    || database && 'counts' in database.platform && ((database.platform.unknownStatusCount ?? 0) > 0
      || (database.platform.counts.reconciliation ?? 0) > 0)) process.exitCode = 1;
} catch {
  // Provider/DB/config error objects can contain URLs, credentials or input. Emit only a stable public diagnostic.
  process.stderr.write(JSON.stringify({ status: 'diagnostic_failed', phase, detail: 'Check profile, RPC, database and API connectivity. No transactions were sent.' }) + '\n');
  process.exitCode = 1;
}
