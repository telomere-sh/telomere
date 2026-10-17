import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAbiItem, keccak256, parseAbi, parseEventLogs,
  type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson, sameAddress } from '../common.js';
import { verifyReceiptPath } from '../receipts/merkle.js';
import { verifiedWorkActivitySchema, type VerifiedWorkActivity, type WorkActivityVerifier } from './work-allocation.js';

const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(value => BigInt(value) < 1n << 256n);
export const committedWorkObservationSchema = z.object({
  protocol: z.literal('telomere-work-observation-v1'), kind: z.enum(['probe', 'verification', 'storage']),
  sourceReceiptId: bytes32Schema, recipient: addressSchema, units: uint.refine(value => BigInt(value) > 0n),
  week: z.number().int().nonnegative().safe(), endedAt: z.number().int().positive().safe(),
  evidenceDigest: bytes32Schema, policyDigest: bytes32Schema,
}).strict().refine(value => Math.floor(value.endedAt / 604800) === value.week, 'Work observation is outside its declared week');
export const committedWorkVerifierPolicySchema = z.object({ chainId: z.number().int().positive().safe(),
  receiptRoot: addressSchema, receiptRootCodeHash: bytes32Schema, signerSet: addressSchema, signerSetCodeHash: bytes32Schema,
  approvedPolicyDigest: bytes32Schema, minConfirmations: z.number().int().min(1).max(128) }).strict();
const handleSchema = z.object({ observation: committedWorkObservationSchema, rootTransactionHash: bytes32Schema,
  proof: z.array(bytes32Schema).max(12) }).strict();
const abi = parseAbi(['struct Root { bytes32 root; uint32 count; address signer; uint64 postedAt; }',
  'function postRoot(uint64 hour,bytes32 root,uint32 count)', 'function getRoot(uint64 hour) view returns (Root)',
  'function signerSet() view returns (address)', 'function currentSigner() view returns (address)',
  'event RootPosted(uint64 indexed hour,bytes32 indexed root,uint32 count,address indexed signer)']);
const rootEvent = getAbiItem({ abi, name: 'RootPosted' });
const kinds = { probe: 1, verification: 2, storage: 3 } as const;

