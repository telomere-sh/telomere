/** Browser-safe, deterministic snippets for the existing Legacy quote API. No I/O. */
export type RequestExampleContext = {
  serverOrigin: string;
  leashId: string;
  taskText: string;
  maxSeconds: number;
  idempotencyKey: string;
  runtimeMaxSeconds?: number;
};
export type RequestExamples = {
  origin: string;
  body: { leashId: string; maxSeconds: number; task: { kind: 'sha256'; text: string } };
  bodyJson: string;
  curl: string;
  typescript: string;
  python: string;
};
export type ExampleField = keyof RequestExampleContext;
export class RequestExampleError extends Error {
  constructor(readonly field: ExampleField, message: string) { super(message); this.name = 'RequestExampleError'; }
}

/** Pin public snippets to production; only canonical loopback origins support local tests. */
export function requestExampleOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new RequestExampleError('serverOrigin', 'Open this tool on the Telomere site or a local loopback origin.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((value !== url.origin && value !== url.origin + '/') || url.username || url.password || url.search || url.hash
    || !(url.origin === 'https://my-telomere.com' || (local && ['http:', 'https:'].includes(url.protocol)))) {
    throw new RequestExampleError('serverOrigin', 'Use https://my-telomere.com or a canonical local loopback origin.');
  }
  return url.origin;
}

function shellLiteral(value: string): string { return "'" + value.replace(/'/g, "'\"'\"'") + "'"; }
// ASCII string literals work in both JavaScript and Python, including astral Unicode.
function ascii(value: string): string { return value.replace(/[\u007f-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')); }
function literal(value: string): string { return ascii(JSON.stringify(value)); }
function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function buildRequestExamples(context: RequestExampleContext): RequestExamples {
  const origin = requestExampleOrigin(context.serverOrigin);
  if (typeof context.leashId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(context.leashId)) {
    throw new RequestExampleError('leashId', 'Enter an existing confirmed Leash ID: 0x followed by 64 hexadecimal characters.');
  }
  const limit = context.runtimeMaxSeconds ?? 120;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 120) throw new RequestExampleError('runtimeMaxSeconds', 'The runtime CPU limit must be a whole number from 1 to 120.');
  if (!Number.isSafeInteger(context.maxSeconds) || context.maxSeconds < 1 || context.maxSeconds > limit) {
    throw new RequestExampleError('maxSeconds', `Choose a whole number from 1 to ${limit} seconds.`);
  }
  if (typeof context.taskText !== 'string' || !validUnicode(context.taskText) || new TextEncoder().encode(context.taskText).byteLength > 8192) {
    throw new RequestExampleError('taskText', 'Use valid Unicode text containing at most 8,192 UTF-8 bytes.');
  }
  if (typeof context.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(context.idempotencyKey)) {
    throw new RequestExampleError('idempotencyKey', 'Use 8–128 letters, numbers, underscores or hyphens for the idempotency key.');
  }
  const body: RequestExamples['body'] = {leashId: context.leashId.toLowerCase(), maxSeconds: context.maxSeconds, task: {kind: 'sha256', text: context.taskText}};
  // Keep shell arguments ASCII, including on Windows POSIX shells whose curl uses a legacy code page.
  const bodyJson = ascii(JSON.stringify(body));
  const key = context.idempotencyKey;
  const url = origin + '/api/quotes';
  const prerequisite = 'Requires a prior signed-wallet API login and an existing confirmed Leash owned by that wallet.';
  const scope = 'Prepares a quote and unsigned transaction only. Review the response; no broadcast or token approval.';
  const curl = [
    '#!/bin/sh', '# POSIX shell + curl. ' + prerequisite, '# ' + scope,
    '# Set TELOMERE_SESSION privately to the session token returned by your own API login.',
    'set -eu', ': "${TELOMERE_SESSION:?Set TELOMERE_SESSION from your signed-wallet API login}"',
    'case "$TELOMERE_SESSION" in *[!a-f0-9]*) echo "Invalid session token" >&2; exit 1;; esac',
    '[ "${#TELOMERE_SESSION}" -eq 64 ] || { echo "Invalid session token length" >&2; exit 1; }',
    'curl --fail --silent --show-error --max-time 30 \\',
    '  --request POST --url ' + shellLiteral(url) + ' \\',
    '  --header ' + shellLiteral('Origin: ' + origin) + ' \\',
    '  --header ' + shellLiteral('Content-Type: application/json') + ' \\',
    '  --header ' + shellLiteral('Accept: application/json') + ' \\',
    '  --header "Cookie: telomere_session=$TELOMERE_SESSION" \\',
    '  --header ' + shellLiteral('Idempotency-Key: ' + key) + ' \\',
    '  --data-binary ' + shellLiteral(bodyJson), '',
  ].join('\n');
  const typescript = [
    '// Node.js 22+. Valid TypeScript and JavaScript; save as quote.mjs and run node quote.mjs.',
    '// ' + prerequisite, '// ' + scope,
    'const token = process.env.TELOMERE_SESSION;',
    'if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Set TELOMERE_SESSION from your signed-wallet API login");',
    'const origin = ' + literal(origin) + ';',
    'const body = JSON.parse(' + literal(bodyJson) + ');',
    'const response = await fetch(origin + "/api/quotes", {',
    '  method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),',
    '  headers: { Origin: origin, "Content-Type": "application/json", Accept: "application/json",',
    '    Cookie: "telomere_session=" + token, "Idempotency-Key": ' + literal(key) + ' },',
    '  body: JSON.stringify(body)',
    '});', 'if (!response.ok) throw new Error("Quote request returned HTTP " + response.status);',
    'console.log(await response.text());', '',
  ].join('\n');
  const python = [
    '# Python 3 standard library. Save as quote.py and run python3 quote.py.',
    '# ' + prerequisite, '# ' + scope,
    'import json', 'import os', 'import re', 'import urllib.request', '',
    'token = os.environ.get("TELOMERE_SESSION", "")',
    'if re.fullmatch(r"[a-f0-9]{64}", token) is None:',
    '    raise ValueError("Set TELOMERE_SESSION from your signed-wallet API login")',
    'origin = ' + literal(origin),
    // Decode a JSON document, rather than treating JSON object syntax as Python.
    'body = json.loads(' + literal(bodyJson) + ')', '',
    'class NoRedirect(urllib.request.HTTPRedirectHandler):',
    '    def redirect_request(self, req, fp, code, msg, headers, newurl):',
    '        return None', '',
    'request = urllib.request.Request(origin + "/api/quotes",',
    '    data=json.dumps(body, ensure_ascii=True, separators=(",", ":")).encode("utf-8"),',
    '    headers={"Origin": origin, "Content-Type": "application/json", "Accept": "application/json",',
    '             "Cookie": "telomere_session=" + token, "Idempotency-Key": ' + literal(key) + '},',
    '    method="POST")',
    'with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:',
    '    print(response.read().decode("utf-8"))', '',
  ].join('\n');
  return {origin, body, bodyJson, curl, typescript, python};
}
