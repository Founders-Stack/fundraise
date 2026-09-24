import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { COPY } from "@fstack/core";
import { HttpError } from "@/lib/server/http";
import { loadIssuance } from "@/lib/server/issuance-record";
import { publicIssuanceView } from "@/lib/server/issuance";
import { getHoldersView, getMarketView } from "@/lib/server/market";
import { listDistributions } from "@/lib/server/distribution";
import { agreementSummary } from "@/lib/server/agreement-summary";
import { AgreementText } from "@/components/agreement-text";
import { AddrLink, TxLink } from "@/components/explorer-link";
import { fmtDate, plain, usd, usdCompact } from "@/components/format";
import { TradePanel } from "@/components/investor/trade-panel";
import { LiveHolders } from "@/components/investor/live-holders";
import { TokenGlyph } from "@/components/fs";
import { PriceChart } from "@/components/price-chart";

export const dynamic = "force-dynamic";

const STEPS = [COPY.onboardingSteps.connectWallet, COPY.onboardingSteps.acceptAgreement, COPY.onboardingSteps.tradingEnabled] as const;

async function load(id: string) {
  try {
    return await loadIssuance(id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
}

export default async function MarketPage({ params, searchParams }: PageProps<"/market/[id]">) {
  const { id } = await params;
  const invite = (await searchParams).invite;
  const issuance = await load(id);
  const info = publicIssuanceView(issuance);
  const { terms } = issuance;

  if (!issuance.market) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
        {terms.symbol} is still being created on-chain. Refresh in a few seconds.
      </div>
    );
  }

  let data;
  try {
    const [market, history, holders] = await Promise.all([getMarketView(id), listDistributions(id), getHoldersView(id, false)]);
    data = { market, history, holders };
  } catch (e) {
    return (
      <div className="mx-auto max-w-xl space-y-2 rounded-xl border p-8 text-sm">
        <p className="font-medium">Market data is unavailable right now</p>
        <p className="text-muted-foreground">{(e as Error).message}</p>
      </div>
    );
  }
  const { market: m, history, holders } = data;
  const fake = m.chainMode === "fake";
  const y = m.yield;
  // R7: with fewer than a year of periods, the headline is annualized from the last period and says so.
  const headline =
    y.periodsExecuted === 0
      ? { value: "—", note: "No distributions yet" }
      : y.isAnnualized
        ? { value: y.annualizedYield ?? "—", note: y.annualizedNote ?? "annualized" }
        : { value: y.trailingYield ?? "—", note: "last 12 months" };
  const freq = terms.distributionFrequency === "MONTHLY" ? "monthly" : "quarterly";

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------------------ header */}
      <div className="space-y-4">
        <nav className="eyebrow flex items-center gap-1.5">
          <Link href="/#markets" className="hover:underline">Markets</Link>
          <span className="text-faint">/</span>
          <span>{terms.symbol} · Cash flow rights</span>
        </nav>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            <TokenGlyph symbol={terms.symbol} size="lg" />
            <div>
              <h1 className="text-[27px] leading-tight font-semibold">{terms.issuerName}</h1>
              <p className="text-sm text-muted-foreground">
                {info.terms.poolPercentage} of {freq} Distributable Cash Flow · {info.terms.tokenSupplyDisplay} {terms.symbol} units
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="num text-3xl font-semibold tracking-[-0.03em] text-strong">{usd(m.price.baseUnits)}</p>
            <p className="text-xs text-muted-foreground">
              per unit · token market cap <span className="num">{usdCompact(m.tokenMarketCap.baseUnits)}</span> (not company valuation)
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-4">
          <Stat label="Distribution yield" value={headline.value} note={headline.note} positive={y.periodsExecuted > 0} />
          <Stat label="Last distribution / unit" value={y.periodsExecuted === 0 ? "—" : usd(y.lastDistributionPerToken.baseUnits)} note={y.history.at(-1)?.periodLabel ?? "—"} />
          <Stat label={COPY.nextRecordDate} value={fmtDate(m.nextRecordDate)} note={`Period ${m.nextPeriod.label}`} />
          <Stat label="Holders" value={String(m.holders.participants)} note="registered wallets holding units" />
        </dl>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* ---------------------------------------------------------- trade (first on mobile) */}
        <aside className="space-y-3 lg:sticky lg:top-20 lg:col-start-2 lg:row-start-1 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto lg:overscroll-contain">
          <TradePanel
            issuanceId={id}
            symbol={terms.symbol}
            chainMode={m.chainMode}
            graduated={m.progress.isMigrated}
            gate={{
              issuanceId: id,
              symbol: terms.symbol,
              agreement: { hash: issuance.agreement.hash, version: issuance.agreement.version, text: issuance.agreement.text, summary: agreementSummary(issuance) },
              steps: STEPS,
              selfAttested: COPY.selfAttested,
              inviteFromUrl: typeof invite === "string" ? invite : null,
            }}
          />
          <p className="px-1 text-xs text-muted-foreground">
            {COPY.positioning.eligibility} Prices come from the Meteora DBC curve; fees are shown before you sign.
          </p>
        </aside>

        {/* ---------------------------------------------------------- content */}
        <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-start-1">
          <PriceChart
            symbol={terms.symbol}
            startPrice={issuance.startingMarketCap / terms.tokenSupply}
            currentPrice={BigInt(m.price.baseUnits)}
            graduationPrice={issuance.graduationMarketCap / terms.tokenSupply}
            progressBps={m.progress.bps}
            isMigrated={m.progress.isMigrated}
          />

          {/* yield + history */}
          <section className="overflow-hidden rounded-xl border bg-card">
            <header className="border-b px-4 py-3 sm:px-5">
              <h2 className="text-[15px] font-semibold">Distributions</h2>
              <p className="text-xs text-muted-foreground">{COPY.trailingYield}</p>
            </header>
            <div className="grid gap-px bg-border sm:grid-cols-3">
              <Metric
                label="Distribution yield"
                value={headline.value}
                note={
                  y.periodsExecuted === 0
                    ? "after the first distribution"
                    : y.isAnnualized
                      ? `${usd(y.lastDistributionPerToken.baseUnits)} × ${y.periodsPerYear} ÷ price, ${headline.note}`
                      : "last 12 months of distributions ÷ price"
                }
              />
              <Metric
                label="Paid per unit, last 12 months"
                value={y.periodsExecuted === 0 ? "—" : usd(y.ttmPerToken.baseUnits)}
                note={y.periodsExecuted === 0 ? "—" : `trailing yield ${y.trailingYield} at today's price`}
              />
              <Metric label="Next record date" value={fmtDate(m.nextRecordDate)} note={m.distributionDue ? "Due: the issuer reports this period next" : `End of ${m.nextPeriod.label}`} />
            </div>
            {history.distributions.length === 0 ? (
              <p className="border-t px-4 py-6 text-center text-sm text-muted-foreground sm:px-5">
                No periods reported yet. After each period closes, the issuer reports its cash flow and current holders are paid in USDC.
              </p>
            ) : (
              <div className="overflow-x-auto border-t">
                <table className="w-full min-w-[440px] text-sm">
                  <thead className="bg-surface text-left">
                    <tr className="[&>th]:px-4 [&>th]:py-2 [&>th]:label-mono [&>th]:font-normal sm:[&>th]:px-5">
                      <th>Period</th>
                      <th className="text-right">Reported DCF</th>
                      <th className="text-right">Rights pool</th>
                      <th className="text-right">Per unit</th>
                      <th className="text-right">Paid</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {[...history.distributions].reverse().map((d) => (
                      <tr key={d.id} className="group [&>td]:px-4 [&>td]:py-3 sm:[&>td]:px-5">
                        <td className="whitespace-nowrap">
                          <Link href={`/distributions/${d.id}`} className="inline-flex items-center gap-0.5 font-medium hover:underline">
                            {d.periodLabel} <ArrowUpRight className="size-3 text-muted-foreground group-hover:text-foreground" />
                          </Link>
                          <div className="text-xs text-muted-foreground">{d.status === "EXECUTED" ? fmtDate(d.executedAt) : <StatusText status={d.status} />}</div>
                        </td>
                        <td className="num text-right text-muted-foreground">{usd(d.dcf.baseUnits)}</td>
                        <td className="num text-right">{usd(d.rightsPool.baseUnits)}</td>
                        <td className="num text-right font-medium">{usd(d.perToken.baseUnits)}</td>
                        <td className="num text-right">{d.totalAllocated ? usd(d.totalAllocated.baseUnits) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <LiveHolders issuanceId={id} symbol={terms.symbol} initial={plain(holders)} fake={fake} />

          {/* bonding curve */}
          <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-[15px] font-semibold">Bonding curve</h2>
              <span className="num text-sm font-medium">{m.progress.pct}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(1, Math.min(100, m.progress.bps / 100))}%` }} />
            </div>
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span className="num">{usd(m.progress.quoteReserve.baseUnits)} USDC in the curve</span>
              <span className="num">graduates at {usd(m.progress.migrationQuoteThreshold.baseUnits)}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Starts at the yield-implied price ({info.terms.startingPricePerToken.display} / unit = {info.terms.targetInitialYield} target yield on{" "}
              {info.terms.expectedAnnualDcf.display}/yr expected DCF) and rises to {info.terms.graduationMultiple}× at graduation. At
              graduation the pool migrates to Meteora DAMM v2 and the transfer hook is removed; distributions still go only to registered
              participants.
            </p>
          </section>

          {/* economics */}
          <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
            <div>
              <h2 className="text-[15px] font-semibold">{m.economics.label}</h2>
              <p className="text-xs text-muted-foreground">{m.economics.note}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <p className="eyebrow">At graduation</p>
                <div className="flex h-2 overflow-hidden rounded-full">
                  <span className="bg-brand" style={{ width: `${m.economics.split.issuerPct}%` }} />
                  <span className="bg-chart-3" style={{ width: `${Math.max(1, m.economics.split.platformPct)}%` }} />
                  <span className="bg-chart-2" style={{ width: `${m.economics.split.liquidityPct}%` }} />
                </div>
                <ul className="space-y-1 text-sm">
                  <Split dot="bg-brand" label={`${terms.issuerName} (${m.economics.split.issuerPct}%)`} value={usd(m.economics.atGraduation.issuer.baseUnits)} />
                  <Split dot="bg-chart-3" label={`Founder Stack (${m.economics.split.platformPct}%)`} value={usd(m.economics.atGraduation.founderStack.baseUnits)} />
                  <Split dot="bg-chart-2" label={`Locked liquidity (${m.economics.split.liquidityPct}%)`} value={usd(m.economics.atGraduation.liquidity.baseUnits)} />
                </ul>
              </div>
              <div className="space-y-2">
                <p className="eyebrow">Trading fees</p>
                <ul className="space-y-1 text-sm">
                  {m.economics.fees.lines
                    .filter((l) => l.label === "Trading fees")
                    .map((l) => (
                      <li key={l.label} className="text-muted-foreground">{l.value}</li>
                    ))}
                  <Split label="Accrued to the startup" value={usd(m.accruedTradingFees.startup.baseUnits)} />
                  <Split label="Accrued to Founder Stack" value={usd(m.accruedTradingFees.founderStack.baseUnits)} />
                </ul>
              </div>
            </div>
          </section>

          {/* terms + agreement */}
          <section id="agreement" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-4 sm:p-5">
            <h2 className="text-[15px] font-semibold">Terms</h2>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Term label="Issuer" value={`${terms.issuerName} (${terms.issuerJurisdiction})`} />
              <Term label="Rights" value={`${info.terms.poolPercentage} of ${freq} Distributable Cash Flow`} />
              <Term label="Units" value={`${info.terms.tokenSupplyDisplay} ${terms.symbol} (fixed supply, mint authority revoked)`} />
              <Term label="Record date" value={terms.recordDateRule.charAt(0).toUpperCase() + terms.recordDateRule.slice(1)} />
              <Term label="Distributable Cash Flow" value={terms.distributableCashFlowDefinition} wide />
              <Term label="Unit mint" value={<AddrLink addr={issuance.market.baseMint} fake={fake} chars={6} />} />
              <Term label="Meteora DBC pool" value={<AddrLink addr={issuance.market.dbcPool} fake={fake} chars={6} />} />
              <Term label="Pool creation" value={<span className="flex flex-wrap gap-2">{issuance.market.signatures.map((s) => <TxLink key={s} sig={s} />)}</span>} />
              <Term label="Custody" value={COPY.demoCustody} />
            </dl>
            <details className="group rounded-lg border bg-surface">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="font-medium">Cash Flow Participation Agreement {issuance.agreement.version}</span>
                <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                  sha256 {issuance.agreement.hash.slice(0, 10)}…
                  <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                </span>
              </summary>
              <div className="border-t px-4 py-4">
                <AgreementText markdown={issuance.agreement.text} />
                <p className="mt-4 break-all font-mono text-[11px] text-muted-foreground">sha256 {issuance.agreement.hash}</p>
              </div>
            </details>
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, note, positive }: { label: string; value: string; note: string; positive?: boolean }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="label-mono">{label}</dt>
      <dd className={`num mt-1 text-xl font-semibold tracking-[-0.02em] ${positive ? "text-positive" : "text-strong"}`}>{value}</dd>
      <dd className="num text-xs text-muted-foreground">{note}</dd>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="bg-card px-4 py-3 sm:px-5">
      <p className="label-mono">{label}</p>
      <p className="num mt-1 text-base font-semibold text-strong">{value}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function Split({ dot, label, value }: { dot?: string; label: string; value: string }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-muted-foreground">
        {dot && <span className={`size-2 rounded-full ${dot}`} />}
        {label}
      </span>
      <span className="num">{value}</span>
    </li>
  );
}

function Term({ label, value, wide }: { label: string; value: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="label-mono">{label}</dt>
      <dd className="mt-1">{value}</dd>
    </div>
  );
}

function StatusText({ status }: { status: string }) {
  return <span className="text-warning">{status === "DRAFT" ? "Reported, awaiting snapshot" : "Snapshot taken, awaiting payout"}</span>;
}
