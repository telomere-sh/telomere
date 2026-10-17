import { configuredNearProvider } from '../src/providers/configured.js';
import { loadConfig } from '../src/config.js';
import { VerifiedProviderRequestRejectedError } from '../src/providers/index.js';

const provider = configuredNearProvider(loadConfig(process.env));
if (!provider || !('verifyAttestation' in provider)) throw new Error('Configure an independently reviewed verified NEAR provider');
try {
  const evidence = await provider.verifyAttestation(AbortSignal.timeout(60000));
  console.log(JSON.stringify({ status: 'verified', paidPosts: 0, checkedAt: new Date().toISOString(), evidence }));
} catch (error) {
  console.log(JSON.stringify({ status: 'rejected', paidPosts: 0, checkedAt: new Date().toISOString(),
    reason: error instanceof VerifiedProviderRequestRejectedError ? error.verificationReason : 'verification_failed',
    ...(error instanceof VerifiedProviderRequestRejectedError ? { reasonCode: error.reasonCode, ...(error.attestationFailure ? { attestationFailure: error.attestationFailure } : {}) } : {}) }));
  process.exitCode = 1;
}
