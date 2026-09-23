import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function Home() {
  const issuances = await prisma.issuance.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold">Cash Flow Rights</h1>
        <p className="text-muted-foreground">
          Contractual cash-flow participation rights. Distributions are based on issuer-reported
          Distributable Cash Flow.
        </p>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Issuances</CardTitle>
        </CardHeader>
        <CardContent>
          {issuances.length === 0 ? (
            <p className="text-sm text-muted-foreground">No issuances yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Issuer</TableHead>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Rights</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {issuances.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{i.issuerName}</TableCell>
                    <TableCell>{i.symbol}</TableCell>
                    <TableCell>{(i.poolPercentageBps / 100).toFixed(1)}% of DCF</TableCell>
                    <TableCell className="text-right">
                      <Link className="underline" href={`/market/${i.id}`}>Market</Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Launch from Claude Code / Codex</CardTitle>
          <CardDescription>Founders run the issuer side from their coding agent.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="rounded-md bg-muted p-4 text-sm overflow-x-auto">{`# Claude Code
/plugin install ./plugins/fstack
/fstack:fundraise

# Codex: skills in .agents/skills, MCP server in ~/.codex/config.toml`}</pre>
        </CardContent>
      </Card>
    </div>
  );
}
