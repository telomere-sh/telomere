import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { unusedLocalPort } from '../scripts/local-chain.js';
import { loadConfig } from '../src/config.js';
import { startPilot } from '../src/main.js';
import { Worker } from '../src/worker.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { Ed25519Identity } from '../src/host-kit/protocol.js';
import { HttpAgentLifecycleControl } from '../src/agents/http-client.js';
import { ApiTransport } from '../src/sdk/transport.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

describe('actual mounted owner Vault lifecycle', () => {
  let artifacts: Record<string, ContractArtifact>;
  beforeAll(() => {
    artifacts = compileContracts(['TelomereRunEscrow.sol', 'PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol',
      'MockToken.sol', 'PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
    artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
  }, 90_000);
  it('requires reviewed Vault pins, serves the human owner with real auth, persists scope and denies agent-wallet owner impersonation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telomere-vault-agent-main-')), control = new Ed25519Identity();
    // REASON: Ed25519Identity's generated public key is a validated bytes32 string.
    const local = await deployPlatformRuntime(control.publicKey as Hex, artifacts);
    let pilot: Awaited<ReturnType<typeof startPilot>> | undefined;
    try {
      const vault = await deployPlatformVault(local), legacyKey = generatePrivateKey(), legacySigner = privateKeyToAccount(legacyKey);
      const legacyArtifact = local.artifact('TelomereRunEscrow');
      const deployed = await local.confirmed(local.owner.deployContract({ abi: legacyArtifact.abi, bytecode: legacyArtifact.bytecode,
        args: [local.pins.tokenAddress, legacySigner.address, legacySigner.address, local.accounts.owner.address] }));
      if (!deployed.contractAddress) throw new Error('Legacy reference escrow missing');
      const port = await unusedLocalPort(), origin = 'http://127.0.0.1:' + port;
      const signerKeyFile = join(root, 'platform.key'), controlPemFile = join(root, 'control.pem'), runtimePath = join(root, 'platform.json');
      await writeFile(signerKeyFile, local.keys.signer, { mode: 0o600 });
      await writeFile(controlPemFile, control.exportPrivatePem(), { mode: 0o600 });
      const runtimeConfig = { pins: local.pins, signerKeyFile, hosts: [{ hostId: local.hostId, hostKey: control.publicKey,
        hardwareClass: 'cpu', region: 'local-test', image: 'fixture/node@sha256:' + '1'.repeat(64), imageDigest: 'sha256:' + '1'.repeat(64),
        sealed: false, lane: 'standard', pricePerSecond: '100', reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0,
        url: 'http://127.0.0.1:1', controlPemFile }] };
      await writeFile(runtimePath, JSON.stringify(runtimeConfig), { mode: 0o600 });
      const rawConfig = { MODE: 'demo', CHAIN_ID: '31337', RPC_URL: local.local.rpcUrl, DATA_DIR: join(root, 'db'),
        ESCROW_ADDRESS: deployed.contractAddress, TOKEN_ADDRESS: local.pins.tokenAddress, SIGNER_PRIVATE_KEY: legacyKey,
        DEMO_PRIVATE_KEY: local.keys.owner, HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: origin,
        CPU_MODE: 'demo', CYSTS_ENABLED: 'true', CYSTS_DIR: join(root, 'cysts'), AGENT_RUNTIME: 'platform_vault',
        PLATFORM_RUNTIME_CONFIG: runtimePath, LOG_LEVEL: 'error' };
      const config = loadConfig(rawConfig);
      expect(() => loadConfig({ ...rawConfig, CYSTS_ENABLED: 'false' })).toThrow('Paid agent lifecycle');
      await expect(startPilot(config)).rejects.toThrow('Vault agent lifecycle requires');
      await writeFile(runtimePath, JSON.stringify({ ...runtimeConfig, vaults: vault.pins }), { mode: 0o600 });
      pilot = await startPilot(config);
      const signIn = await fetch(origin + '/api/auth/demo', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
      const sessionToken = signIn.headers.get('set-cookie')?.match(/telomere_session=([a-f0-9]{64})/)?.[1];
      if (!sessionToken) throw new Error('Owner authentication failed');
      const owner = local.accounts.owner.address, agent = vault.account.address;
      const ownerClient = new HttpAgentLifecycleControl(new ApiTransport(origin, { sessionToken }));
      expect((await fetch(origin + '/api/agents')).status).toBe(401);
      await ownerClient.register(owner, agent);
      expect((await ownerClient.evaluate(owner, agent)).balance).toBe('1000000');
      expect((await ownerClient.get(owner, agent)).policy).toMatchObject({ maximumLeaseSeconds: 120, rollBeforeSeconds: 30 });
      expect(await (await fetch(origin + '/api/config')).json()).toMatchObject({ platform: { agentLifecycle: true,
        agentRuntimeScope: { protocol: 'platform_vault', ownerPayersOnly: false, agentVaultsOnly: true,
          registry: vault.registryAddress.toLowerCase() } } });
      const post = (path: string, value: unknown) => fetch(origin + path, { method: 'POST', headers: { Origin: origin,
        'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      const challengeResponse = await post('/api/auth/challenge', { address: agent });
      // REASON: The real authentication endpoint returns the bounded nonce and signable message.
      const challenge = await challengeResponse.json() as { nonce: string; message: string };
      const signature = await vault.account.signMessage({ message: challenge.message });
      const authenticatedAgent = await post('/api/auth/verify', { address: agent, nonce: challenge.nonce, signature });
      const agentCookie = authenticatedAgent.headers.get('set-cookie')?.match(/telomere_session=[a-f0-9]{64}/)?.[0];
      if (!agentCookie) throw new Error('Agent authentication failed');
      const denied = await fetch(origin + '/api/agents', { method: 'POST', headers: { Origin: origin, Cookie: agentCookie,
        'Content-Type': 'application/json' }, body: JSON.stringify({ agent }) });
      expect(denied.status).toBe(404);
      expect((await fetch(origin + '/api/agents/' + agent, { headers: { Cookie: agentCookie } })).status).toBe(404);
      await pilot.close(); pilot = undefined;
      const recover = vi.spyOn(Worker.prototype, 'recover'), initialize = vi.spyOn(PlatformRuntimeService.prototype, 'initialize');
      await expect(startPilot({ ...config, AGENT_RUNTIME: 'platform' })).rejects.toThrow('different reviewed runtime');
      expect(recover).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled();
      recover.mockRestore(); initialize.mockRestore();
      pilot = await startPilot(config);
      expect((await ownerClient.list(owner)).agents).toHaveLength(1);
      expect((await ownerClient.evaluate(owner, agent)).balance).toBe('1000000');
    } finally {
      vi.restoreAllMocks(); await pilot?.close(); await local.close();
      const target = resolve(root);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-vault-agent-main-')) throw new Error('Unexpected owned main acceptance directory');
      await rm(target, { recursive: true, force: true });
    }
  }, 60_000);
});
