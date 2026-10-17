import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { addressSchema, bytes32Schema, Problem, sameAddress } from '../common.js';
import type { Config } from '../config.js';
import type { Service } from '../service.js';

export const AKASH_MIN_CONSOLE_RUNTIME_SECONDS = 3_600;
const MAX_PROFILE_BYTES = 2_048;
const profileSchema = z.object({
  version: z.literal(1), mode: z.literal('readiness_only'), chainId: z.number().int().positive(),
  escrowAddress: addressSchema, leaseCreationEnabled: z.literal(false),
}).strict();

function regularProfile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n
    || stat.size > BigInt(MAX_PROFILE_BYTES) || process.platform !== 'win32' && (stat.mode & 0o077n) !== 0n) {
    throw new Error('Reviewed Akash readiness profile is unavailable');
  }
}
function unchanged(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}
async function profileText(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Reviewed Akash readiness profile requires an absolute path');
  const before = await lstat(path, { bigint: true }); regularProfile(before);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await file.stat({ bigint: true }); regularProfile(opened);
    if (!unchanged(before, opened)) throw new Error('Reviewed Akash readiness profile changed during open');
    const bytes = Buffer.alloc(MAX_PROFILE_BYTES + 1); let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    regularProfile(after); regularProfile(named);
    if (length !== Number(opened.size) || !unchanged(opened, after) || !unchanged(after, named)) {
      throw new Error('Reviewed Akash readiness profile changed during read');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await file.close(); }
}

/** A controller-owned eligibility proof. This class has no Console client, writer, or treasury authority. */
export class AkashControllerReadiness {
  constructor(private readonly service: Service) {}

  async run(ownerValue: string, idValue: string) {
    const owner = addressSchema.parse(ownerValue), id = bytes32Schema.parse(idValue);
    const job = await this.service.requireJob(owner, id);
    const escrow = await this.service.bridge.run(id);
    if (escrow.status !== 0 && (!sameAddress(escrow.payer, owner) || escrow.leashId !== job.quote.leashId
      || escrow.workloadHash !== job.quote.workloadHash || escrow.maxSeconds !== BigInt(job.quote.maxSeconds)
      || escrow.pricePerSecond !== BigInt(job.quote.pricePerSecond)
      || escrow.inferencePrice !== BigInt(job.quote.inferencePrice) || escrow.ceiling !== BigInt(job.ceiling))) {
      throw new Problem(409, 'supplier_run_terms_mismatch', 'Onchain run terms differ from the controller quote.');
    }
    const maxRunSeconds = escrow.status === 0 ? job.quote.maxSeconds : Number(escrow.maxSeconds);
    const blockers = [
      ...(job.status === 'prepared' ? ['run_not_admitted'] : []),
      ...(escrow.status !== 1 ? ['escrow_not_open'] : []),
      ...(maxRunSeconds < AKASH_MIN_CONSOLE_RUNTIME_SECONDS ? ['runtime_too_short'] : []),
      'treasury_snapshot_unavailable', 'lease_creation_disabled',
    ];
    return { network: 'akash' as const, runId: id, controllerRunState: job.status,
      escrowOpen: escrow.status === 1, maxRunSeconds, minConsoleRuntimeSeconds: AKASH_MIN_CONSOLE_RUNTIME_SECONDS,
      leaseCreationEnabled: false as const, eligible: false as const, blockers,
      meterEligible: false as const, billableSeconds: 0 as const };
  }
}

/** Default off; only a pinned, read-only operator profile can mount this proof route. */
export async function configuredAkashReadiness(config: Config, service: Service): Promise<AkashControllerReadiness | undefined> {
  if (!config.AKASH_READINESS_CONFIG) return undefined;
  try {
    const profile = profileSchema.parse(JSON.parse(await profileText(config.AKASH_READINESS_CONFIG)) as unknown);
    if (profile.chainId !== config.CHAIN_ID || !sameAddress(profile.escrowAddress, config.ESCROW_ADDRESS)) {
      throw new Error('Reviewed Akash readiness profile has different escrow pins');
    }
    return new AkashControllerReadiness(service);
  } catch { throw new Error('Akash readiness configuration is unavailable or cannot enable lease creation'); }
}
