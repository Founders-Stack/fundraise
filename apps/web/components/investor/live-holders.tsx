"use client";

// Holders read from chain (SPEC section 6): polled every 5s and refetched right after a confirmed
// swap. When balances move, the rest of the page (price, progress, yield) is refreshed too.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { cn } from "@/lib/utils";
import { AddrLink } from "@/components/explorer-link";
import { StatusTag } from "@/components/fs";
import { MARKET_CHANGED, api } from "./client";

export interface HoldersView {
  slot: number;
  holders: {
    wallet: string;
    kind: "POOL" | "PARTICIPANT" | "UNREGISTERED";
    label: string;
    tokens: { baseUnits: string; display: string };
    pctOfSupply: string;
    flag: string | null;
  }[];
  unregisteredCount: number;
  participantCount: number;
}

const POLL_MS = 5_000;
const keyOf = (v: HoldersView) => v.holders.map((h) => `${h.wallet}:${h.tokens.baseUnits}`).join("|");

export function LiveHolders({ issuanceId, symbol, initial, fake }: { issuanceId: string; symbol: string; initial: HoldersView; fake: boolean }) {
  const router = useRouter();
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const [view, setView] = useState(initial);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [updatedAt, setUpdatedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const last = useRef(initial);

  const load = useCallback(async () => {
    try {
      const next = await api<HoldersView>(`/api/issuances/${issuanceId}/holders`);
      setUpdatedAt(Date.now());
      if (keyOf(next) !== keyOf(last.current)) {
        const before = new Map(last.current.holders.map((h) => [h.wallet, h.tokens.baseUnits]));
        setChanged(new Set(next.holders.filter((h) => before.get(h.wallet) !== h.tokens.baseUnits).map((h) => h.wallet)));
        last.current = next;
        setView(next);
        router.refresh();
      }
    } catch {
      /* keep the last good view; the next poll retries */
    }
  }, [issuanceId, router]);

  useEffect(() => {
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    const onChange = () => void load();
    window.addEventListener(MARKET_CHANGED, onChange);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      window.removeEventListener(MARKET_CHANGED, onChange);
    };
  }, [load]);

  const ago = Math.max(0, Math.round((now - updatedAt) / 1000));

  return (
    <section className="overflow-hidden rounded-[4px] border bg-card">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
        <div>
          <h2 className="text-[15px] font-semibold">Holders</h2>
          <p className="text-xs text-muted-foreground">
            Balances read from chain · {view.participantCount} wallet{view.participantCount === 1 ? "" : "s"} onboarded
          </p>
        </div>
        <span className="flex items-center gap-[7px] rounded-[3px] border bg-card px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground" title={`Slot ${view.slot}`}>
          <span className="live-dot" /> {ago <= POLL_MS / 1000 + 1 ? "live" : `updated ${ago}s ago`}
        </span>
      </header>
      <table className="w-full text-sm">
        <thead className="bg-surface text-left">
          <tr className="[&>th]:px-4 [&>th]:py-2 [&>th]:label-mono [&>th]:font-normal sm:[&>th]:px-5">
            <th>Holder</th>
            <th className="text-right">{symbol}</th>
            <th className="text-right">Share</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {view.holders.map((h) => (
            <tr key={`${h.wallet}:${changed.has(h.wallet) ? view.slot : 0}`} className={cn("[&>td]:px-4 [&>td]:py-2.5 sm:[&>td]:px-5", changed.has(h.wallet) && "flash")}>
              <td>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <AddrLink addr={h.wallet} fake={fake} />
                  {h.wallet === me && <StatusTag tone="brand">You</StatusTag>}
                </div>
                <div className={cn("text-xs", h.kind === "UNREGISTERED" ? "text-warning" : "text-muted-foreground")}>{h.label}</div>
              </td>
              <td className="num text-right font-medium">{h.tokens.display}</td>
              <td className="num text-right text-muted-foreground">{h.pctOfSupply}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.unregisteredCount > 0 && (
        <p className="border-t px-4 py-2.5 text-xs text-warning sm:px-5">
          {view.unregisteredCount} holder{view.unregisteredCount === 1 ? " is" : "s are"} not a registered participant; their share of
          each distribution stays unallocated (retained by issuer).
        </p>
      )}
      <p className="border-t px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
        Units held by the Meteora pool aren&apos;t paid; their share of each period&apos;s pool stays with the issuer.
      </p>
    </section>
  );
}
