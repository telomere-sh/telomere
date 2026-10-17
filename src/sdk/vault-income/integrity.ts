import { recoverTypedDataAddress, type Hex } from 'viem';
import { EIP3009_TYPES } from '../../payments/gateway.js';
import { canonical, digest, encodePaymentHeader, paymentPayloadSchema, requestBinding, type PaymentPayload } from '../../payments/protocol.js';
import { VaultIncomeClientError, vaultIncomePublicProfileSchema, type VaultIncomePublicProfile, type VaultIncomePlan,
  type VaultIncomeAttempt, type VaultIncomeTypedData } from './types.js';

export function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
export function reviewedVaultIncomeProfile(raw: VaultIncomePublicProfile): Readonly<VaultIncomePublicProfile> {
  const parsed = vaultIncomePublicProfileSchema.parse(raw), { assetImplementation, ...base } = parsed.pins;
  return immutable({ resourceUrl: parsed.resourceUrl, grossAmount: parsed.grossAmount,
    pins: { ...base, ...(assetImplementation ? { assetImplementation } : {}) } });
}
export function vaultIncomeTypedData(plan: VaultIncomePlan, profile: VaultIncomePublicProfile): VaultIncomeTypedData {
  const auth = plan.authorization;
  return immutable({ domain: { name: profile.pins.exact.name, version: profile.pins.exact.version,
    chainId: profile.pins.chainId, verifyingContract: profile.pins.asset }, types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization', message: { ...auth, value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) } });
}
export function assertVaultIncomePlan(plan: VaultIncomePlan, profile: VaultIncomePublicProfile): void {
  const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase(), terms = plan.accepted, auth = plan.authorization;
  if (plan.profileHash !== digest(profile) || plan.resource.url !== profile.resourceUrl || terms.scheme !== 'exact'
    || terms.network !== `eip155:${profile.pins.chainId}` || !equal(terms.asset, profile.pins.asset)
    || !equal(terms.payTo, profile.pins.payTo) || terms.amount !== profile.grossAmount
    || terms.extra.assetTransferMethod !== 'eip3009' || !equal(terms.extra.facilitatorAddress, profile.pins.facilitator)
    || terms.extra.name !== profile.pins.exact.name || terms.extra.version !== profile.pins.exact.version
    || terms.extra.telomere.requestHash !== requestBinding('POST', profile.resourceUrl, Buffer.from('{}'))
    || !equal(auth.to, profile.pins.payTo) || auth.value !== profile.grossAmount || auth.nonce !== terms.extra.telomere.nonce
    || BigInt(auth.validBefore) <= BigInt(auth.validAfter) || BigInt(auth.validBefore) - BigInt(auth.validAfter) > 420n) {
    throw new VaultIncomeClientError('vault_income_plan_mismatch');
  }
}
export function vaultIncomePayment(plan: VaultIncomePlan, signature: Hex): PaymentPayload {
  return paymentPayloadSchema.parse({ x402Version: 2, resource: plan.resource, accepted: plan.accepted,
    payload: { authorization: plan.authorization, signature }, extensions: { 'telomere-request-binding': {
      version: 1, requestHash: plan.accepted.extra.telomere.requestHash } } });
}
export async function assertVaultIncomeAttempt(attempt: VaultIncomeAttempt, profile: VaultIncomePublicProfile): Promise<void> {
  assertVaultIncomePlan(attempt.plan, profile);
  if (Boolean(attempt.signature) !== Boolean(attempt.signedHeader) || attempt.submitted && !attempt.signature
    || attempt.candidateHash && !attempt.submitted || attempt.observation && (!attempt.candidateHash
      || attempt.observation.transactionHash !== attempt.candidateHash)) throw new VaultIncomeClientError('vault_income_journal_invalid');
  if (attempt.signature) {
    const signature = attempt.signature as Hex, payment = vaultIncomePayment(attempt.plan, signature);
    if (attempt.signedHeader !== encodePaymentHeader(payment)) throw new VaultIncomeClientError('vault_income_journal_invalid');
    try { const signer = await recoverTypedDataAddress({ ...vaultIncomeTypedData(attempt.plan, profile), signature });
      if (signer.toLowerCase() !== attempt.plan.authorization.from.toLowerCase()) throw new Error('payer');
    } catch { throw new VaultIncomeClientError('vault_income_signature_mismatch'); }
  }
}
export function sameVaultIncomeValue(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
