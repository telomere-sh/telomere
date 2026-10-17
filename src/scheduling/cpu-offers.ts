import { z } from 'zod';
import { canonical, moneySchema } from '../common.js';
import { paidInterruptibleCapabilitySchema } from './paid-lanes.js';

export const cpuSessionPricesSchema = z.object({ full: moneySchema, lean: moneySchema, torpor: moneySchema }).strict()
  .refine(value => BigInt(value.torpor) > 0n && BigInt(value.full) >= BigInt(value.lean) && BigInt(value.lean) >= BigInt(value.torpor),
    'CPU profile prices must be positive and decrease with resource quota');

/** Prices for a lane share the physical host, image, key, region and admission slot. */
export const cpuLaneOfferSchema = z.object({ lane: z.enum(['standard', 'interruptible']),
  pricePerSecond: moneySchema.refine(value => BigInt(value) > 0n, 'A posted CPU offer must have a positive price'),
  sessionPrices: cpuSessionPricesSchema.optional(), interruptible: paidInterruptibleCapabilitySchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.sessionPrices && value.sessionPrices.full !== value.pricePerSecond) context.addIssue({
    code: z.ZodIssueCode.custom, message: 'The full CPU profile must retain the posted lane price.' });
  if (value.lane === 'interruptible' && !value.interruptible) context.addIssue({
    code: z.ZodIssueCode.custom, message: 'Interruptible offers require explicit reviewed preemption capability.' });
});
export type CpuLaneOffer = z.infer<typeof cpuLaneOfferSchema>;
export const cpuLaneOffersSchema = z.object({ protocol: z.literal('telomere-cpu-lane-offers-v1'),
  offers: z.array(cpuLaneOfferSchema).min(1).max(2).refine(offers => new Set(offers.map(offer => offer.lane)).size === offers.length,
    'A physical host may post only one exact offer per lane'),
}).strict();
export type CpuLaneOffers = z.infer<typeof cpuLaneOffersSchema>;
type OfferHost = { lane: CpuLaneOffer['lane']; pricePerSecond: string; sessionPrices?: z.infer<typeof cpuSessionPricesSchema> | undefined;
  interruptible?: z.infer<typeof paidInterruptibleCapabilitySchema> | undefined; sessionEnabled?: boolean | undefined;
  laneOffers?: CpuLaneOffers | undefined };

/** Omission keeps the historical single-lane catalogue. A versioned catalogue must
 * include that exact base offer; it cannot silently alter existing quote semantics. */
export function assertCpuLaneOffers(host: OfferHost): void {
  if (!host.laneOffers) return;
  const declared = cpuLaneOffersSchema.parse(host.laneOffers);
  const base = declared.offers.find(offer => offer.lane === host.lane);
  const original = { lane: host.lane, pricePerSecond: host.pricePerSecond,
    ...(host.sessionPrices ? { sessionPrices: host.sessionPrices } : {}),
    ...(host.interruptible ? { interruptible: host.interruptible } : {}) };
  if (host.sessionEnabled !== true || !base || canonical(base) !== canonical(original)) {
    throw new Error('CPU lane offers require one reviewed session host and its unchanged exact base offer');
  }
}

/** Resolve a rate only from the independently reviewed host, never the quote. */
export function cpuLaneOffer(host: OfferHost, lane: CpuLaneOffer['lane']): CpuLaneOffer | undefined {
  assertCpuLaneOffers(host);
  if (host.laneOffers) return host.laneOffers.offers.find(offer => offer.lane === lane);
  return host.lane === lane ? { lane: host.lane, pricePerSecond: host.pricePerSecond,
    ...(host.sessionPrices ? { sessionPrices: host.sessionPrices } : {}),
    ...(host.interruptible ? { interruptible: host.interruptible } : {}) } : undefined;
}
