import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { addressSchema, sameAddress, bytes32Schema, canonical } from '../common.js';
import { cystInputDescriptorSchema, cystInputDescriptorHash, signedCystInputResultSchema,
  type CystInputDescriptor, type SignedCystInputResult } from '../host-kit/sessions/cyst-input-protocol.js';
import { parsePaidSessionLease } from '../host-kit/sessions/paid-protocol.js';
import { hostMessageHash, verifyHostMessage } from '../host-kit/protocol.js';
import type { PlatformVaultRuntimeClient } from '../platform-runtime/vault-client.js';

type RuntimeClient = Pick<PlatformVaultRuntimeClient, 'origin' | 'config' | 'get' | 'sessionLease'>;
/** The checked agent's binary transport. Local source paths never enter the API. */
export class PaidCystInputClient {
  readonly origin: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: { baseUrl: string; vault: string; sessionToken: string;
    client: RuntimeClient; fetchImpl?: typeof fetch }) {
    this.options = Object.freeze({ ...options });
    const url = new URL(options.baseUrl);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password
      || !['https:', 'http:'].includes(url.protocol)
      || url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !/^[a-f0-9]{64}$/.test(options.sessionToken)) throw new Error('Use a checked HTTPS origin and original agent session');
    this.origin = url.origin; this.fetcher = options.fetchImpl ?? fetch;
    if (options.client.origin !== this.origin) throw new Error('Binary input and checked runtime must use the same reviewed origin');
    addressSchema.parse(options.vault);
  }
  private path(runId: string, descriptor: CystInputDescriptor) {
    return this.origin + '/api/platform/vaults/' + this.options.vault + '/runs/' + runId + '/inputs/' + descriptor.operationId;
  }
  private async scope(runId: string, descriptor: CystInputDescriptor) {
    const id = bytes32Schema.parse(runId), expected = cystInputDescriptorSchema.parse(descriptor);
    const config = await this.options.client.config(), run = await this.options.client.get(id);
    const evidence = await this.options.client.sessionLease(id), { lease, payload } = parsePaidSessionLease(evidence.lease);
    const host = config.capacity.find(value => value.hostId === run.quote.hostId);
    if (!sameAddress(config.binding.vault, addressSchema.parse(this.options.vault)) || config.binding.agentId !== expected.agentId
      || !sameAddress(config.binding.owner, addressSchema.parse(expected.checkpoint.owner))
      || !sameAddress(config.binding.agentWallet, addressSchema.parse(expected.checkpoint.agent))
      || !payload.spec.cystInput || cystInputDescriptorHash(payload.spec.cystInput) !== cystInputDescriptorHash(expected)
      || !host || (host.cystInputMaxBytes ?? 0) < expected.plaintextBytes
      || lease.body.runId !== id || !sameAddress(lease.body.owner, addressSchema.parse(this.options.vault))
      || hostMessageHash(lease) !== evidence.leaseHash) throw new Error('Paid file input differs from the original checked Vault session');
    return { id, expected, lease, run };
  }
  private async checked(response: Response, scope: Awaited<ReturnType<PaidCystInputClient['scope']>>): Promise<SignedCystInputResult> {
    if (response.status !== 200) { await response.body?.cancel(); throw new Error('Paid file request failed with HTTP ' + response.status); }
    if (!/(^|,)\s*no-store\s*(,|$)/i.test(response.headers.get('cache-control') ?? '')) {
      await response.body?.cancel(); throw new Error('Paid file response must be private and uncached');
    }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Paid file response is empty');
    const parts: Uint8Array[] = []; let length = 0;
    try { for (;;) { const item = await reader.read(); if (item.done) break;
      if (item.value.byteLength > 8192 - length) throw new Error('Paid file response exceeds its bound');
      parts.push(item.value); length += item.value.byteLength; } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const result = signedCystInputResultSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, length))));
    const body = result.body;
    if (!verifyHostMessage(scope.lease.body.hostKey, 'cyst-input-result', result) || body.hostKey !== scope.lease.body.hostKey
      || body.runId !== scope.id || !sameAddress(body.owner, addressSchema.parse(this.options.vault))
      || body.leaseHash !== hostMessageHash(scope.lease) || body.operationId !== scope.expected.operationId
      || body.descriptorHash !== cystInputDescriptorHash(scope.expected)
      || body.plaintextBytes !== scope.expected.plaintextBytes || body.plaintextSha256 !== scope.expected.plaintextSha256
      || body.state === 'ready' && !body.committed || ['waiting', 'staged'].includes(body.state) && body.committed) {
      throw new Error('Paid input response changed its original signed file binding');
    }
    return result;
  }
  async status(runId: string, descriptor: CystInputDescriptor) {
    const scope = await this.scope(runId, descriptor);
    return this.checked(await this.fetcher(this.path(scope.id, scope.expected), { method: 'GET', redirect: 'error',
      headers: { Cookie: 'telomere_session=' + this.options.sessionToken }, credentials: 'include', cache: 'no-store',
      signal: AbortSignal.timeout(15_000) }), scope);
  }
  async uploadFile(runId: string, raw: CystInputDescriptor, sourcePath: string, signal?: AbortSignal) {
    const scope = await this.scope(runId, raw);
    const known = await this.status(scope.id, scope.expected);
    if (known.body.committed) return known;
    if (!isAbsolute(sourcePath) || scope.run.status !== 'running' || scope.lease.body.expiresAt <= Date.now()) {
      throw new Error('A private source file and an active original paid lease are required');
    }
    const before = await lstat(sourcePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(scope.expected.plaintextBytes)
      || process.platform !== 'win32' && ((before.mode & 0o777n) !== 0o600n
        || typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid()))) throw new Error('Prepared state is not a private immutable source');
    const file = await open(sourcePath, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    const identity = (s: typeof before) => canonical([s.dev.toString(), s.ino.toString(), s.size.toString(), s.mtimeNs.toString(), s.ctimeNs.toString()]);
    let stopped = false, pending: Promise<void> = Promise.resolve();
    try {
      if (identity(before) !== identity(await file.stat({ bigint: true }))) throw new Error('Prepared file changed while opening');
      const hash = createHash('sha256'), checkedBytes = Buffer.alloc(65_536);
      try {
        let checkedOffset = 0;
        while (checkedOffset < scope.expected.plaintextBytes) {
          signal?.throwIfAborted();
          if (scope.lease.body.expiresAt <= Date.now()) throw new Error('Original paid input lease expired');
          const value = await file.read(checkedBytes, 0, Math.min(checkedBytes.length, scope.expected.plaintextBytes - checkedOffset), checkedOffset);
          if (!value.bytesRead) throw new Error('Prepared file ended early');
          hash.update(checkedBytes.subarray(0, value.bytesRead)); checkedOffset += value.bytesRead;
        }
      } finally { checkedBytes.fill(0); }
      if (hash.digest('hex') !== scope.expected.plaintextSha256 || identity(before) !== identity(await file.stat({ bigint: true }))
        || identity(before) !== identity(await lstat(sourcePath, { bigint: true }))) throw new Error('Prepared file differs from its declared digest');
      let offset = 0;
      const input = new ReadableStream<Uint8Array>({ pull: controller => { pending = (async () => {
        if (stopped) return;
        if (offset === scope.expected.plaintextBytes) { controller.close(); return; }
        const bytes = Buffer.alloc(Math.min(65_536, scope.expected.plaintextBytes - offset));
        const part = await file.read(bytes, 0, bytes.length, offset);
        if (!part.bytesRead) throw new Error('Prepared file ended early');
        if (stopped) return;
        offset += part.bytesRead; controller.enqueue(bytes.subarray(0, part.bytesRead));
      })(); return pending; }, cancel() { stopped = true; } });
      const remaining = scope.lease.body.expiresAt - Date.now();
      if (remaining <= 0) throw new Error('Original paid input lease expired');
      const options: RequestInit & { duplex: 'half' } = { method: 'PUT', duplex: 'half', redirect: 'error',
        headers: { Cookie: 'telomere_session=' + this.options.sessionToken, Origin: this.origin, 'Content-Type': 'application/octet-stream',
          'Content-Length': String(scope.expected.plaintextBytes), 'Idempotency-Key': scope.expected.operationId },
        credentials: 'include', cache: 'no-store', body: input,
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(remaining)]) };
      const result = await this.checked(await this.fetcher(this.path(scope.id, scope.expected), options), scope);
      if (!result.body.committed || identity(before) !== identity(await file.stat({ bigint: true }))
        || identity(before) !== identity(await lstat(sourcePath, { bigint: true }))) throw new Error('Prepared file or committed result changed during transfer');
      return result;
    } finally { stopped = true; await pending.catch(() => undefined); await file.close(); }
  }
}
