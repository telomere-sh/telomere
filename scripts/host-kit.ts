import { readFile, lstat } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { createHostKitRoutes, imageDigestSchema, openHostJournal } from '../src/host-kit/index.js';
import { createDockerHostedHostKit } from '../src/host-kit/hosted.js';
import { PaidHostSessionAgent } from '../src/host-kit/sessions/paid-agent.js';
import { PaidHostPreemptionService } from '../src/host-kit/sessions/paid-preemption.js';
import { PaidCystInputSpool } from '../src/host-kit/sessions/cyst-input-spool.js';
import { assertPaidCystInputLocation, readPaidCystInputConfig } from '../src/host-kit/sessions/cyst-input-config.js';

const configuration = z.object({ HOST_KIT_DIR: z.string().min(1), HOST_KIT_CONTROL_KEY: z.string().regex(/^0x[0-9a-f]{64}$/),
  HOST_KIT_IMAGES_FILE: z.string().min(1), HOST_KIT_ISOLATION: z.enum(['gvisor','kata','docker_development']).default('gvisor'),
  HOST_KIT_ALLOW_DOCKER_DEVELOPMENT: z.enum(['true','false']).default('false'),
  HOST_KIT_DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  HOST_KIT_CYST_INPUTS_CONFIG: z.string().min(1).optional(),
  HOST_KIT_CYST_INPUTS_CONFIG_SHA256: z.string().regex(/^(?:0x)?[a-fA-F0-9]{64}$/).optional(),
  HOST_KIT_PORT: z.coerce.number().int().min(1024).max(65535).default(13290) }).parse(process.env);
if (configuration.HOST_KIT_ISOLATION === 'docker_development' && configuration.HOST_KIT_ALLOW_DOCKER_DEVELOPMENT !== 'true') {
  throw new Error('Docker development mode requires its explicit operator acknowledgement');
}
const metadata = await lstat(configuration.HOST_KIT_IMAGES_FILE);
if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) throw new Error('Image allowlist file rejected');
const images = z.array(imageDigestSchema).min(1).max(32).parse(JSON.parse(await readFile(configuration.HOST_KIT_IMAGES_FILE, 'utf8')));
const cystInputConfig = await readPaidCystInputConfig(configuration.HOST_KIT_CYST_INPUTS_CONFIG,
  configuration.HOST_KIT_CYST_INPUTS_CONFIG_SHA256);
assertPaidCystInputLocation(cystInputConfig, configuration.HOST_KIT_DIR);
if (cystInputConfig && configuration.HOST_KIT_ISOLATION === 'docker_development') throw new Error('Paid Cyst input requires gVisor or Kata isolation');
const journal = await openHostJournal(configuration.HOST_KIT_DIR);
let cystInputs: PaidCystInputSpool | undefined, hosted: ReturnType<typeof createDockerHostedHostKit> | undefined;
let paidSessions: PaidHostSessionAgent | undefined, preemptions: PaidHostPreemptionService | undefined;
async function closeHost(): Promise<void> {
  const preemptionClose = await Promise.allSettled([preemptions?.close()]);
  const sessionClose = await Promise.allSettled([paidSessions?.close()]);
  const hostClose = await Promise.allSettled([hosted?.close()]);
  const failures = [...preemptionClose, ...sessionClose, ...hostClose];
  // Keep the spool lock and plaintext when actual resource cleanup is uncertain.
  try {
    if (!failures.some(result => result.status === 'rejected') && hosted) {
      failures.push(...await Promise.allSettled([cystInputs?.close()]));
    }
  } finally { await journal.close(); }
  const failed = failures.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw new Error('Host resource cleanup is uncertain; paid input storage remains held');
}
try {
  cystInputs = cystInputConfig ? await PaidCystInputSpool.open(cystInputConfig) : undefined;
  hosted = createDockerHostedHostKit({ journal, isolation: configuration.HOST_KIT_ISOLATION, socketPath: configuration.HOST_KIT_DOCKER_SOCKET,
    controlKey: configuration.HOST_KIT_CONTROL_KEY, reviewedImages: new Set(images), ...(cystInputs ? { cystInputs } : {}) });
  const agent = hosted.agent;
  const recovery = await hosted.initialize();
  paidSessions = configuration.HOST_KIT_ISOLATION === 'docker_development' ? undefined
    : new PaidHostSessionAgent(journal, hosted.sessions, configuration.HOST_KIT_CONTROL_KEY);
  await paidSessions?.initialize();
  preemptions = paidSessions ? new PaidHostPreemptionService(journal, paidSessions) : undefined;
  await preemptions?.initialize();
  const server = serve({ fetch: createHostKitRoutes(agent, paidSessions, preemptions).fetch, hostname: '127.0.0.1', port: configuration.HOST_KIT_PORT });
  process.stdout.write(JSON.stringify({ ...agent.identity(), orphanedCells: recovery.orphanedCells.length, faultedRuns: recovery.faultedRuns.length }) + '\n');
  let stopping = false;
  const shutdown = async () => { if (stopping) return; stopping = true;
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    try { await closeHost(); } finally { await closed; } };
  process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
} catch { await closeHost().catch(() => undefined); throw new Error('Host Kit initialization failed closed; inspect runtime and private state configuration'); }
