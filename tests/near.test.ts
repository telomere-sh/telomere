import { describe, expect, it, vi } from "vitest";
import { AmbiguousProviderError, createNearProvider, nearProviderFromEnv, ProviderRequestRejectedError } from "../src/providers/index.js";

const options = { endpoint: "https://cloud-api.near.ai/v1", model: "operator/model", allowedModels: ["operator/model"], apiKey: "secret-canary-key", timeoutMs: 5000 };
const input = { prompt: "private-canary-prompt", maxTokens: 32, runId: "run-1" };
const response = (extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ id: "completion-1", model: "operator/model",
  choices: [{ message: { content: "answer" } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, ...extra }), { headers: { "content-type": "application/json" } });

describe("bounded NEAR provider", () => {
  it("makes one fixed-model HTTPS request and labels its evidence as TLS only", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response());
    const result = await createNearProvider({ ...options, fetch: request }).complete(input, new AbortController().signal);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://cloud-api.near.ai/v1/chat/completions");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ model: "operator/model", messages: [{ role: "user", content: input.prompt }], stream: false, temperature: 0, max_tokens: 32 });
    expect(result).toMatchObject({ output: "answer", model: "operator/model", requestId: "completion-1", usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 }, evidence: { verification: "provider_tls" } });
    expect(JSON.stringify(result)).not.toContain(options.apiKey);
    expect(JSON.stringify(result)).not.toContain(input.prompt);
  });

  it("rejects unapproved origins, models and user token/prompt caps before dispatch", async () => {
    const request = vi.fn<typeof fetch>();
    expect(() => createNearProvider({ ...options, endpoint: "https://attacker.example/v1" })).toThrow("allowlist");
    expect(() => createNearProvider({ ...options, endpoint: "http://cloud-api.near.ai/v1" })).toThrow("allowlist");
    expect(() => createNearProvider({ ...options, model: "other-model" })).toThrow("allowlist");
    const provider = createNearProvider({ ...options, maxTokens: 16, fetch: request });
    await expect(provider.complete(input, new AbortController().signal)).rejects.toBeInstanceOf(ProviderRequestRejectedError);
    await expect(provider.complete({ ...input, maxTokens: 8, prompt: "a".repeat(8193) }, new AbortController().signal)).rejects.toBeInstanceOf(ProviderRequestRejectedError);
    const controller = new AbortController(); controller.abort();
    await expect(provider.complete({ ...input, maxTokens: 8 }, controller.signal)).rejects.toBeInstanceOf(ProviderRequestRejectedError);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["http_error", () => new Response("secret-canary-key private-canary-prompt", { status: 503 })],
    ["malformed", () => new Response("not JSON")],
    ["malformed", () => response({ model: "wrong-model" })],
    ["malformed", () => response({ usage: { prompt_tokens: 5, completion_tokens: 99, total_tokens: 104 } })],
    ["response_limit", () => response({ choices: [{ message: { content: "a".repeat(16_385) } }] })],
  ])("quarantines %s without retry or raw provider data", async (reason, makeResponse) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(makeResponse());
    const provider = createNearProvider({ ...options, fetch: request });
    let caught: unknown;
    try { await provider.complete(input, new AbortController().signal); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AmbiguousProviderError);
    expect(caught).toMatchObject({ reason, runId: input.runId, code: "PROVIDER_OUTCOME_UNKNOWN" });
    expect(String(caught)).not.toContain(options.apiKey);
    expect(String(caught)).not.toContain(input.prompt);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled response even when an injected transport ignores cancellation", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => await new Promise<Response>(() => undefined));
    await expect(createNearProvider({ ...options, fetch: request, timeoutMs: 10 }).complete(input, new AbortController().signal))
      .rejects.toMatchObject({ reason: "timeout", code: "PROVIDER_OUTCOME_UNKNOWN" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds chunked bodies without Content-Length and cancels unfinished streams", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(20_000)); },
      cancel() { cancelled = true; },
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    await expect(createNearProvider({ ...options, fetch: request }).complete(input, new AbortController().signal)).rejects.toMatchObject({ reason: "response_limit" });
    expect(cancelled).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("applies the same deadline while waiting for response body bytes", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    await expect(createNearProvider({ ...options, fetch: request, timeoutMs: 10 }).complete(input, new AbortController().signal)).rejects.toMatchObject({ reason: "timeout" });
    expect(cancelled).toBe(true);
  });

  it("treats cancellation after dispatch and transport failures as ambiguous", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(); throw new Error("secret-canary-key private-canary-prompt"); });
    await expect(createNearProvider({ ...options, fetch: request }).complete(input, controller.signal)).rejects.toMatchObject({ reason: "cancelled" });
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret-canary-key private-canary-prompt"));
    await expect(createNearProvider({ ...options, fetch: failing }).complete(input, new AbortController().signal)).rejects.toMatchObject({ reason: "transport" });
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("requires operator credentials and a model allowlist in environment configuration", () => {
    expect(() => nearProviderFromEnv({ NEAR_ENDPOINT: options.endpoint, NEAR_MODEL: options.model, NEAR_API_KEY: options.apiKey })).toThrow("incomplete");
    expect(() => nearProviderFromEnv({ NEAR_ENDPOINT: options.endpoint, NEAR_MODEL: options.model, NEAR_API_KEY: options.apiKey, NEAR_ALLOWED_MODELS: "different/model" })).toThrow("allowlist");
  });
});
