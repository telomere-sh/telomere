import { z } from 'zod';
import { executeCommand, type DockerCommand } from '../runtime/command.js';

// NVIDIA UUID hex digits are case-insensitive. Normalize all inventory,
// process and claim identities before comparing occupancy or duplicates.
const uuidSchema = z.string().regex(/^GPU-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/)
  .transform(value => 'GPU-' + value.slice(4).toLowerCase());
export const gpuUuidSchema = uuidSchema;
export const gpuSnapshotSchema = z.object({
  uuid: uuidSchema,
  driverMajor: z.number().int().min(1).max(9999),
  totalMemoryMiB: z.number().int().positive().max(1_048_576),
  freeMemoryMiB: z.number().int().nonnegative().max(1_048_576),
  powerLimitWatts: z.number().positive().max(10_000),
  defaultPowerLimitWatts: z.number().positive().max(10_000),
  computeMode: z.literal('Exclusive_Process'),
  migMode: z.enum(['Disabled', 'N/A']),
}).strict().refine(value => value.freeMemoryMiB <= value.totalMemoryMiB);
export type GpuSnapshot = z.infer<typeof gpuSnapshotSchema>;

const fields = 'uuid,memory.total,memory.free,driver_version,compute_mode,mig.mode.current,power.limit,power.default_limit';
export const gpuInventoryArgs = ['--query-gpu=' + fields, '--format=csv,noheader,nounits'] as const;
export const gpuProcessesArgs = ['--query-compute-apps=gpu_uuid,pid', '--format=csv,noheader,nounits'] as const;
const unavailable = () => new Error('GPU inventory unavailable');

function rows(raw: string, maximum: number): string[][] {
  if (Buffer.byteLength(raw) > maximum || raw.includes('\ufffd') || raw.includes('\0')) throw unavailable();
  const lines = raw.trim() ? raw.trim().split(/\r?\n/) : [];
  if (lines.length > 32) throw unavailable();
  return lines.map(line => line.split(',').map(value => value.trim()));
}

function numeric(raw: string | undefined): number {
  if (!raw || !/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(raw)) throw unavailable();
  const number = Number(raw);
  if (!Number.isFinite(number)) throw unavailable();
  return number;
}

function parseInventory(raw: string): GpuSnapshot[] {
  const seen = new Set<string>();
  return rows(raw, 16_384).map(row => {
    if (row.length !== 8) throw unavailable();
    const [uuid, total, free, driver, computeMode, migMode, power, defaultPower] = row;
    if (!driver || !/^\d{3,4}\.\d{1,3}(?:\.\d{1,3})?$/.test(driver)) throw unavailable();
    const value = gpuSnapshotSchema.parse({ uuid, totalMemoryMiB: numeric(total), freeMemoryMiB: numeric(free),
      driverMajor: Number(driver.split('.')[0]), computeMode, migMode, powerLimitWatts: numeric(power),
      defaultPowerLimitWatts: numeric(defaultPower) });
    if (seen.has(value.uuid)) throw unavailable();
    seen.add(value.uuid); return value;
  });
}

function parseProcesses(raw: string): ReadonlySet<string> {
  const active = new Set<string>();
  for (const row of rows(raw, 16_384)) {
    if (row.length !== 2) throw unavailable();
    const uuid = uuidSchema.parse(row[0]);
    if (!row[1] || !/^[1-9]\d{0,9}$/.test(row[1])) throw unavailable();
    active.add(uuid);
  }
  return active;
}

/** nvidia-smi inventory is only a local, software-reported observation. The
 * exclusive compute mode and empty-process checks are admission guards, not
 * a substitute for a separately verified isolated GPU runtime. */
export async function readGpuInventory(options: { binary?: string; command?: DockerCommand; signal?: AbortSignal }): Promise<{
  devices: GpuSnapshot[]; activeComputeUuids: ReadonlySet<string>;
}> {
  const binary = options.binary ?? 'nvidia-smi';
  if (!binary || binary.includes('\0') || Buffer.byteLength(binary) > 4096 || options.command !== undefined && typeof options.command !== 'function') throw unavailable();
  const command = options.command ?? ((args, input) => executeCommand(binary, args, input));
  const timeout = AbortSignal.timeout(5000);
  const controller = new AbortController();
  const abort = () => controller.abort();
  timeout.addEventListener('abort', abort, { once: true });
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) throw unavailable();
    const call = async (args: readonly string[]) => {
      let abort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => { abort = () => reject(unavailable()); });
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        if (controller.signal.aborted) throw unavailable();
        const result = await Promise.race([Promise.resolve().then(() => command(args,
          { signal: controller.signal, maxOutputBytes: 16_384 })), aborted]);
        if (controller.signal.aborted || result.exitCode !== 0 || result.stderr.trim() || Buffer.byteLength(result.stdout) > 16_384) throw unavailable();
        return result.stdout;
      } finally { controller.signal.removeEventListener('abort', abort); }
    };
    const devices = parseInventory(await call(gpuInventoryArgs));
    const activeComputeUuids = parseProcesses(await call(gpuProcessesArgs));
    if ([...activeComputeUuids].some(uuid => !devices.some(device => device.uuid === uuid))) throw unavailable();
    return { devices, activeComputeUuids };
  } catch { throw unavailable(); }
  finally {
    timeout.removeEventListener('abort', abort);
    options.signal?.removeEventListener('abort', abort);
  }
}
