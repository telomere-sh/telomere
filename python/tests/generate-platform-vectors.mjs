// Offline public TEST identities only. No RPC, HTTP, wallet submission or operator keys.
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodeFunctionData, hashTypedData, keccak256, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { platformEscrowAbi, platformQuoteTypes } from '../../dist/src/platform-runtime/types.js';

const signer = privateKeyToAccount(`0x${'11'.repeat(32)}`), owner = privateKeyToAccount(`0x${'22'.repeat(32)}`), agent = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const address = byte => `0x${byte.repeat(20)}`, id = byte => `0x${byte.repeat(32)}`, epoch = 1_700_000_000;
const pins = { chainId: 31337, escrowAddress: address('44'), tokenAddress: address('55'), tokenCodeHash: id('55'),
  reviewedTokenKind: 'immutable', quoteSigner: signer.address,
  receiptRootAddress: address('66'), hostRegistryAddress: address('77'), feeRouterAddress: address('88'),
  escrowCodeHash: id('44'), receiptRootCodeHash: id('66'), hostRegistryCodeHash: id('77'), feeRouterCodeHash: id('88') };
const vaultPins = { registryAddress: address('99'), registryCodeHash: id('99'), implementationAddress: address('aa'), implementationCodeHash: id('aa') };
const binding = { vault: address('bb'), owner: owner.address, agentWallet: agent.address, agentId: id('cc'), leashId: id('dd') };
const capacity = [{ hostId: id('ee'), hardwareClass: 'cpu', region: 'test-one', imageDigest: `sha256:${'a'.repeat(64)}`, lane: 'standard', pricePerSecond: '101' }];
const config = { protocol: 'telomere-platform-v1', pins, maxSeconds: 120, feeBps: 900, capacity };
const vaultConfig = { ...config, binding, vaultPins };
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']'
  : '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
const vaultAbi = parseAbi([
  'struct PlatformQuote { bytes32 runId; bytes32 leashId; bytes32 hostId; address payer; uint16 hwClass; bytes32 regionHash; bytes32 imageHash; bytes32 workloadHash; uint64 maxSeconds; uint96 pricePerSecond; uint96 inferencePrice; uint64 quoteExpiry; }',
  'function payRun(PlatformQuote quote,bytes signature,bytes32[] imageProof,bytes32[] regionProof)', 'function requestStop(bytes32 runId)',
]);
const input = { leashId: id('dd'), task: { kind: 'hash_chain', text: 'Telomere проверка 🧬', iterations: 13 }, maxSeconds: 3,
  deadline: epoch + 90, maxSpend: '331', regions: ['test-one'] };
const typed = quote => ({ domain: { name: 'TelomerePlatformEscrow', version: '1', chainId: pins.chainId, verifyingContract: pins.escrowAddress },
  types: platformQuoteTypes, primaryType: 'PlatformQuote', message: quote });
const transaction = (to, data) => ({ chainId: pins.chainId, to, data, value: '0' });
async function vector(name, payer, isVault, imageProof, regionProof, selectedInput = input, runId = id(name === 'eoa' ? '12' : '34')) {
  const quote = { runId, leashId: selectedInput.leashId, hostId: capacity[0].hostId, payer, hwClass: 0,
    regionHash: keccak256(toHex(capacity[0].region)), imageHash: keccak256(toHex(capacity[0].imageDigest)), workloadHash: keccak256(toHex(canonical({ task: selectedInput.task }))),
    maxSeconds: BigInt(selectedInput.maxSeconds), pricePerSecond: 101n, inferencePrice: 0n, quoteExpiry: BigInt(epoch + 60) };
  const signature = await signer.signTypedData(typed(quote));
  const data = encodeFunctionData({ abi: isVault ? vaultAbi : platformEscrowAbi, functionName: isVault ? 'payRun' : 'openRun', args: [quote, signature, imageProof, regionProof] });
  const wire = { ...quote, maxSeconds: selectedInput.maxSeconds, pricePerSecond: '101', inferencePrice: '0', quoteExpiry: epoch + 60 };
  const prepared = { input: selectedInput, quote: wire, signature, ceiling: '331', imageProof, regionProof, transaction: transaction(isVault ? binding.vault : pins.escrowAddress, data) };
  const admissionHash = id(isVault ? '56' : '78');
  const run = { id: wire.runId, status: 'queued', quote: wire, ceiling: '331', admissionTx: admissionHash, settlementTx: null,
    result: null, settlement: null, charged: null, refund: null, errorCode: null };
  const stop = transaction(isVault ? binding.vault : pins.escrowAddress, encodeFunctionData({ abi: isVault ? vaultAbi : platformEscrowAbi, functionName: 'requestStop', args: [wire.runId] }));
  const refund = transaction(pins.escrowAddress, encodeFunctionData({ abi: platformEscrowAbi, functionName: 'refundRun', args: [wire.runId] }));
  return { prepared, quoteDigest: hashTypedData(typed(quote)), run, admissionHash, actions: { stop, refund } };
}
const vectors = { source: 'viem 2.57.3; actual compiled platform ABI; offline public test identities; no RPC/HTTP/broadcast', epoch,
  owner: owner.address, agent: agent.address, pins, vaultPins, binding, config, vaultConfig, input,
  eoa: await vector('eoa', owner.address, false, [id('10')], [id('20'), id('30')]),
  vault: await vector('vault', binding.vault, true, [id('40'), id('50')], [id('60')]),
  emptyProofs: await vector('eoa', owner.address, false, [], []) };
const execInput = { ...input, task: { kind: 'exec', imageDigest: capacity[0].imageDigest,
  argv: ['/usr/local/bin/node', '-e', 'process.stdout.write(require("node:fs").readFileSync(0,"utf8"))'],
  stdin: 'Telomere проверка 🧬\n' } };
const execConfig = { ...config, capacity: capacity.map(host => ({ ...host, execEnabled: true })) };
Object.assign(vectors, { execInput, execConfig, execVaultConfig: { ...execConfig, binding, vaultPins },
  execEoa: await vector('execEoa', owner.address, false, [id('10')], [id('20'), id('30')], execInput, id('90')),
  execVault: await vector('execVault', binding.vault, true, [id('40'), id('50')], [id('60')], execInput, id('91')) });
mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
writeFileSync(new URL('./fixtures/platform-typescript.json', import.meta.url), JSON.stringify(vectors, null, 2) + '\n');
