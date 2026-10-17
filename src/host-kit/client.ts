import { z } from 'zod';
import { Problem, hashJson, randomId } from '../common.js';
import { HostMeterVerifier } from './meter.js';
import { Ed25519Identity, capacityResponseSchema, hostMessageHash, imageDigestSchema, leaseSchema, signedAckSchema, signedTickSchema, verifyHostMessage,
  type HostLease, type SignedHostAck, type SignedHostLease, type SignedHostTick } from './protocol.js';
import { RunMeter } from '../runtime/meter.js';
import { cpuRunInputSchema, type CpuExecutor, type CpuRunInput, type CpuRunResult, type TickHandler } from '../runtime/types.js';
import { paidSessionControlSchema, paidSessionStatusSchema, type PaidSessionControl } from './sessions/paid-protocol.js';
import { parsePaidSessionLease } from './sessions/paid-protocol.js';
import { cystInputBindingSchema, cystInputDescriptorHash, signedCystInputResultSchema,
  type SignedCystInputResult } from './sessions/cyst-input-protocol.js';
import { paidPreemptionNoticeSchema, paidPreemptionOptInSchema, paidPreemptionRequestSchema,
  PAID_PREEMPTION_MAX_NOTICE_MS, PAID_PREEMPTION_MIN_NOTICE_MS } from './sessions/paid-preemption-protocol.js';
import type { SessionCommand } from './sessions/types.js';
import { hostV2AdmissionEnvelopeSchema, hostV2AdmissionReceiptSchema,
  type HostV2AdmissionEnvelope } from './v2-admission.js';

const statusSchema = z.object({ version: z.literal(1), hostKey: z.string(), isolation: z.enum(['gvisor','kata','docker_development','local_process_fixture']),
  runId: z.string(), owner: z.string(), leaseHash: z.string(), state: z.enum(['starting','running','completed','failed','cancelled','timed_out','fault']),
  ticks: z.array(signedTickSchema).max(100), acks: z.array(signedAckSchema).max(100), billableSeconds: z.number().int().min(0).max(120),
  output: z.string().max(16384), exitCode: z.number().int(), cleanupConfirmed: z.boolean() }).strict();
