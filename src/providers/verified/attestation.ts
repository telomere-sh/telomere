import { spawn } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { checkServerIdentity, type PeerCertificate, type TLSSocket } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createNearAttestationError, isNearAttestationError, isUnapprovedNearWorkload, nearVerifierErrorCodes, type NearAttestationFailure } from "./attestation-error.js";
import { sha256Hex } from "./support.js";
import type { NearAttestationVerifier, NearVerifiedFetch } from "./inference.js";

export type NvidiaLocalRuntime = { binaryPath: string; libraryPath: string };
export type NearProviderOptions = {
  pythonPath: string; policyPath: string; policySha256?: string; verifierPath?: string; apiKey?: string; nvidiaLocal?: NvidiaLocalRuntime;
  /** Trusted operator limit for direct attestation GETs only. Never retries inference. */
  maxDirectAdmissionAttempts?: number;
};
/** Explicit trusted operator configuration; never inherit ambient vendor settings. */
export function nvidiaVerifierOptions(env: { NVIDIA_VERIFIER_MODE?: string | undefined; NVIDIA_NVAT_BINARY?: string | undefined; NVIDIA_NVAT_LIBRARY?: string | undefined }): Pick<NearProviderOptions, "nvidiaLocal"> {
  const mode = env.NVIDIA_VERIFIER_MODE ?? "nras";
  if (mode === "nras") {
    if (env.NVIDIA_NVAT_BINARY || env.NVIDIA_NVAT_LIBRARY) throw new Error("Local NVIDIA artifacts require explicit local verification mode");
    return {};
  }
  const binaryPath = env.NVIDIA_NVAT_BINARY, libraryPath = env.NVIDIA_NVAT_LIBRARY;
  if (mode !== "local" || !binaryPath || !libraryPath || binaryPath === libraryPath
    || [binaryPath, libraryPath].some(path => !isAbsolute(path) || /[\0\r\n]/.test(path))
    || /[:$]/.test(libraryPath)) {
    throw new Error("Local NVIDIA verification requires absolute binary and library paths");
  }
  return { nvidiaLocal: { binaryPath, libraryPath } };
}
/** Source checkout, copied build assets, or dist/src while infra remains at project root. */
export function defaultNearVerifierPath(): string {
  const candidates = ["../../../infra/near/verify.py", "../../../../infra/near/verify.py"].map(path => fileURLToPath(new URL(path, import.meta.url)));
  const selected = candidates.find(path => existsSync(path));
  if (!selected) throw new Error("Vendored NEAR verifier assets are missing");
  return selected;
}
const hex32 = z.string().regex(/^(?:0x)?[0-9a-f]{64}$/i);
const signerAddress = z.string().regex(/^0x[0-9a-f]{40}$/i).refine(value => !/^0x0{40}$/i.test(value));
const verdictSchema = z.object({
  ok: z.literal(true), signingAddress: signerAddress,
  tlsSpkiSha256: hex32, attestationRef: hex32, verifiedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  allowedSigners: z.array(signerAddress).min(1).max(32).optional(),
  archivedHardwareVerified: z.boolean().optional(),
}).passthrough();
const normalizeHex = (value: string) => value.replace(/^0x/, "").toLowerCase();
export type { NearAttestationFailure } from "./attestation-error.js";
const unavailable = (diagnostic: NearAttestationFailure = { stage: "transport", reason: "request" }) => createNearAttestationError(diagnostic);
const tlsErrorCodes = new Set(["ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_REVOKED", "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED"]);
function transportFailure(error: unknown, signal: RequestInit["signal"]): ReturnType<typeof createNearAttestationError> {
  if (signal?.aborted) return unavailable({ stage: "transport", reason: "aborted" });
  if (isNearAttestationError(error)) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return unavailable({ stage: "transport", reason: typeof code === "string" && tlsErrorCodes.has(code) ? "tls" : "request" });
}
function fixedVerifierError(output: Buffer): typeof nearVerifierErrorCodes[number] | undefined {
  try {
    const value: unknown = JSON.parse(output.toString("utf8"));
    if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== false || !("error" in value)) return undefined;
    return nearVerifierErrorCodes.find(code => value.error === code);
  } catch { return undefined; }
}

