# Upstream x402 compatibility fixtures

The `permit2/`, `solmate/`, and `x402/` Solidity files are unchanged upstream MIT-licensed test dependencies. Each repository includes its original license. `provenance.json` records immutable commit URLs and SHA-256 hashes of every downloaded file. OpenZeppelin imports use the project's existing pinned 5.4.0 package.

`Permit2.compiled.json` is an offline deployment fixture compiled from the pinned, unchanged upstream `Permit2.sol` and its dependencies. Its compiler, settings, and SHA-256 are recorded in the manifest. The official Solidity 0.8.17 JavaScript compiler release has SHA-256 `617828e63be485c7cc2dbcbdd5a22b582b40fafaa41016ad595637b83c90656c`. Permit2's exact `pragma solidity 0.8.17` requires this compiler; the project compiler remains 0.8.28. Compilation used upstream optimizer/viaIR settings, a London EVM target, and no metadata bytecode hash. This is a local fixture build, not a claim that its runtime equals a deployed canonical runtime.

The test suite checks source and artifact integrity, deploys actual Permit2 bytecode, and compiles the unchanged upstream x402 proxy using the installed 0.8.28 compiler. It performs real EIP712 witness transfers on disposable Anvil chain 31337. Test addresses are local deployments, not canonical addresses or evidence of deployment on Robinhood Chain.

`LocalEip3009Token.sol` is first-party local-only code. Its constructor rejects other chains. Its mint function supplies disposable test tokens and is never production token logic; it demonstrates EIP3009 behavior and makes no USDG capability claim.

Reproduction: obtain the exact compiler release above from the official `ethereum/solc-bin` repository, verify SHA-256, compile `permit2/src/Permit2.sol` with `settings` from the artifact, and resolve imports only to the pinned `permit2/` and `solmate/` fixture files. ABI and creation bytecode must match the artifact. Regular tests require neither this compiler download nor an external network.
