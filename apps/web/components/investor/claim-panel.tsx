"use client";

// Holder claim for an escrow-funded distribution (SPEC 7, P1): connect → fetch Merkle proof →
// sign the claim message in the wallet → the API verifies and releases the payout from escrow.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import { Check, Loader2, Wallet } from "lucide-react";
import { TxLink } from "@/components/explorer-link";
import { api, ApiError, isUserRejection } from "@/components/investor/client";

interface Proof {
  wallet: string;
  payout: { display: string };
  proof: string[];
  claimed: boolean;
  txSignature: string | null;
  claimMessage: string;
}

export function ClaimPanel({ distributionId, chainMode }: { distributionId: string; chainMode: "fake" | "devnet" }) {
  const router = useRouter();
  const { publicKey, signMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const wallet = publicKey?.toBase58() ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ payout: string; sig: string | null } | null>(null);

  async function claim() {
    if (!wallet) return;
    setError(null);
    setBusy(true);
    try {
      const p = await api<Proof>(`/api/distributions/${distributionId}/proof?wallet=${wallet}`);
      if (p.claimed) {
        setDone({ payout: p.payout.display, sig: p.txSignature });
        return;
      }
      let signature: string | undefined;
      if (signMessage) signature = bs58.encode(await signMessage(new TextEncoder().encode(p.claimMessage)));
      else if (chainMode !== "fake") throw new Error("This wallet can't sign messages; try another wallet.");
      const r = await api<{ payout: { display: string }; txSignature: string }>(`/api/distributions/${distributionId}/claim`, {
        method: "POST",
        body: { wallet, signature, proof: p.proof },
      });
      setDone({ payout: r.payout.display, sig: r.txSignature });
      router.refresh();
    } catch (e) {
      if (isUserRejection(e)) setError("Signature cancelled in the wallet.");
      else if (e instanceof ApiError && e.code === "no_allocation") setError("This wallet has no payout in this distribution's snapshot.");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <h2 className="text-[15px] font-semibold">Claim your payout</h2>
      <p className="text-xs text-muted-foreground">
        The issuer funded the claim escrow. Connect the wallet that held units at the snapshot and sign a claim message (signing costs
        nothing). The escrow sends your USDC to that wallet. Fees: Solana network fee, plus a one-time USDC account rent if your wallet
        has none; no other deduction.
      </p>
      {done ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Check className="size-4 text-positive" /> Claimed {done.payout}
          {done.sig && <TxLink sig={done.sig} />}
        </p>
      ) : wallet ? (
        <button
          type="button"
          onClick={claim}
          disabled={busy}
          className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-[2px] bg-primary px-3.5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {busy && <Loader2 className="size-3.5 animate-spin" />} Sign and claim
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setVisible(true)}
          className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-[2px] border border-input bg-muted px-3.5 text-sm font-semibold hover:bg-secondary"
        >
          <Wallet className="size-3.5" /> Connect wallet
        </button>
      )}
      {error && <p className="text-xs text-warning">{error}</p>}
    </section>
  );
}
