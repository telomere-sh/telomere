import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPlatformMcpServer } from '../src/mcp/platform.js';
import { readPlatformMcpProfile } from '../src/mcp/platform-config.js';
import { PlatformRuntimeClient } from '../src/platform-runtime/client.js';
import { PlatformVaultRuntimeClient } from '../src/platform-runtime/vault-client.js';

try {
  const path = process.env.TELOMERE_PLATFORM_PINS_FILE, sessionToken = process.env.TELOMERE_SESSION_TOKEN;
  if (!path || !sessionToken || !/^[a-f0-9]{64}$/.test(sessionToken)) throw new Error('Reviewed pins and an existing session are required');
  const { pins, vaultPins } = await readPlatformMcpProfile(path);
  const baseUrl = process.env.TELOMERE_API_URL ?? 'http://127.0.0.1:3280';
  const server = createPlatformMcpServer({ client: new PlatformRuntimeClient({ baseUrl, pins, sessionToken }),
    ...(vaultPins ? { createVaultClient: (vault: string) => new PlatformVaultRuntimeClient({ baseUrl, pins, vaultPins, vault, sessionToken }) } : {}) });
  await server.connect(new StdioServerTransport());
  let closing = false;
  async function close() { if (!closing) { closing = true; await server.close(); process.exit(0); } }
  const shutdown = () => { void close().catch(() => {
    process.stderr.write('Telomere financial MCP shutdown failed.\n'); process.exit(1);
  }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch {
  // Stdout belongs to MCP. Credentials, configuration paths and raw exceptions stay out of diagnostics.
  process.stderr.write('Telomere financial MCP startup failed. Check the reviewed public pins, API origin and existing session.\n');
  process.exitCode = 1;
}
