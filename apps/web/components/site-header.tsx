import Link from "next/link";
import { WalletButton } from "@/components/wallet-button";
import { ThemeToggle } from "@/components/theme-toggle";

export function Logo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-6">
      <rect x="1" y="1" width="22" height="22" rx="6" className="fill-primary" />
      <path d="M6 16.5h3V12H6zM10.5 16.5h3V9h-3zM15 16.5h3V6.5h-3z" className="fill-brand" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-5">
          <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
            <Logo />
            <span className="hidden sm:inline">
              Founder Stack <span className="font-normal text-muted-foreground">/capital</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-4 text-sm text-muted-foreground md:flex">
            <Link href="/#markets" className="hover:text-foreground">Markets</Link>
            <Link href="/#agent" className="hover:text-foreground">For founders</Link>
          </nav>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning sm:px-2.5 sm:py-1">
            <span className="size-1.5 rounded-full bg-warning" />
            Devnet
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
