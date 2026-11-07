import { cookieStorage, createConfig, createStorage, fallback, http } from "wagmi";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { baseMainnet, robinhoodMainnet } from "@/config/chains";
import { siteUrl } from "@/lib/site";

const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

/** WalletConnect compares metadata.url with the page origin, so use the real one (browser) or the canonical site URL. */
const appUrl = typeof window !== "undefined" ? window.location.origin : siteUrl();

const basePrimary = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";
const baseFallback = process.env.NEXT_PUBLIC_BASE_FALLBACK_RPC_URL || "https://base-rpc.publicnode.com";

export const wagmiConfig = createConfig({
  chains: [baseMainnet, robinhoodMainnet],
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
  connectors: [
    injected({ shimDisconnect: true }),
    // "all" lets users pick Coinbase Smart Wallet (EIP-5792 atomic batching) or the extension
    coinbaseWallet({ appName: "Kestrel Sentinel", appLogoUrl: `${appUrl}/apple-icon`, preference: "all" }),
    ...(wcProjectId
      ? [walletConnect({ projectId: wcProjectId, showQrModal: true, metadata: { name: "Kestrel", description: "Overnight sentinel for Base & Robinhood Chain", url: appUrl, icons: [`${appUrl}/apple-icon`] } })]
      : []),
  ],
  transports: {
    // Rescue simulation, quotes, allowance re-reads and receipt polling all ride this transport: a rate-limited
    // public endpoint (HTTP 429 / -32011) fails over to the second one instead of disabling signing.
    [baseMainnet.id]: fallback(
      [...new Set([basePrimary, baseFallback, "https://mainnet.base.org"])].map((url) => http(url, { timeout: 12_000, retryCount: 1 })),
      { retryCount: 1 }
    ),
    [robinhoodMainnet.id]: http(process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
