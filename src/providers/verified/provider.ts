import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { AmbiguousProviderError, ProviderRequestRejectedError, approvedNearEndpoint, nearCompletionInputSchema,
  type NearProvider, type NearCompletionResult, type NearProviderOptions, type AmbiguousProviderReason } from "../near.js";
import { createNearAttestationVerifier, defaultNearVerifierPath, nvidiaVerifierOptions, type NvidiaLocalRuntime } from "./attestation.js";
import { assertVerifiedSession, createNearInference, getNearInferenceFailure, type NearAttestationVerifier, type NearInferenceResult } from "./inference.js";
import { sha256Hex } from "./support.js";
import { createNearAttestationError, getNearAttestationFailure, type NearAttestationFailure } from "./attestation-error.js";
import { checkVerifiedNearReadiness } from './readiness.js';
import type { NearProviderReadiness } from '../readiness.js';

export type VerifiedNearProviderOptions = Omit<NearProviderOptions, "fetch"> & {
  pythonPath: string;
  policyPath: string;
  /** Operator approval means an independently reviewed file with this exact immutable hash. Required. */
  policySha256: string;
  verifierPath?: string;
  nvidiaLocal?: NvidiaLocalRuntime;
};
/** This seam is trusted application code, used for offline tests. It cannot be selected by HTTP/user input. */
export type VerifiedNearDependencies = { verifyAttestation: NearAttestationVerifier };
export type NearAttestationSummary = {
  verification: "enclave_verified";
  attestationRef: string;
  policySha256: string;
  verifiedAt: string;
  expiresAt: string;
  sessionEvidenceHash: string;
  primarySigningAddress: string;
  signerCount: number;
};
export interface VerifiedNearProvider extends NearProvider {
  readiness(): Promise<NearProviderReadiness>;
  /** Official report GET and live hardware verification only. Never sends an inference POST. */
  verifyAttestation(signal: AbortSignal): Promise<NearAttestationSummary>;
}
export type VerificationRejectionReason = "input" | "cancelled" | "policy" | "attestation";
export class VerifiedProviderRequestRejectedError extends ProviderRequestRejectedError {
  readonly attestationFailure?: Readonly<NearAttestationFailure>;
  readonly reasonCode: string;
  constructor(readonly verificationReason: VerificationRejectionReason, diagnostic?: Readonly<NearAttestationFailure>) {
    super(); this.name = "VerifiedProviderRequestRejectedError";
    // Revalidate an explicit diagnostic with the source's fixed-enum boundary; never attach raw errors.
    const safe = diagnostic ? getNearAttestationFailure(createNearAttestationError(diagnostic)) : undefined;
    if (safe) this.attestationFailure = safe;
    this.reasonCode = safe ? (safe.stage === "verifier" && safe.reason === "rejected" ? safe.verifierError : `${safe.stage}:${safe.reason}`) : verificationReason;
  }
}

const reviewedPolicySchema = z.object({ schemaVersion: z.literal(1), version: z.string().min(1).max(128),
  validFrom: z.string().datetime({ offset: true }), validUntil: z.string().datetime({ offset: true }),
  maxSessionSeconds: z.number().int().min(1).max(300),
  profiles: z.array(z.object({ model: z.string().min(1).max(512) }).passthrough()).min(1).max(32),
  nvidiaVerifier: z.object({ mode: z.enum(["nras", "local"]) }).passthrough().optional(),
}).passthrough();
const signedUsageSchema = z.object({ prompt_tokens: z.number().int().min(0).max(10_000_000),
  completion_tokens: z.number().int().min(0).max(512), total_tokens: z.number().int().min(0).max(10_000_512) });

function checkedFile(path: string, label: string): string {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error(`NEAR ${label} must be an absolute path`);
  try { if (!statSync(path).isFile()) throw new Error(); }
  catch { throw new Error(`NEAR ${label} file is unavailable`); }
  return path;
}

