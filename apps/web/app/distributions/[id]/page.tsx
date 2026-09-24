import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { COPY } from "@fstack/core";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/server/http";
import { getPublicDistribution } from "@/lib/server/distribution";
import { AddrLink, TxLink } from "@/components/explorer-link";
import { fmtDate, usd } from "@/components/format";
import { StatusTag } from "@/components/fs";

export const dynamic = "force-dynamic";

// Read-only: one period's report, snapshot, allocations and payout signatures (SPEC sections 7, 9).
// Execution happens in the issuer's agent (fundraise-distribute); nothing here mutates.
export default async function DistributionPage({ params }: PageProps<"/distributions/[id]">) {
  const { id } = await params;
  let d;
  try {
    d = await getPublicDistribution(id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  const periods = await prisma.distribution.findMany({
    where: { issuanceId: d.issuance.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, periodLabel: true, status: true, perTokenBaseUnits: true },
  });
  const dist = d.distribution;
  const fake = d.chainMode === "fake";
  const executed = dist.status === "EXECUTED";

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------------------ header */}
      <div className="space-y-4">
        <nav className="eyebrow flex flex-wrap items-center gap-1.5">
          <Link href="/#markets" className="hover:underline">Markets</Link>
          <span className="text-faint">/</span>
          <Link href={`/market/${d.issuance.id}`} className="hover:underline">{d.issuance.symbol}</Link>
          <span className="text-faint">/</span>
          <span>Distribution {dist.periodLabel}</span>
        </nav>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h1 className="text-[27px] leading-tight font-semibold">{dist.periodLabel} distribution</h1>
              <StatusBadge status={dist.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              {d.issuance.issuerName} · {d.issuance.poolPercentage} of {d.issuance.distributionFrequency === "MONTHLY" ? "monthly" : "quarterly"}{" "}
              Distributable Cash Flow · {executed ? `paid ${fmtDate(dist.executedAt, true)}` : `reported ${fmtDate(dist.createdAt)}`}
            </p>
          </div>
          <Link
            href={`/market/${d.issuance.id}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-[2px] border border-input bg-muted px-3.5 text-sm font-semibold hover:bg-secondary"
          >
            {d.issuance.symbol} market <ArrowUpRight className="size-3.5" />
          </Link>
        </div>

        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-5">
          <Stat label="Reported DCF" value={usd(dist.dcf.baseUnits)} note="issuer-reported" />
          <Stat label={`Rights pool (${dist.poolPercentage})`} value={usd(dist.rightsPool.baseUnits)} note="DCF × rights %" />
          <Stat label="Per unit" value={usd(dist.perToken.baseUnits)} note={`÷ ${d.snapshot?.tokenSupply.display ?? BigInt(d.issuance.tokenSupply).toLocaleString("en-US")} units`} positive />
          <Stat label={executed ? "Paid to holders" : "To holders"} value={dist.totalAllocated ? usd(dist.totalAllocated.baseUnits) : "—"} note={d.totals ? `${d.totals.payees} wallet${d.totals.payees === 1 ? "" : "s"}` : "after snapshot"} />
          <Stat label="Unallocated" value={dist.unallocated ? usd(dist.unallocated.baseUnits) : "—"} note="retained by issuer" />
        </dl>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-6">
          {/* allocations */}
          <section className="overflow-hidden rounded-xl border bg-card">
            <header className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3 sm:px-5">
              <h2 className="text-[15px] font-semibold">Allocations</h2>
              <span className="text-xs text-muted-foreground">
                {d.snapshot ? `Snapshot at slot ${d.snapshot.slot.toLocaleString("en-US")} · ${fmtDate(d.snapshot.takenAt, true)}` : "No snapshot yet"}
              </span>
            </header>
            {d.rows.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground sm:px-5">
                {dist.status === "DRAFT"
                  ? "Reported. Allocations appear once the issuer takes the holder snapshot."
                  : "No registered participant held units at the snapshot."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="bg-surface text-left">
                    <tr className="[&>th]:px-4 [&>th]:py-2 [&>th]:label-mono [&>th]:font-normal sm:[&>th]:px-5">
                      <th>Holder</th>
                      <th className="text-right">Units</th>
                      <th className="text-right">Share</th>
                      <th className="text-right">Payout</th>
                      <th className="text-right">Transfer</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {d.rows.map((r) => (
                      <tr key={r.wallet} className="[&>td]:px-4 [&>td]:py-2.5 sm:[&>td]:px-5">
                        <td><AddrLink addr={r.wallet} fake={fake} /></td>
                        <td className="num text-right">{r.tokens.display}</td>
                        <td className="num text-right text-muted-foreground">{r.pctOfSupply}</td>
                        <td className="num text-right font-medium">{usd(r.payout.baseUnits)}</td>
                        <td className="text-right">{r.txSignature ? <TxLink sig={r.txSignature} /> : <span className="text-xs text-muted-foreground">{executed ? "—" : "pending"}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                  {d.totals && (
                    <tfoot className="border-t bg-surface">
                      <tr className="[&>td]:px-4 [&>td]:py-2.5 sm:[&>td]:px-5">
                        <td className="text-xs font-medium">Total to holders</td>
                        <td />
                        <td />
                        <td className="num text-right font-semibold">{usd(d.totals.totalAllocated.baseUnits)}</td>
                        <td className="text-right text-xs text-muted-foreground">{d.totals.paid}/{d.rows.length} paid</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </section>

          {/* unallocated */}
          {d.unallocated && (
            <section className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-[15px] font-semibold">{d.unallocated.label}</h2>
                <span className="num text-sm font-medium">{usd(d.unallocated.total.baseUnits)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Each unit earns the same share of the pool. Units not held by a registered participant at the snapshot aren&apos;t paid, and
                their share stays with the issuer. It isn&apos;t redistributed.
              </p>
              <ul className="divide-y rounded-lg border text-sm">
                <Line label="Units in the market (Meteora DBC pool)" value={usd(d.unallocated.breakdown.marketPool.baseUnits)} />
                <Line label="Unregistered wallets" value={usd(d.unallocated.breakdown.unregistered.baseUnits)} />
                <Line label="Units not found in any wallet" value={usd(d.unallocated.breakdown.unsold.baseUnits)} />
                <Line label="Rounding (each payout rounds down)" value={usd(d.unallocated.breakdown.roundingDust.baseUnits)} />
              </ul>
              {d.excluded.length > 0 && (
                <div className="space-y-1.5">
                  <p className="eyebrow">Excluded holders</p>
                  <ul className="space-y-1 text-sm">
                    {d.excluded.map((e) => (
                      <li key={e.wallet} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <AddrLink addr={e.wallet} fake={fake} />
                          <span className={e.kind === "UNREGISTERED" ? "text-xs text-warning" : "text-xs text-muted-foreground"}>{e.label}</span>
                        </span>
                        <span className="num text-muted-foreground">
                          {e.tokens.display} units · {usd(e.retainedShare.baseUnits)} retained
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {d.warnings.map((w) => (
                <p key={w} className="text-xs text-warning">{w}</p>
              ))}
            </section>
          )}

          {/* signatures */}
          <section className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
            <h2 className="text-[15px] font-semibold">Payout transactions</h2>
            {d.signatures.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {executed ? "No transfers were needed." : "None yet. The issuer executes the payout from their agent (fundraise-distribute)."}
              </p>
            ) : (
              <ul className="divide-y rounded-lg border text-sm">
                {d.signatures.map((s) => (
                  <li key={s.signature} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                    <TxLink sig={s.signature} chars={8} />
                    <span className="num text-xs text-muted-foreground">
                      {usd(s.amount.baseUnits)} USDC to {s.wallets.length} wallet{s.wallets.length === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">USDC transfers from the issuer&apos;s wallet, up to 10 holders per transaction.</p>
          </section>
        </div>

        {/* ---------------------------------------------------------- side */}
        <aside className="space-y-6 lg:sticky lg:top-20">
          <section className="space-y-3 rounded-xl border bg-card p-4">
            <h2 className="text-[15px] font-semibold">Report</h2>
            <dl className="space-y-3 text-sm">
              <Field label="Report hash (sha256)">
                <span className="break-all font-mono text-[11px] leading-relaxed">{dist.reportHash}</span>
              </Field>
              <Field label="Supporting document">
                {dist.reportUrl ? (
                  <a href={dist.reportUrl} target="_blank" rel="noreferrer" className="break-all underline decoration-border underline-offset-4 hover:decoration-foreground">
                    {dist.reportUrl.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  <span className="text-muted-foreground">None provided</span>
                )}
              </Field>
            </dl>
            <p className="text-xs text-muted-foreground">{COPY.positioning.reported} Founder Stack doesn&apos;t audit it; the hash lets anyone check the report hasn&apos;t changed.</p>
          </section>

          <section className="space-y-2 rounded-xl border bg-card p-4">
            <h2 className="text-[15px] font-semibold">All periods</h2>
            <ul className="space-y-0.5 text-sm">
              {[...periods].reverse().map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/distributions/${p.id}`}
                    aria-current={p.id === dist.id ? "page" : undefined}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-medium"
                  >
                    <span>{p.periodLabel}</span>
                    <span className="num text-xs text-muted-foreground">
                      {p.status === "EXECUTED" ? `${usd(p.perTokenBaseUnits)} / unit` : p.status.toLowerCase()}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "EXECUTED") return <StatusTag tone="positive" dot>Paid</StatusTag>;
  if (status === "SNAPSHOTTED") return <StatusTag tone="warning" dot>Snapshot taken</StatusTag>;
  return <StatusTag dot>Reported</StatusTag>;
}

function Stat({ label, value, note, positive }: { label: string; value: string; note: string; positive?: boolean }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="label-mono truncate">{label}</dt>
      <dd className={`num mt-1 text-xl font-semibold tracking-[-0.02em] ${positive ? "text-positive" : "text-strong"}`}>{value}</dd>
      <dd className="truncate text-xs text-muted-foreground">{note}</dd>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="num">{value}</span>
    </li>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="label-mono">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}
