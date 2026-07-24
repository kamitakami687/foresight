import { createConfig, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "viem/chains";

// Primary: dRPC's free public Arc Testnet gateway (no signup/API key
// required — verified live via eth_chainId). Secondary: Arc's own bare
// public endpoint. If one is rate-limited, viem's fallback transport
// automatically retries against the other.
export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: fallback([
      http("https://arc-testnet.drpc.org"),
      http("https://rpc.testnet.arc.network"),
    ]),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
