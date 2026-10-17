import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { type ReadOnlyErc8004Rpc } from './erc8004-testnet-probe.js';

// Historical Robinhood transport retained for its bounded-RPC regression tests.
// No public ERC-8004 registry has been approved for the new Base target.
const methods = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call']);
const maximumResponseBytes = 262_144;

export function createReadOnlyRpc(urlText: string, fetchFn: typeof fetch = fetch): ReadOnlyErc8004Rpc {
  const url = new URL(urlText);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('ERC-8004 preflight requires an HTTPS RPC URL without URL credentials');
  }
  let id = 0;
  return { async request(method, params) {
    if (!methods.has(method)) throw new Error('ERC-8004 RPC method is not read-only');
    const response = await fetchFn(url.href, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !response.body) throw new Error('ERC-8004 RPC unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.byteLength;
        if (length > maximumResponseBytes) throw new Error('ERC-8004 RPC response too large');
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!decoded || typeof decoded !== 'object' || !('result' in decoded) || 'error' in decoded) {
      throw new Error('ERC-8004 RPC failed');
    }
    return decoded.result;
  } };
}

async function main() {
  throw new Error('Historical Robinhood ERC-8004 probe is disabled; Base registry pins require separate review');
}

// ESM entry-point guard keeps the transport importable in isolated tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // An RPC exception may contain a private provider URL. Deliberately suppress it.
    process.stderr.write(JSON.stringify({ status: 'erc8004_readonly_preflight_failed' }) + '\n');
    process.exitCode = 1;
  });
}
