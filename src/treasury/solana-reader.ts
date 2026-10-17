import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { z } from 'zod';
import { hashJson } from '../common.js';
import { incomeStrictJson } from '../selection/income-endpoints/json.js';
import { SOLANA_TOKEN_PROGRAM, type SolanaTopUpProof, type TopUpProfile, solanaKey, solanaSignature, sourceProofSchema } from './types.js';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function decodeBase58(value: string): Buffer {
  if (!value || value.length > 128) throw new Error('Invalid base58 value');
  let number = 0n;
  for (const character of value) { const digit = alphabet.indexOf(character); if (digit < 0) throw new Error('Invalid base58 value'); number = number * 58n + BigInt(digit); }
  const bytes: number[] = [];
  while (number) { bytes.unshift(Number(number & 255n)); number >>= 8n; }
  for (const character of value) { if (character !== '1') break; bytes.unshift(0); }
  return Buffer.from(bytes);
}
export function encodeBase58(value: Uint8Array): string {
  let number = 0n; for (const byte of value) number = (number << 8n) + BigInt(byte);
  let text = ''; while (number) { text = alphabet[Number(number % 58n)] + text; number /= 58n; }
  for (const byte of value) { if (byte !== 0) break; text = '1' + text; }
  return text;
}
function publicKey(value: string): Buffer {
  const bytes = decodeBase58(solanaKey.parse(value)); if (bytes.length !== 32 || encodeBase58(bytes) !== value) throw new Error('Invalid Solana public key'); return bytes;
}
/** Canonical classic-SPL ATA; off-curve PDA derivation, not an operator assertion. */
export function associatedTokenAddress(owner: string, mint: string): string {
  const seeds = [publicKey(owner), publicKey(SOLANA_TOKEN_PROGRAM), publicKey(mint)];
  const program = publicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  for (let bump = 255; bump >= 0; bump--) {
    const digest = createHash('sha256').update(Buffer.concat([...seeds, Buffer.from([bump]), program, Buffer.from('ProgramDerivedAddress')])).digest();
    try { ed25519.ExtendedPoint.fromHex(digest); } catch { return encodeBase58(digest); }
  }
  throw new Error('Associated token account is unavailable');
}
const index = z.number().int().min(0).max(255);
const transactionSchema = z.object({ slot: z.number().int().nonnegative().safe(), blockTime: z.number().int().positive().safe(),
  version: z.literal('legacy'), transaction: z.object({ signatures: z.array(solanaSignature).min(1).max(16),
    message: z.object({ accountKeys: z.array(solanaKey).min(1).max(64),
      header: z.object({ numRequiredSignatures: index, numReadonlySignedAccounts: index, numReadonlyUnsignedAccounts: index }),
      instructions: z.array(z.object({ programIdIndex: index, accounts: z.array(index).max(32), data: z.string().min(1).max(512) })).min(1).max(64),
    }) }), meta: z.object({ err: z.null(),
      preTokenBalances: z.array(z.object({ accountIndex: index, mint: solanaKey, owner: solanaKey,
        uiTokenAmount: z.object({ amount: z.string().regex(/^(0|[1-9][0-9]{0,19})$/), decimals: z.number().int() }) })).max(64),
      postTokenBalances: z.array(z.object({ accountIndex: index, mint: solanaKey, owner: solanaKey,
        uiTokenAmount: z.object({ amount: z.string().regex(/^(0|[1-9][0-9]{0,19})$/), decimals: z.number().int() }) })).max(64),
    }) });

/** Read methods only. The configured RPC is a trusted finality observation,
 * not an independently verified Solana consensus proof. */
