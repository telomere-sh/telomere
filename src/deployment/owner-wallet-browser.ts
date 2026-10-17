import type { EIP1193Provider } from 'viem';
import { checkOwnerWalletReview, isOwnerWalletProvider, prepareOwnerWalletRequest } from './owner-wallet-wallet.js';
import { ownerWalletPlanSchema, ownerWalletTrustSchema, type OwnerWalletReview } from './owner-wallet-types.js';

function element(id: string): HTMLElement {
  const value = document.getElementById(id); if (!value) throw new Error('Operator page element missing'); return value;
}
function button(id: string): HTMLButtonElement {
  const value = element(id); if (!(value instanceof HTMLButtonElement)) throw new Error('Operator button missing'); return value;
}
function checked(): boolean { const value = element('reviewed'); return value instanceof HTMLInputElement && value.checked; }
function trustedClick(event: Event) { if (!event.isTrusted) throw new Error('Use an explicit owner click'); }
const providers = new Map<string, { name: string; provider: EIP1193Provider }>();
let provider: EIP1193Provider | undefined, revision = 0, review: OwnerWalletReview | undefined, busy = false;
const status = (message: string) => { element('status').textContent = message; };
const controls = () => { button('deploy').disabled = busy || !provider || review?.status !== 'ready_for_owner_wallet' || !checked(); };
function addProvider(id: string, name: string, candidate: unknown) {
  if (!isOwnerWalletProvider(candidate) || [...providers.values()].some(value => value.provider === candidate)) return;
  providers.set(id, { name: name.slice(0, 80), provider: candidate });
  const select = element('providers'); if (!(select instanceof HTMLSelectElement)) throw new Error('Wallet selector missing');
  const option = document.createElement('option'); option.value = id; option.textContent = name.slice(0, 80); select.append(option);
}
window.addEventListener('eip6963:announceProvider', event => {
  if (!(event instanceof CustomEvent)) return;
  const value: unknown = event.detail;
  if (!value || typeof value !== 'object' || !('info' in value) || !('provider' in value)
    || !value.info || typeof value.info !== 'object' || !('uuid' in value.info) || !('name' in value.info)
    || typeof value.info.uuid !== 'string' || value.info.uuid.length > 128 || typeof value.info.name !== 'string') return;
  addProvider(value.info.uuid, value.info.name, value.provider);
});
addProvider('okx', 'OKX Web3', Reflect.get(window, 'okxwallet'));
addProvider('ethereum', 'Injected EVM wallet', Reflect.get(window, 'ethereum'));
window.dispatchEvent(new Event('eip6963:requestProvider'));

const context = await fetch('/api/plan', { cache: 'no-store', credentials: 'same-origin', redirect: 'error' }).then(async response => {
  if (!response.ok) throw new Error('Frozen review is unavailable');
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || !('plan' in value) || !('trust' in value) || !('reviewToken' in value)
    || typeof value.reviewToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.reviewToken)) throw new Error('Invalid review context');
  return { plan: ownerWalletPlanSchema.parse(value.plan), trust: ownerWalletTrustSchema.parse(value.trust), reviewToken: value.reviewToken };
});
element('plan').textContent = JSON.stringify({ plan: context.plan, gasBounds: context.trust,
  treasuryReview: 'Treasury is proposed as the owner address. Confirm this destination in the review before deploying.' }, null, 2);
