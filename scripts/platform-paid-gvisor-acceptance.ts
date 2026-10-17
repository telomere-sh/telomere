import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { chmod, lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
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
import { TelomereApiError } from '../src/sdk/transport.js';
import { PlatformRuntimeClient, type PlatformRuntimeRun } from '../src/platform-runtime/client.js';
import { platformHostLeases, platformRuns, platformTransactionJournal } from '../src/platform-runtime/schema.js';
import { PLATFORM_ZERO, platformEscrowAbi, platformHostRegistryAbi, platformHostSchema, type PlatformPins } from '../src/platform-runtime/types.js';
import { createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { hostRuntimeInfoArgs } from '../src/host-kit/docker-runtime.js';
import { createDockerHostedHostKit } from '../src/host-kit/hosted.js';
import { hostPaidSessions, hostSessions, openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, hostMessageHash, verifyHostMessage } from '../src/host-kit/protocol.js';
import { HostMeterVerifier } from '../src/host-kit/meter.js';
import { sessionContainerName } from '../src/host-kit/sessions/backends.js';
import { PaidHostSessionAgent } from '../src/host-kit/sessions/paid-agent.js';
import { executeCommand } from '../src/runtime/command.js';
import { PlatformReceiptService, platformReceiptRootAbi } from '../src/receipts/platform-service.js';
import { platformFinancialLeaf } from '../src/receipts/platform-merkle.js';
import { controllerHostRuns } from '../src/host-kit/controller-schema.js';

const DEPOSIT = 1_000_000n, COLLATERAL = 300_000_000n, MAX_SECONDS = 30, PRICE = 100n;
const TASK = { kind: 'session' as const, imageDigest: '', maxCommands: 2 };
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)']);
const routerAbi = parseAbi(['struct Buckets { uint256 work; uint256 treasury; uint256 stakers; uint256 buyAndBurn; }',
  'function getBuckets(uint64 week) view returns (Buckets)', 'function hostAccrued(uint64 week,address host) view returns (uint256)',
  'function accountedBalance() view returns (uint256)', 'function settledReceipt(bytes32) view returns (bool)']);

class AcceptanceFailure extends Error { constructor(readonly code: string) { super(code); } }
function check(value: unknown, code: string): asserts value { if (!value) throw new AcceptanceFailure(code); }
function safeFailureCode(error: unknown): string {
  if (error instanceof AcceptanceFailure) return error.code;
  if (error instanceof TelomereApiError) return `api_${error.status}_${error.code}`;
  if (error instanceof z.ZodError) {
    const path = error.issues[0]?.path.join('_').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 48) || 'unknown';
    return `response_schema_${path}`;
  }
  if (error instanceof Error) {
    if (error.message === 'Platform run changed its owner, request or fee ceiling') return 'platform_run_scope_validation';
    if (error.message === 'Paid session event page changed sequence') return 'paid_event_page_sequence';
    if (error.name === 'TimeoutError') return 'dependency_timeout';
  }
  return 'acceptance_dependency_failed';
}
const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
type Options = { image: string; dockerSocket: string; dockerBinary?: string };

