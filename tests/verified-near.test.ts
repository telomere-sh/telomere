import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { AmbiguousProviderError, ProviderRequestRejectedError, createVerifiedNearProvider,
  type VerifiedNearProviderOptions } from "../src/providers/index.js";
import { checkNearCertificate, defaultNearVerifierPath, peerSpkiSha256, runNearVerifier } from "../src/providers/verified/attestation.js";
import type { NearAttestationVerifier, NearVerifiedSession, NearVerifiedFetch } from "../src/providers/verified/inference.js";
import { createNearAttestationError } from "../src/providers/verified/attestation-error.js";

// Disposable, public fixture keys sign only synthetic offline messages. They never authenticate a live service.
const signer = privateKeyToAccount(`0x${"01".repeat(32)}`);
const otherSigner = privateKeyToAccount(`0x${"02".repeat(32)}`);
const model = "operator/model", prompt = "private-prompt-canary", apiKey = "secret-key-canary";
const input = { prompt, maxTokens: 32, runId: `0x${"aa".repeat(32)}` };
const hash = (value: string | Buffer) => `0x${createHash("sha256").update(value).digest("hex")}`;
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.restoreAllMocks(); });

async function fixture(overrides: Record<string, unknown> = {}): Promise<VerifiedNearProviderOptions> {
  const directory = await mkdtemp(join(tmpdir(), "telomere-verified-near-")); temporary.push(directory);
  const policyPath = join(directory, "reviewed-policy.json");
  const bytes = JSON.stringify({ schemaVersion: 1, version: "reviewed-test-v1", validFrom: new Date(Date.now() - 60_000).toISOString(),
    validUntil: new Date(Date.now() + 300_000).toISOString(), maxSessionSeconds: 120, profiles: [{ model }], ...overrides });
  await writeFile(policyPath, bytes);
  return { endpoint: "https://cloud-api.near.ai/v1", model, allowedModels: [model], apiKey, maxTokens: 64,
    timeoutMs: 5_000, pythonPath: process.execPath, policyPath, policySha256: hash(bytes) };
}

function syntheticSession(fetch: NearVerifiedFetch, overrides: Partial<NearVerifiedSession> = {}): NearVerifiedSession {
  return { allowedSigners: [signer.address], attestationRef: `0x${"bb".repeat(32)}`, verifiedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90_000).toISOString(), tlsBound: true, fetch,
    attestationProof: "sensitive-public-hardware-report-canary", close: vi.fn(), ...overrides };
}

function signedTransport(options: { wrongSigner?: boolean; wrongBinding?: boolean; transientSignature?: boolean; usage?: unknown } = {}) {
  let body = "", signatureGets = 0;
  const responseBody = JSON.stringify({ id: "completion-1", model, choices: [{ message: { content: "verified answer" } }],
    ...(options.usage === undefined ? {} : { usage: options.usage }) });
  const fetch = vi.fn<NearVerifiedFetch>().mockImplementation(async (_url, request) => {
    if (request.method === "POST") { body = String(request.body); return new Response(responseBody); }
    signatureGets++;
    if (options.transientSignature && signatureGets === 1) return new Response("not yet", { status: 404 });
    const text = `${model}:${hash(body).slice(2)}:${hash(responseBody).slice(2)}`;
    const account = options.wrongSigner ? otherSigner : signer;
    const signedText = options.wrongBinding ? `${text}-wrong` : text;
    return new Response(JSON.stringify({ text: signedText, signature: await account.signMessage({ message: signedText }),
      signing_address: account.address, signing_algo: "ecdsa", signature_kind: "provider_tee" }));
  });
  return { fetch, requestBody: () => body };
}

