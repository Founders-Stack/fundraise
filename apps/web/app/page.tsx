import Link from "next/link";
import { ArrowRight, ArrowUpRight, Bot, ShieldCheck, Landmark, Waves } from "lucide-react";
import { COPY } from "@fstack/core";
import { currentCluster } from "@/lib/cluster";
import { listIssuances } from "@/lib/server/issuance-record";
import { getMarketView } from "@/lib/server/market";
import { CodeBlock } from "@/components/code-block";
import { bps, usd, usdCompact } from "@/components/format";

export const dynamic = "force-dynamic";

const CLAUDE_CODE = `# Claude Code: load the fstack plugin from the repo
export FS_API_URL=http://localhost:3000/api FS_API_TOKEN=dev-local-token
claude --plugin-dir ./plugins/fstack
> /fstack:fundraise`;

const CODEX = `# Codex: ~/.codex/config.toml
[mcp_servers.fstack]
command = "node"
args = ["/path/to/FS-Stocklana/packages/fstack-mcp/dist/index.js"]
env = { FS_API_URL = "http://localhost:3000/api", FS_API_TOKEN = "dev-local-token" }

# then, from the repo root
codex
> $fstack-fundraise`;

function freqWord(f: string) {
  return f === "MONTHLY" ? "monthly" : "quarterly";
}

async function loadRows() {
  const issuances = (await listIssuances()).map(({ record }) => record).reverse(); // oldest first
  return Promise.all(
    issuances.map(async (i) => {
      let market: Awaited<ReturnType<typeof getMarketView>> | null = null;
      if (i.market) {
        try {
          market = await getMarketView(i.id);
        } catch {
          market = null;
        }
      }
      return { i, market };
    }),
  );
}

