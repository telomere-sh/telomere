// Local public-data fixtures only. Importing the guard does not run its private-filesystem/RPC entry point.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getContractAddress, keccak256 } from 'viem';
import { legacyDeploymentPlanDigest } from '../../scripts/deployment-approval.ts';
import { validateBootstrapOwnership, validateDaemonConfiguration, validateLegacyPlan, validateDeploymentTransaction,
  validateFinalizedDeployment, validateRuntime } from './preflight.mjs';

const expected = JSON.parse(await readFile(new URL('./expected.json.template', import.meta.url), 'utf8'));
const daemon = JSON.parse(await readFile(new URL('./docker-daemon.json.draft', import.meta.url), 'utf8'));
const daemonUnit = await readFile(new URL('./telomere-mainnet-docker.service.draft', import.meta.url), 'utf8');
const plan = JSON.parse(await readFile(new URL('../../docs/evidence/legacy-mainnet-preparation-20261015/vps/deployment-plan-base-mainnet.json', import.meta.url), 'utf8'));
const config = { ESCROW_ADDRESS: plan.predictedEscrowAddress, TOKEN_ADDRESS: plan.reviewedAsset.address,
  TOKEN_CODE_HASH: plan.reviewedAsset.proxyCodeHash, TOKEN_IMPLEMENTATION_ADDRESS: plan.reviewedAsset.implementation.address,
  TOKEN_IMPLEMENTATION_CODE_HASH: plan.reviewedAsset.implementation.codeHash };
const crypto = { legacyDeploymentPlanDigest, keccak256, getContractAddress };
const hash = '0x' + '11'.repeat(32), blockHash = '0x' + '22'.repeat(32), finalizedHash = '0x' + '33'.repeat(32);
const transaction = { hash, from: expected.deployerAddress, to: null, value: 0n, nonce: 0,
  input: plan.transaction.data, blockNumber: 123n, blockHash };
const receipt = { transactionHash: hash, from: expected.deployerAddress, to: null, status: 'success',
  contractAddress: expected.deploymentEscrowAddress, blockNumber: 123n, blockHash };
const deploymentBlock = { number: 123n, hash: blockHash }, finalized = { number: 200n, hash: finalizedHash };

test('accepts the exact isolated daemon configuration with an owned explicit bridge', () => {
  validateDaemonConfiguration(daemon);
});
for (const [field, value] of [['bridge', 'none'], ['bridge', 'docker0'], ['fixed-cidr', '172.17.0.0/16'],
  ['bip', '172.31.254.1/24'], ['default-address-pools', [{ base: '172.31.254.0/24', size: 24 }]],
  ['iptables', true], ['ip6tables', true], ['ip-forward', true], ['ip-masq', true],
  ['data-root', '/var/lib/docker'], ['exec-root', '/var/run/docker'],
  ['hosts', ['unix:///var/run/docker.sock']], ['containerd-namespace', 'moby'],
  ['default-runtime', 'runc'],
  ['runtimes', { runsc: { path: '/tmp/runsc' } }]]) {
  test('refuses unsafe or shared daemon option ' + field + '=' + JSON.stringify(value), () => {
    assert.throws(() => validateDaemonConfiguration({ ...daemon, [field]: value }));
  });
}
test('refuses omitted isolation option or an additional unreviewed daemon option', () => {
  const changed = { ...daemon }; delete changed['containerd-namespace'];
  assert.throws(() => validateDaemonConfiguration(changed));
  assert.throws(() => validateDaemonConfiguration({ ...daemon, containerd: '/tmp/containerd.sock' }));
});
test('refuses both plugin namespace JSON keys; the reviewed explicit CLI flag supplies this option', () => {
  for (const key of ['containerd-plugin-namespace', 'containerd-plugins-namespace']) {
    assert.throws(() => validateDaemonConfiguration({ ...daemon, [key]: 'telomere-mainnet-plugins' }));
  }
});
test('pins the accepted explicit plugin namespace flag and before/after network guards in the daemon unit', () => {
  const lines = daemonUnit.split(/\r?\n/);
  assert.deepEqual(lines.filter(line => line.startsWith('ExecStart=')), [
    'ExecStart=/usr/bin/dockerd --config-file=/opt/telomere-mainnet-pilot/private/docker-daemon.json --containerd-plugins-namespace=telomere-mainnet-plugins',
  ]);
  assert.ok(lines.includes('Requires=telomere-mainnet-network.service'));
  assert.ok(lines.includes('ExecStartPre=/usr/bin/python3 /opt/telomere-mainnet-pilot/operator/prepare-network.py --before-daemon'));
  assert.ok(lines.includes('ExecStartPost=/usr/bin/python3 /opt/telomere-mainnet-pilot/operator/prepare-network.py --after-daemon'));
});

