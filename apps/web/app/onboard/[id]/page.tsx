import Link from "next/link";
import { notFound } from "next/navigation";
import { COPY } from "@fstack/core";
import { HttpError } from "@/lib/server/http";
import { loadIssuance } from "@/lib/server/issuance-record";
import { publicIssuanceView } from "@/lib/server/issuance";
import { agreementSummary } from "@/lib/server/agreement-summary";
import { OnboardingGate } from "@/components/investor/onboarding-gate";

export const dynamic = "force-dynamic";

// Investor onboarding (SPEC section 6): the shareable ?invite= link from fundraise-launch.
export default async function OnboardPage({ params, searchParams }: PageProps<"/onboard/[id]">) {
  const { id } = await params;
  const { invite } = await searchParams;
  let issuance;
  try {
    issuance = await loadIssuance(id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  const info = publicIssuanceView(issuance);
  const { terms } = issuance;
  const freq = terms.distributionFrequency === "MONTHLY" ? "monthly" : "quarterly";

  return (
    <div className="fs-backdrop -mx-4 -mt-8 px-4 pt-12 pb-4 sm:-mx-6 sm:-mt-10 sm:px-6 sm:pt-16">
      <div className="mx-auto max-w-xl space-y-6">
        <div className="space-y-3 text-center">
          <p className="eyebrow">Investor onboarding · {terms.symbol}</p>
          <h1 className="text-[clamp(2rem,5vw,2.75rem)] leading-[0.95] font-semibold tracking-[-0.05em] text-balance">
            Hold {terms.issuerName}{" "}
            <em className="serif-accent text-[1.08em] tracking-[-0.03em]">cash&#8209;flow</em> units
          </h1>
          <p className="mx-auto max-w-md text-sm text-muted-foreground text-pretty">
            {terms.issuerName} pays {info.terms.poolPercentage} of its {freq} Distributable Cash Flow to registered holders of{" "}
            {terms.symbol}, in USDC. Accept the agreement with one wallet signature and your wallet can buy on the{" "}
            <Link href={`/market/${id}`} className="font-medium text-foreground underline underline-offset-4">
              {terms.symbol} market
            </Link>
            .
          </p>
        </div>

        {!issuance.market ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            {terms.symbol} is still being created on-chain. Refresh in a few seconds.
          </div>
        ) : (
          <OnboardingGate
            variant="page"
            issuanceId={id}
            symbol={terms.symbol}
            agreement={{ hash: issuance.agreement.hash, version: issuance.agreement.version, text: issuance.agreement.text, summary: agreementSummary(issuance) }}
            steps={[COPY.onboardingSteps.connectWallet, COPY.onboardingSteps.acceptAgreement, COPY.onboardingSteps.tradingEnabled]}
            selfAttested={COPY.selfAttested}
            inviteFromUrl={typeof invite === "string" ? invite : null}
          />
        )}

        <p className="text-center text-xs text-muted-foreground">
          {COPY.positioning.eligibility} Onboarding is self-attested for this pilot: there is no identity check, and the invite link
          keeps it closed. {COPY.positioning.reported}
        </p>
      </div>
    </div>
  );
}
