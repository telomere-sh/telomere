import { createHash } from 'node:crypto';
import { decodeFunctionResult, domainSeparator, encodeFunctionData, getContractAddress, keccak256, parseAbi } from 'viem';

// Public, read-only RPC observations. No wallet, secret input, signing or submission.
// Run from this checkout: node docs/evidence/base-mainnet-asset-observation-20261015/observe-public-base.mjs
// The script writes its complete report to stdout only; retain a new output file deliberately.
const endpoints = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const asset = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ownerProposal = '0xa67c6a174409b9b44e67d24cdd386a31d44edb1d';
const implementationSlot = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const oracle = '0x420000000000000000000000000000000000000F';
const l1Block = '0x4200000000000000000000000000000000000015';
const allowed = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt',
  'eth_call', 'eth_getTransactionCount', 'eth_getBalance', 'eth_gasPrice']);
const abi = parseAbi(['function name() view returns(string)', 'function symbol() view returns(string)',
  'function version() view returns(string)', 'function decimals() view returns(uint8)',
  'function DOMAIN_SEPARATOR() view returns(bytes32)', 'function isFjord() view returns(bool)',
  'function isIsthmus() view returns(bool)', 'function isJovian() view returns(bool)',
  'function getOperatorFee(uint256) view returns(uint256)', 'function getL1FeeUpperBound(uint256) view returns(uint256)',
  'function operatorFeeScalar() view returns(uint32)', 'function operatorFeeConstant() view returns(uint64)']);
const raw = [];
let nextId = 1;
const quantity = value => `0x${BigInt(value).toString(16)}`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const expect = (ok, message) => { if (!ok) throw new Error(message); };
async function rpc(endpoint, method, params) {
  expect(endpoints.includes(endpoint) && allowed.has(method), 'Non-read-only RPC refused');
  const request = { jsonrpc: '2.0', id: nextId++, method, params };
  const startedAt = new Date().toISOString();
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(15000) });
  const responseText = await response.text();
  const body = JSON.parse(responseText);
  raw.push({ endpoint, startedAt, finishedAt: new Date().toISOString(), httpStatus: response.status,
    request, response: body, responseTextSha256: sha256(responseText) });
  expect(response.ok && body.id === request.id && !body.error && Object.hasOwn(body, 'result'), 'Public RPC read failed');
  return body.result;
}
async function call(endpoint, address, functionName, args, state) {
  const data = encodeFunctionData({ abi, functionName, args });
  const result = await rpc(endpoint, 'eth_call', [{ to: address, data }, state]);
  return decodeFunctionResult({ abi, functionName, data: result });
}
async function observeAsset(endpoint, block, kind) {
  expect(block && block.hash && block.number && block.timestamp, 'Missing canonical block');
  const state = { blockHash: block.hash, requireCanonical: true };
  const [proxy, pointer, name, symbol, version, decimals, domain] = await Promise.all([
    rpc(endpoint, 'eth_getCode', [asset, state]), rpc(endpoint, 'eth_getStorageAt', [asset, implementationSlot, state]),
    ...['name', 'symbol', 'version', 'decimals', 'DOMAIN_SEPARATOR'].map(fn => call(endpoint, asset, fn, [], state)),
  ]);
  expect(/^0x[0-9a-f]{64}$/i.test(pointer), 'Invalid Circle implementation slot');
  const implementation = `0x${pointer.slice(-40)}`;
  const code = await rpc(endpoint, 'eth_getCode', [implementation, state]);
  const canonical = (await rpc(endpoint, 'eth_getBlockByNumber', [block.number, false])).hash === block.hash;
  const expectedDomain = domainSeparator({ domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: asset } });
  expect(proxy !== '0x' && code !== '0x' && !/^0x0{40}$/i.test(implementation) && canonical,
    'Missing code or noncanonical asset state');
  expect(name === 'USD Coin' && symbol === 'USDC' && version === '2' && decimals === 6 && domain === expectedDomain,
    'Circle native USDC metadata or domain differs');
  return { kind, number: BigInt(block.number).toString(), hash: block.hash,
    timestamp: BigInt(block.timestamp).toString(), utc: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(),
    proxyBytes: (proxy.length - 2) / 2, proxyCodeHash: keccak256(proxy), implementation,
    implementationBytes: (code.length - 2) / 2, implementationCodeHash: keccak256(code),
    metadata: { name, symbol, version, decimals, domain }, expectedDomain, canonical };
}
const startedAt = new Date().toISOString();
const finalized = await Promise.all(endpoints.map(async endpoint => {
  expect(BigInt(await rpc(endpoint, 'eth_chainId', [])) === 8453n, 'Wrong Base chain');
  return rpc(endpoint, 'eth_getBlockByNumber', ['finalized', false]);
}));
const commonNumber = finalized.reduce((n, block) => BigInt(block.number) < n ? BigInt(block.number) : n,
  BigInt(finalized[0].number));
