import { z } from 'zod';
import { bytes32Schema } from '../common.js';
import { hostKeySchema } from './protocol.js';

/** Public host testimony about an exact private authorization envelope. */
export const hostV2AdmissionReceiptSchema = z.object({
  body: z.object({
    version: z.literal(2), chainId: z.union([z.literal(31337), z.literal(8453), z.literal(84532)]),
    escrow: z.string().regex(/^0x[0-9a-fA-F]{40}$/), hostRegistry: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    runId: bytes32Schema, hostId: bytes32Schema, hostKey: hostKeySchema,
    controllerKey: hostKeySchema, owner: z.string().regex(/^0x[0-9a-f]{40}$/),
    admissionTx: bytes32Schema, openingBlockHash: bytes32Schema,
    quoteHash: bytes32Schema, signedLeaseHash: bytes32Schema,
    meterLeaseHash: bytes32Schema, delegationHash: bytes32Schema,
    envelopeHash: bytes32Schema, acceptedAtMs: z.number().int().positive().safe(),
  }).strict(),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();
export type SignedHostV2AdmissionReceipt = z.infer<typeof hostV2AdmissionReceiptSchema>;
