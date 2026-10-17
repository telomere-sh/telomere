import { z } from 'zod';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { addressSchema, bytes32Schema, moneySchema } from './common.js';
import { baseUsdcForChainId } from './chain/chains.js';

const schema = z.object({
  MODE: z.enum(['demo', 'testnet', 'mainnet']).default('demo'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3280),
  HOST: z.string().default('127.0.0.1'),
  PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:3280'),
  DATABASE_URL: z.string().url().optional(),
  DATA_DIR: z.string().default('.local/db'),
  CYSTS_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  CYSTS_DIR: z.string().min(1).optional(),
  CYSTS_LARGE_DIR: z.string().min(1).optional(),
  CYSTS_LARGE_GLOBAL_BYTES: z.coerce.number().int().safe().min(4 * 1024 * 1024 + 40).max(1_099_511_627_776).optional(),
  CYSTS_LARGE_OWNER_BYTES: z.coerce.number().int().safe().min(4 * 1024 * 1024 + 40).max(1_099_511_627_776).optional(),
  CYSTS_LARGE_REPLICATION_CONFIG: z.string().min(1).optional(),
  CYSTS_LARGE_REPLICATION_CONFIG_SHA256: bytes32Schema.optional(),
  CYSTS_REPLICATION_CONFIG: z.string().min(1).optional(),
  CYST_REGISTRY_CONFIG: z.string().min(1).optional(),
  PAID_CYST_INPUTS_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  CYSTS_QUOTA_POLICY_PATH: z.string().min(1).optional(),
  CYSTS_QUOTA_POLICY_SHA256: z.string().regex(/^(?:0x)?[a-fA-F0-9]{64}$/)
    .transform(value => value.replace(/^0x/, '').toLowerCase()).optional(),
  INCOME_ENDPOINTS_CONFIG: z.string().min(1).optional(),
  AKASH_READINESS_CONFIG: z.string().min(1).optional(),
  VAULT_INCOME_CONFIG: z.string().min(1).optional(),
  TREASURY_TOPUP_CONFIG: z.string().min(1).optional(),
  TREASURY_TOPUP_CONFIG_SHA256: z.string().regex(/^(?:0x)?[a-fA-F0-9]{64}$/)
    .transform(value => value.replace(/^0x/, '').toLowerCase()).optional(),
  REPUTATION_PUBLISHER_CONFIG: z.string().min(1).optional(),
  RPC_URL: z.string().url().default('http://127.0.0.1:8547'),
  CHAIN_ID: z.coerce.number().int().default(31337),
  ESCROW_ADDRESS: addressSchema, TOKEN_ADDRESS: addressSchema,
  TOKEN_CODE_HASH: bytes32Schema.optional(), TOKEN_IMPLEMENTATION_ADDRESS: addressSchema.optional(),
  TOKEN_IMPLEMENTATION_CODE_HASH: bytes32Schema.optional(),
  RECEIPT_ROOT_ADDRESS: addressSchema.optional(),
  PLATFORM_RUNTIME_CONFIG: z.string().min(1).optional(),
  AGENT_RUNTIME: z.enum(['legacy', 'platform', 'platform_vault']).default('legacy'),
  SELECTION_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  SELECTION_REGISTRY_ADDRESS: addressSchema.optional(), SELECTION_CODE_HASH: bytes32Schema.optional(),
  SELECTION_START_BLOCK: z.string().regex(/^(0|[1-9][0-9]{0,18})$/).optional(),
  SELECTION_CONFIRMATIONS: z.coerce.number().int().min(0).max(10000).default(3),
  SIGNER_PRIVATE_KEY: bytes32Schema,
  DEMO_PRIVATE_KEY: bytes32Schema.optional(),
  CPU_MODE: z.enum(['demo', 'docker', 'hostkit']).default('demo'),
  CPU_IMAGE: z.string().default('node:22-alpine'),
  HOST_KIT_URL: z.string().url().optional(), HOST_KIT_HOST_KEY: bytes32Schema.optional(),
  HOST_KIT_CONTROL_PEM: z.string().min(1).optional(),
  CPU_PRICE_PER_SECOND: moneySchema.default('100'),
  INFERENCE_FIXED_PRICE: moneySchema.default('10000'),
  MAX_TOKENS: z.coerce.number().int().min(1).max(512).default(256),
  NEAR_ENDPOINT: z.string().url().optional(), NEAR_MODEL: z.string().optional(),
  NEAR_API_KEY: z.string().min(1).optional(), NEAR_ALLOWED_MODELS: z.string().optional(),
  NEAR_VERIFICATION_MODE: z.enum(['provider_tls', 'enclave_verified']).default('provider_tls'),
  NEAR_VERIFIER_PYTHON: z.string().optional(), NEAR_ATTESTATION_POLICY: z.string().optional(),
  NEAR_ATTESTATION_POLICY_SHA256: bytes32Schema.optional(), NEAR_VERIFIER_PATH: z.string().optional(),
  NEAR_NVIDIA_VERIFIER_MODE: z.enum(['nras', 'local']).default('nras'), NEAR_NVAT_BINARY: z.string().optional(), NEAR_NVAT_LIBRARY: z.string().optional(),
  PILOT_ALLOWED_OWNERS: z.string().default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
}).superRefine((env, context) => {
  if (env.CPU_MODE === 'hostkit' && !(env.HOST_KIT_URL && env.HOST_KIT_HOST_KEY && env.HOST_KIT_CONTROL_PEM
    && /@sha256:[a-f0-9]{64}$/.test(env.CPU_IMAGE))) context.addIssue({ code: 'custom', message: 'Host Kit requires reviewed host origin/public key, private control identity file and immutable fixed-task image' });
  if (env.SELECTION_ENABLED && !(env.SELECTION_REGISTRY_ADDRESS && env.SELECTION_CODE_HASH && env.SELECTION_START_BLOCK !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Selection indexing requires reviewed registry address, runtime code hash and starting block' });
  }
  if (env.REPUTATION_PUBLISHER_CONFIG && !env.SELECTION_ENABLED) {
    context.addIssue({ code: 'custom', message: 'Reputation publication requires canonical Selection indexing' });
  }
  if (env.CYSTS_ENABLED && !env.CYSTS_DIR && !env.CYSTS_REPLICATION_CONFIG) context.addIssue({ code: 'custom', message: 'Cysts require an explicit private ciphertext directory or reviewed replication config' });
  if (env.CYSTS_LARGE_DIR && !env.CYSTS_ENABLED) context.addIssue({ code: 'custom', message: 'Large Cyst storage requires enabled Cysts' });
  if (env.CYSTS_LARGE_DIR && env.CYSTS_DIR) {
    const small = resolve(env.CYSTS_DIR), large = resolve(env.CYSTS_LARGE_DIR);
    const contained = (parent: string, child: string) => {
      const path = relative(parent, child);
      return path === '' || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
    };
    if (contained(small, large) || contained(large, small)) {
      context.addIssue({ code: 'custom', message: 'Large Cysts require a separate private directory tree' });
    }
  }
  if (env.CYSTS_LARGE_DIR && (!env.CYSTS_LARGE_GLOBAL_BYTES || !env.CYSTS_LARGE_OWNER_BYTES
    || env.CYSTS_LARGE_OWNER_BYTES > env.CYSTS_LARGE_GLOBAL_BYTES)) context.addIssue({ code: 'custom', message: 'Large Cysts require explicit global and per-owner byte caps' });
  if (!env.CYSTS_LARGE_DIR && (env.CYSTS_LARGE_GLOBAL_BYTES || env.CYSTS_LARGE_OWNER_BYTES)) context.addIssue({ code: 'custom', message: 'Large Cyst quotas require a private directory' });
  if (Boolean(env.CYSTS_LARGE_REPLICATION_CONFIG) !== Boolean(env.CYSTS_LARGE_REPLICATION_CONFIG_SHA256)
    || env.CYSTS_LARGE_REPLICATION_CONFIG && !env.CYSTS_LARGE_DIR) {
    context.addIssue({ code: 'custom', message: 'Large Cyst replication requires a private quota directory and a pinned config hash' });
  }
  if (env.CYST_REGISTRY_CONFIG && !env.CYSTS_ENABLED) context.addIssue({ code: 'custom', message: 'CystRegistry requires enabled encrypted checkpoint storage' });
  if (env.PAID_CYST_INPUTS_ENABLED && (!env.PLATFORM_RUNTIME_CONFIG || !env.CYST_REGISTRY_CONFIG)) {
    context.addIssue({ code: 'custom', message: 'Paid Cyst input requires a reviewed platform runtime and canonical CystRegistry configuration' });
  }
  if (env.AGENT_RUNTIME !== 'legacy' && (!env.CYSTS_ENABLED || !env.PLATFORM_RUNTIME_CONFIG)) {
    context.addIssue({ code: 'custom', message: 'Paid agent lifecycle requires enabled Cysts and a reviewed platform runtime' });
  }
  if (env.CYSTS_DIR && env.CYSTS_REPLICATION_CONFIG) context.addIssue({ code: 'custom', message: 'Choose one authoritative ciphertext storage configuration' });
  if (env.MODE === 'demo') {
    if (env.CHAIN_ID !== 31337 || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.RPC_URL).hostname)) {
      context.addIssue({ code: 'custom', message: 'Demo requires a loopback chain 31337' });
    }
    if (!env.DEMO_PRIVATE_KEY) context.addIssue({ code: 'custom', message: 'Demo requires an ephemeral demo owner key' });
    if (!['127.0.0.1', 'localhost', '::1'].includes(env.HOST)) context.addIssue({ code: 'custom', message: 'Demo binds to loopback only' });
  } else {
    const rpc = new URL(env.RPC_URL);
    if (rpc.username || rpc.password || rpc.hash || (rpc.protocol !== 'https:' && !(rpc.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(rpc.hostname)))) {
      context.addIssue({ code: 'custom', message: 'Public Base RPC requires HTTPS or explicit loopback HTTP without URL credentials' });
    }
    const expectedChain = env.MODE === 'mainnet' ? 8453 : 84532;
    if (env.CHAIN_ID !== expectedChain) context.addIssue({ code: 'custom', message: 'Base mode and chain ID differ; mainnet requires 8453 and testnet requires 84532' });
    if (env.TOKEN_ADDRESS.toLowerCase() !== baseUsdcForChainId(expectedChain)?.toLowerCase()) context.addIssue({ code: 'custom', message: 'Base requires canonical Circle native USDC for its selected chain' });
    if (!(env.TOKEN_CODE_HASH && env.TOKEN_IMPLEMENTATION_ADDRESS && env.TOKEN_IMPLEMENTATION_CODE_HASH)) {
      context.addIssue({ code: 'custom', message: 'Public Base requires independently reviewed USDC proxy and implementation code pins' });
    }
    if (!['docker', 'hostkit'].includes(env.CPU_MODE) || !/@sha256:[a-f0-9]{64}$/.test(env.CPU_IMAGE)) context.addIssue({ code: 'custom', message: 'Public Base requires a container executor with a digest-pinned CPU image' });
    if (!env.DATABASE_URL) context.addIssue({ code: 'custom', message: 'Public Base requires PostgreSQL' });
    if (!env.PILOT_ALLOWED_OWNERS) context.addIssue({ code: 'custom', message: 'Public Base requires explicit pilot owner allowlist' });
    if (env.DEMO_PRIVATE_KEY) context.addIssue({ code: 'custom', message: 'Demo signing is disabled on public Base' });
  }
  if ((env.NEAR_ENDPOINT || env.NEAR_MODEL || env.NEAR_API_KEY) && !(env.NEAR_ENDPOINT && env.NEAR_MODEL && env.NEAR_API_KEY && env.NEAR_ALLOWED_MODELS)) {
    context.addIssue({ code: 'custom', message: 'NEAR requires endpoint, key, model and model allowlist together' });
  }
  if (env.MODE !== 'demo' && env.NEAR_ENDPOINT && env.NEAR_VERIFICATION_MODE !== 'enclave_verified') {
    context.addIssue({ code: 'custom', message: 'Public Base NEAR requires explicit enclave_verified mode' });
  }
  if (env.NEAR_ENDPOINT && env.NEAR_VERIFICATION_MODE === 'enclave_verified'
    && !(env.NEAR_VERIFIER_PYTHON && env.NEAR_ATTESTATION_POLICY && env.NEAR_ATTESTATION_POLICY_SHA256)) {
    context.addIssue({ code: 'custom', message: 'Verified NEAR requires Python verifier, reviewed policy and pinned policy hash' });
  }
  if (env.NEAR_NVIDIA_VERIFIER_MODE === 'local' && !(env.NEAR_NVAT_BINARY && env.NEAR_NVAT_LIBRARY)) {
    context.addIssue({ code: 'custom', message: 'Local NVIDIA verification requires explicit binary and library paths' });
  }
  if (env.NEAR_NVIDIA_VERIFIER_MODE === 'nras' && (env.NEAR_NVAT_BINARY || env.NEAR_NVAT_LIBRARY)) {
    context.addIssue({ code: 'custom', message: 'NVIDIA artifacts require explicit local verification mode' });
  }
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (!!env.CYSTS_QUOTA_POLICY_PATH !== !!env.CYSTS_QUOTA_POLICY_SHA256
    || !!env.CYSTS_QUOTA_POLICY_PATH && !env.CYSTS_ENABLED) {
    context.addIssue({ code: 'custom', message: 'Checkpoint quota policy requires enabled Cysts and both its reviewed path and hash' });
  }
  if (!!env.TREASURY_TOPUP_CONFIG !== !!env.TREASURY_TOPUP_CONFIG_SHA256) {
    context.addIssue({ code: 'custom', message: 'Treasury top-ups require both the private configuration path and its reviewed hash' });
  }
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) context.addIssue({ code: 'custom', message: 'PUBLIC_ORIGIN must be an origin' });
  if (env.MODE !== 'demo' && origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) context.addIssue({ code: 'custom', message: 'Remote Base requires HTTPS' });
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return schema.parse(Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value === '' ? undefined : value])));
}
