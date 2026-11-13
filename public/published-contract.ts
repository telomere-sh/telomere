import config from '../website/optional/contract-address/config.json' with {type: 'json'};
import {mountContractAddress, resolveContractAddress} from '../website/optional/contract-address/contract-address.js';

/** Marketing identity only; never read this as a payment or escrow binding. */
export function syncContractAddress(home: boolean, doc: Document = document): HTMLElement | null {
  let host = doc.getElementById('contract-address');
  if (!home || !resolveContractAddress(config)) {
    if (host) host.hidden = true;
    return host;
  }
  if (!host) {
    host = doc.createElement('div');
    host.id = 'contract-address';
    host.className = 'tl-contract-host';
    host.dataset.contractAddressHost = '';
    host.hidden = true;
    const footer = doc.querySelector('.tl-footer');
    if (footer) footer.before(host);
    else doc.body.append(host);
  }
  mountContractAddress(host, config);
  host.hidden = false;
  const view = doc.defaultView;
  if (view?.location.hash === '#contract-address') {
    const target = host;
    view.requestAnimationFrame(() => {
      if (target.isConnected && !target.hidden && view.location.hash === '#contract-address') target.scrollIntoView({block:'start'});
    });
  }
  return host;
}
