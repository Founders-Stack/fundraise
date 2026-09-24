"use client";

// /sign/[requestId] (SPEC 0.4 P1): connect → build the tx(s) for this wallet → sign in the wallet →
// the server verifies, broadcasts and applies them → signatures + a link to the result.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import { ArrowRight, Check, Loader2, PenLine, Wallet } from "lucide-react";
import { TxLink } from "@/components/explorer-link";
import { shortAddr } from "@/components/format";
import { api, isUserRejection } from "@/components/investor/client";
import { Callout } from "@/components/investor/onboarding-gate";

/** Fake chain only: a stand-in founder address when no wallet is connected. */
const FAKE_FOUNDER = new PublicKey(new Uint8Array(32).fill(7)).toBase58();

interface Built {
  wallet: string;
  simulated: boolean;
  txs: { tx: string; label: string }[];
}

export interface SignFlowProps {
  id: string;
  status: "PENDING" | "COMPLETED" | "FAILED" | "EXPIRED";
  chainMode: "fake" | "devnet";
  signer: string | null;
  signatures: string[];
  lastError: string | null;
  doneUrl?: string;
}

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: Uint8Array) => btoa(Array.from(b, (c) => String.fromCharCode(c)).join(""));

export function SignFlow(props: SignFlowProps) {
  const router = useRouter();
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const { setVisible } = useWalletModal();
  const fake = props.chainMode === "fake";
  const wallet = publicKey?.toBase58() ?? (fake ? FAKE_FOUNDER : null);

  const [busy, setBusy] = useState<null | "build" | "sign" | "send">(null);
  const [error, setError] = useState<string | null>(null);
  const [signatures, setSignatures] = useState<string[]>(props.signatures);
  const [done, setDone] = useState(props.status === "COMPLETED");

  const wrongWallet = Boolean(props.signer && wallet && props.signer !== wallet);

  async function run() {
    if (!wallet) return;
    setError(null);
    try {
      setBusy("build");
      const built = await api<Built>(`/api/sign/${props.id}/build`, { method: "POST", body: { wallet } });
      let signedTxs: string[];
      if (built.simulated) {
        // Local fake chain: nothing a wallet can sign; the server applies the prepared effect.
        signedTxs = built.txs.map((t) => t.tx);
      } else {
        if (!signTransaction) throw new Error("This wallet can't sign transactions.");
        const txs = built.txs.map((t) => Transaction.from(fromB64(t.tx)));
        setBusy("sign");
        const signed = signAllTransactions && txs.length > 1 ? await signAllTransactions(txs) : await Promise.all(txs.map((t) => signTransaction(t)));
        signedTxs = signed.map((t) => toB64(t.serialize({ requireAllSignatures: false, verifySignatures: false })));
      }
      setBusy("send");
      const res = await api<{ signatures: string[] }>(`/api/sign/${props.id}/submit`, { method: "POST", body: { wallet, signedTxs } });
      setSignatures(res.signatures);
      setDone(true);
      router.refresh();
    } catch (e) {
      setError(isUserRejection(e) ? "Signature cancelled in the wallet. Nothing was sent." : (e as Error).message || "Signing failed.");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return (
      <div className="space-y-4">
        <Callout tone="positive">
          <span className="inline-flex items-center gap-2 font-medium">
            <Check className="size-4" /> Signed and confirmed.
          </span>{" "}
          You can close this tab; your agent sees the result.
        </Callout>
        <Signatures sigs={signatures} />
        {props.doneUrl && (
          <Link href={props.doneUrl} className="inline-flex items-center gap-1.5 text-sm font-semibold underline underline-offset-4">
            View the result <ArrowRight className="size-4" />
          </Link>
        )}
      </div>
    );
  }

  if (props.status === "EXPIRED") {
    return <Callout tone="warning">This sign link expired. Ask your agent for a new one.</Callout>;
  }

  return (
    <div className="space-y-4">
      {props.lastError && !error && <Callout tone="warning">The last attempt failed: {props.lastError}. You can sign again.</Callout>}
      {signatures.length > 0 && <Signatures sigs={signatures} label="Already confirmed" />}

      {!publicKey && !fake ? (
        <button
          type="button"
          onClick={() => setVisible(true)}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[3px] bg-foreground px-4 text-sm font-semibold text-background hover:opacity-90"
        >
          <Wallet className="size-4" /> Connect wallet
        </button>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Signing as <span className="font-mono text-foreground">{shortAddr(wallet ?? "", 6)}</span>
            {fake && !publicKey && " (local fake chain: simulated founder wallet)"}
            {fake && publicKey && " (local fake chain: the signature is simulated)"}
          </p>
          {wrongWallet && (
            <Callout tone="error">
              This request is being signed by <span className="font-mono">{shortAddr(props.signer!, 6)}</span>. Switch to that wallet.
            </Callout>
          )}
          <button
            type="button"
            disabled={Boolean(busy) || wrongWallet}
            onClick={run}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[3px] bg-brand px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <PenLine className="size-4" />}
            {busy === "build" ? "Preparing…" : busy === "sign" ? "Approve in your wallet…" : busy === "send" ? "Confirming on-chain…" : fake ? "Simulate signature" : "Review and sign"}
          </button>
        </>
      )}
      {error && <Callout tone="error">{error}</Callout>}
    </div>
  );
}

function Signatures({ sigs, label = "Signatures" }: { sigs: string[]; label?: string }) {
  if (sigs.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="eyebrow">{label}</p>
      <ul className="space-y-1">
        {sigs.map((s) => (
          <li key={s}>
            <TxLink sig={s} chars={10} />
          </li>
        ))}
      </ul>
    </div>
  );
}
