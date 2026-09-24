import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { explorerAddress, explorerTx, isSimulatedSig, shortAddr } from "@/components/format";

/** Tx signature → Solana Explorer (devnet). Fake-chain signatures render as a muted "simulated" chip. */
export function TxLink({ sig, className, chars = 6 }: { sig: string | null | undefined; className?: string; chars?: number }) {
  if (!sig) return <span className="text-muted-foreground">—</span>;
  if (isSimulatedSig(sig)) {
    return (
      <span
        title={sig === "already-allowlisted" ? "Already allowlisted on-chain" : `Local fake chain (CHAIN_MODE=fake): ${sig}`}
        className={cn("inline-flex items-center gap-1 font-mono text-xs text-muted-foreground", className)}
      >
        {sig === "already-allowlisted" ? "already allowlisted" : shortAddr(sig.replace(/^fake_/, ""), chars)}
        <span className="rounded bg-muted px-1 py-px font-sans text-[10px] uppercase tracking-wide">sim</span>
      </span>
    );
  }
  return (
    <a
      href={explorerTx(sig)}
      target="_blank"
      rel="noreferrer"
      className={cn("inline-flex items-center gap-0.5 font-mono text-xs text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground", className)}
    >
      {shortAddr(sig, chars)}
      <ArrowUpRight className="size-3 text-muted-foreground" />
    </a>
  );
}

export function AddrLink({ addr, className, chars = 4, fake }: { addr: string; className?: string; chars?: number; fake?: boolean }) {
  if (fake) {
    return <span title={addr} className={cn("font-mono text-xs", className)}>{shortAddr(addr, chars)}</span>;
  }
  return (
    <a
      href={explorerAddress(addr)}
      target="_blank"
      rel="noreferrer"
      title={addr}
      className={cn("font-mono text-xs underline decoration-border underline-offset-4 hover:decoration-foreground", className)}
    >
      {shortAddr(addr, chars)}
    </a>
  );
}
