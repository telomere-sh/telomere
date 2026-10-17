import { z } from 'zod';

/** Akash DecCoin bid prices are decimal micro-ACT per block, with up to 18 places.
 * Keep their exact atoms; Number would silently change small or large bids. */
const SCALE = 10n ** 18n;
const priceText = z.string().regex(/^(0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/);

export function akashPriceAtoms(value: string): bigint {
  const [whole, fraction = ''] = priceText.parse(value).split('.');
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(18, '0') || '0');
}

export function canonicalAkashPrice(value: string): string {
  const atoms = akashPriceAtoms(value);
  if (atoms === 0n) throw new Error('Akash bid price must be positive');
  const whole = atoms / SCALE, fraction = (atoms % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export const akashRemotePriceSchema = priceText.refine(value => akashPriceAtoms(value) > 0n);
/** Journal and EIP-712 text has one spelling. Historical integer prices already satisfy it. */
export const akashCanonicalPriceSchema = akashRemotePriceSchema.refine(value => value === canonicalAkashPrice(value));

export function sameAkashPrice(left: string, right: string): boolean {
  return akashPriceAtoms(left) === akashPriceAtoms(right);
}

/** Conservative whole-uact treasury hold. Round once after blocks and buffer. */
export function reservedAkashUact(price: string, blocks: bigint, bufferBps: bigint): bigint {
  if (blocks <= 0n || bufferBps < 0n || bufferBps > 300n) throw new Error('Invalid Akash reserve policy');
  const atoms = akashPriceAtoms(price);
  if (atoms === 0n) throw new Error('Akash bid price must be positive');
  const numerator = atoms * blocks * (10_000n + bufferBps);
  const denominator = SCALE * 10_000n;
  return (numerator + denominator - 1n) / denominator;
}
