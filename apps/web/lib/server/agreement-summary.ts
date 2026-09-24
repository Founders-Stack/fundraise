// The 5-line agreement summary shown next to the onboarding checkbox (SPEC section 6). Every
// line restates a section of the agreement; the full text and its hash sit right below it.
import type { IssuanceRecord } from "./issuance-record";
import { pctDisplay, tokenDisplay } from "./money";

export function agreementSummary(issuance: IssuanceRecord): string[] {
  const { terms } = issuance;
  const supply = tokenDisplay(terms.tokenSupply, 0);
  const freq = terms.distributionFrequency === "MONTHLY" ? "monthly" : "quarterly";
  return [
    `${terms.issuerName} pays ${pctDisplay(terms.poolPercentageBps)} of its ${freq} Distributable Cash Flow to holders, split across ${supply} ${terms.symbol} units.`,
    `Each unit earns 1/${supply} of every period's pool, in USDC, sent to registered wallets when the issuer executes the distribution.`,
    "Cash flow is reported by the issuer and not audited by Founder Stack. Returns are not guaranteed and may be zero.",
    "Units are a contractual right to cash-flow participation only: no shares, no voting or governance rights.",
    "Units move only between registered wallets while the raise is live (Token-2022 transfer hook). The agreement runs until the issuer winds up.",
  ];
}
