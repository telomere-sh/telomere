# Original website integration, 15 October 2026

All **411 files** from `Telomere-Website-Handoff.zip` are preserved byte-for-byte under `website/`, including the supplied source, built assets, motion code, media and documentation. The archive SHA-256 is `fcce1b980083ed4bdcde00bb37677dc256dc835dc3ceeac3e6d86bca3ec7f026`. The [import manifest](evidence/website-handoff-import-20261015.json) records every original file hash.

The backend serves the original website at `/` and keeps its functional console at `/console` and `/console/`. The supplied dashboard retains its original localStorage/sessionStorage behavior and JSON request export. It is not connected to backend Cell execution or receipt verification. Connecting those controls would require changing the supplied frontend.

`npm run build` compiles the backend and copies all **312 public assets** from `website/dist` to `dist/website` without running the frontend build. Run it before `npm run dev` or `npm start`; startup loads the finite website inventory before opening the database or chain connection. `npm run demo` prepares the public assets itself. For the original standalone preview, change directory to `website` and run `node serve.mjs` on localhost port 4196.

Static serving uses asynchronous file streaming, HEAD and single byte ranges, rejects symlinks and changed file identities, and never returns a website fallback for API, health, MCP, console or missing asset paths. Public website CSP allows the original inline scripts through exact SHA-256 hashes, inline styles, local Blob Workers and the required Google font origin. API and console policies retain their previous restrictions. No script `unsafe-inline` or `unsafe-eval` was added.

The [scoped validation record](website-handoff-validation-2026-10-15.json) retains the exact raw test report and the integration input hashes:

- Complete backend build passed, including Solidity compilation, TypeScript compilation, console bundling and website copy.
- Focused Node tests passed **124/124**, with zero failures or skips: website 29, existing service 6, CPU finish runner 32, CPU replan runner 42, financial MCP 14 and the actual local-EVM paid CPU job case 1.
- Supplied frontend `npm run check` passed without editing its files.
- Direct comparison confirmed all 411 imported files against the ZIP and all 312 copied public assets against their originals.
- The compiled website handler returned all 312 asset bodies exactly, refused seven reserved/missing paths and streamed a 1,024-byte video range with HTTP 206.

Browser observation confirmed initial rendering, loaded fonts/images and mounted landing sections. **Full animation acceptance is incomplete**: interactive motion, navigation transitions, all dashboard interactions, responsive cases, media playback and reduced-motion behavior were not comprehensively exercised. No statement here certifies every animation. Original handoff limitations remain unchanged, including a malformed mask declaration in a loading-spinner variant and canvas motion preference sampled at mount.

This focused verification is for the prepared local source. It does not establish a clean full-backend regression, an updated functional percentage, funded public Base/USDC acceptance, GPU Cells, TEE execution, live suppliers or staging activation. The previous full-run and Linux acceptance records retain their original source cutoffs. No public push or staging cutover was performed for this commit preparation.
