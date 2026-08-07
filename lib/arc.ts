import { arcTestnet } from "viem/chains";
import type { Chain } from "viem";

export const ARC_CONFIG = {
  chainId: 5042002,
  name: "Arc Testnet",
  rpcUrl: "https://rpc.testnet.arc.network",
  explorerUrl: "https://testnet.arcscan.app",
  usdcErc20Address: "0x3600000000000000000000000000000000000000",
  usdcErc20Decimals: 6,
  usdcNativeDecimals: 18,
};

// Single source of truth for the Arc Testnet chain (viem's built-in
// arcTestnet with rpcUrls overridden so the docs-official
// https://rpc.testnet.arc.io comes FIRST — docs.arc.io/arc/references/connect-to-arc;
// the .network hosts are used by viem and the working Arc examples as fallback).
// Used by: wagmi config (frontend), wallet auto-switch, and every on-chain
// transaction (approve/deposit) — keeps the chain consistent everywhere.
export const arcChain: Chain = {
  ...arcTestnet,
  rpcUrls: {
    default: {
      http: [
        "https://rpc.testnet.arc.io",
        "https://rpc.testnet.arc.network",
        "https://rpc.blockdaemon.testnet.arc.network",
        "https://arc-testnet.drpc.org",
      ],
      webSocket: ["wss://rpc.testnet.arc.io", "wss://rpc.testnet.arc.network"],
    },
  },
};
