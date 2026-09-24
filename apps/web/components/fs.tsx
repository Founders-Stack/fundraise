// Small Founder Stack (f-stack.ai) design-system pieces shared across pages.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The module tile: a solid accent square with mono initials ("MK" on the f-stack shelf). */
export function TokenGlyph({ symbol, size = "md" }: { symbol: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[3px] bg-brand font-mono font-semibold text-white",
        size === "sm" && "size-7 text-[10px]",
        size === "md" && "size-9 text-[11px]",
        size === "lg" && "size-12 text-[13px]",
      )}
    >
      {symbol.slice(0, 4)}
    </span>
  );
}

type Tone = "neutral" | "positive" | "warning" | "danger" | "brand";

/** Status chip: 9px mono caps on a weak tint, 2px corners (f-stack `.status`). */
export function StatusTag({ tone = "neutral", dot, children, className }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[2px] px-[7px] py-[3px] font-mono text-[9px] leading-none tracking-[0.06em] uppercase",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "positive" && "bg-positive-soft text-positive",
        tone === "warning" && "bg-warning-soft text-warning",
        tone === "danger" && "bg-destructive/10 text-destructive",
        tone === "brand" && "bg-brand-soft text-brand",
        className,
      )}
    >
      {dot && <i className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
