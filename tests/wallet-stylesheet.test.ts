import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {chooseWallet, ensureWalletStyles, type WalletHost} from '../public/wallet-picker.js';

// Only the DOM operations used by the loader and existing chooser are modelled here.
// Actual layout and browser navigation are checked separately in the rendered app.
class ElementFixture extends EventTarget {
  children: ElementFixture[] = [];
  parent?: ElementFixture;
  className = ''; textContent = ''; rel = ''; href = ''; media = ''; disabled = false;
  sheet: {disabled: boolean} | null = null;
  dataset: Record<string, string> = {};
  isConnected = true;
  onclick?: () => void;
  parts = new Map<string, ElementFixture>();
  showModal = vi.fn();
  constructor(readonly owner: DocumentFixture, readonly tag: string) { super(); }
  set innerHTML(_value: string) {
    for (const selector of ['.wallet-picker-list', '.wallet-picker-help', '.wallet-picker-head button', '.wallet-picker-refresh']) {
      this.parts.set(selector, new ElementFixture(this.owner, selector.includes('button') || selector.includes('refresh') ? 'button' : 'div'));
    }
  }
  setAttribute() {}
  append(...nodes: ElementFixture[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.isConnected = false; }
  replaceChildren() { this.children = []; }
  querySelector(selector: string) { return this.parts.get(selector) ?? null; }
  querySelectorAll(selector: string) { return this.children.filter(child => child.tag === selector); }
  focus() { this.owner.activeElement = this; }
  close() { this.dispatchEvent(new Event('close')); }
}
class DocumentFixture {
  URL = 'https://telomere.example/dashboard/';
  baseURI = 'https://other.example/';
  head = new ElementFixture(this, 'head');
  body = new ElementFixture(this, 'body');
  activeElement: ElementFixture | null = new ElementFixture(this, 'button');
  defaultView = {matchMedia: (media: string) => ({matches: media === 'screen'})};
  createElement = vi.fn((tag: string) => new ElementFixture(this, tag));
  querySelectorAll() { return this.head.children.filter(child => child.tag === 'link' && child.rel === 'stylesheet'); }
  document() { return this as unknown as Document; }
  link(href = 'https://telomere.example/wallet-picker.css', loaded = false) {
    const link = this.createElement('link'); link.rel = 'stylesheet'; link.href = href;
    if (loaded) link.sheet = {disabled: false};
    this.head.append(link); return link;
  }
  get links() { return this.head.children; }
  get dialogs() { return this.body.children.filter(child => child.tag === 'dialog'); }
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const load = (link: ElementFixture) => { link.sheet = {disabled: false}; link.dispatchEvent(new Event('load')); };

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('wallet chooser stylesheet readiness', () => {
  it('loads the same-origin stylesheet once, shares pending work, and reuses the loaded link', async () => {
    const fixture = new DocumentFixture();
    const first = ensureWalletStyles(fixture.document());
    expect(ensureWalletStyles(fixture.document())).toBe(first);
    expect(fixture.links).toHaveLength(1);
    expect(fixture.links[0]?.href).toBe('https://telomere.example/wallet-picker.css');
    let ready = false; void first.then(() => { ready = true; });
    await flush(); expect(ready).toBe(false);
    load(fixture.links[0]!); await first;
    await ensureWalletStyles(fixture.document());
    expect(fixture.links).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('reuses an already loaded direct-entry stylesheet without adding a link or timer', async () => {
    const fixture = new DocumentFixture(), link = fixture.link(undefined, true);
    await ensureWalletStyles(fixture.document());
    expect(fixture.links).toEqual([link]); expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a direct-entry stylesheet that is still loading', async () => {
    const fixture = new DocumentFixture(), link = fixture.link();
    let ready = false;
    const pending = ensureWalletStyles(fixture.document()).then(() => { ready = true; });
    await vi.advanceTimersByTimeAsync(9000);
    expect(ready).toBe(false); expect(fixture.links).toEqual([link]);
    load(link); await pending; expect(ready).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores foreign, disabled, and print-only links when choosing the applicable stylesheet', async () => {
    const fixture = new DocumentFixture();
    fixture.link('https://other.example/wallet-picker.css', true);
    fixture.link(undefined, true).disabled = true;
    fixture.link(undefined, true).media = 'print';
    const pending = ensureWalletStyles(fixture.document());
    expect(fixture.links).toHaveLength(4);
    load(fixture.links[3]!); await pending;
  });

  it('cleans up a failed owned link and permits a fresh concurrent retry', async () => {
    const fixture = new DocumentFixture(), first = ensureWalletStyles(fixture.document());
    const failed = expect(first).rejects.toThrow('Wallet selection failed to load');
    fixture.links[0]!.dispatchEvent(new Event('error')); await failed;
    expect(fixture.links).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    const retry = ensureWalletStyles(fixture.document());
    expect(ensureWalletStyles(fixture.document())).toBe(retry);
    load(fixture.links[0]!); await retry; expect(fixture.links).toHaveLength(1);
  });

  it('preserves a failed document-owned link and bypasses it on retry', async () => {
    const fixture = new DocumentFixture(), original = fixture.link();
    const first = ensureWalletStyles(fixture.document());
    const failed = expect(first).rejects.toThrow('Wallet selection failed to load');
    original.dispatchEvent(new Event('error')); await failed;
    expect(fixture.links).toEqual([original]);
    const retry = ensureWalletStyles(fixture.document());
    expect(fixture.links).toHaveLength(2);
    load(fixture.links[1]!); await retry;
  });

  it('bounds slow loads, removes their listeners, and retries without stale events settling the retry', async () => {
    const fixture = new DocumentFixture(), first = ensureWalletStyles(fixture.document(), 40);
    const stale = fixture.links[0]!, remove = vi.spyOn(stale, 'removeEventListener');
    const timedOut = expect(first).rejects.toThrow('Wallet selection took too long');
    await vi.advanceTimersByTimeAsync(40); await timedOut;
    expect(fixture.links).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    expect(remove.mock.calls.map(([name]) => name)).toEqual(['load', 'error']);
    let ready = false;
    const retry = ensureWalletStyles(fixture.document(), 40).then(() => { ready = true; });
    load(stale); await flush(); expect(ready).toBe(false);
    load(fixture.links[0]!); await retry; expect(ready).toBe(true);
  });

  it('keeps pending loads independent between documents', async () => {
    const a = new DocumentFixture(), b = new DocumentFixture();
    const first = ensureWalletStyles(a.document()), second = ensureWalletStyles(b.document());
    expect(first).not.toBe(second); expect(vi.getTimerCount()).toBe(2);
    load(a.links[0]!); await first; expect(vi.getTimerCount()).toBe(1);
    load(b.links[0]!); await second;
  });

  it('holds concurrent chooser opens until CSS is ready and preserves selection and close cleanup', async () => {
    const fixture = new DocumentFixture(), previous = fixture.activeElement!;
    const request = vi.fn(), host: WalletHost = new EventTarget();
    host.ethereum = {isMetaMask: true, request};
    Object.assign(host, {setInterval, clearInterval});
    vi.stubGlobal('window', host); vi.stubGlobal('document', fixture.document()); vi.stubGlobal('HTMLElement', ElementFixture);
    const first = chooseWallet(); expect(chooseWallet()).toBe(first);
    await flush(); expect(fixture.dialogs).toHaveLength(0); expect(request).not.toHaveBeenCalled();
    load(fixture.links[0]!); await flush();
    expect(fixture.dialogs).toHaveLength(1);
    const dialog = fixture.dialogs[0]!;
    expect(dialog.showModal).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
    const options = dialog.querySelector('.wallet-picker-list')!.children;
    options.find(option => option.dataset.wallet === 'legacy:ethereum')!.onclick!();
    expect((await first)?.name).toBe('MetaMask'); expect(request).not.toHaveBeenCalled();
    expect(fixture.dialogs).toHaveLength(0); expect(fixture.activeElement).toBe(previous); expect(vi.getTimerCount()).toBe(0);
    const reopened = chooseWallet(); await flush();
    expect(fixture.links).toHaveLength(1); expect(fixture.dialogs).toHaveLength(1);
    fixture.dialogs[0]!.querySelector('.wallet-picker-head button')!.onclick!();
    expect(await reopened).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['error', 'timeout'])('rejects chooser CSS %s before discovery or dialog creation, then allows a retry', async failure => {
    const fixture = new DocumentFixture(), host = new EventTarget(), discovery = vi.spyOn(host, 'dispatchEvent');
    Object.assign(host, {setInterval, clearInterval});
    vi.stubGlobal('window', host); vi.stubGlobal('document', fixture.document()); vi.stubGlobal('HTMLElement', ElementFixture);
    const first = chooseWallet(), rejected = expect(first).rejects.toThrow('Please try connecting again');
    if (failure === 'error') fixture.links[0]!.dispatchEvent(new Event('error'));
    else await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(fixture.dialogs).toHaveLength(0); expect(discovery).not.toHaveBeenCalled();
    const retry = chooseWallet(); load(fixture.links[0]!); await flush();
    expect(fixture.dialogs).toHaveLength(1);
    fixture.dialogs[0]!.close(); expect(await retry).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
