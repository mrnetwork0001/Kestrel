import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lets `next build` run into a separate dir while `next dev` keeps using .next
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  webpack: (config, { webpack }) => {
    // Optional, lazily `import()`-ed peers of @coinbase/cdp-sdk (via wagmi's baseAccount connector).
    // Kestrel never calls those code paths, so the whole @x402/* namespace is ignored at bundle time.
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }));
    config.resolve = config.resolve ?? {};
    config.resolve.alias = { ...(config.resolve.alias ?? {}), "@react-native-async-storage/async-storage": false };
    config.externals = [...(Array.isArray(config.externals) ? config.externals : []), "pino-pretty", "lokijs", "encoding"];
    return config;
  },
};

export default nextConfig;
