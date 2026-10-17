import { createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData, formatUnits, http, isAddress, parseUnits, type Address, type EIP1193Provider, type Hex } from 'viem';
import { z } from 'zod';
import { escrowAbi } from '../src/chain/abi.js';
import { CystPanel } from './cysts.js';

// REASON: these assertions only brand strings after runtime address/hex validation.
const addressSchema = z.string().refine(isAddress, 'Expected an EVM address').transform(value => value as Address);
const hexSchema = z.string().regex(/^0x(?:[a-fA-F0-9]{2})*$/).transform(value => value as Hex);
const idSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/).transform(value => value as Hex);
const moneySchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const transactionSchema = z.object({ to: addressSchema, data: hexSchema.default('0x'), value: z.literal('0x0').default('0x0') });
const transactionResponseSchema = z.object({ transaction: transactionSchema });
const fundingResponseSchema = z.union([z.object({ transactions: z.array(transactionSchema).min(1) }), transactionResponseSchema]);
const nearReadinessSchema = z.object({ state: z.enum(['ready', 'unavailable', 'disabled']), reasonCode: z.string(),
  scope: z.literal('local_configuration'), liveAttestationChecked: z.literal(false), policyExpiresAt: z.string().datetime().optional() });
const configSchema = z.object({
  mode: z.enum(['demo', 'local', 'testnet', 'mainnet']),
  chain: z.object({ id: z.number().int().positive(), name: z.string().min(1), rpcUrl: z.string().url(), explorerUrl: z.string().url().optional() }),
  token: z.object({ address: addressSchema, symbol: z.string().min(1), decimals: z.number().int().min(0).max(36) }),
  escrowAddress: addressSchema, receiptSigner: addressSchema,
  prices: z.object({ cpuPerSecond: moneySchema, inferenceFixed: moneySchema, maxSeconds: z.number().int().min(1).max(120), maxTokens: z.number().int().min(1).max(512) }),
  nearAvailable: z.boolean(), nearReadiness: nearReadinessSchema.optional(), cpuMode: z.string(), nearMode: z.string().optional(), cystsAvailable: z.boolean().default(false),
});
const leashSchema = z.object({ id: idSchema, owner: addressSchema, agent: addressSchema, maxPerHour: moneySchema, maxPerDay: moneySchema, expiry: z.union([z.number().int(), moneySchema]), killed: z.boolean() });
const runSchema = z.object({
  id: idSchema, leashId: idSchema,
  status: z.enum(['prepared', 'quote_pending', 'queued', 'running', 'near_dispatching', 'receipt_pending', 'settling', 'completed', 'failed', 'cancelled', 'timed_out', 'reconciliation', 'refunded']),
  createdAt: z.union([z.string(), z.number()]), maxSeconds: z.number().int().positive(), ceiling: moneySchema,
  charged: moneySchema.nullish(), refund: moneySchema.nullish(), billableSeconds: z.number().int().nonnegative().optional(),
  output: z.unknown().optional(), errorCode: z.string().nullish(), receipt: z.unknown().optional(),
  txHash: idSchema.nullish(), settlementTxHash: idSchema.nullish(), task: z.object({ kind: z.string() }).optional(), refundAt: z.union([z.number().int(), moneySchema]).nullish(),
});
const quoteResponseSchema = z.object({
  quote: z.object({ runId: idSchema, leashId: idSchema, payer: addressSchema, workloadHash: idSchema, maxSeconds: z.number().int().positive(), pricePerSecond: moneySchema, inferencePrice: moneySchema, quoteExpiry: z.number().int().positive() }),
  signature: hexSchema, ceiling: moneySchema, transaction: transactionSchema,
});
const accountSchema = z.object({ address: addressSchema, demo: z.boolean().default(false) });
const challengeSchema = z.object({ message: z.string().min(1), nonce: z.string().regex(/^[a-fA-F0-9]{48}$/) });
const balanceSchema = z.object({ available: moneySchema, reserved: moneySchema });
const leashListSchema = z.object({ leashes: z.array(leashSchema) });
const runListSchema = z.object({ runs: z.array(runSchema) });
const verificationSchema = z.object({ valid: z.boolean(), anchored: z.boolean().default(false), signer: addressSchema.optional(), evidence: z.string().optional(), reason: z.string().optional() });
const pendingAdmissionSchema = z.object({ runId: idSchema, txHash: idSchema, owner: addressSchema, chainId: z.number().int().positive() });
const operationsSchema = z.object({
  worker: z.object({ state: z.enum(['idle', 'running', 'stopped', 'quarantined', 'faulted']), activeRunId: idSchema.nullish(), reason: z.string().nullish() }),
  counts: z.record(z.number().int().nonnegative()),
  near: z.object({ configured: z.boolean(), verification: z.enum(['disabled', 'provider_tls', 'enclave_verified']), model: z.string().nullish(), readiness: nearReadinessSchema.optional() }),
  cpu: z.object({ mode: z.enum(['demo', 'docker']) }),
});
const providerEvidenceSchema = z.object({
  verification: z.enum(['provider_tls', 'enclave_verified']), attestationRef: z.string().nullish(), signingAddress: z.string().nullish(), signer: z.string().nullish(),
  expiresAt: z.union([z.string(), z.number()]).nullish(), receivedAt: z.string().nullish(),
});
type Transaction = z.infer<typeof transactionSchema>;
type Config = z.infer<typeof configSchema>;
type Leash = z.infer<typeof leashSchema>;
type Run = z.infer<typeof runSchema>;
type QuoteResponse = z.infer<typeof quoteResponseSchema>;
type PendingAdmission = z.infer<typeof pendingAdmissionSchema>;
type Operations = z.infer<typeof operationsSchema>;

declare global { interface Window { ethereum?: EIP1193Provider } }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const state: { config: Config | undefined; address: Address | undefined; demo: boolean; provider?: EIP1193Provider; leashes: Leash[]; runs: Run[]; quote: QuoteResponse | undefined; selectedRun: Run | undefined; operations: Operations | undefined; busy: Set<string>; poll: ReturnType<typeof setInterval> | undefined; runFingerprint?: string; leashFingerprint?: string; runDetailFingerprint?: string } = { config: undefined, address: undefined, demo: false, leashes: [], runs: [], quote: undefined, selectedRun: undefined, operations: undefined, busy: new Set(), poll: undefined };
let editingLeash: Leash | undefined;
let initialLeashExpiry = '';
let sessionVersion = 0;
const cystPanel = new CystPanel({ owner: () => state.address, enabled: () => state.config?.cystsAvailable ?? false, notice: message => notice(message) });
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'refunded']);
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const short = (value: string, size = 6) => value.length > size * 2 + 3 ? `${value.slice(0, size)}…${value.slice(-size)}` : value;
const readableStatus = (value: string) => value === 'prepared' ? 'quote pending' : value === 'near_dispatching' ? 'NEAR inference' : value === 'receipt_pending' ? 'preparing receipt' : value.replaceAll('_', ' ');
const jsonString = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

