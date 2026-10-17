import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { hashJson, sameAddress } from '../common.js';
import { privateVaultIncomeText } from '../payments/vault-income-private-file.js';
import { incomeStrictJson } from '../selection/income-endpoints/json.js';
import { BaseTopUpCredit } from './base-credit.js';
import { FileTopUpLedger } from './ledger.js';
import { TreasuryTopUpService } from './service.js';
import { SolanaTopUpReader } from './solana-reader.js';
import { topUpProfileSchema } from './types.js';

export interface TreasuryTopUpConfig {
  TREASURY_TOPUP_CONFIG?: string | undefined; TREASURY_TOPUP_CONFIG_SHA256?: string | undefined;
  CHAIN_ID: number; RPC_URL: string; TOKEN_ADDRESS: string; MODE: string;
}
function freezeProfile(value: unknown): void {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freezeProfile(item); Object.freeze(value); }
}
/** Default off. Startup reads a reviewed private profile and canonical Base
 * bindings; there is no private key, paid request or signed relay at startup. */
export async function configuredTreasuryTopUps(config: TreasuryTopUpConfig, otherSigners: readonly string[] = []): Promise<TreasuryTopUpService | undefined> {
  if (!config.TREASURY_TOPUP_CONFIG && !config.TREASURY_TOPUP_CONFIG_SHA256) return undefined;
  try {
    if (!config.TREASURY_TOPUP_CONFIG || !config.TREASURY_TOPUP_CONFIG_SHA256
      || !/^[a-f0-9]{64}$/.test(config.TREASURY_TOPUP_CONFIG_SHA256)) throw new Error('Both reviewed profile pins required');
    const text = await privateVaultIncomeText(config.TREASURY_TOPUP_CONFIG, 32768);
    if (createHash('sha256').update(text).digest('hex') !== config.TREASURY_TOPUP_CONFIG_SHA256) throw new Error('Private top-up profile hash differs');
    const profile = topUpProfileSchema.parse(incomeStrictJson(text));
    freezeProfile(profile);
    if (otherSigners.some(signer => sameAddress(signer, profile.base.facilitator))) throw new Error('Top-up relayer belongs to another nonce journal');
    if (profile.base.chainId !== config.CHAIN_ID || !sameAddress(config.TOKEN_ADDRESS, profile.base.asset) || !isAbsolute(profile.journalPath)) throw new Error('Runtime top-up pins differ');
    for (const raw of [config.RPC_URL, profile.solana.rpcUrl]) {
      const url = new URL(raw), loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.hash || url.protocol !== 'https:' && !(profile.localFixture && loopback && url.protocol === 'http:')) throw new Error('Reviewed top-up RPC transport differs');
      if (profile.localFixture && !loopback) throw new Error('Local top-up fixtures require loopback RPCs');
    }
    if (profile.localFixture && config.MODE !== 'demo' || !profile.localFixture && (config.MODE !== 'mainnet' || config.CHAIN_ID !== 8453)) throw new Error('Unsupported Solana/Base top-up network pair');
    const policyHash = hashJson(profile), base = new BaseTopUpCredit(profile, config.RPC_URL);
    await base.initialize();
    const service = new TreasuryTopUpService(profile, policyHash, new FileTopUpLedger(profile.journalPath, policyHash), new SolanaTopUpReader(profile.solana), base);
    await service.initialize(); return service;
  } catch { throw new Error('Treasury top-up configuration, policy journal or reviewed deployment is unavailable'); }
}
