import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { z } from 'zod';
import { executeCommand } from '../../src/runtime/command.js';
import pins from '../../security/gvisor-runtime-pins.json' with { type: 'json' };

const pinnedImage = 'node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';
const manifestSchema = z.object({ version: z.literal(1), fixtureId: z.string().regex(/^[a-z0-9-]{8,48}$/),
  socket: z.string(), parent: z.string(), dockerRoot: z.string(), image: z.literal(pinnedImage),
  runscPath: z.string().regex(/^\/[a-zA-Z0-9_./-]+\/runsc$/), runscSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Test-only profile. Never redirects a production configuration or Docker context. */
export function parseIsolatedGvisorFixture(value: unknown) {
  const p = manifestSchema.parse(value), prefix = 'telomere-audit-' + p.fixtureId;
  if (p.socket !== '/run/' + prefix + '/docker.sock' || p.parent !== '/var/tmp/' + prefix + '/sessions'
    || p.dockerRoot !== '/var/tmp/' + prefix + '/data' || p.runscPath !== '/opt/' + prefix + '/gvisor/runsc'
    || p.runscSha256 !== pins.files.find(row => row.path === 'runsc')?.sha256) {
    throw new Error('An isolated audit daemon, session root and pinned image are required');
  }
  return p;
}
export function verifyIsolatedGvisorIdentity(p: ReturnType<typeof parseIsolatedGvisorFixture>, value: unknown) {
  const actual = z.object({ dockerRoot: z.string(), runtime: z.string(), runscPath: z.string(),
    runscSha256: z.string(), imageDigests: z.array(z.string()) }).strict().parse(value);
  if (actual.dockerRoot !== p.dockerRoot || actual.runtime !== 'runsc' || actual.runscPath !== p.runscPath
    || actual.runscSha256 !== p.runscSha256 || !actual.imageDigests.includes(p.image)) {
    throw new Error('The actual isolated gVisor daemon differs from its reviewed profile');
  }
}

export async function reviewedGvisorFixture(enabled: boolean) {
  const path = process.env.TELOMERE_ISOLATED_GVISOR_MANIFEST;
  if (!path) return { image: '127.0.0.1:15002/telomere-cpu@sha256:6839949540d11906cbdbc614867ac3a825fa0e6f8cbed90c79773979517b4bbe',
    socket: '/var/run/telomere-host-docker/docker.sock', parent: '/opt/telomere-host-runtime' };
  if (!enabled || process.platform !== 'linux') throw new Error('Explicit Linux gVisor acceptance must be enabled');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096 || (stat.mode & 0o077) !== 0
    || stat.uid !== process.getuid?.()) throw new Error('Private regular fixture manifest required');
  const p = parseIsolatedGvisorFixture(JSON.parse(await readFile(path, 'utf8')));
  for (const directory of [p.parent, '/var/tmp/telomere-audit-' + p.fixtureId, '/run/telomere-audit-' + p.fixtureId]) {
    const s = await lstat(directory);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== stat.uid || (s.mode & 0o077) !== 0
      || await realpath(directory) !== directory) throw new Error('Private canonical fixture directory required');
  }
  const socket = await lstat(p.socket), runtime = await lstat(p.runscPath);
  if (!socket.isSocket() || (socket.mode & 0o077) !== 0 || socket.uid !== stat.uid
    || !runtime.isFile() || runtime.isSymbolicLink() || runtime.size > 134_217_728 || runtime.uid !== stat.uid
    || (runtime.mode & 0o022) !== 0) throw new Error('Reviewed private socket and runtime required');
  for (const row of pins.files) {
    const file = p.runscPath.slice(0, -5) + row.path, s = await lstat(file);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== stat.uid || (s.mode & 0o022) !== 0 || s.size !== row.bytes
      || await realpath(file) !== file || createHash('sha256').update(await readFile(file)).digest('hex') !== row.sha256) {
      throw new Error('The complete pinned gVisor distribution is required');
    }
  }
  const call = async (args: string[]) => {
    const out = await executeCommand('docker', ['--host', 'unix://' + p.socket, ...args],
      { signal: AbortSignal.timeout(10_000), maxOutputBytes: 8192 });
    if (out.exitCode !== 0) throw new Error('Isolated daemon inspection failed');
    return JSON.parse(out.stdout) as unknown;
  };
  const identity = z.object({ dockerRoot: z.string(), runtime: z.string(), runscPath: z.string() }).strict().parse(await call(['info', '--format',
    '{"dockerRoot":{{json .DockerRootDir}},"runtime":{{json .DefaultRuntime}},"runscPath":{{with index .Runtimes "runsc"}}{{json .Path}}{{else}}null{{end}}}']));
  const imageDigests = await call(['image', 'inspect', '--format', '{{json .RepoDigests}}', p.image]);
  verifyIsolatedGvisorIdentity(p, { ...identity, imageDigests, runscSha256: createHash('sha256').update(await readFile(p.runscPath)).digest('hex') });
  return { image: p.image, socket: p.socket, parent: p.parent };
}