export type HostKitStatus = z.infer<typeof statusSchema>;
export class HostKitClient {
  private readonly url: string;
  constructor(baseUrl: string, readonly hostKey: string, readonly control: Ed25519Identity,
    private readonly allowDevelopment = false, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))) throw new Error('Host Kit transport requires HTTPS or loopback');
    this.url = url.href.replace(/\/$/, '');
  }
  /** A fresh signed hint for quote placement, never a reservation of CPU capacity. */
  async capacity(imageValue: string, kind: 'one_shot' | 'session', cystInputBytes?: number): Promise<boolean> {
    const image = imageDigestSchema.parse(imageValue), issuedAt = Date.now(), nonce = randomId();
    const challenge = this.control.sign('capacity-challenge', { version: 1 as const,
      hostKey: this.hostKey, image, kind, nonce, issuedAt, expiresAt: issuedAt + 5000,
      ...(cystInputBytes === undefined ? {} : { cystInputBytes }) });
    const response = await this.fetcher(this.url + '/v1/capacity', { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(challenge), signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`Host capacity request failed (${response.status})`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('Host capacity response was empty');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.length;
      if (size > 4096) { await reader.cancel(); throw new Error('Host capacity response exceeds limit'); } chunks.push(result.value); } }
    finally { reader.releaseLock(); }
    const result = capacityResponseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))), body = result.body, now = Date.now();
    if (!verifyHostMessage(this.hostKey, 'capacity', result) || body.hostKey !== this.hostKey
      || body.image !== image || body.kind !== kind || body.nonce !== nonce
      || body.challengeHash !== hostMessageHash(challenge)
      || body.issuedAt < issuedAt - 5000 || body.issuedAt > now + 5000
      || body.expiresAt <= now || body.expiresAt > challenge.body.expiresAt
      || body.expiresAt <= body.issuedAt
      || cystInputBytes === undefined && body.cystInput !== undefined
      || cystInputBytes !== undefined && (!body.cystInput || body.cystInput.requestedBytes !== cystInputBytes
        || body.available && (!body.cystInput.available || body.cystInput.maxBytes < cystInputBytes))
      || (!this.allowDevelopment && !['gvisor', 'kata'].includes(body.isolation))) {
      throw new Error('Host capacity signature, challenge binding, isolation, or freshness rejected');
    }
    return body.available;
  }
  private async request(path: string, value: unknown, lease: SignedHostLease): Promise<HostKitStatus> {
    const response = await this.fetcher(this.url + path, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Host Kit request failed (${response.status})`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('Host response was empty');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.length;
      if (size > 262_144) { await reader.cancel(); throw new Error('Host response exceeds limit'); } chunks.push(result.value); } }
    finally { reader.releaseLock(); }
    const result = z.object({ body: statusSchema, signature: z.string() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!verifyHostMessage(this.hostKey, 'control', result) || result.body.hostKey !== this.hostKey
      || result.body.runId !== lease.body.runId || result.body.owner !== lease.body.owner || result.body.leaseHash !== hostMessageHash(lease)
      || (!this.allowDevelopment && !['gvisor','kata'].includes(result.body.isolation))) throw new Error('Host identity, lease scope, or isolation rejected');
    return result.body;
  }
  admit(lease: SignedHostLease): Promise<HostKitStatus> { return this.request('/v1/leases', lease, lease); }
  /** Opt-in only. The normal CPU executor continues to use /v1/leases. */
  async admitV2(raw: HostV2AdmissionEnvelope) {
    const envelope = hostV2AdmissionEnvelopeSchema.parse(raw);
    const response = await this.fetcher(this.url + '/v2/leases', { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Host v2 admission failed (${response.status})`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('Host v2 admission response was empty');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.length;
      if (size > 262_144) { await reader.cancel(); throw new Error('Host v2 admission response exceeds limit'); }
      chunks.push(result.value); } }
    finally { reader.releaseLock(); }
    const signedStatusSchema = z.object({ body: statusSchema, signature: z.string() }).strict();
    const result = z.object({ status: signedStatusSchema, admission: hostV2AdmissionReceiptSchema }).strict()
      .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const status = result.status.body, admission = result.admission.body;
    if (!verifyHostMessage(this.hostKey, 'control', result.status)
      || !verifyHostMessage(this.hostKey, 'v2-admission', result.admission)
      || status.hostKey !== this.hostKey || status.runId !== envelope.lease.body.runId
      || status.owner !== envelope.lease.body.owner || status.leaseHash !== hostMessageHash(envelope.lease)
      || admission.hostKey !== this.hostKey || admission.runId !== envelope.quote.runId
      || admission.hostId !== envelope.quote.hostId || admission.owner !== envelope.lease.body.owner
      || admission.chainId !== envelope.delegation.body.chainId
      || admission.escrow.toLowerCase() !== envelope.delegation.body.escrow.toLowerCase()
      || admission.hostRegistry.toLowerCase() !== envelope.delegation.body.hostRegistry.toLowerCase()
      || admission.controllerKey !== this.control.publicKey || admission.admissionTx !== envelope.admissionTx
      || admission.quoteHash !== hashJson(envelope.quote)
      || admission.signedLeaseHash !== hostMessageHash(envelope.lease)
      || admission.meterLeaseHash !== hostMessageHash({ body: envelope.lease.body, signature: '' })
      || admission.delegationHash !== hashJson(envelope.delegation)
      || admission.envelopeHash !== hashJson(envelope)
      || admission.acceptedAtMs < envelope.lease.body.issuedAt - 5000
      || admission.acceptedAtMs > envelope.lease.body.expiresAt
      || (!this.allowDevelopment && !['gvisor', 'kata'].includes(status.isolation))) {
      throw new Error('Host v2 admission signature or exact envelope binding changed');
    }
    return { status, admission: result.admission };
  }
  command(lease: SignedHostLease, action: 'status' | 'stop' | 'ack', ack?: z.infer<typeof signedAckSchema>): Promise<HostKitStatus> {
    const body = { version: 1 as const, hostKey: this.hostKey, runId: lease.body.runId, owner: lease.body.owner,
      action, nonce: randomId(), issuedAt: Date.now(), ...(ack === undefined ? {} : { ack }) };
    return this.request('/v1/control', this.control.sign('control', body), lease);
  }
  private cystInputRequest(lease: SignedHostLease, action: 'upload' | 'status' | 'commit') {
    const { payload } = parsePaidSessionLease(lease);
    if (!payload.spec.cystInput || lease.body.hostKey !== this.hostKey
      || !verifyHostMessage(this.control.publicKey, 'lease', lease)) throw new Error('Original paid Cyst input lease is unavailable');
    return this.control.sign('cyst-input-request', { ...cystInputBindingSchema.parse({ version: 1,
      hostKey: this.hostKey, runId: lease.body.runId, owner: lease.body.owner,
      leaseHash: hostMessageHash(lease), expiresAt: lease.body.expiresAt, descriptor: payload.spec.cystInput }),
    action, nonce: randomId(), issuedAt: Date.now() });
  }
  private async cystInputResponse(response: Response,
    request: ReturnType<HostKitClient['cystInputRequest']>): Promise<SignedCystInputResult> {
    if (response.status !== 200) { await response.body?.cancel(); throw new Error('Host paid file request failed (' + response.status + ')'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Host paid file response is empty');
    const parts: Uint8Array[] = []; let length = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break;
        if (part.value.byteLength > 8192 - length) throw new Error('Host paid file response exceeds its bound');
        parts.push(part.value); length += part.value.byteLength; }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const result = signedCystInputResultSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, length))));
    const body = result.body, expected = request.body;
    if (!verifyHostMessage(this.hostKey, 'cyst-input-result', result) || body.hostKey !== this.hostKey
      || body.runId !== expected.runId || body.owner !== expected.owner || body.leaseHash !== expected.leaseHash
      || body.requestNonce !== expected.nonce || body.descriptorHash !== cystInputDescriptorHash(expected.descriptor)
      || body.operationId !== expected.descriptor.operationId || body.plaintextBytes !== expected.descriptor.plaintextBytes
      || body.plaintextSha256 !== expected.descriptor.plaintextSha256
      || body.state === 'ready' && !body.committed || ['waiting', 'staged'].includes(body.state) && body.committed) {
      throw new Error('Host paid file result differs from the exact signed request');
    }
    return result;
  }
  async cystInputControl(lease: SignedHostLease, action: 'status' | 'commit'): Promise<SignedCystInputResult> {
    const request = this.cystInputRequest(lease, action);
    return this.cystInputResponse(await this.fetcher(this.url + '/v1/sessions/cyst-inputs/control', {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(10_000) }), request);
  }
  async cystInputUpload(lease: SignedHostLease, input: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<SignedCystInputResult> {
    const request = this.cystInputRequest(lease, 'upload'), remaining = lease.body.expiresAt - Date.now();
    if (remaining <= 0) { await input.cancel(); throw new Error('Original paid file lease expired'); }
    const options: RequestInit & { duplex: 'half' } = { method: 'PUT', redirect: 'error', duplex: 'half',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(request.body.descriptor.plaintextBytes),
        'x-telomere-cyst-input': Buffer.from(JSON.stringify(request)).toString('base64') }, body: input,
      signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]) };
    const response = await this.fetcher(this.url + '/v1/sessions/cyst-inputs/' + request.body.runId + '/'
      + request.body.descriptor.operationId, options);
    return this.cystInputResponse(response, request);
  }
  private async preemptionResponse(path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
    const response = await this.fetcher(this.url + path, { method, redirect: 'error',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000) });
    const missingNotice = method === 'GET' && response.status === 404
      && /^\/v1\/sessions\/preemption\/0x[a-f0-9]{64}\/notices$/.test(path);
    if (!response.ok && !missingNotice) throw new Error(`Host paid preemption request failed (${response.status})`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('Host paid preemption response was empty');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.length;
      if (size > 16_384) { await reader.cancel(); throw new Error('Host paid preemption response exceeds limit'); }
      chunks.push(result.value); } }
    finally { reader.releaseLock(); }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (missingNotice) {
      if (z.object({ title: z.literal('paid_preemption_notice_not_found') }).strict().safeParse(value).success) {
        throw new Problem(404, 'paid_preemption_notice_not_found', 'No paid preemption notice exists for the original session.');
      }
      throw new Error('Host paid preemption request failed (404)');
    }
    return value;
  }
  private preemptionScope(lease: SignedHostLease) {
    if (!verifyHostMessage(this.control.publicKey, 'lease', lease) || lease.body.hostKey !== this.hostKey) {
      throw new Error('Original paid session lease differs from reviewed HostKit authority');
    }
    return { version: 1 as const, hostKey: this.hostKey, owner: lease.body.owner,
      runId: lease.body.runId, leaseHash: hostMessageHash(lease), image: lease.body.image };
  }
  private checkedPreemptionNotice(lease: SignedHostLease, raw: unknown) {
    const notice = paidPreemptionNoticeSchema.parse(raw), scope = this.preemptionScope(lease), body = notice.body;
    if (!verifyHostMessage(this.hostKey, 'paid-preemption', notice)
      || body.hostKey !== scope.hostKey || body.owner !== scope.owner || body.runId !== scope.runId
      || body.leaseHash !== scope.leaseHash || body.image !== scope.image
      || body.interruptAt - body.issuedAt < PAID_PREEMPTION_MIN_NOTICE_MS
      || body.interruptAt - body.issuedAt > PAID_PREEMPTION_MAX_NOTICE_MS
      || body.interruptAt > lease.body.expiresAt) throw new Error('Paid preemption notice changed its signed lease scope');
    return notice;
  }
  /** A Vault owner's authenticated controller action explicitly opts in the
   * already paid original lease. HostKit retains the first accepted artifact. */
  async preemptionOptIn(lease: SignedHostLease, key: string) {
    const scope = this.preemptionScope(lease), issuedAt = Date.now(), expiresAt = lease.body.expiresAt;
    // HostKit rejects a new late opt-in; a regenerated same-nonce request must
    // still reach its durable replay path after the paid lease has expired.
    const signed = paidPreemptionOptInSchema.parse(this.control.sign('paid-preemption-optin', {
      domain: 'telomere-paid-preemption-optin/v1' as const, ...scope,
      nonce: hashJson({ domain: 'telomere-paid-preemption-optin-nonce/v1', runId: scope.runId,
        leaseHash: scope.leaseHash, key }), issuedAt, expiresAt }));
    const result = z.object({ optIn: paidPreemptionOptInSchema, replayed: z.boolean() }).strict().parse(
      await this.preemptionResponse('/v1/sessions/preemption/opt-in', 'POST', signed));
    const original = result.optIn.body;
    if (!verifyHostMessage(this.control.publicKey, 'paid-preemption-optin', result.optIn)
      || original.hostKey !== scope.hostKey || original.owner !== scope.owner || original.runId !== scope.runId
      || original.leaseHash !== scope.leaseHash || original.image !== scope.image
      || original.nonce !== signed.body.nonce) throw new Error('Host preemption opt-in acknowledgment changed its original authority');
    return result;
  }
  /** The host operator chooses when to issue a notice. This controller-signed
   * request cannot bypass HostKit's prior durable owner opt-in. */
  async requestPreemptionNotice(lease: SignedHostLease, noticeMilliseconds: number,
    reason: 'maintenance' | 'capacity', key: string) {
    const scope = this.preemptionScope(lease), issuedAt = Date.now();
    const signed = paidPreemptionRequestSchema.parse(this.control.sign('paid-preemption-request', {
      domain: 'telomere-paid-preemption-request/v1' as const, ...scope,
      nonce: hashJson({ domain: 'telomere-paid-preemption-request-nonce/v1', runId: scope.runId,
        leaseHash: scope.leaseHash, key }), issuedAt, noticeMilliseconds, reason }));
    const result = z.object({ notice: paidPreemptionNoticeSchema, replayed: z.boolean() }).strict().parse(
      await this.preemptionResponse('/v1/sessions/preemption/' + scope.runId + '/notices', 'POST', signed));
    return { ...result, notice: this.checkedPreemptionNotice(lease, result.notice) };
  }
  async preemptionNotice(lease: SignedHostLease) {
    const scope = this.preemptionScope(lease);
    const result = z.object({ notice: paidPreemptionNoticeSchema }).strict().parse(
      await this.preemptionResponse('/v1/sessions/preemption/' + scope.runId + '/notices', 'GET'));
    return this.checkedPreemptionNotice(lease, result.notice);
  }
  async preemptionOptInEvidence(lease: SignedHostLease) {
    const scope = this.preemptionScope(lease);
    const result = z.object({ optIn: paidPreemptionOptInSchema }).strict().parse(
      await this.preemptionResponse('/v1/sessions/preemption/' + scope.runId + '/opt-in', 'GET'));
    const signed = result.optIn, body = signed.body;
    if (!verifyHostMessage(this.control.publicKey, 'paid-preemption-optin', signed)
      || body.hostKey !== scope.hostKey || body.owner !== scope.owner || body.runId !== scope.runId
      || body.leaseHash !== scope.leaseHash || body.image !== scope.image
      || body.expiresAt > lease.body.expiresAt || body.expiresAt <= body.issuedAt) {
      throw new Error('Stored paid preemption opt-in changed its original signed lease');
    }
    return signed;
  }
  private async sessionRequest(path: string, value: unknown, lease: SignedHostLease, nonce: string,
    timeoutMs: number): Promise<z.infer<typeof paidSessionStatusSchema>['body']> {
    const response = await this.fetcher(this.url + path, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      if (response.status === 409) {
        const failure: unknown = await response.json().catch(() => undefined);
        if (failure && typeof failure === 'object' && 'title' in failure && failure.title === 'session_command_conflict') {
          throw new Problem(409, 'platform_command_conflict', 'The command ID was used with different input.');
        }
      }
      throw new Error(`Host session request failed (${response.status})`);
    }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Host session response was empty');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.length;
      if (size > 262_144) { await reader.cancel(); throw new Error('Host session response exceeds limit'); } chunks.push(result.value); } }
    finally { reader.releaseLock(); }
    const result = paidSessionStatusSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!verifyHostMessage(this.hostKey, 'session-status', result) || result.body.requestNonce !== nonce
      || result.body.hostKey !== this.hostKey || result.body.runId !== lease.body.runId
      || result.body.owner !== lease.body.owner || result.body.leaseHash !== hostMessageHash(lease)
      || (!this.allowDevelopment && !['gvisor', 'kata'].includes(result.body.isolation))) {
      throw new Error('Host session identity, nonce, scope, or isolation rejected');
    }
    return result.body;
  }
  sessionAdmit(lease: SignedHostLease) {
    return this.sessionRequest('/v1/sessions/leases', lease, lease, lease.body.nonce, 10_000);
  }
  sessionControl(lease: SignedHostLease, input: { action: 'status'; afterSequence?: number; limit?: number }
    | { action: 'stop' } | { action: 'ack'; ack: SignedHostAck } | { action: 'execute'; command: SessionCommand }) {
    const nonce = randomId(), base = { version: 1 as const, hostKey: this.hostKey, runId: lease.body.runId,
      owner: lease.body.owner, leaseHash: hostMessageHash(lease), nonce, issuedAt: Date.now() };
    const body = input.action === 'status' ? { ...base, action: 'status' as const,
      afterSequence: input.afterSequence ?? -1, limit: input.limit ?? 8 } : { ...base, ...input };
    const signed: PaidSessionControl = paidSessionControlSchema.parse(this.control.sign('session-control', body));
    return this.sessionRequest('/v1/sessions/control', signed, lease, nonce, input.action === 'execute' ? 125_000 : 10_000);
  }
}
export type HostKitObserver = { onLease(lease: SignedHostLease): Promise<void>;
  /** Optional exact-envelope admission. Persist any host testimony before returning its first ticks. */
  admit?(lease: SignedHostLease): Promise<HostKitStatus>;
  /** Called only when admission is skipped after the lease was persisted, before any host request. */
  onAdmissionSkipped?(lease: SignedHostLease): Promise<void>;
  onEvidence(tick: SignedHostTick, ack: SignedHostAck): Promise<void> };
