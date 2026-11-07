import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lets `next build` run into a separate dir while `next dev` keeps using .next
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Anti-clickjacking for the wallet-signing pages (/rescue, the Panic Bunker tab). Only frame-ancestors (plus
          // base-uri/object-src) is enforced: a script/connect CSP would break wallet connectors (Coinbase Smart Wallet
          // popup, WalletConnect relay, injected providers) and arbitrary user-configured RPCs.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          // No Cross-Origin-Opener-Policy on purpose: the Coinbase Smart Wallet popup talks to its opener via postMessage.
        ],
      },
    ];
  },
  webpack:(config, { webpack }) => {
    // Optional, lazily `import()`-ed peers of @coinbase/cdp-sdk (via wagmi's baseAccount connector).
    // Kestrel never calls those code paths, so the whole @x402/* namespace is ignored at bundle time.
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }));
    // Server-only modules (pager, x402) import Node built-ins as `node:x`. Next also compiles instrumentation for the
    // edge runtime, where webpack has no `node:` scheme handler; map `node:x` -> `x` (server bundles treat both as
    // built-in externals, and the edge copy of that branch never runs).
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
        resource.request = resource.request.replace(/^node:/, "");
      }),
    );
    config.resolve = config.resolve ?? {};
    config.resolve.alias = { ...(config.resolve.alias ?? {}), "@react-native-async-storage/async-storage": false };
    config.externals = [...(Array.isArray(config.externals) ? config.externals : []), "pino-pretty", "lokijs", "encoding"];
    return config;
  },
};

export default nextConfig;