export default async function Home() {
  const rows = await loadRows();

  return (
    <div className="space-y-16 sm:space-y-20">
      {/* ------------------------------------------------------------ hero */}
      <section className="grid items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-6">
          <p className="eyebrow">Cash Flow Rights · {currentCluster().copy.networkLabel}</p>
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Raise against your cash flow, straight from your coding agent.
          </h1>
          <p className="max-w-xl text-base text-muted-foreground text-pretty sm:text-lg">
            Founders launch a market for a share of future Distributable Cash Flow from Claude Code or Codex.
            Customers and fans onboard, trade on Meteora, and receive USDC each period.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="#markets"
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/85"
            >
              Browse markets <ArrowRight className="size-4" />
            </Link>
            <Link
              href="#agent"
              className="inline-flex h-10 items-center gap-2 rounded-lg border bg-card px-4 text-sm font-medium hover:bg-muted"
            >
              <Bot className="size-4" /> Operate from your agent
            </Link>
          </div>
          <p className="max-w-xl text-xs text-muted-foreground">
            {COPY.positioning.claim} {COPY.positioning.reported}
          </p>
        </div>

        <div className="relative">
          <div aria-hidden className="absolute -inset-6 -z-10 rounded-3xl bg-[radial-gradient(60%_60%_at_70%_30%,var(--brand-soft),transparent)]" />
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex items-center gap-1.5 border-b bg-surface px-3 py-2">
              <span className="size-2.5 rounded-full bg-foreground/15" />
              <span className="size-2.5 rounded-full bg-foreground/15" />
              <span className="size-2.5 rounded-full bg-foreground/15" />
              <span className="ml-2 font-mono text-[11px] text-muted-foreground">claude — acme-saas</span>
            </div>
            <div className="space-y-3 p-4 font-mono text-[12.5px] leading-relaxed">
              <p><span className="text-brand">›</span> /fstack:fundraise we&apos;re Acme SaaS, raise against 10% of quarterly cash flow</p>
              <div className="rounded-md border bg-surface p-3 text-muted-foreground">
                <p className="text-foreground">Preview · ACME</p>
                <p>Expected DCF $1.6M/yr × 10% → $160K rights pool</p>
                <p>÷ 16% target yield → <span className="text-foreground">$1.00 / token</span></p>
                <p>Graduation 48 / 2 / 50 · trading fees 50 / 50</p>
                <p>Agreement sha256 9f3c…a1e2</p>
              </div>
              <p><span className="text-brand">›</span> yes</p>
              <p className="text-muted-foreground">
                <span className="text-positive">✓</span> Market live · investor link /onboard/acme
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ pillars */}
      <section className="grid gap-4 sm:grid-cols-3">
        {[
          { icon: Landmark, title: "A contractual claim", body: COPY.positioning.claim },
          { icon: ShieldCheck, title: "Eligible holders only", body: COPY.positioning.eligibility },
          { icon: Waves, title: "Liquid from day one", body: COPY.positioning.meteora },
        ].map(({ icon: Icon, title, body }) => (
          <div key={title} className="rounded-xl border bg-card p-5">
            <Icon className="size-5 text-brand" />
            <h3 className="mt-3 text-sm font-medium">{title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{body}</p>
          </div>
        ))}
      </section>

      {/* ------------------------------------------------------------ markets */}
      <section id="markets" className="scroll-mt-20 space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Markets</h2>
            <p className="text-sm text-muted-foreground">Live cash-flow participation markets on Meteora DBC.</p>
          </div>
          <span className="hidden text-xs text-muted-foreground sm:block">{COPY.demoCustody}</span>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
            No issuances yet. Launch one with <code className="font-mono text-foreground">/fstack:fundraise</code>.
          </div>
        ) : (
          <>
            {/* desktop table */}
            <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
              <table className="w-full text-sm">
                <thead className="border-b bg-surface text-left">
                  <tr className="[&>th]:px-4 [&>th]:py-2.5 [&>th]:text-xs [&>th]:font-medium [&>th]:text-muted-foreground">
                    <th>Issuance</th>
                    <th>Rights</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Token market cap</th>
                    <th className="text-right">Trailing yield</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map(({ i, market }) => (
                    <tr key={i.id} className="group hover:bg-surface/60 [&>td]:px-4 [&>td]:py-4">
                      <td>
                        <Link href={`/market/${i.id}`} className="flex items-center gap-3">
                          <TokenMark symbol={i.terms.symbol} />
                          <div>
                            <div className="font-medium">{i.terms.symbol}</div>
                            <div className="text-xs text-muted-foreground">{i.terms.issuerName}</div>
                          </div>
                        </Link>
                      </td>
                      <td className="text-muted-foreground">
                        {bps(i.terms.poolPercentageBps)} of {freqWord(i.terms.distributionFrequency)} distributable cash flow
                      </td>
                      <td className="num text-right font-medium">{market ? usd(market.price.baseUnits) : "—"}</td>
                      <td className="num text-right text-muted-foreground">
                        {market ? usdCompact(market.tokenMarketCap.baseUnits) : "—"}
                      </td>
                      <td className="text-right">
                        <YieldCell market={market} />
                      </td>
                      <td className="text-right">
                        <Link
                          href={`/market/${i.id}`}
                          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground group-hover:text-foreground"
                        >
                          Trade <ArrowUpRight className="size-3.5" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* mobile cards */}
            <div className="grid gap-3 md:hidden">
              {rows.map(({ i, market }) => (
                <Link key={i.id} href={`/market/${i.id}`} className="rounded-xl border bg-card p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <TokenMark symbol={i.terms.symbol} />
                      <div>
                        <div className="font-medium">{i.terms.symbol}</div>
                        <div className="text-xs text-muted-foreground">{i.terms.issuerName}</div>
                      </div>
                    </div>
                    <div className="num text-right font-medium">{market ? usd(market.price.baseUnits) : "—"}</div>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {bps(i.terms.poolPercentageBps)} of {freqWord(i.terms.distributionFrequency)} distributable cash flow
                  </p>
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Trailing yield</span>
                    <YieldCell market={market} />
                  </div>
                </Link>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Trailing yield: {COPY.trailingYield.replace(/^Trailing distribution yield /, "")}. {COPY.marketCap}.
            </p>
          </>
        )}
      </section>

      {/* ------------------------------------------------------------ agent */}
      <section id="agent" className="scroll-mt-20 grid gap-8 rounded-2xl border bg-card p-6 sm:p-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-4">
          <p className="eyebrow">For founders</p>
          <h2 className="text-2xl font-semibold tracking-tight">Operate from your agent</h2>
          <p className="text-sm text-muted-foreground">
            The issuer side lives in Claude Code and Codex. One skill family,{" "}
            <code className="font-mono text-foreground">/fstack:fundraise</code>, launches the market, reports each
            period&apos;s cash flow from your own finance export, and distributes USDC. Every step that creates on-chain
            state or moves money shows a preview first and waits for your explicit yes.
          </p>
          <ol className="space-y-2 text-sm">
            {[
              "Launch: preview terms, pricing and agreement hash, then confirm",
              "Report: the agent reads ./finance/q3.csv and proposes the period's DCF",
              "Distribute: snapshot holders, type the exact total, signatures print",
            ].map((s, n) => (
              <li key={s} className="flex gap-3">
                <span className="num mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-medium text-brand">
                  {n + 1}
                </span>
                <span className="text-muted-foreground">{s}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="min-w-0 space-y-3">
          <CodeBlock label="Claude Code" code={CLAUDE_CODE} />
          <CodeBlock label="Codex" code={CODEX} />
        </div>
      </section>
    </div>
  );
}

function TokenMark({ symbol }: { symbol: string }) {
  return (
    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-[11px] font-semibold tracking-tight text-brand">
      {symbol.slice(0, 4)}
    </span>
  );
}

function YieldCell({ market }: { market: Awaited<ReturnType<typeof getMarketView>> | null }) {
  if (!market) return <span className="text-muted-foreground">—</span>;
  const y = market.yield;
  if (y.periodsExecuted === 0) return <span className="text-xs text-muted-foreground">No distributions yet</span>;
  return (
    <span className="inline-flex flex-col items-end">
      <span className="num font-medium text-positive">{y.trailingYield}</span>
      {y.annualizedNote && (
        <span className="num text-[11px] text-muted-foreground">
          {y.annualizedYield} {y.annualizedNote}
        </span>
      )}
    </span>
  );
}
