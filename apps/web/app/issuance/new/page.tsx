import type { Metadata } from "next";
import { NewIssuanceForm } from "@/components/issuer/new-issuance-form";

export const metadata: Metadata = { title: "New issuance · Founder Stack" };

// Web fallback for the fundraise-launch skill (A26): same two calls, same confirmation gate.
// POST /api/issuances/preview (nothing on-chain) → founder reviews → explicit confirm → POST /api/issuances.
export default function NewIssuancePage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-3">
        <p className="eyebrow">Issuer · web fallback</p>
        <h1 className="text-[clamp(2rem,5vw,2.75rem)] leading-[0.95] font-semibold tracking-[-0.05em] text-balance">
          Launch a <em className="serif-accent text-[1.08em] tracking-[-0.03em]">cash&#8209;flow</em> market
        </h1>
        <p className="max-w-xl text-sm text-muted-foreground text-pretty">
          The same flow the agent runs: enter terms, review the preview (price derivation, what you share, fees, agreement hash), then
          confirm. Nothing is created on-chain until you confirm.
        </p>
      </div>
      <NewIssuanceForm />
    </div>
  );
}
