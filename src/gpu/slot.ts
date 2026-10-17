import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { gpuUuidSchema } from './inventory.js';

const runIdSchema = z.string().regex(/^0x[a-f0-9]{64}$/);
const recordSchema = z.object({ version: z.literal(1), uuid: gpuUuidSchema,
  runId: runIdSchema, token: z.string().regex(/^[a-f0-9]{64}$/), pid: z.number().int().positive(),
  createdAt: z.string().datetime() }).strict();
const unavailable = () => new Error('GPU slot unavailable or requires operator reconciliation');

export class GpuSlotLease {
  private released = false;
  constructor(readonly uuid: string, readonly runId: string, private readonly path: string, private readonly original: string) {}
  /** Call only after isolated-cell cleanup is independently confirmed. A crash
   * intentionally leaves the file in place and blocks re-admission. */
  async release(cleanup: { cleanupConfirmed: true }): Promise<void> {
    if (cleanup?.cleanupConfirmed !== true || this.released) throw unavailable();
    try {
      const current = await readFile(this.path, 'utf8');
      if (current !== this.original) throw unavailable();
      await unlink(this.path);
      this.released = true;
    } catch { throw unavailable(); }
  }
}

/** Atomic O_EXCL reservation across local HostKit processes. It does not lock
 * unrelated workloads; GPU admission also requires exclusive compute mode. */
export async function reserveGpuSlot(options: { directory: string; uuid: string; runId: string }): Promise<GpuSlotLease> {
  const uuid = gpuUuidSchema.parse(options.uuid), runId = runIdSchema.parse(options.runId);
  const directory = options.directory;
  if (!isAbsolute(directory) || directory.includes('\0')) throw unavailable();
  try {
    const stat = await lstat(directory), canonical = await realpath(directory);
    // Windows realpath expands 8.3 aliases, so textual equality is only a
    // useful symlink/path guard on POSIX. lstat still rejects a symlink here.
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32'
      && (resolve(directory) !== canonical || (stat.mode & 0o077) !== 0)) throw unavailable();
    const path = join(directory, uuid.toLowerCase() + '.json');
    const record = recordSchema.parse({ version: 1, uuid, runId, token: randomBytes(32).toString('hex'),
      pid: process.pid, createdAt: new Date().toISOString() });
    const serialized = JSON.stringify(record) + '\n';
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(serialized); await handle.sync(); }
    finally { await handle.close(); }
    // The claim must survive a host power loss before a probe can touch the GPU.
    // If directory durability is uncertain, leave the claim on disk and refuse
    // admission for operator reconciliation.
    if (process.platform !== 'win32') {
      const parent = await open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
    return new GpuSlotLease(uuid, runId, path, serialized);
  } catch (error) { throw new Error('GPU slot unavailable or requires operator reconciliation', { cause: error }); }
}
