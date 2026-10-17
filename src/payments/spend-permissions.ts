import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAbiItem, hashTypedData, keccak256, parseAbi, parseEventLogs,
  toFunctionSelector, type Hex, type PublicClient } from 'viem';
import { addressSchema, bytes32Schema, canonical, sameAddress } from '../common.js';
import type { PlatformPins, PlatformQuote } from '../platform-runtime/types.js';
import { canonicalPlatformReceipt, checkPlatformAsset } from '../platform-runtime/read-only.js';

export { spendPermissionSchema, spendPermissionFundingSchema, spendPermissionProfileSchema, SPEND_PERMISSION_MANAGER, SPEND_PERMISSION_TYPE, SPEND_PERMISSION_TYPEHASH, SPEND_PERMISSION_LEASH_DOMAIN } from './spend-permission-types.js';
export type { SpendPermission } from './spend-permission-types.js';
import { spendPermissionSchema, spendPermissionFundingSchema, SPEND_PERMISSION_MANAGER, SPEND_PERMISSION_TYPEHASH, SPEND_PERMISSION_LEASH_DOMAIN, type SpendPermission } from './spend-permission-types.js';
const permissionStruct = 'struct SpendPermission { address account; address spender; address token; uint160 allowance; uint48 period; uint48 start; uint48 end; uint256 salt; bytes extraData; }';
export const spendPermissionManagerAbi = parseAbi([permissionStruct,
  'struct PeriodSpend { uint48 start; uint48 end; uint160 spend; }',
  'function SPEND_PERMISSION_TYPEHASH() view returns (bytes32)', 'function getHash(SpendPermission permission) view returns (bytes32)',
  'function isValid(SpendPermission permission) view returns (bool)',
  'function getCurrentPeriod(SpendPermission permission) view returns (PeriodSpend)',
  'event SpendPermissionUsed(bytes32 indexed hash,address indexed account,address indexed spender,address token,PeriodSpend periodSpend)',
]);
export const spendPermissionEscrowAbi = parseAbi([permissionStruct,
  'struct PlatformQuote { bytes32 runId; bytes32 leashId; bytes32 hostId; address payer; uint16 hwClass; bytes32 regionHash; bytes32 imageHash; bytes32 workloadHash; uint64 maxSeconds; uint96 pricePerSecond; uint96 inferencePrice; uint64 quoteExpiry; }',
  'function spendPermissionManager() view returns (address)', 'function spendPermissionManagerCodeHash() view returns (bytes32)',
  'function eip712Domain() view returns (bytes1 fields,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt,uint256[] extensions)',
  'function SPEND_PERMISSION_TYPEHASH() view returns (bytes32)',
  'function spendPermissionExtraData(address account,address beneficiary,bytes32 leashId) view returns (bytes)',
  'function openRunFromSpendPermission(PlatformQuote quote,bytes signature,bytes32[] imageProof,bytes32[] regionProof,SpendPermission permission)',
  'event SpendPermissionRunFunded(bytes32 indexed runId,bytes32 indexed permissionHash,address indexed fundingAccount,address refundBeneficiary,uint96 amount,bytes32 leashTermsHash)',
]);
export const spendPermissionOpeningSelector = toFunctionSelector(getAbiItem({ abi: spendPermissionEscrowAbi, name: 'openRunFromSpendPermission' }));
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)']);
const leashAbi = parseAbi([
  'struct PlatformLeash { address owner; address agent; uint96 maxPerHour; uint96 maxPerDay; uint64 classMask; bool sealedOnly; bytes32 imageAllowRoot; bytes32 regionAllowRoot; uint64 expiry; bool killed; uint64 killedAt; uint64 hourKey; uint64 dayKey; uint96 spentHour; uint96 spentDay; uint96 pending; }',
  'function getLeash(bytes32 leashId) view returns (PlatformLeash)',
  'struct PlatformRun { address payer; address hostOperator; bytes32 leashId; bytes32 hostId; uint16 hwClass; bytes32 regionHash; bytes32 imageHash; bytes32 workloadHash; bool sealedHost; uint64 openedAt; uint64 acceptedExpiry; uint64 maxSeconds; uint64 stopAt; uint96 pricePerSecond; uint96 inferencePrice; uint96 ceiling; uint8 status; uint64 billableSeconds; uint96 inferenceCharge; bytes32 receiptHash; bool hostReleased; }',
  'function getRun(bytes32 runId) view returns (PlatformRun)',
  'event RunOpened(bytes32 indexed runId,bytes32 indexed leashId,bytes32 indexed hostId,address payer,uint96 ceiling,uint64 openedAt,uint64 maxSeconds)',
]);
export function typedSpendPermission(permission: SpendPermission) {
  return { ...permission, account: addressSchema.parse(permission.account), spender: addressSchema.parse(permission.spender),
    token: addressSchema.parse(permission.token), allowance: BigInt(permission.allowance), salt: BigInt(permission.salt),
    extraData: permission.extraData as Hex };
}
export function spendPermissionOpenCall(quote: PlatformQuote, signature: Hex, imageProof: Hex[], regionProof: Hex[], permission: SpendPermission): Hex {
  return encodeFunctionData({ abi: spendPermissionEscrowAbi, functionName: 'openRunFromSpendPermission', args: [
    { ...quote, maxSeconds: BigInt(quote.maxSeconds), pricePerSecond: BigInt(quote.pricePerSecond),
      inferencePrice: BigInt(quote.inferencePrice), quoteExpiry: BigInt(quote.quoteExpiry) }, signature, imageProof, regionProof,
    typedSpendPermission(permission)] });
}
export function spendPermissionHash(chainId: number, manager: string, permission: SpendPermission): Hex {
  return hashTypedData({ domain: { name: 'Spend Permission Manager', version: '1', chainId, verifyingContract: addressSchema.parse(manager) },
    primaryType: 'SpendPermission', types: { SpendPermission: [
      { name: 'account', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'token', type: 'address' },
      { name: 'allowance', type: 'uint160' }, { name: 'period', type: 'uint48' }, { name: 'start', type: 'uint48' },
      { name: 'end', type: 'uint48' }, { name: 'salt', type: 'uint256' }, { name: 'extraData', type: 'bytes' },
    ] }, message: typedSpendPermission(permission) });
}
type LeashTerms = { agent: string; maxPerHour: bigint; maxPerDay: bigint; classMask: bigint;
  sealedOnly: boolean; imageAllowRoot: Hex; regionAllowRoot: Hex; expiry: bigint };
