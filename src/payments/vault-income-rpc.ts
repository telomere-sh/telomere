import { incomeStrictJson } from '../selection/income-endpoints/json.js';

const unavailable = () => new Error('Vault income RPC is unavailable');
const limit = 262_144;

/** Keep the deadline through the complete RPC body; viem's normal HTTP timer
 * covers only receipt of headers. This transport never follows redirects.
 */
export const vaultIncomeRpcFetch: typeof fetch = async (input, init) => {
  const controller = new AbortController();
  const signal = init?.signal === undefined && input instanceof Request ? input.signal : init?.signal;
  if (signal?.aborted) throw unavailable();
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => {};
  const cancel = () => {
    controller.abort();
    if (reader) void reader.cancel().catch(() => undefined);
    else void response?.body?.cancel().catch(() => undefined);
  };
  const deadline = new Promise<never>((_resolve, reject) => {
    stop = () => { reject(unavailable()); cancel(); };
    timer = setTimeout(stop, 10_000);
  });
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  try {
    response = await Promise.race([fetch(input, { ...init, signal: controller.signal, redirect: 'error' }), deadline]);
    let bytes = 0, fields = 0;
    for (const [name, value] of response.headers) { bytes += Buffer.byteLength(name) + Buffer.byteLength(value); fields++; }
    const length = response.headers.get('content-length');
    if (!response.ok || bytes > 8192 || fields > 40 || length !== null && (!/^(0|[1-9][0-9]*)$/.test(length)
      || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) throw unavailable();
    reader = response.body?.getReader(); if (!reader) throw unavailable();
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > limit) throw unavailable(); chunks.push(chunk.value);
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    incomeStrictJson(text);
    return new Response(text, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  } catch { throw unavailable(); }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', stop); cancel();
    try { reader?.releaseLock(); } catch { /* Cancellation is deliberately nonblocking. */ }
  }
};