const common = await Promise.all(endpoints.map(endpoint => rpc(endpoint, 'eth_getBlockByNumber', [quantity(commonNumber), false])));
expect(common.every(block => block.hash === common[0].hash), 'Finalized RPC block disagreement');
let anchorNumber = commonNumber - 21600n;
let anchor = await rpc(endpoints[0], 'eth_getBlockByNumber', [quantity(anchorNumber), false]);
for (let attempt = 0; BigInt(common[0].timestamp) - BigInt(anchor.timestamp) < 21600n && attempt < 8; attempt++) {
  anchorNumber -= 21600n;
  expect(anchorNumber >= 0n, 'No old finalized anchor');
  anchor = await rpc(endpoints[0], 'eth_getBlockByNumber', [quantity(anchorNumber), false]);
}
expect(BigInt(common[0].timestamp) - BigInt(anchor.timestamp) >= 21600n, 'Archive anchor younger than six hours');
const observations = await Promise.all(endpoints.map(async (endpoint, index) => {
  const old = await rpc(endpoint, 'eth_getBlockByNumber', [quantity(anchorNumber), false]);
  expect(old.hash === anchor.hash, 'Archive RPC block disagreement');
  const latest = await rpc(endpoint, 'eth_getBlockByNumber', ['latest', false]);
  const states = [];
  for (const [kind, block] of [['finalized', common[index]], ['historical-finalized', old], ['latest', latest]]) {
    states.push(await observeAsset(endpoint, block, kind));
  }
  const state = { blockHash: latest.hash, requireCanonical: true };
  const nonceHex = await rpc(endpoint, 'eth_getTransactionCount', [ownerProposal, 'pending']);
  const nonceAtBlock = await rpc(endpoint, 'eth_getTransactionCount', [ownerProposal, latest.number]);
  const predicted = getContractAddress({ from: ownerProposal, nonce: BigInt(nonceHex) });
  const calls = [['isFjord', oracle, []], ['isIsthmus', oracle, []], ['isJovian', oracle, []],
    ['getOperatorFee', oracle, [1000000n]], ['getL1FeeUpperBound', oracle, [15000n]],
    ['operatorFeeScalar', l1Block, []], ['operatorFeeConstant', l1Block, []]];
  const fees = [];
  for (const [functionName, address, args] of calls) fees.push({ functionName,
    args: args.map(String), value: String(await call(endpoint, address, functionName, args, state)) });
  return { endpoint, finalizedReported: finalized[index].number, states,
    ownerProposal: { address: ownerProposal, roleAssignmentApprovedByObservation: false,
      code: await rpc(endpoint, 'eth_getCode', [ownerProposal, state]), pendingNonce: BigInt(nonceHex).toString(),
      nonceAtLatestObservation: BigInt(nonceAtBlock).toString(),
      balanceWei: BigInt(await rpc(endpoint, 'eth_getBalance', [ownerProposal, state])).toString(),
      predictedCreate: predicted, predictedCode: await rpc(endpoint, 'eth_getCode', [predicted, state]) },
    feeObservations: { block: latest.number, blockHash: latest.hash,
      gasPriceWei: BigInt(await rpc(endpoint, 'eth_gasPrice', [])).toString(), calls: fees,
      scope: '1,000,000 gas and 15,000 transaction bytes are illustrative probes, not a deployment estimate' },
    latestStillCanonical: (await rpc(endpoint, 'eth_getBlockByNumber', [latest.number, false])).hash === latest.hash };
}));
const pins = observations.flatMap(item => item.states).map(item => JSON.stringify({ proxyCodeHash: item.proxyCodeHash,
  implementation: item.implementation, implementationCodeHash: item.implementationCodeHash, metadata: item.metadata }));
expect(new Set(pins).size === 1 && observations.every(item => item.latestStillCanonical), 'Asset pins or canonicality disagree');
const report = { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), chainId: 8453, asset,
  rpcClass: 'two unauthenticated public RPC providers; not a private archive service',
  officialReferences: ['https://developers.circle.com/stablecoins/usdc-contract-addresses',
    'https://docs.base.org/specifications/transactions/network-fees',
    'https://docs.optimism.io/op-stack/transactions/fees',
    'https://github.com/circlefin/stablecoin-evm/blob/master/contracts/upgradeability/UpgradeabilityProxy.sol'],
  implementationSlot, anchorAgeSeconds: (BigInt(common[0].timestamp) - BigInt(anchor.timestamp)).toString(),
  observations, agreement: true, publicTransactionsSent: 0, signaturesCreated: 0, raw };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