export function nearBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !(url.hostname === "cloud-api.near.ai" || /^[a-z0-9-]+\.completions\.near\.ai$/.test(url.hostname))
    || (url.port && url.port !== "443") || !["", "/", "/v1", "/v1/"].includes(url.pathname)
    || url.username || url.password || url.search || url.hash) throw new Error("NEAR requires an approved HTTPS endpoint");
  return url;
}

export function peerSpkiSha256(cert: Pick<PeerCertificate, "raw">): string {
  if (!cert.raw?.length) throw unavailable({ stage: "transport", reason: "tls" });
  const spki = new X509Certificate(cert.raw).publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(spki).digest("hex");
}

/** Public CA verification is retained in addition to the attested SPKI binding. */
export function checkNearCertificate(hostname: string, cert: PeerCertificate, expectedSpki: string): Error | undefined {
  const identityError = checkServerIdentity(hostname, cert);
  if (identityError) return identityError;
  try { if (peerSpkiSha256(cert) !== normalizeHex(expectedSpki)) return unavailable({ stage: "transport", reason: "tls" }); }
  catch { return unavailable({ stage: "transport", reason: "tls" }); }
  return undefined;
}

type WireResponse = { response: Response; peerSpki: string };
async function requestBytes(url: URL, init: RequestInit, agent: https.Agent, maximum = 8_388_608): Promise<WireResponse> {
  if (init.body != null && typeof init.body !== "string") throw unavailable({ stage: "transport", reason: "body-type" });
  const requestBody = init.body as string | undefined;
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  if (requestBody !== undefined) headers["content-length"] = String(Buffer.byteLength(requestBody));
  return new Promise<WireResponse>((resolve, reject) => {
    const req = https.request(url, { method: init.method ?? "GET", headers, agent,
      ...(init.signal ? { signal: init.signal } : {}),
    }, (res) => {
      let peerSpki: string;
      try { peerSpki = peerSpkiSha256((res.socket as TLSSocket).getPeerCertificate()); }
      catch { res.destroy(); reject(unavailable({ stage: "transport", reason: "tls" })); return; }
      const declared = Number(res.headers["content-length"] ?? 0);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximum) {
        res.destroy(); reject(unavailable({ stage: "transport", reason: "body-limit" })); return;
      }
      if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
        res.destroy(); reject(unavailable({ stage: "transport", reason: "encoding" })); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximum) { res.destroy(); reject(unavailable({ stage: "transport", reason: "body-limit" })); return; }
        chunks.push(Buffer.from(chunk));
      });
      res.on("error", () => reject(unavailable({ stage: "transport", reason: init.signal?.aborted ? "aborted" : "response" })));
      res.on("aborted", () => reject(unavailable({ stage: "transport", reason: init.signal?.aborted ? "aborted" : "response" })));
      res.on("end", () => {
        try {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          const status = res.statusCode ?? 502;
          // No redirects or decompression: the verifier hashes the original HTTP body bytes.
          resolve({ response: new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders }), peerSpki });
        } catch { reject(unavailable({ stage: "transport", reason: "response" })); }
      });
    });
    req.on("error", error => reject(transportFailure(error, init.signal)));
    if (requestBody !== undefined) req.write(requestBody);
    req.end();
  });
}