export const hostCommandInputSchema = leaseSchema.pick({ runId: true, maxSeconds: true, argv: true, stdin: true });
export type HostCommandInput = z.infer<typeof hostCommandInputSchema>;
/** Bounded commands inside reviewed images, with the same durable signed evidence as fixed CPU tasks. */
export class HostKitCommandExecutor {
  // Omitted observer is suitable only for local tests. Production wires durable controller storage.
  constructor(private readonly client: HostKitClient, private readonly owner: string, private readonly image: string,
    private readonly observer?: HostKitObserver) {}
  async run(rawInput: HostCommandInput, signal: AbortSignal, onTick?: TickHandler): Promise<CpuRunResult> {
    const input = hostCommandInputSchema.parse(rawInput), standardMeter = new RunMeter(input.runId, input.maxSeconds, onTick);
    if (signal.aborted) {
      await standardMeter.emit('cancelled', 0, ''); await standardMeter.flush();
      return { output: '', billableSeconds: 0, ticks: standardMeter.ticks, exitCode: -1, status: 'cancelled' };
    }
    const now = Date.now();
    const body: HostLease = leaseSchema.parse({ version: 1, hostKey: this.client.hostKey, runId: input.runId, owner: this.owner.toLowerCase(), image: this.image,
      argv: input.argv, ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      issuedAt: now, expiresAt: now + input.maxSeconds * 1000, maxSeconds: input.maxSeconds, nonce: randomId() });
    const lease = this.client.control.sign('lease', body), meter = new HostMeterVerifier(body, this.client.control);
    await this.observer?.onLease(lease);
    if (signal.aborted) {
      await this.observer?.onAdmissionSkipped?.(lease);
      signal.throwIfAborted();
    }
    let state: HostKitStatus, sequence = 0;
    try { state = await (this.observer?.admit ? this.observer.admit(lease) : this.client.admit(lease)); }
    catch (error) { try { await this.client.command(lease, 'stop'); } catch { /* Lost admission acknowledgement is bounded by the signed lease. */ } throw error; }
    try { for (;;) {
      if (signal.aborted && ['starting','running'].includes(state.state)) state = await this.client.command(lease, 'stop');
      for (const tick of state.ticks.slice(sequence)) {
        const ack = meter.accept(tick);
        await this.observer?.onEvidence(tick, ack);
        if (tick.body.state === 'RUNNING') await standardMeter.emit('running', meter.billableSeconds * 1000);
        // When wired, persist signed evidence and standard observations before confirming it to the host. A lost
        // acknowledgement reply can be read back by exact signed-ack hash.
        try { state = await this.client.command(lease, 'ack', ack); }
        catch (error) { state = await this.client.command(lease, 'status');
          if (!state.acks.some(recorded => hostMessageHash(recorded) === hostMessageHash(ack))) throw error; }
        sequence++;
      }
      // ACK/status replies can reveal additional ticks, including a terminal tick. Drain all signed
      // observations before returning a terminal result so none bypass durable evidence and ACKs.
      if (state.ticks.length > sequence) continue;
      if (!['starting','running'].includes(state.state)) break;
      if (meter.missing()) { await this.client.command(lease, 'stop'); throw new Error('Host missed three signed meter ticks'); }
      await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 250); signal.addEventListener('abort', done, { once: true }); });
      state = await this.client.command(lease, 'status');
    } } catch (error) { try { await this.client.command(lease, 'stop'); } catch { /* A bounded lease and host acknowledgement watchdog remain active. */ } throw error; }
    const status = state.state === 'completed' ? 'completed' : state.state === 'cancelled' ? 'cancelled'
      : state.state === 'timed_out' ? 'timed_out' : 'failed';
    if (!state.cleanupConfirmed) throw new Error('Host terminal cleanup was not confirmed');
    await standardMeter.emit(status, meter.billableSeconds * 1000, state.output); await standardMeter.flush();
    return { output: state.output, billableSeconds: meter.billableSeconds, ticks: standardMeter.ticks, exitCode: state.exitCode, status };
  }
}
/** Root worker adapter: fixed task image, signed host evidence, control countersignatures. */
export class HostKitCpuExecutor implements CpuExecutor {
  private readonly commands: HostKitCommandExecutor;
  constructor(client: HostKitClient, owner: string, image: string, observer?: HostKitObserver) {
    this.commands = new HostKitCommandExecutor(client, owner, image, observer);
  }
  async run(rawInput: CpuRunInput, signal: AbortSignal, onTick?: TickHandler): Promise<CpuRunResult> {
    const input = cpuRunInputSchema.parse(rawInput);
    return this.commands.run({ runId: leaseSchema.shape.runId.parse(input.runId), maxSeconds: input.maxSeconds,
      argv: ['/usr/local/bin/node', '/opt/telomere/task-runner.mjs'], stdin: JSON.stringify(input.task) }, signal, onTick);
  }
}
