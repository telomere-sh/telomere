import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAbiItem, keccak256, parseEventLogs, parseAbi,
  verifyTypedData, type Hex, type PublicClient } from 'viem';
import { bytes32Schema, sameAddress } from '../common.js';
import { tokenAbi } from '../chain/abi.js';
import { matchesAssetFacetPins, stableAssetFacetReceiptBlock } from '../payments/asset-facets.js';
import { matchesCircleProxyPins, matchesNativeBaseUsdcMetadata, stableCircleProxyReceiptBlock } from '../payments/circle-usdc.js';
import { platformEscrowAbi, platformHostRegistryAbi, platformPinsSchema, platformQuoteSchema,
  platformQuoteDomainVersion, platformQuoteTypes, typedPlatformQuote, type PlatformPins } from '../platform-runtime/types.js';
import { checkPlatformEconomicsAt, readPlatformFeeDiscount } from '../economics/profile.js';
import { platformV2EvidenceCoreSchema, platformV2HistoricalAuthoritySchema, verifyPlatformV2EvidenceCore,
  type PlatformV2HistoricalAuthority } from './platform-v2.js';

const routerAbi = parseAbi(['function token() view returns (address)', 'function controller() view returns (address)']);
const registryOpen = getAbiItem({ abi: parseAbi(['event RunOpened(bytes32 indexed hostId,bytes32 indexed runId)']), name: 'RunOpened' });
const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const vaultOpeningAbi = parseAbi([
  'struct PlatformQuote { bytes32 runId; bytes32 leashId; bytes32 hostId; address payer; uint16 hwClass; bytes32 regionHash; bytes32 imageHash; bytes32 workloadHash; uint64 maxSeconds; uint96 pricePerSecond; uint96 inferencePrice; uint64 quoteExpiry; }',
  'function payRun(PlatformQuote quote,bytes signature,bytes32[] imageProof,bytes32[] regionProof)',
]);
const vaultIdentityAbi = parseAbi([
  'struct Agent { uint256 identityId; address owner; address agentWallet; address vault; bytes32 leashId; bytes32 parent; bytes32 family; bytes32 cystHash; uint64 enteredAt; uint64 dormantAt; uint64 diedAt; uint64 lastPaidRun; uint64 lastActivationAt; uint64 deathAt; uint256 lifetimeIncome; uint256 lifetimeBurn; uint256 lifetimeSubsidy; uint256 lifetimeIncomeFees; uint8 livingChildren; uint8 status; bool frozen; }',
  'function vaultAgent(address) view returns (bytes32)', 'function getAgent(bytes32) view returns (Agent)',
  'function registry() view returns (address)', 'function escrow() view returns (address)', 'function token() view returns (address)',
  'function agentId() view returns (bytes32)', 'function leashId() view returns (bytes32)', 'function owner() view returns (address)',
]);

function decodedOpening(input: Hex, nested: boolean) {
  if (nested) {
    let call: ReturnType<typeof decodeFunctionData<typeof vaultOpeningAbi>>;
    try { call = decodeFunctionData({ abi: vaultOpeningAbi, data: input }); }
    catch { throw new Error('Platform v2 opening calldata cannot be decoded'); }
    if (encodeFunctionData({ abi: vaultOpeningAbi, functionName: 'payRun', args: call.args }) !== input) throw new Error('Platform v2 Vault opening calldata is not canonical');
    return call.args;
  }
  let call: ReturnType<typeof decodeFunctionData<typeof platformEscrowAbi>>;
  try { call = decodeFunctionData({ abi: platformEscrowAbi, data: input }); }
  catch { throw new Error('Platform v2 opening calldata cannot be decoded'); }
  if (call.functionName !== 'openRun') throw new Error('Platform v2 opening is not openRun');
  if (!same(encodeFunctionData({ abi: platformEscrowAbi, functionName: 'openRun', args: call.args }), input)) throw new Error('Platform v2 opening calldata is not canonical');
  return call.args;
}

