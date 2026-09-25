"use client";

// ZK passport onboarding (Rarimo RariMe): prove "over 18 and not from a blocked country" on the phone,
// the proof is verified ON-CHAIN by the fs_allowlist program, and the wallet allowlists itself. Rendered
// by the onboarding gate when the market accepts ZK KYC (walletStatus.kyc.available).
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { QRCodeSVG } from "qrcode.react";
import { Check, ExternalLink, Loader2, ScanFace, Smartphone } from "lucide-react";
import { TxLink } from "@/components/explorer-link";
import { api, isUserRejection, type WalletStatus } from "./client";

type Kyc = NonNullable<WalletStatus["kyc"]>;
type Phase = "idle" | "requesting" | "waiting" | "signing" | "confirming" | "done";

export function ZkKycPanel(props: {
  issuanceId: string;
  wallet: string;
  kyc: Kyc;
  /** Called once the on-chain allowlist entry is active. `signature` is the confirmed tx (null if it already existed). */
  onDone: (signature: string | null) => void;
  onError: (e: { code: string; message: string }) => void;
}) {
  const { issuanceId, wallet, kyc, onDone, onError } = props;
  const { connection } = useConnection();
  const { sendTransaction } = useWallet();
  const [phase, setPhase] = useState<Phase>(kyc.allowlisted ? "done" : "idle");
  const [link, setLink] = useState<string | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  const [citizenship, setCitizenship] = useState<string | null>(kyc.attested?.citizenship ?? null);
  const stop = useRef(false);

  useEffect(() => {
    stop.current = false;
    return () => {
      stop.current = true;
    };
  }, []);
  useEffect(() => {
    if (kyc.allowlisted && phase === "idle") {
      setPhase("done");
      onDone(null);
    }
  }, [kyc.allowlisted, phase, onDone]);

  const fail = useCallback(
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      setPhase("idle");
      onError(
        isUserRejection(e)
          ? { code: "rejected", message: "Transaction cancelled in the wallet. Nothing was recorded." }
          : { code: err.code ?? "kyc_error", message: err.message || "ZK passport verification failed." },
      );
    },
    [onError],
  );

  const sendAndConfirm = useCallback(
    async (b64: string) => {
      const tx = Transaction.from(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      setPhase("signing");
      const signature = await sendTransaction(tx, connection);
      setPhase("confirming");
      const res = await connection.confirmTransaction(
        { signature, blockhash: tx.recentBlockhash!, lastValidBlockHeight: tx.lastValidBlockHeight ?? (await connection.getBlockHeight()) + 150 },
        "confirmed",
      );
      if (res.value.err) throw Object.assign(new Error(`Transaction failed on-chain: ${JSON.stringify(res.value.err)}`), { code: "kyc_tx_failed" });
      setSig(signature);
      setPhase("done");
      onDone(signature);
    },
    [connection, sendTransaction, onDone],
  );

  const poll = useCallback(async () => {
    for (;;) {
      if (stop.current) return;
      const r = await api<{ status: "pending" } | { status: "verified"; citizenship: string; tx: string }>(
        `/api/issuances/${issuanceId}/kyc?wallet=${encodeURIComponent(wallet)}`,
      );
      if (r.status === "verified") {
        setCitizenship(r.citizenship);
        await sendAndConfirm(r.tx);
        return;
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
  }, [issuanceId, wallet, sendAndConfirm]);

  async function start() {
    onError({ code: "", message: "" });
    try {
      if (kyc.attested) {
        // valid attestation already on-chain: only the per-mint allow entry is missing
        setPhase("waiting");
        await poll();
        return;
      }
      setPhase("requesting");
      const r = await api<{ link: string }>(`/api/issuances/${issuanceId}/kyc`, { method: "POST", body: { wallet } });
      setLink(r.link);
      setPhase("waiting");
      await poll();
    } catch (e) {
      fail(e);
    }
  }

  const busy = phase === "requesting" || phase === "signing" || phase === "confirming";

  return (
    <div className="space-y-3 rounded-[3px] border bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
          <ScanFace className="size-4" />
        </span>
        <div className="min-w-0 space-y-1 text-sm">
          <p className="font-medium">Verify with a ZK passport</p>
          <p className="text-muted-foreground">
            Prove you are over {kyc.minAge ?? 18} and not a citizen of a blocked country
            {kyc.blocked?.length ? ` (${kyc.blocked.join(", ")})` : ""}. Your passport stays on your phone: only a zero-knowledge proof
            leaves it, and the Solana program verifies it on-chain.
          </p>
        </div>
      </div>

      {phase === "done" ? (
        <div className="flex items-center gap-2 rounded-[3px] border border-positive/30 bg-positive-soft px-3 py-2 text-sm">
          <Check className="size-4 text-positive" />
          <span>
            Verified{citizenship ? ` · ${citizenship}` : ""} · allowlisted on-chain
            {sig ? (
              <>
                {" "}
                · <TxLink sig={sig} />
              </>
            ) : null}
          </span>
        </div>
      ) : (
        <>
          {phase === "waiting" && link && (
            <div className="flex flex-col items-center gap-3 rounded-[3px] border bg-card p-4 sm:flex-row sm:items-start">
              <div className="rounded bg-white p-2">
                <QRCodeSVG value={link} size={148} />
              </div>
              <div className="space-y-2 text-sm">
                <p className="flex items-center gap-2 font-medium">
                  <Loader2 className="size-4 animate-spin" /> Waiting for your proof…
                </p>
                <p className="text-muted-foreground">
                  Scan with your phone (RariMe app, passport already registered there) and approve the request.
                </p>
                <a
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-medium underline underline-offset-4"
                >
                  <Smartphone className="size-3.5" /> Open in RariMe on this device <ExternalLink className="size-3" />
                </a>
              </div>
            </div>
          )}
          {(phase === "signing" || phase === "confirming") && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {phase === "signing" ? "Proof received. Confirm the verification transaction in your wallet…" : "Verifying the proof on-chain…"}
            </p>
          )}
          {(phase === "idle" || phase === "requesting") && (
            <button
              type="button"
              onClick={start}
              disabled={busy}
              className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-[2px] border border-input bg-card px-4 text-sm font-semibold hover:bg-muted disabled:pointer-events-none disabled:opacity-45"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ScanFace className="size-4" />}
              {kyc.attested ? "Use my existing verification" : "Verify with RariMe"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
