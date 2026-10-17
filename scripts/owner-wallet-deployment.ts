import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { z } from 'zod';
import { projectRoot } from './compile-contracts.js';
import { publicBaseClient, safeDeploymentRpcUrl } from './base-usdc-deployment.js';
import { loadFrozenOwnerWalletDeployment, reviewOwnerWalletDeployment,
  type FrozenOwnerWalletDeployment } from '../src/deployment/owner-wallet-review.js';
import { ownerWalletTrustSchema } from '../src/deployment/owner-wallet-types.js';

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Telomere owner deployment review</title><style>body{max-width:980px;margin:36px auto;padding:0 20px;font:16px/1.5 system-ui;color:#17202a}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f7;padding:16px;max-height:55vh;overflow:auto}button,select{font:inherit;padding:10px;margin:6px 8px 6px 0}label{display:block;margin:18px 0}#status{padding:14px;border:1px solid #ccd1d1}</style></head><body><h1>Review one new Base mainnet escrow</h1><p>This is the closed, trusted-operator CPU pilot. It uses real native USDC and owner Leash limits, with no HostRegistry collateral. It does not activate the Platform/Vault marketplace.</p><p>Connect only the reviewed owner. Connecting and read-only checks request no signature and send no transaction. Deploy is a separate explicit wallet action. The owner seed/private key is never requested or loaded.</p><h2>Frozen plan and proposed treasury</h2><pre id="plan">Loading immutable public planвЂ¦</pre><h2>Owner wallet</h2><select id="providers" aria-label="Wallet provider"></select><button id="connect" type="button">Connect reviewed owner</button><button id="switch-base" type="button" disabled>Switch to Base</button><button id="refresh" type="button">Run read-only checks</button><h2>Fresh gas review</h2><pre id="gas">Not checked. The fresh total estimate will include L2 gas, the Base L1 data-fee upper bound and operator fee.</pre><label><input id="reviewed" type="checkbox">I reviewed the exact creation bytes, dedicated signer, proposed treasury and gas bounds. I approve opening this one deployment transaction in my wallet.</label><button id="deploy" type="button" disabled>Deploy new escrow through my wallet</button><p id="status" role="status">No wallet request or financial transaction has been made.</p><p>The Base transaction transfers zero USDC. ETH gas applies. Retain the original nonce and transaction hash; this page never retries an ambiguous wallet attempt. After deployment the operator must verify code, roles and canonical receipt before starting the service.</p><script type="module" src="/deployment.js"></script></body></html>`;
function reply(response: ServerResponse, status: number, type: string, body: string | Uint8Array, head = false) {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
  response.end(head ? undefined : body);
}
const json = (response: ServerResponse, status: number, value: unknown) => reply(response, status, 'application/json; charset=utf-8', JSON.stringify(value));
async function emptyObject(request: IncomingMessage) {
  let size = 0; const parts: Buffer[] = [];
  for await (const part of request) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(String(part)); size += bytes.length;
    if (size > 16) throw new Error('Review body limit'); parts.push(bytes);
  }
  if (Buffer.concat(parts).toString('utf8') !== '{}') throw new Error('Review requires an empty JSON object');
}
/** Only static public data and one bounded read-only RPC review route. There is
 * no server endpoint accepting a tx, signature, private key or RPC method name. */
