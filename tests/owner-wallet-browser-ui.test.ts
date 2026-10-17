import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';

let javascript: string;
beforeAll(async () => {
  const bundled = await build({ entryPoints: [resolve('src/deployment/owner-wallet-browser.ts')], bundle: true,
    write: false, format: 'iife', platform: 'browser', target: 'es2022', plugins: [{ name: 'ui-boundary-fixtures', setup(builder) {
      builder.onResolve({ filter: /owner-wallet-(wallet|types)\.js$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.includes('types')
        ? 'export const ownerWalletPlanSchema={parse:x=>x};export const ownerWalletTrustSchema={parse:x=>x};'
        : 'export const isOwnerWalletProvider=x=>!!x&&typeof x.request==="function";export const checkOwnerWalletReview=x=>x;export const prepareOwnerWalletRequest=()=>{throw Error("No financial action in UI fixture")};' }));
    } }] });
  javascript = bundled.outputFiles[0]!.text;
});

class Node {
  textContent = ''; disabled = false; checked = false; value = ''; children: Node[] = [];
  listeners = new Map<string, ((event: { isTrusted: boolean }) => void)[]>();
  addEventListener(name: string, callback: (event: { isTrusted: boolean }) => void) {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]);
  }
  append(child: Node) { this.children.push(child); if (!this.value) this.value = child.value; }
  click() { this.listeners.get('click')?.forEach(callback => callback({ isTrusted: true })); }
}

async function mount(options: { storageBlocked?: boolean; planUnavailable?: boolean; previous?: string; wrongChain?: boolean; rejectSwitch?: boolean; ignoreSwitch?: boolean } = {}) {
  const nodes = new Map(['status', 'deploy', 'connect', 'switch-base', 'refresh', 'providers', 'reviewed', 'plan', 'gas'].map(id => [id, new Node()]));
  const requests: string[] = [], events = new Map<string, (() => void)[]>();
  const switches: unknown[] = [];
  let chainId = options.wrongChain ? '0x1' : '0x2105';
  const wallet = { request: async ({ method, params }: { method: string; params?: unknown }) => {
    requests.push(method);
    if (method === 'eth_chainId') return chainId;
    if (method === 'wallet_switchEthereumChain') {
      switches.push(params);
      if (options.rejectSwitch) throw Error('User rejected network switch');
      if (!options.ignoreSwitch) chainId = '0x2105';
      return null;
    }
    return ['0xowner'];
  } };
  const window: Record<string, unknown> = {
    addEventListener: (name: string, callback: () => void) => events.set(name, [...events.get(name) ?? [], callback]),
    dispatchEvent: () => true,
  };
  const context = createContext({ window, document: { getElementById: (id: string) => nodes.get(id), createElement: () => new Node() },
    HTMLElement: Node, HTMLButtonElement: Node, HTMLInputElement: Node, HTMLSelectElement: Node,
    Event: class {}, CustomEvent: class {}, navigator: {},
    localStorage: { getItem: () => { if (options.storageBlocked) throw Error('Storage denied'); return options.previous ?? null; } },
    fetch: async (url: string) => ({ ok: !options.planUnavailable, json: async () => url === '/api/plan'
      ? { plan: { reviewDigest: 'digest', transaction: { nonce: 0 } }, trust: { owner: '0xowner' }, reviewToken: 'a'.repeat(64) }
      : { status: 'ready_for_owner_wallet', trust: { owner: '0xowner' }, gas: {} } }),
  });
  runInContext(javascript, context);
  const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  await flush();
  return { nodes, requests, switches, wallet, window, events, flush, node: (id: string) => nodes.get(id)! };
}

it('detects a wallet injected after page initialization on an explicit connect click', async () => {
  const ui = await mount();
  expect(ui.node('status').textContent).toContain('No wallet detected');
  ui.window.okxwallet = ui.wallet; ui.node('connect').click(); await ui.flush();
  expect(ui.node('providers').children.map(option => option.textContent)).toContain('OKX Web3');
  expect(ui.requests).toEqual(['eth_requestAccounts']);
  expect(ui.node('status').textContent).toContain('Connected. No signature');
  expect(ui.node('deploy').disabled).toBe(true);
});

it('keeps read-only controls working with unavailable local storage and disables deployment', async () => {
  const ui = await mount({ storageBlocked: true });
  ui.node('refresh').click(); await ui.flush();
  expect(ui.node('status').textContent).toContain('Read-only checks passed');
  expect(ui.node('status').textContent).toContain('storage is unavailable');
  expect(ui.node('deploy').disabled).toBe(true); expect(ui.requests).toEqual([]);
});

it('shows initialization errors and disables unavailable controls rather than silently failing', async () => {
  const ui = await mount({ planUnavailable: true });
  expect(ui.node('status').textContent).toContain('initialization failed');
  expect(ui.node('connect').disabled).toBe(true); expect(ui.node('refresh').disabled).toBe(true);
  expect(ui.node('deploy').disabled).toBe(true); expect(ui.requests).toEqual([]);
});

it('retains an ambiguous attempt and permits only read-only reconciliation', async () => {
  const ui = await mount({ previous: 'awaiting_wallet' });
  ui.window.okxwallet = ui.wallet; ui.node('connect').click(); await ui.flush();
  expect(ui.node('status').textContent).toContain('must be reconciled'); expect(ui.requests).toEqual([]);
  ui.node('refresh').click(); await ui.flush();
  expect(ui.node('status').textContent).toContain('Read-only checks passed');
  expect(ui.node('deploy').disabled).toBe(true);
});

it('switches only the explicitly connected wallet to Base and never submits a deployment', async () => {
  const ui = await mount({ wrongChain: true });
  ui.window.okxwallet = ui.wallet; ui.node('connect').click(); await ui.flush();
  expect(ui.switches).toEqual([]);
  ui.node('reviewed').checked = true;
  ui.node('switch-base').click(); await ui.flush();
  expect(ui.switches).toEqual([[{ chainId: '0x2105' }]]);
  expect(ui.node('status').textContent).toContain('Base mainnet (8453) selected');
  expect(ui.node('reviewed').checked).toBe(false);
  expect(ui.node('deploy').disabled).toBe(true);
  expect(ui.requests).not.toContain('eth_sendTransaction');
});

it('does not report success when the network switch is rejected or ignored', async () => {
  for (const behavior of [{ rejectSwitch: true }, { ignoreSwitch: true }]) {
    const ui = await mount({ wrongChain: true, ...behavior });
    ui.window.okxwallet = ui.wallet; ui.node('connect').click(); await ui.flush();
    ui.node('switch-base').click(); await ui.flush();
    expect(ui.node('status').textContent).not.toContain('8453) selected');
    expect(ui.node('deploy').disabled).toBe(true);
    expect(ui.requests).not.toContain('eth_sendTransaction');
  }
});

it('identifies the wrong wallet network during read-only checks and leaves deployment disabled', async () => {
  const ui = await mount({ wrongChain: true });
  ui.window.okxwallet = ui.wallet; ui.node('connect').click(); await ui.flush();
  ui.node('refresh').click(); await ui.flush();
  expect(ui.node('status').textContent).toContain('Click Switch to Base');
  expect(ui.node('deploy').disabled).toBe(true);
  expect(ui.switches).toEqual([]);
});