const journalKey = 'telomere-owner-deployment:' + context.plan.reviewDigest;
const previous = localStorage.getItem(journalKey);
if (previous !== null) { busy = true; status('An original wallet attempt is retained. Reconcile its nonce and transaction before any retry. ' + previous); }
controls();
async function freshReview() {
  const response = await fetch('/api/review', { method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Deployment-Review': context.reviewToken }, body: '{}' });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error('Read-only review refused. Check the frozen plan, nonce, network, gas and funding.');
  const parsed = checkOwnerWalletReview(value, context.plan.reviewDigest, Date.now(), false);
  if (parsed.trust.planSha256 !== context.trust.planSha256 || JSON.stringify(parsed.trust) !== JSON.stringify(context.trust)) {
    throw new Error('Explicit owner review bounds changed');
  }
  element('gas').textContent = JSON.stringify(parsed.gas, null, 2)
    + '\nTotal snapshot estimate includes L2 gas, the Base L1 data-fee upper bound and operator fee. The explicit total budget is a review guard, not an onchain cap on future L1 fees. Check the wallet final fee before confirming.';
  return parsed;
}
function run(action: () => Promise<void>) {
  void action().catch(error => { review = undefined; status(error instanceof Error ? error.message : 'Owner review failed'); }).finally(controls);
}
button('connect').addEventListener('click', event => run(async () => {
  trustedClick(event); if (busy) return;
  const select = element('providers'); if (!(select instanceof HTMLSelectElement)) throw new Error('Wallet selector missing');
  const selected = providers.get(select.value); if (!selected) throw new Error('Open in the OKX Web3 browser or install a browser wallet');
  const accounts = await selected.provider.request({ method: 'eth_requestAccounts' });
  if (accounts.length !== 1 || accounts[0]?.toLowerCase() !== context.trust.owner.toLowerCase()) throw new Error('Select only the reviewed owner ' + context.trust.owner);
  provider = selected.provider; review = undefined; revision++;
  status('Connected. No signature or transaction requested. Select Base mainnet in the wallet, then run read-only checks.');
}));
button('refresh').addEventListener('click', event => run(async () => {
  trustedClick(event); if (busy) return; review = await freshReview(); status(review.status === 'ready_for_owner_wallet'
    ? 'Read-only checks passed. Review all roles and gas, then explicitly approve deployment.'
    : 'The plan is prepared, but the owner needs Base ETH. No transaction was sent. Fund by an incoming transfer, then repeat the checks.');
}));
element('providers').addEventListener('change', () => { provider = undefined; review = undefined; revision++; controls(); });
element('reviewed').addEventListener('change', controls);
button('deploy').addEventListener('click', event => run(async () => {
  trustedClick(event); if (busy || !provider || !checked()) return;
  if (!navigator.locks) throw new Error('This browser requires Web Locks support for exclusive deployment review');
  const selected = provider, expectedRevision = revision;
  await navigator.locks.request(journalKey, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock || localStorage.getItem(journalKey) !== null) throw new Error('Another original wallet attempt must be reconciled first');
    busy = true; controls();
    try {
      review = await freshReview();
      const request = await prepareOwnerWalletRequest(review, selected, context.plan.reviewDigest);
      if (provider !== selected || expectedRevision !== revision || !checked()) throw new Error('Wallet selection or owner review changed');
      localStorage.setItem(journalKey, JSON.stringify({ state: 'awaiting_wallet', reviewDigest: context.plan.reviewDigest,
        owner: context.trust.owner, nonce: context.plan.transaction.nonce, predictedAddress: context.plan.predictedEscrowAddress, createdAtMs: Date.now() }));
      status('Review the exact contract creation in your wallet. Deployment transfers zero USDC; Base ETH gas is charged.');
      // This is the ONLY financial request. It is reached only by this trusted
      // owner click, after both server and wallet independent read-only checks.
      const hash = await selected.request({ method: 'eth_sendTransaction', params: [request] });
      if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new Error('Wallet outcome is uncertain; retain the original attempt');
      localStorage.setItem(journalKey, JSON.stringify({ state: 'submitted', reviewDigest: context.plan.reviewDigest,
        transactionHash: hash, owner: context.trust.owner, nonce: context.plan.transaction.nonce,
        predictedAddress: context.plan.predictedEscrowAddress, submittedAtMs: Date.now() }));
      status('Original transaction submitted: ' + hash + '. This page never retries it. Operator verification is still required.');
    } finally {
      busy = localStorage.getItem(journalKey) !== null; controls();
    }
  });
}));
