# 10. Copy request examples

Prepared locally behind `POSTLAUNCH_FEATURES=copy-examples`. `/developers/examples/` generates curl, TypeScript-compatible Node.js fetch and Python stdlib HTTP requests for the actual `/api/quotes` endpoint. The UI pins the site origin and current runtime CPU maximum, accepts an existing Leash and SHA-256 task text, and previews the exact body.

Examples prepare an unsigned quote only. They never approve tokens, broadcast a transaction or start paid compute. A prior signed-wallet API login supplies TELOMERE_SESSION privately in the caller's terminal; the page never reads or asks for the HttpOnly session cookie. Clipboard text includes task text, so the form warns against secrets. POSIX curl quoting, JSON serialization and idempotency keys are validated. Automatic copy has a manual-selection fallback.

Validation: 21 tests run the generated Node/Python/curl examples against a loopback HTTP receiver, check headers/body and reject hostile origin or shell injection. No production request is sent.