export function createOwnerWalletReviewServer(options: { frozen: FrozenOwnerWalletDeployment; origin: string; javascript: Uint8Array;
  review: () => ReturnType<typeof reviewOwnerWalletDeployment>; token?: string }) {
  const origin = new URL(options.origin), token = options.token ?? randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(token) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password
    || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) {
    throw new Error('Review origin must be HTTPS or loopback HTTP');
  }
  let reviewing = false, lastReviewAt = -Infinity;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.host !== origin.host || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      json(response, 400, { status: 'refused' }); return;
    }
    const url = new URL(request.url, origin);
    if (url.search || url.hash) { json(response, 404, { status: 'not_found' }); return; }
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/') {
      reply(response, 200, 'text/html; charset=utf-8', page, request.method === 'HEAD'); return;
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/deployment.js') {
      reply(response, 200, 'text/javascript; charset=utf-8', options.javascript, request.method === 'HEAD'); return;
    }
    if (request.method === 'GET' && url.pathname === '/api/plan') {
      await options.frozen.assertUnchanged();
      json(response, 200, { plan: options.frozen.plan, trust: options.frozen.trust, reviewToken: token }); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/review') {
      const sent = request.headers['x-deployment-review'];
      if (request.headers.origin !== origin.origin || request.headers['content-type'] !== 'application/json'
        || typeof sent !== 'string' || !/^[a-f0-9]{64}$/.test(sent)
        || !timingSafeEqual(Buffer.from(sent), Buffer.from(token))) { json(response, 403, { status: 'refused' }); return; }
      if (reviewing || Date.now() - lastReviewAt < 1000) { json(response, 429, { status: 'review_busy' }); return; }
      reviewing = true; lastReviewAt = Date.now();
      try { await emptyObject(request); json(response, 200, await options.review()); }
      finally { reviewing = false; }
      return;
    }
    json(response, 404, { status: 'not_found' });
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) json(response, 422, { status: 'review_refused', detail: 'Recheck original plan, source, chain, nonce, asset pins, gas and funding.' });
      else response.destroy();
    });
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32;
  return server;
}

export async function runOwnerWalletDeployment(argv = process.argv.slice(2), environment = process.env) {
  const { values } = parseArgs({ args: argv, options: { plan: { type: 'string' }, 'plan-sha256': { type: 'string' },
    'review-digest': { type: 'string' }, owner: { type: 'string' }, signer: { type: 'string' }, treasury: { type: 'string' },
    'max-gas': { type: 'string' }, 'max-fee-per-gas-wei': { type: 'string' }, 'max-total-gas-budget-wei': { type: 'string' }, port: { type: 'string' },
    'public-origin': { type: 'string' } }, strict: true, allowPositionals: false });
  const trust = ownerWalletTrustSchema.parse({ owner: values.owner, signer: values.signer, treasury: values.treasury,
    planSha256: values['plan-sha256'], reviewDigest: values['review-digest'], maxGas: values['max-gas'], maxFeePerGasWei: values['max-fee-per-gas-wei'],
    maxTotalGasBudgetWei: values['max-total-gas-budget-wei'] });
  const planPath = z.string().min(1).max(4096).parse(values.plan), port = z.coerce.number().int().min(1024).max(65535).parse(values.port ?? '3283');
  const frozen = await loadFrozenOwnerWalletDeployment(planPath, trust, projectRoot);
  const bundled = await build({ entryPoints: [resolve(projectRoot, 'src/deployment/owner-wallet-browser.ts')], write: false,
    bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], logLevel: 'silent' });
  const javascript = bundled.outputFiles[0]?.contents;
  if (!javascript || javascript.length > 2_097_152) throw new Error('Owner review browser bundle unavailable');
  const origin = values['public-origin'] ?? 'http://127.0.0.1:' + port;
  const rpc = publicBaseClient(8453, safeDeploymentRpcUrl(8453, environment.RPC_URL));
  const server = createOwnerWalletReviewServer({ frozen, origin, javascript, review: () => reviewOwnerWalletDeployment(frozen, rpc) });
  await new Promise<void>((resolveListening, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListening); });
  process.stdout.write(JSON.stringify({ status: 'prepared_owner_review_only', url: origin, chainId: 8453, owner: trust.owner,
    predictedEscrowAddress: frozen.plan.predictedEscrowAddress, reviewDigest: frozen.plan.reviewDigest,
    transactionsSent: 0, ownerKeysLoaded: false, publicServiceStarted: false }) + '\n');
  let closing = false;
  const close = () => { if (closing) return; closing = true; server.closeAllConnections(); server.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runOwnerWalletDeployment().catch(() => {
    process.stderr.write(JSON.stringify({ status: 'owner_review_preparation_refused', transactionsSent: 0, ownerKeysLoaded: false }) + '\n');
    process.exitCode = 1;
  });
}