export type PlatformV2OpeningAuthority = {
  authority: PlatformV2HistoricalAuthority;
  opening: { transactionHash: Hex; blockHash: Hex; blockNumber: bigint; logIndex: number; confirmations: bigint };
};

/** Recheck immediately before returning a public verdict; a block-hash read alone does not survive a reorg. */
export async function recheckPlatformV2Opening(client: PublicClient, opening: PlatformV2OpeningAuthority['opening'],
  minConfirmations: number): Promise<void> {
  if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 4096) {
    throw new Error('Platform v2 confirmation depth is invalid');
  }
  const [block, head] = await Promise.all([
    client.getBlock({ blockNumber: opening.blockNumber }), client.getBlockNumber({ cacheTime: 0 }),
  ]);
  if (!same(block.hash, opening.blockHash) || head < opening.blockNumber
    || head - opening.blockNumber + 1n < BigInt(minConfirmations)) {
    throw new Error('Platform v2 opening reorged or lacks confirmation depth');
  }
}

/** Read-only opening authority from a canonical, confirmed archive snapshot and exact openRun calldata. */
export async function readPlatformV2OpeningAuthority(client: PublicClient, rawPins: PlatformPins,
  rawHash: Hex, minConfirmations = 12): Promise<PlatformV2OpeningAuthority> {
  const pins = platformPinsSchema.parse(rawPins), hash = bytes32Schema.parse(rawHash);
  if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 4096)
    throw new Error('Platform v2 confirmation depth is invalid');
  if (await client.getChainId() !== pins.chainId) throw new Error('Platform v2 opening chain differs from reviewed pins');
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash }), client.getTransaction({ hash }),
  ]);
  if (receipt.transactionHash !== hash || transaction.hash !== hash || receipt.status !== 'success'
    || !receipt.to || !transaction.to || !same(receipt.to, transaction.to) || transaction.blockHash !== receipt.blockHash
    || transaction.blockNumber !== receipt.blockNumber || !same(transaction.from, receipt.from)
    || transaction.chainId !== pins.chainId || transaction.value !== 0n
    || receipt.blockNumber === 0n) {
    throw new Error('Platform v2 opening transaction is not a successful exact escrow or reviewed Vault call');
  }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (!same(block.hash, receipt.blockHash)) throw new Error('Platform v2 opening block is not canonical');
  const opening = { transactionHash: hash, blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber, logIndex: 0, confirmations: 0n };
  await recheckPlatformV2Opening(client, opening, minConfirmations);
  const nestedVault = !same(transaction.to, pins.escrowAddress);
  if (nestedVault && !pins.financialProfile?.discountVaultRegistry) throw new Error('Platform v2 nested Vault opening lacks reviewed factory and implementation pins');
  const decoded = decodedOpening(transaction.input, nestedVault);
  const [typedQuote, signature] = decoded;
  const quote = platformQuoteSchema.parse({ ...typedQuote,
    maxSeconds: Number(typedQuote.maxSeconds), pricePerSecond: typedQuote.pricePerSecond.toString(),
    inferencePrice: typedQuote.inferencePrice.toString(), quoteExpiry: Number(typedQuote.quoteExpiry) });
  if (nestedVault) {
    const configured = pins.financialProfile!.discountVaultRegistry!, state = { blockHash: receipt.blockHash, requireCanonical: true } as const;
    await checkPlatformEconomicsAt(client, pins, receipt.blockHash);
    const clone = `0x363d3d373d3d3d363d73${configured.implementationAddress.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    const code = await client.getCode({ address: transaction.to, ...state });
    if (!same(quote.payer, transaction.to) || !code || !same(code, clone)) throw new Error('Platform v2 nested payer is not the reviewed canonical Vault clone');
    const agentId = await client.readContract({ address: configured.address, abi: vaultIdentityAbi,
      functionName: 'vaultAgent', args: [transaction.to], ...state });
    if (agentId === `0x${'0'.repeat(64)}`) throw new Error('Platform v2 nested payer is absent from the reviewed factory');
    const [agent, owner, leashId, cloneId, cloneRegistry, cloneEscrow, cloneToken] = await Promise.all([
      client.readContract({ address: configured.address, abi: vaultIdentityAbi, functionName: 'getAgent', args: [agentId], ...state }),
      client.readContract({ address: transaction.to, abi: vaultIdentityAbi, functionName: 'owner', ...state }),
      client.readContract({ address: transaction.to, abi: vaultIdentityAbi, functionName: 'leashId', ...state }),
      client.readContract({ address: transaction.to, abi: vaultIdentityAbi, functionName: 'agentId', ...state }),
      client.readContract({ address: transaction.to, abi: vaultIdentityAbi, functionName: 'registry', ...state }),
      client.readContract({ address: transaction.to, abi: vaultIdentityAbi, functionName: 'escrow', ...state }),
      client.readContract({ address: transaction.to, abi: vaultIdentityAbi, functionName: 'token', ...state }),
    ]);
    if (!same(agent.vault, quote.payer) || !same(agent.owner, owner) || agent.leashId !== quote.leashId || leashId !== quote.leashId
      || cloneId !== agentId || agent.status !== 1 || agent.frozen || !same(cloneRegistry, configured.address)
      || !same(cloneEscrow, pins.escrowAddress) || !same(cloneToken, pins.tokenAddress)) {
      throw new Error('Platform v2 nested Vault binding differs from its reviewed original factory entry');
    }
  }
  const opens = parseEventLogs({ abi: platformEscrowAbi, eventName: 'RunOpened',
    logs: receipt.logs.filter(log => same(log.address, pins.escrowAddress)), strict: true });
  if (opens.length !== 1 || opens[0]?.logIndex === null || opens[0]?.logIndex === undefined) {
    throw new Error('Platform v2 opening event is missing or ambiguous');
  }
  const event = opens[0]!;
  const registryOpens = parseEventLogs({ abi: [registryOpen], eventName: 'RunOpened',
    logs: receipt.logs.filter(log => same(log.address, pins.hostRegistryAddress)), strict: true });
  if (event.transactionHash !== hash || event.blockHash !== receipt.blockHash
    || event.blockNumber !== receipt.blockNumber || registryOpens.length !== 1
    || registryOpens[0]!.transactionHash !== hash || registryOpens[0]!.blockHash !== receipt.blockHash
    || registryOpens[0]!.blockNumber !== receipt.blockNumber
    || registryOpens[0]!.args.hostId !== quote.hostId
    || registryOpens[0]!.args.runId !== quote.runId || registryOpens[0]!.logIndex >= event.logIndex
    || event.args.runId !== quote.runId || event.args.leashId !== quote.leashId
    || event.args.hostId !== quote.hostId || !sameAddress(event.args.payer, quote.payer)
    || event.args.maxSeconds !== BigInt(quote.maxSeconds) || event.args.openedAt !== block.timestamp
    || quote.quoteExpiry < Number(block.timestamp)) {
    throw new Error('Platform v2 opening events or quote expiry differ from canonical calldata');
  }
  const state = { blockHash: receipt.blockHash, requireCanonical: true } as const;
  const codePins = [
    [pins.escrowAddress, pins.escrowCodeHash], [pins.hostRegistryAddress, pins.hostRegistryCodeHash],
    [pins.receiptRootAddress, pins.receiptRootCodeHash], [pins.feeRouterAddress, pins.feeRouterCodeHash],
    [pins.tokenAddress, pins.tokenCodeHash],
  ] as const;
  const codes = await Promise.all(codePins.map(([address]) => client.getCode({ address, ...state })));
  if (codes.some((code, index) => !code || code === '0x' || keccak256(code) !== codePins[index]![1])) {
    throw new Error('Platform v2 opening historical contract code differs from reviewed pins');
  }
  if (pins.reviewedTokenKind === 'eip1967') {
    const implementation = pins.assetImplementation!;
    const [slot, code] = await Promise.all([
      client.getStorageAt({ address: pins.tokenAddress, slot: implementationSlot, ...state }),
      client.getCode({ address: implementation.address, ...state }),
    ]);
    if (!slot || !same(`0x${slot.slice(-40)}`, implementation.address)
      || !code || keccak256(code) !== implementation.codeHash) {
      throw new Error('Platform v2 opening historical asset implementation differs from reviewed pins');
    }
    if (pins.assetFacet && (!await matchesAssetFacetPins(client, pins.tokenAddress, pins.assetFacet, state)
      || !await stableAssetFacetReceiptBlock(client, pins.tokenAddress, pins.assetFacet,
        receipt.blockHash, receipt.blockNumber))) {
      throw new Error('Platform v2 opening historical asset facet differs from reviewed pins');
    }
  }
  if (pins.reviewedTokenKind === 'circle_proxy' && (!pins.assetImplementation
    || !await matchesCircleProxyPins(client, pins.tokenAddress, pins.assetImplementation, state)
    || !await matchesNativeBaseUsdcMetadata(client, pins.chainId, pins.tokenAddress, state)
    || !await stableCircleProxyReceiptBlock(client, pins.tokenAddress, pins.tokenCodeHash,
      pins.assetImplementation, receipt.blockHash, receipt.blockNumber))) {
    throw new Error('Platform v2 opening historical Circle USDC implementation or domain differs from reviewed pins');
  }
  const [run, host, signer, token, registry, roots, router, registryToken, registryController,
    registryRoot, routerToken, routerController, decimals] = await Promise.all([
    client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'getRun', args: [quote.runId], ...state }),
    client.readContract({ address: pins.hostRegistryAddress, abi: platformHostRegistryAbi, functionName: 'getHost', args: [quote.hostId], ...state }),
    client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'quoteSigner', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'token', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'hostRegistry', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'receiptRoot', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'feeRouter', ...state }),
    client.readContract({ address: pins.hostRegistryAddress, abi: platformHostRegistryAbi, functionName: 'token', ...state }),
    client.readContract({ address: pins.hostRegistryAddress, abi: platformHostRegistryAbi, functionName: 'controller', ...state }),
    client.readContract({ address: pins.hostRegistryAddress, abi: platformHostRegistryAbi, functionName: 'evidenceRoot', ...state }),
    client.readContract({ address: pins.feeRouterAddress, abi: routerAbi, functionName: 'token', ...state }),
    client.readContract({ address: pins.feeRouterAddress, abi: routerAbi, functionName: 'controller', ...state }),
    client.readContract({ address: pins.tokenAddress, abi: tokenAbi, functionName: 'decimals', ...state }),
  ]);
  if (![[signer, pins.quoteSigner], [token, pins.tokenAddress], [registry, pins.hostRegistryAddress],
    [roots, pins.receiptRootAddress], [router, pins.feeRouterAddress], [registryToken, pins.tokenAddress],
    [registryController, pins.escrowAddress], [registryRoot, pins.receiptRootAddress],
    [routerToken, pins.tokenAddress], [routerController, pins.escrowAddress]].every(([actual, expected]) =>
      same(actual!, expected!)) || decimals !== 6 || host.hostKey === `0x${'0'.repeat(64)}`
    || keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' },
      { type: 'address' }, { type: 'bytes32' }],
    [BigInt(pins.chainId), pins.hostRegistryAddress, host.operator, host.hostKey])) !== quote.hostId
    || !same(host.operator, run.hostOperator) || run.sealedHost || host.kind === 2 || run.hwClass !== 0
    || !same(run.payer, quote.payer) || run.leashId !== quote.leashId || run.hostId !== quote.hostId
    || run.regionHash !== quote.regionHash || run.imageHash !== quote.imageHash
    || run.workloadHash !== quote.workloadHash || run.maxSeconds !== BigInt(quote.maxSeconds)
    || run.pricePerSecond !== BigInt(quote.pricePerSecond) || run.inferencePrice !== BigInt(quote.inferencePrice)
    || run.openedAt !== event.args.openedAt || run.ceiling !== event.args.ceiling
    || run.acceptedExpiry < run.openedAt || run.status === 0) {
    throw new Error('Platform v2 opening historical state differs from signed quote and reviewed pins');
  }
  let validQuoteSignature = false;
  try { validQuoteSignature = await verifyTypedData({ address: signer,
    domain: { name: 'TelomerePlatformEscrow', version: platformQuoteDomainVersion(pins), chainId: pins.chainId,
      verifyingContract: pins.escrowAddress }, types: platformQuoteTypes,
    primaryType: 'PlatformQuote', message: typedPlatformQuote(quote), signature }); }
  catch { /* A malformed ECDSA signature is an invalid quote, not an RPC error. */ }
  if (!validQuoteSignature) {
    throw new Error('Platform v2 opening quote signature is invalid');
  }
  const authority = platformV2HistoricalAuthoritySchema.parse({
    ...(pins.financialProfile ? { quoteDomainVersion: '2',
      feeDiscountBps: await readPlatformFeeDiscount(client, pins, quote.runId, receipt.blockHash) } : {}),
    chainId: pins.chainId, escrow: pins.escrowAddress, hostRegistry: pins.hostRegistryAddress,
    quoteSigner: signer, runId: quote.runId, hostId: quote.hostId, hostKey: host.hostKey,
    payer: run.payer, leashId: run.leashId, hwClass: 0, regionHash: run.regionHash,
    imageHash: run.imageHash, workloadHash: run.workloadHash,
    pricePerSecond: run.pricePerSecond.toString(), inferencePrice: run.inferencePrice.toString(),
    quoteExpiry: quote.quoteExpiry, maxSeconds: Number(run.maxSeconds), openedAt: Number(run.openedAt),
    cutoff: Number(run.openedAt + run.maxSeconds < run.acceptedExpiry
      ? run.openedAt + run.maxSeconds : run.acceptedExpiry),
  });
  opening.logIndex = event.logIndex;
  opening.confirmations = (await client.getBlockNumber({ cacheTime: 0 })) - opening.blockNumber + 1n;
  await recheckPlatformV2Opening(client, opening, minConfirmations);
  return { authority, opening };
}

/** Archive-backed cryptographic opening check. Settlement/root publication remains a separate verifier. */
export async function verifyPlatformV2OpeningEvidence(client: PublicClient, pins: PlatformPins,
  openTransactionHash: Hex, core: unknown, expectedReceiptHash: string, minConfirmations = 12) {
  const result = await readPlatformV2OpeningAuthority(client, pins, openTransactionHash, minConfirmations);
  const parsedCore = platformV2EvidenceCoreSchema.parse(core);
  if (parsedCore.hostAdmission && (parsedCore.hostAdmission.body.admissionTx !== result.opening.transactionHash
    || parsedCore.hostAdmission.body.openingBlockHash !== result.opening.blockHash)) {
    throw new Error('Platform v2 host admission differs from the canonical opening transaction');
  }
  const verified = await verifyPlatformV2EvidenceCore(parsedCore, expectedReceiptHash, result.authority);
  await recheckPlatformV2Opening(client, result.opening, minConfirmations);
  return { ...verified, historicalAuthoritySource: 'archive-rpc' as const,
    ...(pins.financialProfile ? { quoteDomainVersion: '2' as const, feeDiscountBps: result.authority.feeDiscountBps! } : {}),
    opening: result.opening, onchainReceiptVerified: false as const };
}
