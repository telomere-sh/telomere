import './refunds.css';
import { mountRefundDashboard } from './refunds.js';
import './prices.css';
import { mountPrices } from './prices.js';

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
