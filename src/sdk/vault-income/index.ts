/** Node-only entry point. Intentionally absent from the browser SDK barrel. */
export { VaultIncomeClient, type VaultIncomeClientResult } from './client.js';
export { RpcVaultIncomeReader } from './reader.js';
export { VaultIncomeClientError, type VaultIncomePublicProfile, type VaultIncomePlan,
  type VaultIncomeTypedData, type VaultIncomeInspection, type VaultIncomeJournal,
  type VaultIncomeJournalState, type VaultIncomeReader } from './types.js';
