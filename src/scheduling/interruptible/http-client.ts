import { z } from 'zod';
import { bytes32Schema } from '../../common.js';
import { ApiTransport } from '../../sdk/transport.js';
import { interruptibleAdmissionSchema, interruptibleKeySchema, interruptibleOwnerSchema, interruptiblePublicSchema,
  signedPreemptionNoticeSchema } from './types.js';
import type { InterruptibleService, InterruptibleProgress } from './service.js';
import type { InterruptibleClientControl } from './client.js';

const progressSchema = z.object({ run: interruptiblePublicSchema, action: z.enum(['wait', 'lifecycle', 'done']), phase: z.string().max(96).optional() }).strict();
const changedSchema = z.object({ run: interruptiblePublicSchema, replayed: z.boolean() }).strict();
/** Bounded authenticated client; contains no wallet/key/payment API. Every response is owner/id scoped. */
export class HttpInterruptibleControl implements InterruptibleClientControl {
  constructor(private readonly transport: ApiTransport) {}
  private scope(ownerValue: string, idValue: string, run: ReturnType<InterruptibleService['publicRecord']>) {
    if (run.owner !== interruptibleOwnerSchema.parse(ownerValue) || run.id !== bytes32Schema.parse(idValue))
      throw new Error('Interruptible response changed owner or admission scope');
  }
  async get(owner: string, id: string): ReturnType<InterruptibleService['get']> {
    const run = interruptiblePublicSchema.parse(await this.transport.request('/api/interruptible/' + bytes32Schema.parse(id), { maxResponseBytes: 16384 }));
    this.scope(owner, id, run); return run;
  }
  private async progress(owner: string, id: string, suffix: string, body?: unknown): Promise<InterruptibleProgress> {
    const result = progressSchema.parse(await this.transport.request('/api/interruptible/' + bytes32Schema.parse(id) + '/' + suffix,
      { method: 'POST', maxResponseBytes: 16384, ...(body === undefined ? {} : { body }) }));
    this.scope(owner, id, result.run); return { run: result.run, action: result.action, ...(result.phase === undefined ? {} : { phase: result.phase }) };
  }
  advance(owner: string, id: string) { return this.progress(owner, id, 'advance'); }
  validateClientStep(owner: string, id: string, intentId: string, phase: string) {
    return this.progress(owner, id, 'execution', { intentId: z.string().uuid().parse(intentId), phase });
  }
  async admit(owner: string, input: unknown, key: string): ReturnType<InterruptibleService['admit']> {
    const result = changedSchema.parse(await this.transport.request('/api/interruptible', { method: 'POST', body: interruptibleAdmissionSchema.parse(input),
      idempotencyKey: interruptibleKeySchema.parse(key), maxResponseBytes: 16384 }));
    this.scope(owner, result.run.id, result.run); return result;
  }
  async approveTarget(owner: string, id: string, runId: string): ReturnType<InterruptibleService['approveTarget']> {
    const result = changedSchema.parse(await this.transport.request('/api/interruptible/' + bytes32Schema.parse(id) + '/targets',
      { method: 'POST', body: { runId: bytes32Schema.parse(runId) }, maxResponseBytes: 16384 }));
    this.scope(owner, id, result.run); return result;
  }
  async acceptNotice(owner: string, id: string, value: unknown): ReturnType<InterruptibleService['acceptNotice']> {
    const result = changedSchema.parse(await this.transport.request('/api/interruptible/' + bytes32Schema.parse(id) + '/notices',
      { method: 'POST', body: signedPreemptionNoticeSchema.parse(value), maxResponseBytes: 16384 }));
    this.scope(owner, id, result.run); return result;
  }
}
