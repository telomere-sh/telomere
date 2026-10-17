import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { addressSchema } from '../src/common.js';
import { createReceiptRootReader, verifyHourlyReceipt } from '../src/receipts/index.js';

const pinsSchema = z.object({ chainId: z.number().int().positive().safe(), escrowAddress: addressSchema,
  tokenAddress: addressSchema, receiptSigner: addressSchema, receiptRootAddress: addressSchema.optional() }).strict();
async function boundedJson(path: string, maxBytes: number): Promise<unknown> {
  const handle = await open(resolve(path), 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maxBytes) throw new Error('Verification input exceeds its file limit');
    const bytes = Buffer.alloc(metadata.size + 1); let position = 0;
    while (position < bytes.length) {
      const read = await handle.read(bytes, position, bytes.length - position, position);
      if (!read.bytesRead) break; position += read.bytesRead;
    }
    if (position !== metadata.size) throw new Error('Verification input changed during its bounded read');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, position)));
  } finally { await handle.close(); }
}
export async function verifyReceiptProofCommand(args: readonly string[]): Promise<void> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key || !['--proof', '--pins', '--rpc'].includes(key) || !value || values[key]) throw new Error('Use --proof FILE --pins FILE [--rpc HTTPS_OR_LOOPBACK_RPC]');
    values[key] = value;
  }
  if (!values['--proof'] || !values['--pins']) throw new Error('Use --proof FILE --pins FILE [--rpc HTTPS_OR_LOOPBACK_RPC]');
  const parsedPins = pinsSchema.parse(await boundedJson(values['--pins'], 4096));
  const pins = { chainId: parsedPins.chainId, escrowAddress: parsedPins.escrowAddress,
    tokenAddress: parsedPins.tokenAddress, receiptSigner: parsedPins.receiptSigner,
    ...(parsedPins.receiptRootAddress === undefined ? {} : { receiptRootAddress: parsedPins.receiptRootAddress }) };
  const proof = await boundedJson(values['--proof'], 262_144);
  const rpc = values['--rpc'];
  if (rpc && !pins.receiptRootAddress) throw new Error('An independently reviewed ReceiptRoot address is required for the RPC check');
  const result = await verifyHourlyReceipt(proof, pins, rpc ? createReceiptRootReader(rpc) : undefined);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.valid || (rpc !== undefined && !result.onchain_verified)) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await verifyReceiptProofCommand(process.argv.slice(2)); }
  catch { process.stderr.write('Receipt proof verification failed: check the bounded proof, reviewed pins, and optional RPC.\n'); process.exitCode = 1; }
}