export function committedWorkLeaf(raw: z.infer<typeof committedWorkObservationSchema>,
  rawPolicy: z.infer<typeof committedWorkVerifierPolicySchema>): Hex {
  const observation = committedWorkObservationSchema.parse(raw), policy = committedWorkVerifierPolicySchema.parse(rawPolicy);
  if (observation.policyDigest !== policy.approvedPolicyDigest) throw new Error('Work measurement policy was not approved');
  return keccak256(keccak256(encodeAbiParameters([
    { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint8' },
    { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'bytes32' },
  ], [keccak256(new TextEncoder().encode('telomere-work-observation-v1')), BigInt(policy.chainId), policy.receiptRoot,
    observation.policyDigest, kinds[observation.kind], observation.sourceReceiptId, observation.recipient,
    BigInt(observation.units), BigInt(observation.week), BigInt(observation.endedAt), observation.evidenceDigest])));
}

/** Verifies publisher-accepted non-compute observations against a reviewed
 * historical ReceiptRoot. The committed units are trusted measurement testimony;
 * this does not turn a signature into independent physical resource proof. */
export class CanonicalCommittedWorkVerifier implements WorkActivityVerifier {
  readonly policy: z.infer<typeof committedWorkVerifierPolicySchema>;
  private readonly handles = new Map<string, z.infer<typeof handleSchema>>();
  constructor(private readonly client: PublicClient, rawPolicy: z.infer<typeof committedWorkVerifierPolicySchema>) {
    this.policy = committedWorkVerifierPolicySchema.parse(rawPolicy);
  }
  async read(raw: unknown): Promise<VerifiedWorkActivity> {
    const handle = handleSchema.parse(raw), observation = handle.observation, policy = this.policy;
    const leaf = committedWorkLeaf(observation, policy);
    if (await this.client.getChainId() !== policy.chainId) throw new Error('Work receipt chain differs');
    const [receipt, transaction, head] = await Promise.all([
      this.client.getTransactionReceipt({ hash: handle.rootTransactionHash }),
      this.client.getTransaction({ hash: handle.rootTransactionHash }), this.client.getBlockNumber({ cacheTime: 0 }),
    ]);
    if (receipt.status !== 'success' || !receipt.to || !transaction.to
      || !sameAddress(receipt.to, policy.receiptRoot) || !sameAddress(transaction.to, policy.receiptRoot)
      || receipt.transactionHash !== handle.rootTransactionHash || transaction.hash !== handle.rootTransactionHash
      || transaction.blockHash !== receipt.blockHash || transaction.chainId !== policy.chainId || transaction.value !== 0n
      || head < receipt.blockNumber || head - receipt.blockNumber + 1n < BigInt(policy.minConfirmations)) throw new Error('Work root transaction is not confirmed canonical publication');
    const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash) throw new Error('Work root block is no longer canonical');
    const state = { blockHash: receipt.blockHash, requireCanonical: true } as const;
    for (const [address, expected] of [[policy.receiptRoot, policy.receiptRootCodeHash], [policy.signerSet, policy.signerSetCodeHash]] as const) {
      const code = await this.client.getCode({ address, ...state });
      if (!code || code === '0x' || keccak256(code) !== expected) throw new Error('Work root historical code differs from approved pins');
    }
    const call = decodeFunctionData({ abi, data: transaction.input });
    const hour = BigInt(Math.floor(observation.endedAt / 3600));
    if (call.functionName !== 'postRoot' || call.args[0] !== hour || call.args[2] < 1
      || encodeFunctionData({ abi, functionName: 'postRoot', args: call.args }) !== transaction.input
      || hour >= block.timestamp / 3600n) throw new Error('Work root calldata is not exact closed-hour publication');
    const [root, set, signer] = await Promise.all([
      this.client.readContract({ address: policy.receiptRoot, abi, functionName: 'getRoot', args: [hour], ...state }),
      this.client.readContract({ address: policy.receiptRoot, abi, functionName: 'signerSet', ...state }),
      this.client.readContract({ address: policy.signerSet, abi, functionName: 'currentSigner', ...state }),
    ]);
    const events = parseEventLogs({ abi: [rootEvent], eventName: 'RootPosted',
      logs: receipt.logs.filter(log => sameAddress(log.address, policy.receiptRoot)), strict: true });
    if (!sameAddress(set, policy.signerSet) || !sameAddress(transaction.from, signer)
      || !sameAddress(root.signer, signer) || root.root !== call.args[1] || root.count !== call.args[2]
      || root.postedAt !== block.timestamp || events.length !== 1 || events[0]!.args.hour !== hour
      || events[0]!.args.root !== root.root || events[0]!.args.count !== root.count
      || !sameAddress(events[0]!.args.signer, signer) || !verifyReceiptPath(leaf, handle.proof, root.root)) {
      throw new Error('Work observation is absent from the approved canonical publisher commitment');
    }
    if ((await this.client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Work root changed during verification');
    const activity = verifiedWorkActivitySchema.parse({ kind: observation.kind,
      receiptId: observation.sourceReceiptId, recipient: observation.recipient, units: observation.units,
      week: observation.week, chainId: policy.chainId, blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash, evidenceDigest: hashJson({ observation, leaf, rootTransactionHash: handle.rootTransactionHash }) });
    this.handles.set(activity.receiptId, handle); return activity;
  }
  async recheck(activity: VerifiedWorkActivity): Promise<void> {
    const handle = this.handles.get(activity.receiptId);
    if (!handle || hashJson(await this.read(handle)) !== hashJson(activity)) throw new Error('Committed work observation changed before allocation');
  }
}