export async function runNearVerifier(options: NearProviderOptions, input: unknown, signal: AbortSignal, cloud = false, archive = false): Promise<z.infer<typeof verdictSchema>> {
  if (signal.aborted) throw unavailable({ stage: "verifier", reason: "aborted" });
  let serializedInput: string;
  try {
    const encoded = JSON.stringify(input);
    if (encoded === undefined) throw new Error();
    serializedInput = encoded;
  } catch { throw unavailable({ stage: "verifier", reason: "invalid-input" }); }
  const env: NodeJS.ProcessEnv = { PYTHONUTF8: "1" };
  // The verifier only receives public hardware evidence, never inference credentials.
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ProgramData", "PROGRAMDATA", "TEMP", "TMP", "HOME", "USERPROFILE"] as const) {
    if (process.env[name]) env[name] = process.env[name];
  }
  if (options.nvidiaLocal) {
    const checked = nvidiaVerifierOptions({ NVIDIA_VERIFIER_MODE: "local", NVIDIA_NVAT_BINARY: options.nvidiaLocal.binaryPath,
      NVIDIA_NVAT_LIBRARY: options.nvidiaLocal.libraryPath });
    env.NVIDIA_VERIFIER_MODE = "local";
    env.NVIDIA_NVAT_BINARY = checked.nvidiaLocal!.binaryPath;
    env.NVIDIA_NVAT_LIBRARY = checked.nvidiaLocal!.libraryPath;
  }
  return new Promise<z.infer<typeof verdictSchema>>((resolve, reject) => {
    const child = spawn(options.pythonPath, [options.verifierPath ?? defaultNearVerifierPath(), "--policy", options.policyPath,
      ...(options.policySha256 === undefined ? [] : ["--policy-sha256", options.policySha256]),
      ...(archive ? [cloud ? "--cloud-archive" : "--direct-archive"] : cloud ? ["--cloud"] : [])], {
      env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, signal, detached: process.platform !== "win32",
    });
    // An owned POSIX process group includes the native verifier. Abort must stop
    // the whole group even if Python exits before cleaning up its child.
    let terminationTimer: NodeJS.Timeout | undefined;
    const terminateGroup = (kind: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch { /* Already exited; never forward process diagnostics. */ }
    };
    const terminate = () => {
      terminateGroup("SIGTERM");
      terminationTimer ??= setTimeout(() => terminateGroup("SIGKILL"), 3_000);
      terminationTimer.unref();
    };
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) terminate();
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (diagnostic: NearAttestationFailure) => { if (!settled) { settled = true; reject(unavailable(diagnostic)); } };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2_097_152) { terminate(); fail({ stage: "verifier", reason: "output-limit" }); return; }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", () => { /* Never forward arbitrary verifier diagnostics. */ });
    child.stdin.on("error", () => fail({ stage: "verifier", reason: signal.aborted ? "aborted" : "stdin-failed" }));
    child.on("error", () => fail({ stage: "verifier", reason: signal.aborted ? "aborted" : "process-failed" }));
    child.on("close", (code) => {
      signal.removeEventListener("abort", terminate);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (process.platform !== "win32") terminateGroup("SIGKILL");
      if (settled) return;
      if (signal.aborted) { fail({ stage: "verifier", reason: "aborted" }); return; }
      const output = Buffer.concat(chunks), verifierError = fixedVerifierError(output);
      if (verifierError) { fail({ stage: "verifier", reason: "rejected", verifierError }); return; }
      if (code !== 0) { fail({ stage: "verifier", reason: "process-failed" }); return; }
      try {
        const parsed = verdictSchema.parse(JSON.parse(output.toString("utf8")));
        if (archive && parsed.archivedHardwareVerified !== true) { fail({ stage: "verifier", reason: "archive-unverified" }); return; }
        settled = true;
        resolve(parsed);
      } catch { fail({ stage: "verifier", reason: "invalid-output" }); }
    });
    child.stdin.end(serializedInput);
  }).catch((error: unknown) => {
    if (isNearAttestationError(error)) throw error;
    throw unavailable({ stage: "verifier", reason: signal.aborted ? "aborted" : "process-failed" });
  });
}

