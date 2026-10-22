import type { EIP1193Provider } from 'viem';

export type WalletProvider = EIP1193Provider & {
  on?: (name: string, handler: (data: unknown) => void) => void;
  removeListener?: (name: string, handler: (data: unknown) => void) => void;
};
export interface WalletOption { id: string; key: string; name: string; provider: WalletProvider }
export interface WalletHost {
  addEventListener(type: string, listener: EventListener): void;
  dispatchEvent(event: Event): boolean;
  ethereum?: unknown; okxwallet?: unknown; coinbaseWalletExtension?: unknown; phantom?: unknown;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}
function provider(value: unknown): value is WalletProvider { return typeof object(value)?.request === 'function'; }
const brands = [
  ['okx', 'OKX Wallet'], ['metamask', 'MetaMask'], ['coinbase', 'Coinbase Wallet'],
  ['rainbow', 'Rainbow'], ['rabby', 'Rabby'], ['trust', 'Trust Wallet'],
] as const;
function legacyName(value: WalletProvider): string {
  const flags = object(value);
  if (flags?.isOkxWallet || flags?.isOKExWallet) return 'OKX Wallet';
  if (flags?.isRabby) return 'Rabby';
  if (flags?.isRainbow) return 'Rainbow';
  if (flags?.isCoinbaseWallet) return 'Coinbase Wallet';
  if (flags?.isTrust || flags?.isTrustWallet) return 'Trust Wallet';
  if (flags?.isPhantom) return 'Phantom';
  if (flags?.isMetaMask) return 'MetaMask';
  return 'Browser wallet';
}

