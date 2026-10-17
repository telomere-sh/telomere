// Offline test-only cross-runtime application checkpoint fixtures; no wallet, RPC or HTTP.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { encryptCheckpoint, decryptCheckpoint } from "../../dist/src/sdk/cysts.js";

if (process.argv[2] === "--verify-python") {
  const path = process.argv[3];
  if (!path || statSync(path).size > 3_000_000) throw new Error("Invalid bounded fixture file");
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  const key = Uint8Array.from(Buffer.from(fixture.testOnlyRecoveryKey, "hex"));
  try {
    const restored = await decryptCheckpoint(fixture.envelope, key);
    if (!Buffer.from(restored).equals(Buffer.from(fixture.plaintextBase64, "base64"))) throw new Error("Cross-language restore mismatch");
    process.stdout.write(JSON.stringify({ matched: true, bytes: restored.byteLength }) + "\n");
  } finally { key.fill(0); }
} else if (process.argv.length === 2) {
  const plaintext = new TextEncoder().encode('{"counter":42,"memory":"Python ↔ TypeScript 🧬 fixture"}');
  const key = Uint8Array.from(Buffer.from("01".repeat(32), "hex"));
  try {
    const result = await encryptCheckpoint(plaintext, { owner: "0x" + "11".repeat(20), agent: "0x" + "22".repeat(20), applicationSchema: "agent-state/v1" }, key);
    mkdirSync(new URL("./fixtures/", import.meta.url), { recursive: true });
    writeFileSync(new URL("./fixtures/cyst-typescript.json", import.meta.url), JSON.stringify({
      source: "Real Telomere TypeScript SDK @noble/ciphers 1.3.0; offline public test key, no HTTP/RPC", envelope: result.envelope,
      testOnlyRecoveryKey: Buffer.from(result.recoveryKey).toString("hex"), plaintextBase64: Buffer.from(plaintext).toString("base64") }, null, 2) + "\n");
    result.recoveryKey.fill(0);
  } finally { key.fill(0); }
} else { throw new Error("Unsupported fixture generator operation"); }
