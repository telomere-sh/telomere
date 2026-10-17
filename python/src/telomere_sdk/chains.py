"""Reviewed Python SDK chain and native USDC identities.

Circle publishes the two token addresses at
https://developers.circle.com/stablecoins/usdc-contract-addresses.
"""

LOCAL_CHAIN_ID = 31337
BASE_MAINNET_CHAIN_ID = 8453
BASE_SEPOLIA_CHAIN_ID = 84532
SUPPORTED_CHAIN_IDS = frozenset((LOCAL_CHAIN_ID, BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID))
PUBLIC_BASE_CHAIN_IDS = frozenset((BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID))

BASE_MAINNET_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
BASE_MAINNET_RPC = "https://mainnet.base.org"
BASE_SEPOLIA_RPC = "https://sepolia.base.org"

MODE_CHAIN_IDS = {"demo": LOCAL_CHAIN_ID, "testnet": BASE_SEPOLIA_CHAIN_ID, "mainnet": BASE_MAINNET_CHAIN_ID}
PUBLIC_BASE_TOKENS = {BASE_MAINNET_CHAIN_ID: BASE_MAINNET_USDC, BASE_SEPOLIA_CHAIN_ID: BASE_SEPOLIA_USDC}
PUBLIC_BASE_RPCS = {BASE_MAINNET_CHAIN_ID: BASE_MAINNET_RPC, BASE_SEPOLIA_CHAIN_ID: BASE_SEPOLIA_RPC}
PUBLIC_BASE_EXPLORERS = {BASE_MAINNET_CHAIN_ID: "https://basescan.org",
                         BASE_SEPOLIA_CHAIN_ID: "https://sepolia.basescan.org"}
PUBLIC_BASE_USDC_DOMAINS = {
    BASE_MAINNET_CHAIN_ID: {"name": "USD Coin", "symbol": "USDC", "version": "2"},
    BASE_SEPOLIA_CHAIN_ID: {"name": "USDC", "symbol": "USDC", "version": "2"},
}

# Circle's FiatTokenProxy uses org.zeppelinos.proxy.implementation, not EIP-1967.
CIRCLE_IMPLEMENTATION_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3"
