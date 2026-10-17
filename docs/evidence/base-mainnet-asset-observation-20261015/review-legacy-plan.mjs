import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import solc from 'solc';
import { decodeFunctionResult, domainSeparator, encodeDeployData, encodeFunctionData, getContractAddress,
  keccak256, parseAbi, serializeTransaction, stringToHex } from 'viem';

// This review reads one explicitly selected PUBLIC deployment plan. No key/env input.
// It compiles in memory, reads public RPCs, simulates creation with eth_call, and writes stdout only.
const expectedPlanSha256 = '2be56662f572ae01c25a2950f9f010104f12e2e30afb3150f153b96993f15bf8';
const expectedDigest = '0xc9d585926f2489d5d3745ec996eac8fc8eab0fc2d217c9b352c5f6c627f00e2f';
const endpoints = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const owner = '0xa67c6a174409b9b44e67d24cdd386a31d44edb1d';
const signer = '0x87599dBF6f720DE7751E8CB2d36d4Ea96A4A1d38';
const token = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const oracle = '0x420000000000000000000000000000000000000F';
const implementationSlot = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const root = resolve(import.meta.dirname, '../../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const quantity = value => `0x${BigInt(value).toString(16)}`;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  assert(typeof value === 'object', 'Non-JSON plan value');
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
const planPath = process.argv[2];
assert(planPath && process.argv.length === 3 && basename(planPath) === 'deployment-plan-base-mainnet.json',
  'Select the explicitly reviewed public Base mainnet plan');
const stat = lstatSync(planPath);
assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 262144, 'Unsafe public plan file');
const planBytes = readFileSync(planPath);
assert(sha(planBytes) === expectedPlanSha256, 'The reviewed plan bytes changed');
const plan = JSON.parse(planBytes.toString('utf8'));
const { reviewDigest, ...content } = plan;
assert(equal(keccak256(stringToHex(canonical(content))), reviewDigest) && equal(reviewDigest, expectedDigest), 'Plan digest differs');
assert(plan.chainId === 8453 && plan.schemaVersion === 2 && plan.mode === 'unsigned-base-usdc-legacy-escrow', 'Wrong plan type');
assert(equal(plan.transaction.from, owner) && equal(plan.treasury, owner) && equal(plan.quoteSigner, signer)
  && equal(plan.receiptSigner, signer) && equal(plan.reviewedAsset.address, token), 'Role or asset differs from reviewed proposal');
assert(plan.transaction.to === null && plan.transaction.value === '0' && Number.isSafeInteger(plan.transaction.nonce)
  && plan.transaction.nonce >= 0 && /^\d+$/.test(plan.transaction.gas), 'Invalid creation transaction');
const predicted = getContractAddress({ from: owner, nonce: BigInt(plan.transaction.nonce) });
assert(equal(predicted, plan.predictedEscrowAddress), 'CREATE prediction differs');

const sourcePath = 'contracts/TelomereRunEscrow.sol';
const compilerInputs = new Map();
function readSource(path) { const raw = readFileSync(resolve(root, path)); compilerInputs.set(path, sha(raw)); return raw.toString('utf8'); }
const input = { language: 'Solidity', sources: { [sourcePath]: { content: readSource(sourcePath) } }, settings: {
  optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'], '': ['ast'] } },
} };
const compiled = JSON.parse(solc.compile(JSON.stringify(input), { import: path => {
  if (!path.startsWith('@openzeppelin/contracts/') || path.includes('..')) return { error: 'Unexpected import' };
  return { contents: readSource(`node_modules/${path}`) };
} }));
assert(!(compiled.errors ?? []).some(error => error.severity === 'error'), 'Fresh Solidity compilation failed');
const contract = compiled.contracts[sourcePath].TelomereRunEscrow;
const bytecode = `0x${contract.evm.bytecode.object}`;
const data = encodeDeployData({ abi: contract.abi, bytecode, args: [token, signer, signer, owner] });
assert(equal(data, plan.transaction.data) && equal(keccak256(data), plan.creationCodeHash)
  && equal(keccak256(bytecode), plan.artifactBytecodeHash) && solc.version() === plan.compiler,
  'Fresh compiler or exact constructor data differs');
