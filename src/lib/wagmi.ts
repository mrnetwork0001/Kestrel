import { createConfig, http, cookieStorage, createStorage } from "wagmi";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { baseMainnet, robinhoodMainnet } from "@/config/chains";

const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

export const wagmiConfig = createConfig({
  chains: [baseMainnet, robinhoodMainnet],
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
  connectors: [
    injected({ shimDisconnect: true }),
    // "all" lets users pick Coinbase Smart Wallet (EIP-5792 atomic batching) or the extension
    coinbaseWallet({ appName: "Kestrel Sentinel", preference: "all" }),
    ...(wcProjectId
      ? [walletConnect({ projectId: wcProjectId, showQrModal: true, metadata: { name: "Kestrel", description: "Overnight sentinel for Base & Robinhood Chain", url: "https://kestrel.vibestarter.xyz", icons: [] } })]
      : []),
  ],
  transports: {
    [baseMainnet.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org"),
    [robinhoodMainnet.id]: http(process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
