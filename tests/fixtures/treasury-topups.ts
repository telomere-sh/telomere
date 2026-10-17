import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { encodeBase58, associatedTokenAddress } from '../../src/treasury/solana-reader.js';
import { SOLANA_MAINNET_GENESIS, SOLANA_TOKEN_PROGRAM, SOLANA_USDC_MINT, topUpProfileSchema, type TopUpProfile } from '../../src/treasury/types.js';
import { secureVaultIncomeTestFile, vaultIncomeMainConfig, type deployVaultIncomeMainFixture } from './vault-income-main.js';

const key = (byte: number) => encodeBase58(Buffer.alloc(32, byte));
export const fixtureSolanaRecipient = key(17);
export const fixtureSolanaAta = associatedTokenAddress(fixtureSolanaRecipient, SOLANA_USDC_MINT);
export function sourceTransaction(invoice: { reference: string; amountMicros: string; createdAt: number }, signature: string) {
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(BigInt(invoice.amountMicros), 1); data[9] = 6;
  return { slot: 100, blockTime: invoice.createdAt, version: 'legacy',
    transaction: { signatures: [signature], message: { accountKeys: [key(1), key(2), fixtureSolanaAta, SOLANA_USDC_MINT, SOLANA_TOKEN_PROGRAM, invoice.reference],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 3 },
      instructions: [{ programIdIndex: 4, accounts: [1, 3, 2, 0, 5], data: encodeBase58(data) }] } },
    meta: { err: null, preTokenBalances: [{ accountIndex: 2, mint: SOLANA_USDC_MINT, owner: fixtureSolanaRecipient, uiTokenAmount: { amount: '0', decimals: 6 } }],
      postTokenBalances: [{ accountIndex: 2, mint: SOLANA_USDC_MINT, owner: fixtureSolanaRecipient, uiTokenAmount: { amount: invoice.amountMicros, decimals: 6 } }] } };
}
/** Local JSON-RPC fixture only; it does not mine or finalize a Solana transaction. */
export class SolanaTopUpRpcFixture {
  endpoint = ''; readonly requests: string[] = []; readonly transactions = new Map<string, ReturnType<typeof sourceTransaction>>();
  genesisHash = SOLANA_MAINNET_GENESIS; finalized = true; treasuryAccountAvailable = true;
  private readonly server: Server;
  constructor() {
    this.server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 16_384) throw new Error('Fixture request bound'); chunks.push(bytes); }
        const input: { method: string; params?: unknown[] } = JSON.parse(Buffer.concat(chunks).toString()); this.requests.push(input.method);
        const signature = typeof input.params?.[0] === 'string' ? input.params[0] : '';
        let result: unknown;
        if (input.method === 'getGenesisHash') result = this.genesisHash;
        else if (input.method === 'getAccountInfo') result = { context: { slot: 101 }, value: this.treasuryAccountAvailable ? {
          owner: SOLANA_TOKEN_PROGRAM, executable: false, data: { parsed: { type: 'account', info: { mint: SOLANA_USDC_MINT,
            owner: fixtureSolanaRecipient, state: 'initialized', tokenAmount: { amount: '0', decimals: 6 } } } } } : null };
        else if (input.method === 'getTransaction') result = this.transactions.get(signature) ?? null;
        else if (input.method === 'getSignatureStatuses') result = { context: { slot: 101 }, value: [{ slot: 100, err: null, confirmationStatus: this.finalized ? 'finalized' : 'confirmed' }] };
        else if (input.method === 'getBlock') result = { blockhash: key(31), signatures: [...this.transactions.keys()] };
        else throw new Error('Fixture rejects mutation or unknown RPC method');
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      })().catch(() => { response.writeHead(400, { 'content-type': 'application/json' }); response.end('{}'); });
    });
  }
  async start(): Promise<void> {
    await new Promise<void>(done => this.server.listen(0, '127.0.0.1', done));
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('Fixture RPC did not bind');
    this.endpoint = 'http://127.0.0.1:' + address.port;
  }
  add(invoice: { reference: string; amountMicros: string; createdAt: number }, signature = encodeBase58(Buffer.alloc(64, this.transactions.size + 1))) {
    this.transactions.set(signature, sourceTransaction(invoice, signature)); return signature;
  }
  async close(): Promise<void> { this.server.closeAllConnections(); await new Promise<void>(done => this.server.close(() => done())); }
}

/** Real disposable Base-like EVM contracts paired with the explicitly fake Solana RPC. */
export async function treasuryTopUpFixtureProfile(fixture: Awaited<ReturnType<typeof deployVaultIncomeMainFixture>>, directory: string,
  source: SolanaTopUpRpcFixture, overrides: Partial<TopUpProfile> = {}) {
  const initial = await vaultIncomeMainConfig(fixture, directory), now = Math.floor(Date.now() / 1000);
  await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.tokenAddress, abi: fixture.artifact('MockToken').abi,
    functionName: 'faucet', args: [fixture.accounts.outsider.address, 1_000_000n] }));
  await fixture.test.mine({ blocks: initial.profile.pins.confirmations + 1 });
  const profile = topUpProfileSchema.parse({ version: 1, kind: 'telomere-solana-usdc-topups-v1', localFixture: true,
    journalPath: resolve(directory, 'treasury-state', 'topups.json'),
    solana: { rpcUrl: source.endpoint, genesisHash: SOLANA_MAINNET_GENESIS, mint: SOLANA_USDC_MINT, tokenProgram: SOLANA_TOKEN_PROGRAM,
      recipient: fixtureSolanaRecipient, recipientAta: fixtureSolanaAta }, base: initial.profile.pins,
    notBefore: now - 60, expiresAt: now + 3600, maxInvoiceMicros: '250000', maxTotalCreditMicros: '1000000',
    maxInvoices: 8, maxWaitingInvoices: 8, invoiceSeconds: 900, authorizationSeconds: 600,
    feeBps: 0, maxRelayerGas: 1_000_000, maxRelayerFeePerGas: '10000000000', broadcastEnabled: true, ...overrides });
  const profilePath = resolve(directory, 'treasury-topups.json'), encoded = JSON.stringify(profile);
  await secureVaultIncomeTestFile(profilePath, encoded);
  const config = loadConfig({ MODE: 'demo', CHAIN_ID: '31337', RPC_URL: fixture.local.rpcUrl, DATA_DIR: resolve(directory, 'topup-db'),
    ESCROW_ADDRESS: fixture.legacyEscrow, TOKEN_ADDRESS: fixture.pins.tokenAddress, SIGNER_PRIVATE_KEY: fixture.keys.signer,
    DEMO_PRIVATE_KEY: fixture.keys.owner, HOST: '127.0.0.1', PORT: String(initial.config.PORT), PUBLIC_ORIGIN: initial.config.PUBLIC_ORIGIN,
    CPU_MODE: 'demo', CYSTS_ENABLED: 'false', LOG_LEVEL: 'error', TREASURY_TOPUP_CONFIG: profilePath,
    TREASURY_TOPUP_CONFIG_SHA256: createHash('sha256').update(encoded).digest('hex') });
  return { config, profile, profilePath };
}
