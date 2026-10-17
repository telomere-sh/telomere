// Read-only deployment guard. No main.ts import, database opening, Docker operation or transaction broadcast.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = '/opt/telomere-mainnet-pilot';
const PRIVATE = BASE + '/private';
const SOCKET = 'unix:///run/telomere-mainnet-docker/docker.sock';
const address = /^0x[0-9a-fA-F]{40}$/;
const hexHash = /^0x[0-9a-fA-F]{64}$/;
const sha = /^[0-9a-f]{64}$/;
const BOOTSTRAP = Object.freeze({ operation: 'telomere-mainnet-prepare-20261015',
  id: 'f1f1fa857fb34ae9adb708ecf6af7166', base: BASE, uid: 995, gid: 993,
  owner: '0xa67c6a174409b9b44e67d24cdd386a31d44edb1d', controllerStarted: false, transactionsSent: 0 });
let phase = 'arguments';
function requireValue(condition) { if (!condition) throw new Error('Preparation guard refused'); }
function object(value) { requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)); return value; }
function same(left, right) { return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase(); }
export function validateBootstrapOwnership(value, reviewed) {
  for (const item of [object(value), object(reviewed)]) {
    requireValue(Object.keys(item).length === Object.keys(BOOTSTRAP).length);
    for (const [key, expected] of Object.entries(BOOTSTRAP)) requireValue(item[key] === expected);
  }
}
export function validateDaemonConfiguration(value) {
  const expected = {
    'data-root': BASE + '/docker-data', 'exec-root': '/run/telomere-mainnet-docker/exec',
    pidfile: '/run/telomere-mainnet-docker/docker.pid', hosts: [SOCKET], group: 'telomere-mainnet',
    'containerd-namespace': 'telomere-mainnet-cpu',
    bridge: 'tlmr-mainnet0', 'fixed-cidr': '172.31.254.0/24',
    iptables: false, ip6tables: false, 'ip-forward': false, 'ip-masq': false, 'live-restore': false,
    'default-runtime': 'runsc', runtimes: { runsc: { path: '/opt/telomere-host-runtime/gvisor/runsc' } },
    'log-driver': 'json-file', 'log-opts': { 'max-size': '10m', 'max-file': '3' },
  };
  function exact(actual, reviewed) {
    if (reviewed !== null && typeof reviewed === 'object') {
      requireValue(actual !== null && typeof actual === 'object' && Array.isArray(actual) === Array.isArray(reviewed));
      requireValue(Object.keys(actual).length === Object.keys(reviewed).length);
      for (const key of Object.keys(reviewed)) { requireValue(Object.hasOwn(actual, key)); exact(actual[key], reviewed[key]); }
    } else requireValue(actual === reviewed);
  }
  exact(value, expected);
}
export function validateLegacyPlan(plan, expected, config, crypto) {
  object(plan); object(plan.transaction); object(plan.reviewedAsset); object(plan.reviewedAsset.implementation);
  requireValue(plan.schemaVersion === 2 && plan.mode === 'unsigned-base-usdc-legacy-escrow' && plan.chainId === 8453
    && same(plan.reviewDigest, expected.deploymentReviewDigest)
    && same(crypto.legacyDeploymentPlanDigest(plan), expected.deploymentReviewDigest)
    && same(plan.creationCodeHash, expected.deploymentCreationCodeHash)
    && typeof plan.transaction.data === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(plan.transaction.data)
    && same(crypto.keccak256(plan.transaction.data), expected.deploymentCreationCodeHash)
    && plan.transaction.to === null && plan.transaction.value === '0'
    && plan.transaction.nonce === expected.deploymentNonce
    && same(plan.transaction.from, expected.deployerAddress)
    && same(plan.predictedEscrowAddress, expected.deploymentEscrowAddress)
    && same(config.ESCROW_ADDRESS, expected.deploymentEscrowAddress)
    && same(crypto.getContractAddress({ from: plan.transaction.from, nonce: BigInt(plan.transaction.nonce) }), expected.deploymentEscrowAddress)
    && same(plan.quoteSigner, expected.operatorAddress) && same(plan.receiptSigner, expected.operatorAddress)
    && same(plan.treasury, expected.treasuryAddress)
    && plan.reviewedAsset.kind === 'circle_proxy' && plan.reviewedAsset.name === 'USD Coin'
    && plan.reviewedAsset.symbol === 'USDC' && plan.reviewedAsset.decimals === 6 && plan.reviewedAsset.version === '2'
    && same(plan.reviewedAsset.address, config.TOKEN_ADDRESS)
    && same(plan.reviewedAsset.proxyCodeHash, config.TOKEN_CODE_HASH)
    && same(plan.reviewedAsset.implementation.address, config.TOKEN_IMPLEMENTATION_ADDRESS)
    && same(plan.reviewedAsset.implementation.codeHash, config.TOKEN_IMPLEMENTATION_CODE_HASH));
}
export function validateDeploymentTransaction(transaction, receipt, plan, expected, hash) {
  requireValue(same(transaction.hash, hash) && same(receipt.transactionHash, hash)
    && same(transaction.from, expected.deployerAddress) && transaction.to === null && transaction.value === 0n
    && transaction.nonce === expected.deploymentNonce && same(transaction.input, plan.transaction.data)
    && receipt.status === 'success' && receipt.to === null && same(receipt.from, expected.deployerAddress)
    && same(receipt.contractAddress, expected.deploymentEscrowAddress)
    && transaction.blockNumber === receipt.blockNumber && same(transaction.blockHash, receipt.blockHash));
}
export function validateFinalizedDeployment(receipt, canonicalDeployment, finalized, canonicalFinalized) {
  requireValue(typeof receipt.blockNumber === 'bigint' && canonicalDeployment.number === receipt.blockNumber && same(canonicalDeployment.hash, receipt.blockHash)
    && typeof finalized.number === 'bigint' && finalized.number >= receipt.blockNumber
    && canonicalFinalized.number === finalized.number && same(canonicalFinalized.hash, finalized.hash));
}
export function validateRuntime(code, expected, keccak256) {
  requireValue(typeof code === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(code)
    && (code.length - 2) / 2 === expected.expectedEscrowRuntimeBytes
    && same(keccak256(code), expected.expectedEscrowRuntimeKeccak256));
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function protectedFile(path, maximum = 262144) {
  const metadata = await lstat(path);
  requireValue(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && metadata.uid === 0
    && [0o600, 0o640].includes(metadata.mode & 0o777) && metadata.size > 0 && metadata.size <= maximum
    && await realpath(path) === path);
  return readFile(path, 'utf8');
}
async function rootOwned(path) {
  const metadata = await lstat(path);
  requireValue(metadata.uid === 0 && (metadata.mode & 0o022) === 0 && !metadata.isSymbolicLink());
  return metadata;
}
async function absent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (error && error.code === 'ENOENT') return true; throw error; }
}

