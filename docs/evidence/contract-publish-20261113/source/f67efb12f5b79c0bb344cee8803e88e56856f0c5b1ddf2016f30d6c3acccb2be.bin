/** Dormant homepage component. It is intentionally absent from website/dist. */
export interface ContractAddressConfig {
  enabled: boolean;
  address: string | null;
}
export interface ContractIdentity {
  address: string;
  explorerUrl: string;
}

export function resolveContractAddress(config: ContractAddressConfig): ContractIdentity | null {
  if (config.enabled !== true || typeof config.address !== 'string') return null;
  const address = config.address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) return null;
  return { address, explorerUrl: 'https://basescan.org/address/' + address };
}

let nextId = 0;
function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createPanel(doc: Document, identity: ContractIdentity | null): HTMLElement {
  const panel = element(doc, 'section', 'tl-contract-address');
  panel.dataset.contractAddress = '';
  const id = 'contract-address-title-' + ++nextId;
  panel.setAttribute('aria-labelledby', id);

  const top = element(doc, 'div', 'tl-contract-top');
  top.append(element(doc, 'span', 'mono tl-contract-kicker', 'TELOMERE / ONCHAIN IDENTITY'));
  top.append(element(doc, 'span', 'mono tl-contract-network', 'BASE · 8453'));

  const content = element(doc, 'div', 'tl-contract-content');
  const heading = element(doc, 'h2', 'tl-contract-heading');
  heading.id = id;
  heading.append(doc.createTextNode('One address.'));
  heading.append(doc.createElement('br'));
  heading.append(element(doc, 'span', '', 'On Base.'));

  const detail = element(doc, 'div', 'tl-contract-detail');
  const label = element(doc, 'span', 'mono tl-contract-label', 'CONTRACT ADDRESS');
  const address = element(doc, 'code', 'tl-contract-value', identity?.address ?? '0x…your contract address');
  address.setAttribute('aria-label', identity ? 'Contract address ' + identity.address : 'Contract address placeholder');
  if (!identity) address.classList.add('tl-contract-placeholder');
  const controls = element(doc, 'div', 'tl-contract-controls');
  const copy = element(doc, 'button', 'pill primary tl-contract-copy', 'Copy address');
  copy.type = 'button';
  copy.disabled = identity === null;
  const copyIcon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  copyIcon.setAttribute('class', 'tl-contract-copy-symbol');
  copyIcon.setAttribute('viewBox', '0 0 24 24');
  copyIcon.setAttribute('aria-hidden', 'true');
  const outline = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  outline.setAttribute('d', 'M8 7V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-3M4 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z');
  copyIcon.append(outline);
  copy.append(copyIcon);
  const status = element(doc, 'p', 'tl-contract-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  if (identity) {
    const explorer = element(doc, 'a', 'tl-contract-explorer', 'View on BaseScan ↗');
    explorer.href = identity.explorerUrl;
    explorer.target = '_blank';
    explorer.rel = 'noopener noreferrer';
    explorer.setAttribute('aria-label', 'View contract address on BaseScan (opens in a new tab)');
    controls.append(copy, explorer);
    copy.addEventListener('click', () => {
      void (async () => {
        copy.disabled = true;
        try {
          const clipboard = doc.defaultView?.navigator.clipboard;
          if (!clipboard) throw new Error('Clipboard unavailable');
          await clipboard.writeText(identity.address);
          status.textContent = 'Address copied.';
        } catch {
          status.textContent = 'Select the address above and copy it manually.';
          const range = doc.createRange();
          range.selectNodeContents(address);
          const selection = doc.defaultView?.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        } finally {
          copy.disabled = false;
        }
      })();
    });
  } else {
    const explorer = element(doc, 'span', 'tl-contract-explorer tl-contract-unavailable', 'View on BaseScan ↗');
    explorer.setAttribute('aria-disabled', 'true');
    controls.append(copy, explorer);
    status.textContent = 'Private preview · address not configured';
  }
  detail.append(label, address, controls, status);
  content.append(heading, detail);
  panel.append(top, content);
  return panel;
}

/** Hidden or incomplete configurations create no DOM, listeners or requests. */
export function mountContractAddress(target: HTMLElement, config: ContractAddressConfig): HTMLElement | null {
  const identity = resolveContractAddress(config);
  if (!identity) return null;
  const existing = target.querySelector<HTMLElement>('[data-contract-address]');
  if (existing) return existing;
  const panel = createPanel(target.ownerDocument, identity);
  target.append(panel);
  return panel;
}

/** Local design preview only. No address, clipboard action or explorer link. */
export function createContractAddressPreview(doc: Document): HTMLElement {
  return createPanel(doc, null);
}