function units(value: string | number | null | undefined) {
  if (value === undefined || value === null) return '—';
  try {
    const text = formatUnits(BigInt(value), state.config?.token.decimals ?? 6);
    const [whole, fraction] = text.split('.');
    return fraction ? `${whole}.${fraction.slice(0, 6).replace(/0+$/, '')}`.replace(/\.$/, '') : (whole ?? '0');
  } catch { return String(value); }
}
function amount(value: string | number | null | undefined) { return value === undefined || value === null ? '—' : `${units(value)} ${state.config?.token.symbol ?? ''}`; }
function timestamp(value: string | number | null | undefined) {
  if (value === undefined || value === null) return '—';
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
function announce(message: string) { $('live-status').textContent = message; }
function notice(message: string, error = false) {
  $('notice').hidden = false; $('notice').classList.toggle('error', error); $('notice-text').textContent = message;
}
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined; }
function errorText(error: unknown) {
  const object = record(error); const message = typeof object?.message === 'string' ? object.message : '';
  if (object?.code === 4001 || /user rejected|user denied/i.test(message)) return 'Transaction cancelled in the wallet. You can try again.';
  if (error instanceof z.ZodError) return 'The server returned an unexpected response. Refresh and try again.';
  return typeof object?.shortMessage === 'string' ? object.shortMessage : message || 'Unable to complete this action. Check your connection and try again.';
}
async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  const version = sessionVersion;
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const payload: unknown = await response.json().catch(() => ({}));
  if (version !== sessionVersion && path !== '/api/demo/transaction') throw new Error('The signed-in account changed. Review the action again.');
  if (!response.ok) {
    if (response.status === 401 && state.address && version === sessionVersion) { sessionVersion++; state.address = undefined; updateAuth(); stopPolling(); }
    const problem = record(payload); const nested = record(problem?.error);
    const message = [problem?.error, problem?.detail, nested?.message, problem?.message].find(value => typeof value === 'string');
    throw new Error(typeof message === 'string' ? message : `Request failed (${response.status}). Try again.`);
  }
  return payload;
}
const post = (path: string, body: unknown = {}, idempotent = false) => api(path, { method: 'POST', body: JSON.stringify(body), headers: idempotent ? { 'Idempotency-Key': crypto.randomUUID() } : {} });
function fieldError(id: string, message = '') { $(id).textContent = message; $(id).hidden = !message; }
function clearFieldErrors() {
  ['funding-error', 'task-error', 'leash-error'].forEach(id => fieldError(id));
  document.querySelectorAll('[aria-invalid=true]').forEach(input => input.removeAttribute('aria-invalid'));
}
function invalid(input: HTMLElement, message: string, errorId: string): never {
  input.setAttribute('aria-invalid', 'true');
  const descriptions = new Set((input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)); descriptions.add(errorId);
  input.setAttribute('aria-describedby', [...descriptions].join(' ')); input.focus(); fieldError(errorId, message); throw new Error(message);
}
function clearEditedError(event: Event, errorId: string) {
  if (event.target instanceof HTMLElement) event.target.removeAttribute('aria-invalid');
  fieldError(errorId);
}
function positiveAmount(input: HTMLInputElement, errorId: string) {
  const value = input.value.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) invalid(input, 'Enter a positive token amount.', errorId);
  if ((value.split('.')[1]?.length ?? 0) > state.config!.token.decimals) invalid(input, `Use no more than ${state.config!.token.decimals} decimal places.`, errorId);
  const parsed = parseUnits(value, state.config!.token.decimals);
  if (parsed <= 0n) invalid(input, 'Enter an amount greater than zero.', errorId);
  if (parsed >= 2n ** 96n) invalid(input, 'Choose a smaller token amount.', errorId);
  return parsed.toString();
}
async function busy(buttonId: string, action: () => Promise<void>, errorId?: string) {
  if (state.busy.has(buttonId)) return;
  const button = $(buttonId) as HTMLButtonElement; const label = button.textContent;
  state.busy.add(buttonId); button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = `${label}…`;
  if (errorId) fieldError(errorId);
  try { await action(); }
  catch (error) { const message = errorText(error); if (errorId) fieldError(errorId, message); else notice(message, true); }
  finally { state.busy.delete(buttonId); button.removeAttribute('aria-busy'); button.textContent = buttonId === 'connect-wallet' && state.address && !state.demo ? 'Switch wallet' : label; button.disabled = button.classList.contains('signed-action') ? !state.address : false; updateWorkAvailability(); }
}

