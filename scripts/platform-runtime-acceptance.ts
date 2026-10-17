import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestClient, createWalletClient, encodeAbiParameters, getContractAddress, http, keccak256, parseAbi, parseEther,
  type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileContracts } from './compile-contracts.js';
import { startLocalChain, unusedLocalPort, type LocalChain } from './local-chain.js';
import { loadConfig } from '../src/config.js';
import { startPilot } from '../src/main.js';
import { localChain } from '../src/chain/chains.js';
import { hashJson, randomId, sameAddress } from '../src/common.js';
import { TelomereClient } from '../src/sdk/client.js';
import { PlatformRuntimeClient, type PlatformRuntimeRun } from '../src/platform-runtime/client.js';
import { platformHostLeases, platformRuns, platformTransactionJournal } from '../src/platform-runtime/schema.js';
import { PLATFORM_ZERO, platformEscrowAbi, platformHostRegistryAbi, platformHostSchema, type PlatformPins, type PlatformTask } from '../src/platform-runtime/types.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { Ed25519Identity, hostMessageHash, verifyHostMessage } from '../src/host-kit/protocol.js';
import { HostMeterVerifier } from '../src/host-kit/meter.js';
import { validateCpuResult } from '../src/runtime/validation.js';
import { PlatformReceiptService, platformReceiptRootAbi } from '../src/receipts/platform-service.js';
import { platformFinancialLeaf } from '../src/receipts/platform-merkle.js';
import { controllerHostRuns } from '../src/host-kit/controller-schema.js';

const HOST_URL = 'http://127.0.0.1:13290';
const HOST_KEY = '0xe11487bd43e613c421f7eaffcb79d97cd8b507f9b16f33d36bcadeebbbc3874c' as Hex;
const IMAGE = '127.0.0.1:15002/telomere-cpu@sha256:6839949540d11906cbdbc614867ac3a825fa0e6f8cbed90c79773979517b4bbe';
const CONTROL_PEM = '/opt/telomere-host-runtime/control.pem';
const DEPOSIT = 1_000_000n, COLLATERAL = 300_000_000n, MAX_SECONDS = 30, PRICE = 100n;
const TASK = { kind: 'hash_chain' as const, text: 'platform-runtime-gvisor-full-financial-proof', iterations: 2_000_000 };
const EXEC_MARKER = 'Telomere проверка 🧬';
const EXEC_STDIN = JSON.stringify({ task: TASK, marker: EXEC_MARKER });
const EXEC_ARGV = ['/usr/local/bin/node', '-e',
  'const fs=require("node:fs"),crypto=require("node:crypto");'
  + 'const {task,marker}=JSON.parse(fs.readFileSync(0,"utf8"));'
  + 'if(task.kind!=="hash_chain"||typeof task.text!=="string"||task.iterations!==2000000||typeof marker!=="string")process.exit(2);'
  + 'let hash=crypto.createHash("sha256").update(task.text).digest();'
  + 'for(let index=1;index<task.iterations;index++)hash=crypto.createHash("sha256").update(hash).digest();'
  + 'process.stdout.write(JSON.stringify({hash:hash.toString("hex"),iterations:task.iterations,marker}));'];
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)']);
const routerAbi = parseAbi(['struct Buckets { uint256 work; uint256 treasury; uint256 stakers; uint256 buyAndBurn; }',
  'function getBuckets(uint64 week) view returns (Buckets)', 'function hostAccrued(uint64 week,address host) view returns (uint256)',
  'function accountedBalance() view returns (uint256)', 'function settledReceipt(bytes32) view returns (bool)']);

class AcceptanceFailure extends Error { constructor(readonly code: string) { super(code); } }
function check(value: unknown, code: string): asserts value { if (!value) throw new AcceptanceFailure(code); }
const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

