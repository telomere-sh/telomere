import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { baseMainnetUsdc, baseSepoliaUsdc, chainForId } from '../src/chain/chains.js';
import { bindControllerChain } from '../src/chain/controller-binding.js';
import { loadConfig } from '../src/config.js';
import { openStore, sessions } from '../src/store.js';
import { TelomereClient } from '../src/sdk/client.js';
import type { DeploymentPins } from '../src/sdk/types.js';
import { paymentChallenges } from '../src/payments/schema.js';
import { PlatformV2PublicationJournal, platformV2PublicationRows } from '../src/receipts/platform-v2-publication.js';

const signerKey = `0x${'22'.repeat(32)}` as const;
const signer = privateKeyToAccount(signerKey);
const escrow = '0x1111111111111111111111111111111111111111' as const;
const implementation = '0x3333333333333333333333333333333333333333' as const;
const tokenCodeHash = `0x${'aa'.repeat(32)}` as const;
const implementationCodeHash = `0x${'bb'.repeat(32)}` as const;
function environment(mode: 'testnet' | 'mainnet') {
  return { MODE: mode, CHAIN_ID: mode === 'mainnet' ? '8453' : '84532',
    TOKEN_ADDRESS: mode === 'mainnet' ? baseMainnetUsdc : baseSepoliaUsdc,
    TOKEN_CODE_HASH: tokenCodeHash, TOKEN_IMPLEMENTATION_ADDRESS: implementation,
    TOKEN_IMPLEMENTATION_CODE_HASH: implementationCodeHash, ESCROW_ADDRESS: escrow,
    SIGNER_PRIVATE_KEY: signerKey, CPU_MODE: 'docker', CPU_IMAGE: `node@sha256:${'cc'.repeat(32)}`,
    DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/telomere', PILOT_ALLOWED_OWNERS: signer.address,
    PUBLIC_ORIGIN: 'https://telomere.example.com' };
}
function response(mode: 'testnet' | 'mainnet') {
  const env = environment(mode), chain = chainForId(Number(env.CHAIN_ID));
  return { mode, chain: { id: chain.id, name: chain.name, rpcUrl: chain.rpcUrls.default.http[0],
    explorerUrl: chain.blockExplorers?.default.url }, token: { address: env.TOKEN_ADDRESS, symbol: 'USDC', decimals: 6,
    codeHash: tokenCodeHash, implementation: { address: implementation, codeHash: implementationCodeHash } },
    escrowAddress: escrow, receiptSigner: signer.address, prices: { cpuPerSecond: '100', inferenceFixed: '10000', maxSeconds: 120, maxTokens: 256 },
    workload: { nearModel: null }, nearAvailable: false, cpuMode: 'docker' };
}
function client(body: unknown, pins?: DeploymentPins) {
  return new TelomereClient({ baseUrl: 'https://telomere.example.com', ...(pins ? { pins } : {}),
    fetch: async () => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }) });
}

