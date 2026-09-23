import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";

export default async function MarketPage({ params }: PageProps<"/market/[id]">) {
  const { id } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Market {id}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-muted-foreground">
        <p>Price, terms, yield block, DBC progress, economics panel, buy/sell and holders (A14).</p>
        <Link className={buttonVariants()} href={`/onboard/${id}`}>Onboard to trade</Link>
      </CardContent>
    </Card>
  );
}
