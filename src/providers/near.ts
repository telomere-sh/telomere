import { createHash } from "node:crypto";
import { z } from "zod";
import { nearReadinessSnapshot, type NearProviderReadiness } from './readiness.js';

export type NearCompletionInput = { prompt: string; maxTokens: number; runId: string; requestUser?: string };
export type NearUsage = { promptTokens: number; completionTokens: number; totalTokens: number };
export type NearCompletionResult = {
  output: string;
  model: string;
  requestId: string;
  usage?: NearUsage;
  evidence: {
    verification: "provider_tls" | "enclave_verified";
    endpoint: string;
    receivedAt: string;
    requestHash: string;
    responseHash: string;
    /** Present only after live hardware, attested TLS, and signer verification. Hashes/references only. */
    attestationRef?: string;
    policySha256?: string;
    providerEvidenceHash?: string;
    verifiedAt?: string;
    expiresAt?: string;
    outputHash?: string;
    signingAddress?: string;
    signature?: string;
    signatureText?: string;
  };
};
export interface NearProvider {
  complete(input: NearCompletionInput, signal: AbortSignal): Promise<NearCompletionResult>;
  /** Optional cheap local probe; does not perform live hardware verification or provider requests. */
  readiness?(): Promise<NearProviderReadiness>;
}
export type AmbiguousProviderReason = "timeout" | "cancelled" | "http_error" | "malformed" | "transport" | "response_limit";
export class AmbiguousProviderError extends Error {
  readonly code = "PROVIDER_OUTCOME_UNKNOWN";
  constructor(readonly runId: string, readonly reason: AmbiguousProviderReason) {
    super("Provider request may have executed; reconcile this run and never retry its paid dispatch");
    this.name = "AmbiguousProviderError";
  }
}
export class ProviderRequestRejectedError extends Error {
  readonly code = "PROVIDER_REQUEST_REJECTED";
  constructor() { super("Provider request was rejected before dispatch"); this.name = "ProviderRequestRejectedError"; }
}
export type NearProviderOptions = {
  endpoint: string;
  model: string;
  apiKey: string;
  allowedModels?: readonly string[];
  maxTokens?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

export const nearCompletionInputSchema = z.object({ prompt: z.string().min(1).max(8192).refine(value => Buffer.byteLength(value, "utf8") <= 8192),
  maxTokens: z.number().int().min(1).max(512), runId: z.string().regex(/^(?:0x[a-f0-9]{64}|[a-z0-9][a-z0-9-]{0,63})$/),
  requestUser: z.string().regex(/^enclave-platform-0x[a-f0-9]{64}$/).optional() }).strict();
const usageSchema = z.object({ prompt_tokens: z.number().int().min(0).max(10_000_000), completion_tokens: z.number().int().min(0).max(10_000_000),
  total_tokens: z.number().int().min(0).max(20_000_000) });
const responseSchema = z.object({ id: z.string().min(1).max(256), model: z.string().min(1).max(512),
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).min(1).max(16), usage: usageSchema.optional() });
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Fixed NEAR HTTPS origins only. Standard TLS is not CPU/GPU attestation. */
export function approvedNearEndpoint(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("Invalid NEAR endpoint"); }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.search || url.hash
    || !["/v1", "/v1/"].includes(url.pathname)
    || !(url.hostname === "cloud-api.near.ai" || /^[a-z0-9-]+\.completions\.near\.ai$/.test(url.hostname))) throw new Error("NEAR endpoint is outside the operator allowlist");
  url.pathname = "/v1/chat/completions";
  return url;
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error("Provider deadline elapsed"));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted)).catch(() => undefined);
  });
}

