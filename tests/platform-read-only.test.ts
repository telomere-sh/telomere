import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createPlatformReadOnlyBridge } from '../src/platform-runtime/read-only.js';
import { platformPinsSchema } from '../src/platform-runtime/types.js';

const address = `0x${'1'.repeat(40)}`, hash = `0x${'2'.repeat(64)}`;
const pins = platformPinsSchema.parse({ chainId: 31337, escrowAddress: address,
  tokenAddress: address, quoteSigner: address, receiptRootAddress: address,
  hostRegistryAddress: address, feeRouterAddress: address, tokenCodeHash: hash,
  reviewedTokenKind: 'immutable', escrowCodeHash: hash, receiptRootCodeHash: hash,
  hostRegistryCodeHash: hash, feeRouterCodeHash: hash });

describe('independent Platform read-only transport', () => {
  it('rejects unreviewed RPC transports before making a request', () => {
    for (const url of ['http://remote.example', 'https://remote.example',
      'http://user:secret@localhost', 'http://localhost/#secret', 'file:///rpc']) {
      expect(() => createPlatformReadOnlyBridge(pins, url)).toThrow();
    }
    const reader = createPlatformReadOnlyBridge(pins, 'http://localhost:1');
    expect('wallet' in reader || 'account' in reader || 'transactions' in reader).toBe(false);
  });

  it('aborts an actual stalled RPC request instead of leaving the CLI transport running', async () => {
    let started!: () => void;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    const server = createServer((_request, _response) => { started(); });
    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const startDeadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { abort.abort(); reject(new Error('RPC fixture did not receive a request')); }, 3_000);
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const bound = server.address();
      if (!bound || typeof bound === 'string') throw new Error('Missing read-only RPC fixture port');
      const reader = createPlatformReadOnlyBridge(pins, `http://127.0.0.1:${bound.port}`, abort.signal);
      const stopped = expect(reader.check()).rejects.toThrow();
      await Promise.race([requestStarted, startDeadline]);
      const requestedAt = Date.now();
      abort.abort();
      await stopped;
      expect(Date.now() - requestedAt).toBeLessThan(2_000);
    } finally {
      if (timeout) clearTimeout(timeout);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 5_000);
});
