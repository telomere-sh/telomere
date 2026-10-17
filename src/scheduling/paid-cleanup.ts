import { Problem } from '../common.js';
import { billableHostInterval } from '../host-kit/meter.js';
import { hostMessageHash, signedAckSchema, signedTickSchema, verifyHostMessage,
  type SignedHostLease } from '../host-kit/protocol.js';

/** Controller-retained HostKit evidence. This is not independent TEE testimony. */
export function assertPaidCpuCleanup(input: { lease: SignedHostLease; controllerKey: string; hostKey: string;
  cleanupConfirmed: number; ticks: unknown[]; acknowledgments: unknown[]; billableSeconds: number }) {
  const { lease, controllerKey, hostKey } = input;
  if (!input.cleanupConfirmed || lease.body.hostKey !== hostKey || !verifyHostMessage(controllerKey, 'lease', lease)
    || !input.ticks.length || input.ticks.length > 100 || input.ticks.length !== input.acknowledgments.length) {
    throw new Problem(409, 'paid_cpu_cleanup_unconfirmed', 'Original signed paid CPU cleanup is unavailable.');
  }
  const leaseHash = hostMessageHash({ body: lease.body, signature: '' });
  let previous: ReturnType<typeof signedTickSchema.parse> | undefined, total = 0;
  for (let index = 0; index < input.ticks.length; index++) {
    const tick = signedTickSchema.parse(input.ticks[index]), ack = signedAckSchema.parse(input.acknowledgments[index]);
    const delta = billableHostInterval(previous, tick, total, lease.body.maxSeconds);
    if (!verifyHostMessage(hostKey, 'tick', tick) || !verifyHostMessage(controllerKey, 'ack', ack)
      || tick.body.hostKey !== hostKey || tick.body.runId !== lease.body.runId || tick.body.owner !== lease.body.owner
      || tick.body.leaseHash !== leaseHash || tick.body.sequence !== index
      || tick.body.previousHash !== (previous ? hostMessageHash(previous) : null)
      || previous && (previous.body.state !== 'RUNNING' || tick.body.timestamp <= previous.body.timestamp
        || tick.body.elapsedMs < previous.body.elapsedMs || tick.body.cpuMs < previous.body.cpuMs)
      || tick.body.timestamp < lease.body.issuedAt - 5000 || tick.body.timestamp > lease.body.expiresAt + 5000
      || tick.body.elapsedMs > lease.body.maxSeconds * 1000
      || ack.body.hostKey !== hostKey || ack.body.runId !== lease.body.runId || ack.body.leaseHash !== leaseHash
      || ack.body.sequence !== index || ack.body.tickHash !== hostMessageHash(tick)
      || ack.body.billableDelta !== delta || ack.body.billableSeconds !== total + delta
      || Math.abs(ack.body.acceptedAt - tick.body.timestamp) > 5000) {
      throw new Problem(409, 'paid_cpu_cleanup_changed', 'Original paid CPU signed terminal evidence changed.');
    }
    total += delta; previous = tick;
  }
  if (!previous || previous.body.state === 'RUNNING' || total !== input.billableSeconds) {
    throw new Problem(409, 'paid_cpu_cleanup_unconfirmed', 'Paid CPU cleanup requires a retained final host tick and matching charge.');
  }
  return previous;
}
