import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  // Served under f-stack.ai/fundraise via a rewrite on the main site (NEXT_PUBLIC_BASE_PATH=/fundraise).
  basePath: basePath || undefined,
  transpilePackages: ["@fstack/core"],
  // lib/cluster: expose SOLANA_CLUSTER to browser bundles (inlined at build).
  env: { NEXT_PUBLIC_BASE_PATH: basePath, NEXT_PUBLIC_SOLANA_CLUSTER: process.env.SOLANA_CLUSTER || process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "devnet" },
};

export default nextConfig;