describe("verified NEAR provider fail-closed admission and dispatch", () => {
  it("binds real ECDSA proof to raw request/response hashes and returns references only", async () => {
    const options = await fixture(), transport = signedTransport(), session = syntheticSession(transport.fetch);
    const verifyAttestation = vi.fn<NearAttestationVerifier>().mockResolvedValue(session);
    const result = await createVerifiedNearProvider(options, { verifyAttestation }).complete(input, new AbortController().signal);
    expect(transport.fetch.mock.calls.map(call => call[1].method)).toEqual(["POST", "GET"]);
    expect(JSON.parse(transport.requestBody())).toMatchObject({ model, stream: false, max_tokens: 32, messages: [{ role: "user", content: prompt }] });
    expect(result).toMatchObject({ output: "verified answer", requestId: "completion-1", evidence: { verification: "enclave_verified",
      attestationRef: session.attestationRef, policySha256: options.policySha256, requestHash: hash(transport.requestBody()) } });
    expect(result.evidence.providerEvidenceHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(result.evidence.signingAddress).toBe(signer.address);
    for (const sensitive of [prompt, apiKey, "sensitive-public-hardware-report-canary", "transcript"]) expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("performs a read-only attestation preflight without inference dispatch and closes transport", async () => {
    const options = await fixture(), fetch = vi.fn<NearVerifiedFetch>(), session = syntheticSession(fetch);
    const summary = await createVerifiedNearProvider(options, { verifyAttestation: async () => session }).verifyAttestation(new AbortController().signal);
    expect(summary).toMatchObject({ verification: "enclave_verified", attestationRef: session.attestationRef, policySha256: options.policySha256 });
    expect(summary.sessionEvidenceHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(fetch).not.toHaveBeenCalled(); expect(session.close).toHaveBeenCalledOnce();
  });

  it.each([
    { validUntil: new Date(Date.now() - 1000).toISOString() },
    { validFrom: new Date(Date.now() + 60_000).toISOString() },
    { version: "development-unreviewed-v1" },
    { profiles: [{ model: "other/model" }] },
    { nvidiaVerifier: { mode: "local" } },
  ])("rejects inadmissible pinned policy before any provider operation: %j", async policy => {
    const options = await fixture(policy), verifyAttestation = vi.fn<NearAttestationVerifier>();
    await expect(createVerifiedNearProvider(options, { verifyAttestation }).complete(input, new AbortController().signal))
      .rejects.toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", verificationReason: "policy" });
    expect(verifyAttestation).not.toHaveBeenCalled();
  });

  it("rejects modified exact policy bytes before attestation", async () => {
    const options = await fixture(), verifyAttestation = vi.fn<NearAttestationVerifier>();
    await writeFile(options.policyPath, (await readFile(options.policyPath, "utf8")) + "\n");
    await expect(createVerifiedNearProvider(options, { verifyAttestation }).complete(input, new AbortController().signal)).rejects.toBeInstanceOf(ProviderRequestRejectedError);
    expect(verifyAttestation).not.toHaveBeenCalled();
  });

  it("checks pinned policy again after attestation and before POST", async () => {
    const options = await fixture(), transport = signedTransport(), session = syntheticSession(transport.fetch);
    const verifyAttestation: NearAttestationVerifier = async () => {
      await writeFile(options.policyPath, "modified-policy-canary"); return session;
    };
    await expect(createVerifiedNearProvider(options, { verifyAttestation }).complete(input, new AbortController().signal)).rejects.toBeInstanceOf(ProviderRequestRejectedError);
    expect(transport.fetch).not.toHaveBeenCalled(); expect(session.close).toHaveBeenCalledOnce();
  });

  it("redacts an attestation failure and makes no paid dispatch", async () => {
    const options = await fixture(), verifyAttestation = vi.fn<NearAttestationVerifier>().mockRejectedValue(new Error(`${apiKey} ${prompt}`));
    let caught: unknown;
    try { await createVerifiedNearProvider(options, { verifyAttestation }).complete(input, new AbortController().signal); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ProviderRequestRejectedError);
    expect(String(caught)).not.toContain(apiKey); expect(String(caught)).not.toContain(prompt);
  });

  it("preserves only a trusted fixed-enum attestation diagnostic for operator review", async () => {
    const options = await fixture(), fetch = vi.fn<NearVerifiedFetch>();
    const verifyAttestation: NearAttestationVerifier = async () => { throw createNearAttestationError({ stage: "verifier", reason: "rejected", verifierError: "WORKLOAD_NOT_APPROVED" }); };
    const provider = createVerifiedNearProvider(options, { verifyAttestation });
    // Start each operation only when its rejection assertion is attached. Eagerly
    // creating both promises leaves the second rejection unhandled while awaiting
    // the first operation's filesystem/policy checks.
    for (const operation of [() => provider.verifyAttestation(new AbortController().signal),
      () => provider.complete(input, new AbortController().signal)]) {
      await expect(operation()).rejects.toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", reasonCode: "WORKLOAD_NOT_APPROVED",
        attestationFailure: { stage: "verifier", reason: "rejected", verifierError: "WORKLOAD_NOT_APPROVED" } });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not trust enum-shaped details attached to an arbitrary verifier error", async () => {
    const options = await fixture();
    const verifyAttestation: NearAttestationVerifier = async () => { throw Object.assign(new Error(apiKey), {
      details: { attestationFailure: { stage: "verifier", reason: "rejected", verifierError: "WORKLOAD_NOT_APPROVED", raw: prompt } } }); };
    await expect(createVerifiedNearProvider(options, { verifyAttestation }).verifyAttestation(new AbortController().signal))
      .rejects.toMatchObject({ reasonCode: "attestation", attestationFailure: undefined });
  });

  it("rejects expired or overlong attested sessions before dispatch", async () => {
    for (const expiresAt of [new Date(Date.now() - 1).toISOString(), new Date(Date.now() + 121_000).toISOString()]) {
      const options = await fixture(), fetch = vi.fn<NearVerifiedFetch>(), session = syntheticSession(fetch, { expiresAt });
      await expect(createVerifiedNearProvider(options, { verifyAttestation: async () => session }).complete(input, new AbortController().signal))
        .rejects.toBeInstanceOf(ProviderRequestRejectedError);
      expect(fetch).not.toHaveBeenCalled(); expect(session.close).toHaveBeenCalledOnce();
    }
  });

  it("bounds tokens, UTF-8 prompt bytes, and cancelled input before attestation", async () => {
    const options = await fixture(), verifyAttestation = vi.fn<NearAttestationVerifier>(), provider = createVerifiedNearProvider(options, { verifyAttestation });
    await expect(provider.complete({ ...input, maxTokens: 65 }, new AbortController().signal)).rejects.toBeInstanceOf(ProviderRequestRejectedError);
    await expect(provider.complete({ ...input, prompt: "я".repeat(4097) }, new AbortController().signal)).rejects.toBeInstanceOf(ProviderRequestRejectedError);
    const controller = new AbortController(); controller.abort();
    await expect(provider.complete(input, controller.signal)).rejects.toBeInstanceOf(ProviderRequestRejectedError);
    expect(verifyAttestation).not.toHaveBeenCalled();
  });

  it.each([{ wrongSigner: true }, { wrongBinding: true }])("holds an untrusted signer/binding after POST without repeating it: %j", async proof => {
    const options = await fixture(), transport = signedTransport(proof);
    await expect(createVerifiedNearProvider(options, { verifyAttestation: async () => syntheticSession(transport.fetch) }).complete(input, new AbortController().signal))
      .rejects.toBeInstanceOf(AmbiguousProviderError);
    expect(transport.fetch.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
  });

  it("allows bounded read-only signature GET retry while keeping one paid POST", async () => {
    const options = await fixture(), transport = signedTransport({ transientSignature: true });
    await createVerifiedNearProvider(options, { verifyAttestation: async () => syntheticSession(transport.fetch) }).complete(input, new AbortController().signal);
    expect(transport.fetch.mock.calls.map(call => call[1].method)).toEqual(["POST", "GET", "GET"]);
  });

  it("returns provider token usage only when it is in the signed bounded response", async () => {
    const options = await fixture(), transport = signedTransport({ usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
    const result = await createVerifiedNearProvider(options, { verifyAttestation: async () => syntheticSession(transport.fetch) }).complete(input, new AbortController().signal);
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 3, totalTokens: 13 });
  });

  it.each([{ prompt_tokens: 10, completion_tokens: 33, total_tokens: 43 }, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 12 }])
    ("holds malformed signed usage without another POST: %j", async usage => {
      const options = await fixture(), transport = signedTransport({ usage });
      await expect(createVerifiedNearProvider(options, { verifyAttestation: async () => syntheticSession(transport.fetch) }).complete(input, new AbortController().signal))
        .rejects.toBeInstanceOf(AmbiguousProviderError);
      expect(transport.fetch.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
    });

  it.each([
    ["http_error", () => Promise.resolve(new Response(`${apiKey} ${prompt}`, { status: 503 }))],
    ["malformed", () => Promise.resolve(new Response("invalid JSON"))],
    ["transport", () => Promise.reject(new Error(`${apiKey} ${prompt}`))],
    ["timeout", () => new Promise<Response>(() => undefined)],
  ] as const)("classifies post-dispatch %s as unknown and never retries", async (reason, outcome) => {
    const options = await fixture(), fetch = vi.fn<NearVerifiedFetch>().mockImplementation(outcome), session = syntheticSession(fetch);
    let caught: unknown;
    try { await createVerifiedNearProvider({ ...options, timeoutMs: 30 }, { verifyAttestation: async () => session }).complete(input, new AbortController().signal); }
    catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "PROVIDER_OUTCOME_UNKNOWN", reason, runId: input.runId });
    expect(fetch).toHaveBeenCalledOnce(); expect(String(caught)).not.toContain(apiKey); expect(String(caught)).not.toContain(prompt);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("cancels a dispatched operation with one POST and closes the pinned transport", async () => {
    const options = await fixture(), controller = new AbortController();
    const fetch = vi.fn<NearVerifiedFetch>().mockImplementation(async () => { controller.abort(); return await new Promise<Response>(() => undefined); });
    const session = syntheticSession(fetch);
    await expect(createVerifiedNearProvider(options, { verifyAttestation: async () => session }).complete(input, controller.signal))
      .rejects.toMatchObject({ code: "PROVIDER_OUTCOME_UNKNOWN", reason: "cancelled" });
    expect(fetch).toHaveBeenCalledOnce(); expect(session.close).toHaveBeenCalledOnce();
  });

  it("holds a policy change during inference despite a valid completion signature", async () => {
    const options = await fixture(), transport = signedTransport();
    const fetch: NearVerifiedFetch = async (url, request) => {
      const response = await transport.fetch(url, request);
      if (request.method === "GET") await writeFile(options.policyPath, "changed-after-post");
      return response;
    };
    await expect(createVerifiedNearProvider(options, { verifyAttestation: async () => syntheticSession(fetch) }).complete(input, new AbortController().signal))
      .rejects.toBeInstanceOf(AmbiguousProviderError);
    expect(transport.fetch.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
  });
});

describe("vendored verifier process and attested TLS", () => {
  it("resolves portable Python assets and rejects a subprocess verdict failure without arbitrary diagnostics", async () => {
    expect(await readFile(defaultNearVerifierPath(), "utf8")).toContain("from verifier import");
    const options = await fixture(), verifierPath = join(temporary[temporary.length - 1]!, "reject.mjs");
    await writeFile(verifierPath, 'process.stdin.resume(); process.stdin.on("end", () => { console.log(JSON.stringify({ok:false,error:"POLICY_EXPIRED"})); process.exitCode=1; });');
    await expect(runNearVerifier({ pythonPath: process.execPath, policyPath: options.policyPath, policySha256: options.policySha256, verifierPath }, {}, new AbortController().signal))
      .rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED", details: { attestationFailure: { stage: "verifier", reason: "rejected", verifierError: "POLICY_EXPIRED" } } });
  });

  it("does not leak credentials to the verifier child environment", async () => {
    const options = await fixture(), verifierPath = join(temporary[temporary.length - 1]!, "env.mjs");
    vi.stubEnv("NEAR_API_KEY", apiKey);
    await writeFile(verifierPath, `process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify(process.env.NEAR_API_KEY ? {ok:false,error:"VERIFICATION_FAILED"} : {ok:true,signingAddress:"${signer.address}",tlsSpkiSha256:"${"11".repeat(32)}",attestationRef:"${"22".repeat(32)}",verifiedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()})));`);
    try {
      await expect(runNearVerifier({ pythonPath: process.execPath, policyPath: options.policyPath, policySha256: options.policySha256, verifierPath }, {}, new AbortController().signal))
        .resolves.toMatchObject({ ok: true, signingAddress: signer.address });
    } finally { vi.unstubAllEnvs(); }
  });

  it("retains hostname checks and rejects an SPKI mismatch", () => {
    const cert = new X509Certificate(`-----BEGIN CERTIFICATE-----
MIIB1jCCAXugAwIBAgIUQH167SxubumFz1674ZsxL2voIJQwCgYIKoZIzj0EAwIw
IzEhMB8GA1UEAwwYdGVzdC5jb21wbGV0aW9ucy5uZWFyLmFpMB4XDTI2MDkyODE3
NDMwMVoXDTM2MDkyNjE3NDMwMVowIzEhMB8GA1UEAwwYdGVzdC5jb21wbGV0aW9u
cy5uZWFyLmFpMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKM+30DfU/cWgtugL
zenTuJa/dseF3VDZMIVO55+ESL7d58jcFK2g8F7zjUIkHRz8hHeGly2MvqsxTrJq
Aer9tqOBjDCBiTAdBgNVHQ4EFgQUdHpijHVIXHnXwWFnaaQlV9cANbgwHwYDVR0j
BBgwFoAUdHpijHVIXHnXwWFnaaQlV9cANbgwNgYDVR0RBC8wLYIYdGVzdC5jb21w
bGV0aW9ucy5uZWFyLmFpghFjbG91ZC1hcGkubmVhci5haTAPBgNVHRMBAf8EBTAD
AQH/MAoGCCqGSM49BAMCA0kAMEYCIQClzAGEXrd05jxXQTUK2SCe+qt5PMfNQOC+
XH9PIYc1DQIhAKxa3TQR4Ojd6kgD8Drpoynvkm1HlNiFdTRseWg20C9a
-----END CERTIFICATE-----`);
    const peer = cert.toLegacyObject(), spki = peerSpkiSha256(peer);
    expect(checkNearCertificate("cloud-api.near.ai", peer, spki)).toBeUndefined();
    expect(checkNearCertificate("cloud-api.near.ai", peer, "00".repeat(32))).toBeInstanceOf(Error);
    expect(checkNearCertificate("wrong.completions.near.ai", peer, spki)).toBeInstanceOf(Error);
    expect(() => peerSpkiSha256({ raw: Buffer.alloc(0) })).toThrow();
  });
});
