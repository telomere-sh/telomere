import { describe, expect, it, vi } from 'vitest';
import { GolemStatsReader } from '../src/suppliers/golem-stats.js';

const node = '0x' + 'a'.repeat(40);
const another = '0x' + 'b'.repeat(40);
const observed = '2026-10-13T00:00:00.000Z';
const now = Date.parse(observed) + 30_000;

function fixture(id = node) {
  return [{ node_id: id, runtimes: { vm: { properties: { id, 'golem.runtime.name': 'vm',
    'golem.inf.cpu.cores': 4, 'golem.inf.cpu.threads': 8,
    'golem.inf.mem.gib': 15.5, 'golem.inf.storage.gib': 64 } } },
  online: true, updated_at: observed }];
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' } });
}

describe('Golem Stats read-only provider inventory', () => {
  it('queries only the fixed public GET endpoint and labels data as indexed observation', async () => {
    const fetcher = vi.fn(async () => json(fixture())) as unknown as typeof fetch;
    const result = await new GolemStatsReader(fetcher, () => now).provider(node);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('https://api.stats.golem.network/v2/provider/node/' + node,
      expect.objectContaining({ method: 'GET', redirect: 'error', headers: { accept: 'application/json' } }));
    expect(result).toEqual({ nodeId: node, runtime: 'vm', cpuCores: 4, cpuThreads: 8,
      memoryGiB: 15.5, storageGiB: 64, onlineReported: true, observedAt: observed,
      recentlyObserved: true });
  });

  it('does not turn stale, future, or offline reports into current availability', async () => {
    const fetcher = vi.fn(async () => json(fixture())) as unknown as typeof fetch;
    expect((await new GolemStatsReader(fetcher, () => now + 6 * 60_000).provider(node)).recentlyObserved).toBe(false);
    expect((await new GolemStatsReader(fetcher, () => now - 60_000).provider(node)).recentlyObserved).toBe(false);
    const offline = vi.fn(async () => json([{ ...fixture()[0], online: false }])) as unknown as typeof fetch;
    expect((await new GolemStatsReader(offline, () => now).provider(node)).onlineReported).toBe(false);
  });

  it('rejects untrusted IDs before a network request and rejects changed response identities', async () => {
    const fetcher = vi.fn(async () => json(fixture())) as unknown as typeof fetch;
    const reader = new GolemStatsReader(fetcher, () => now);
    await expect(reader.provider('https://evil.example/')).rejects.toThrow();
    await expect(reader.provider(node.toUpperCase())).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const wrong = vi.fn(async () => json(fixture(another))) as unknown as typeof fetch;
    await expect(new GolemStatsReader(wrong, () => now).provider(node)).rejects.toThrow('identity mismatch');
  });

  it('rejects a missing or stale runtime inventory and requires a GPU model for NVIDIA runtime', async () => {
    const noRuntime = vi.fn(async () => json([{ ...fixture()[0], runtimes: {} }])) as unknown as typeof fetch;
    await expect(new GolemStatsReader(noRuntime).provider(node)).rejects.toThrow('no current inventory');
    const oldRuntime = vi.fn(async () => json([{ ...fixture()[0], runtimes: { vm: { properties: null } } }])) as unknown as typeof fetch;
    await expect(new GolemStatsReader(oldRuntime).provider(node)).rejects.toThrow('no current inventory');
    const otherMalformed = vi.fn(async () => json([{ ...fixture()[0], runtimes: {
      ...fixture()[0]!.runtimes, automatic: { properties: 'unexpected' } } }])) as unknown as typeof fetch;
    expect((await new GolemStatsReader(otherMalformed, () => now).provider(node)).runtime).toBe('vm');
    const missingModel = vi.fn(async () => json([{ ...fixture()[0], runtimes: { 'vm-nvidia': {
      properties: { ...fixture()[0]!.runtimes.vm.properties, 'golem.runtime.name': 'vm-nvidia' } } } }])) as unknown as typeof fetch;
    await expect(new GolemStatsReader(missingModel).provider(node, 'vm-nvidia')).rejects.toThrow('GPU model');
    const gpu = vi.fn(async () => json([{ ...fixture()[0], runtimes: { 'vm-nvidia': {
      properties: { ...fixture()[0]!.runtimes.vm.properties, 'golem.runtime.name': 'vm-nvidia',
        'golem.!exp.gap-35.v1.inf.gpu.model': 'NVIDIA RTX 4090' } } } }])) as unknown as typeof fetch;
    expect((await new GolemStatsReader(gpu, () => now).provider(node, 'vm-nvidia')).gpuModel).toBe('NVIDIA RTX 4090');
  });

  it('rejects malformed stats, wrong content type and oversized bodies', async () => {
    const malformed = vi.fn(async () => json([{ ...fixture()[0], runtimes: { vm: { properties: {
      ...fixture()[0]!.runtimes.vm.properties, 'golem.inf.cpu.cores': 0 } } } }])) as unknown as typeof fetch;
    await expect(new GolemStatsReader(malformed).provider(node)).rejects.toThrow();
    const html = vi.fn(async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    await expect(new GolemStatsReader(html).provider(node)).rejects.toThrow('not JSON');
    const large = vi.fn(async () => json({ filler: 'x'.repeat(1_048_576) })) as unknown as typeof fetch;
    await expect(new GolemStatsReader(large).provider(node)).rejects.toThrow('size limit');
  });

  it('bounds an explicit approved ID batch and rejects duplicate or empty identities', async () => {
    const fetcher = vi.fn(async (url: string) => json(fixture(url.split('/').at(-1)!))) as unknown as typeof fetch;
    const reader = new GolemStatsReader(fetcher, () => now);
    expect((await reader.providers([node, another])).map(item => item.nodeId)).toEqual([node, another]);
    await expect(reader.providers([node, node])).rejects.toThrow('Duplicate');
    await expect(reader.providers([])).rejects.toThrow();
    await expect(reader.providers(Array.from({ length: 65 }, (_, i) => '0x' + i.toString(16).padStart(40, '0')))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