export class WalletRegistry {
  private readonly entries = new Map<string, WalletOption>();
  private readonly listeners = new Set<() => void>();
  private refreshing = false;
  constructor(private readonly host: WalletHost) {
    host.addEventListener('eip6963:announceProvider', event => {
      const detail = object(Reflect.get(event, 'detail')), info = object(detail?.info);
      if (!info || typeof info.uuid !== 'string' || info.uuid.length > 128 || !info.uuid
        || typeof info.name !== 'string' || !info.name.trim() || !provider(detail?.provider)) return;
      const rdns = typeof info.rdns === 'string' && /^[a-z0-9.-]{1,128}$/i.test(info.rdns) ? info.rdns.toLowerCase() : info.name.trim().toLowerCase();
      this.add('eip6963:' + info.uuid, rdns, info.name, detail.provider, true);
    });
    host.addEventListener('ethereum#initialized', () => this.refresh());
    this.refresh();
  }
  private add(id: string, key: string, name: string, value: unknown, announced = false): void {
    if (!provider(value)) return;
    const existing = [...this.entries.values()].find(item => item.provider === value);
    if (existing) {
      if (!announced || existing.id === id) return;
      this.entries.delete(existing.id);
    }
    // Announced icons and names are untrusted; the UI renders names as text only.
    if (this.entries.has(id) || this.entries.size >= 32) return;
    this.entries.set(id, {id, key, name: name.trim().slice(0, 60), provider: value});
    if (!this.refreshing) this.listeners.forEach(listener => listener());
  }
  refresh(): void {
    const before = this.list();this.refreshing = true;
    try {
    for (const id of this.entries.keys()) if (id.startsWith('legacy:')) this.entries.delete(id);
    this.add('legacy:okx', 'okx', 'OKX Wallet', this.host.okxwallet);
    this.add('legacy:coinbase', 'coinbase', 'Coinbase Wallet', this.host.coinbaseWalletExtension);
    this.add('legacy:phantom', 'phantom', 'Phantom', object(this.host.phantom)?.ethereum);
    const ethereum = this.host.ethereum, multiple = object(ethereum)?.providers;
    if (Array.isArray(multiple) && multiple.length) multiple.slice(0, 32).forEach((value: unknown, index: number) => {
      if (provider(value)) { const name = legacyName(value); this.add('legacy:' + index, name.toLowerCase(), name, value); }
    });
    else if (provider(ethereum)) { const name = legacyName(ethereum); this.add('legacy:ethereum', name.toLowerCase(), name, ethereum); }
    this.host.dispatchEvent(new Event('eip6963:requestProvider'));
    } finally { this.refreshing = false; }
    const after = this.list();
    if (before.length !== after.length || before.some((item,index) => item.id !== after[index]?.id || item.provider !== after[index]?.provider || item.name !== after[index]?.name || item.key !== after[index]?.key)) this.listeners.forEach(listener => listener());
  }
  list(): WalletOption[] { return [...this.entries.values()].sort((a,b) => a.name.localeCompare(b.name)); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
const registries = new WeakMap<WalletHost, WalletRegistry>();
export function walletRegistry(): WalletRegistry {
  let registry = registries.get(window);
  if (!registry) { registry = new WalletRegistry(window); registries.set(window, registry); }
  return registry;
}
const preference = 'telomere-wallet-choice-v1';
export function rememberWallet(option: WalletOption): void { try { localStorage.setItem(preference, option.key); } catch { /* Wallet access also works with blocked preference storage. */ } }
export function savedWallet(): WalletOption | undefined {
  const wallets = walletRegistry(); wallets.refresh();
  let key: string | null = null; try { key = localStorage.getItem(preference); } catch { /* Ask for a choice when several providers are available. */ }
  const options = wallets.list(), matches = options.filter(item => item.key === key);
  return matches.length === 1 ? matches[0] : !key && options.length === 1 ? options[0] : undefined;
}

let choosing: Promise<WalletOption | undefined> | undefined;
export function chooseWallet(): Promise<WalletOption | undefined> {
  if (choosing) return choosing;
  const wallets = walletRegistry();
  const dialog = document.createElement('dialog'); dialog.className = 'wallet-picker';
  dialog.setAttribute('aria-labelledby', 'wallet-picker-title');
  dialog.setAttribute('aria-describedby', 'wallet-picker-intro');
  const previous = document.activeElement;
  const task = new Promise<WalletOption | undefined>(resolve => {
    dialog.innerHTML = '<div class="wallet-picker-head"><span>TELOMERE / WALLET</span><button type="button" aria-label="Close wallet selection">×</button></div><h2 id="wallet-picker-title">Choose your wallet.</h2><p id="wallet-picker-intro">Select a wallet to sign in to your private Workspace.</p><div class="wallet-picker-list"></div><p class="wallet-picker-help" role="status">No funds move when you sign in. Your wallet will ask you to sign a message.</p><button type="button" class="wallet-picker-refresh">Refresh wallets ↗</button>';
    const list = dialog.querySelector('.wallet-picker-list')!;
    const help = dialog.querySelector('.wallet-picker-help')!;
    const closeButton = dialog.querySelector<HTMLButtonElement>('.wallet-picker-head button')!;
    let selected: WalletOption | undefined;
    const render = () => {
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.wallet : undefined;
      list.replaceChildren();
      const options = wallets.list();
      const row = (name: string, option?: WalletOption) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'wallet-picker-option';
        button.dataset.wallet = option?.id ?? name;
        const badge = document.createElement('span'); badge.className = 'wallet-picker-badge'; badge.setAttribute('aria-hidden','true');
        const brand = brands.find(([,label]) => label.toLowerCase().replace(/ wallet$/, '') === name.toLowerCase().replace(/ wallet$/, ''));
        if (brand) {
          const icon = document.createElement('img'); icon.src = '/assets/wallets/' + brand[0] + '.svg';
          icon.alt = ''; icon.width = 36; icon.height = 36; icon.decoding = 'async'; badge.append(icon);
        } else badge.textContent = name.slice(0,2).toUpperCase();
        const label = document.createElement('span'); label.textContent = name;
        const state = document.createElement('small'); state.textContent = option ? 'Detected ↗' : 'Not detected';
        button.append(badge,label,state);
        button.onclick = () => {
          if (!option) { help.textContent = 'Open Telomere in ' + name + '’s browser, or enable its browser extension, then refresh wallets. Keep your recovery phrase in your wallet.'; return; }
          selected = option; dialog.close();
        };
        list.append(button);
      };
      options.forEach(option => row(option.name, option));
      for (const [,name] of brands) if (!options.some(option => option.name.toLowerCase().includes(name.toLowerCase().replace(' wallet','')))) row(name);
      if (focused) [...list.querySelectorAll<HTMLButtonElement>('button')].find(button => button.dataset.wallet === focused)?.focus();
    };
    const unsubscribe = wallets.subscribe(render);
    const refresh = () => wallets.refresh();
    const discoveryTimer = window.setInterval(refresh, 750);
    window.addEventListener('focus', refresh);
    closeButton.onclick = () => dialog.close();
    dialog.querySelector<HTMLButtonElement>('.wallet-picker-refresh')!.onclick = () => { wallets.refresh(); render(); help.textContent = 'Choose a detected wallet. For mobile, open this site inside your wallet’s browser.'; };
    dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
    dialog.addEventListener('close', () => { window.clearInterval(discoveryTimer);window.removeEventListener('focus', refresh);unsubscribe(); dialog.remove(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); resolve(selected); }, {once:true});
    document.body.append(dialog); render(); dialog.showModal(); closeButton.focus(); wallets.refresh();
  });
  choosing = task.finally(() => { choosing = undefined; });
  return choosing;
}

export function walletError(error: unknown): string {
  const code = object(error)?.code;
  if (code === 4001) return 'Connection cancelled. Choose a wallet to try again.';
  if (code === -32002) return 'A request is already open in your selected wallet. Open the wallet to continue.';
  if (code === 4900 || code === 4901) return 'Your wallet is disconnected. Unlock it and connect again.';
  return error instanceof Error ? error.message : 'Wallet connection failed. Unlock your wallet and try again.';
}