async function readBody(response: Response, signal: AbortSignal, runId: string): Promise<string> {
  const maximum = 114_688; // 16 KiB text + JSON escaping/envelope overhead.
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    void response.body?.cancel().catch(() => undefined);
    throw new AmbiguousProviderError(runId, "response_limit");
  }
  if (!response.body) throw new AmbiguousProviderError(runId, "malformed");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await withAbort(reader.read(), signal);
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maximum) throw new AmbiguousProviderError(runId, "response_limit");
      chunks.push(item.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createNearProvider(options: NearProviderOptions): NearProvider {
  const endpoint = approvedNearEndpoint(options.endpoint);
  const model = z.string().trim().min(1).max(512).regex(/^[a-zA-Z0-9._/-]+$/).parse(options.model);
  const allowedModels = options.allowedModels ?? [model];
  if (!allowedModels.length || !allowedModels.includes(model)) throw new Error("NEAR model is outside the operator allowlist");
  const apiKey = z.string().trim().min(1).max(4096).refine(value => !/[\r\n\0]/.test(value)).parse(options.apiKey);
  const maximumTokens = z.number().int().min(1).max(512).parse(options.maxTokens ?? 512);
  const timeoutMs = z.number().int().min(1).max(120_000).parse(options.timeoutMs ?? 30_000);
  const request = options.fetch ?? globalThis.fetch;
  return {
    async readiness() { return nearReadinessSnapshot('ready', 'TLS_ONLY', 'provider_tls'); },
    async complete(rawInput, signal): Promise<NearCompletionResult> {
      const parsed = nearCompletionInputSchema.safeParse(rawInput);
      if (!parsed.success || parsed.data.maxTokens > maximumTokens || signal.aborted) throw new ProviderRequestRejectedError();
      const input = parsed.data, deadline = new AbortController(), combined = AbortSignal.any([signal, deadline.signal]);
      const timeout = setTimeout(() => deadline.abort(), timeoutMs);
      const body = JSON.stringify({ model, messages: [{ role: "user", content: input.prompt }], stream: false, temperature: 0, max_tokens: input.maxTokens });
      try {
        // Exactly one POST. Once dispatched, all uncertainty is terminal for this run.
        const operation = request(endpoint, { method: "POST", redirect: "error", signal: combined,
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json", "x-no-aliasing": "true" }, body });
        void operation.then(response => { if (combined.aborted) void response.body?.cancel().catch(() => undefined); }, () => undefined);
        const response = await withAbort(operation, combined);
        if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new AmbiguousProviderError(input.runId, "http_error"); }
        const rawBody = await readBody(response, combined, input.runId);
        let value: unknown;
        try { value = JSON.parse(rawBody); } catch { throw new AmbiguousProviderError(input.runId, "malformed"); }
        const completion = responseSchema.safeParse(value);
        if (!completion.success || completion.data.model !== model || combined.aborted) throw new AmbiguousProviderError(input.runId, "malformed");
        const output = completion.data.choices[0]?.message.content;
        if (output === undefined || Buffer.byteLength(output, "utf8") > 16_384) throw new AmbiguousProviderError(input.runId, "response_limit");
        const usage = completion.data.usage;
        if (usage && (usage.completion_tokens > input.maxTokens || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens)) throw new AmbiguousProviderError(input.runId, "malformed");
        return { output, model, requestId: completion.data.id,
          ...(usage ? { usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens } } : {}),
          evidence: { verification: "provider_tls", endpoint: endpoint.toString(), receivedAt: new Date().toISOString(), requestHash: sha256(body), responseHash: sha256(rawBody) } };
      } catch (error) {
        if (combined.aborted) throw new AmbiguousProviderError(input.runId, signal.aborted ? "cancelled" : "timeout");
        if (error instanceof AmbiguousProviderError) throw error;
        // Never expose provider error bodies, credential strings, prompts, or raw exceptions.
        throw new AmbiguousProviderError(input.runId, "transport");
      } finally { clearTimeout(timeout); }
    },
  };
}

export function nearProviderFromEnv(env: NodeJS.ProcessEnv = process.env, request?: typeof globalThis.fetch): NearProvider {
  const parsed = z.object({ NEAR_ENDPOINT: z.string().url(), NEAR_MODEL: z.string().min(1), NEAR_API_KEY: z.string().min(1),
    NEAR_ALLOWED_MODELS: z.string().min(1), NEAR_MAX_TOKENS: z.coerce.number().int().min(1).max(512).default(512),
    NEAR_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(30_000) }).safeParse(env);
  if (!parsed.success) throw new Error("NEAR operator configuration is incomplete or invalid");
  return createNearProvider({ endpoint: parsed.data.NEAR_ENDPOINT, model: parsed.data.NEAR_MODEL, apiKey: parsed.data.NEAR_API_KEY,
    allowedModels: parsed.data.NEAR_ALLOWED_MODELS.split(",").map(value => value.trim()).filter(Boolean), maxTokens: parsed.data.NEAR_MAX_TOKENS,
    timeoutMs: parsed.data.NEAR_TIMEOUT_MS, ...(request ? { fetch: request } : {}) });
}
