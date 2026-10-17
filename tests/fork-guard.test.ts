import { describe, expect, it } from 'vitest';
import { assertForkMutationTarget } from '../src/operator/fork-guard.js';

describe('issuer-token fork mutation boundary', () => {
  const child = { pid: 12345, port: 25123, exited: false };
  it('accepts the exact fresh loopback endpoint of a live child', () => {
    expect(() => assertForkMutationTarget('http://127.0.0.1:25123', child)).not.toThrow();
  });
  it.each(['https://sepolia.base.org', 'https://mainnet.base.org', 'http://127.0.0.1:18547', 'http://localhost:25123',
    'http://127.0.0.1:25124', 'http://127.0.0.1:25123/path', 'http://user:secret@127.0.0.1:25123',
    'http://127.0.0.1:25123?token=secret'])('rejects %s before native/token/impersonation mutation', endpoint => {
    expect(() => assertForkMutationTarget(endpoint, child)).toThrow();
  });
  it('rejects an exited or unowned process and known live staging ports', () => {
    expect(() => assertForkMutationTarget('http://127.0.0.1:25123', { ...child, exited: true })).toThrow();
    expect(() => assertForkMutationTarget('http://127.0.0.1:25123', { ...child, pid: undefined })).toThrow();
    expect(() => assertForkMutationTarget('http://127.0.0.1:18547', { ...child, port: 18547 })).toThrow();
  });
});
