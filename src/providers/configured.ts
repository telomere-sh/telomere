import type { Config } from '../config.js';
import { createNearProvider, type NearProvider } from './near.js';
import { createVerifiedNearProvider, type VerifiedNearProvider } from './verified/index.js';

export function configuredNearProvider(config: Config): NearProvider | VerifiedNearProvider | undefined {
  if (!(config.NEAR_ENDPOINT && config.NEAR_MODEL && config.NEAR_API_KEY)) return undefined;
  const options = { endpoint: config.NEAR_ENDPOINT, model: config.NEAR_MODEL, apiKey: config.NEAR_API_KEY,
    allowedModels: (config.NEAR_ALLOWED_MODELS ?? '').split(',').map(item => item.trim()), maxTokens: config.MAX_TOKENS };
  if (config.NEAR_VERIFICATION_MODE === 'provider_tls') return createNearProvider(options);
  if (!(config.NEAR_VERIFIER_PYTHON && config.NEAR_ATTESTATION_POLICY && config.NEAR_ATTESTATION_POLICY_SHA256)) throw new Error('Verified provider configuration incomplete');
  return createVerifiedNearProvider({ ...options, pythonPath: config.NEAR_VERIFIER_PYTHON, policyPath: config.NEAR_ATTESTATION_POLICY,
    policySha256: config.NEAR_ATTESTATION_POLICY_SHA256, ...(config.NEAR_VERIFIER_PATH ? { verifierPath: config.NEAR_VERIFIER_PATH } : {}),
    ...(config.NEAR_NVIDIA_VERIFIER_MODE === 'local' && config.NEAR_NVAT_BINARY && config.NEAR_NVAT_LIBRARY
      ? { nvidiaLocal: { binaryPath: config.NEAR_NVAT_BINARY, libraryPath: config.NEAR_NVAT_LIBRARY } } : {}) });
}