/** A standalone Linux acceptance. Importing this module has no side effects. */
export async function platformPaidGvisorAcceptance(options: Options): Promise<Record<string, unknown>> {
  let stage = 'preflight', work: string | undefined, chain: LocalChain | undefined;
  let pilot: Awaited<ReturnType<typeof startPilot>> | undefined, report: Record<string, unknown> | undefined;
  let host: ReturnType<typeof createDockerHostedHostKit> | undefined, paid: PaidHostSessionAgent | undefined;
  let hostServer: Server | undefined, hostJournal: HostJournal | undefined, hostKey: Hex | undefined;
  let cleanupOwned: (() => Promise<{ clean: boolean; found: number }>) | undefined;
  let cleanupConfirmed = true;
  const previousMask = process.umask(0o077);
  try {
    check(process.platform === 'linux', 'linux_gvisor_required');
    const IMAGE = platformHostSchema.shape.image.parse(options.image);
    const socket = options.dockerSocket;
    check(/^\/[a-zA-Z0-9_./\-]{1,200}\.sock$/.test(socket) && !socket.includes('..')
      && !['/var/run/docker.sock', '/run/docker.sock'].includes(socket), 'dedicated_docker_socket_required');
    const socketStat = await lstat(socket);
    check(socketStat.isSocket() && !socketStat.isSymbolicLink(), 'docker_socket_invalid');
    const dockerBinary = options.dockerBinary ?? 'docker';
    const docker = async (args: string[], maxOutputBytes = 8192) => executeCommand(dockerBinary,
      ['--host', 'unix://' + socket, ...args], { signal: AbortSignal.timeout(10_000), maxOutputBytes });
    const runtime = await docker(hostRuntimeInfoArgs('gvisor'));
    check(runtime.exitCode === 0 && runtime.stdout.trim() && JSON.parse(runtime.stdout).split('/').at(-1) === 'runsc', 'runsc_unavailable');
    check((await docker(['image', 'inspect', IMAGE, '--format', '{{json .Id}}'])).exitCode === 0, 'reviewed_image_not_local');
    work = await mkdtemp(join(tmpdir(), 'telomere-paid-gvisor-')); await chmod(work, 0o700);
    hostJournal = await openHostJournal(join(work, 'host'));
    hostKey = hostJournal.identity.publicKey as Hex;
    const initialOwned = await docker(['ps', '--all', '--filter', 'label=telomere.host_key=' + hostKey,
      '--format', '{{.ID}}']);
    check(initialOwned.exitCode === 0 && initialOwned.stdout.trim() === '', 'fresh_host_key_already_owns_resources');
    cleanupOwned = async () => {
      const key = hostKey!;
      const inventory = async () => docker(['ps', '--all', '--no-trunc', '--filter', 'label=telomere.session=true',
        '--filter', 'label=telomere.host_key=' + key, '--format', '{{.ID}} {{.Names}}'], 16_384);
      const current = await inventory();
      if (current.exitCode !== 0) return { clean: false, found: 0 };
      const rows = current.stdout.trim().split(/\r?\n/).filter(Boolean);
      for (const row of rows) {
        const pair = /^([a-f0-9]{64}) (tlmr-session-[a-f0-9]{8}-[a-f0-9]{64})$/.exec(row);
        if (!pair || !pair[2]!.startsWith('tlmr-session-' + key.slice(2, 10) + '-')) return { clean: false, found: rows.length };
        const details = await docker(['inspect', '--format',
          '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}}}', pair[1]!]);
        if (details.exitCode !== 0) return { clean: false, found: rows.length };
        const value = JSON.parse(details.stdout) as { id?: string; name?: string; labels?: Record<string, string> };
        if (value.id !== pair[1] || value.name !== '/' + pair[2]
          || value.labels?.['telomere.session'] !== 'true'
          || value.labels?.['telomere.host_key'] !== key
          || value.labels?.['telomere.session_id'] !== '0x' + pair[2]!.split('-').at(-1)) {
          return { clean: false, found: rows.length };
        }
        const removed = await docker(['rm', '--force', '--volumes', pair[1]!]);
        if (removed.exitCode !== 0) return { clean: false, found: rows.length };
      }
      const after = await inventory();
      return { clean: after.exitCode === 0 && after.stdout.trim() === '', found: rows.length };
    };
    const control = new Ed25519Identity(), controlFile = join(work, 'control.pem');
    await writeFile(controlFile, control.exportPrivatePem(), { mode: 0o600, flag: 'wx' });
    host = createDockerHostedHostKit({ journal: hostJournal, controlKey: control.publicKey,
      reviewedImages: new Set([IMAGE]), isolation: 'gvisor', socketPath: socket, dockerBinary });
    await host.initialize(); paid = new PaidHostSessionAgent(hostJournal, host.sessions, control.publicKey); await paid.initialize();
    hostServer = createServer(getRequestListener(createHostKitRoutes(host.agent, paid).fetch));
    await new Promise<void>((resolveListening, reject) => hostServer!.listen(0, '127.0.0.1', resolveListening).once('error', reject));
    const hostAddress = hostServer.address(); check(hostAddress && typeof hostAddress !== 'string', 'host_loopback_bind_failed');
    const HOST_URL = 'http://127.0.0.1:' + hostAddress.port, HOST_KEY = hostKey, CONTROL_PEM = controlFile;
    const task = { ...TASK, imageDigest: IMAGE.split('@')[1]! };
    const hostClient = new HostKitClient(HOST_URL, HOST_KEY, control);
    stage = 'host_capacity_preflight'; check(await hostClient.capacity(IMAGE, 'session'), 'host_capacity_unavailable');
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
    const reviewedHost = platformHostSchema.parse({ hostId, hostKey: HOST_KEY, hardwareClass: 'cpu', region: 'acceptance-local',
      image: IMAGE, imageDigest: IMAGE.split('@')[1], sealed: false, lane: 'standard', pricePerSecond: PRICE.toString(),
      sessionEnabled: true,
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
      deadline: Number((await local.publicClient.getBlock()).timestamp) + 90, maxSpend: '3270', regions: ['acceptance-local'] }, 'gvisor_paid_quote_001');
    check(quote.ceiling === '3270', 'fee_inclusive_quote_ceiling');
    check(quote.quote.workloadHash === hashJson({ task }), 'signed_workload_hash_mismatch');
    const plan = await sdk.openPlan(quote), opened = await confirmed(owner.sendTransaction({ to: plan.to, data: plan.data as Hex, value: 0n }));
    check((await pilot.platformRuntime.bridge.host(hostId)).openRuns === 1n, 'host_open_hook_not_atomic');
    await sdk.admit({ runId: quote.quote.runId, transactionHash: opened.transactionHash }, 'gvisor_paid_admit_001');
    const runId = quote.quote.runId, containerName = sessionContainerName(HOST_KEY, runId);
    stage = 'two_commands_one_gvisor_cell';
    let admitted = false, until = Date.now() + 15_000;
    while (!admitted && Date.now() < until) {
      try { admitted = (await sdk.sessionEvents(runId)).events.some(event => event.kind === 'ready'); }
      catch { /* Host admission may still be starting. */ }
      if (!admitted) await pause(200);
    }
    check(admitted, 'paid_session_admission_unavailable');
    const inspect = async () => {
      const result = await docker(['inspect', '--format',
        '{"id":{{json .Id}},"runtime":{{json .HostConfig.Runtime}},"network":{{json .HostConfig.NetworkMode}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"running":{{json .State.Running}}}',
        containerName]);
      check(result.exitCode === 0, 'owned_session_container_unavailable');
      const value = JSON.parse(result.stdout) as { id?: string; runtime?: string; network?: string; readOnly?: boolean; running?: boolean };
      check(value.id && /^[a-f0-9]{64}$/.test(value.id) && value.runtime === 'runsc' && value.network === 'none'
        && value.readOnly === true && value.running === true, 'owned_session_isolation_invalid');
      return value.id;
    };
    const originalContainer = await inspect();
    const firstInput = { commandId: 'write', argv: ['/usr/local/bin/node', '-e',
      "require('node:fs').writeFileSync('paid-cell.txt','retained-in-one-cell');process.stdout.write('written')"] };
    const secondInput = { commandId: 'read', argv: ['/usr/local/bin/node', '-e',
      "process.stdout.write(require('node:fs').readFileSync('paid-cell.txt','utf8'))"] };
    const first = await sdk.command(runId, firstInput);
    check(first.state === 'completed' && first.stdout === 'written', 'first_command_failed');
    check(await inspect() === originalContainer, 'container_changed_after_first_command');
    const second = await sdk.command(runId, secondInput);
    check(second.state === 'completed' && second.stdout === 'retained-in-one-cell', 'second_command_did_not_share_state');
    check(await inspect() === originalContainer, 'container_changed_after_second_command');
    const activeReplay = await sdk.command(runId, firstInput);
    check(hashJson(activeReplay) === hashJson(first), 'active_command_replay_changed');
    stage = 'wait_for_signed_lease_expiry';
    const [admittedLease] = await pilot.service.db.select().from(platformHostLeases);
    check(admittedLease?.runId === runId && verifyHostMessage(control.publicKey, 'lease', admittedLease.lease),
      'signed_paid_lease_unavailable');
    const untilExpiry = admittedLease.lease.body.expiresAt - Date.now() + 1500;
    if (untilExpiry > 0) await pause(untilExpiry);
    let outcome: PlatformRuntimeRun = await sdk.get(runId);
    until = Date.now() + 65_000;
    while (!(outcome.result && outcome.settlement) && Date.now() < until) {
      await pause(2000); stage = 'poll_terminal_run'; outcome = await sdk.get(runId);
    }
    check(outcome.result && outcome.settlement && outcome.status === 'receipt_pending', 'original_outcome_unavailable');
    check(outcome.settlement.billableSeconds > 0, 'positive_billable_time_required');
    const leaseRows = await pilot.service.db.select().from(platformHostLeases), evidence = leaseRows[0];
    check(leaseRows.length === 1 && evidence && evidence.runId === outcome.id && evidence.cleanupConfirmed === 1
      && evidence.ticks.length > 0 && evidence.ticks.length === evidence.acknowledgments.length, 'durable_original_host_evidence');
    check(verifyHostMessage(control.publicKey, 'lease', evidence.lease) && evidence.owner === accounts.owner.address.toLowerCase()
      && evidence.lease.body.owner === evidence.owner && evidence.lease.body.hostKey === HOST_KEY && evidence.lease.body.image === IMAGE
      && evidence.lease.body.runId === outcome.id && evidence.lease.body.maxSeconds === MAX_SECONDS,
    'original_lease_scope_invalid');
    check(Date.now() >= evidence.lease.body.expiresAt, 'signed_lease_not_expired');
    stage = 'signed_terminal_host_status';
    const hostState = await hostClient.sessionControl(evidence.lease, { action: 'status' });
    check(hostState.isolation === 'gvisor' && hostState.state === 'expired' && hostState.cleanupConfirmed
      && hostState.billableSeconds >= outcome.settlement.billableSeconds,
    'signed_gvisor_terminal_status');
    stage = 'durable_terminal_host_history';
    const [retained] = await hostJournal.db.select().from(hostSessions);
    const [paidRow] = await hostJournal.db.select().from(hostPaidSessions);
    check(retained?.sessionId === runId && retained.record?.commands.length === 2 && retained.record.cleanupConfirmed
      && paidRow?.sessionId === runId && paidRow.cleanupConfirmed, 'retained_host_journal_incomplete');
    check(evidence.sessionEvents && evidence.sessionEvents.length === hostState.eventCount
      && hostState.eventsHash === hashJson({ protocol: 'telomere-paid-session-events-v1', events: evidence.sessionEvents })
      && (outcome.result as { output?: string }).output === hostState.eventsHash,
    'terminal_event_history_digest_invalid');
    stage = 'controller_terminal_event_pages';
    const pagedEvents = [];
    for (let cursor = -1; cursor + 1 < hostState.eventCount;) {
      const page = await sdk.sessionEvents(runId, cursor, 8);
      check(page.events.length > 0 && page.eventCount === hostState.eventCount, 'terminal_event_page_incomplete');
      pagedEvents.push(...page.events); cursor = page.nextSequence;
    }
    check(hashJson({ protocol: 'telomere-paid-session-events-v1', events: pagedEvents }) === hostState.eventsHash,
      'terminal_event_pages_changed');
    stage = 'physical_gvisor_container_cleanup';
    const remaining = await docker(['ps', '--all', '--filter', 'name=^/' + containerName + '$', '--format', '{{.ID}}']);
    check(remaining.exitCode === 0 && remaining.stdout.trim() === '', 'owned_session_container_remains');
    stage = 'signed_meter_replay';
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
    check(meter.billableSeconds === hostState.billableSeconds && outcome.settlement.billableSeconds <= meter.billableSeconds,
      'meter_financial_conservation');
    stage = 'closed_hour_actual_root_settlement';
    const receiptHour = Math.floor(outcome.settlement.endedAt / 3600), current = (await local.publicClient.getBlock()).timestamp;
    const closedAt = BigInt((receiptHour + 1) * 3600 + 1);
    await test.setNextBlockTimestamp({ timestamp: closedAt > current ? closedAt : current + 1n }); await test.mine({ blocks: 1 });
    until = Date.now() + 35_000;
    let completed = await sdk.get(outcome.id);
    while (completed.status !== 'completed' && Date.now() < until) { await pause(1000); completed = await sdk.get(outcome.id); }
    check(completed.status === 'completed' && completed.settlement && completed.settlementTx && completed.charged && completed.refund, 'canonical_settlement_missing');
    check(hashJson(completed.settlement) === hashJson(outcome.settlement), 'original_settlement_changed');
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
    const snapshot = hashJson(completed), evidenceHash = hostMessageHash(evidence.lease);
    stage = 'terminal_same_id_replay';
    const terminalFirst = await sdk.command(runId, firstInput), terminalSecond = await sdk.command(runId, secondInput);
    check(hashJson(terminalFirst) === hashJson(first) && hashJson(terminalSecond) === hashJson(second),
      'terminal_command_replay_changed');
    let changedInputRejected = false, newCommandRejected = false;
    try { await sdk.command(runId, { ...firstInput, argv: ['/usr/local/bin/node', '-e', "process.stdout.write('changed')"] }); }
    catch { changedInputRejected = true; }
    try { await sdk.command(runId, { commandId: 'new-after-expiry', argv: ['/usr/local/bin/node', '-e', 'process.exit(0)'] }); }
    catch { newCommandRejected = true; }
    const [afterReplay] = await hostJournal.db.select().from(hostSessions);
    check(changedInputRejected && newCommandRejected && afterReplay?.record?.commands.length === 2,
      'terminal_replay_redispatched_or_accepted_new_command');
    stage = 'same_config_database_restart'; await pilot.close(); pilot = undefined;
    check(await readFile(pilotPath, 'utf8') === originalPilotConfig && await readFile(runtimePath, 'utf8') === originalRuntimeConfig, 'private_configuration_changed');
    pilot = await startPilot(loadConfig(JSON.parse(await readFile(pilotPath, 'utf8')) as NodeJS.ProcessEnv)); sdk = await client();
    // Let the real maintenance loop run after recovery, then query it through the SDK again.
    await pause(2200);
    const recovered = await sdk.get(completed.id), restoredLeases = await pilot.service.db.select().from(platformHostLeases);
    const restoredJournal = await pilot.service.db.select().from(platformTransactionJournal);
    check(hashJson(recovered) === snapshot && (await sdk.balance()).available === balance.available
      && restoredLeases.length === 1 && restoredLeases[0]?.cleanupConfirmed === 1
      && hostMessageHash(restoredLeases[0].lease) === evidenceHash
      && restoredJournal.length === journal.length && restoredJournal.every(row => journal.some(old => old.key === row.key && old.hash === row.hash))
      && (await pilot.service.db.select().from(platformRuns)).length === 1, 'restart_redispatch_or_accounting_change');
    const restoredHost = await hostClient.sessionControl(evidence.lease, { action: 'status' });
    check(restoredHost.state === 'expired' && restoredHost.cleanupConfirmed && restoredHost.eventsHash === hostState.eventsHash
      && hashJson(restoredHost.ticks) === hashJson(hostState.ticks) && hashJson(restoredHost.acks) === hashJson(hostState.acks),
    'original_host_history_changed');
    check(hashJson(await sdk.command(runId, firstInput)) === hashJson(first), 'restart_terminal_replay_changed');
    check((await docker(['ps', '--all', '--filter', 'name=^/' + containerName + '$', '--format', '{{.ID}}'])).stdout.trim() === '',
      'restart_redispatched_cell');
    report = { status: 'passed', checkedAt: new Date().toISOString(), protocol: 'telomere-platform-v1', chainId: 31337,
      task: 'paid_session', commands: 2, sameContainer: true, sharedState: true, activeAndTerminalSameIdReplay: true,
      changedInputAndNewCommandRejected: true, workloadHashBound: true,
      runId: completed.id, hostId, isolation: 'gvisor', image: IMAGE, sdkOverActualHttp: true, separateLegacySignerIdle: true,
      billableSeconds: completed.settlement.billableSeconds, signedHostTicks: evidence.ticks.length,
      signedControlAcknowledgments: evidence.acknowledgments.length, eventHistoryDigest: hostState.eventsHash,
      signedLeaseExpired: true, physicalCleanupConfirmed: true,
      reservation: quote.ceiling, hostAmount: base.toString(), platformFee: fee.toString(), charged: completed.charged, refund: completed.refund,
      available: balance.available, feeBuckets: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.toString()])),
      receiptHour: proof.hour, financialLeaf: proof.leaf, root: proof.root, publicationTransaction: proof.transactionHash,
      settlementTransaction: completed.settlementTx, actualFullFinancialMerkleProofVerified: true, atomicHostOpenCloseVerified: true,
      tokenBalancesConserved: true, sameDatabaseAndConfigRestart: true, restartWithoutRedispatch: true,
      publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false };
  } catch (error) {
    report = { status: 'failed', checkedAt: new Date().toISOString(), stage,
      code: safeFailureCode(error),
      publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false };
  } finally {
    try { await pilot?.close(); } catch { cleanupConfirmed = false; }
    try { await paid?.close(); } catch { cleanupConfirmed = false; }
    try { await host?.close(); } catch { cleanupConfirmed = false; }
    try {
      if (hostServer) { hostServer.closeAllConnections(); await new Promise<void>((done, reject) =>
        hostServer!.close(error => error ? reject(error) : done())); }
    } catch { cleanupConfirmed = false; }
    try { if (cleanupOwned) { const resources = await cleanupOwned();
      if (!resources.clean || resources.found !== 0) cleanupConfirmed = false; } }
    catch { cleanupConfirmed = false; }
    try { await hostJournal?.close(); } catch { cleanupConfirmed = false; }
    try { await chain?.close(); } catch { cleanupConfirmed = false; }
    process.umask(previousMask);
  }
  check(report, 'acceptance_report_missing');
  if (!cleanupConfirmed) report = { status: 'failed', checkedAt: new Date().toISOString(), stage: 'disposable_shutdown',
    code: 'owned_resource_cleanup_unconfirmed', publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false };
  const finalReport = { ...report, disposableControllerHostAndChainStopped: cleanupConfirmed };
  if (work) {
    try { await writeFile(join(work, 'acceptance.json'), JSON.stringify(finalReport, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
    catch { return { status: 'failed', stage: 'private_report_write', code: 'private_report_write_failed', privateKeysIncluded: false,
      disposableControllerHostAndChainStopped: cleanupConfirmed, publicTransactions: 0, paidProviderRequests: 0 }; }
  }
  return finalReport;
}

// No raw errors, PEM, private keys, session cookies, signed transaction bytes or database rows in stdout.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), valid = (args.length === 4 || args.length === 6)
    && args[0] === '--image' && args[2] === '--docker-socket'
    && (args.length === 4 || args[4] === '--docker-binary');
  const evidence = valid ? await platformPaidGvisorAcceptance({ image: args[1]!, dockerSocket: args[3]!,
    ...(args[5] ? { dockerBinary: args[5] } : {}) })
    : { status: 'failed', stage: 'preflight', code: 'acceptance_arguments_invalid',
      publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false };
  process.stdout.write(JSON.stringify(evidence) + '\n');
  if (evidence.status !== 'passed') process.exitCode = 1;
}
