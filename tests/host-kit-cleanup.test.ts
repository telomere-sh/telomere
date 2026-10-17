import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerHostRuntime } from '../src/host-kit/docker-runtime.js';
import type { DockerCommand } from '../src/runtime/command.js';

const hostKey = `0x${'a'.repeat(64)}`;
const ownedName = `tlmr-hostkit-${hostKey.slice(2, 10)}-${'b'.repeat(16)}-12345678`;

// Actual Unix HTTP transport, with an explicitly simulated Docker Engine.
describe.skipIf(process.platform !== 'linux')('HostKit independently confirmed duplicate cleanup', () => {
  let directory: string | undefined, server: Server | undefined;
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    if (directory) await rm(directory, { recursive: true, force: true });
    server = undefined; directory = undefined;
  });

  async function fixture(handler: RequestListener, rmExit = 1) {
    directory = await mkdtemp(join(tmpdir(), 'tlmr-cleanup-'));
    const socketPath = join(directory, 'engine.sock'), calls: string[][] = [];
    server = createServer(handler);
    await new Promise<void>(resolve => server!.listen(socketPath, resolve));
    const command: DockerCommand = async args => {
      calls.push([...args]);
      if (args[0] === 'ps') return { exitCode: 0, stdout: `${ownedName}\n`, stderr: '' };
      if (args[0] === 'rm') return { exitCode: rmExit, stdout: '', stderr: 'fixture rm acknowledgement unavailable' };
      throw new Error('Unexpected fixture command');
    };
    return { runtime: new DockerHostRuntime({ isolation: 'gvisor', socketPath, command }), calls };
  }

  it('accepts only exact absence evidence after failed removal of the owned name', async () => {
    const requests: string[] = [];
    const { runtime, calls } = await fixture((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: `No such container: ${ownedName}` }));
    });
    expect(await runtime.cleanupOrphans(hostKey)).toEqual([ownedName]);
    expect(requests).toEqual([`GET /v1.41/containers/${ownedName}/json`]);
    expect(calls.at(-1)).toEqual(['rm', '--force', '--volumes', ownedName]);
  });

  it.each([
    ['still present', 200, JSON.stringify({ message: `No such container: ${ownedName}` })],
    ['server failure', 500, JSON.stringify({ message: `No such container: ${ownedName}` })],
    ['different resource', 404, JSON.stringify({ message: 'No such container: different' })],
    ['unknown API route', 404, JSON.stringify({ message: 'page not found' })],
    ['extra ambiguous data', 404, JSON.stringify({ message: `No such container: ${ownedName}`, extra: true })],
    ['wrong JSON type', 404, JSON.stringify([`No such container: ${ownedName}`])],
    ['malformed JSON', 404, '{'],
    ['oversized body', 404, ' '.repeat(1025)],
  ] as const)('refuses %s', async (_label, status, body) => {
    const { runtime } = await fixture((_req, res) => { res.writeHead(status); res.end(body); });
    await expect(runtime.cleanupOrphans(hostKey)).rejects.toThrow('cleanup could not be confirmed');
  });

  it('refuses invalid UTF-8', async () => {
    const { runtime } = await fixture((_req, res) => {
      res.writeHead(404); res.end(Buffer.from([0xff]));
    });
    await expect(runtime.cleanupOrphans(hostKey)).rejects.toThrow('cleanup could not be confirmed');
  });

  it('keeps a total deadline while an Engine error body continues arriving', async () => {
    const { runtime } = await fixture((_req, res) => {
      res.writeHead(404); res.write(' ');
      const timer = setInterval(() => res.write(' '), 200);
      res.once('close', () => clearInterval(timer));
    });
    const started = performance.now();
    await expect(runtime.cleanupOrphans(hostKey)).rejects.toThrow('cleanup could not be confirmed');
    expect(performance.now() - started).toBeGreaterThanOrEqual(2200);
    expect(performance.now() - started).toBeLessThan(6000);
  });

  it('refuses a transport failure', async () => {
    const { runtime } = await fixture((_req, res) => res.destroy());
    await expect(runtime.cleanupOrphans(hostKey)).rejects.toThrow('cleanup could not be confirmed');
  });

  it('does not query absence when removal was acknowledged', async () => {
    let requests = 0;
    const { runtime } = await fixture((_req, res) => { requests++; res.end(); }, 0);
    expect(await runtime.cleanupOrphans(hostKey)).toEqual([ownedName]);
    expect(requests).toBe(0);
  });
});