/** Hardware verification is delegated to the pinned Python DCAP/NVIDIA implementation, never HTTP flags. */
export function createVerifiedNearProvider(options: VerifiedNearProviderOptions, dependencies?: VerifiedNearDependencies): VerifiedNearProvider {
  const endpoint = approvedNearEndpoint(options.endpoint);
  const model = z.string().trim().min(1).max(512).regex(/^[a-zA-Z0-9._/-]+$/).parse(options.model);
  const allowedModels = options.allowedModels ?? [model];
  if (!allowedModels.length || !allowedModels.includes(model)) throw new Error("NEAR model is outside the operator allowlist");
  const apiKey = z.string().trim().min(1).max(4096).refine(value => !/[\r\n\0]/.test(value)).parse(options.apiKey);
  const maxTokens = z.number().int().min(1).max(512).parse(options.maxTokens ?? 512);
  const timeoutMs = z.number().int().min(1).max(120_000).parse(options.timeoutMs ?? 30_000);
  const policySha256 = z.string().regex(/^0x[a-f0-9]{64}$/).parse(options.policySha256);
  const pythonPath = checkedFile(options.pythonPath, "Python runtime"), policyPath = checkedFile(options.policyPath, "policy");
  const verifierPath = checkedFile(options.verifierPath ?? defaultNearVerifierPath(), "verifier");
  const nvidia = options.nvidiaLocal ? nvidiaVerifierOptions({ NVIDIA_VERIFIER_MODE: "local",
    NVIDIA_NVAT_BINARY: options.nvidiaLocal.binaryPath, NVIDIA_NVAT_LIBRARY: options.nvidiaLocal.libraryPath }) : {};
  const hardwareVerifier = dependencies?.verifyAttestation ?? createNearAttestationVerifier({ pythonPath, policyPath, policySha256,
    verifierPath, apiKey, ...nvidia, maxDirectAdmissionAttempts: 1 });
  const readReviewedPolicy = async () => {
    try {
      const bytes = await readFile(policyPath);
      if (bytes.length > 1_048_576 || sha256Hex(bytes) !== policySha256) throw new Error();
      const policy = reviewedPolicySchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      const now = Date.now();
      // Development/candidate examples are not an approved production policy, even if somebody pins one.
      if (/^(?:development|candidate)(?:[-_.]|$)/i.test(policy.version) || !policy.profiles.some(profile => profile.model === model)
        || Date.parse(policy.validFrom) > now || Date.parse(policy.validUntil) <= now
        || (policy.nvidiaVerifier?.mode ?? "nras") !== (options.nvidiaLocal ? "local" : "nras")) throw new Error();
      return policy;
    } catch { throw new VerifiedProviderRequestRejectedError("policy"); }
  };
  const verifiedSession: NearAttestationVerifier = async context => {
    const session = await hardwareVerifier(context);
    try {
      assertVerifiedSession(session);
      const policy = await readReviewedPolicy();
      const issued = Date.parse(session.verifiedAt), expires = Date.parse(session.expiresAt), now = Date.now();
      if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued < now - 300_000 || issued > now + 5_000
        || expires <= now || expires > issued + policy.maxSessionSeconds * 1000
        || expires > Date.parse(policy.validUntil) || session.tlsBound !== true) throw new Error();
      return session;
    } catch (error) { session.close?.(); throw error; }
  };

  return {
    async readiness() {
      return checkVerifiedNearReadiness({ model, policyPath, policySha256, pythonPath, verifierPath,
        cloud: endpoint.hostname === 'cloud-api.near.ai', ...(options.nvidiaLocal ? { nvidiaLocal: options.nvidiaLocal } : {}) });
    },
    async verifyAttestation(signal): Promise<NearAttestationSummary> {
      if (signal.aborted) throw new VerifiedProviderRequestRejectedError("cancelled");
      await readReviewedPolicy();
      const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      let session: Awaited<ReturnType<NearAttestationVerifier>> | undefined;
      try {
        session = await verifiedSession({ baseUrl: new URL("/v1", endpoint).href, model, signal: combined });
        if (combined.aborted) throw new Error();
        return { verification: "enclave_verified", attestationRef: session.attestationRef, policySha256,
          verifiedAt: session.verifiedAt, expiresAt: session.expiresAt,
          primarySigningAddress: session.allowedSigners[0]!, signerCount: session.allowedSigners.length,
          sessionEvidenceHash: sha256Hex(JSON.stringify({ attestationRef: session.attestationRef,
            allowedSigners: session.allowedSigners, verifiedAt: session.verifiedAt, expiresAt: session.expiresAt, tlsBound: session.tlsBound })) };
      } catch (error) {
        const reason = signal.aborted ? "cancelled" : error instanceof VerifiedProviderRequestRejectedError ? error.verificationReason : "attestation";
        throw new VerifiedProviderRequestRejectedError(reason, getNearAttestationFailure(error));
      }
      finally { session?.close?.(); }
    },
    async complete(rawInput, signal): Promise<NearCompletionResult> {
      const parsed = nearCompletionInputSchema.safeParse(rawInput);
      if (!parsed.success || parsed.data.maxTokens > maxTokens) throw new VerifiedProviderRequestRejectedError("input");
      if (signal.aborted) throw new VerifiedProviderRequestRejectedError("cancelled");
      const input = parsed.data;
      await readReviewedPolicy(); // No report GET or paid POST under stale/unapproved policy.
      let result: NearInferenceResult | undefined;
      const inference = createNearInference({ baseUrl: new URL("/v1", endpoint).href, model, apiKey, timeoutMs,
        maxTokens: input.maxTokens, maxRequestBytes: 65_536, maxResponseBytes: 114_688, maxOutputBytes: 16_384,
        maxSignatureAttempts: 3, signatureRetryDelayMs: 250, enableThinking: false,
        ...(input.requestUser ? { requestUser: input.requestUser } : {}),
        beforeDispatch: async () => { await readReviewedPolicy(); }, verifyAttestation: verifiedSession,
      });
      try {
        result = await inference(Buffer.from(input.prompt, "utf8"), signal);
        // A policy rotation/expiry during a billable request must hold settlement for reconciliation.
        await readReviewedPolicy();
        const signedResponse = JSON.parse(result.transcript.responseBody.toString("utf8")) as { usage?: unknown };
        let usage: NearCompletionResult["usage"];
        if (signedResponse.usage !== undefined) {
          const parsedUsage = signedUsageSchema.safeParse(signedResponse.usage);
          if (!parsedUsage.success || parsedUsage.data.completion_tokens > input.maxTokens
            || parsedUsage.data.total_tokens !== parsedUsage.data.prompt_tokens + parsedUsage.data.completion_tokens) throw new Error();
          usage = { promptTokens: parsedUsage.data.prompt_tokens, completionTokens: parsedUsage.data.completion_tokens,
            totalTokens: parsedUsage.data.total_tokens };
        }
        return { output: result.output.toString("utf8"), model, requestId: result.evidence.completionId,
          ...(usage ? { usage } : {}),
          evidence: { verification: "enclave_verified", endpoint: endpoint.href, receivedAt: new Date().toISOString(),
            requestHash: result.evidence.requestHash, responseHash: result.evidence.responseHash,
            attestationRef: result.evidence.attestationRef, policySha256,
            providerEvidenceHash: sha256Hex(JSON.stringify(result.evidence)),
            outputHash: result.evidence.outputHash, signingAddress: result.evidence.signingAddress,
            signature: result.evidence.signature, signatureText: result.evidence.signatureText,
            verifiedAt: result.evidence.verifiedAt, expiresAt: result.evidence.expiresAt } };
      } catch (error) {
        const failure = getNearInferenceFailure(error);
        if (!result && failure?.postAttempted === false) {
          throw new VerifiedProviderRequestRejectedError(signal.aborted ? "cancelled" : "attestation", failure.attestationFailure);
        }
        let reason: AmbiguousProviderReason = signal.aborted ? "cancelled" : "malformed";
        if (!signal.aborted) {
          if (failure?.reason === "timeout") reason = "timeout";
          else if (failure?.reason === "http-status") reason = "http_error";
          else if (failure?.reason === "response-limit" || failure?.reason === "output-limit") reason = "response_limit";
          else if (failure?.reason === "verification-failed" || failure?.reason === "transport-binding") reason = "transport";
        }
        throw new AmbiguousProviderError(input.runId, reason);
      } finally {
        // No transcript store/log exists in this adapter. Drop the temporary signed HTTP body bytes.
        result?.transcript.requestBody.fill(0);
        result?.transcript.responseBody.fill(0);
      }
    },
  };
}
