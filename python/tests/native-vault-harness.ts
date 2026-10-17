/** Test-only disposable deployment/signing/reorg controls. Python acceptance
 * reads actual Anvil RPC independently; no Node evidence-reader bridge exists. */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { createWalletClient, http, parseAbi, type Hex } from 'viem';
import { localChain } from '../../src/chain/chains.js';
import { startPilot } from '../../src/main.js';
import { EIP3009_TYPES } from '../../src/payments/gateway.js';
import { digest, exactAuthorizationSchema, paymentPayloadSchema } from '../../src/payments/protocol.js';
import type { VaultIncomePublicProfile } from '../../src/sdk/vault-income/types.js';
import { deployVaultIncomeMainFixture, vaultIncomeMainConfig } from '../../tests/fixtures/vault-income-main.js';

const typedSchema = z.object({ domain: z.object({ name: z.string(), version: z.string(), chainId: z.literal(31337),
  verifyingContract: z.string() }).strict(), primaryType: z.literal('TransferWithAuthorization'),
  types: z.object({ TransferWithAuthorization: z.array(z.object({ name: z.string(), type: z.string() }).strict()),
    EIP712Domain: z.array(z.object({ name: z.string(), type: z.string() }).strict()) }).strict(), message: exactAuthorizationSchema }).strict();