/** Linux-only driver; importing it does not execute an acceptance or contact the reviewed host. */
export async function platformRuntimeAcceptance(options: { mode?: 'fixed' | 'exec' } = {}): Promise<Record<string, unknown>> {
  const mode = options.mode ?? 'fixed';
  if (mode !== 'fixed' && mode !== 'exec') return { status: 'failed', stage: 'preflight', code: 'acceptance_arguments_invalid',
    publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false };
  const task: PlatformTask = mode === 'exec'
    ? { kind: 'exec', imageDigest: IMAGE.slice(IMAGE.indexOf('@') + 1), argv: EXEC_ARGV, stdin: EXEC_STDIN } : TASK;
  let stage = 'preflight', work: string | undefined, chain: LocalChain | undefined;
  let pilot: Awaited<ReturnType<typeof startPilot>> | undefined, report: Record<string, unknown> | undefined;
  let cleanupConfirmed = true;
  const previousMask = process.umask(0o077);
  try {
    check(process.platform === 'linux', 'linux_gvisor_required');
    check(process.env.HOST_KIT_URL === undefined || process.env.HOST_KIT_URL === HOST_URL, 'host_origin_pin_mismatch');
    check(process.env.HOST_KIT_HOST_KEY === undefined || process.env.HOST_KIT_HOST_KEY === HOST_KEY, 'host_identity_pin_mismatch');
    check(process.env.HOST_KIT_TASK_IMAGE === undefined || process.env.HOST_KIT_TASK_IMAGE === IMAGE, 'image_pin_mismatch');
    check(process.env.HOST_KIT_CONTROL_PEM === undefined || process.env.HOST_KIT_CONTROL_PEM === CONTROL_PEM, 'control_file_pin_mismatch');
    const controlStat = await lstat(CONTROL_PEM);
    check(controlStat.isFile() && !controlStat.isSymbolicLink() && controlStat.nlink === 1 && controlStat.size > 0
      && controlStat.size <= 1024 && (controlStat.mode & 0o077) === 0, 'control_file_permissions');
    const control = new Ed25519Identity(await readFile(CONTROL_PEM, 'utf8'));
    const hostClient = new HostKitClient(HOST_URL, HOST_KEY, control);
    work = await mkdtemp('/opt/telomere-host-runtime/platform-runtime-'); await chmod(work, 0o700);
    stage = 'disposable_chain_deploy'; chain = await startLocalChain();
    check(new URL(chain.rpcUrl).hostname === '127.0.0.1' && await chain.publicClient.getChainId() === 31337, 'disposable_chain_pin');
    const local = chain, artifacts = compileContracts(['MockToken.sol', 'TelomereRunEscrow.sol', 'PlatformRunEscrow.sol',
      'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol']);
    const keys = { owner: generatePrivateKey(), legacy: generatePrivateKey(), platform: generatePrivateKey(), host: generatePrivateKey() };
    const accounts = { owner: privateKeyToAccount(keys.owner), legacy: privateKeyToAccount(keys.legacy),
      platform: privateKeyToAccount(keys.platform), host: privateKeyToAccount(keys.host) };
    const transport = http(local.rpcUrl, { retryCount: 0 }), test = createTestClient({ chain: localChain, mode: 'anvil', transport });
    for (const account of Object.values(accounts)) await test.setBalance({ address: account.address, value: parseEther('10') });
    const owner = createWalletClient({ account: accounts.owner, chain: localChain, transport });
    const hostWallet = createWalletClient({ account: accounts.host, chain: localChain, transport });
    function artifact(name: string) { const value = artifacts[name]; check(value, 'contract_artifact_missing'); return value; }
    async function confirmed(pending: Promise<Hex>) {
      const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await pending, timeout: 15_000 });
      check(receipt.status === 'success', 'disposable_transaction_reverted'); return receipt;
    }
    async function deploy(name: string, args: readonly unknown[] = []): Promise<Address> {
      const value = artifact(name), receipt = await confirmed(owner.deployContract({ abi: value.abi, bytecode: value.bytecode, args }));
      check(receipt.contractAddress, 'deployment_address_missing'); return receipt.contractAddress;
    }
    const tokenAddress = await deploy('MockToken');
    const legacyEscrow = await deploy('TelomereRunEscrow', [tokenAddress, accounts.legacy.address, accounts.legacy.address, accounts.owner.address]);
    const signerSet = await deploy('SignerSet', [accounts.owner.address, accounts.platform.address]);
    // An hour boundary can cross a Unix week. Both possible publication weeks have an explicit signer.
    const currentWeek = (await local.publicClient.getBlock()).timestamp / 604800n;
    await confirmed(owner.writeContract({ address: signerSet, abi: artifact('SignerSet').abi, functionName: 'scheduleSigner',
      args: [currentWeek + 1n, accounts.platform.address] }));
    const receiptRootAddress = await deploy('ReceiptRoot', [signerSet]);
    const nonce = await local.publicClient.getTransactionCount({ address: accounts.owner.address });
    const expectedEscrow = getContractAddress({ from: accounts.owner.address, nonce: BigInt(nonce + 2) });
    const hostRegistryAddress = await deploy('HostRegistry', [tokenAddress, expectedEscrow, accounts.owner.address, accounts.owner.address, receiptRootAddress]);
    const feeRouterAddress = await deploy('FeeRouter', [tokenAddress, expectedEscrow, accounts.owner.address,
      accounts.owner.address, accounts.owner.address, accounts.owner.address]);
    const escrowAddress = await deploy('PlatformRunEscrow', [{ token: tokenAddress, quoteSigner: accounts.platform.address,
      receiptRoot: receiptRootAddress, hostRegistry: hostRegistryAddress, feeRouter: feeRouterAddress, guardian: accounts.owner.address }]);
    check(sameAddress(escrowAddress, expectedEscrow) && !sameAddress(legacyEscrow, escrowAddress)
      && !sameAddress(accounts.legacy.address, accounts.platform.address), 'dedicated_platform_relationships');
    const mock = artifact('MockToken').abi, escrow = artifact('PlatformRunEscrow').abi;
    await confirmed(owner.writeContract({ address: tokenAddress, abi: mock, functionName: 'faucet', args: [accounts.host.address, COLLATERAL] }));
    await confirmed(hostWallet.writeContract({ address: tokenAddress, abi: mock, functionName: 'approve', args: [hostRegistryAddress, COLLATERAL] }));
    await confirmed(hostWallet.writeContract({ address: hostRegistryAddress, abi: artifact('HostRegistry').abi, functionName: 'register',
      args: [HOST_KEY, 0, PLATFORM_ZERO, COLLATERAL, false] }));
    const hostId = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
      [31337n, hostRegistryAddress, accounts.host.address, HOST_KEY]));
    await confirmed(owner.writeContract({ address: tokenAddress, abi: mock, functionName: 'faucet', args: [accounts.owner.address, DEPOSIT] }));
    await confirmed(owner.writeContract({ address: tokenAddress, abi: mock, functionName: 'approve', args: [escrowAddress, DEPOSIT] }));
    await confirmed(owner.writeContract({ address: escrowAddress, abi: escrow, functionName: 'deposit', args: [DEPOSIT] }));
    const leashId = randomId();
    await confirmed(owner.writeContract({ address: escrowAddress, abi: escrow, functionName: 'createLeash', args: [leashId,
      { agent: accounts.owner.address, maxPerHour: 100_000n, maxPerDay: DEPOSIT, classMask: 1n, sealedOnly: false,
        imageAllowRoot: PLATFORM_ZERO, regionAllowRoot: PLATFORM_ZERO, expiry: (await local.publicClient.getBlock()).timestamp + 86_400n }] }));
    async function codeHash(address: Address) { const code = await local.publicClient.getCode({ address }); check(code && code !== '0x', 'runtime_code_missing'); return keccak256(code); }
    const pins: PlatformPins = { chainId: 31337, escrowAddress, tokenAddress, tokenCodeHash: await codeHash(tokenAddress),
      reviewedTokenKind: 'immutable', quoteSigner: accounts.platform.address,
      receiptRootAddress, hostRegistryAddress, feeRouterAddress, escrowCodeHash: await codeHash(escrowAddress),
      receiptRootCodeHash: await codeHash(receiptRootAddress), hostRegistryCodeHash: await codeHash(hostRegistryAddress), feeRouterCodeHash: await codeHash(feeRouterAddress) };
    const signerKeyFile = join(work, 'platform-signer.key'), runtimePath = join(work, 'platform-runtime.json'), pilotPath = join(work, 'pilot.json');
    await writeFile(signerKeyFile, keys.platform + '\n', { mode: 0o600, flag: 'wx' });
    const reviewedHost = platformHostSchema.parse({ hostId, hostKey: HOST_KEY, hardwareClass: 'cpu', region: 'vps-local',
      image: IMAGE, imageDigest: IMAGE.split('@')[1], sealed: false, lane: 'standard', pricePerSecond: PRICE.toString(),
      ...(mode === 'exec' ? { execEnabled: true } : {}),
      reliabilityBps: 10000, strikes: 0, stake: COLLATERAL.toString(), availableAt: 0 });
    await writeFile(runtimePath, JSON.stringify({ pins, signerKeyFile, hosts: [{ ...reviewedHost, url: HOST_URL, controlPemFile: CONTROL_PEM }] }), { mode: 0o600, flag: 'wx' });
    const port = await unusedLocalPort(), origin = 'http://127.0.0.1:' + port;
    // Do not inherit DATABASE_URL, NEAR credentials, legacy Host Kit scheduling or other operator services.
    const isolatedEnv: NodeJS.ProcessEnv = { MODE: 'demo', PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: origin,
      RPC_URL: local.rpcUrl, CHAIN_ID: '31337', DATA_DIR: join(work, 'db'), ESCROW_ADDRESS: legacyEscrow, TOKEN_ADDRESS: tokenAddress,
      SIGNER_PRIVATE_KEY: keys.legacy, DEMO_PRIVATE_KEY: keys.owner, CPU_MODE: 'demo', PLATFORM_RUNTIME_CONFIG: runtimePath,
      CYSTS_ENABLED: 'false', SELECTION_ENABLED: 'false', LOG_LEVEL: 'error' };
    await writeFile(pilotPath, JSON.stringify(isolatedEnv), { mode: 0o600, flag: 'wx' });
    const originalPilotConfig = await readFile(pilotPath, 'utf8'), originalRuntimeConfig = await readFile(runtimePath, 'utf8');
    const config = loadConfig(isolatedEnv);
    stage = 'start_pilot_http_auth'; pilot = await startPilot(config);
    check(pilot.platformRuntime, 'configured_platform_missing');
    async function client() {
      let sessionToken: string | undefined;
      const auth = new TelomereClient({ baseUrl: origin,
        pins: { chainId: 31337, escrowAddress: legacyEscrow, tokenAddress, receiptSigner: accounts.legacy.address },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          const cookie = response.headers.get('set-cookie')?.match(/(?:^|,\s*)telomere_session=([a-f0-9]{64})(?:;|$)/);
          if (cookie?.[1]) sessionToken = cookie[1]; return response;
        } });
      const authenticated = await auth.authenticateDemo({ explicitlyEnabled: true });
      check(sameAddress(authenticated.address, accounts.owner.address) && sessionToken, 'http_owner_session_missing');
      return new PlatformRuntimeClient({ baseUrl: origin, pins, sessionToken });
    }
    let sdk = await client(); await sdk.config();
    check((await sdk.balance()).available === DEPOSIT.toString(), 'initial_http_balance');
    stage = 'quote_open_admit';
    const quote = await sdk.quote({ leashId, task, maxSeconds: MAX_SECONDS,
      deadline: Number((await local.publicClient.getBlock()).timestamp) + 90, maxSpend: '3270', regions: ['vps-local'] }, 'gvisor_platform_quote_001');
    check(quote.ceiling === '3270', 'fee_inclusive_quote_ceiling');
    check(quote.quote.workloadHash === hashJson({ task }), 'signed_workload_hash_mismatch');
    const plan = await sdk.openPlan(quote), opened = await confirmed(owner.sendTransaction({ to: plan.to, data: plan.data as Hex, value: 0n }));
    check((await pilot.platformRuntime.bridge.host(hostId)).openRuns === 1n, 'host_open_hook_not_atomic');
    await sdk.admit({ runId: quote.quote.runId, transactionHash: opened.transactionHash }, 'gvisor_platform_admit_001');
    stage = 'original_gvisor_outcome';
    let outcome: PlatformRuntimeRun = await sdk.get(quote.quote.runId), until = Date.now() + 60_000;
    while (!(outcome.result && outcome.settlement) && Date.now() < until) { await pause(1000); outcome = await sdk.get(quote.quote.runId); }
    check(outcome.result && outcome.settlement && outcome.status === 'receipt_pending', 'original_outcome_unavailable');
    const cpu = validateCpuResult(outcome.result, outcome.id, MAX_SECONDS);
    check(cpu.status === 'completed' && cpu.exitCode === 0 && outcome.settlement.billableSeconds > 0, 'positive_completed_cpu_required');
    const leaseRows = await pilot.service.db.select().from(platformHostLeases), evidence = leaseRows[0];
    check(leaseRows.length === 1 && evidence && evidence.runId === outcome.id && evidence.cleanupConfirmed === 1
      && evidence.ticks.length > 0 && evidence.ticks.length === evidence.acknowledgments.length, 'durable_original_host_evidence');
    check(verifyHostMessage(control.publicKey, 'lease', evidence.lease) && evidence.owner === accounts.owner.address.toLowerCase()
      && evidence.lease.body.owner === evidence.owner && evidence.lease.body.hostKey === HOST_KEY && evidence.lease.body.image === IMAGE
      && evidence.lease.body.runId === outcome.id && evidence.lease.body.stdin === (mode === 'exec' ? EXEC_STDIN : JSON.stringify(TASK)), 'original_lease_scope_invalid');
    if (mode === 'exec') check(JSON.stringify(evidence.lease.body.argv) === JSON.stringify(EXEC_ARGV)
      && evidence.lease.body.maxSeconds === MAX_SECONDS, 'original_command_argv_or_duration_changed');
    const hostState = await hostClient.command(evidence.lease, 'status');
    check(hostState.isolation === 'gvisor' && hostState.state === 'completed' && hostState.cleanupConfirmed
      && hostState.output === cpu.output && hostState.exitCode === 0 && hostState.billableSeconds === cpu.billableSeconds,
    'signed_gvisor_terminal_status');
    let replayTime = evidence.lease.body.issuedAt;
    const meter = new HostMeterVerifier(evidence.lease.body, control, () => replayTime);
    for (let index = 0; index < evidence.ticks.length; index++) {
      const tick = evidence.ticks[index], ack = evidence.acknowledgments[index];
      check(tick && ack && verifyHostMessage(HOST_KEY, 'tick', tick) && verifyHostMessage(control.publicKey, 'ack', ack), 'signed_tick_ack_invalid');
      replayTime = ack.body.acceptedAt;
      check(hostMessageHash(meter.accept(tick)) === hostMessageHash(ack)
        && hostState.ticks.some(value => hostMessageHash(value) === hostMessageHash(tick))
        && hostState.acks.some(value => hostMessageHash(value) === hostMessageHash(ack)), 'original_meter_replay_invalid');
    }
    check(meter.billableSeconds === cpu.billableSeconds && outcome.settlement.billableSeconds <= meter.billableSeconds, 'meter_financial_conservation');
    // An independent calculation verifies the original task output, after the host has finished.
    let expectedHash = createHash('sha256').update(TASK.text).digest();
    for (let index = 1; index < TASK.iterations; index++) expectedHash = createHash('sha256').update(expectedHash).digest();
    check(cpu.output === JSON.stringify({ hash: expectedHash.toString('hex'), iterations: TASK.iterations,
      ...(mode === 'exec' ? { marker: EXEC_MARKER } : {}) }), 'original_cpu_output_mismatch');
    stage = 'closed_hour_actual_root_settlement';
    const receiptHour = Math.floor(outcome.settlement.endedAt / 3600), current = (await local.publicClient.getBlock()).timestamp;
    const closedAt = BigInt((receiptHour + 1) * 3600 + 1);
    await test.setNextBlockTimestamp({ timestamp: closedAt > current ? closedAt : current + 1n }); await test.mine({ blocks: 1 });
    until = Date.now() + 35_000;
    let completed = await sdk.get(outcome.id);
    while (completed.status !== 'completed' && Date.now() < until) { await pause(1000); completed = await sdk.get(outcome.id); }
    check(completed.status === 'completed' && completed.settlement && completed.settlementTx && completed.charged && completed.refund, 'canonical_settlement_missing');
    check(JSON.stringify(completed.settlement) === JSON.stringify(outcome.settlement), 'original_settlement_changed');
    const receiptReader = new PlatformReceiptService(pilot.service.db, { chainId: 31337, escrowAddress, receiptRootAddress,
      publicClient: local.publicClient, submitTransaction: async () => { throw new AcceptanceFailure('readonly_proof_attempted_publication'); } });
    const proof = await receiptReader.proof(accounts.owner.address, completed.id); check(proof, 'published_financial_proof_missing');
    const actualRun = await pilot.platformRuntime.bridge.run(completed.id);
    check(proof.hour === receiptHour && proof.leaf === platformFinancialLeaf(31337, escrowAddress, actualRun, completed.settlement), 'financial_leaf_mismatch');
    check(await local.publicClient.readContract({ address: receiptRootAddress, abi: artifact('ReceiptRoot').abi, functionName: 'verify',
      args: [proof.leaf, proof.proof, BigInt(proof.hour)] }) === true, 'onchain_merkle_proof_invalid');
    const root = await local.publicClient.readContract({ address: receiptRootAddress, abi: platformReceiptRootAbi, functionName: 'getRoot', args: [BigInt(proof.hour)] });
    check(root.root === proof.root && root.count === 1 && sameAddress(root.signer, accounts.platform.address), 'actual_root_commitment_mismatch');
    const financial = await pilot.platformRuntime.bridge.confirmedSettlement(completed.settlement, completed.settlementTx);
    const base = BigInt(completed.settlement.billableSeconds) * PRICE, fee = (base * 900n + 9999n) / 10_000n;
    check(financial.charged === (base + fee).toString() && financial.charged === completed.charged && financial.refund === completed.refund
      && BigInt(completed.charged) + BigInt(completed.refund) === BigInt(quote.ceiling), 'settled_charge_refund_mismatch');
    const balance = await sdk.balance(), canonicalSettlement = await local.publicClient.getTransactionReceipt({ hash: completed.settlementTx });
    const week = (await local.publicClient.getBlock({ blockNumber: canonicalSettlement.blockNumber })).timestamp / 604800n;
    const hostAccrued = await local.publicClient.readContract({ address: feeRouterAddress, abi: routerAbi, functionName: 'hostAccrued', args: [week, accounts.host.address] });
    const buckets = await local.publicClient.readContract({ address: feeRouterAddress, abi: routerAbi, functionName: 'getBuckets', args: [week] });
    check(hostAccrued === base && buckets.treasury === fee * 10n / 100n && buckets.stakers === fee * 5n / 100n
      && buckets.buyAndBurn === fee * 5n / 100n && buckets.work === fee - buckets.treasury - buckets.stakers - buckets.buyAndBurn,
    'actual_fee_buckets_mismatch');
    const tokenBalance = (address: Address) => local.publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: 'balanceOf', args: [address] });
    check(BigInt(balance.available) + base + fee === DEPOSIT && await tokenBalance(escrowAddress) === BigInt(balance.available)
      && await tokenBalance(feeRouterAddress) === base + fee && await tokenBalance(hostRegistryAddress) === COLLATERAL
      && await local.publicClient.readContract({ address: feeRouterAddress, abi: routerAbi, functionName: 'accountedBalance' }) === base + fee
      && await local.publicClient.readContract({ address: feeRouterAddress, abi: routerAbi, functionName: 'settledReceipt', args: [completed.settlement.receiptHash] })
      && await local.publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: 'totalSupply' }) === DEPOSIT + COLLATERAL,
    'actual_token_accounting_mismatch');
    const leash = await local.publicClient.readContract({ address: escrowAddress, abi: platformEscrowAbi, functionName: 'getLeash', args: [leashId] });
    check(actualRun.status === 2 && actualRun.hostReleased && leash.pending === 0n
      && (await local.publicClient.readContract({ address: hostRegistryAddress, abi: platformHostRegistryAbi, functionName: 'getHost', args: [hostId] })).openRuns === 0n,
    'host_close_hook_or_leash_pending');
    const journal = await pilot.service.db.select().from(platformTransactionJournal);
    check(journal.length === 2 && journal.every(row => sameAddress(row.sender, accounts.platform.address))
      && await local.publicClient.getTransactionCount({ address: accounts.legacy.address }) === 0
      && (await pilot.service.db.select().from(controllerHostRuns)).length === 0, 'legacy_path_was_not_idle');
    const snapshot = JSON.stringify(completed), evidenceHash = hostMessageHash(evidence.lease);
    stage = 'same_config_database_restart'; await pilot.close(); pilot = undefined;
    check(await readFile(pilotPath, 'utf8') === originalPilotConfig && await readFile(runtimePath, 'utf8') === originalRuntimeConfig, 'private_configuration_changed');
    pilot = await startPilot(loadConfig(JSON.parse(await readFile(pilotPath, 'utf8')) as NodeJS.ProcessEnv)); sdk = await client();
    // Let the real maintenance loop run after recovery, then query it through the SDK again.
    await pause(2200);
    const recovered = await sdk.get(completed.id), restoredLeases = await pilot.service.db.select().from(platformHostLeases);
    const restoredJournal = await pilot.service.db.select().from(platformTransactionJournal);
    check(JSON.stringify(recovered) === snapshot && (await sdk.balance()).available === balance.available
      && restoredLeases.length === 1 && restoredLeases[0]?.cleanupConfirmed === 1
      && hostMessageHash(restoredLeases[0].lease) === evidenceHash
      && restoredJournal.length === journal.length && restoredJournal.every(row => journal.some(old => old.key === row.key && old.hash === row.hash))
      && (await pilot.service.db.select().from(platformRuns)).length === 1, 'restart_redispatch_or_accounting_change');
    const restoredHost = await hostClient.command(evidence.lease, 'status');
    check(restoredHost.state === 'completed' && restoredHost.cleanupConfirmed && restoredHost.output === cpu.output
      && JSON.stringify(restoredHost.ticks) === JSON.stringify(hostState.ticks) && JSON.stringify(restoredHost.acks) === JSON.stringify(hostState.acks), 'original_host_history_changed');
    report = { status: 'passed', checkedAt: new Date().toISOString(), protocol: 'telomere-platform-v1', chainId: 31337,
      mode, oneShotCommand: mode === 'exec', argvAndStdinBound: mode === 'exec', workloadHashBound: true,
      runId: completed.id, hostId, isolation: 'gvisor', image: IMAGE, sdkOverActualHttp: true, separateLegacySignerIdle: true,
      billableSeconds: completed.settlement.billableSeconds, signedHostTicks: evidence.ticks.length,
      signedControlAcknowledgments: evidence.acknowledgments.length, originalOutputVerified: true,
      reservation: quote.ceiling, hostAmount: base.toString(), platformFee: fee.toString(), charged: completed.charged, refund: completed.refund,
      available: balance.available, feeBuckets: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.toString()])),
      receiptHour: proof.hour, financialLeaf: proof.leaf, root: proof.root, publicationTransaction: proof.transactionHash,
      settlementTransaction: completed.settlementTx, actualFullFinancialMerkleProofVerified: true, atomicHostOpenCloseVerified: true,
      tokenBalancesConserved: true, sameDatabaseAndConfigRestart: true, restartWithoutRedispatch: true,
      publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false };
  } catch (error) {
    report = { status: 'failed', checkedAt: new Date().toISOString(), stage,
      code: error instanceof AcceptanceFailure ? error.code : 'acceptance_dependency_failed',
      publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false };
  } finally {
    try { await pilot?.close(); } catch { cleanupConfirmed = false; }
    try { await chain?.close(); } catch { cleanupConfirmed = false; }
    process.umask(previousMask);
  }
  check(report, 'acceptance_report_missing');
  if (!cleanupConfirmed) report = { status: 'failed', checkedAt: new Date().toISOString(), stage: 'disposable_shutdown',
    code: 'local_process_cleanup_unconfirmed', publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false };
  const finalReport = { ...report, disposableControllerAndChainStopped: cleanupConfirmed };
  if (work) {
    try { await writeFile(join(work, 'acceptance.json'), JSON.stringify(finalReport, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
    catch { return { status: 'failed', stage: 'private_report_write', code: 'private_report_write_failed', privateKeysIncluded: false,
      disposableControllerAndChainStopped: cleanupConfirmed, publicTransactions: 0, paidProviderRequests: 0 }; }
  }
  return finalReport;
}

// No raw errors, PEM, private keys, session cookies, signed transaction bytes or database rows in stdout.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const evidence = args.length === 0 ? await platformRuntimeAcceptance()
    : args.length === 1 && args[0] === '--exec' ? await platformRuntimeAcceptance({ mode: 'exec' })
    : { status: 'failed', stage: 'preflight', code: 'acceptance_arguments_invalid',
      publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false };
  process.stdout.write(JSON.stringify(evidence) + '\n');
  if (evidence.status !== 'passed') process.exitCode = 1;
}