test('accepts the exact reviewed bootstrap ownership record', () => {
  validateBootstrapOwnership(structuredClone(expected.bootstrapOwnership), expected.bootstrapOwnership);
});
for (const [field, value] of [['operation', 'other'], ['id', 'wrong'], ['base', '/opt/telomere-pilot'], ['uid', 1000],
  ['gid', 1000], ['owner', '0x' + '44'.repeat(20)], ['controllerStarted', true], ['transactionsSent', 1], ['unexpected', true]]) {
  test('refuses altered bootstrap ' + field, () => {
    assert.throws(() => validateBootstrapOwnership({ ...expected.bootstrapOwnership, [field]: value }, expected.bootstrapOwnership));
  });
}
test('accepts the actual retained unsigned plan with independently pinned digest, creation hash, roles and predicted address', () => {
  validateLegacyPlan(plan, expected, config, crypto);
});
for (const [name, mutate] of [
  ['creation bytes', value => { value.transaction.data = value.transaction.data.slice(0, -2) + 'ff'; }],
  ['nonce', value => { value.transaction.nonce = 1; }],
  ['deployer', value => { value.transaction.from = '0x' + '44'.repeat(20); }],
  ['quote signer', value => { value.quoteSigner = '0x' + '44'.repeat(20); }],
  ['receipt signer', value => { value.receiptSigner = '0x' + '44'.repeat(20); }],
  ['treasury', value => { value.treasury = '0x' + '44'.repeat(20); }],
  ['token', value => { value.reviewedAsset.address = '0x' + '44'.repeat(20); }],
  ['USDC implementation', value => { value.reviewedAsset.implementation.address = '0x' + '44'.repeat(20); }],
  ['predicted address', value => { value.predictedEscrowAddress = '0x' + '44'.repeat(20); }],
  ['review digest', value => { value.reviewDigest = '0x' + '44'.repeat(32); }],
]) {
  test('refuses altered retained plan ' + name, () => {
    const changed = structuredClone(plan); mutate(changed);
    assert.throws(() => validateLegacyPlan(changed, expected, config, crypto));
  });
}
test('accepts only the exact canonical CREATE transaction fixture', () => {
  validateDeploymentTransaction(transaction, receipt, plan, expected, hash);
});
for (const [field, value] of [['from', '0x' + '44'.repeat(20)], ['to', expected.deploymentEscrowAddress], ['value', 1n],
  ['nonce', 1], ['input', '0x1234'], ['hash', '0x' + '44'.repeat(32)], ['blockHash', '0x' + '44'.repeat(32)], ['blockNumber', 124n]]) {
  test('refuses substituted deployment transaction ' + field, () => {
    assert.throws(() => validateDeploymentTransaction({ ...transaction, [field]: value }, receipt, plan, expected, hash));
  });
}
for (const [field, value] of [['status', 'reverted'], ['to', expected.deployerAddress],
  ['contractAddress', '0x' + '44'.repeat(20)], ['from', '0x' + '44'.repeat(20)]]) {
  test('refuses substituted deployment receipt ' + field, () => {
    assert.throws(() => validateDeploymentTransaction(transaction, { ...receipt, [field]: value }, plan, expected, hash));
  });
}
test('accepts a deployment covered by the canonical finalized block', () => {
  validateFinalizedDeployment(receipt, deploymentBlock, finalized, finalized);
});
test('refuses a deployment ahead of finalized head', () => {
  const behind = { number: 122n, hash: finalizedHash };
  assert.throws(() => validateFinalizedDeployment(receipt, deploymentBlock, behind, behind));
});
test('refuses noncanonical deployment or finalized block hashes', () => {
  assert.throws(() => validateFinalizedDeployment(receipt, { ...deploymentBlock, hash: finalizedHash }, finalized, finalized));
  assert.throws(() => validateFinalizedDeployment(receipt, deploymentBlock, finalized, { ...finalized, hash: blockHash }));
});
const review = JSON.parse(await readFile(new URL('../../docs/evidence/base-mainnet-asset-observation-20261015/legacy-plan-runtime-cost-review.json', import.meta.url), 'utf8'));
function findRuntime(value) {
  if (typeof value === 'string' && value.length === expected.expectedEscrowRuntimeBytes * 2 + 2
    && /^0x[0-9a-f]+$/i.test(value) && keccak256(value) === expected.expectedEscrowRuntimeKeccak256) return value;
  if (value && typeof value === 'object') for (const item of Object.values(value)) {
    const result = findRuntime(item); if (result) return result;
  }
  return undefined;
}
const runtime = findRuntime(review);
test('accepts the independently simulated exact runtime including constructor immutables', () => {
  assert.ok(runtime); validateRuntime(runtime, expected, keccak256);
});
test('refuses same-length substituted runtime even if an activation record could hash it', () => {
  assert.ok(runtime);
  const changed = '0x00' + runtime.slice(4);
  assert.equal(changed.length, runtime.length);
  assert.notEqual(keccak256(changed), expected.expectedEscrowRuntimeKeccak256);
  assert.throws(() => validateRuntime(changed, expected, keccak256));
});
test('refuses missing and wrong-length runtime', () => {
  assert.throws(() => validateRuntime('0x', expected, keccak256));
  assert.ok(runtime); assert.throws(() => validateRuntime(runtime.slice(0, -2), expected, keccak256));
});
