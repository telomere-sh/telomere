import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { parseLargeCystManifest, type LargeCystHeader, type LargeCystManifest,
  restoreLargeCystFileWithWrappedKey, type LargeCystScope, type LargeCystStore } from '../cysts/large-checkpoints.js';
import { largeCystCurrentCheckpointSchema } from '../cysts/large-publication-types.js';
import { largeCystRegistryDescriptor, largeCystRegistryMatches } from '../cysts/large-registry.js';
import { cystRegistryHashSchema, cystRegistryPinsSchema, cystRegistrySnapshotSchema,
  type CystRegistryReader } from '../cysts/registry-types.js';
import { cystIdSchema } from '../cysts/types.js';
import type { CystWrappingIdentity } from './cyst-key-wrap.js';

const MAX_MANIFEST_BYTES = 131_072;
const MAX_CURRENT_BYTES = 147_456;

/** Read-only client for the original Selection agent's signed session.
 * checkedLargeCystCommitPlan independently authenticates this value with the
 * recovery key before it can return unsigned calldata.
 */
export class LargeCystAgentManifestStore implements Pick<LargeCystStore, 'manifest' | 'header' | 'part'> {
  private readonly origin: string;
  private readonly agentId: string;
  private readonly sessionToken: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { baseUrl: string; agentId: string; sessionToken: string; fetchImpl?: typeof fetch }) {
    const url = new URL(options.baseUrl);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password
      || !['https:', 'http:'].includes(url.protocol)
      || url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('Use an HTTPS origin or loopback HTTP for the agent manifest client');
    }
    if (!/^[0-9a-f]{64}$/.test(options.sessionToken)) throw new Error('Invalid agent session');
    this.origin = url.origin;
    this.agentId = cystRegistryHashSchema.parse(options.agentId);
    this.sessionToken = options.sessionToken;
    this.fetcher = options.fetchImpl ?? fetch;
  }

  async manifest(id: string, signal?: AbortSignal): Promise<LargeCystManifest | undefined> {
    signal?.throwIfAborted();
    const checkpointId = cystIdSchema.parse(id);
    const response = await this.fetcher(`${this.origin}/api/cysts-large-registry/agents/${this.agentId}`
      + `/checkpoints/${checkpointId}/manifest`, {
      method: 'GET', headers: { Cookie: 'telomere_session=' + this.sessionToken },
      credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
    });
    if (response.status === 404) { await response.body?.cancel(); return undefined; }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error('Agent manifest request failed with HTTP ' + response.status);
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')
      || !/(^|,)\s*no-store\s*(,|$)/i.test(response.headers.get('cache-control') ?? '')
      || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
      await response.body?.cancel();
      throw new Error('Agent manifest response headers are invalid');
    }
    const claimed = response.headers.get('content-length');
    if (claimed !== null && (!/^(0|[1-9][0-9]{0,6})$/.test(claimed) || Number(claimed) > MAX_MANIFEST_BYTES)) {
      await response.body?.cancel();
      throw new Error('Agent manifest response exceeds the byte limit');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Agent manifest response body is missing');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (part.value.byteLength > MAX_MANIFEST_BYTES - length) throw new Error('Agent manifest response exceeds the byte limit');
        chunks.push(part.value);
        length += part.value.byteLength;
      }
      if (claimed !== null && length !== Number(claimed)) throw new Error('Agent manifest response length changed');
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))); }
    catch { throw new Error('Agent manifest JSON is invalid'); }
    const manifest = parseLargeCystManifest(raw);
    if (manifest.header.id !== checkpointId) throw new Error('Agent manifest ID changed');
    return manifest;
  }

  async header(id: string, signal?: AbortSignal): Promise<LargeCystHeader | undefined> {
    return (await this.manifest(id, signal))?.header;
  }

  private async assertCurrent(reader: CystRegistryReader,
    resolved: z.infer<typeof largeCystCurrentCheckpointSchema>): Promise<void> {
    const pins = cystRegistryPinsSchema.parse(reader.pins);
    if (pins.chainId !== resolved.pins.chainId || pins.registryAddress !== resolved.pins.registryAddress
      || pins.registryCodeHash !== resolved.pins.registryCodeHash
      || pins.selectionRegistryAddress !== resolved.pins.selectionRegistryAddress
      || pins.selectionRegistryCodeHash !== resolved.pins.selectionRegistryCodeHash
      || pins.confirmations !== resolved.pins.confirmations) {
      throw new Error('Current checkpoint registry pins differ');
    }
    await reader.check();
    const fresh = cystRegistrySnapshotSchema.parse(await reader.snapshot(this.agentId));
    if (JSON.stringify(fresh.binding) !== JSON.stringify(resolved.binding)
      || BigInt(fresh.current.block.number) < BigInt(resolved.current.block.number)
      || fresh.current.block.number === resolved.current.block.number
        && fresh.current.block.hash !== resolved.current.block.hash
      || JSON.stringify({ ...fresh.current, block: undefined })
        !== JSON.stringify({ ...resolved.current, block: undefined })
      || !largeCystRegistryMatches(fresh.current, resolved.checkpoint)) {
      throw new Error('Current checkpoint changed on the canonical registry');
    }
  }

  /** Resolve the currently published locator with a separate, pinned registry
   * reader. The returned manifest remains ciphertext metadata until the agent
   * authenticates its wrapped recovery key during restore.
   */
  async resolveCurrent(reader: CystRegistryReader, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const response = await this.fetcher(`${this.origin}/api/cysts-large-registry/agents/${this.agentId}`
      + '/checkpoints/current', {
      method: 'GET', headers: { Cookie: 'telomere_session=' + this.sessionToken },
      credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error('Current checkpoint request failed with HTTP ' + response.status);
    }
    const declared = response.headers.get('content-length');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')
      || !/(^|,)\s*no-store\s*(,|$)/i.test(response.headers.get('cache-control') ?? '')
      || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity'
      || declared === null || !/^(0|[1-9][0-9]{0,6})$/.test(declared)
      || Number(declared) > MAX_CURRENT_BYTES) {
      await response.body?.cancel();
      throw new Error('Current checkpoint response headers are invalid');
    }
    const stream = response.body?.getReader();
    if (!stream) throw new Error('Current checkpoint response body is missing');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const item = await stream.read();
        if (item.done) break;
        if (item.value.byteLength > MAX_CURRENT_BYTES - length) throw new Error('Current checkpoint response exceeds its bound');
        chunks.push(item.value);
        length += item.value.byteLength;
      }
    } finally {
      await stream.cancel().catch(() => undefined);
      stream.releaseLock();
    }
    if (length !== Number(declared)) throw new Error('Current checkpoint response length changed');
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))); }
    catch { throw new Error('Current checkpoint JSON is invalid'); }
    const resolved = largeCystCurrentCheckpointSchema.parse(raw);
    const manifest = parseLargeCystManifest(resolved.manifest);
    const descriptor = largeCystRegistryDescriptor(manifest);
    if (resolved.binding.agentId !== this.agentId || resolved.current.agentId !== this.agentId
      || resolved.checkpointId !== manifest.header.id
      || descriptor.owner !== resolved.binding.owner.toLowerCase()
      || descriptor.agent !== resolved.binding.agentWallet.toLowerCase()
      || JSON.stringify(resolved.checkpoint) !== JSON.stringify(descriptor)
      || !largeCystRegistryMatches(resolved.current, descriptor)) {
      throw new Error('Current checkpoint descriptor differs from its manifest');
    }
    await this.assertCurrent(reader, resolved);
    signal?.throwIfAborted();
    return { ...resolved, manifest };
  }

  /** Restore an agent's current Cyst only if the same canonical revision still
   * exists after the full ciphertext download and MAC verification. The final
   * registry read occurs before the destination file is published.
   */
  async restoreCurrent(options: { reader: CystRegistryReader; destinationPath: string;
    scope: LargeCystScope; identity: CystWrappingIdentity }): Promise<void> {
    const resolved = await this.resolveCurrent(options.reader);
    await restoreLargeCystFileWithWrappedKey({
      store: { manifest: async id => id === resolved.checkpointId ? resolved.manifest : undefined,
        header: async id => id === resolved.checkpointId ? resolved.manifest.header : undefined,
        part: (id, index) => this.part(id, index) },
      id: resolved.checkpointId, destinationPath: options.destinationPath,
      scope: options.scope, recipient: 'agent', identity: options.identity,
      beforePublish: () => this.assertCurrent(options.reader, resolved),
    });
  }

  /** Read-only agent download. The manifest digest and exact length are checked
   * independently of the controller before the ciphertext reaches restore.
   */
  async part(id: string, index: number, signal?: AbortSignal): Promise<Buffer | undefined> {
    signal?.throwIfAborted();
    const checkpointId = cystIdSchema.parse(id);
    const manifest = await this.manifest(checkpointId, signal);
    if (!manifest) return undefined;
    if (!Number.isInteger(index) || index < 0 || index >= manifest.parts.length) throw new Error('Invalid agent part index');
    const expected = manifest.parts[index];
    if (!expected || expected.index !== index) throw new Error('Agent manifest part order changed');
    const response = await this.fetcher(`${this.origin}/api/cysts-large-registry/agents/${this.agentId}`
      + `/checkpoints/${checkpointId}/parts/${index}`, {
      method: 'GET', headers: { Cookie: 'telomere_session=' + this.sessionToken },
      credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]),
    });
    if (response.status === 404) { await response.body?.cancel(); return undefined; }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error('Agent part request failed with HTTP ' + response.status);
    }
    if (response.headers.get('content-type') !== 'application/octet-stream'
      || !/(^|,)\s*no-store\s*(,|$)/i.test(response.headers.get('cache-control') ?? '')
      || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity'
      || response.headers.get('content-length') !== String(expected.bytes)) {
      await response.body?.cancel();
      throw new Error('Agent part response headers are invalid');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Agent part response body is missing');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        if (item.value.byteLength > expected.bytes - length) throw new Error('Agent part response exceeds its bound');
        chunks.push(item.value);
        length += item.value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, length);
    if (length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      throw new Error('Agent part integrity check failed');
    }
    return bytes;
  }
}
