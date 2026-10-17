import { z } from 'zod';
import { executeCommand, type CommandResult, type DockerCommand } from '../runtime/command.js';
import { hostKeySchema, imageDigestSchema } from './protocol.js';

export type HostInventoryDescriptor = { kind: 'oneshot' | 'session'; resourceId: string; image: string; name: string };
const maximumResources = 1000, listBytes = 65_536, inspectBytes = 8192, totalMs = 30_000;
const idPattern = /^[a-f0-9]{64}$/, resourcePattern = /^0x[a-f0-9]{64}$/;
const unavailable = () => new Error('Host inventory is unavailable');
const inspectedSchema = z.object({ id: z.string(), name: z.string(), image: imageDigestSchema,
  labels: z.record(z.string()) }).strict();
const inspectTemplate = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"labels":{{json .Config.Labels}}}';

/** Read-only inventory of both host-owned namespaces. One retained 30-second
 * deadline covers both bounded lists and all inspections, with at most 1000
 * resources. The caller must match every descriptor to durable original input
 * before cleanup; a well-formed label is not admission authorization.
 */
export async function inspectHostInventory(options: { hostKey: string; socketPath: string; dockerBinary?: string; command?: DockerCommand }): Promise<HostInventoryDescriptor[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const hostKey = hostKeySchema.parse(options.hostKey), socket = options.socketPath, binary = options.dockerBinary ?? 'docker';
    if (typeof socket !== 'string' || !/^\/[a-zA-Z0-9_./\-]{1,200}\.sock$/.test(socket) || socket.includes('..')
      || typeof binary !== 'string' || !binary.length || binary.includes('\0') || Buffer.byteLength(binary) > 4096
      || Buffer.from(binary).toString('utf8') !== binary || options.command !== undefined && typeof options.command !== 'function') throw unavailable();
    const command: DockerCommand = options.command ?? ((args, input) => executeCommand(binary, ['--host', 'unix://' + socket, ...args], input));
    const controller = new AbortController(); timer = setTimeout(() => controller.abort(), totalMs);
    const call = async (args: string[], maximum: number): Promise<CommandResult> => {
      if (controller.signal.aborted) throw unavailable();
      let abort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => { abort = () => reject(unavailable()); });
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await Promise.race([Promise.resolve().then(() => command(args, { signal: controller.signal, maxOutputBytes: maximum })), aborted]);
        if (controller.signal.aborted || result.exitCode !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
          || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maximum
          || result.stdout.includes('\ufffd') || Buffer.from(result.stdout).toString('utf8') !== result.stdout) throw unavailable();
        return result;
      } finally { controller.signal.removeEventListener('abort', abort); }
    };
    const resources: Array<{ kind: HostInventoryDescriptor['kind']; id: string }> = [], ids = new Set<string>();
    for (const kind of ['oneshot', 'session'] as const) {
      const marker = kind === 'oneshot' ? 'telomere.hostkit' : 'telomere.session';
      // Presence discovers malformed owned markers as well; inspect must then
      // require literal true instead of silently omitting an untrusted value.
      const result = await call(['ps', '--all', '--no-trunc', '--filter', 'label=' + marker,
        '--filter', 'label=telomere.host_key=' + hostKey, '--format', '{{.ID}}'], listBytes);
      if (!result.stdout) continue;
      const listed = result.stdout.split(/\r?\n/); if (listed.at(-1) === '') listed.pop();
      if (listed.some(id => !idPattern.test(id)) || resources.length + listed.length > maximumResources) throw unavailable();
      for (const id of listed.sort()) {
        // A duplicate across the two filters is ambiguous, never adopted as a second kind.
        if (ids.has(id)) throw unavailable(); ids.add(id); resources.push({ kind, id });
      }
    }
    const result: HostInventoryDescriptor[] = [], names = new Set<string>(), resourceIds = new Set<string>();
    for (const resource of resources) {
      const raw = await call(['inspect', '--format', inspectTemplate, resource.id], inspectBytes);
      const value = inspectedSchema.parse(JSON.parse(raw.stdout)), labels = value.labels;
      if (value.id !== resource.id || !idPattern.test(value.id) || labels['telomere.host_key'] !== hostKey) throw unavailable();
      const own = resource.kind === 'oneshot' ? 'telomere.hostkit' : 'telomere.session';
      const other = resource.kind === 'oneshot' ? 'telomere.session' : 'telomere.hostkit';
      const ownId = resource.kind === 'oneshot' ? 'telomere.run_id' : 'telomere.session_id';
      const otherId = resource.kind === 'oneshot' ? 'telomere.session_id' : 'telomere.run_id';
      const resourceId = labels[ownId];
      if (labels[own] !== 'true' || other in labels || otherId in labels || !resourceId || !resourcePattern.test(resourceId)) throw unavailable();
      const name = value.name.startsWith('/') ? value.name.slice(1) : '';
      const expected = resource.kind === 'oneshot'
        ? new RegExp('^tlmr-hostkit-' + hostKey.slice(2, 10) + '-' + resourceId.slice(2, 18) + '-[a-f0-9]{8}$').test(name)
        : name === 'tlmr-session-' + hostKey.slice(2, 10) + '-' + resourceId.slice(2);
      const resourceKey = resource.kind + ':' + resourceId;
      if (!expected || names.has(name) || resourceIds.has(resourceKey)) throw unavailable();
      names.add(name); resourceIds.add(resourceKey); result.push({ kind: resource.kind, resourceId, image: value.image, name });
    }
    return result;
  } catch { throw unavailable(); }
  finally { clearTimeout(timer); }
}