export function spendPermissionLeashTermsHash(leash: LeashTerms): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint96' }, { type: 'uint96' }, { type: 'uint64' },
    { type: 'bool' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint64' }],
  [addressSchema.parse(leash.agent), leash.maxPerHour, leash.maxPerDay, leash.classMask, leash.sealedOnly,
    leash.imageAllowRoot, leash.regionAllowRoot, leash.expiry]));
}
export function spendPermissionExtraData(chainId: number, escrow: string, account: string,
  refundBeneficiary: string, leashId: string, termsHash: Hex): Hex {
  return encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' },
    { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }], [SPEND_PERMISSION_LEASH_DOMAIN, BigInt(chainId),
    addressSchema.parse(escrow), addressSchema.parse(account), addressSchema.parse(refundBeneficiary), bytes32Schema.parse(leashId), termsHash]);
}
export async function checkSpendPermissionDeploymentAt(client: PublicClient, pins: PlatformPins, blockHash: Hex): Promise<void> {
  const profile = pins.spendPermissionProfile;
  if (!profile) return;
  if (pins.financialProfile || pins.chainId !== 31337 && !sameAddress(profile.managerAddress, SPEND_PERMISSION_MANAGER)) {
    throw new Error('Spend permission deployment profile is unsupported');
  }
  const state = { blockHash, requireCanonical: true } as const;
  const [code, manager, codeHash, managerType, escrowType, domain, escrowCode] = await Promise.all([
    client.getCode({ address: profile.managerAddress, ...state }),
    client.readContract({ address: pins.escrowAddress, abi: spendPermissionEscrowAbi, functionName: 'spendPermissionManager', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: spendPermissionEscrowAbi, functionName: 'spendPermissionManagerCodeHash', ...state }),
    client.readContract({ address: profile.managerAddress, abi: spendPermissionManagerAbi, functionName: 'SPEND_PERMISSION_TYPEHASH', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: spendPermissionEscrowAbi, functionName: 'SPEND_PERMISSION_TYPEHASH', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: spendPermissionEscrowAbi, functionName: 'eip712Domain', ...state }),
    client.getCode({ address: pins.escrowAddress, ...state }),
  ]);
  if (!code || keccak256(code) !== profile.managerCodeHash || !escrowCode || keccak256(escrowCode) !== pins.escrowCodeHash
    || !sameAddress(manager, profile.managerAddress)
    || codeHash !== profile.managerCodeHash || managerType !== SPEND_PERMISSION_TYPEHASH || escrowType !== SPEND_PERMISSION_TYPEHASH
    || domain[0] !== '0x0f' || domain[1] !== 'TelomerePlatformEscrow' || domain[2] !== '3'
    || domain[3] !== BigInt(pins.chainId) || !sameAddress(domain[4], pins.escrowAddress)
    || domain[5] !== '0x' + '0'.repeat(64) || domain[6].length !== 0) {
    throw new Error('Spend permission manager, code or signed type differs from reviewed pins');
  }
}
/** Planning observation only. It never adds a credit to escrow or treats a
 * permission as a reservation. The manager and Leash recheck atomically on spend. */
