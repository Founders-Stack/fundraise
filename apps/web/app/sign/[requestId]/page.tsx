import { notFound } from "next/navigation";
import { HttpError } from "@/lib/server/http";
import { getSignRequest } from "@/lib/server/sign-flows";
import { StatusTag } from "@/components/fs";
import { fmtDate } from "@/components/format";
import { SignFlow } from "@/components/sign/sign-flow";

export const dynamic = "force-dynamic";

// Wallet-signing link (SPEC 0.4 P1): the founder's agent returns this URL instead of signing with
// server keys. The founder opens it in their own browser, reads the summary, and signs.
export default async function SignPage({ params }: PageProps<"/sign/[requestId]">) {
  const { requestId } = await params;
  let req;
  try {
    req = await getSignRequest(requestId);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  const { summary } = req;
  const tone = req.status === "COMPLETED" ? "positive" : req.status === "PENDING" ? "brand" : "warning";

  return (
    <div className="fs-backdrop -mx-4 -mt-8 px-4 pt-12 pb-4 sm:-mx-6 sm:-mt-10 sm:px-6 sm:pt-16">
      <div className="mx-auto max-w-xl space-y-6">
        <div className="space-y-3 text-center">
          <p className="eyebrow">Sign with your wallet</p>
          <h1 className="text-[clamp(1.75rem,5vw,2.5rem)] leading-[1] font-semibold tracking-[-0.04em] text-balance">{summary.title}</h1>
          <p className="mx-auto max-w-md text-sm text-muted-foreground text-pretty">{summary.action}</p>
        </div>

        <div className="space-y-5 rounded-[4px] border bg-card p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <StatusTag tone={tone} dot>
              {req.status === "PENDING" ? "Awaiting signature" : req.status.toLowerCase()}
            </StatusTag>
            <span className="font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
              {req.chainMode === "fake" ? "Local fake chain" : "Solana devnet"} · expires {fmtDate(req.expiresAt, true)}
            </span>
          </div>

          <dl className="divide-y border-y text-sm">
            {summary.lines.map((l) => (
              <div key={l.label} className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-muted-foreground">{l.label}</dt>
                <dd className="text-right font-medium break-all">{l.value}</dd>
              </div>
            ))}
          </dl>

          {summary.warning && req.status === "PENDING" && <p className="text-xs text-muted-foreground">{summary.warning}</p>}

          <SignFlow
            id={req.id}
            status={req.status}
            chainMode={req.chainMode}
            signer={req.signer}
            signatures={req.signatures}
            lastError={req.error}
            doneUrl={summary.doneUrl}
          />
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Your wallet shows the exact transaction before you approve it. Founder Stack never holds your keys for this action.
        </p>
      </div>
    </div>
  );
}
