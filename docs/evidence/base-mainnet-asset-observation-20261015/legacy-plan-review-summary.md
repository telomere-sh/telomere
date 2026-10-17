# Independent review of the actual unsigned legacy plan

The reviewed plan has SHA-256
`2be56662f572ae01c25a2950f9f010104f12e2e30afb3150f153b96993f15bf8`,
review digest
`0xc9d585926f2489d5d3745ec996eac8fc8eab0fc2d217c9b352c5f6c627f00e2f`
and creation-data Keccak-256
`0x1d589d5abd07f90fed9e2c56710acba9b1ae9d5347032b413ef4e02607dc0b05`.
The original plan was read and left byte-for-byte unchanged.

`review-legacy-plan.mjs` compiles the actual Solidity and installed OpenZeppelin
sources in memory. Compiler identity, exact creation bytes, encoded constructor,
bytecode hash and complete normalized plan digest matched. It writes no compiler
artifacts, signs nothing and sends only public read-only RPC calls.

The reviewed constructor uses native Base USDC, the proposed owner/deployer/
treasury `0xa67c6a174409b9b44e67d24cdd386a31d44edb1d`, and dedicated service
quote/receipt signer `0x87599dBF6f720DE7751E8CB2d36d4Ea96A4A1d38`.
No private key was read or included. These are immutable constructor roles;
observing the proposal does not itself constitute an owner's wallet approval.

Two public RPC providers independently simulated those exact creation bytes
through `eth_call`. The sender balance was overridden only inside the read-only
simulation. No chain state or actual balance changed. Both returned the same
12,573-byte resolved runtime:

`0xd2ce03e0de4dc334d671294ae5f900eee12ff05cebc6f6484455103f0b204ed5`.

Every byte outside compiler-declared immutable ranges matched the freshly
compiled template. The runtime review directly checked nine immutable values:
token, quote signer, receipt signer, treasury, cached chain ID, cached address,
cached EIP-712 domain and hashed name/version. The accompanying
`runtime-shortstring-review.json` additionally checks the two OpenZeppelin
ShortString values against the documented name/version packing. All eleven
immutable values therefore have semantic checks across the retained packet.
This hash is an expected simulated runtime for the exact proposal, not a claim
that the contract has been deployed. After a user submits it, compare the actual
canonical transaction, receipt, runtime bytes/hash and getters again.

## Cost observation

At canonical Base block 52648894, both providers returned the same quote:

| Component | Wei |
| --- | --- |
| Reviewed gas limit | 3,402,641 gas |
| Proposed fresh EIP-1559 maximum fee per gas | 11,000,000 |
| Priority fee per gas | 1,000,000 |
| Gas limit times maximum fee | 37,429,051,000,000 |
| Current L1 fee estimate for exact unsigned encoding | 117,458,780,953 |
| L1 upper estimate for the 14,079-byte unsigned transaction | 190,960,739,104 |
| Operator fee at gas limit | 0 |
| Total using gas-limit ceiling and L1 upper estimate | 37,620,011,739,104 |

The latter is approximately `0.000037620011739104 ETH`, an observation rather
than a fixed future cost. The owner had zero actual ETH, so funding was
insufficient at this snapshot. This EIP-1559 price review is separate from the
unchanged original plan's six-million-wei gas-price observation. Refresh nonce,
vacancy, asset pins, execution estimate and all fee components before requesting
the actual wallet confirmation. L1 fee changes are not capped by maxFeePerGas.

The planner's original `sufficientForEstimate` covers only L2 execution. It must
not be displayed as total Base affordability. Funding the new service signer is
a separate owner-reviewed transfer; sending it from the deployer before creation
would consume the planned nonce and require preparation of a new plan.

Forty actual public RPC reads, exact simulation responses, unsigned cost bytes,
compiler-input hashes, observed canonical blocks and full resolved runtimes are
retained in `legacy-plan-runtime-cost-review.json`. No mainnet transaction was
submitted and no live service was changed during this review.
