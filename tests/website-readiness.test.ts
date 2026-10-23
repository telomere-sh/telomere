import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

interface Scope { querySelectorAll(selector: string): ReturnType<typeof image>[]; dataset: Record<string, string> }
interface Runtime { prepare(scope: Scope | null): Promise<void>; reveal(): void; downloaded: Promise<unknown[]> }
function image(top = 0, decode = vi.fn(() => Promise.resolve())) {
  return { loading: 'lazy', src: '/assets/small.webp', srcset: '/assets/small.webp 400w, /assets/large.webp 1600w',
    sizes: '100vw', decode, getBoundingClientRect: () => ({ top, bottom: top + 100, width: 200, height: 100 }) };
}
describe('bounded, viewport-only website readiness', () => {
  let source: string;
  beforeAll(async () => { source = await readFile('website/dist/preload.js', 'utf8'); });
  afterEach(() => { vi.useRealTimers(); });
  function fixture(bodyReady = true, viewportHeight = 800) {
    vi.useFakeTimers();
    const classes = new Set<string>(), events: string[] = [], append = vi.fn(), remove = vi.fn();
    const listeners = new Map<string, () => void>(), network = vi.fn(() => { throw new Error('Unexpected speculative download'); });
    const window: { TelomereAssets?: Runtime } = {};
    runInNewContext(source, { window, innerHeight: viewportHeight, setTimeout, clearTimeout, fetch: network,
      Event: class { constructor(public type: string) {} },
      document: { documentElement: { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } },
        body: bodyReady ? { append } : null, fonts: { ready: new Promise(() => {}) },
        createElement: () => ({ setAttribute: vi.fn(), remove }),
        addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
        dispatchEvent: (event: { type: string }) => events.push(event.type) } });
    if (!window.TelomereAssets) throw new Error('Readiness runtime did not initialize');
    return { runtime: window.TelomereAssets, classes, events, network, append, remove, listeners };
  }
  it('never downloads the site-wide image manifest or unrelated assets', async () => {
    const f = fixture();
    await expect(f.runtime.downloaded).resolves.toEqual([]);
    await f.runtime.prepare({ querySelectorAll: () => [], dataset: {} });
    expect(f.network).not.toHaveBeenCalled();
  });
  it('keeps responsive source selection and does not decode offscreen images', async () => {
    const f = fixture(), above = image(), below = image(3000);
    const scope = { querySelectorAll: () => [above, below], dataset: {} };
    await f.runtime.prepare(scope);
    expect(above.decode).toHaveBeenCalledOnce(); expect(below.decode).not.toHaveBeenCalled();
    expect(above.srcset).toContain('1600w'); expect(above.src).toBe('/assets/small.webp');
    expect(below.loading).toBe('lazy'); expect(scope.dataset).toEqual({ imagesReady: 'true' });
  });
  it('finishes within 800ms when a visible image never decodes, without waiting for fonts', async () => {
    const f = fixture(), blocked = image(0, vi.fn(() => new Promise<void>(() => {})));
    const scope = { querySelectorAll: () => [blocked], dataset: {} };
    const ready = f.runtime.prepare(scope);
    await vi.advanceTimersByTimeAsync(800); await ready;
    expect(scope.dataset).toEqual({ imagesReady: 'true' });
  });
  it('tolerates broken images and limits visible decode work to four images', async () => {
    const f = fixture(), pictures = Array.from({ length: 12 }, () => image(0, vi.fn(() => Promise.reject(new Error('Broken image')))));
    await f.runtime.prepare({ querySelectorAll: () => pictures, dataset: {} });
    expect(pictures.filter(p => p.decode.mock.calls.length)).toHaveLength(4);
  });
  it('reveals the site after four seconds even if route initialization never completes', async () => {
    const f = fixture(); expect(f.classes.has('assets-pending')).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.classes.has('assets-pending')).toBe(false); expect(f.classes.has('assets-ready')).toBe(true);
    expect(f.remove).toHaveBeenCalledOnce(); f.runtime.reveal();
    expect(f.events).toEqual(['telomere-assets-ready']);
  });
  it('does not mount a late loader after the document exceeded the deadline', async () => {
    const f = fixture(false);
    await vi.advanceTimersByTimeAsync(4000); f.listeners.get('DOMContentLoaded')?.();
    expect(f.append).not.toHaveBeenCalled(); expect(f.classes.has('assets-pending')).toBe(false);
  });
  it.each([568, 667, 800, 844, 932])('preserves lazy loading below a %i px mobile viewport', async height => {
    const f = fixture(true, height), visible = image(height - 50), below = image(height + 2000);
    await f.runtime.prepare({ querySelectorAll: () => [visible, below], dataset: {} });
    expect(visible.decode).toHaveBeenCalledOnce(); expect(below.decode).not.toHaveBeenCalled();
    expect(below.loading).toBe('lazy'); expect(f.network).not.toHaveBeenCalled();
  });
  it('does not restore the overlay when a late image finally resolves', async () => {
    const f = fixture(); let complete!: () => void;
    const slow = image(0, vi.fn(() => new Promise<void>(resolve => { complete = resolve; })));
    const ready = f.runtime.prepare({ querySelectorAll: () => [slow], dataset: {} });
    await vi.advanceTimersByTimeAsync(4000); await ready; complete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.classes.has('assets-pending')).toBe(false); expect(f.append).toHaveBeenCalledOnce();
    expect(f.events).toEqual(['telomere-assets-ready']);
  });
  it('keeps subsequent route preparation bounded without remounting the loader', async () => {
    const f = fixture(); f.runtime.reveal();
    const stuck = image(0, vi.fn(() => new Promise<void>(() => {})));
    const next = { querySelectorAll: () => [stuck], dataset: {} };
    const ready = f.runtime.prepare(next); await vi.advanceTimersByTimeAsync(800); await ready;
    expect(next.dataset).toEqual({ imagesReady: 'true' }); expect(f.classes.has('assets-pending')).toBe(false);
    expect(f.append).toHaveBeenCalledOnce(); expect(f.remove).toHaveBeenCalledOnce();
  });
  it('handles a synchronous image decode failure without leaving preparation pending', async () => {
    const f = fixture(), broken = image(0, vi.fn((): Promise<void> => { throw new Error('Decoder unavailable'); }));
    const scope = { querySelectorAll: () => [broken], dataset: {} };
    await f.runtime.prepare(scope); expect(scope.dataset).toEqual({ imagesReady: 'true' });
  });
});
