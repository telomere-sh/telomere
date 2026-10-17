import { z } from "zod";
import { AppError } from "./support.js";

export const nearVerifierErrorCodes = Object.freeze([
  "ARCHIVE_INVALID", "ARCHIVE_TIME_INVALID", "ARCHIVE_VERDICT_MISMATCH", "INPUT_INVALID", "POLICY_CHANGED", "POLICY_INVALID", "POLICY_EXPIRED",
  "CPU_BINDING_MISMATCH", "CPU_DEBUG_REJECTED", "CPU_INVALID", "CPU_TCB_REJECTED", "CPU_TYPE_REJECTED", "CPU_VERIFICATION_FAILED",
  "GATEWAY_COMPOSE_MISMATCH", "GATEWAY_EVENT_LOG_INVALID", "GATEWAY_EVENT_LOG_MISMATCH", "GATEWAY_EVIDENCE_MISSING", "GATEWAY_POLICY_MISMATCH", "GATEWAY_SIGNER_INVALID",
  "MODEL_EVENT_LOG_MISMATCH", "MODEL_EVIDENCE_DUPLICATE", "MODEL_EVIDENCE_INVALID", "MODEL_EVIDENCE_MISSING", "MODEL_INVALID", "NONCE_MISMATCH",
  "NVIDIA_GPU_BINDING_INVALID", "NVIDIA_GPU_REJECTED", "NVIDIA_GPU_SET_INVALID", "NVIDIA_IMPLEMENTATION_CHANGED", "NVIDIA_INVALID",
  "NVIDIA_LOCAL_CONFIG_INVALID", "NVIDIA_LOCAL_OUTPUT_INVALID", "NVIDIA_LOCAL_TIMEOUT", "NVIDIA_LOCAL_UNAVAILABLE", "NVIDIA_NONCE_INVALID",
  "NVIDIA_RESULT_REJECTED", "NVIDIA_SIGNATURE_INVALID", "NVIDIA_TIME_INVALID", "NVIDIA_UNAVAILABLE", "NVIDIA_VERIFIER_MISMATCH",
  "SIGNING_ALGORITHM_REJECTED", "TLS_BINDING_MISMATCH", "VERIFICATION_ABORTED", "VERIFICATION_EXPIRED", "VERIFICATION_FAILED", "VERIFICATION_TIMEOUT",
  "WORKLOAD_ACTIONS_INVALID", "WORKLOAD_BINDING_MISMATCH", "WORKLOAD_COMPOSE_MISMATCH", "WORKLOAD_EVIDENCE_MISSING", "WORKLOAD_MANAGER_UNKNOWN",
  "WORKLOAD_NONCE_MISMATCH", "WORKLOAD_NOT_APPROVED", "WORKLOAD_VM_MISMATCH",
] as const);
export type NearAttestationFailure =
  | { stage: "verifier"; reason: "aborted" | "output-limit" | "process-failed" | "stdin-failed" | "invalid-output" | "archive-unverified" | "invalid-input" }
  | { stage: "verifier"; reason: "rejected"; verifierError: typeof nearVerifierErrorCodes[number] }
  | { stage: "transport"; reason: "aborted" | "tls" | "request" | "response" | "body-limit" | "encoding" | "body-type" }
  | { stage: "report"; reason: "http-status" | "json" | "shape" | "nonce-binding" | "tls-binding" | "model-binding" }
  | { stage: "policy"; reason: "unreadable" | "size" | "changed" | "json" }
  | { stage: "session"; reason: "tls-binding" | "signer" | "signer-set" | "time" | "origin" | "expired" }
  | { stage: "configuration"; reason: "credentials" };

const rejectedVerifier = z.object({ stage: z.literal("verifier"), reason: z.literal("rejected"), verifierError: z.enum(nearVerifierErrorCodes) }).strict();
const failureSchema = z.union([
  rejectedVerifier,
  z.object({ stage: z.literal("verifier"), reason: z.enum(["aborted", "output-limit", "process-failed", "stdin-failed", "invalid-output", "archive-unverified", "invalid-input"]) }).strict(),
  z.object({ stage: z.literal("transport"), reason: z.enum(["aborted", "tls", "request", "response", "body-limit", "encoding", "body-type"]) }).strict(),
  z.object({ stage: z.literal("report"), reason: z.enum(["http-status", "json", "shape", "nonce-binding", "tls-binding", "model-binding"]) }).strict(),
  z.object({ stage: z.literal("policy"), reason: z.enum(["unreadable", "size", "changed", "json"]) }).strict(),
  z.object({ stage: z.literal("session"), reason: z.enum(["tls-binding", "signer", "signer-set", "time", "origin", "expired"]) }).strict(),
  z.object({ stage: z.literal("configuration"), reason: z.literal("credentials") }).strict(),
]);
// Only factory-created errors carry provenance; public details are not a trust source.
const diagnostics = new WeakMap<object, Readonly<NearAttestationFailure>>();
class NearAttestationError extends AppError {
  constructor(failure: NearAttestationFailure) {
    super("INFERENCE_ATTESTATION_FAILED", "NEAR hardware attestation or transport verification failed", 503, { attestationFailure: { ...failure } });
    diagnostics.set(this, Object.freeze({ ...failure }));
  }
}

export function createNearAttestationError(failure: NearAttestationFailure): AppError {
  const parsed = failureSchema.safeParse(failure);
  // Invalid internal diagnostics are reduced to a fixed enum, never echoed by Zod.
  return new NearAttestationError(parsed.success ? parsed.data : { stage: "transport", reason: "request" });
}

export function getNearAttestationFailure(error: unknown): Readonly<NearAttestationFailure> | undefined {
  return error !== null && (typeof error === "object" || typeof error === "function") ? diagnostics.get(error) : undefined;
}

export function isNearAttestationError(error: unknown): error is AppError {
  return getNearAttestationFailure(error) !== undefined;
}

export function isUnapprovedNearWorkload(error: unknown): boolean {
  const failure = getNearAttestationFailure(error);
  return failure?.stage === "verifier" && failure.reason === "rejected" && failure.verifierError === "WORKLOAD_NOT_APPROVED";
}
