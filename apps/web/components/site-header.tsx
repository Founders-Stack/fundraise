import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { WalletButton } from "@/components/wallet-button";

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          Founder Stack <span className="text-muted-foreground font-normal">/capital</span>
          <Badge variant="outline">devnet</Badge>
        </Link>
        <WalletButton />
      </div>
    </header>
  );
}
