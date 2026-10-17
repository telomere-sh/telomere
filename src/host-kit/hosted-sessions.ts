import { Problem } from '../common.js';
import { HostAdmissionCoordinator, admissionHash } from './admission.js';
import { SessionRuntime } from './sessions/runtime.js';
import { sessionSpecSchema, type SessionBackend, type SessionSpec } from './sessions/types.js';

/** Internal host-owned sessions. This supplies no remote authorization, paid
 * interactive lease, financial meter or public session routes. */
export class HostedSessionManager {
  private closed = false;
  private readonly opens = new Map<string, { hash: string; flight: Promise<SessionRuntime>; fault?: () => void; runtime?: SessionRuntime }>();
  constructor(readonly admission: HostAdmissionCoordinator, private readonly reviewedImages: ReadonlySet<string>) {}
  open(raw: SessionSpec): Promise<SessionRuntime> {
    const spec = sessionSpecSchema.parse(raw); this.admission.assertReady();
    if (this.closed || !this.admission.backend || !this.reviewedImages.has(spec.image)) throw new Problem(503, 'host_unavailable', 'Session admission is unavailable.');
    const hash = admissionHash(spec), prior = this.opens.get(spec.sessionId);
    if (prior) { if (prior.hash !== hash) throw new Problem(409, 'session_conflict', 'Session input is immutable.'); return prior.flight; }
    const entry: { hash: string; flight: Promise<SessionRuntime>; fault?: () => void; runtime?: SessionRuntime } = { hash, flight: Promise.resolve(undefined as never) };
    this.opens.set(spec.sessionId, entry);
    entry.flight = (async () => {
      const reservation = await this.admission.session(spec), backend = this.admission.backend!;
      const deadline = performance.now() + spec.lifetimeSeconds * 1000;
      let invoked = false, stopping = false;
      const wrapped: SessionBackend = { isolation: backend.isolation, identity: backend.identity,
        cleanup: async value => { stopping = true; if (invoked) await backend.cleanup(value); }, start: async (value, frame, fault) => {
          entry.fault = () => fault();
          await reservation.dispatch();
          if (stopping || this.closed || !this.admission.available() || performance.now() >= deadline) { fault(); throw new Error('Host lifecycle closed before session dispatch'); }
          invoked = true;
          return backend.start(value, frame, fault);
        } };
      const runtime = await SessionRuntime.open({ spec, backend: wrapped, journal: reservation.journal, reviewedImages: this.reviewedImages });
      entry.runtime = runtime;
      if (this.closed) { await runtime.stop(); throw new Problem(503, 'host_unavailable', 'Session lifecycle is closed.'); }
      return runtime;
    })();
    // A refused reservation must remain retryable without retaining unbounded
    // failed IDs. Durable headers, once created, enforce immutable input.
    void entry.flight.catch(() => { if (this.opens.get(spec.sessionId) === entry) this.opens.delete(spec.sessionId); }); return entry.flight;
  }
  async close(): Promise<void> {
    this.closed = true; this.admission.closeAdmission();
    const flights = [...this.opens.values()].map(async entry => {
      if (entry.runtime) await entry.runtime.stop(); else { entry.fault?.(); await entry.flight.then(runtime => runtime.stop(), () => undefined); }
    });
    await Promise.all(flights);
  }
}