export async function readSpendPermissionFunding(client: PublicClient, pins: PlatformPins, payer: string,
  leashId: Hex, raw: unknown) {
  const funding = spendPermissionFundingSchema.parse(raw), permission = funding.permission, profile = pins.spendPermissionProfile;
  if (!profile || !sameAddress(permission.spender, pins.escrowAddress) || !sameAddress(permission.token, pins.tokenAddress)) {
    throw new Error('Spend permission funding requires its original reviewed escrow and USDC');
  }
  const head = await client.getBlockNumber({ cacheTime: 0 }), depth = pins.chainId === 31337 ? 0n : 12n;
  if (head < depth) throw new Error('Spend permission funding lacks confirmed history');
  const block = await client.getBlock({ blockNumber: head - depth }), state = { blockHash: block.hash, requireCanonical: true } as const;
  await checkPlatformAsset(client, pins, block.hash);
  await checkSpendPermissionDeploymentAt(client, pins, block.hash);
  const typed = typedSpendPermission(permission);
  const [valid, period, balance, leash, accountCode, payerCode, hash] = await Promise.all([
    client.readContract({ address: profile.managerAddress, abi: spendPermissionManagerAbi, functionName: 'isValid', args: [typed], ...state }),
    client.readContract({ address: profile.managerAddress, abi: spendPermissionManagerAbi, functionName: 'getCurrentPeriod', args: [typed], ...state }),
    client.readContract({ address: pins.tokenAddress, abi: tokenAbi, functionName: 'balanceOf', args: [permission.account], ...state }),
    client.readContract({ address: pins.escrowAddress, abi: leashAbi, functionName: 'getLeash', args: [leashId], ...state }),
    client.getCode({ address: addressSchema.parse(permission.account), ...state }), client.getCode({ address: addressSchema.parse(payer), ...state }),
    client.readContract({ address: profile.managerAddress, abi: spendPermissionManagerAbi, functionName: 'getHash', args: [typed], ...state }),
  ]);
  const now = Number(block.timestamp), start = permission.start + Math.floor((now - permission.start) / permission.period) * permission.period;
  const end = Math.min(permission.end, start + permission.period);
  if (!valid || !accountCode || accountCode === '0x' || payerCode && payerCode !== '0x'
    || !sameAddress(leash.owner, addressSchema.parse(payer)) || leash.killed || now < permission.start || now >= permission.end
    || period.start !== start || period.end !== end || period.spend > BigInt(permission.allowance)
    || hash !== spendPermissionHash(pins.chainId, profile.managerAddress, permission)
    || permission.extraData.toLowerCase() !== spendPermissionExtraData(pins.chainId, pins.escrowAddress,
      permission.account, payer, leashId, spendPermissionLeashTermsHash(leash))
    || (await client.getBlock({ blockNumber: block.number })).hash !== block.hash) {
    throw new Error('Spend permission approval, period, refund beneficiary or original Leash terms changed');
  }
  const remaining = BigInt(permission.allowance) - period.spend;
  return { available: (balance < remaining ? balance : remaining).toString(), fundingAccount: permission.account,
    refundBeneficiary: addressSchema.parse(payer), permissionHash: hash, periodStart: period.start, periodEnd: period.end,
    blockNumber: block.number, blockHash: block.hash };
}

