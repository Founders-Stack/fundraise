"use client";

import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import { DevBurnerWalletAdapter, devBurnerEnabled } from "@/components/dev-burner-wallet";
import "@solana/wallet-adapter-react-ui/styles.css";

export function SolanaProvider({ children }: { children: ReactNode }) {
  const endpoint = process.env.NEXT_PUBLIC_RPC_URL || clusterApiUrl("devnet");
  // Phantom / Backpack / Solflare are discovered via wallet-standard; the burner is local dev only.
  const wallets = useMemo(() => (devBurnerEnabled() ? [new DevBurnerWalletAdapter()] : []), []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
