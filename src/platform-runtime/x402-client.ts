import { z } from 'zod';
import { keccak256, toHex, verifyTypedData, type Hex } from 'viem';
import { addressSchema, canonical, hashJson, sameAddress, signatureSchema } from '../common.js';
import { ApiTransport } from '../sdk/transport.js';
import type { FetchTransport } from '../sdk/types.js';
import { requestBinding } from '../payments/protocol.js';
import { x402CpuAuthorization, x402CpuOpenCall, x402CpuPaymentSchema, x402CpuRequired, x402CpuTypedData,
  type X402CpuPayment } from '../payments/cpu-reservations.js';
import { PlatformRuntimeClient } from './client.js';
import { platformPinsSchema, platformQuoteTypes, typedPlatformQuote, platformWorkloadHash,
  platformX402RequestSchema, platformX402ChallengeSchema, platformX402IntentSchema,
  type PlatformPins, type PlatformX402Challenge, type PlatformX402Intent } from './types.js';

type Request = z.infer<typeof platformX402RequestSchema>;
const idemSchema = z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/);
/** Explicit Telomere reservation extension. Never signs or broadcasts a payment. */
export class X402CpuReservationClient {
  private readonly transport: ApiTransport;
  private readonly runtime: PlatformRuntimeClient;
  private readonly pins: PlatformPins;
  private readonly now: () => number;
  constructor(options: { baseUrl: string; pins: PlatformPins; sessionToken?: string; fetch?: FetchTransport; nowSeconds?: () => number }) {
    this.pins = platformPinsSchema.parse(options.pins);
    if (!this.pins.x402CpuProfile) throw new Error('Explicit reviewed x402 CPU domain4 profile required');
    this.transport = new ApiTransport(options.baseUrl, options);
    this.runtime = new PlatformRuntimeClient({ ...options, cpuReceiptVersion: 1 });
    this.now = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }
  private request(raw: unknown): Request {
    const request = platformX402RequestSchema.parse(raw), input = request.input;
    if (input.funding || input.near || input.task.kind === 'session' || input.task.kind === 'near_inference' || input.cpuScheduling) throw new Error('X402 CPU supports EOA one-shot CPU receipt-v1 only');
    return request;
  }
  private async checked(raw: unknown, request: Request, allowExpired: boolean): Promise<PlatformX402Challenge> {
    const config = await this.runtime.config(), challenge = platformX402ChallengeSchema.parse(raw), q = challenge.quote, input = request.input;
    if (!config.pins.x402CpuProfile || config.cpuReceiptVersion === 2) throw new Error('X402 CPU receipt/profile changed');
    const owner = z.object({ address: addressSchema, demo: z.boolean() }).strict().parse(await this.transport.request('/api/me')).address;
    const host = config.capacity.find(value => value.hostId === q.hostId), now = this.now(), base = BigInt(q.maxSeconds) * BigInt(q.pricePerSecond),
      ceiling = base + (base * 900n + 9999n) / 10000n, reservation = challenge.reservation;
    if (!host || host.lane !== 'standard' || q.inferencePrice !== '0' || !sameAddress(q.payer, owner) || canonical(challenge.input) !== canonical(input)
      || q.leashId !== input.leashId || q.maxSeconds !== input.maxSeconds || q.pricePerSecond !== host.pricePerSecond || q.hwClass !== 0
      || input.excludedHostIds?.includes(host.hostId) || input.regions.length && !input.regions.includes(host.region)
      || input.task.kind === 'exec' && (host.execEnabled !== true || input.task.imageDigest !== host.imageDigest)
      || q.imageHash !== keccak256(toHex(host.imageDigest)) || q.regionHash !== keccak256(toHex(host.region)) || q.workloadHash !== platformWorkloadHash(input)
      || base <= 0n || ceiling.toString() !== challenge.ceiling || ceiling > BigInt(input.maxSpend) || ceiling > 250_000_000n
      || !Number.isSafeInteger(now) || !allowExpired && q.quoteExpiry < now || q.quoteExpiry + q.maxSeconds > input.deadline
      || reservation.validBefore !== q.quoteExpiry || reservation.scheme !== request.scheme || reservation.resourceUrl !== this.transport.origin + '/api/platform/cells'
      || reservation.requestHash !== requestBinding('POST', reservation.resourceUrl, Buffer.from(canonical(request)))
      || reservation.maximum !== (request.scheme === 'exact' ? challenge.ceiling : (BigInt(input.maxSpend) < 250_000_000n ? input.maxSpend : '250000000'))
      || reservation.validAfter > reservation.validBefore || reservation.validBefore - reservation.validAfter > 121
      || canonical(challenge.disclosure).toLowerCase() !== canonical({ extension: 'telomere-cpu-reservation-v1', immediateDebit: challenge.ceiling,
        refundBeneficiary: q.payer, unusedFunds: 'escrow_balance_withdrawable_by_original_eoa', externalWalletGas: true, receiptVersion: 1 }).toLowerCase()
      || canonical(challenge.paymentRequired).toLowerCase() !== canonical(x402CpuRequired(this.pins, q, challenge.ceiling, reservation)).toLowerCase()) {
      throw new Error('CPU challenge changed its original owner, work, resource, immediate debit, refund recipient or explicit extension');
    }
    if (!await verifyTypedData({ address: this.pins.quoteSigner,
      domain: { name: 'TelomerePlatformEscrow', version: '4', chainId: this.pins.chainId, verifyingContract: this.pins.escrowAddress },
      types: platformQuoteTypes, primaryType: 'PlatformQuote', message: typedPlatformQuote(q), signature: challenge.signature })) throw new Error('X402 CPU quote signature is invalid');
    return challenge;
  }
  async challenge(raw: unknown, idempotencyKey: string): Promise<PlatformX402Challenge> {
    const request = this.request(raw), response = z.object({ error: z.literal('payment_required'), challenge: platformX402ChallengeSchema }).strict().parse(
      await this.transport.request('/api/platform/cells', { method: 'POST', body: { request }, idempotencyKey: idemSchema.parse(idempotencyKey), acceptCpuPaymentRequired: true }));
    return this.checked(response.challenge, request, false);
  }
  async typedData(rawChallenge: unknown, rawRequest: unknown) {
    const request = this.request(rawRequest), challenge = await this.checked(rawChallenge, request, false);
    return x402CpuTypedData(this.pins, challenge.quote, challenge.ceiling, challenge.reservation);
  }
  async payment(rawChallenge: unknown, rawRequest: unknown, signature: Hex): Promise<X402CpuPayment> {
    const request = this.request(rawRequest), challenge = await this.checked(rawChallenge, request, false), required = x402CpuRequired(this.pins, challenge.quote, challenge.ceiling, challenge.reservation),
      authorization = x402CpuAuthorization(this.pins, challenge.quote, challenge.ceiling, challenge.reservation), checkedSignature = signatureSchema.parse(signature);
    return x402CpuPaymentSchema.parse({ x402Version: 2, resource: required.resource, accepted: required.accepts[0], extensions: required.extensions,
      payload: authorization.signatureType === 'ReceiveWithAuthorization' ? { signature: checkedSignature, authorization: authorization.authorization }
        : { signature: checkedSignature, permit2Authorization: authorization.permit2Authorization } });
  }
  async intent(rawRequest: unknown, rawPayment: unknown, idempotencyKey: string): Promise<PlatformX402Intent> {
    const request = this.request(rawRequest), payment = x402CpuPaymentSchema.parse(rawPayment), result = platformX402IntentSchema.parse(
      await this.transport.request('/api/platform/cells', { method: 'POST', body: { request, payment }, idempotencyKey: idemSchema.parse(idempotencyKey) }));
    const challenge = await this.checked(result.challenge, request, result.state === 'retained_external_wallet_intent'),
      data = x402CpuOpenCall(this.pins, challenge.quote, challenge.signature, challenge.imageProof, challenge.regionProof, challenge.ceiling, challenge.reservation, payment);
    if (result.paymentHash !== hashJson(payment) || result.transaction.chainId !== this.pins.chainId || !sameAddress(result.transaction.to, this.pins.escrowAddress)
      || result.transaction.data !== data || result.transaction.value !== '0') throw new Error('X402 CPU wallet intent differs from its original signed payment and reservation');
    return result;
  }
  admit(intent: PlatformX402Intent, transactionHash: Hex, idempotencyKey: string) {
    const checked = platformX402IntentSchema.parse(intent);
    return this.runtime.admit({ runId: checked.challenge.quote.runId, transactionHash }, idempotencyKey);
  }
}
