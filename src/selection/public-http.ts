import { z } from 'zod';

/** Operator-configured loopback service only; never a caller-selected URL. */
export const selectionPublicOrigin = z.string().url().refine(value => {
  const u = new URL(value);
  return u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)
    && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password;
}, 'Use a loopback HTTP Selection service origin');

export async function selectionPublicJson(origin: string, path: string, options: {
  fetch?: typeof fetch; timeoutMs?: number; limit?: number;
} = {}): Promise<unknown> {
  const base = selectionPublicOrigin.parse(origin), timeout = options.timeoutMs ?? 5000, limit = options.limit ?? 2_097_152;
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 40_000 || !Number.isInteger(limit) || limit < 1 || limit > 2_097_152
    || !path.startsWith('/') || path.startsWith('//') || path.includes('#')) throw new Error('Invalid Selection read boundary');
  const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(new Error('Selection read deadline')); controller.abort(); void reader?.cancel().catch(() => undefined);
  }, timeout); });
  try {
    const response = await Promise.race([(options.fetch ?? fetch)(new URL(path, base), { method: 'GET', redirect: 'error',
      credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal }), deadline]);
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')
      || Number(response.headers.get('content-length') ?? 0) > limit) throw new Error('Selection source unavailable');
    reader = response.body?.getReader(); if (!reader) throw new Error('Selection response missing');
    const parts: Uint8Array[] = []; let size = 0;
    while (true) {
      const part = await Promise.race([reader.read(), deadline]); if (part.done) break;
      size += part.value.byteLength; if (size > limit) throw new Error('Selection response limit'); parts.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => undefined); }
}

const units = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
export const selectionPublicHealthSchema = z.object({ version: z.literal(1), state: z.enum(['ready', 'syncing', 'unavailable']),
  chainId: z.number().int().positive(), registryAddress: z.string().regex(/^0x[0-9a-f]{40}$/), confirmations: z.number().int().min(3),
  indexedThrough: units.nullable(), asOfSeconds: units.nullable(), stale: z.boolean() }).strict();
export type SelectionPublicHealth = z.infer<typeof selectionPublicHealthSchema>;
