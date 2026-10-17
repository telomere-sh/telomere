import { z } from 'zod';
import { imageDigestSchema, leaseSchema } from '../protocol.js';
import { cystInputDescriptorSchema } from './cyst-input-protocol.js';
import type { PaidCystInputSpool } from './cyst-input-spool.js';

export const sessionIdSchema = z.string().regex(/^0x[a-f0-9]{64}$/);
export const commandIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const cpuResourceProfileSchema = z.enum(['full', 'lean', 'torpor']);
export const CPU_PROFILE_QUOTAS = Object.freeze({ full: 1, lean: 0.5, torpor: 0.25 } as const);
export const sessionPolicySchema = z.object({ version: z.literal(1), cpu: z.union([z.literal(1), z.literal(0.5), z.literal(0.25)]), memoryBytes: z.literal(268_435_456),
  pids: z.literal(64), temporaryBytes: z.literal(16_777_216), network: z.literal('none'), readOnlyRoot: z.literal(true),
  maxCommands: z.number().int().min(1).max(32), maxOutputBytesPerCommand: z.number().int().min(1).max(16_384),
  maxSessionOutputBytes: z.number().int().min(1).max(65_536), maxOutputFrames: z.number().int().min(1).max(1024) }).strict();
export const sessionSpecSchema = z.object({ version: z.literal(1), sessionId: sessionIdSchema, image: imageDigestSchema,
  lifetimeSeconds: z.number().int().min(1).max(120), policy: sessionPolicySchema,
  cystInput: cystInputDescriptorSchema.optional() }).strict();
const unicode = (value: string) => !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value;
export const sessionCommandSchema = z.object({ commandId: commandIdSchema,
  argv: leaseSchema.shape.argv.refine(values => values.every(unicode)),
  stdin: z.string().max(8192).refine(value => unicode(value) && Buffer.byteLength(value, 'utf8') <= 8192).optional() }).strict();
export type SessionSpec = z.infer<typeof sessionSpecSchema>;
export type SessionCommand = z.infer<typeof sessionCommandSchema>;
export const sessionReasonSchema = z.enum(['requested', 'expired', 'transport_fault', 'output_limit', 'journal_fault', 'recovered']);
export const sessionFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), pid: z.number().int().positive().safe() }).strict(),
  z.object({ kind: z.literal('heartbeat'), sequence: z.number().int().nonnegative().safe(), elapsedMs: z.number().int().nonnegative().safe() }).strict(),
  z.object({ kind: z.literal('started'), commandId: commandIdSchema, pid: z.number().int().positive().safe().optional() }).strict(),
  z.object({ kind: z.literal('output'), commandId: commandIdSchema, stream: z.enum(['stdout', 'stderr']), data: z.string().max(5464) }).strict(),
  z.object({ kind: z.literal('exit'), commandId: commandIdSchema, exitCode: z.number().int().min(-1).max(255),
    reason: z.enum(['exited', 'cancelled', 'output_limit', 'spawn_failed']) }).strict(),
  z.object({ kind: z.literal('stopped'), reason: sessionReasonSchema }).strict(),
]);
export type SessionFrame = z.infer<typeof sessionFrameSchema>;
export const sessionEventSchema = z.object({ sequence: z.number().int().nonnegative().max(4095),
  kind: z.enum(['ready', 'started', 'output', 'command_exit', 'session_exit']), commandId: commandIdSchema.optional(),
  stream: z.enum(['stdout', 'stderr']).optional(), text: z.string().max(8192).refine(unicode).optional(),
  exitCode: z.number().int().min(-1).max(255).optional(), reason: z.string().max(32).optional() }).strict();
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export const commandResultSchema = z.object({ command: sessionCommandSchema, inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['queued', 'starting', 'running', 'completed', 'failed', 'cancelled', 'uncertain']),
  stdout: z.string().max(16_384).refine(unicode), stderr: z.string().max(16_384).refine(unicode),
  exitCode: z.number().int().min(-1).max(255), reason: z.string().max(32), outputBytes: z.number().int().min(0).max(65_536) }).strict();
export type SessionCommandResult = z.infer<typeof commandResultSchema>;
export const sessionRecordSchema = z.object({ version: z.literal(1), spec: sessionSpecSchema,
  backend: z.object({ isolation: z.enum(['gvisor', 'kata', 'local_process_fixture']), identity: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  specHash: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['starting', 'running', 'stopped', 'expired', 'fault']),
  reason: z.string().max(32), initPid: z.number().int().positive().safe().nullable(),
  commands: z.array(commandResultSchema).max(32), events: z.array(sessionEventSchema).max(4096),
  outputBytes: z.number().int().min(0).max(65_536), outputFrames: z.number().int().min(0).max(1024),
  cleanupConfirmed: z.boolean() }).strict();
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
/** Required durable boundary: save is atomic and durable before returning. A
 * later callback or transport failure must never roll a completed write back.
 * One runtime process exclusively owns this journal until close.
 */
export interface SessionJournal { load(): Promise<SessionRecord | undefined>; save(value: SessionRecord): Promise<void> }
export interface SessionProcess {
  readonly closed: Promise<void>;
  send(value: unknown): Promise<void>;
  sample(): Promise<{ running: boolean; cpuMs: number }>;
  stop(): Promise<void>;
}
export interface SessionBackend {
  readonly isolation: 'gvisor' | 'kata' | 'local_process_fixture';
  readonly cystInputs?: PaidCystInputSpool | undefined;
  /** Immutable digest of exact local resource scope and isolation configuration. */
  readonly identity: string;
  start(spec: SessionSpec, onFrame: (value: unknown) => void, onFault: (reason?: 'output_limit') => void): Promise<SessionProcess>;
  /** Reopening never reruns an ambiguous command. Remove only this exact resource. */
  cleanup(spec: SessionSpec): Promise<void>;
}
export class SessionRuntimeError extends Error {
  constructor(readonly code: 'invalid_session' | 'session_conflict' | 'session_unavailable' | 'command_conflict'
    | 'command_limit' | 'session_journal_invalid' | 'session_cleanup_uncertain') { super(code); this.name = 'SessionRuntimeError'; }
}