const declarations = new Map();
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.nodeType === 'VariableDeclaration') declarations.set(String(node.id), node.name);
  for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value); }
}
Object.values(compiled.sources).forEach(source => walk(source.ast));
const refs = contract.evm.deployedBytecode.immutableReferences;
const template = contract.evm.deployedBytecode.object;
function checkRuntime(runtime) {
  const observed = runtime.slice(2);
  assert(observed.length === template.length, 'Simulated runtime length differs');
  const masked = observed.split('');
  const immutables = [];
  for (const [id, ranges] of Object.entries(refs)) {
    const values = ranges.map(({ start, length }) => observed.slice(start * 2, (start + length) * 2));
    assert(new Set(values).size === 1, 'One immutable has different copies');
    const name = declarations.get(id);
    const expected = { token, quoteSigner: signer, receiptSigner: signer, treasury: owner,
      _cachedThis: predicted, _cachedChainId: quantity(8453),
      _cachedDomainSeparator: domainSeparator({ domain: { name: 'TelomereRunEscrow', version: '1', chainId: 8453, verifyingContract: predicted } }),
      _hashedName: keccak256(stringToHex('TelomereRunEscrow')), _hashedVersion: keccak256(stringToHex('1')) }[name];
    if (expected) assert(equal(values[0], expected.slice(2).padStart(ranges[0].length * 2, '0')), 'Constructor immutable differs');
    for (const { start, length } of ranges) masked.fill('0', start * 2, (start + length) * 2);
    immutables.push({ astId: id, name, ranges, value: `0x${values[0]}`, expectedValueChecked: !!expected });
  }
  assert(masked.join('') === template, 'Non-immutable deployed runtime differs from fresh compiler');
  return immutables;
}

let nextId = 1;
const raw = [];
const allowed = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call',
  'eth_getTransactionCount', 'eth_getBalance', 'eth_gasPrice', 'eth_maxPriorityFeePerGas']);
async function rpc(endpoint, method, params) {
  assert(endpoints.includes(endpoint) && allowed.has(method), 'Non-read-only method refused');
  const request = { jsonrpc: '2.0', id: nextId++, method, params };
  const startedAt = new Date().toISOString();
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(15000) });
  const text = await response.text(); const body = JSON.parse(text);
  raw.push({ endpoint, startedAt, finishedAt: new Date().toISOString(), httpStatus: response.status, request, response: body,
    responseTextSha256: sha(text) });
  assert(response.ok && body.id === request.id && !body.error && Object.hasOwn(body, 'result'), 'Read-only RPC failed');
  return body.result;
}
const abi = parseAbi(['function getL1Fee(bytes) view returns(uint256)', 'function getL1FeeUpperBound(uint256) view returns(uint256)',
  'function getOperatorFee(uint256) view returns(uint256)', 'function isJovian() view returns(bool)']);