/** A new nonce, policy read and hardware verification are required for every inference. */
export function createNearAttestationVerifier(options: NearProviderOptions): NearAttestationVerifier {
  if (!options.pythonPath || !options.policyPath) throw new Error("NEAR verifier runtime and versioned policy are required");
  if (options.policySha256 !== undefined && !/^0x[0-9a-f]{64}$/.test(options.policySha256)) throw new Error("NEAR policy fingerprint must be lowercase bytes32");
  const configuredAttempts = options.maxDirectAdmissionAttempts ?? 1;
  if (!Number.isSafeInteger(configuredAttempts) || configuredAttempts < 1 || configuredAttempts > 3) throw new Error("NEAR direct admission attempts must be an integer from 1 to 3");
  if (configuredAttempts > 1 && options.policySha256 === undefined) throw new Error("NEAR direct admission retries require a pinned policy fingerprint");
  return async ({ baseUrl, model, signal }) => {
    const base = nearBaseUrl(baseUrl);
    const cloud = base.hostname === "cloud-api.near.ai";
    const attempts = cloud ? 1 : configuredAttempts;
    const readRetryPolicy = async (): Promise<Buffer> => {
      if (signal.aborted) throw unavailable({ stage: "transport", reason: "aborted" });
      const bytes = await readFile(options.policyPath).catch(() => { throw unavailable({ stage: "policy", reason: "unreadable" }); });
      if (bytes.length > 1_048_576) throw unavailable({ stage: "policy", reason: "size" });
      if (sha256Hex(bytes) !== options.policySha256) throw unavailable({ stage: "policy", reason: "changed" });
      if (signal.aborted) throw unavailable({ stage: "transport", reason: "aborted" });
      return bytes;
    };
    const retryPolicy = attempts > 1 ? await readRetryPolicy() : undefined;
    const verifyAttempt = async () => {
      if (signal.aborted) throw unavailable({ stage: "transport", reason: "aborted" });
      const nonce = randomBytes(32).toString("hex");
      const reportUrl = new URL("/v1/attestation/report", base);
      reportUrl.searchParams.set("signing_algo", "ecdsa");
      reportUrl.searchParams.set("nonce", nonce);
      reportUrl.searchParams.set("include_tls_fingerprint", "true");
      if (cloud) {
        reportUrl.searchParams.set("model", model);
        reportUrl.searchParams.set("provider", "near");
        if (!options.apiKey?.trim() || /[\r\n]/.test(options.apiKey)) throw unavailable({ stage: "configuration", reason: "credentials" });
      }
      let attestedSpki: string | undefined;
      let handedOff = false;
      // Reuse the attested connection across the provider's load balancer. Every
      // reconnect still requires CA/hostname validation and the verified SPKI.
      const bootstrapAgent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, maxCachedSessions: 0,
        checkServerIdentity: (host, cert) => attestedSpki === undefined
          ? checkServerIdentity(host, cert) : checkNearCertificate(host, cert, attestedSpki),
      });
      try {
        const { response, peerSpki } = await requestBytes(reportUrl, { signal, headers: { accept: "application/json", "accept-encoding": "identity",
          ...(cloud ? { authorization: `Bearer ${options.apiKey}`, "x-no-aliasing": "true" } : {}) } }, bootstrapAgent);
        if (response.status !== 200) throw unavailable({ stage: "report", reason: "http-status" });
        const rawReport = await response.text();
        let report: Record<string, unknown>;
        try {
          const value: unknown = JSON.parse(rawReport);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable({ stage: "report", reason: "shape" });
          report = value as Record<string, unknown>;
        } catch (error) {
          if (isNearAttestationError(error)) throw error;
          throw unavailable({ stage: "report", reason: "json" });
        }
        const gatewayReport = cloud ? report.gateway_attestation as Record<string, unknown> | undefined : report;
        if (!gatewayReport || typeof gatewayReport !== "object" || Array.isArray(gatewayReport)
          || typeof gatewayReport.request_nonce !== "string" || typeof gatewayReport.tls_cert_fingerprint !== "string"
          || (cloud && (!Array.isArray(report.model_attestations) || report.model_attestations.length < 1))) throw unavailable({ stage: "report", reason: "shape" });
        if (gatewayReport.request_nonce !== nonce) throw unavailable({ stage: "report", reason: "nonce-binding" });
        if (normalizeHex(gatewayReport.tls_cert_fingerprint) !== peerSpki) throw unavailable({ stage: "report", reason: "tls-binding" });
        if (!cloud && report.model_name !== model) throw unavailable({ stage: "report", reason: "model-binding" });
        const policyBefore = await readFile(options.policyPath).catch(() => { throw unavailable({ stage: "policy", reason: "unreadable" }); });
        if (policyBefore.length > 1_048_576) throw unavailable({ stage: "policy", reason: "size" });
        if (retryPolicy && !policyBefore.equals(retryPolicy)) throw unavailable({ stage: "policy", reason: "changed" });
        const verdict = await runNearVerifier(options, cloud
          ? { attestation: report, model, nonce, tlsSpkiSha256: peerSpki }
          : { attestation: report, nonce, tlsSpkiSha256: peerSpki }, signal, cloud);
        const now = Date.now();
        if (normalizeHex(verdict.tlsSpkiSha256) !== peerSpki) throw unavailable({ stage: "session", reason: "tls-binding" });
        if (!cloud && (typeof report.signing_address !== "string" || verdict.signingAddress.toLowerCase() !== report.signing_address.toLowerCase())) throw unavailable({ stage: "session", reason: "signer" });
        if ((!cloud && verdict.allowedSigners !== undefined && (verdict.allowedSigners.length !== 1
            || verdict.allowedSigners[0]?.toLowerCase() !== verdict.signingAddress.toLowerCase()))
          || (cloud && (!verdict.allowedSigners || verdict.allowedSigners[0]?.toLowerCase() !== verdict.signingAddress.toLowerCase()))) throw unavailable({ stage: "session", reason: "signer-set" });
        if (Date.parse(verdict.verifiedAt) > now + 5_000 || Date.parse(verdict.verifiedAt) < now - 300_000
          || Date.parse(verdict.expiresAt) <= now || Date.parse(verdict.expiresAt) > Date.parse(verdict.verifiedAt) + 300_000) throw unavailable({ stage: "session", reason: "time" });
        const policyAfter = await readFile(options.policyPath).catch(() => { throw unavailable({ stage: "policy", reason: "unreadable" }); });
        if (!policyBefore.equals(policyAfter)) throw unavailable({ stage: "policy", reason: "changed" });
        if (signal.aborted) throw unavailable({ stage: "transport", reason: "aborted" });
        attestedSpki = peerSpki;
        const pinnedFetch: NearVerifiedFetch = async (url, init) => {
          if (url.origin !== base.origin) throw unavailable({ stage: "session", reason: "origin" });
          if (Date.parse(verdict.expiresAt) <= Date.now()) throw unavailable({ stage: "session", reason: "expired" });
          let wire: WireResponse;
          try { wire = await requestBytes(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "accept-encoding": "identity" } }, bootstrapAgent); }
          catch (error) { throw transportFailure(error, init.signal); }
          if (wire.peerSpki !== peerSpki) throw unavailable({ stage: "session", reason: "tls-binding" });
          if (wire.response.headers.get("content-encoding") && wire.response.headers.get("content-encoding") !== "identity") throw unavailable({ stage: "transport", reason: "encoding" });
          return wire.response;
        };
        const session = {
          allowedSigners: (cloud ? verdict.allowedSigners! : [verdict.signingAddress]) as `0x${string}`[],
          attestationRef: `0x${normalizeHex(verdict.attestationRef)}` as `0x${string}`,
          verifiedAt: verdict.verifiedAt, expiresAt: verdict.expiresAt, tlsBound: true as const,
          fetch: pinnedFetch, close: () => bootstrapAgent.destroy(),
          attestationProof: JSON.stringify({ report: JSON.parse(rawReport), verdict, policy: JSON.parse(policyBefore.toString("utf8")), policyHash: sha256Hex(policyBefore) }),
        };
        handedOff = true;
        return session;
      } catch (error) {
        if (isNearAttestationError(error)) throw error;
        throw transportFailure(error, signal);
      }
      finally { if (!handedOff) bootstrapAgent.destroy(); }
    };
    // Only an authenticated verifier rejection of an unknown direct workload
    // can select another connection. Every candidate still needs fresh complete
    // hardware verification under the same pinned policy and caller deadline.
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (retryPolicy && !(await readRetryPolicy()).equals(retryPolicy)) throw unavailable({ stage: "policy", reason: "changed" });
      try { return await verifyAttempt(); }
      catch (error) {
        if (signal.aborted) {
          if (isNearAttestationError(error) && !isUnapprovedNearWorkload(error)) throw error;
          throw unavailable({ stage: "transport", reason: "aborted" });
        }
        if (cloud || !(isNearAttestationError(error)) || !isUnapprovedNearWorkload(error) || attempt + 1 >= attempts) throw error;
        // Destroyed by verifyAttempt's finally before waiting or selecting again.
        if (retryPolicy && !(await readRetryPolicy()).equals(retryPolicy)) throw unavailable({ stage: "policy", reason: "changed" });
        try { await delay(100, undefined, { signal }); }
        catch (waitError) { throw transportFailure(waitError, signal); }
      }
    }
    throw unavailable({ stage: "verifier", reason: "process-failed" });
  };
}