/** Independent historical funded-opening check. Exact transaction calldata,
 * pinned escrow/manager code, original permission and per-transaction token
 * conservation are required, including after the permission expires. */
export async function verifySpendPermissionOpening(client: PublicClient, pins: PlatformPins, quote: PlatformQuote,
  ceiling: string, transactionHash: Hex, expectedFunding?: unknown): Promise<void> {
  if (!pins.spendPermissionProfile) throw new Error('Spend permission opening lacks reviewed pins');
  const [receipt, transaction] = await Promise.all([
    canonicalPlatformReceipt(client, pins, transactionHash, pins.escrowAddress), client.getTransaction({ hash: transactionHash }),
  ]);
  if (receipt.status !== 'success' || transaction.hash !== transactionHash || receipt.transactionHash !== transactionHash
    || !transaction.to || !sameAddress(transaction.to, pins.escrowAddress) || !receipt.to || !sameAddress(receipt.to, transaction.to)
    || transaction.blockHash !== receipt.blockHash || transaction.blockNumber !== receipt.blockNumber || transaction.value !== 0n
    || transaction.chainId !== pins.chainId || (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) {
    throw new Error('Spend permission opening is not a canonical exact escrow transaction');
  }
  const head = await client.getBlockNumber({ cacheTime: 0 });
  if (head < receipt.blockNumber || pins.chainId !== 31337 && head - receipt.blockNumber + 1n < 12n
    || receipt.logs.some(log => log.removed || log.transactionHash !== transactionHash
      || log.blockHash !== receipt.blockHash || log.blockNumber !== receipt.blockNumber)) {
    throw new Error('Spend permission funding lacks canonical confirmed transaction logs');
  }
  await checkSpendPermissionDeploymentAt(client, pins, receipt.blockHash);
  const code = await client.getCode({ address: pins.escrowAddress, blockHash: receipt.blockHash, requireCanonical: true });
  if (!code || keccak256(code) !== pins.escrowCodeHash) throw new Error('Spend permission opening escrow code changed');
  const call = decodeFunctionData({ abi: spendPermissionEscrowAbi, data: transaction.input });
  if (call.functionName !== 'openRunFromSpendPermission'
    || encodeFunctionData({ abi: spendPermissionEscrowAbi, functionName: call.functionName, args: call.args }) !== transaction.input) {
    throw new Error('Spend permission opening calldata is not canonical');
  }
  const [typedQuote, , , , typed] = call.args;
  const decodedQuote = { ...typedQuote, maxSeconds: Number(typedQuote.maxSeconds), pricePerSecond: typedQuote.pricePerSecond.toString(),
    inferencePrice: typedQuote.inferencePrice.toString(), quoteExpiry: Number(typedQuote.quoteExpiry) };
  const permission = spendPermissionSchema.parse({ ...typed, allowance: typed.allowance.toString(), salt: typed.salt.toString() });
  if (canonical(decodedQuote).toLowerCase() !== canonical(quote).toLowerCase()
    || expectedFunding && canonical(spendPermissionFundingSchema.parse(expectedFunding)).toLowerCase()
      !== canonical({ kind: 'base_spend_permission_v1', permission }).toLowerCase()) throw new Error('Spend permission opening changed original quote or funding approval');
  const hash = spendPermissionHash(pins.chainId, pins.spendPermissionProfile.managerAddress, permission);
  const run = await client.readContract({ address: pins.escrowAddress, abi: leashAbi, functionName: 'getRun', args: [quote.runId],
    blockHash: receipt.blockHash, requireCanonical: true });
  const openings = parseEventLogs({ abi: leashAbi, eventName: 'RunOpened', logs: receipt.logs.filter(log => sameAddress(log.address, pins.escrowAddress)) });
  const events = parseEventLogs({ abi: spendPermissionEscrowAbi, eventName: 'SpendPermissionRunFunded', logs: receipt.logs.filter(log => sameAddress(log.address, pins.escrowAddress)) });
  const event = events.find(value => value.args.runId === quote.runId);
  const used = parseEventLogs({ abi: spendPermissionManagerAbi, eventName: 'SpendPermissionUsed', logs: receipt.logs.filter(log => sameAddress(log.address, pins.spendPermissionProfile!.managerAddress)) });
  const transfers = parseEventLogs({ abi: tokenAbi, eventName: 'Transfer', logs: receipt.logs.filter(log => sameAddress(log.address, pins.tokenAddress)) });
  if (!event || events.length !== 1 || openings.length !== 1 || openings[0]!.args.runId !== quote.runId
    || openings[0]!.args.leashId !== quote.leashId || openings[0]!.args.hostId !== quote.hostId
    || !sameAddress(openings[0]!.args.payer, quote.payer) || openings[0]!.args.ceiling.toString() !== ceiling
    || openings[0]!.args.maxSeconds !== BigInt(quote.maxSeconds) || run.status === 0 || !sameAddress(run.payer, quote.payer)
    || run.leashId !== quote.leashId || run.hostId !== quote.hostId || run.hwClass !== quote.hwClass
    || run.regionHash !== quote.regionHash || run.imageHash !== quote.imageHash || run.workloadHash !== quote.workloadHash
    || run.maxSeconds !== BigInt(quote.maxSeconds) || run.pricePerSecond.toString() !== quote.pricePerSecond
    || run.inferencePrice.toString() !== quote.inferencePrice || run.ceiling.toString() !== ceiling
    || run.openedAt !== openings[0]!.args.openedAt
    || event.args.permissionHash !== hash || !sameAddress(event.args.fundingAccount, permission.account)
    || !sameAddress(event.args.refundBeneficiary, quote.payer) || event.args.amount.toString() !== ceiling
    || permission.extraData.toLowerCase() !== spendPermissionExtraData(pins.chainId, pins.escrowAddress, permission.account,
      quote.payer, quote.leashId, event.args.leashTermsHash)
    || used.length !== 1 || used[0]!.args.hash !== hash || !sameAddress(used[0]!.args.account, permission.account)
    || !sameAddress(used[0]!.args.spender, pins.escrowAddress) || !sameAddress(used[0]!.args.token, pins.tokenAddress)
    || used[0]!.args.periodSpend.spend.toString() !== ceiling
    || transfers.filter(value => sameAddress(value.args.from, permission.account) && sameAddress(value.args.to, pins.escrowAddress)
      && value.args.value.toString() === ceiling).length !== 1
    || transfers.filter(value => sameAddress(value.args.to, pins.escrowAddress)).reduce((sum, value) => sum + value.args.value, 0n) !== BigInt(ceiling)
    || transfers.some(value => sameAddress(value.args.from, pins.escrowAddress))
    || (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) {
    throw new Error('Spend permission opening lacks exact approved funding conservation');
  }
}
