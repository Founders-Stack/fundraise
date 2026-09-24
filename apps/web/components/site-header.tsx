import Link from "next/link";
import { WalletButton } from "@/components/wallet-button";
import { ThemeToggle } from "@/components/theme-toggle";

/** Founder Stack brand mark: an accent ring with a dot (f-stack.ai). */
export function Logo({ className = "size-[27px]" }: { className?: string }) {
  return (
    <span aria-hidden className={`relative grid shrink-0 place-items-center rounded-full border-2 border-brand ${className}`}>
      <i className="block size-2 rounded-full bg-brand" />
    </span>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/88 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-6">
          <Link href="/" aria-label="Founder Stack home" className="flex shrink-0 items-center gap-2.5">
            <Logo />
            <span className="hidden flex-col leading-tight sm:flex">
              <strong className="text-[15px] font-semibold tracking-[-0.02em] text-strong">Founder Stack</strong>
              <small className="font-mono text-[9px] tracking-[0.08em] text-faint uppercase">Capital · Cash Flow Rights</small>
            </span>
          </Link>
          <nav className="hidden items-center gap-5 font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase md:flex">
            <Link href="/#markets" className="hover:text-foreground">Markets</Link>
            <Link href="/#agent" className="hover:text-foreground">For founders</Link>
          </nav>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <span className="inline-flex items-center gap-[7px] rounded-[3px] border bg-card px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground">
            <i className="size-1.5 rounded-full bg-warning shadow-[0_0_0_3px_var(--warning-soft)]" />
            devnet
          </span>
          <ThemeToggle />
          <div className="fs-wallet">
            <WalletButton />
          </div>
        </div>
      </div>
    </header>
  );
}