async function call(endpoint, functionName, args, state) {
  const result = await rpc(endpoint, 'eth_call', [{ to: oracle, data: encodeFunctionData({ abi, functionName, args }) }, state]);
  return decodeFunctionResult({ abi, functionName, data: result });
}
const startedAt = new Date().toISOString();
const observations = await Promise.all(endpoints.map(async endpoint => {
  assert(BigInt(await rpc(endpoint, 'eth_chainId', [])) === 8453n, 'Wrong chain');
  const reference = await rpc(endpoint, 'eth_getBlockByNumber', [quantity(plan.referenceBlock), false]);
  assert(equal(reference.hash, plan.referenceHash), 'Plan reference no longer canonical');
  const block = await rpc(endpoint, 'eth_getBlockByNumber', ['latest', false]);
  const state = { blockHash: block.hash, requireCanonical: true };
  const [pending, atBlock, ownerCode, futureCode, balance, proxy, pointer] = await Promise.all([
    rpc(endpoint, 'eth_getTransactionCount', [owner, 'pending']), rpc(endpoint, 'eth_getTransactionCount', [owner, block.number]),
    rpc(endpoint, 'eth_getCode', [owner, state]), rpc(endpoint, 'eth_getCode', [predicted, state]),
    rpc(endpoint, 'eth_getBalance', [owner, state]), rpc(endpoint, 'eth_getCode', [token, state]),
    rpc(endpoint, 'eth_getStorageAt', [token, implementationSlot, state]),
  ]);
  assert(BigInt(pending) === BigInt(plan.transaction.nonce) && pending === atBlock && ownerCode === '0x' && futureCode === '0x',
    'Deployer nonce/code or predicted vacancy changed');
  const implementation = `0x${pointer.slice(-40)}`;
  const implementationCode = await rpc(endpoint, 'eth_getCode', [implementation, state]);
  assert(equal(keccak256(proxy), plan.reviewedAsset.proxyCodeHash) && equal(implementation, plan.reviewedAsset.implementation.address)
    && equal(keccak256(implementationCode), plan.reviewedAsset.implementation.codeHash), 'Current USDC code pins differ');
  const runtime = await rpc(endpoint, 'eth_call', [{ from: owner, data, value: '0x0', gas: quantity(plan.transaction.gas),
    nonce: quantity(plan.transaction.nonce) }, state, { [owner]: { balance: quantity(10n ** 18n) } }]);
  const immutables = checkRuntime(runtime);
  const gasLimit = BigInt(plan.transaction.gas);
  const priority = BigInt(await rpc(endpoint, 'eth_maxPriorityFeePerGas', []));
  const maxFeePerGas = BigInt(block.baseFeePerGas) * 2n + priority;
  const unsigned = serializeTransaction({ type: 'eip1559', chainId: 8453, nonce: plan.transaction.nonce,
    gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas: priority, value: 0n, data });
  const [l1Estimate, l1Upper, operatorFee, jovian] = await Promise.all([
    call(endpoint, 'getL1Fee', [unsigned], state), call(endpoint, 'getL1FeeUpperBound', [BigInt((unsigned.length - 2) / 2)], state),
    call(endpoint, 'getOperatorFee', [gasLimit], state), call(endpoint, 'isJovian', [], state),
  ]);
  assert((await rpc(endpoint, 'eth_getBlockByNumber', [block.number, false])).hash === block.hash, 'Cost/runtime snapshot became noncanonical');
  assert(equal((await rpc(endpoint, 'eth_getBlockByNumber', [quantity(plan.referenceBlock), false])).hash, plan.referenceHash), 'Plan reference replaced');
  const currentGasPrice = BigInt(await rpc(endpoint, 'eth_gasPrice', []));
  return { endpoint, blockNumber: BigInt(block.number).toString(), blockHash: block.hash,
    observedAt: new Date().toISOString(), actualOwnerBalanceWei: BigInt(balance).toString(),
    planNonce: String(plan.transaction.nonce), pendingNonce: BigInt(pending).toString(), predictedVacant: true,
    usdcPinsMatch: true, referenceCanonical: true, latestCanonical: true,
    creationSimulation: { method: 'eth_call', realStatePersisted: false, simulatedOwnerBalanceWei: (10n ** 18n).toString(),
      runtimeBytes: (runtime.length - 2) / 2, runtimeCodeHash: keccak256(runtime), exactCompilerTemplateOutsideImmutables: true,
      immutables, runtime },
    pricing: { mode: 'separate unsigned EIP-1559 cost review; original legacy plan unchanged',
      planGasPriceWei: plan.transaction.gasPrice, currentGasPriceWei: currentGasPrice.toString(),
      gasLimit: gasLimit.toString(), baseFeePerGasWei: BigInt(block.baseFeePerGas).toString(), maxPriorityFeePerGasWei: priority.toString(),
      maxFeePerGasWei: maxFeePerGas.toString(), unsignedTransactionBytes: (unsigned.length - 2) / 2,
      unsignedTransaction: unsigned, l2GasLimitTimesMaxFeeWei: (gasLimit * maxFeePerGas).toString(),
      l1CurrentEstimateWei: l1Estimate.toString(), l1EstimatedUpperBoundWei: l1Upper.toString(),
      jovian, operatorFeeAtGasLimitWei: operatorFee.toString(),
      estimatedTotalUsingL1UpperWei: (gasLimit * maxFeePerGas + l1Upper + operatorFee).toString(),
      ownerBalanceSufficientForThisObservation: BigInt(balance) >= gasLimit * maxFeePerGas + l1Upper + operatorFee,
      futureL1FeeHardCap: false },
  };
}));
assert(new Set(observations.map(x => x.creationSimulation.runtimeCodeHash)).size === 1, 'Cross-RPC simulated runtime differs');
for (const [path, hash] of compilerInputs) assert(sha(readFileSync(resolve(root, path))) === hash, 'Compiler input changed during review');
assert(sha(readFileSync(planPath)) === expectedPlanSha256, 'Original plan changed during review');
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(),
  planSha256: expectedPlanSha256, reviewDigest, creationCodeHash: keccak256(data), predictedAddress: predicted,
  compiler: solc.version(), compilerInputs: Object.fromEntries(compilerInputs),
  exactPlanCompilationMatch: true, exactPlanBytesUnchanged: true, crossRpcSimulatedRuntimeAgreement: true,
  observations, publicTransactionsSent: 0, signaturesCreated: 0, raw }, null, 2)}\n`);
