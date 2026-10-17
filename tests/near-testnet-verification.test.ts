import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { baseSepoliaUsdc } from '../src/chain/chains.js';
import { loadConfig } from '../src/config.js';

const testnet = {
  MODE: 'testnet', CHAIN_ID: '84532', TOKEN_ADDRESS: baseSepoliaUsdc,
  TOKEN_CODE_HASH: '0x' + 'aa'.repeat(32), TOKEN_IMPLEMENTATION_ADDRESS: '0x' + '11'.repeat(20),
  TOKEN_IMPLEMENTATION_CODE_HASH: '0x' + 'bb'.repeat(32),
  ESCROW_ADDRESS: '0x1111111111111111111111111111111111111111',
  SIGNER_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
  CPU_MODE: 'docker', CPU_IMAGE: `node@sha256:${'aa'.repeat(32)}`,
  DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/telomere',
  PILOT_ALLOWED_OWNERS: '0x3333333333333333333333333333333333333333',
  NEAR_ENDPOINT: 'https://cloud-api.near.ai/v1', NEAR_MODEL: 'fixture/model',
  NEAR_API_KEY: 'fixture-only-key', NEAR_ALLOWED_MODELS: 'fixture/model',
};
const verified = {
  ...testnet, NEAR_VERIFICATION_MODE: 'enclave_verified',
  NEAR_VERIFIER_PYTHON: 'python3', NEAR_ATTESTATION_POLICY: '/fixture/reviewed-policy.json',
  NEAR_ATTESTATION_POLICY_SHA256: `0x${'bb'.repeat(32)}`,
};

describe('testnet NEAR configuration', () => {
  it('rejects both the implicit and explicit TLS-only mode even with verification pins supplied', () => {
    expect(() => loadConfig(testnet)).toThrow('Public Base NEAR requires explicit enclave_verified mode');
    expect(() => loadConfig({ ...verified, NEAR_VERIFICATION_MODE: 'provider_tls' }))
      .toThrow('Public Base NEAR requires explicit enclave_verified mode');
  });

  it('requires each verified pin, then accepts the explicit verified profile', () => {
    for (const pin of ['NEAR_VERIFIER_PYTHON', 'NEAR_ATTESTATION_POLICY', 'NEAR_ATTESTATION_POLICY_SHA256'] as const) {
      expect(() => loadConfig({ ...verified, [pin]: undefined }))
        .toThrow('Verified NEAR requires Python verifier, reviewed policy and pinned policy hash');
    }
    expect(loadConfig(verified)).toMatchObject({ MODE: 'testnet', NEAR_VERIFICATION_MODE: 'enclave_verified',
      NEAR_ENDPOINT: verified.NEAR_ENDPOINT, NEAR_ATTESTATION_POLICY_SHA256: verified.NEAR_ATTESTATION_POLICY_SHA256 });
  });

  it('keeps provider TLS available for demo fixtures', () => {
    expect(loadConfig({ ...testnet, MODE: 'demo', CHAIN_ID: '31337',
      TOKEN_ADDRESS: '0x4444444444444444444444444444444444444444',
      DEMO_PRIVATE_KEY: `0x${'55'.repeat(32)}`, CPU_MODE: 'demo', CPU_IMAGE: 'node:22-alpine' }))
      .toMatchObject({ MODE: 'demo', NEAR_VERIFICATION_MODE: 'provider_tls' });
  });

  it('fails CLI startup before RPC access or an HTTP listener in TLS-only testnet mode', async () => {
    let rpcRequests = 0;
    const rpc = createServer((_request, response) => { rpcRequests += 1; response.writeHead(500).end(); });
    await new Promise<void>((resolve, reject) => { rpc.once('error', reject); rpc.listen(0, '127.0.0.1', resolve); });
    try {
      const address = rpc.address();
      if (!address || typeof address === 'string') throw new Error('Expected local RPC port');
      const project = fileURLToPath(new URL('..', import.meta.url));
      const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        ...testnet, RPC_URL: `http://127.0.0.1:${address.port}`,
        NEAR_ENDPOINT: `http://127.0.0.1:${address.port}/v1`,
      };
      const child = spawn(process.execPath, ['--import', 'tsx', main], { cwd: project, env, windowsHide: true });
      let output = '';
      child.stdout.on('data', chunk => { output += String(chunk); });
      child.stderr.on('data', chunk => { output += String(chunk); });
      const timeout = setTimeout(() => child.kill(), 20_000);
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('exit', resolve);
      }).finally(() => clearTimeout(timeout));
      expect(exitCode).toBe(1);
      expect(output).toContain('"errorCode":"ZodError"');
      expect(output).toContain('startup_failed');
      expect(output).not.toContain('pilot_started');
      expect(rpcRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => rpc.close(error => error ? reject(error) : resolve()));
    }
  }, 30_000);
});
