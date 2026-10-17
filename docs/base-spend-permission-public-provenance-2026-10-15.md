# Public Manager source provenance and exact rebuild, 15 October 2026

The canonical public Manager runtime is now reproduced **byte for byte on both Base and Base Sepolia, including metadata**, after exact substitution of the independently expected constructor/domain immutables. This resolves the metadata gap in the [earlier read-only snapshot](base-spend-permission-public-readonly-2026-10-15.md). It verifies source/build provenance at those recorded blocks; it does not approve a public pin or establish funded wallet acceptance.

No production, test or configuration source changed. No wallet, token, paid request or transaction was used. No gateway was repeatedly polled.

## Authenticated artifact retrieval

The two legacy Sourcify `full_match/.../metadata.json` requests returned HTTP404 with an API-v1 migration response. Its [current API documentation](https://docs.sourcify.dev/docs/api/) identifies the v2 read endpoint. One v2 request per chain returned metadata, sources and compiler settings successfully. An explorer fallback was unnecessary.

The API's `exact_match` label was not used as proof. Both responses supplied identical canonical metadata, **48002 bytes**, with 36 required source entries. Their additional 30 source-path aliases were excluded from compilation. Independently calculating the Solidity IPFS multihash reproduced the CID already embedded in both observed public runtimes:

`QmQCxNbuPnt54vEekdmU3A513RiDiYYGn1Tu16r2vV7wTV`

The multihash is `0x12201bbeb3272166953d2a5eb88d3845fc62e4d6b2898d0c1e326c1117e93e325e28`. Authentication used the single-chunk UnixFS/DAG-PB encoding implemented by [Solidity 0.8.28](https://github.com/ethereum/solidity/blob/v0.8.28/libsolutil/IpfsHash.cpp). As the [compiler documentation](https://docs.soliditylang.org/en/v0.8.28/metadata.html) explains, the direct SHA256 of the JSON file is a different hash. That direct file digest is `b427a895b88bcc431261739b641ed0c0d911c47b7c6f5fbe031345cf569bd1ee`; it is retained as an ordinary evidence-file checksum, not mistaken for the IPFS digest.

Every required source's UTF-8 content matched the keccak256 in the authenticated metadata. The second chain's metadata and all 36 required source contents were identical to the first chain's verified inputs. The earlier gateway HTTP429 remains recorded; its response-body checksum is diagnostic only.

## Exact offline reproduction

The authenticated settings identify solc `0.8.28+commit.7893614a`, Cancun, optimizer enabled with **999999** runs, IPFS metadata and the original import remappings. The installed pinned solc compiled the 36 authenticated source units. Its metadata output exactly matched the authenticated canonical metadata.

The seven immutable declarations at ten locations were filled with the expected Manager address, verified chain ID, computed EIP-712 name/version/domain hashes and the previously observed documented validator/MagicSpend addresses. Every resulting 32-byte value matched the corresponding public runtime location. The entire **12610-byte runtime**, including the 53-byte Solidity trailer, then matched:

| Chain | Observed and reproduced runtime keccak256 | Exact full-runtime match |
| --- | --- | --- |
| Base, 8453 | `0x2e9e272aa2f685632aae292aaf8bca67f22e4494ec831959bc6e9ff071378bea` | Yes |
| Base Sepolia, 84532 | `0x52485746e0e69bdb943d424484c356c7d3eb97599374f38b29e87dda34c521ee` | Yes |

This compares against the original RPC evidence at finalized Base block **52618360** and Base Sepolia block **48129000**. It performs no additional state-changing calls. The [earlier report](base-spend-permission-public-readonly-2026-10-15.md) retains the exact block hashes, domains, dependency code observations and independent-provider limitations.

## Difference from the local acceptance fixture

The retained local fixture uses the later official source reference `e0004e63edc4e17de7aa978293800ac7a16892e5`, optimizer runs **200**, and its documented local account/dependency boundary. It remains unchanged and remains a **9981-byte local artifact**, rather than the exact deployed public artifact.

All 36 retained source texts differ bytewise because of their retained line endings. Normalizing line endings makes 35 files identical to the authenticated public inputs. The remaining Manager file differs in precisely two lines: `magicspend/MagicSpend.sol` versus `magic-spend/MagicSpend.sol`, and the corresponding repository URL in a comment. The resolved MagicSpend source content matches after line-ending normalization. The authenticated public Manager source also exactly matches the raw Git blob from Coinbase's [v1.0.0 release](https://github.com/coinbase/spend-permissions/tree/v1.0.0), commit `54e99c7e73846418c9b5d2b4139c17d415a27d41`. The full source-path/hash inventory and narrow unified diff are retained.

The earlier executable-only comparison remains a valid historical observation from before the source bundle was available. This supplement establishes the previously missing exact metadata/build identity. It does not turn local account-executor tests into Base Account/AA acceptance, prove the original deployment transaction, review dependency authority, or authorize a public escrow deployment. Public runtime approval and real funded end-to-end acceptance remain separate decisions.

## Evidence and reproduction

The [machine-readable validation](base-spend-permission-public-provenance-validation-2026-10-15.json) inventories all nine evidence files with SHA256 checksums, including both raw Sourcify responses, authenticated metadata, the exact standard input, per-source and per-immutable comparisons, and the source diff. Source license notices remain available in the [reference fixture notices](../tests/fixtures/spend-permissions/REFERENCE_LICENSES.txt).

From the repository root, run:

```text
node docs/evidence/reproduce-public-spend-manager-20261015.mjs
```

The retained reproduction script authenticates the metadata CID and source keccaks, compiles with the installed pinned solc, asserts full-runtime identity for both snapshots and writes its outputs under `.local`. It makes **zero network requests**. That durable reproduction command completed with exit code **0** on 15 October 2026.
