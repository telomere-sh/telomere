# Robinhood testnet operator funding investigation

Network update, 14 October 2026: the active implementation targets Base and native Circle USDC. Earlier Robinhood/USDG evidence below remains historical and does not prove Base deployment or funded acceptance. See [the current migration record](base-usdc-migration-2026-10-14.md).

Checked on **8 October 2026 at 18:46:02 Moscow time**, after a legitimate Quicknode form attempt around 18:44. The form rejected the generated deployer address before funding. No test ETH was received. Both operational addresses still had zero gas balance at Robinhood testnet block **131,169,243**. Evidence is recorded in [testnet-funding-investigation.json](testnet-funding-investigation.json).

| Role | Generated controlled public address | Confirmed balance |
| --- | --- | --- |
| Deployer | `0x2C85d8d8B177476A7c705970891ed97a4046941D` | 0 wei |
| Quote / receipt / settlement operator | `0x5d38F6db9E574337f6F7a3895B1Eb9374198bFE1` | 0 wei |

The official public RPC responded with chain ID **46630**, matching [Robinhood's network documentation](https://docs.robinhood.com/chain/connecting/). Both balances were read at the same explicit block. Deployment plans and private operator profiles were left unchanged.

## Routes checked

| Route | Evidence | Result |
| --- | --- | --- |
| [Robinhood-hosted testnet faucet](https://faucet.testnet.chain.robinhood.com/) | The web reader returned HTTP 403. | No form was available to the reader. No identical retry, alternate egress, challenge bypass or guessed claim endpoint was used. |
| [Quicknode Robinhood faucet](https://faucet.quicknode.com/robinhood/testnet) | The FAQ advertises availability for fresh addresses without mainnet funds. In an ordinary Chrome session, the generated deployer was entered, Robinhood Testnet selected, and Continue clicked. The actual form returned **“Invalid ETH mainnet balance.”**, explaining that it currently requires a small mainnet balance for abuse prevention. Quicknode is listed among [Robinhood's supported providers](https://docs.robinhood.com/chain/connecting/). | The live eligibility check rejected the address; its behavior conflicts with the FAQ. No CAPTCHA was shown or solved, wallet signature requested, tokens received, or public transaction sent. |
| [Alchemy Robinhood faucet](https://www.alchemy.com/faucets/robinhood-testnet) | The provider offers 0.1 test ETH per 24 hours, with eligibility requiring at least 0.001 Ethereum mainnet ETH and sufficient mainnet transaction history. | The generated development identities have no approved mainnet funding or activity. No mainnet transfer, fabricated activity, borrowed identity or claim was attempted. |
| Official programmatic alternatives | The provider documentation searched did not expose a supported public Robinhood ETH claim API. Quicknode's documented x402 `/drip` route supplies Base Sepolia payment USDC, which does not fund Robinhood gas. | No applicable API route was found; no reverse-engineered or guessed faucet POST was sent. |

## Next autonomous step

The live Quicknode rejection establishes that this route currently cannot fund the fresh deployer without mainnet eligibility. An authorised alternative source of test ETH or a provider changing its eligibility rule is needed before public deployment. Existing generated addresses should be retained, and successful funding must be confirmed on chain before deployment proceeds. No mainnet activity should be fabricated to satisfy faucet criteria.

CUA's inventory had no available browser and its in-app browser attempt failed. The root task subsequently used an ordinary installed Chrome session for the actual form attempt described above. The CUA limitation therefore does not establish a general inability to open the faucet page.

This funding constraint affects publishing and testing on the public Robinhood testnet. The isolated CPU, escrow, settlement, restart and refund acceptance tests can continue on the existing disposable local chain without the user's wallet.