function chain() {
  const config = state.config!;
  return defineChain({ id: config.chain.id, name: config.chain.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [config.chain.rpcUrl] } }, ...(config.chain.explorerUrl ? { blockExplorers: { default: { name: 'Explorer', url: config.chain.explorerUrl } } } : {}) });
}
async function ensureChain() {
  if (!state.provider) throw new Error('Connect your wallet again to approve a transaction.');
  const chainId = `0x${state.config!.chain.id.toString(16)}`;
  try { await state.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
  catch (error) {
    if (record(error)?.code !== 4902) throw error;
    await state.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: state.config!.chain.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [state.config!.chain.rpcUrl], ...(state.config!.chain.explorerUrl ? { blockExplorerUrls: [state.config!.chain.explorerUrl] } : {}) }] });
  }
}
async function transact(transaction: Transaction, onSubmitted?: (hash: `0x${string}`) => void, beforeSubmit?: () => Promise<void>) {
  requireAccount();
  const identity = { version: sessionVersion, address: state.address!, demo: state.demo, provider: state.provider };
  const unchanged = () => {
    if (identity.version !== sessionVersion || identity.address !== state.address || identity.demo !== state.demo || identity.provider !== state.provider) {
      throw new Error('The signed-in account changed before submission. Review the action again.');
    }
  };
  let hash: `0x${string}`;
  if (identity.demo) {
    await beforeSubmit?.(); unchanged();
    const result = z.object({ txHash: idSchema }).parse(await post('/api/demo/transaction', transaction)); hash = result.txHash;
  } else {
    await ensureChain();
    unchanged();
    await beforeSubmit?.(); unchanged();
    const provider = identity.provider;
    if (!provider) throw new Error('Connect your wallet again to approve a transaction.');
    const wallet = createWalletClient({ chain: chain(), transport: custom(provider) });
    hash = await wallet.sendTransaction({ account: identity.address, chain: chain(), to: transaction.to, data: transaction.data ?? '0x', value: BigInt(transaction.value ?? '0') });
  }
  onSubmitted?.(hash);
  announce('Transaction sent. Waiting for confirmation.');
  const client = createPublicClient({ chain: chain(), transport: http(state.config!.chain.rpcUrl) });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw Object.assign(new Error('The transaction reverted. Refresh the balance and try again.'), { transactionReverted: true });
  return hash;
}
function transactionList(payload: unknown): Transaction[] {
  const response = fundingResponseSchema.parse(payload);
  return 'transactions' in response ? response.transactions : [response.transaction];
}
function requireAccount() { if (!state.address) throw new Error('Connect a wallet or use the local demo account first.'); }
function workerBlocked() { return Boolean(state.operations && ['stopped', 'quarantined', 'faulted'].includes(state.operations.worker.state)); }
function requireWorkerReady() { if (workerBlocked()) throw new Error('Execution is paused. Review the worker status before starting a run.'); }
function updateWorkAvailability() {
  for (const id of ['get-quote', 'approve-quote']) $<HTMLButtonElement>(id).disabled = !state.address || state.busy.has(id) || workerBlocked();
  $('worker-task-guidance').hidden = !state.address || !workerBlocked();
  $('worker-task-guidance').textContent = 'Execution is paused. Review worker status. Existing reservations keep their settlement and refund deadlines.';
}
function cpuDescription(mode: string) { return mode === 'demo' ? 'Local process · demo' : mode === 'docker' ? 'Docker container' : mode; }
function renderNearAvailability(configured: boolean, readiness?: z.infer<typeof nearReadinessSchema>) {
  const available = configured && (!readiness || readiness.state === 'ready');
  const checkbox = $<HTMLInputElement>('add-near'); checkbox.disabled = !available;
  if (!available) { checkbox.checked = false; $('near-fields').hidden = true; }
  $('near-status').textContent = available ? 'Available' : readiness?.reasonCode === 'POLICY_EXPIRED' ? 'Policy expired' : configured ? 'Unavailable' : 'Disabled';
  $('near-hint').textContent = available ? `${amount(state.config!.prices.inferenceFixed)} per inference request. Live verification runs before dispatch.`
    : readiness?.reasonCode === 'POLICY_EXPIRED' ? 'The operator must review a new provider policy before inference can run.'
    : configured ? 'Provider configuration needs operator review. CPU tasks remain available.' : 'Inference is disabled on this deployment. CPU tasks remain available.';
}
function renderOperations() {
  const operations = state.operations; if (!operations) return;
  const worker = operations.worker;
  const badge = $('worker-state'); badge.textContent = worker.state[0]!.toUpperCase() + worker.state.slice(1); badge.classList.toggle('blocked', workerBlocked());
  $('worker-active-row').hidden = !worker.activeRunId;
  $('worker-active-run').textContent = worker.activeRunId ? short(worker.activeRunId, 8) : ''; $('worker-active-run').title = worker.activeRunId ?? '';
  $('worker-queue').textContent = String(operations.counts.queued ?? 0);
  $('worker-settling').textContent = String((operations.counts.settling ?? 0) + (operations.counts.receipt_pending ?? 0));
  $('worker-reconciling').textContent = String(operations.counts.reconciliation ?? 0);
  const message = worker.state === 'quarantined' ? 'Worker recovery requires operator review. New work is paused. Review affected runs and their refund deadlines.'
    : worker.state === 'faulted' ? 'The worker is unavailable. New work is paused. The operator can inspect connectivity and pending runs.'
    : worker.state === 'stopped' ? 'The worker is stopped. The operator must start it before new work can run.'
    : (operations.counts.reconciliation ?? 0) > 0 ? 'Some runs await reconciliation. Review those runs for settlement or their refund deadline.'
    : (operations.counts.receipt_pending ?? 0) > 0 ? 'Results are saved. Receipt preparation is retrying automatically.' : '';
  $('worker-message').hidden = !message; $('worker-message').textContent = message;
  $('worker-reason').hidden = !worker.reason; $('worker-reason').textContent = worker.reason ?? '';
  $('cpu-evidence').textContent = cpuDescription(operations.cpu.mode);
  $('near-evidence').textContent = !operations.near.configured || operations.near.verification === 'disabled' ? 'Disabled'
    : operations.near.verification === 'enclave_verified' ? 'Enclave verification required' : 'Provider TLS · no enclave verification';
  $('near-model-row').hidden = !operations.near.model; $('near-model').textContent = operations.near.model ?? '';
  renderNearAvailability(operations.near.configured, operations.near.readiness);
  updateWorkAvailability();
}