const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('sign'), typedData: typedSchema, payer: z.enum(['external', 'owner']) }).strict(),
  z.object({ action: z.literal('stats') }).strict(),
  z.object({ action: z.literal('branch') }).strict(),
  z.object({ action: z.literal('reorg') }).strict(),
  z.object({ action: z.literal('restart') }).strict(),
  z.object({ action: z.literal('mine'), blocks: z.number().int().min(1).max(16) }).strict(),
  z.object({ action: z.literal('payment-before-family-birth'), payment: paymentPayloadSchema }).strict(),
]);
const tokenAbi = parseAbi(['function balanceOf(address) view returns(uint256)']);
let fixture: Awaited<ReturnType<typeof deployVaultIncomeMainFixture>> | undefined;
let configured: Awaited<ReturnType<typeof vaultIncomeMainConfig>> | undefined;
let pilot: Awaited<ReturnType<typeof startPilot>> | undefined;
let server: Server | undefined, directory: string | undefined, branch: Hex | undefined, closing = false;

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  server?.closeAllConnections();
  if (server) await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done()));
  await pilot?.close();
  await fixture?.close();
  if (directory) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-python-native-')) throw new Error('Unsafe fixture cleanup');
    await rm(target, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  fixture = await deployVaultIncomeMainFixture();
  const deployed = fixture;
  directory = await mkdtemp(join(tmpdir(), 'telomere-python-native-'));
  configured = await vaultIncomeMainConfig(deployed, directory);
  const config = configured;
  const { assetImplementation, ...pins } = config.profile.pins;
  const profile: VaultIncomePublicProfile = { resourceUrl: config.profile.resourceUrl,
    grossAmount: config.profile.grossAmount, pins: { ...pins, ...(assetImplementation ? { assetImplementation } : {}) } };
  pilot = await startPilot(config.config);
  await deployed.confirmed(deployed.owner.writeContract({ address: profile.pins.asset,
    abi: deployed.artifact('MockToken').abi, functionName: 'faucet', args: [deployed.accounts.owner.address, 1000n] }));
  server = createServer((incoming, outgoing) => {
    void (async () => {
      if (incoming.method !== 'POST' || incoming.url !== '/fixture') throw new Error('Fixture request');
      const chunks: Buffer[] = []; let total = 0;
      for await (const chunk of incoming) {
        const bytes = Buffer.from(chunk); total += bytes.length;
        if (total > 16_384) throw new Error('Fixture input bound');
        chunks.push(bytes);
      }
      const command = commandSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      let result: unknown;
      if (command.action === 'sign') {
        const typed = command.typedData, auth = typed.message;
        const account = command.payer === 'external' ? deployed.payer : deployed.accounts.owner;
        if (typed.domain.name !== profile.pins.exact.name || typed.domain.version !== profile.pins.exact.version
          || typed.domain.verifyingContract.toLowerCase() !== profile.pins.asset.toLowerCase()
          || JSON.stringify(typed.types.TransferWithAuthorization) !== JSON.stringify(EIP3009_TYPES.TransferWithAuthorization)
          || auth.from.toLowerCase() !== account.address.toLowerCase() || auth.to.toLowerCase() !== profile.pins.payTo.toLowerCase()
          || auth.value !== profile.grossAmount) throw new Error('Fixture signing terms changed');
        result = { signature: await account.signTypedData({ domain: { name: profile.pins.exact.name, version: profile.pins.exact.version,
          chainId: 31337, verifyingContract: profile.pins.asset }, types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization',
          message: { ...auth, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) } }) };
      } else if (command.action === 'stats') {
        const [external, owner, vault, facilitatorTransactions] = await Promise.all([
          deployed.local.publicClient.readContract({ address: profile.pins.asset, abi: tokenAbi, functionName: 'balanceOf', args: [deployed.payer.address] }),
          deployed.local.publicClient.readContract({ address: profile.pins.asset, abi: tokenAbi, functionName: 'balanceOf', args: [deployed.accounts.owner.address] }),
          deployed.local.publicClient.readContract({ address: profile.pins.asset, abi: tokenAbi, functionName: 'balanceOf', args: [profile.pins.payTo] }),
          deployed.local.publicClient.getTransactionCount({ address: deployed.facilitator.address }),
        ]);
        result = { external: external.toString(), owner: owner.toString(), vault: vault.toString(), facilitatorTransactions };
      } else if (command.action === 'branch') {
        branch = await deployed.test.snapshot(); result = { ok: true };
      } else if (command.action === 'reorg') {
        if (!branch) throw new Error('Missing fixture branch');
        await deployed.test.revert({ id: branch }); branch = undefined; result = { ok: true };
      } else if (command.action === 'mine') {
        await deployed.test.mine({ blocks: command.blocks }); result = { ok: true };
      } else if (command.action === 'payment-before-family-birth') {
        const payload = command.payment.payload;
        if (!('authorization' in payload)) throw new Error('Fixture exact authorization required');
        const auth = payload.authorization, signature = payload.signature;
        if (auth.from.toLowerCase() !== deployed.payer.address.toLowerCase() || auth.to.toLowerCase() !== profile.pins.payTo.toLowerCase()
          || auth.value !== profile.grossAmount) throw new Error('Fixture payment scope');
        // REASON: Solidity ABI is loaded dynamically from the actual fixture artifact.
        const identity = await deployed.local.publicClient.readContract({ address: deployed.vault.registryAddress,
          abi: deployed.artifact('PlatformSelectionRegistry').abi, functionName: 'identityRegistry' }) as `0x${string}`;
        await deployed.confirmed(deployed.owner.writeContract({ address: identity, abi: deployed.artifact('PlatformRuntimeIdentityFixture').abi,
          functionName: 'register', args: [2n, deployed.accounts.owner.address] }));
        // REASON: Real dynamic artifact returns the registered Leash tuple.
        const leash = await deployed.local.publicClient.readContract({ address: deployed.pins.escrowAddress,
          abi: deployed.artifact('PlatformRunEscrow').abi, functionName: 'getLeash', args: [deployed.vault.agent.leashId] }) as { expiry: bigint };
        const facilitator = createWalletClient({ account: deployed.facilitator, chain: localChain,
          transport: http(deployed.local.rpcUrl, { retryCount: 0 }) });
        let paymentHash: Hex, birthHash: Hex;
        await deployed.test.setAutomine(false);
        try {
          const vByte = Number.parseInt(signature.slice(130, 132), 16);
          paymentHash = await facilitator.writeContract({ address: profile.pins.payTo, abi: parseAbi([
            'function receiveFundsWithAuthorization(address from,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)']),
          functionName: 'receiveFundsWithAuthorization', args: [auth.from, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce,
            vByte < 27 ? vByte + 27 : vByte, `0x${signature.slice(2, 66)}`, `0x${signature.slice(66, 130)}`],
          gas: 1_000_000n, gasPrice: 1_000_000_000n });
          birthHash = await deployed.owner.writeContract({ address: deployed.vault.registryAddress, abi: deployed.artifact('PlatformSelectionRegistry').abi,
            functionName: 'spawn', args: [deployed.agentId, 2n, deployed.payer.address, 1n, leash.expiry], gas: 5_000_000n, gasPrice: 1_000_000_000n });
          await deployed.test.mine({ blocks: 1 });
        } finally { await deployed.test.setAutomine(true); }
        const paymentReceipt = await deployed.local.publicClient.waitForTransactionReceipt({ hash: paymentHash });
        const birthReceipt = await deployed.local.publicClient.waitForTransactionReceipt({ hash: birthHash });
        if (paymentReceipt.status !== 'success' || birthReceipt.status !== 'success' || paymentReceipt.blockHash !== birthReceipt.blockHash
          || paymentReceipt.transactionIndex >= birthReceipt.transactionIndex) throw new Error('Fixture ordered same-block execution failed');
        result = { paymentHash, birthHash, blockHash: paymentReceipt.blockHash,
          paymentIndex: paymentReceipt.transactionIndex, birthIndex: birthReceipt.transactionIndex };
      } else {
        await pilot?.close(); pilot = await startPilot(config.config); result = { ok: true };
      }
      outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify(result));
    })().catch(() => { if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'application/json' }); outgoing.end('{"error":"fixture_failed"}'); });
  });
  await new Promise<void>((done, reject) => server!.once('error', reject).listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  process.stdout.write(JSON.stringify({ profile, profileHash: digest(profile), rpcUrl: deployed.local.rpcUrl, readerUrl: 'http://127.0.0.1:' + address.port + '/fixture',
    payer: deployed.payer.address, owner: deployed.accounts.owner.address }) + '\n');
  process.stdin.once('data', () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  process.stdin.once('end', () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  process.once('SIGTERM', () => { void close().then(() => process.exit(0), () => process.exit(1)); });
}

void run().catch(async () => { process.stderr.write('Disposable Python native Vault fixture failed.\n');
  try { await close(); } finally { process.exitCode = 1; } });
