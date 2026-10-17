import { open, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, dirname, join } from 'node:path';
import { z } from 'zod';
import { nearReadinessSnapshot, type NearProviderReadiness, type NearReadinessReasonCode } from '../readiness.js';
import { sha256Hex } from './support.js';
import type { NvidiaLocalRuntime } from './attestation.js';

const maximumPolicyBytes = 1_048_576;
const hex = (bytes: number) => z.string().regex(new RegExp(`^[a-f0-9]{${bytes * 2}}$`, 'i'));
const measurementsSchema = z.object({ tee_tcb_svn: hex(16), mr_seam: hex(48), mr_signer_seam: hex(48),
  seam_attributes: hex(8), td_attributes: hex(8), xfam: hex(8), mr_td: hex(48), mr_config_id: hex(48),
  mr_owner: hex(48), mr_owner_config: hex(48), rt_mr0: hex(48), rt_mr1: hex(48), rt_mr2: hex(48), rt_mr3: hex(48) }).strict();
const profileSchema = z.object({ model: z.string().min(1).max(512), appComposeSha256: hex(32), composeManagerActionsSha256: hex(32),
  composeManagerImage: z.string().regex(/^nearaidev\/compose-manager@sha256:[a-f0-9]{64}$/), measurements: measurementsSchema,
  gpuCount: z.number().int().min(1).max(32), gpuModels: z.array(z.string().min(1).max(512)).min(1).max(32) }).passthrough();
const gatewaySchema = z.object({ appComposeSha256: hex(32), measurements: measurementsSchema }).passthrough();
// These identities are the implementation approved by the vendored Python verifier; no policy can choose a different native verifier.
const nvidiaSchema = z.union([z.object({ mode: z.literal('nras') }).strict(), z.object({ mode: z.literal('local'),
  sdkVersion: z.literal('1.2.2'), binarySha256: z.literal('ef4d6b63fc898081d45f39d836848b32e9579202c7b64664aa38350649c09ff6'),
  librarySha256: z.literal('088b827f0ce9f356afd4afcb27c22bfd71409268e7fc6d987b3331ca8d2a5c24') }).strict()]);
const policySchema = z.object({ schemaVersion: z.literal(1), version: z.string().min(1).max(128),
  validFrom: z.string().datetime({ offset: true }), validUntil: z.string().datetime({ offset: true }),
  maxSessionSeconds: z.number().int().min(1).max(300), profiles: z.array(profileSchema).min(1).max(32),
  gatewayProfiles: z.array(gatewaySchema).min(1).max(32).optional(), nvidiaVerifier: nvidiaSchema.optional() }).passthrough();

export type VerifiedNearReadinessOptions = { model: string; policyPath: string; policySha256: string;
  pythonPath: string; verifierPath: string; cloud: boolean; nvidiaLocal?: NvidiaLocalRuntime };

async function regularFile(path: string, maximum: number, executable = false): Promise<boolean> {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) return false;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum) return false;
    await access(path, executable && process.platform !== 'win32' ? constants.R_OK | constants.X_OK : constants.R_OK);
    return true;
  } catch { return false; }
}

/** Bounded local check. Native hashes, hardware and TLS are rechecked by live attestation, not by this probe. */
export async function checkVerifiedNearReadiness(options: VerifiedNearReadinessOptions): Promise<NearProviderReadiness> {
  let expiresAt: string | undefined;
  const unavailable = (reason: NearReadinessReasonCode) => nearReadinessSnapshot('unavailable', reason, 'enclave_verified', expiresAt);
  if (!isAbsolute(options.policyPath) || /[\0\r\n]/.test(options.policyPath)) return unavailable('POLICY_UNAVAILABLE');
  let bytes: Buffer;
  try {
    const file = await open(options.policyPath, 'r');
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) return unavailable('POLICY_UNAVAILABLE');
      if (metadata.size > maximumPolicyBytes) return unavailable('POLICY_TOO_LARGE');
      // A concurrently growing file cannot make this local health probe allocate/read without a bound.
      const buffer = Buffer.alloc(maximumPolicyBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const chunk = await file.read(buffer, size, buffer.length - size, null);
        if (!chunk.bytesRead) break;
        size += chunk.bytesRead;
      }
      if (size > maximumPolicyBytes) return unavailable('POLICY_TOO_LARGE');
      bytes = buffer.subarray(0, size);
    } finally { await file.close(); }
  } catch { return unavailable('POLICY_UNAVAILABLE'); }
  if (!/^0x[a-f0-9]{64}$/.test(options.policySha256) || sha256Hex(bytes) !== options.policySha256) return unavailable('POLICY_CHANGED');
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return unavailable('POLICY_INVALID'); }
  const result = policySchema.safeParse(raw);
  if (!result.success) return unavailable('POLICY_INVALID');
  const policy = result.data;
  const now = Date.now(), start = Date.parse(policy.validFrom), end = Date.parse(policy.validUntil);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return unavailable('POLICY_INVALID');
  expiresAt = new Date(end).toISOString();
  if (/^(?:development|candidate)(?:[-_.]|$)/i.test(policy.version)) return unavailable('POLICY_NOT_REVIEWED');
  if (!policy.profiles.some(profile => profile.model === options.model)) return unavailable('MODEL_NOT_APPROVED');
  if (start >= end) return unavailable('POLICY_INVALID');
  if (start > now) return unavailable('POLICY_NOT_YET_VALID');
  if (end <= now) return unavailable('POLICY_EXPIRED');
  if (options.cloud && !policy.gatewayProfiles?.length) return unavailable('GATEWAY_POLICY_MISSING');
  if ((policy.nvidiaVerifier?.mode ?? 'nras') !== (options.nvidiaLocal ? 'local' : 'nras')) return unavailable('NVIDIA_VERIFIER_MISMATCH');
  if (!await regularFile(options.pythonPath, Number.MAX_SAFE_INTEGER, true)) return unavailable('RUNTIME_UNAVAILABLE');
  if (!await regularFile(options.verifierPath, maximumPolicyBytes)
    || !await regularFile(join(dirname(options.verifierPath), 'verifier.py'), maximumPolicyBytes)) return unavailable('VERIFIER_UNAVAILABLE');
  if (options.nvidiaLocal) {
    if (!await regularFile(options.nvidiaLocal.binaryPath, 2_000_000, true)
      || !await regularFile(options.nvidiaLocal.libraryPath, 32_000_000)
      || !await regularFile(join(dirname(options.nvidiaLocal.libraryPath), 'libnvat.so.1'), 32_000_000)) return unavailable('NVIDIA_ARTIFACTS_UNAVAILABLE');
    if (process.platform !== 'linux' || process.arch !== 'x64') return unavailable('NVIDIA_RUNTIME_UNSUPPORTED');
  }
  return nearReadinessSnapshot('ready', 'CONFIGURATION_READY', 'enclave_verified', expiresAt);
}
