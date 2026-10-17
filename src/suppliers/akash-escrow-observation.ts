import { z } from 'zod';
import { akashAddressSchema, akashDseqSchema } from './akash-console.js';
import { akashRemotePriceSchema, sameAkashPrice } from './akash-price.js';
import { supplierRecordSchema, type SupplierRecord } from './ledger.js';

const whole = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const chainDecimal = z.string().regex(/^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/);
const coin = z.object({ denom: z.string().min(1).max(64), amount: chainDecimal });
const lease = z.object({
  id: z.object({ owner: akashAddressSchema, dseq: akashDseqSchema,
    gseq: z.number().int().positive().safe(), oseq: z.number().int().positive().safe(),
    provider: akashAddressSchema }),
  state: z.enum(['active', 'closed']),
  price: z.object({ denom: z.string().min(1).max(64), amount: akashRemotePriceSchema }),
});
const responseSchema = z.object({ data: z.object({
  deployment: z.object({ id: z.object({ owner: akashAddressSchema, dseq: akashDseqSchema }),
    state: z.enum(['active', 'closed']), hash: z.string().min(1).max(256) }),
  leases: z.array(lease).max(64),
  escrow_account: z.object({
    id: z.object({ scope: z.literal('deployment'), xid: z.string().min(1).max(256) }),
    state: z.object({ owner: akashAddressSchema, state: z.enum(['open', 'closed', 'overdrawn']),
      settled_at: whole, funds: z.array(coin).max(32), transferred: z.array(coin).max(32),
      deposits: z.array(z.unknown()).max(128) }),
  }),
}) });

const observationSchema = z.object({
  reservationId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  akashOwner: akashAddressSchema, dseq: akashDseqSchema,
  deploymentState: z.enum(['active', 'closed']),
  leaseState: z.enum(['active', 'closed', 'not_listed']),
  escrowState: z.enum(['open', 'closed', 'overdrawn']), settledAtHeight: whole,
  /** Integer units of 10^-18 uact; never convert these to JS Number. */
  fundsUactAtoms: z.string().regex(/^-?(?:0|[1-9][0-9]*)$/),
  transferredUactAtoms: z.string().regex(/^(0|[1-9][0-9]*)$/),
  transferredDeltaUactAtoms: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  observedAtMs: z.number().int().nonnegative().safe(),
  /** The Console GET is an observation, not a final invoice or refund proof. */
  settlementConfirmed: z.literal(false), reserveReleaseEligible: z.literal(false),
}).strict();
export type AkashEscrowObservation = z.infer<typeof observationSchema>;

const SCALE = 10n ** 18n;
function atoms(value: string): bigint {
  const negative = value.startsWith('-');
  const [wholePart, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const magnitude = BigInt(wholePart ?? '0') * SCALE + BigInt(fraction.padEnd(18, '0') || '0');
  return negative ? -magnitude : magnitude;
}
function sumUact(coins: { denom: string; amount: string }[], signed: boolean): bigint {
  let sum = 0n;
  for (const value of coins) {
    if (value.denom !== 'uact') throw new Error('Akash escrow has an unsupported denomination');
    const amount = atoms(value.amount);
    if (!signed && amount < 0n) throw new Error('Akash transferred amount is negative');
    sum += amount;
  }
  return sum;
}

/** Inspect raw chain-denominated Console fields without treating them as Telomere billing. */
export function observeAkashEscrow(raw: unknown, recordValue: SupplierRecord,
  previousValue?: AkashEscrowObservation, now = Date.now()): AkashEscrowObservation {
  const record = supplierRecordSchema.parse(recordValue);
  const { data } = responseSchema.parse(raw);
  const { deployment, leases, escrow_account: account } = data;
  if (deployment.id.owner !== record.akashOwner || deployment.id.dseq !== record.dseq
    || deployment.hash !== record.deploymentHash || account.state.owner !== record.akashOwner
    || account.id.xid !== `${record.akashOwner}/${record.dseq}`) {
    throw new Error('Akash escrow deployment identity or manifest changed');
  }
  if (leases.length > 1) throw new Error('Akash escrow has more than one lease');
  const listed = leases[0];
  if (listed && (listed.id.owner !== record.akashOwner || listed.id.dseq !== record.dseq
    || listed.id.gseq !== record.gseq || listed.id.oseq !== record.oseq
    || listed.id.provider !== record.provider || listed.price.denom !== 'uact'
    || !sameAkashPrice(listed.price.amount, record.pricePerBlockUact))) {
    throw new Error('Akash escrow lease identity or price changed');
  }
  if (deployment.state === 'active' && (!listed || listed.state !== 'active')) {
    throw new Error('Akash active deployment has no pinned active lease');
  }
  if (deployment.state === 'closed' && listed?.state === 'active') {
    throw new Error('Akash closed deployment still lists an active lease');
  }
  const funds = sumUact(account.state.funds, true);
  const transferred = sumUact(account.state.transferred, false);
  const previous = previousValue === undefined ? undefined : observationSchema.parse(previousValue);
  if (previous && (previous.reservationId !== record.id || previous.akashOwner !== record.akashOwner
    || previous.dseq !== record.dseq || BigInt(account.state.settled_at) < BigInt(previous.settledAtHeight)
    || transferred < BigInt(previous.transferredUactAtoms))) {
    throw new Error('Akash escrow observation regressed or belongs to another reservation');
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Akash observation time is invalid');
  return observationSchema.parse({ reservationId: record.id, akashOwner: record.akashOwner, dseq: record.dseq,
    deploymentState: deployment.state, leaseState: listed?.state ?? 'not_listed',
    escrowState: account.state.state, settledAtHeight: account.state.settled_at,
    fundsUactAtoms: funds.toString(), transferredUactAtoms: transferred.toString(),
    transferredDeltaUactAtoms: previous ? (transferred - BigInt(previous.transferredUactAtoms)).toString() : null,
    observedAtMs: now, settlementConfirmed: false, reserveReleaseEligible: false });
}

/** Read-only, bounded Console transport for an operator's exact supplier reservation. */
export class AkashConsoleEscrowObserver {
  private readonly base = 'https://console-api.akash.network';
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {
    if (!apiKey || apiKey.length > 1024 || /[\r\n]/.test(apiKey)) throw new Error('Akash API key is required for escrow observation');
  }
  async observe(record: SupplierRecord, previous?: AkashEscrowObservation): Promise<AkashEscrowObservation> {
    const pinned = supplierRecordSchema.parse(record);
    try {
      const response = await this.fetchImpl(this.base + '/v1/deployments/' + pinned.dseq, {
        method: 'GET', redirect: 'error', headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error('Akash Console escrow GET failed');
      if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json') || !response.body)
        throw new Error('Akash Console escrow response is not JSON');
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > 1_048_576) throw new Error('Akash Console escrow response is too large');
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))) as unknown;
      return observeAkashEscrow(raw, pinned, previous);
    } catch {
      // Fetch/JSON errors may echo a credential in their message; never propagate them.
      throw new Error('Akash escrow observation unavailable');
    }
  }
}
