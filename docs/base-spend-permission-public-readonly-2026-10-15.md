# Public SpendPermissionManager read-only verification, 15 October 2026

Subsequent evidence: the [authenticated provenance supplement](base-spend-permission-public-provenance-2026-10-15.md) reproduces the entire runtime, including metadata, on both chains. The report below preserves the earlier executable-only result and its original retrieval boundary.

The documented canonical Manager exists on both Base and Base Sepolia. Its type hash, EIP-712 domain and immutable dependency getters agree with the official interface. Recompiling the retained 36 official source inputs with the official **deploy** optimizer setting reproduces every byte preceding the Solidity metadata trailer after substituting all expected immutables. This is stronger than address recognition, but it does **not** reproduce the full metadata or approve a public runtime pin.

No wallet, signing key, paid endpoint, transaction or configuration enablement was used. Production and test sources were unchanged. This evidence adds no funded-public-acceptance or backend-completion claim.

## Canonical address and public observations

Coinbase's [pinned deployment README](https://github.com/coinbase/spend-permissions/blob/e0004e63edc4e17de7aa978293800ac7a16892e5/README.md) and [v1.0.0 release](https://github.com/coinbase/spend-permissions/releases/tag/v1.0.0) identify `0xf85210B21cC50302F477BA56686d2019dC9b67Ad`. Base's [network documentation](https://docs.base.org/get-started/connect-to-base) supplies the public RPCs and chain IDs used below. The release tag resolves locally to `54e99c7e73846418c9b5d2b4139c17d415a27d41`; our retained source reference remains `e0004e63edc4e17de7aa978293800ac7a16892e5`.

Reads began at **2026-10-15 01:20:55 UTC**. Each official endpoint returned the expected `eth_chainId`. Code and view calls used one explicit finalized block number per network, and a second header read returned the same hash.

| Network | Finalized block | Block timestamp UTC | Runtime bytes | Observed runtime keccak256 |
| --- | ---: | --- | ---: | --- |
| Base, 8453 | 52618360 | 2026-10-15 01:01:07 | 12610 | `0x2e9e272aa2f685632aae292aaf8bca67f22e4494ec831959bc6e9ff071378bea` |
| Base Sepolia, 84532 | 48129000 | 2026-10-15 01:04:48 | 12610 | `0x52485746e0e69bdb943d424484c356c7d3eb97599374f38b29e87dda34c521ee` |

Base block hash: `0xfd18714a7016d6dbf076fd240c592bb2ed4e126b14faeba530475ba84f7dcc33`. Base Sepolia block hash: `0xf66a5444c738dfe570b3fe8084c5dc902877b234e52a42899fc8f2a7ef3d588d`.

Both return `SPEND_PERMISSION_TYPEHASH = 0xc9fa0f0252014cf89ab0539e3bb3adcb76f93e6bb6494e8cc61c14e2761ee2e4`. Their domain fields are `0x0f`, name `Spend Permission Manager`, version `1`, the corresponding chain ID, the canonical Manager address, zero salt and no extensions.

The dependency getters and code observations agree across both networks:

| Getter | Address | Runtime bytes | Runtime keccak256 |
| --- | --- | ---: | --- |
| `PUBLIC_ERC6492_VALIDATOR` | `0xcfCE48B757601F3f351CB6f434CB0517aEEE293D` | 597 | `0x94a000eab18fdda0465241bd0e82487463fb2e539854a3645542e57ed8dde484` |
| `MAGIC_SPEND` | `0x011A61C07DbF256A68256B1cB51A5e246730aB92` | 6369 | `0x009286b156593cd94bbfee6c40925aa87c52950783b97d400ee6d58639691e2e` |

The validator address agrees with Coinbase's README; MagicSpend agrees with the [pinned deployment script](https://github.com/coinbase/spend-permissions/blob/e0004e63edc4e17de7aa978293800ac7a16892e5/script/Deploy.s.sol). These dependency observations establish addresses and code hashes, not a review of their ownership, upgrades or complete signature/withdrawal behavior.

A second free provider, PublicNode, corroborated both exact block headers and Base Sepolia's code at the same block. It refused historical Base code without a personal token. Its supplementary `latest` Base code matched the official finalized runtime; that is not a second independent historical-state proof. The refusal and successful reads are retained without requesting a token.

## Source and compiler comparison

The [official deploy configuration](https://github.com/coinbase/spend-permissions/blob/e0004e63edc4e17de7aa978293800ac7a16892e5/foundry.toml) specifies Cancun and optimizer runs **999999**. Our local Anvil fixture deliberately retained optimizer runs **200**. With solc `0.8.28+commit.7893614a.Emscripten.clang`, those settings produce 12610 and 9981 runtime bytes respectively. Therefore the local acceptance artifact cannot be called the exact public deployed artifact.

The comparison reused `tests/fixtures/spend-permissions/reference-input.json`, SHA256 `5a2825705245373c5d57a56f77acf406c6c09f924e44bef8b168876ba6e01128`, whose 36 input source digests were verified in the separately recorded local acceptance. Only optimizer runs changed to 999999; additional compiler output selected AST declarations and `immutableReferences`. No source text was changed.

All seven runtime immutable declarations, at ten 32-byte locations, matched their independently computed expected values:

| Immutable | Byte offsets in the deploy-profile runtime | Expected value source |
| --- | --- | --- |
| `_cachedThis` | 8161 | Canonical Manager address |
| `_cachedChainId` | 8196 | Verified RPC chain ID |
| `_cachedNameHash` | 8276 | keccak256 of the observed domain name |
| `_cachedVersionHash` | 8314 | keccak256 of domain version `1` |
| `_cachedDomainSeparator` | 8128 | EIP-712 domain computed with that chain ID and Manager |
| `PUBLIC_ERC6492_VALIDATOR` | 1109, 4295, 4966 | Observed getter, documented canonical validator |
| `MAGIC_SPEND` | 1222, 4041 | Observed getter, official deployment-script constant |

After these exact substitutions, all **12557 bytes** before the metadata trailer match on each chain. The remaining **53 bytes** comprise a 51-byte Solidity CBOR object plus its two-byte length. Both public chains have identical metadata and identify compiler 0.8.28. Their embedded IPFS CID is `QmQCxNbuPnt54vEekdmU3A513RiDiYYGn1Tu16r2vV7wTV`; the gateway returned HTTP 429, so the referenced metadata/source bundle was not retrieved or authenticated. The build's metadata differs. The cause and complete original compiler input have not been established.

This is an executable-code match to the retained official sources under the documented deploy optimizer setting, with expected chain/dependency immutables. It is not an exact full-runtime reproducible build or permission to copy these observed hashes into an enabled public profile. Public deployment review, new escrow deployment/source verification and actual funded wallet acceptance remain separate gates. The existing local Manager fixture's unused zero dependency constructor addresses remain a local direct-approval fixture limitation.

## Durable evidence

The [machine-readable report](base-spend-permission-public-readonly-validation-2026-10-15.json) records scope, source URLs, observations and SHA256 inventories. Raw evidence is retained in:

- [Official RPC requests and responses](evidence/public-spend-manager-rpc-20261015.json), including full code and view results.
- [Compiler comparison and immutable checks](evidence/public-spend-manager-build-comparison-20261015.json).
- [Independent-provider results and historical-read refusal](evidence/public-spend-manager-corroboration-20261015.json).
- [IPFS metadata retrieval attempt](evidence/public-spend-manager-ipfs-check-20261015.json).

To reproduce the comparison, compile the retained standard JSON input with the installed pinned solc, select deployed bytecode plus immutable references and AST, and set optimizer runs to 999999. Map the referenced AST IDs to the declarations above, substitute their exact values for each chain, then compare all preceding bytes and the CBOR trailer separately. The unmodified 200-runs build is retained in the comparison as a nonmatching baseline.
