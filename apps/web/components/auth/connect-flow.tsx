"use client";

// /connect: connect wallet → sign a one-time message (free, no transaction) → get an API key for
// the fstack agent. The key is shown once; the server keeps only its hash.
import { useState } from "react";
import bs58 from "bs58";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { KeyRound, Loader2, Wallet } from "lucide-react";
import { CodeBlock } from "@/components/code-block";
import { shortAddr } from "@/components/format";
import { api, isUserRejection } from "@/components/investor/client";
import { Callout } from "@/components/investor/onboarding-gate";

interface Challenge {
  nonce: string;
  message: string;
}
interface Minted {
  apiKey: string;
  wallet: string;
}

export function ConnectFlow({ apiUrl }: { apiUrl: string }) {
  const { publicKey, signMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const wallet = publicKey?.toBase58() ?? null;
  const [busy, setBusy] = useState<null | "challenge" | "sign" | "verify">(null);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<Minted | null>(null);

  async function run() {
    if (!wallet) return;
    setError(null);
    if (!signMessage) {
      setError("This wallet can't sign messages. Try Phantom, Backpack or Solflare.");
      return;
    }
    try {
      setBusy("challenge");
      const c = await api<Challenge>("/api/auth/challenge", { method: "POST", body: { wallet } });
      setBusy("sign");
      const signature = bs58.encode(await signMessage(new TextEncoder().encode(c.message)));
      setBusy("verify");
      const res = await api<Minted>("/api/auth/verify", {
        method: "POST",
        body: { wallet, nonce: c.nonce, signature, label: "Created on /connect" },
      });
      setMinted(res);
    } catch (e) {
      setError(isUserRejection(e) ? "Signature cancelled in the wallet. No key was created." : (e as Error).message || "Sign-in failed.");
    } finally {
      setBusy(null);
    }
  }

  if (minted) {
    const defaultUrl = apiUrl.includes("localhost") ? `export FS_API_URL=${apiUrl}\n` : "";
    return (
      <div className="space-y-4">
        <Callout tone="warning">
          Copy your key now. It is shown once and can&apos;t be recovered. Anyone with it can launch tokens as {shortAddr(minted.wallet, 6)}.
        </Callout>
        <CodeBlock label="your API key" code={minted.apiKey} />
        <p className="text-sm text-muted-foreground">Then, in your terminal:</p>
        <CodeBlock
          code={`# one-time setup\nclaude plugin marketplace add Founders-Stack/fundraise\nclaude plugin install fstack@founder-stack\n\n# every session\n${defaultUrl}export FS_API_TOKEN=${minted.apiKey}\nclaude\n> /fstack:fundraise-launch`}
        />
      </div>
    );
  }

  if (!publicKey) {
    return (
      <button
        type="button"
        onClick={() => setVisible(true)}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[3px] bg-foreground px-4 text-sm font-semibold text-background hover:opacity-90"
      >
        <Wallet className="size-4" /> Connect wallet
      </button>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Signing in as <span className="font-mono text-foreground">{shortAddr(wallet ?? "", 6)}</span>
      </p>
      {error && <Callout tone="error">{error}</Callout>}
      <button
        type="button"
        disabled={Boolean(busy)}
        onClick={run}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[3px] bg-brand px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
        {busy === "challenge" ? "Preparing…" : busy === "sign" ? "Approve in your wallet…" : busy === "verify" ? "Creating key…" : "Sign and create API key"}
      </button>
    </div>
  );
}
