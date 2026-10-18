# Contributing

Use a focused branch and describe the observable behavior changed. Preserve owner isolation, integer token accounting, original signed transaction replay, existing website styling and motion.

Install dependencies from both locks using `npm ci --ignore-scripts` and `npm --prefix website ci --ignore-scripts`. Run `npm run typecheck`, `npm run build`, `npm test`, `npm run release:verify`, the relevant Python suites and `python -B docs/verify-evidence.py`. The CI workflow documents isolated Linux/PostgreSQL and security gates.

Allow at least 4 GiB RAM for the full protocol TypeScript build. CI sets `NODE_OPTIONS=--max-old-space-size=3072`; a smaller container can otherwise exhaust V8's automatically selected heap before checking the complete tree. This build-time requirement is separate from the running CPU worker's workload limits.

Tests use disposable loopback EVM accounts. PostgreSQL acceptance accepts only an explicitly selected loopback `telomere_ci` or `telomere_audit` database. Never copy production `.env`, wallet keys, recovery identities or database backups into a checkout or test report.

Changes to financial code need negative, replay, conservation and rollback checks. Seeded campaigns must retain seeds, actual handler counts, expected reverts and discarded calls. Do not count repeated assertions as separate campaigns.

Security findings require a source-bound rationale. Do not suppress a detector, exclude a directory or silently replace a baseline to make CI green. Dependency changes must update reviewed versions, hashes and lockfiles together.

Report vulnerabilities privately through the process in SECURITY.md. Contributions to original Telomere code use the root MIT license; third-party contributions retain their applicable terms and attribution.
