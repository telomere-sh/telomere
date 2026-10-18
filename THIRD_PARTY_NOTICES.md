# Third-party code and media

The root MIT grant covers original Telomere code. It does not relicense third-party material or grant use of another project's trademarks.

| Material | Source of applicable terms |
| --- | --- |
| npm dependencies | The exact root and website lockfiles, each installed package's license and copyright notices |
| OpenZeppelin and other Solidity imports | Upstream package notices; preserve SPDX headers |
| Contract reference fixtures | Licenses and provenance retained beside `tests/fixtures/` sources |
| Python verification libraries | Exact requirement files and upstream wheel metadata/notices |
| Exported Framer/React/motion runtime | Original notices in `website/src/runtime/`, adjacent generated legal notices, and the original handoff terms |
| Photography and technology marks | `website/dist/assets/tech/asset-sources.json` and `website/dist/assets/tech/editorial/manifest.json` |
| Audio/video | `website/docs/audio-provenance.json` and corresponding media provenance |
| Telomere logos and brand artwork | Reserved to the Telomere project; the code license grants no trademark rights |

The checked-in website runtime is an exported source graph, not a complete registry lockfile of its original upstream build. The supply-chain inventory records each retained module by content hash and identifies this provenance boundary. An npm audit of the root application does not certify unidentified code inside that export.

Browser builds preserve recognized third-party legal comments in adjacent `.LEGAL.txt` files. Include these files when distributing the compiled JavaScript.
