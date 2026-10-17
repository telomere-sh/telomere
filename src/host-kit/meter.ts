import { HOST_TICK_MS, ackSchema, hostMessageHash, leaseSchema, signedTickSchema, verifyHostMessage,
  type Ed25519Identity, type HostLease, type SignedHostAck, type SignedHostTick } from './protocol.js';

export type HostMeterState = { leaseHash: string; previous: SignedHostTick | null; billableSeconds: number; fault: boolean };
export function billableHostInterval(previous: SignedHostTick | undefined, current: SignedHostTick, total: number, ceiling: number): number {
  if (!previous) return 0;
  const a = previous.body, b = current.body;
  const fresh = (item: typeof b) => item.heartbeat !== null && item.heartbeat.receivedAt <= item.timestamp
    && item.timestamp - item.heartbeat.receivedAt <= 2500 && item.heartbeat.elapsedMs <= item.elapsedMs + 1000;
  if (a.state !== 'RUNNING' || b.state !== 'RUNNING' || !fresh(a) || !fresh(b) || b.heartbeat!.sequence <= a.heartbeat!.sequence
    || b.timestamp - a.timestamp < 2500 || b.timestamp - a.timestamp > 7500 || b.elapsedMs - a.elapsedMs > 7500
    || b.elapsedMs - a.elapsedMs > b.timestamp - a.timestamp + 1000) return 0;
  return Math.min(Math.max(0, Math.floor(b.elapsedMs / 1000) - Math.ceil(a.elapsedMs / 1000)), ceiling - total);
}
/** Control-plane evidence verifier. Host claims alone never create billable time. */
export class HostMeterVerifier {
  readonly lease: HostLease;
  private previous: SignedHostTick | null = null;
  private billable = 0;
  private faulted = false;
  constructor(lease: HostLease, private readonly control: Ed25519Identity, private readonly clock: () => number = Date.now,
    restored?: HostMeterState) {
    this.lease = leaseSchema.parse(lease);
    if (restored) {
      if (restored.leaseHash !== hostMessageHash({ body: this.lease, signature: '' }) || !Number.isSafeInteger(restored.billableSeconds)
        || restored.billableSeconds < 0 || restored.billableSeconds > this.lease.maxSeconds) throw new Error('Invalid persisted meter state');
      if (restored.previous) this.validate(restored.previous);
      this.previous = restored.previous; this.billable = restored.billableSeconds; this.faulted = restored.fault;
    }
  }
  private validate(value: unknown): SignedHostTick {
    const tick = signedTickSchema.parse(value), body = tick.body;
    if (!verifyHostMessage(this.lease.hostKey, 'tick', tick) || body.hostKey !== this.lease.hostKey
      || body.runId !== this.lease.runId || body.owner !== this.lease.owner || body.leaseHash !== this.leaseHash
      || body.elapsedMs > this.lease.maxSeconds * 1000) throw new Error('Host tick scope or signature rejected');
    return tick;
  }
  get leaseHash(): `0x${string}` { return hostMessageHash({ body: this.lease, signature: '' }); }
  get billableSeconds(): number { return this.billable; }
  get fault(): boolean { return this.faulted; }
  exportState(): HostMeterState { return { leaseHash: this.leaseHash, previous: this.previous, billableSeconds: this.billable, fault: this.faulted }; }
  missing(now = this.clock()): boolean {
    const since = this.previous?.body.timestamp ?? this.lease.issuedAt;
    if (now - since >= HOST_TICK_MS * 3) this.faulted = true;
    return this.faulted;
  }
  accept(value: unknown): SignedHostAck {
    if (this.missing()) throw new Error('Three meter ticks were missed');
    const tick = this.validate(value), body = tick.body, now = this.clock(), previous = this.previous?.body;
    if (this.faulted || Math.abs(now - body.timestamp) > 5000 || body.timestamp < this.lease.issuedAt - 5000
      || body.timestamp > this.lease.expiresAt + 5000 || body.sequence !== (previous ? previous.sequence + 1 : 0)
      || body.previousHash !== (this.previous ? hostMessageHash(this.previous) : null)) throw new Error('Host tick replay, chain, or clock rejected');
    if (previous && (previous.state !== 'RUNNING' || body.timestamp <= previous.timestamp || body.elapsedMs < previous.elapsedMs || body.cpuMs < previous.cpuMs
      || body.elapsedMs - previous.elapsedMs > body.timestamp - previous.timestamp + 1000)) throw new Error('Host tick counters must increase monotonically');
    const delta = billableHostInterval(this.previous ?? undefined, tick, this.billable, this.lease.maxSeconds);
    if (body.state === 'FAULT') this.faulted = true;
    this.billable += delta; this.previous = tick;
    return this.control.sign('ack', ackSchema.parse({ version: 1, hostKey: this.lease.hostKey, runId: this.lease.runId,
      leaseHash: this.leaseHash, sequence: body.sequence, tickHash: hostMessageHash(tick), acceptedAt: now,
      billableSeconds: this.billable, billableDelta: delta, fault: this.faulted }));
  }
}
