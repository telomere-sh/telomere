import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTelomereMcpServer } from "../src/mcp/server.js";
import { TelomereClient, type DeploymentPins } from "../src/sdk/index.js";
import { getAddress } from "viem";
import { baseUsdcForChainId } from "../src/chain/chains.js";

const pinNames = ["TELOMERE_CHAIN_ID", "TELOMERE_ESCROW_ADDRESS", "TELOMERE_TOKEN_ADDRESS", "TELOMERE_RECEIPT_SIGNER"] as const;
const assetPinNames = ["TELOMERE_TOKEN_CODE_HASH", "TELOMERE_TOKEN_IMPLEMENTATION_ADDRESS",
  "TELOMERE_TOKEN_IMPLEMENTATION_CODE_HASH"] as const;
function reviewedHash(value: string | undefined): `0x${string}` {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value)) throw new Error("Reviewed asset hash is required");
  return value.toLowerCase() as `0x${string}`;
}
function deploymentPins(): DeploymentPins | undefined {
  const values = pinNames.map(name => process.env[name]);
  const assetValues = assetPinNames.map(name => process.env[name]);
  if (values.every(value => !value) && assetValues.every(value => !value)) return undefined;
  if (values.some(value => !value)) throw new Error("Deployment pins must be supplied together");
  const chainId = Number(values[0]) as DeploymentPins["chainId"];
  if (chainId !== 31337 && chainId !== 8453 && chainId !== 84532) throw new Error("Unsupported pilot chain");
  const tokenAddress = getAddress(values[2]!);
  const canonical = baseUsdcForChainId(chainId);
  if (canonical && tokenAddress.toLowerCase() !== canonical.toLowerCase()) throw new Error("Base deployments require Circle native USDC");
  const base = { chainId, escrowAddress: getAddress(values[1]!), tokenAddress,
    receiptSigner: getAddress(values[3]!) };
  if (!canonical) {
    if (assetValues.some(value => value)) throw new Error("Local mock pins must not include public Circle implementation");
    return base;
  }
  if (assetValues.some(value => !value)) throw new Error("Public Base deployment requires reviewed Circle proxy pins");
  const implementation = getAddress(assetValues[1]!);
  if (/^0x0{40}$/i.test(implementation)) throw new Error("Circle implementation address is required");
  return { ...base, tokenCodeHash: reviewedHash(assetValues[0]), assetImplementation: {
    address: implementation, codeHash: reviewedHash(assetValues[2]) } };
}
try {
  const pins = deploymentPins();
  const client = new TelomereClient({ baseUrl: process.env.TELOMERE_API_URL ?? "http://127.0.0.1:3280",
    ...(process.env.TELOMERE_SESSION_TOKEN ? { sessionToken: process.env.TELOMERE_SESSION_TOKEN } : {}), ...(pins ? { pins } : {}) });
  if (process.env.TELOMERE_MCP_DEMO_AUTH === "true") await client.authenticateDemo({ explicitlyEnabled: true });
  const server = createTelomereMcpServer(client);
  await server.connect(new StdioServerTransport());
  let closing = false;
  async function close() { if (!closing) { closing = true; await server.close(); process.exit(0); } }
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
} catch {
  // Stdout is reserved for MCP. Never print environment values or credentials.
  process.stderr.write("Telomere MCP startup failed. Check API origin, session format and public deployment pins.\n");
  process.exitCode = 1;
}
