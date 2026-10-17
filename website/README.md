# Telomere website handoff

Complete multi-page frontend and editable source for Telomere. It includes the landing page, protocol and compute pages, Host Kit content, field notes, developer interfaces, the browser-based workspace, and both finished 15-second films.

## Start

Use Node.js 18 or later. From this folder:

```sh
npm install
npm run dev
```

Open http://127.0.0.1:4196. No credentials or backend environment variables are needed to run the supplied frontend.

```sh
npm run check
npm run build
```

`dist/` is the complete static site, including compiled animation modules and media. `npm run build` rebuilds the adapted native landing animation source in `src/runtime/`. It does not overwrite the authored pages, dashboard, or styling. The exact build dependency is esbuild 0.28.2.

## Files to edit

| Area | Source |
| --- | --- |
| Shared shell, public pages, routing, content | `dist/site.js` |
| Shared public styling | `dist/site.css` |
| Agent capability icons and content | `dist/agent-panels.js` |
| Snake-inspired proof chain | `dist/proof-chain.js`, `dist/proof-chain.css` |
| Image preload and reveal gate | `dist/preload.js`, `build-assets.mjs` |
| Landing reference layout adjustments | `dist/home.css` |
| Editable landing animation components | `src/runtime/` |
| Landing static first paint | `dist/index.html` |
| Workspace state, forms, imports, exports | `dist/dashboard.js` |
| Workspace styling and mobile section picker | `dist/dashboard.css` |
| Deterministic motion graphics | `dist/motion.js` |
| Standalone seekable motion frame | `dist/motion.html` |
| Finished videos | `dist/assets/video/` |
| Brand, font, icon and photo assets | `dist/assets/` |

## Backend integration

Read `docs/BACKEND-HANDOFF.md` first. The current workspace stores configurations on the device; backend execution, settlement and cryptographic receipt verification are integration work. Public copy distinguishes prepared configurations from executed compute. The original overview and backend specifications are included in `docs/reference/`.

## Time and responsive navigation

Live clocks use `America/New_York` and US formatting, including the Eastern time abbreviation and daylight saving rules. Stored record timestamps remain UTC ISO strings. Dashboard record dates are presented in New York time.

The mobile bottom bar exposes Overview, Run plans, Leashes and Receipts. More opens all eight workspace sections plus the public site pages in a scrollable dialog. Page navigation closes open dialogs before switching routes.

## Motion and media

Both films are 1920×1080 at 60 fps, around 15 seconds, with audio. The protocol variant is `telomere-protocol-film.mp4`; the compute showreel is `telomere-compute-reel.mp4`. Embedded canvas films run silently without playback controls and stop rendering off-screen. The `seek(ctx, time, variant)` export in `dist/motion.js` computes each frame from time.

Photography and technology-mark provenance is in `dist/assets/tech/asset-sources.json` and `dist/assets/tech/editorial/manifest.json`. Audio provenance is in `docs/audio-provenance.json`. The landing reference is https://xzero.framer.website/ and retains its adapted native Framer animation source. Original Telomere brand artwork is under `dist/assets/brand/`.

## Deploy in your repository

Copy this folder into the chosen repository, install the build dependency and run the checks/build. Serve `dist/` as static output with assets at the site origin. Existing page directories contain their own `index.html`; other application routes should fall back to `dist/page.html`. Serve JavaScript modules, SVG, WOFF2 and MP4 using their normal MIME types. Keep `/assets/` and all public route paths intact, or update absolute references deliberately.

The handoff ZIP excludes Git history, local dependencies, credentials and the original Sites hosting identity. Its manifest records the source commit and SHA-256 of every included file. No original hosting account is required to run this copy.

## Image readiness and proof-chain interaction

`build-assets.mjs` creates `dist/image-manifest.json` and installs the preload boot script in the page entry HTML. The first visit downloads the local image manifest with bounded concurrency. Page images are decoded and fonts are ready before the content is revealed. Subsequent routes prepare their images inside the existing view transition. The loading view reports actual completed image requests; it has no artificial minimum display time. Native static image query variants are normalized to a shared URL for cache reuse.

The guarantees section is a Snake-inspired animated proof chain with eight selectable safeguards. Its segmented body grows as it collects orange apple checkpoints. Animation advances only while the section is visible, stops in hidden tabs, and respects reduced motion. Selecting a safeguard updates the detail panel. It visualizes protocol guarantees and does not represent a live run or verified transaction.

All expanded agent capability panels use their own documented content and branded icons. Company marks appear only for the related technologies. GitHub, Telegram and X community links have no trailing arrows.