describe('Base and native USDC migration boundary', () => {
  it('refuses retained opt-in evidence even when its publisher and runtime rows are absent', async () => {
    const store = await openStore({ DATA_DIR: ':memory:' });
    try {
      const journal = new PlatformV2PublicationJournal(store.db, { chainId: 31337, escrow, hostRegistry: implementation });
      await journal.initialize();
      await store.db.insert(platformV2PublicationRows).values({ scope: tokenCodeHash, runId: implementationCodeHash,
        coreText: 'historical signed core', manifestText: 'historical manifest', manifestDigest: tokenCodeHash });
      await expect(bindControllerChain(store.db, loadConfig(environment('mainnet')), signer.address)).rejects.toThrow('optional public evidence');
      expect(await store.db.select().from(platformV2PublicationRows)).toHaveLength(1);
    } finally { await store.close(); }
  });
  it.each(['testnet', 'mainnet'] as const)('requires exact chain, canonical asset and implementation pins for %s', mode => {
    expect(loadConfig(environment(mode)).MODE).toBe(mode);
    for (const field of ['TOKEN_CODE_HASH', 'TOKEN_IMPLEMENTATION_ADDRESS', 'TOKEN_IMPLEMENTATION_CODE_HASH'] as const) {
      expect(() => loadConfig({ ...environment(mode), [field]: undefined })).toThrow('USDC proxy and implementation');
    }
    expect(() => loadConfig({ ...environment(mode), TOKEN_ADDRESS: escrow })).toThrow('canonical Circle');
    expect(() => loadConfig({ ...environment(mode), RPC_URL: 'http://rpc.example.com' })).toThrow('RPC requires HTTPS');
    expect(() => loadConfig({ ...environment(mode), RPC_URL: 'https://user:password@rpc.example.com' })).toThrow('RPC requires HTTPS');
    expect(() => loadConfig({ ...environment(mode), CHAIN_ID: mode === 'mainnet' ? '84532' : '8453' })).toThrow('mode and chain ID');
    for (const oldChain of [4663, 46630]) {
      expect(() => chainForId(oldChain)).toThrow('Unsupported');
      expect(() => loadConfig({ ...environment(mode), CHAIN_ID: String(oldChain) })).toThrow('mode and chain ID');
    }
  });

  it.each(['testnet', 'mainnet'] as const)('SDK rejects missing or substituted public pins before wallet actions on %s', async mode => {
    const body = response(mode);
    const pins: DeploymentPins = { chainId: mode === 'mainnet' ? 8453 : 84532, escrowAddress: escrow,
      tokenAddress: body.token.address, receiptSigner: signer.address, tokenCodeHash,
      assetImplementation: { address: implementation, codeHash: implementationCodeHash } };
    await expect(client(body).config()).rejects.toThrow('independently reviewed');
    await expect(client(body, { ...pins, tokenCodeHash: implementationCodeHash }).config()).rejects.toThrow('independently reviewed');
    await expect(client({ ...body, token: { ...body.token, address: escrow } }, pins).config()).rejects.toThrow('independently reviewed');
    await expect(client({ ...body, chain: { ...body.chain, rpcUrl: 'https://rpc.example.com' } }, pins).config()).rejects.toThrow('independently reviewed');
    await expect(client({ ...body, chain: { ...body.chain, id: 46630 } }, pins).config()).rejects.toThrow('Unsupported');
    const accepted = await client(body, pins).config();
    expect(accepted.chain.id).toBe(pins.chainId);
    expect(Object.isFrozen(accepted.token.implementation)).toBe(true);
  });

  it('retains the original database chain and deployment across restart', async () => {
    const store = await openStore({ DATA_DIR: ':memory:' });
    try {
      const config = loadConfig(environment('mainnet'));
      await bindControllerChain(store.db, config, signer.address);
      await bindControllerChain(store.db, config, signer.address);
      await expect(bindControllerChain(store.db, loadConfig(environment('testnet')), signer.address)).rejects.toThrow('different chain');
      await expect(bindControllerChain(store.db, { ...config, ESCROW_ADDRESS: implementation }, signer.address)).rejects.toThrow('different chain');
      await expect(bindControllerChain(store.db, { ...config, TOKEN_CODE_HASH: implementationCodeHash }, signer.address)).rejects.toThrow('different chain');
      await bindControllerChain(store.db, config, signer.address);
    } finally { await store.close(); }
  });

  it('refuses to relabel unmarked owner sessions onto Base', async () => {
    const store = await openStore({ DATA_DIR: ':memory:' });
    try {
      await store.db.insert(sessions).values({ hash: 'a'.repeat(64), address: signer.address, expiresAt: new Date(Date.now() + 60_000) });
      await expect(bindControllerChain(store.db, loadConfig(environment('mainnet')), signer.address)).rejects.toThrow('fresh database');
      expect(await store.db.select().from(sessions)).toHaveLength(1);
    } finally { await store.close(); }
  });

  it('refuses retained state of a disabled optional payment module on first public bind', async () => {
    const store = await openStore({ DATA_DIR: ':memory:' });
    try {
      await store.db.insert(paymentChallenges).values({ id: 'historical', nonce: 'legacy-nonce', requestHash: tokenCodeHash,
        resource: { url: 'https://old.example.com/resource', mimeType: 'application/json' },
        requirements: { scheme: 'exact', network: 'eip155:46630', asset: escrow, amount: '1', payTo: implementation,
          maxTimeoutSeconds: 60, extra: { assetTransferMethod: 'eip3009', facilitatorAddress: signer.address,
            telomere: { challengeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nonce: tokenCodeHash, requestHash: tokenCodeHash } } },
        expiresAt: new Date(Date.now() + 60_000) });
      await expect(bindControllerChain(store.db, loadConfig(environment('mainnet')), signer.address)).rejects.toThrow('fresh database');
      expect(await store.db.select().from(paymentChallenges)).toHaveLength(1);
    } finally { await store.close(); }
  });
});