export class SolanaTopUpReader {
  constructor(readonly pins: TopUpProfile['solana'], private readonly fetchImpl: typeof fetch = fetch) {
    const url = new URL(pins.rpcUrl);
    if (url.username || url.password || url.hash || url.protocol !== 'https:'
      && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Reviewed Solana RPC transport differs');
    publicKey(pins.genesisHash); publicKey(pins.recipient); publicKey(pins.mint);
    if (associatedTokenAddress(pins.recipient, pins.mint) !== pins.recipientAta) throw new Error('Reviewed treasury ATA differs');
  }
  private async rpc(method: 'getGenesisHash' | 'getAccountInfo' | 'getTransaction' | 'getSignatureStatuses' | 'getBlock', params: unknown[] = []): Promise<unknown> {
    const response = await this.fetchImpl(this.pins.rpcUrl, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('application/json') || !response.body) throw new Error('Solana read-only RPC unavailable');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length;
      if (size > 262_144) throw new Error('Solana read-only RPC exceeds its bound'); chunks.push(item.value); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const value = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.unknown() }).strict()
      .parse(incomeStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
    return value.result;
  }
  async check(): Promise<void> {
    if (await this.rpc('getGenesisHash') !== this.pins.genesisHash) throw new Error('Solana cluster differs');
    const account = z.object({ value: z.object({ owner: z.literal(SOLANA_TOKEN_PROGRAM), executable: z.literal(false),
      data: z.object({ parsed: z.object({ type: z.literal('account'), info: z.object({ mint: solanaKey, owner: solanaKey,
        state: z.literal('initialized'), tokenAmount: z.object({ decimals: z.literal(6) }) }) }) }) }) })
      .parse(await this.rpc('getAccountInfo', [this.pins.recipientAta, { commitment: 'finalized', encoding: 'jsonParsed' }]));
    if (account.value.data.parsed.info.mint !== this.pins.mint || account.value.data.parsed.info.owner !== this.pins.recipient) {
      throw new Error('Solana treasury token account differs');
    }
  }
  async verify(signatureValue: string, invoice: { reference: string; amountMicros: string; createdAt: number; expiresAt: number }): Promise<SolanaTopUpProof> {
    const signature = solanaSignature.parse(signatureValue);
    if (decodeBase58(signature).length !== 64) throw new Error('Invalid Solana transaction signature');
    await this.check();
    const raw = await this.rpc('getTransaction', [signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }]);
    const transaction = transactionSchema.parse(raw);
    if (transaction.transaction.signatures[0] !== signature || transaction.blockTime < invoice.createdAt || transaction.blockTime > invoice.expiresAt) throw new Error('Solana source binding or payment window differs');
    const { message } = transaction.transaction, instructionIndex = message.instructions.length - 1;
    const instruction = message.instructions[instructionIndex]; if (!instruction) throw new Error('Missing Solana transfer');
    const keys = message.accountKeys, accounts = instruction.accounts.map(position => keys[position]);
    const header = message.header, referenceIndex = instruction.accounts[4];
    if (keys[instruction.programIdIndex] !== this.pins.tokenProgram || accounts.length !== 5 || accounts[1] !== this.pins.mint
      || accounts[2] !== this.pins.recipientAta || accounts[4] !== invoice.reference || referenceIndex === undefined
      || referenceIndex < header.numRequiredSignatures || referenceIndex < keys.length - header.numReadonlyUnsignedAccounts
      || accounts.some(account => account === undefined)
      || header.numRequiredSignatures < 1 || header.numRequiredSignatures !== transaction.transaction.signatures.length
      || header.numReadonlySignedAccounts > header.numRequiredSignatures
      || header.numReadonlyUnsignedAccounts > keys.length - header.numRequiredSignatures
      || new Set(keys).size !== keys.length) throw new Error('Solana exact TransferChecked/reference binding differs');
    const data = decodeBase58(instruction.data);
    if (data.length !== 10 || data[0] !== 12 || data[9] !== 6 || data.readBigUInt64LE(1).toString() !== invoice.amountMicros) throw new Error('Solana USDC transfer amount differs');
    // Reject token instructions earlier in the same transaction: their net
    // effects could otherwise make an unrelated reference appear to fund us.
    if (message.instructions.slice(0, -1).some(item => keys[item.programIdIndex] === this.pins.tokenProgram)) throw new Error('Multiple Solana token instructions are unsupported');
    const destinationIndex = instruction.accounts[2];
    const matches = (values: typeof transaction.meta.postTokenBalances) => values.filter(value => value.accountIndex === destinationIndex);
    const before = matches(transaction.meta.preTokenBalances), after = matches(transaction.meta.postTokenBalances);
    if (before.length !== 1 || after.length !== 1 || !before[0] || !after[0]
      || [...before, ...after].some(value => value.mint !== this.pins.mint || value.owner !== this.pins.recipient || value.uiTokenAmount.decimals !== 6)
      || BigInt(after[0].uiTokenAmount.amount) - BigInt(before[0].uiTokenAmount.amount) !== BigInt(invoice.amountMicros)) throw new Error('Solana treasury token delta differs');
    const status = z.object({ value: z.tuple([z.object({ slot: z.number().int().nonnegative().safe(), err: z.null(),
      confirmationStatus: z.literal('finalized') })]) }).parse(await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]));
    if (status.value[0].slot !== transaction.slot) throw new Error('Solana source finality slot differs');
    const block = z.object({ blockhash: solanaKey, signatures: z.array(solanaSignature).min(1).max(4096) })
      .parse(await this.rpc('getBlock', [transaction.slot, { commitment: 'finalized', transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 0 }]));
    if (block.signatures.filter(value => value === signature).length !== 1) throw new Error('Solana finalized block does not contain source');
    publicKey(block.blockhash);
    return sourceProofSchema.parse({ genesisHash: this.pins.genesisHash, signature, slot: transaction.slot, blockHash: block.blockhash,
      instructionIndex, mint: this.pins.mint, recipient: this.pins.recipient, recipientAta: this.pins.recipientAta,
      reference: invoice.reference, amountMicros: invoice.amountMicros, proofHash: hashJson(raw) });
  }
}
