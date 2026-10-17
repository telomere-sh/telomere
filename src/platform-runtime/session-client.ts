import { z } from 'zod';
import { canonical, secretHash } from '../common.js';
import { commandResultSchema, sessionCommandSchema, sessionEventSchema } from '../host-kit/sessions/types.js';

const eventPageSchema = z.object({
  events: z.array(sessionEventSchema).max(8),
  nextSequence: z.number().int().min(-1).max(4095),
  eventCount: z.number().int().min(0).max(4096),
  state: z.enum(['starting', 'running', 'completed', 'stopped', 'expired', 'fault',
    'cancelled', 'timed_out', 'failed', 'reconciliation']),
}).strict();

export type PlatformSessionCommand = z.infer<typeof sessionCommandSchema>;
export type PlatformSessionCommandResult = z.infer<typeof commandResultSchema>;
export type PlatformSessionEventPage = z.infer<typeof eventPageSchema>;

export function checkedSessionCommand(raw: unknown, requested: PlatformSessionCommand): PlatformSessionCommandResult {
  const result = commandResultSchema.parse(raw);
  if (canonical(result.command) !== canonical(requested) || result.inputHash !== secretHash(canonical(requested))) {
    throw new Error('Paid session command response changed');
  }
  return result;
}

export function checkedSessionEvents(raw: unknown, afterSequence: number, limit: number): PlatformSessionEventPage {
  const page = eventPageSchema.parse(raw);
  const expectedLength = Math.min(limit, Math.max(0, page.eventCount - afterSequence - 1));
  if (page.events.length !== expectedLength || page.eventCount < afterSequence + 1
    || page.events.some((event, index) => event.sequence !== afterSequence + index + 1)
    || page.nextSequence !== (page.events.at(-1)?.sequence ?? afterSequence)) {
    throw new Error('Paid session event page changed sequence');
  }
  return page;
}

export function sessionCursor(afterSequence: number, limit: number): { afterSequence: number; limit: number } {
  if (!Number.isInteger(afterSequence) || afterSequence < -1 || afterSequence > 4095
    || !Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('Invalid paid session event cursor');
  return { afterSequence, limit };
}