function updateAuth() {
  const connected = Boolean(state.address);
  if (editingLeash && (!state.address || editingLeash.owner.toLowerCase() !== state.address.toLowerCase())) $<HTMLDialogElement>('leash-edit-dialog').close();
  document.querySelectorAll<HTMLButtonElement>('.signed-action').forEach(button => { button.disabled = !connected || state.busy.has(button.id); });
  $('connect-wallet').textContent = connected && !state.demo ? 'Switch wallet' : 'Connect wallet';
  $('account-label').textContent = state.address ? short(state.address, 10) : 'Connect a wallet to begin';
  $('account-label').title = state.address ?? '';
  $('account-state').textContent = connected ? (state.demo ? 'Local demo account · no real funds' : 'Signed in · wallet approvals required') : 'Sign a message to access your runs.';
  $('poll-state').textContent = connected ? 'Updates every 4 seconds' : 'Sign in to view runs';
  $('demo-fund').hidden = state.config?.mode !== 'demo' && state.config?.mode !== 'local';
  if (!connected) { $('available-balance').textContent = '—'; $('reserved-balance').textContent = '—'; }
  if (!connected) { state.operations = undefined; $('worker-state').textContent = 'Sign in'; $('worker-state').classList.remove('blocked'); $('worker-active-row').hidden = true; $('worker-message').hidden = true; $('worker-reason').hidden = true; }
  updateWorkAvailability();
  cystPanel.sync();
}
async function connect() {
  sessionVersion++;
  clearFieldErrors();
  const provider = window.ethereum;
  if (!provider) throw new Error('Install an EVM browser wallet, then refresh this page. The local demo account is also available in demo mode.');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts[0]) throw new Error('Choose an account in your wallet.');
  const address = addressSchema.parse(accounts[0]); state.provider = provider;
  const challenge = challengeSchema.parse(await post('/api/auth/challenge', { address }));
  const wallet = createWalletClient({ transport: custom(provider) });
  const signature = await wallet.signMessage({ account: address, message: challenge.message });
  accountSchema.parse(await post('/api/auth/verify', { address, nonce: challenge.nonce, signature }));
  state.address = address; state.demo = false; state.quote = undefined; $('quote-panel').hidden = true;
  updateAuth(); await refresh(); startPolling(); notice('Wallet signed in. Create a leash or select an existing one.');
  provider.removeListener?.('accountsChanged', handleAccountsChanged); provider.on?.('accountsChanged', handleAccountsChanged);
}
function handleAccountsChanged() {
  sessionVersion++; state.address = undefined; state.quote = undefined; $('quote-panel').hidden = true; updateAuth(); stopPolling();
  notice('The wallet account changed. Connect and sign in again to continue.');
}
async function demoSignIn() {
  sessionVersion++;
  const result = accountSchema.parse(await post('/api/auth/demo')); state.address = result.address; state.demo = true; state.quote = undefined;
  updateAuth(); await refresh(); startPolling(); notice('Local demo account ready. Fund the demo balance, then create a leash.');
}
async function funding(action: 'deposit' | 'withdraw') {
  requireAccount(); clearFieldErrors(); const value = positiveAmount($<HTMLInputElement>('funding-amount'), 'funding-error');
  const owner = state.address!; const version = sessionVersion;
  const payload = await api(`/api/transactions/${action}?amount=${encodeURIComponent(value)}`);
  const transactions = transactionList(payload);
  if (!transactions.length) throw new Error('The server returned no transaction. Refresh and try again.');
  for (const [index, transaction] of transactions.entries()) {
    if (version !== sessionVersion || owner !== state.address) throw new Error('The account changed during funding. An earlier approval may be confirmed; review the original account before continuing.');
    notice(`${index === 0 && transactions.length > 1 ? 'Approve token allowance' : action === 'deposit' ? 'Approve deposit' : 'Approve withdrawal'}${state.demo ? ' in the local demo' : ' in your wallet'}.`);
    await transact(transaction);
  }
  await refresh(); notice(action === 'deposit' ? 'Deposit confirmed. Available balance updated.' : 'Withdrawal confirmed. Tokens returned to the account.');
}
async function createLeash() {
  requireAccount(); clearFieldErrors();
  const agentInput = $<HTMLInputElement>('leash-agent'); const agent = agentInput.value.trim() || state.address!;
  if (!isAddress(agent)) invalid(agentInput, 'Enter a complete EVM address, or leave this field blank.', 'leash-error');
  const maxPerHour = positiveAmount($<HTMLInputElement>('hour-budget'), 'leash-error');
  const maxPerDay = positiveAmount($<HTMLInputElement>('day-budget'), 'leash-error');
  if (BigInt(maxPerDay) < BigInt(maxPerHour)) invalid($('day-budget'), 'Set the daily budget at least as high as the hourly budget.', 'leash-error');
  const expiry = Math.floor(Date.now() / 1000) + Number($<HTMLSelectElement>('leash-duration').value);
  const payload = transactionResponseSchema.parse(await post('/api/leashes', { agent, maxPerHour, maxPerDay, expiry }, true));
  const transaction = payload.transaction;
  await transact(transaction); await refresh(); $<HTMLDetailsElement>('leash-details').open = false;
  notice('Leash created. Select it to get a run quote.'); $('run-leash').focus();
}
function taskPayload() {
  const kind = $<HTMLSelectElement>('task-kind').value;
  if (kind === 'sha256' || kind === 'hash_chain') {
    const text = $<HTMLTextAreaElement>('task-text').value;
    if (!text.length) invalid($('task-text'), 'Enter text to hash.', 'task-error');
    if (new TextEncoder().encode(text).byteLength > 8192) invalid($('task-text'), 'Use no more than 8 KB of UTF-8 text.', 'task-error');
    if (kind === 'sha256') return { kind, text };
    const iterationsInput = $<HTMLInputElement>('hash-iterations'); const iterations = Number(iterationsInput.value);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 2_000_000) invalid(iterationsInput, 'Choose 1 to 2,000,000 hash iterations.', 'task-error');
    return { kind, text, iterations };
  }
  if (kind === 'sort') {
    const input = $<HTMLTextAreaElement>('task-numbers'); const tokens = input.value.trim().split(/[\s,]+/).filter(Boolean); const numbers = tokens.map(Number);
    if (!numbers.length || numbers.length > 10_000 || numbers.some(value => !Number.isFinite(value))) invalid(input, 'Enter up to 10,000 finite numbers, separated by commas or spaces.', 'task-error');
    return { kind, numbers };
  }
  const input = $<HTMLInputElement>('task-limit'); const limit = Number(input.value);
  if (!Number.isInteger(limit) || limit < 2 || limit > 2_000_000) invalid(input, 'Enter a whole number from 2 to 2,000,000.', 'task-error');
  return { kind, limit };
}
function discardQuote() { state.quote = undefined; $('quote-panel').hidden = true; }
function pendingAdmissions(): PendingAdmission[] {
  try { const value: unknown = JSON.parse(sessionStorage.getItem('telomere.pendingRuns') ?? '[]'); return z.array(pendingAdmissionSchema).parse(value); }
  catch { return []; }
}
function saveAdmission(value: PendingAdmission) {
  const existing = pendingAdmissions().filter(item => item.runId !== value.runId);
  sessionStorage.setItem('telomere.pendingRuns', JSON.stringify([...existing, value]));
}
function removeAdmission(id: string) { sessionStorage.setItem('telomere.pendingRuns', JSON.stringify(pendingAdmissions().filter(item => item.runId !== id))); }
async function admitPendingRuns() {
  const admissions = pendingAdmissions().filter(item => item.owner.toLowerCase() === state.address?.toLowerCase() && item.chainId === state.config?.chain.id);
  for (const admission of admissions) {
    try {
      await post('/api/runs', { runId: admission.runId, txHash: admission.txHash }, true); removeAdmission(admission.runId);
      if (state.quote?.quote.runId === admission.runId) { discardQuote(); notice('Confirmed run resumed. View its progress in the execution ledger.'); }
    }
    catch { /* Keep the confirmed transaction for the next reconciliation attempt. */ }
  }
}
async function getQuote() {
  requireAccount(); requireWorkerReady(); clearFieldErrors();
  const leashId = $<HTMLSelectElement>('run-leash').value;
  if (!leashId) { $<HTMLDetailsElement>('leash-details').open = true; invalid($('run-leash'), 'Create and select an active leash first.', 'task-error'); }
  const task = taskPayload(); const maxSeconds = Number($<HTMLInputElement>('max-seconds').value);
  if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > state.config!.prices.maxSeconds) invalid($('max-seconds'), `Choose a runtime from 1 to ${state.config!.prices.maxSeconds} seconds.`, 'task-error');
  const nearEnabled = $<HTMLInputElement>('add-near').checked; const nearPrompt = $<HTMLTextAreaElement>('near-prompt').value.trim();
  if (nearEnabled && !nearPrompt) invalid($('near-prompt'), 'Enter a prompt, or turn off NEAR inference.', 'task-error');
  if (nearEnabled && new TextEncoder().encode(nearPrompt).byteLength > 8192) invalid($('near-prompt'), 'Use no more than 8 KB of UTF-8 text for the NEAR prompt.', 'task-error');
  state.quote = quoteResponseSchema.parse(await post('/api/quotes', { leashId, task, maxSeconds, ...(nearEnabled ? { nearPrompt } : {}) }, true));
  $('quote-ceiling').textContent = amount(state.quote.ceiling);
  $('quote-summary').textContent = `${task.kind.replaceAll('_', ' ').toUpperCase()} · up to ${maxSeconds} seconds${nearEnabled ? ' · NEAR inference included' : ''}`;
  $('quote-expiry').textContent = timestamp(state.quote.quote.quoteExpiry);
  $('quote-run').textContent = short(state.quote.quote.runId, 9); $('quote-run').title = state.quote.quote.runId;
  $('quote-panel').hidden = false; $('approve-quote').focus(); announce('Quote ready. Review the maximum reservation before approving.');
}
async function approveQuote() {
  requireAccount(); requireWorkerReady(); const quote = state.quote;
  const owner = state.address!; const version = sessionVersion; const chainId = state.config!.chain.id;
  if (!quote) throw new Error('Get a new quote before approving a run.');
  const pending = pendingAdmissions().find(item => item.runId === quote.quote.runId && item.owner.toLowerCase() === state.address!.toLowerCase() && item.chainId === state.config!.chain.id);
  if (!pending && Number(quote.quote.quoteExpiry) <= Date.now() / 1000) { discardQuote(); throw new Error('This quote expired. Get a new quote to continue.'); }
  notice(pending ? 'Resuming the confirmed run. No new wallet transaction is needed.' : state.demo ? 'Opening the run on the local demo chain.' : 'Approve the run and its maximum reservation in your wallet.');
  let txHash: `0x${string}`;
  try {
    txHash = pending?.txHash ?? await transact(quote.transaction, hash => saveAdmission({ runId: quote.quote.runId, txHash: hash, owner, chainId }));
  } catch (error) {
    if (record(error)?.transactionReverted === true) removeAdmission(quote.quote.runId);
    throw error;
  }
  if (version !== sessionVersion || owner !== state.address) throw new Error('The original reservation was submitted. Reconnect its owner to resume admission; do not send it again.');
  const run = runSchema.parse(await post('/api/runs', { runId: quote.quote.runId, txHash }, true));
  removeAdmission(quote.quote.runId);
  discardQuote(); await refresh(); notice('Run opened. Its reservation is held until settlement.');
  await openRun(run.id);
}
function activeLeash(leash: Leash) { return !leash.killed && Number(leash.expiry) > Date.now() / 1000; }
function renderLeashes() {
  const fingerprint = JSON.stringify(state.leashes);
  if (state.leashFingerprint === fingerprint) return; state.leashFingerprint = fingerprint;
  const live = state.leashes.filter(activeLeash); const select = $<HTMLSelectElement>('run-leash'); const selected = select.value;
  $('leash-count').textContent = `${live.length} active`;
  select.innerHTML = live.length ? live.map(leash => `<option value="${escapeHtml(leash.id)}">${escapeHtml(short(leash.id, 5))} · ${escapeHtml(amount(leash.maxPerDay))}/day</option>`).join('') : '<option value="">Create a leash first</option>';
  if (live.some(leash => leash.id === selected)) select.value = selected;
  $('leashes-list').innerHTML = state.leashes.length ? state.leashes.map(leash => `<div class="leash-item"><div class="leash-top"><strong title="${escapeHtml(leash.id)}">${escapeHtml(short(leash.id, 6))}</strong><span class="tag">${leash.killed ? 'Killed' : activeLeash(leash) ? 'Active' : 'Expired'}</span></div><p class="leash-agent" title="${escapeHtml(leash.agent)}">Agent ${escapeHtml(short(leash.agent, 8))}</p><div class="leash-bottom"><p>${escapeHtml(amount(leash.maxPerHour))}/hour · ${escapeHtml(amount(leash.maxPerDay))}/day<span class="leash-expiry">Expires ${escapeHtml(timestamp(leash.expiry))}</span></p><div class="leash-actions">${!leash.killed ? `<button type="button" class="text-button" data-edit-leash="${escapeHtml(leash.id)}">Edit budget</button>` : ''}${activeLeash(leash) ? `<button type="button" class="text-button" data-kill="${escapeHtml(leash.id)}">Kill leash</button>` : ''}</div></div></div>`).join('') : '<p class="empty-copy">No leashes yet. Create one to cap your spending.</p>';
  if (!live.length) $<HTMLDetailsElement>('leash-details').open = true;
}
function renderRuns() {
  const fingerprint = JSON.stringify(state.runs);
  if (state.runFingerprint === fingerprint) return; state.runFingerprint = fingerprint;
  $('runs-empty').hidden = Boolean(state.runs.length);
  const focused = document.activeElement as HTMLElement; const focusId = focused?.dataset.run ?? focused?.dataset.stop;
  $('runs-list').innerHTML = state.runs.map(run => `<li class="run-row"><div><div class="run-title"><button type="button" data-run="${escapeHtml(run.id)}" title="${escapeHtml(run.id)}">${escapeHtml(short(run.id, 7))}</button></div><p class="run-task">${escapeHtml(run.task?.kind?.toUpperCase() ?? 'CPU run')} · ${escapeHtml(timestamp(run.createdAt))}</p></div><span class="status ${escapeHtml(run.status)}">${escapeHtml(readableStatus(run.status))}</span><dl class="run-metrics"><div><dt>${run.status === 'prepared' ? 'Ceiling' : 'Reserved'}</dt><dd>${escapeHtml(amount(run.ceiling))}</dd></div><div><dt>Charged</dt><dd>${escapeHtml(amount(run.charged))}</dd></div><div><dt>Refund</dt><dd>${escapeHtml(amount(run.refund))}</dd></div></dl><button type="button" class="text-button run-action" ${terminalStatuses.has(run.status) || ['reconciliation', 'prepared', 'quote_pending', 'receipt_pending', 'settling'].includes(run.status) ? `data-run="${escapeHtml(run.id)}">${run.receipt ? 'View receipt' : 'View details'}` : `data-stop="${escapeHtml(run.id)}">Stop run`}</button></li>`).join('');
  if (focusId) document.querySelector<HTMLButtonElement>(`[data-run="${CSS.escape(focusId)}"], [data-stop="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
}
async function refresh(quiet = false) {
  if (!state.address) return;
  const version = sessionVersion; const owner = state.address;
  await admitPendingRuns();
  const results = await Promise.allSettled([api('/api/balance').then(value => balanceSchema.parse(value)), api('/api/leashes').then(value => leashListSchema.parse(value)), api('/api/runs').then(value => runListSchema.parse(value)), api('/api/operations').then(value => operationsSchema.parse(value))]);
  if (version !== sessionVersion || owner !== state.address) return;
  if (results[0].status === 'fulfilled') { $('available-balance').textContent = units(results[0].value.available); $('reserved-balance').textContent = units(results[0].value.reserved); }
  if (results[1].status === 'fulfilled') { state.leashes = results[1].value.leashes; renderLeashes(); }
  if (results[2].status === 'fulfilled') { state.runs = results[2].value.runs.slice().sort((a, b) => Number(new Date(b.createdAt)) - Number(new Date(a.createdAt))); renderRuns(); }
  if (results[3].status === 'fulfilled') { state.operations = results[3].value; renderOperations(); }
  else { $('worker-state').textContent = state.operations ? `Unavailable · last ${state.operations.worker.state}` : 'Status unavailable'; $('worker-message').hidden = false; $('worker-message').textContent = 'Unable to refresh worker status. Select Refresh to try again.'; }
  const failed = results.slice(0, 3).find(result => result.status === 'rejected') as PromiseRejectedResult | undefined;
  if (failed) { $('poll-state').textContent = 'Connection interrupted · retrying'; if (!quiet) throw failed.reason; }
  else $('poll-state').textContent = 'Updates every 4 seconds';
  if (state.selectedRun && $<HTMLDialogElement>('run-dialog').open) {
    const latest = await api(`/api/runs/${encodeURIComponent(state.selectedRun.id)}`).then(value => runSchema.parse(value)).catch(() => undefined);
    if (latest) { state.selectedRun = latest; renderRunDetail(); }
  }
  if (!quiet) await cystPanel.refresh().catch(error => { $('checkpoint-error').textContent = errorText(error); });
}
function stopPolling() { if (state.poll) clearInterval(state.poll); state.poll = undefined; }
function startPolling() { stopPolling(); state.poll = setInterval(() => { if (!document.hidden && state.address) void refresh(true); }, 4000); }
function explorerLink(hash: string | null | undefined, label: string) {
  if (!hash) return '';
  const base = state.config!.chain.explorerUrl;
  return base ? `<p class="hint">${escapeHtml(label)}: <a href="${escapeHtml(`${base.replace(/\/$/, '')}/tx/${hash}`)}" target="_blank" rel="noopener noreferrer">${escapeHtml(short(hash, 10))}</a></p>` : `<p class="hint">${escapeHtml(label)}: <span class="mono">${escapeHtml(hash)}</span></p>`;
}
function renderProviderEvidence(run: Run) {
  const near = record(record(record(run.receipt)?.body)?.near);
  if (!near) return '';
  const parsed = providerEvidenceSchema.safeParse(near.evidence);
  if (!parsed.success) return '<div class="detail-section"><h3>NEAR evidence</h3><p class="hint">No structured provider evidence was returned. Review the raw receipt below.</p></div>';
  const evidence = parsed.data;
  const signer = evidence.signingAddress ?? evidence.signer;
  const expiry = evidence.expiresAt;
  const numericExpiry = expiry == null ? Number.NaN : Number(expiry);
  const expiryMilliseconds = expiry == null ? Number.NaN : Number.isFinite(numericExpiry) ? numericExpiry < 1e12 ? numericExpiry * 1000 : numericExpiry : Date.parse(String(expiry));
  const expired = Number.isFinite(expiryMilliseconds) && expiryMilliseconds < Date.now();
  const rows = [
    `<div><dt>Recorded checks</dt><dd>${evidence.verification === 'enclave_verified' ? 'Enclave verification' : 'Provider TLS'}</dd></div>`,
    typeof near.model === 'string' ? `<div><dt>Model</dt><dd class="mono">${escapeHtml(near.model)}</dd></div>` : '',
    evidence.attestationRef ? `<div><dt>Attestation ref</dt><dd class="mono">${escapeHtml(evidence.attestationRef)}</dd></div>` : '',
    signer ? `<div><dt>Signing address</dt><dd class="mono">${escapeHtml(signer)}</dd></div>` : '',
    expiry != null ? `<div><dt>Attestation expiry</dt><dd>${escapeHtml(timestamp(expiry))}${expired ? ' · expired' : ''}</dd></div>` : '',
  ].join('');
  const caption = evidence.verification === 'provider_tls' ? 'This receipt records TLS provider access. It contains no verified enclave attestation.'
    : expired ? 'The policy has expired. The receipt retains the recorded checks and signature; these do not prove an exact serving instance.' : 'Hardware and workload checks and the response signature were recorded separately. A shared model key does not prove the response came from the exact attested instance.';
  return `<div class="detail-section"><h3>NEAR evidence</h3><dl class="provider-evidence-facts">${rows}</dl><p class="hint">${caption}</p></div>`;
}
function renderRunRecovery(run: Run) {
  const deadline = run.refundAt ? `<p class="hint">An expired reservation can be claimed after ${escapeHtml(timestamp(run.refundAt))}.</p>` : '';
  if (run.status !== 'reconciliation') return deadline;
  const message = run.errorCode === 'PROVIDER_OUTCOME_UNKNOWN' ? 'The provider outcome is unknown. This run needs reconciliation; its paid inference request will not be repeated automatically.'
    : 'This run needs operator review before settlement can finish.';
  return `<div class="detail-section"><h3>Run recovery</h3><p class="hint">${message}</p>${deadline}</div>`;
}
function renderRunDetail() {
  const run = state.selectedRun; if (!run) return;
  $('run-detail-title').textContent = short(run.id, 12); $('run-detail-title').title = run.id;
  const fingerprint = JSON.stringify(run);
  if (state.runDetailFingerprint !== fingerprint) {
  $('run-detail-content').innerHTML = `<dl class="detail-grid"><div><dt>Status</dt><dd class="status ${escapeHtml(run.status)}">${escapeHtml(readableStatus(run.status))}</dd></div><div><dt>Maximum reservation</dt><dd>${escapeHtml(amount(run.ceiling))}</dd></div><div><dt>Actual charge</dt><dd>${escapeHtml(amount(run.charged))}</dd></div><div><dt>Refund</dt><dd>${escapeHtml(amount(run.refund))}</dd></div><div><dt>Billable runtime</dt><dd>${run.billableSeconds === undefined ? '—' : `${escapeHtml(run.billableSeconds)} seconds`}</dd></div><div><dt>Runtime limit</dt><dd>${run.maxSeconds === undefined ? '—' : `${escapeHtml(run.maxSeconds)} seconds`}</dd></div></dl>${run.errorCode ? `<div class="detail-section"><h3>Worker status</h3><p class="field-error">${escapeHtml(run.errorCode)}</p></div>` : ''}<div class="detail-section"><h3>Result</h3>${run.output != null ? `<pre>${escapeHtml(jsonString(run.output))}</pre>` : `<p class="hint">${terminalStatuses.has(run.status) ? 'This run returned no result.' : 'The worker has not returned a result yet.'}</p>`}</div>${renderProviderEvidence(run)}<div class="detail-section"><h3>Settlement evidence</h3>${run.receipt ? `<pre>${escapeHtml(jsonString(run.receipt))}</pre>` : '<p class="hint">A signed receipt becomes available after settlement.</p>'}${explorerLink(run.txHash, 'Open transaction')}${explorerLink(run.settlementTxHash, 'Settlement transaction')}</div>`;
    $('run-detail-content').insertAdjacentHTML('beforeend', renderRunRecovery(run));
    state.runDetailFingerprint = fingerprint;
  }
  $('stop-detail-run').hidden = terminalStatuses.has(run.status) || ['receipt_pending', 'settling', 'reconciliation', 'quote_pending', 'prepared'].includes(run.status);
  const refundButton = $<HTMLButtonElement>('claim-refund');
  refundButton.hidden = terminalStatuses.has(run.status) || !run.refundAt;
  refundButton.disabled = state.busy.has('claim-refund') || Number(run.refundAt) > Date.now() / 1000;
  refundButton.title = run.refundAt ? `Available after ${timestamp(run.refundAt)}` : '';
  $('verify-receipt').hidden = !run.receipt; $('download-receipt').hidden = !run.receipt;
}
async function openRun(id: string) {
  state.selectedRun = runSchema.parse(await api(`/api/runs/${encodeURIComponent(id)}`));
  $('receipt-verification').textContent = ''; $('receipt-verification').classList.remove('error'); renderRunDetail();
  const dialog = $<HTMLDialogElement>('run-dialog'); if (!dialog.open) dialog.showModal();
}
async function stopRun(id: string) {
  requireAccount(); const payload = transactionResponseSchema.parse(await post(`/api/runs/${encodeURIComponent(id)}/stop`));
  await transact(payload.transaction);
  await refresh(); notice('Stop requested. The final charge and refund appear after settlement.');
}
async function killLeash(id: string) {
  requireAccount(); const payload = transactionResponseSchema.parse(await post(`/api/leashes/${encodeURIComponent(id)}/kill`));
  await transact(payload.transaction); await refresh();
  if (state.quote?.quote.leashId === id) discardQuote();
  notice('Leash killed. Active work will stop and new runs are blocked.');
}
function editLeash(id: string) {
  requireAccount();
  const leash = state.leashes.find(item => item.id === id);
  if (!leash || leash.killed || leash.owner.toLowerCase() !== state.address!.toLowerCase()) throw new Error('Refresh and select an available leash.');
  editingLeash = leash;
  $<HTMLInputElement>('edit-hour-budget').value = units(leash.maxPerHour);
  $<HTMLInputElement>('edit-day-budget').value = units(leash.maxPerDay);
  const date = new Date(Number(leash.expiry) * 1000);
  initialLeashExpiry = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $<HTMLInputElement>('edit-leash-expiry').value = initialLeashExpiry;
  $('edit-leash-agent').textContent = leash.agent;
  fieldError('edit-leash-error');
  $<HTMLDialogElement>('leash-edit-dialog').showModal();
}
async function saveLeash() {
  requireAccount();
  const leash = editingLeash;
  if (!leash || leash.owner.toLowerCase() !== state.address!.toLowerCase()) throw new Error('Sign in again before editing this leash.');
  const maxPerHour = positiveAmount($<HTMLInputElement>('edit-hour-budget'), 'edit-leash-error');
  const maxPerDay = positiveAmount($<HTMLInputElement>('edit-day-budget'), 'edit-leash-error');
  if (BigInt(maxPerDay) < BigInt(maxPerHour)) invalid($('edit-day-budget'), 'Set the daily budget at least as high as the hourly budget.', 'edit-leash-error');
  const expiryInput = $<HTMLInputElement>('edit-leash-expiry');
  // REASON: preserving the displayed minute also preserves the original onchain seconds.
  const expiry = expiryInput.value === initialLeashExpiry ? Number(leash.expiry) : Math.floor(new Date(expiryInput.value).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + 30 * 86400) invalid(expiryInput, 'Choose a future expiry within 30 days.', 'edit-leash-error');
  const response = z.object({ leashId: idSchema, agent: addressSchema, transaction: transactionSchema }).strict()
    .parse(await post(`/api/leashes/${encodeURIComponent(leash.id)}/update`, { maxPerHour, maxPerDay, expiry }));
  const expected = encodeFunctionData({ abi: escrowAbi, functionName: 'updateLeash', args: [leash.id, leash.agent, BigInt(maxPerHour), BigInt(maxPerDay), BigInt(expiry)] });
  if (response.leashId !== leash.id || response.agent.toLowerCase() !== leash.agent.toLowerCase()
    || response.transaction.to.toLowerCase() !== state.config!.escrowAddress.toLowerCase() || response.transaction.data.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('The proposed update differs from your reviewed budget. Refresh and try again.');
  }
  await transact(response.transaction, undefined, async () => {
    const fresh = leashListSchema.parse(await api('/api/leashes')).leashes.find(item => item.id === leash.id);
    if (!fresh || fresh.killed || fresh.agent.toLowerCase() !== leash.agent.toLowerCase()) throw new Error('The leash agent or availability changed. Review a fresh budget update.');
  });
  if (state.quote?.quote.leashId === leash.id) discardQuote();
  await refresh(); $<HTMLDialogElement>('leash-edit-dialog').close();
  notice('Leash budget updated. Existing spending and reservations are retained.');
}
async function claimRefund() {
  const run = state.selectedRun; if (!run) return;
  const payload = transactionResponseSchema.parse(await post(`/api/runs/${encodeURIComponent(run.id)}/refund`));
  await transact(payload.transaction); await refresh(); notice('Expired reservation refunded. The ledger will update after reconciliation.');
}
async function verifyReceipt() {
  if (!state.selectedRun?.receipt) return;
  const payload = verificationSchema.parse(await post('/api/receipts/verify', { receipt: state.selectedRun.receipt }));
  $('receipt-verification').classList.toggle('error', !payload.valid);
  $('receipt-verification').textContent = payload.valid ? `Signature verified${payload.signer ? ` · ${short(payload.signer, 8)}` : ''} · ${payload.anchored ? 'Onchain receipt matched' : 'Onchain receipt not matched'}${payload.evidence ? ` · ${payload.evidence.replace(/[.\s]+$/, '')}` : ''}.` : `Receipt verification failed${payload.reason ? `: ${payload.reason}` : '.'}`;
}
function downloadReceipt() {
  const run = state.selectedRun; if (!run?.receipt) return;
  const blob = new Blob([JSON.stringify({ runId: run.id, receipt: run.receipt }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `telomere-${run.id}-receipt.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function changeTask() {
  const kind = $<HTMLSelectElement>('task-kind').value;
  $('text-task').hidden = !['sha256', 'hash_chain'].includes(kind); $('hash-chain-task').hidden = kind !== 'hash_chain'; $('sort-task').hidden = kind !== 'sort'; $('primes-task').hidden = kind !== 'primes';
  $('task-text-label').textContent = kind === 'hash_chain' ? 'Seed text' : 'Text to hash';
  $('task-input-hint').textContent = kind === 'sha256' ? 'Text is hashed by the configured CPU worker. Maximum: 8 KB of UTF-8 text.' : kind === 'hash_chain' ? 'Repeated SHA-256 hashes. Use up to 8 KB of UTF-8 text and 2,000,000 iterations.' : kind === 'sort' ? 'Use up to 10,000 numbers, separated by commas or spaces.' : 'Returns primes up to the chosen limit. Maximum: 2,000,000.';
  discardQuote();
}

$('connect-wallet').addEventListener('click', () => void busy('connect-wallet', connect));
$('use-demo').addEventListener('click', () => void busy('use-demo', demoSignIn));
$('dismiss-notice').addEventListener('click', () => { $('notice').hidden = true; });
$('refresh').addEventListener('click', () => void busy('refresh', async () => { await refresh(); announce('Balance and runs updated.'); }));
$('worker-active-run').addEventListener('click', () => { if (state.operations?.worker.activeRunId) void openRun(state.operations.worker.activeRunId).catch(error => notice(errorText(error), true)); });
$('funding-form').addEventListener('submit', event => { event.preventDefault(); void busy('deposit', () => funding('deposit'), 'funding-error'); });
$('funding-form').addEventListener('input', event => clearEditedError(event, 'funding-error'));
$('withdraw').addEventListener('click', () => void busy('withdraw', () => funding('withdraw'), 'funding-error'));
$('demo-fund').addEventListener('click', () => void busy('demo-fund', async () => { requireAccount(); await post('/api/demo/fund'); await refresh(); notice('Demo balance funded. Available balance updated.'); }));
$('leash-form').addEventListener('submit', event => { event.preventDefault(); void busy('create-leash', createLeash, 'leash-error'); });
$('leash-form').addEventListener('input', event => clearEditedError(event, 'leash-error'));
$('task-form').addEventListener('submit', event => { event.preventDefault(); void busy('get-quote', getQuote, 'task-error'); });
$('task-kind').addEventListener('change', changeTask);
$('task-form').addEventListener('input', event => { clearEditedError(event, 'task-error'); if (state.quote) discardQuote(); });
$('add-near').addEventListener('change', () => { $('near-fields').hidden = !$<HTMLInputElement>('add-near').checked; });
$('discard-quote').addEventListener('click', discardQuote);
$('approve-quote').addEventListener('click', () => void busy('approve-quote', approveQuote, 'task-error'));
$('runs-list').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return;
  if (button.dataset.run) void openRun(button.dataset.run).catch(error => notice(errorText(error), true));
  if (button.dataset.stop) {
    button.disabled = true; void stopRun(button.dataset.stop).catch(error => notice(errorText(error), true)).finally(() => { button.disabled = false; });
  }
});
$('leashes-list').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return;
  if (button.dataset.editLeash) { try { editLeash(button.dataset.editLeash); } catch (error) { notice(errorText(error), true); } }
  if (button.dataset.kill) { button.disabled = true; void killLeash(button.dataset.kill).catch(error => notice(errorText(error), true)).finally(() => { button.disabled = false; }); }
});
$('leash-edit-form').addEventListener('submit', event => { event.preventDefault(); void busy('save-leash', saveLeash, 'edit-leash-error'); });
$('leash-edit-form').addEventListener('input', event => clearEditedError(event, 'edit-leash-error'));
$('cancel-leash-edit').addEventListener('click', () => $<HTMLDialogElement>('leash-edit-dialog').close());
$('leash-edit-dialog').addEventListener('close', () => {
  const id = editingLeash?.id; editingLeash = undefined;
  const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-edit-leash]')).find(button => button.dataset.editLeash === id);
  trigger?.focus();
});
$('close-dialog').addEventListener('click', () => $<HTMLDialogElement>('run-dialog').close());
$('run-dialog').addEventListener('close', () => { state.selectedRun = undefined; });
$('stop-detail-run').addEventListener('click', () => void busy('stop-detail-run', async () => { if (state.selectedRun) await stopRun(state.selectedRun.id); }));
$('claim-refund').addEventListener('click', () => void busy('claim-refund', claimRefund));
$('verify-receipt').addEventListener('click', () => void busy('verify-receipt', verifyReceipt));
$('download-receipt').addEventListener('click', downloadReceipt);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.address) void refresh(true); });

