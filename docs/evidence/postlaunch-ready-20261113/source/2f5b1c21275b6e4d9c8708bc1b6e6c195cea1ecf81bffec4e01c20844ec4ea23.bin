import '../leash-presets.css';
import { mountLeashPresets, type LeashLimits } from '../leash-presets.js';
import './refunds.css';
import { mountRefundDashboard } from './refunds.js';
import './prices.css';
import { mountPrices } from './prices.js';
import './shared-receipt.css';
import { mountSharedReceipt } from './shared-receipt.js';

import './runway.css';
import { mountRunway } from './runway.js';

import './accounting.css';
import { mountAccounting } from './accounting.js';

import './fossils.css';
import { mountFossilRecord } from './fossils.js';

type Hero = (label: string, title: string, description: string, meta?: string) => string;
function toolLifecycle(main: HTMLElement, mount: () => (() => void) | void): void {
  let started = false, cleanup: (() => void) | undefined;
  const update = (): void => {
    const visible = main.isConnected && !main.hidden && !main.inert && main.id === 'page-content';
    if (!visible && cleanup) { cleanup(); cleanup = undefined; started = false; }
    if (visible && !started) { started = true; const dispose = mount(); if (typeof dispose === 'function') cleanup = dispose; }
  };
  new MutationObserver(update).observe(main, { attributes: true, attributeFilter: ['hidden', 'inert', 'id'] });
  update();
}
export function installLeashPresets(form: HTMLFormElement, caps?: LeashLimits): void { ensurePostlaunchStyles(); mountLeashPresets(form, caps); }
function ensurePostlaunchStyles(): void {
  if (document.querySelector('link[data-postlaunch-css]')) return;
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/postlaunch.css'; css.dataset['postlaunchCss'] = ''; document.head.append(css);
}
export async function mountPostlaunchRoute(main: HTMLElement, path: string, hero: Hero): Promise<void> {
  let css = document.querySelector<HTMLLinkElement>('link[data-postlaunch-css]');
  if (!css) {
    css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/postlaunch.css';
    css.dataset['postlaunchCss'] = ''; document.head.append(css);
  }
  try {
    const response = await fetch('/api/public/features', { credentials: 'omit', cache: 'no-store',
      redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Feature configuration is unavailable.');
    const value: unknown = await response.json();
    if (typeof value !== 'object' || value === null || !('enabled' in value) || !Array.isArray(value.enabled)) throw new Error('Feature configuration is unavailable.');
    const enabled = value.enabled;
    const shared = /^\/r\/(0x[a-fA-F0-9]{64})$/.exec(path);
    if (shared && enabled.includes('receipt-links')) {
      toolLifecycle(main, () => mountSharedReceipt(main, hero('Shared receipt', 'The run.<br><span class="orange">On record.</span>',
        'A receipt summary shared by its owner. Current settlement evidence is checked before it is displayed.', 'TELOMERE / SHARED RECEIPT'), shared[1]!));
      return;
    }
    if (path === '/fossils' && enabled.includes('fossils')) {
      toolLifecycle(main, () => mountFossilRecord(main, hero('Fossil Record', 'Every agent.<br><span class="orange">A history.</span>', 'Canonical Selection lifecycle events, with block evidence and explicit index coverage.'))); return;
    }
    if (path === '/accounting' && enabled.includes('accounting')) {
      toolLifecycle(main, () => mountAccounting(main, hero('Accounting', 'Your spend.<br><span class="orange">Every entry.</span>', 'Owner-only monthly summaries and complete CSV exports of confirmed charges and returns.'))); return;
    }
    if (path === '/runway' && enabled.includes('runway')) {
      toolLifecycle(main, () => mountRunway(main, hero('Budget runway', 'Your budget.<br><span class="orange">Time to run.</span>', 'An estimate from your confirmed escrow budget and trailing 24-hour spend.'))); return;
    }
    if (path === '/prices' && enabled.includes('prices')) {
      toolLifecycle(main, () => mountPrices(main, hero('Settled prices', 'Recorded prices.<br><span class="orange">Real settlements.</span>',
        'Price distributions from confirmed, paid CPU runs. Empty hardware classes show no data.', 'TELOMERE / PRICE INSIGHTS')));
      return;
    }
    if (path === '/refunds' && enabled.includes('refunds')) {
      mountRefundDashboard(main, hero('Refunds', 'Unused time.<br><span class="orange">Returned.</span>',
        'Confirmed returns from real escrow settlements. Separate categories. A visible source for every total.', 'TELOMERE / REFUND INSIGHTS'));
      return;
    }
    main.innerHTML = hero('Not enabled', 'This update<br>is not enabled.', 'This deployment has not enabled the requested feature. Existing compute and financial operations remain available.');
  } catch {
    main.innerHTML = hero('Unavailable', 'The data<br>could not be loaded.', 'Reload this page to retry. No wallet action or payment is needed.');
  }
}
