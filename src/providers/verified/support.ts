import { createHash } from "node:crypto";

/** Small local replacement for Enclave's core error/hash helpers. No logger sees provider data. */
export class AppError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 500, readonly details?: unknown) {
    super(message);
    this.name = "AppError";
  }
}
export class ValidationError extends AppError {
  constructor(details: unknown) { super("VALIDATION_ERROR", "Invalid verified inference input", 400, details); }
}
export function sha256Hex(value: string | Buffer): `0x${string}` {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}