async function init() {
  try {
    state.config = configSchema.parse(await api('/api/config')); const config = state.config;
    const isDemo = ['local', 'demo'].includes(config.mode);
    $('profile-badge').textContent = isDemo ? 'Local demo' : config.chain.id === 84532 ? 'Base Sepolia' : config.chain.name;
    $('profile-badge').className = `badge ${isDemo ? 'demo' : config.chain.id === 84532 ? 'testnet' : 'mainnet'}`;
    $('use-demo').hidden = !isDemo;
    $('token-caption').textContent = `${config.token.symbol} · ${isDemo ? 'demo tokens, no real value' : config.chain.name}`;
    $('footer-profile').textContent = `${config.chain.name} · chain ${config.chain.id} · ${config.token.symbol}`;
    $('cpu-price').textContent = `${amount(config.prices.cpuPerSecond)}/sec`;
    $<HTMLInputElement>('max-seconds').max = String(config.prices.maxSeconds);
    $<HTMLInputElement>('max-seconds').value = String(Math.min(10, config.prices.maxSeconds));
    $('runtime-hint').textContent = `Stops at this limit. Maximum: ${config.prices.maxSeconds} seconds.`;
    renderNearAvailability(config.nearReadiness ? config.nearReadiness.state !== 'disabled' : config.nearAvailable, config.nearReadiness);
    $('near-limit').textContent = `Prompt: up to 8 KB of UTF-8 text. Output: up to ${config.prices.maxTokens} tokens.`;
    $('cpu-evidence').textContent = cpuDescription(config.cpuMode) || 'Configured CPU worker';
    $('near-evidence').textContent = config.nearAvailable ? 'Sign in to view configured checks' : 'Disabled · no provider credentials';
    $('signer-evidence').textContent = short(config.receiptSigner, 9); $('signer-evidence').title = config.receiptSigner;
    const me = await api('/api/me').then(value => accountSchema.parse(value)).catch(() => undefined);
    if (me?.address) { state.address = me.address; state.demo = isDemo && Boolean(me.demo); updateAuth(); await refresh(); startPolling(); }
    else updateAuth();
  } catch (error) { $('profile-badge').textContent = 'Server unavailable'; notice(errorText(error), true); }
}
void init();
