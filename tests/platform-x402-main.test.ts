import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { compileContracts } from '../scripts/compile-contracts.js';
import { unusedLocalPort } from '../scripts/local-chain.js';
import { loadConfig } from '../src/config.js';
import { bytes32Schema, randomId } from '../src/common.js';
import { startPilot } from '../src/main.js';
import { Ed25519Identity, capacityChallengeSchema, hostMessageHash, verifyHostMessage } from '../src/host-kit/protocol.js';
import { platformHostSchema, platformX402ChallengeSchema, platformX402IntentSchema } from '../src/platform-runtime/types.js';
import { x402CpuAuthorization, x402CpuRequired, x402CpuTypedData } from '../src/payments/cpu-reservations.js';
import { deployX402CpuRuntime } from './fixtures/platform-x402-cpu.js';

it('mounts configured x402 CPU challenges with real owner authentication, strict streaming intake and exact external-wallet intents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-x402-main-')), identity = new Ed25519Identity();
  let local: Awaited<ReturnType<typeof deployX402CpuRuntime>> | undefined, hostServer: Server | undefined;
  let pilot: Awaited<ReturnType<typeof startPilot>> | undefined;
  try {
    local = await deployX402CpuRuntime(bytes32Schema.parse(identity.publicKey));
    const fixture = local, legacyKey = generatePrivateKey(), legacySigner = privateKeyToAccount(legacyKey);
    const legacy = compileContracts(['TelomereRunEscrow.sol']).TelomereRunEscrow;
    if (!legacy) throw new Error('Legacy local controller artifact unavailable');
    const deployed = await fixture.confirmed(fixture.owner.deployContract({ abi: legacy.abi, bytecode: legacy.bytecode,
      args: [fixture.pins.tokenAddress, legacySigner.address, legacySigner.address, fixture.accounts.owner.address] }));
    if (!deployed.contractAddress) throw new Error('Disposable legacy controller unavailable');
    const imageDigest = 'sha256:' + 'a'.repeat(64), image = 'fixture/x402-main@' + imageDigest;
    const host = platformHostSchema.parse({ hostId: fixture.hostId, hostKey: identity.publicKey, hardwareClass: 'cpu', region: 'x402-main-local',
      image, imageDigest, sealed: false, lane: 'standard', pricePerSecond: '100', reliabilityBps: 10000,
      strikes: 0, stake: '300000000', availableAt: 0 });
    // Capacity-only fixture: no Cell or billable work is started by this test.
    hostServer = createServer((request, response) => {
      void (async () => {
        if (request.method !== 'POST' || request.url !== '/v1/capacity') throw new Error('Unexpected capacity fixture call');
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length;
          if (size > 4096) throw new Error('Capacity request bound'); chunks.push(bytes); }
        const challenge = capacityChallengeSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))), now = Date.now();
        if (!verifyHostMessage(identity.publicKey, 'capacity-challenge', challenge) || challenge.body.hostKey !== identity.publicKey
          || challenge.body.image !== image || challenge.body.expiresAt <= now) throw new Error('Capacity challenge differs');
        const signed = identity.sign('capacity', { version: 1 as const, hostKey: identity.publicKey, image, kind: challenge.body.kind,
          nonce: challenge.body.nonce, challengeHash: hostMessageHash(challenge), isolation: 'gvisor' as const,
          available: true, issuedAt: now, expiresAt: Math.min(challenge.body.expiresAt, now + 2000) });
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(signed));
      })().catch(() => { response.writeHead(400).end(); });
    });
    await new Promise<void>((done, reject) => hostServer!.once('error', reject).listen(0, '127.0.0.1', done));
    const bound = hostServer.address(); if (!bound || typeof bound === 'string') throw new Error('Capacity fixture port unavailable');
    const signerKeyFile = join(directory, 'platform.key'), controlPemFile = join(directory, 'control.pem'), profilePath = join(directory, 'platform.json');
    await writeFile(signerKeyFile, fixture.keys.signer, { mode: 0o600 });
    await writeFile(controlPemFile, identity.exportPrivatePem(), { mode: 0o600 });
    const reviewed = { pins: fixture.pins, signerKeyFile, hosts: [{ ...host, url: 'http://127.0.0.1:' + bound.port, controlPemFile }] };
    await writeFile(profilePath, JSON.stringify(reviewed), { mode: 0o600 });
    const port = await unusedLocalPort(), origin = 'http://127.0.0.1:' + port, path = '/api/platform/cells';
    const config = loadConfig({ MODE: 'demo', CHAIN_ID: '31337', RPC_URL: fixture.local.rpcUrl, DATA_DIR: join(directory, 'db'),
      ESCROW_ADDRESS: deployed.contractAddress, TOKEN_ADDRESS: fixture.pins.tokenAddress, SIGNER_PRIVATE_KEY: legacyKey,
      DEMO_PRIVATE_KEY: fixture.keys.owner, HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: origin,
      CPU_MODE: 'demo', CYSTS_ENABLED: 'false', LOG_LEVEL: 'error', PLATFORM_RUNTIME_CONFIG: profilePath });
    pilot = await startPilot(config);
    const post = (target: string, body: unknown, cookie = '', extra: Record<string, string> = {}) => fetch(origin + target,
      { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...extra }, body: JSON.stringify(body) });
    const auth = await post('/api/auth/challenge', { address: fixture.accounts.owner.address });
    expect(auth.status).toBe(200);
    const challenge = z.object({ nonce: z.string(), message: z.string() }).parse(await auth.json());
    const verified = await post('/api/auth/verify', { address: fixture.accounts.owner.address, nonce: challenge.nonce,
      signature: await fixture.accounts.owner.signMessage({ message: challenge.message }) });
    expect(verified.status).toBe(200);
    const cookie = verified.headers.get('set-cookie')?.match(/telomere_session=[a-f0-9]{64}/)?.[0];
    if (!cookie) throw new Error('Actual owner session unavailable');
    const block = await fixture.local.publicClient.getBlock(), leashId = randomId(), zero = `0x${'0'.repeat(64)}` as const;
    await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress,
      abi: fixture.artifact('PlatformX402EscrowV1').abi, functionName: 'createLeash', args: [leashId, {
        agent: fixture.accounts.owner.address, maxPerHour: 100_000n, maxPerDay: 1_000_000n, classMask: 1n,
        sealedOnly: false, imageAllowRoot: zero, regionAllowRoot: zero, expiry: block.timestamp + 3600n }] }));
    const input = { leashId, task: { kind: 'sha256', text: 'actual-configured-x402' }, maxSeconds: 10,
      deadline: Number(block.timestamp) + 300, maxSpend: '1090', regions: [] };
    const body = { request: { input, scheme: 'exact', extension: 'telomere-cpu-reservation-v1' } };
    const headers = { 'Idempotency-Key': 'configured-x402-original' };
    expect((await post(path, body, '', headers)).status).toBe(401);
    expect((await post(path, body, cookie, { ...headers, Origin: 'https://unapproved.invalid' })).status).toBe(403);
    expect((await post(path, { request: { ...body.request, extension: 'generic-x402' } }, cookie, headers)).status).toBe(422);
    const ambiguous = await fetch(origin + path, { method: 'POST', headers: { Origin: origin, Cookie: cookie,
      'Content-Type': 'application/json', ...headers }, body: '{"request":{},"request":{}}' });
    expect(ambiguous.status).toBe(422);
    const slow = await new Promise<{ status: number; body: unknown }>((done, reject) => {
      let finished = false, trickle: ReturnType<typeof setInterval> | undefined;
      const timer = setTimeout(() => finish(new Error('Configured /cells streamed body did not time out')), 8500);
      const outgoing = httpRequest(origin + path, { method: 'POST', agent: false, headers: { Origin: origin, Cookie: cookie,
        'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked', ...headers } }, response => {
        const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('error', finish);
        response.on('end', () => { try { finish(undefined, { status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }); } catch { finish(new Error('Non-JSON body timeout')); } });
      });
      function finish(error?: Error, value?: { status: number; body: unknown }) {
        if (finished) return; finished = true; clearTimeout(timer); clearInterval(trickle); outgoing.destroy();
        if (error) reject(error); else if (value) done(value);
      }
      outgoing.on('error', finish); outgoing.flushHeaders(); outgoing.write('{'); trickle = setInterval(() => outgoing.write(' '), 100);
    });
    expect(slow.status).toBe(422); expect(slow.body).toMatchObject({ title: 'platform_body_timeout' });
    const requested = await post(path, body, cookie, headers); expect(requested.status).toBe(402);
    const envelope = z.object({ challenge: platformX402ChallengeSchema }).passthrough().parse(await requested.json());
    const original = envelope.challenge;
    expect(original.reservation.resourceUrl).toBe(origin + path);
    expect(original.disclosure).toMatchObject({ immediateDebit: '1090', refundBeneficiary: fixture.accounts.owner.address, externalWalletGas: true });
    expect(JSON.parse(Buffer.from(requested.headers.get('PAYMENT-REQUIRED') ?? '', 'base64').toString('utf8'))).toEqual(original.paymentRequired);
    const repeated = await post(path, body, cookie, headers); expect(repeated.status).toBe(402);
    expect(await repeated.json()).toMatchObject({ challenge: original });
    const required = x402CpuRequired(fixture.pins, original.quote, original.ceiling, original.reservation);
    const authorization = x402CpuAuthorization(fixture.pins, original.quote, original.ceiling, original.reservation);
    const typed = x402CpuTypedData(fixture.pins, original.quote, original.ceiling, original.reservation);
    if (authorization.signatureType !== 'ReceiveWithAuthorization' || typed.primaryType !== 'ReceiveWithAuthorization') throw new Error('Exact receive extension unavailable');
    const payment = { x402Version: 2 as const, resource: required.resource, accepted: required.accepts[0], extensions: required.extensions,
      payload: { authorization: authorization.authorization, signature: await fixture.accounts.owner.signTypedData(typed) } };
    const intentResponse = await post(path, body, cookie, { ...headers, 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payment)).toString('base64') });
    expect(intentResponse.status).toBe(200);
    const intent = platformX402IntentSchema.parse(await intentResponse.json());
    expect(intent.challenge.quote.runId).toBe(original.quote.runId);
    expect(intent.transaction).toMatchObject({ to: fixture.pins.escrowAddress, value: '0', chainId: 31337 });
    expect((await post(path, body, cookie, { ...headers, 'PAYMENT-SIGNATURE': 'invalid-payment' })).status).toBe(422);
    expect(await fixture.local.publicClient.readContract({ address: fixture.pins.escrowAddress,
      abi: fixture.artifact('PlatformX402EscrowV1').abi, functionName: 'availableBalance', args: [fixture.accounts.owner.address] })).toBe(0n);
    expect(await fixture.local.publicClient.readContract({ address: fixture.pins.tokenAddress,
      abi: fixture.artifact('LocalReceiveToken').abi, functionName: 'balanceOf', args: [fixture.accounts.owner.address] })).toBe(1_000_000n);
    await pilot.close(); pilot = undefined;
    await writeFile(profilePath, JSON.stringify({ ...reviewed, nearInference: true }), { mode: 0o600 });
    await expect(startPilot(config)).rejects.toThrow('X402 CPU domain4 requires');
  } finally {
    await pilot?.close(); if (hostServer) { hostServer.closeAllConnections(); await new Promise<void>(done => hostServer!.close(() => done())); }
    await local?.close(); const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-x402-main-')) throw new Error('Unsafe configured x402 test cleanup');
    await rm(target, { recursive: true, force: true });
  }
}, 180_000);
