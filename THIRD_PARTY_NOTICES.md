# Third-party code and media

The root MIT grant covers original Telomere code. It does not relicense third-party material or grant use of another project's trademarks.

The public Framer CMS export under `website/dist/assets/cms` retains the original template's conditions. `website/cms-manifest.json` records its public source URLs, sizes and SHA-256 hashes. The builder localizes those fixed references without changing the imported motion source. These data files are outside the MIT grant for original Telomere code.

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

## Wallet brand icons

The six SVG wallet icons in `website/dist/assets/wallets/` are vendored unchanged from [RainbowKit](https://github.com/rainbow-me/rainbowkit/tree/03360ee924cfa6af13ff1d623b356bf5a170348e/packages/rainbowkit/src/wallets/walletConnectors), commit `03360ee924cfa6af13ff1d623b356bf5a170348e`. Wallet names and marks belong to their respective owners and identify the available providers; no affiliation is implied. Icons are served locally and do not load third-party resources.

Upstream license:

```text
MIT License

Copyright (c) 2024 Rainbow

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
