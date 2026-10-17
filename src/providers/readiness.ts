import type { NearProvider } from './near.js';

export const nearReadinessReasonCodes = ['NOT_CONFIGURED', 'CONFIGURATION_READY', 'TLS_ONLY', 'READINESS_UNSUPPORTED',
  'READINESS_CHECK_FAILED', 'POLICY_UNAVAILABLE', 'POLICY_TOO_LARGE', 'POLICY_CHANGED', 'POLICY_INVALID',
  'POLICY_NOT_REVIEWED', 'MODEL_NOT_APPROVED', 'POLICY_NOT_YET_VALID', 'POLICY_EXPIRED', 'GATEWAY_POLICY_MISSING',
  'RUNTIME_UNAVAILABLE', 'VERIFIER_UNAVAILABLE', 'NVIDIA_VERIFIER_MISMATCH', 'NVIDIA_ARTIFACTS_UNAVAILABLE',
  'NVIDIA_RUNTIME_UNSUPPORTED'] as const;
export type NearReadinessReasonCode = typeof nearReadinessReasonCodes[number];

/** Readiness is a local configuration check. It cannot authorize or attest a live inference. */
export type NearProviderReadiness = {
  state: 'ready' | 'unavailable' | 'disabled';
  reasonCode: NearReadinessReasonCode;
  checkedAt: string;
  verification: 'enclave_verified' | 'provider_tls' | null;
  scope: 'local_configuration';
  liveAttestationChecked: false;
  policyExpiresAt?: string;
};

export function nearReadinessSnapshot(state: NearProviderReadiness['state'], reasonCode: NearReadinessReasonCode,
  verification: NearProviderReadiness['verification'], policyExpiresAt?: string): NearProviderReadiness {
  return { state, reasonCode, checkedAt: new Date().toISOString(), verification,
    scope: 'local_configuration', liveAttestationChecked: false, ...(policyExpiresAt ? { policyExpiresAt } : {}) };
}

/** Never calls complete(), performs a report GET, runs a subprocess, or exposes raw provider/config errors. */
export async function getNearProviderReadiness(provider?: NearProvider): Promise<NearProviderReadiness> {
  if (!provider) return nearReadinessSnapshot('disabled', 'NOT_CONFIGURED', null);
  if (!provider.readiness) return nearReadinessSnapshot('unavailable', 'READINESS_UNSUPPORTED', null);
  try { return await provider.readiness(); }
  catch { return nearReadinessSnapshot('unavailable', 'READINESS_CHECK_FAILED', null); }
}
