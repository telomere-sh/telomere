import { defineChain, type Address } from "viem";

// Base network metadata and Circle native USDC addresses reviewed 2026-10-14.
// https://docs.base.org/base-chain/network-information
// https://developers.circle.com/stablecoins/usdc-contract-addresses
export const baseMainnet = defineChain({
  id: 8453, name: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.base.org"] } },
  blockExplorers: { default: { name: "BaseScan", url: "https://basescan.org" } },
});
export const baseSepolia = defineChain({
  id: 84532, name: "Base Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
  blockExplorers: { default: { name: "Base Sepolia Explorer", url: "https://sepolia.basescan.org" } },
  testnet: true,
});
export const baseMainnetUsdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
export const baseSepoliaUsdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
export function baseUsdcForChainId(chainId: number): Address | undefined {
  if (chainId === 8453) return baseMainnetUsdc;
  if (chainId === 84532) return baseSepoliaUsdc;
  return undefined;
}
export const localChain = defineChain({
  id: 31337, name: "Telomere Disposable Local Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8547"] } }, testnet: true,
});
export function chainForId(chainId: number) {
  if (chainId === 31337) return localChain;
  if (chainId === 8453) return baseMainnet;
  if (chainId === 84532) return baseSepolia;
  throw new Error("Unsupported Telomere chain");
}
