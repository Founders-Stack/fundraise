"use client";

import dynamic from "next/dynamic";

// Rendered client-only to avoid hydration mismatches from wallet detection.
export const WalletButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false },
);
