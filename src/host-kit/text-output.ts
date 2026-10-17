import { z } from 'zod';

export const hostInitFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started'), pid: z.number().int().positive().safe() }).strict(),
  z.object({ kind: z.literal('heartbeat'), runId: z.string().max(128), sequence: z.number().int().nonnegative().safe(),
    elapsedMs: z.number().int().nonnegative().safe() }).strict(),
  z.object({ kind: z.literal('output'), stream: z.enum(['stdout', 'stderr']), data: z.string().max(21_848) }).strict(),
  z.object({ kind: z.literal('exit'), code: z.number().int().safe() }).strict(),
]);

/** Keep byte boundaries until completion; UTF-8 characters can span multiple init frames. */
export class HostTextOutput {
  private readonly stdout: Buffer[] = [];
  private total = 0;
  append(stream: 'stdout' | 'stderr', encoded: string): void {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || this.total + bytes.length > 16_384) throw new Error('Cell output frame rejected');
    this.total += bytes.length;
    if (stream === 'stdout') this.stdout.push(bytes);
  }
  finish(exitCode: number): { output: string; exitCode: number } {
    try {
      // Canonical stdout text normalizes an optional initial BOM before persistence and hashing.
      const output = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(this.stdout));
      if (output.includes('\0')) throw new Error('Cell stdout is not persistable text');
      return { output, exitCode };
    } catch {
      return { output: '[telomere: invalid UTF-8 or NUL in stdout]', exitCode: -1 };
    }
  }
}
