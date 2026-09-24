import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@fstack/core"],
  // lib/cluster: expose SOLANA_CLUSTER to browser bundles (inlined at build).
  env: { NEXT_PUBLIC_SOLANA_CLUSTER: process.env.SOLANA_CLUSTER || process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "devnet" },
};

export default nextConfig;
