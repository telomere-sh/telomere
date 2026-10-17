import type { FetchTransport } from "./types.js";

export class TelomereApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Telomere request failed (${status}: ${code})`); this.name = "TelomereApiError";
  }
}
export function isLoopback(url: URL): boolean { return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname); }
export class ApiTransport {
  readonly origin: string;
  private sessionToken: string | undefined;
  private readonly fetcher: FetchTransport;
  constructor(baseUrl: string, options: { sessionToken?: string; fetch?: FetchTransport } = {}) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)
      || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url)))) {
      throw new Error("Use an HTTPS Telomere origin or a loopback HTTP demo origin");
    }
    this.origin = url.origin;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    if (options.sessionToken !== undefined) this.setSessionToken(options.sessionToken);
  }
  setSessionToken(token: string): void {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid Telomere session token");
    this.sessionToken = token;
  }
  clearSession(): void { this.sessionToken = undefined; }
  async request(path: string, options: { method?: "GET" | "POST"; body?: unknown; idempotencyKey?: string;
    maxResponseBytes?: number; timeoutMs?: number; cystQuotaVersion?: 2; acceptCpuPaymentRequired?: true } = {}): Promise<unknown> {
    if (!/^\/api\/[a-zA-Z0-9/_?=&.%:-]+$/.test(path)) throw new Error("Invalid Telomere API path");
    const limit = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_800_320) throw new Error("Invalid Telomere response bound");
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 130_000) throw new Error("Invalid Telomere request timeout");
    const method = options.method ?? "GET";
    if (options.acceptCpuPaymentRequired && (path !== '/api/platform/cells' || method !== 'POST')) throw new Error('CPU payment challenge handling is restricted to its explicit reservation resource');
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.cystQuotaVersion !== undefined) {
      if (options.cystQuotaVersion !== 2 || !/^\/api\/cysts(?:$|[/?])/.test(path) || /\.\.|%2e|%2f|%5c/i.test(path)) {
        throw new Error('Checkpoint quota profile is restricted to Cyst requests');
      }
      headers['X-Telomere-Cyst-Quota'] = '2';
    }
    if (method === "POST") { headers.Origin = this.origin; headers["Content-Type"] = "application/json"; }
    if (this.sessionToken) headers.Cookie = `telomere_session=${this.sessionToken}`;
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    const response = await this.fetcher(this.origin + path, { method, headers, credentials: "include", redirect: "error",
      signal: AbortSignal.timeout(timeoutMs), ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    // Node has no browser cookie jar; retain only this API's exact scoped cookie.
    // Browsers retain the server's HttpOnly cookie through credentials: include.
    const setCookie = response.headers.get("set-cookie");
    const match = setCookie?.match(/(?:^|,\s*)telomere_session=([a-f0-9]{64})(?:;|$)/);
    if (match?.[1]) this.sessionToken = match[1];
    if (Number(response.headers.get("content-length") ?? "0") > limit) {
      void response.body?.cancel().catch(() => {});
      throw new TelomereApiError(502, "response_limit");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new TelomereApiError(502, "invalid_response");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.byteLength;
        if (size > limit) { void reader.cancel().catch(() => {}); throw new TelomereApiError(502, "response_limit"); }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new TelomereApiError(502, "invalid_response"); }
    if (!response.ok && !(response.status === 402 && options.acceptCpuPaymentRequired)) {
      const title = value && typeof value === "object" && "title" in value ? value.title : undefined;
      const code = typeof title === "string" && /^[a-z_]{1,64}$/.test(title) ? title : "request_failed";
      throw new TelomereApiError(response.status, code);
    }
    return value;
  }
}
