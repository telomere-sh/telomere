import { z } from 'zod';

/** Test mutations require the exact fresh loopback endpoint belonging to our running child. */
export function assertForkMutationTarget(url: string, child: { pid: number | undefined; port: number; exited: boolean }): void {
  const endpoint = new URL(z.string().url().parse(url));
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== String(child.port)
    || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !Number.isSafeInteger(child.pid) || !child.pid || child.pid < 1 || child.exited
    || !Number.isInteger(child.port) || child.port < 1024 || child.port > 65535
    || [3280, 3281, 13280, 15434, 18547, 8547].includes(child.port)) throw new Error('Fork mutations require our isolated local child');
}