async function main() {
try {
  requireValue(process.platform === 'linux' && process.argv.length === 3
    && ['--configuration-only', '--verify-activation'].includes(process.argv[2]));
  const activationRequired = process.argv[2] === '--verify-activation';
  phase = 'manifest';
  const expected = object(JSON.parse(await protectedFile(PRIVATE + '/expected.json')));
  requireValue(expected.schemaVersion === 2 && /^[0-9a-f]{40}$/.test(expected.sourceCommit)
    && /^[0-9a-f]{40}$/.test(expected.releaseId) && sha.test(expected.sourceSnapshotSha256)
    && expected.walletAccess === 'public'
    && expected.releaseDirectory === BASE + '/releases/' + expected.releaseId
    && expected.nodeBinary === '/opt/node-v22.23.3-linux-x64/bin/node' && sha.test(expected.nodeSha256)
    && expected.runtimeUid === 995 && expected.runtimeGid === 993
    && address.test(expected.operatorAddress) && address.test(expected.deployerAddress) && address.test(expected.treasuryAddress)
    && Array.isArray(expected.allowedOwners) && expected.allowedOwners.length > 0
    && expected.allowedOwners.every(value => typeof value === 'string' && address.test(value))
    && Array.isArray(expected.forbiddenSignerAddresses) && expected.forbiddenSignerAddresses.length > 0
    && expected.forbiddenSignerAddresses.every(value => typeof value === 'string' && address.test(value))
    && sha.test(expected.profileSha256) && sha.test(expected.dockerConfigurationSha256)
    && sha.test(expected.networkGuardSha256) && sha.test(expected.networkUnitSha256) && sha.test(expected.dockerUnitSha256)
    && expected.deploymentPlanPath === PRIVATE + '/deployment-plan-base-mainnet.json'
    && sha.test(expected.deploymentPlanSha256) && hexHash.test(expected.deploymentReviewDigest)
    && hexHash.test(expected.deploymentCreationCodeHash) && Number.isSafeInteger(expected.deploymentNonce) && expected.deploymentNonce >= 0
    && address.test(expected.deploymentEscrowAddress) && expected.expectedEscrowRuntimeBytes === 12573
    && same(expected.expectedEscrowRuntimeKeccak256, '0xd2ce03e0de4dc334d671294ae5f900eee12ff05cebc6f6484455103f0b204ed5'));
  phase = 'ownership';
  validateBootstrapOwnership(JSON.parse(await protectedFile(PRIVATE + '/ownership.json', 8192)), expected.bootstrapOwnership);
  phase = 'docker_isolation';
  const dockerConfiguration = await protectedFile(PRIVATE + '/docker-daemon.json', 8192);
  requireValue(createHash('sha256').update(dockerConfiguration).digest('hex') === expected.dockerConfigurationSha256);
  validateDaemonConfiguration(JSON.parse(dockerConfiguration));
  for (const [path, digest] of [[BASE + '/operator/prepare-network.py', expected.networkGuardSha256],
    ['/etc/systemd/system/telomere-mainnet-network.service', expected.networkUnitSha256],
    ['/etc/systemd/system/telomere-mainnet-docker.service', expected.dockerUnitSha256]]) {
    requireValue((await rootOwned(path)).isFile() && await realpath(path) === path && await hashFile(path) === digest);
  }
  phase = 'ownership';
  requireValue(process.getuid() === 0 || process.getuid() === expected.runtimeUid);
  requireValue(await realpath(process.execPath) === expected.nodeBinary && await hashFile(process.execPath) === expected.nodeSha256);
  for (const path of [BASE, PRIVATE, BASE + '/releases', expected.releaseDirectory]) await rootOwned(path);
  requireValue(await realpath(expected.releaseDirectory) === expected.releaseDirectory);
  // The app alias is root-controlled; the controller cannot switch its own release.
  const alias = await lstat(BASE + '/app');
  requireValue(alias.isSymbolicLink() && alias.uid === 0 && await realpath(BASE + '/app') === expected.releaseDirectory);
  requireValue(await absent(expected.releaseDirectory + '/.env'));
  const mandatoryPins = new Set(['dist/src/main.js', 'dist/src/config.js', 'dist/src/bridge.js',
    'dist/src/runtime/docker.js', 'dist/src/runtime/command.js', 'dist/src/operator/profile.js',
    'dist/src/chain/abi.js', 'dist/scripts/deployment-approval.js', 'node_modules/viem/_esm/index.js',
    'dist/website/index.html', 'dist/website/page.html', 'package.json', 'package-lock.json']);
  requireValue(Array.isArray(expected.runtimePins) && expected.runtimePins.length >= mandatoryPins.size && expected.runtimePins.length <= 4096);
  const seen = new Set();
  for (const raw of expected.runtimePins) {
    const pin = object(raw);
    requireValue(typeof pin.path === 'string' && pin.path.length < 1024 && !pin.path.split('/').some(part => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part))
      && sha.test(pin.sha256) && !seen.has(pin.path));
    seen.add(pin.path);
    const location = resolve(expected.releaseDirectory, pin.path);
    requireValue(location.startsWith(expected.releaseDirectory + sep) && await realpath(location) === location);
    requireValue((await rootOwned(location)).isFile() && await hashFile(location) === pin.sha256);
  }
  requireValue([...mandatoryPins].every(path => seen.has(path)));
  requireValue(await hashFile(expected.releaseDirectory + '/source-snapshot.json') === expected.sourceSnapshotSha256);
  phase = 'configuration';
  const profileText = await protectedFile(PRIVATE + '/mainnet.env', 65536);
  requireValue(createHash('sha256').update(profileText).digest('hex') === expected.profileSha256);
  const { parseProfile } = await import(pathToFileURL(join(expected.releaseDirectory, 'dist/src/operator/profile.js')).href);
  const { loadConfig } = await import(pathToFileURL(join(expected.releaseDirectory, 'dist/src/config.js')).href);
  const { ChainBridge } = await import(pathToFileURL(join(expected.releaseDirectory, 'dist/src/bridge.js')).href);
  const raw = parseProfile(profileText), config = loadConfig(raw);
  phase = 'unsigned_plan';
  const planText = await protectedFile(expected.deploymentPlanPath, 65536);
  requireValue(createHash('sha256').update(planText).digest('hex') === expected.deploymentPlanSha256);
  const plan = object(JSON.parse(planText));
  const { legacyDeploymentPlanDigest } = await import(pathToFileURL(join(expected.releaseDirectory, 'dist/scripts/deployment-approval.js')).href);
  const { keccak256, getContractAddress } = await import(pathToFileURL(join(expected.releaseDirectory, 'node_modules/viem/_esm/index.js')).href);
  validateLegacyPlan(plan, expected, config, { legacyDeploymentPlanDigest, keccak256, getContractAddress });
  phase = 'configuration';
  const bridge = new ChainBridge(config);
  requireValue(config.WALLET_ACCESS === expected.walletAccess && config.TRUST_LOOPBACK_PROXY === true
    && config.CYSTS_GLOBAL_BYTES === 1073741824
    && config.MODE === 'mainnet' && config.CHAIN_ID === 8453 && config.HOST === '127.0.0.1' && config.PORT === 3282
    && config.PUBLIC_ORIGIN === expected.publicOrigin && config.CPU_MODE === 'docker' && config.AGENT_RUNTIME === 'legacy'
    && config.CYSTS_ENABLED && config.CYSTS_DIR === BASE + '/data/cysts' && config.DATA_DIR === BASE + '/data/controller'
    && !config.SELECTION_ENABLED && !config.PAID_CYST_INPUTS_ENABLED && config.INFERENCE_FIXED_PRICE === '0'
    && raw.DOCKER_HOST === SOCKET && !raw.DOCKER_CONTEXT && !raw.DOCKER_TLS_VERIFY && !raw.DOCKER_CERT_PATH
    && same(bridge.account.address, expected.operatorAddress)
    && !expected.forbiddenSignerAddresses.some(value => same(value, bridge.account.address))
    && !expected.allowedOwners.some(value => same(value, bridge.account.address)));
  const forbidden = ['DEMO_PRIVATE_KEY', 'DEPLOYER_PRIVATE_KEY', 'PLATFORM_RUNTIME_CONFIG', 'CYST_REGISTRY_CONFIG',
    'CYSTS_REPLICATION_CONFIG', 'CYSTS_LARGE_DIR', 'CYSTS_QUOTA_POLICY_PATH', 'CYSTS_QUOTA_POLICY_SHA256',
    'INCOME_ENDPOINTS_CONFIG', 'AKASH_READINESS_CONFIG', 'VAULT_INCOME_CONFIG', 'TREASURY_TOPUP_CONFIG',
    'TREASURY_TOPUP_CONFIG_SHA256', 'REPUTATION_PUBLISHER_CONFIG', 'NEAR_ENDPOINT', 'NEAR_API_KEY', 'NEAR_MODEL', 'NEAR_ALLOWED_MODELS'];
  requireValue(forbidden.every(key => !raw[key]));
  const owners = config.PILOT_ALLOWED_OWNERS.split(',').map(value => value.trim().toLowerCase()).sort();
  requireValue(JSON.stringify(owners) === JSON.stringify(expected.allowedOwners.map(value => value.toLowerCase()).sort()));
  const database = new URL(config.DATABASE_URL);
  requireValue(database.protocol === 'postgresql:' && database.hostname === '127.0.0.1' && database.port === '15435'
    && database.username === 'telomere_mainnet' && database.pathname === '/telomere_mainnet' && database.password.length >= 32);
  for (const path of [BASE + '/data/cysts', BASE + '/data/controller']) {
    const metadata = await lstat(path);
    requireValue(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === expected.runtimeUid
      && metadata.gid === expected.runtimeGid && (metadata.mode & 0o777) === 0o700 && await realpath(path) === path);
  }
  if (!activationRequired) {
    process.stdout.write(JSON.stringify({ readOnly: true, configurationValid: true, chainId: 8453,
      operator: bridge.account.address, verifiedRuntimePins: seen.size, unsignedPlanBound: true,
      bootstrapOwnershipVerified: true, dockerIsolationVerified: true, controllerStarted: false, onChainCalls: false }) + '\n');
  } else {
    phase = 'activation';
    requireValue(process.env.DOCKER_HOST === SOCKET && !process.env.DOCKER_CONTEXT && !process.env.DEPLOYER_PRIVATE_KEY && !process.env.DEMO_PRIVATE_KEY);
    for (const key of Object.keys(raw)) requireValue(process.env[key] === raw[key]);
    const activation = object(JSON.parse(await protectedFile(PRIVATE + '/activation.json', 8192)));
    requireValue(activation.releaseId === expected.releaseId && activation.publicWalletAccessAuthorized === true
      && activation.ownerReviewed === true && activation.chainId === 8453 && activation.sourceCommit === expected.sourceCommit
      && same(activation.reviewDigest, expected.deploymentReviewDigest) && same(activation.escrowAddress, config.ESCROW_ADDRESS)
      && same(activation.operatorAddress, bridge.account.address) && same(activation.tokenAddress, config.TOKEN_ADDRESS)
      && activation.profileSha256 === expected.profileSha256 && hexHash.test(activation.deploymentTransactionHash)
      && /^(0|[1-9][0-9]*)$/.test(activation.deploymentBlockNumber) && hexHash.test(activation.deploymentBlockHash)
      && same(activation.escrowRuntimeKeccak256, expected.expectedEscrowRuntimeKeccak256));
    // These RPC calls only observe canonical chain state and deployed roles. They cannot sign or send transactions.
    await bridge.check();
    const receipt = await bridge.public.getTransactionReceipt({ hash: activation.deploymentTransactionHash });
    const transaction = await bridge.public.getTransaction({ hash: activation.deploymentTransactionHash });
    validateDeploymentTransaction(transaction, receipt, plan, expected, activation.deploymentTransactionHash);
    requireValue(receipt.blockNumber === BigInt(activation.deploymentBlockNumber)
      && same(receipt.blockHash, activation.deploymentBlockHash));
    const deploymentBlock = await bridge.public.getBlock({ blockNumber: receipt.blockNumber });
    const finalized = await bridge.public.getBlock({ blockTag: 'finalized' });
    const canonicalFinalized = await bridge.public.getBlock({ blockNumber: finalized.number });
    validateFinalizedDeployment(receipt, deploymentBlock, finalized, canonicalFinalized);
    const latest = await bridge.public.getBlock({ blockTag: 'latest' });
    for (const block of [deploymentBlock, latest]) {
      const code = await bridge.public.getCode({ address: config.ESCROW_ADDRESS, blockHash: block.hash, requireCanonical: true });
      validateRuntime(code, expected, keccak256);
    }
    const { escrowAbi } = await import(pathToFileURL(join(expected.releaseDirectory, 'dist/src/chain/abi.js')).href);
    requireValue(same(await bridge.public.readContract({ address: config.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'treasury',
      blockHash: latest.hash, requireCanonical: true }), expected.treasuryAddress));
    requireValue(same((await bridge.public.getBlock({ blockNumber: latest.number })).hash, latest.hash));
    const socket = await stat('/run/telomere-mainnet-docker/docker.sock');
    requireValue(socket.isSocket() && socket.uid === 0 && socket.gid === expected.runtimeGid && (socket.mode & 0o007) === 0);
    process.stdout.write(JSON.stringify({ readOnly: true, activationVerified: true, finalizedDeployment: true,
      exactCreationTransaction: true, runtimeMatchesIndependentExpectation: true, chainId: 8453,
      controllerStarted: false, broadcast: false }) + '\n');
  }
} catch {
  // Never print private profile values, RPC URLs, provider errors, database credentials or signing material.
  process.stderr.write(JSON.stringify({ readOnly: true, status: 'preflight_refused', phase, controllerStarted: false }) + '\n');
  process.exitCode = 1;
}
}
// Resolve the entry path so an operator-owned symlink cannot accidentally turn an invoked guard into a successful no-op.
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) await main();
