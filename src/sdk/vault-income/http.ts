import { incomeStrictJson } from '../../selection/income-endpoints/json.js';
import { VaultIncomeClientError } from './types.js';

export type VaultIncomeFetch = (url: string, init: RequestInit) => Promise<Response>;
export type VaultIncomeHttpResponse = { status: number; required?: unknown; payment?: unknown; body: unknown };
export function vaultIncomeStrictJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes('\0') || text.charCodeAt(0) === 0xfeff || Buffer.from(text).toString('utf8') !== text) throw new Error('UTF-8');
  const parsed = incomeStrictJson(text);
  function strings(value: unknown): void {
    if (typeof value === 'string' && (value.includes('\0') || Buffer.from(value).toString('utf8') !== value)) throw new Error('UTF-8');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { strings(key); strings(child); }
  }
  strings(parsed); return parsed;
}
function header(value: string | null): unknown {
  if (!value || value.length > 8192 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('header');
  const bytes = Buffer.from(value, 'base64'); if (bytes.toString('base64') !== value) throw new Error('header');
  return vaultIncomeStrictJson(bytes);
}
/** Public, cookie-free transport. The deadline covers fetch, headers and the complete body. */
export class VaultIncomePublicHttp {
  constructor(private readonly url: string, private readonly fetcher: VaultIncomeFetch = fetch) {}
  async send(signedHeader?: string): Promise<VaultIncomeHttpResponse> {
    if (signedHeader !== undefined && Buffer.byteLength(signedHeader) > 8192) throw new VaultIncomeClientError('vault_income_request_limit');
    const controller = new AbortController(); let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { controller.abort(); try { void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => undefined); } catch { /* Preserve bounded failure. */ } };
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new VaultIncomeClientError('vault_income_http_timeout')); cancel(); }, 10_000); });
    try {
      const fetching = this.fetcher(this.url, { method: 'POST', body: '{}', credentials: 'omit', redirect: 'error',
        cache: 'no-store', headers: { 'Content-Type': 'application/json', ...(signedHeader ? { 'PAYMENT-SIGNATURE': signedHeader } : {}) }, signal: controller.signal });
      void fetching.then(late => { if (controller.signal.aborted) void late.body?.cancel().catch(() => undefined); }, () => undefined);
      response = await Promise.race([fetching, deadline]);
      if (response.redirected || response.url && response.url !== this.url) throw new Error('redirect');
      let count = 0, bytes = 0; for (const [key, value] of response.headers) { count++; bytes += Buffer.byteLength(key) + Buffer.byteLength(value); }
      if (count > 40 || bytes > 8192 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) throw new Error('headers');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 16_384)) throw new Error('length');
      const required = response.headers.has('PAYMENT-REQUIRED') ? header(response.headers.get('PAYMENT-REQUIRED')) : undefined;
      const payment = response.headers.has('PAYMENT-RESPONSE') ? header(response.headers.get('PAYMENT-RESPONSE')) : undefined;
      reader = response.body?.getReader(); if (!reader) throw new Error('body');
      const chunks: Uint8Array[] = []; let total = 0;
      while (true) { const chunk = await Promise.race([reader.read(), deadline]); if (chunk.done) break;
        total += chunk.value.byteLength; if (total > 16_384) throw new Error('body'); chunks.push(chunk.value); }
      return { status: response.status, ...(required !== undefined ? { required } : {}), ...(payment !== undefined ? { payment } : {}),
        body: vaultIncomeStrictJson(Buffer.concat(chunks)) };
    } catch (error) { cancel(); if (error instanceof VaultIncomeClientError) throw error; throw new VaultIncomeClientError('vault_income_http_invalid'); }
    finally { clearTimeout(timer); try { reader?.releaseLock(); } catch { /* A cancelled read may still be pending. */ } }
  }
}
