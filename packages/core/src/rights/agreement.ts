// Cash Flow Participation Agreement template + deterministic hashes (SPEC R2, section 0.2).

import { createHash } from "node:crypto";
import type { CashFlowTerms } from "./terms";

function groupThousands(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toString()}%`;
}

const FREQ_TEXT: Record<CashFlowTerms["distributionFrequency"], { adj: string; period: string }> = {
  QUARTERLY: { adj: "quarterly", period: "calendar quarter" },
  MONTHLY: { adj: "monthly", period: "calendar month" },
};

/** Renders the Cash Flow Participation Agreement as markdown. Deterministic for given terms. */
export function renderAgreement(terms: CashFlowTerms): string {
  const supply = groupThousands(terms.tokenSupply);
  const pool = formatBps(terms.poolPercentageBps);
  const freq = FREQ_TEXT[terms.distributionFrequency];
  const issuer = terms.issuerName;

  return `> **DEMO — devnet prototype, not an offer of securities.** This document is a hackathon prototype template. It has no legal effect and nothing on devnet has monetary value.

# Cash Flow Participation Agreement

**Agreement version:** ${terms.agreementVersion}
**Issuer:** ${issuer} (${terms.issuerJurisdiction})
**Participation Units:** ${terms.tokenName} (${terms.symbol}), total supply ${supply}, ${terms.tokenDecimals} decimals
**Rights Pool:** ${pool} of Distributable Cash Flow, ${freq.adj}

## 1. Parties

This agreement is between **${issuer}** (the "Issuer") and each person or entity that has completed verification through the Founder Stack registry, accepted this agreement, and holds Participation Units in a registered wallet (each, a "Participant").

## 2. Definitions

- **Participation Units** means the ${supply} ${terms.symbol} tokens. Each unit represents a 1/${supply} participation in each Rights Pool. The token represents participation units; this agreement creates the claim.
- **Distributable Cash Flow (DCF)** means, for each period: ${terms.distributableCashFlowDefinition} DCF is issuer-reported and is not audited by Founder Stack.
- **Rights Pool** means ${pool} of the DCF for a period.
- **Period** means each ${freq.period}.
- **Record Date** means the ${terms.recordDateRule}.
- **Eligible Holder** means a Participant whose wallet is on the Founder Stack allowlist at the Record Date.

## 3. Economic right

For each Period, the Participant is entitled to a distribution equal to the Rights Pool multiplied by the Participant's Participation Units held at the Record Date, divided by ${supply}, rounded down to the nearest USDC base unit. Units not held by Eligible Holders at the Record Date (including units held by liquidity pools, vaults or unregistered wallets) are not distributed; their portion of the Rights Pool, and any rounding remainder, remains with the Issuer.

## 4. Reporting

After each Period closes, the Issuer reports the DCF for that Period, optionally with a supporting document, and publishes a sha256 hash of the report. Participants can use the hash to confirm that the report has not changed.

## 5. Distributions

Distributions are paid in USDC to the Eligible Holder's registered wallet after the Issuer executes the distribution for the Period. If DCF for a Period is zero or negative, no distribution is due for that Period and no shortfall carries forward.

## 6. Eligibility and transfers

Participation Units may be transferred only to wallets that have completed verification and accepted this agreement. This is enforced at the token level by a Token-2022 transfer hook that checks the Founder Stack registry. The Issuer or Founder Stack may remove a wallet from the registry if its eligibility lapses.

## 7. Nature of the right

Participation Units are a contractual right to cash-flow participation only. They do not represent shares or equity in the Issuer and carry no voting, governance, information or liquidation rights beyond this agreement. Token market cap is not a measure of the Issuer's value.

## 8. No guaranteed returns

There are no guaranteed returns. Distributions depend entirely on issuer-reported DCF, which may be zero. Any yield shown is informational and based on past issuer-reported cash flow.

## 9. Risk factors

- The Issuer may underperform, report zero DCF, or cease operations.
- DCF is reported by the Issuer and is not independently verified.
- Token prices may be volatile and liquidity may be limited or unavailable.
- Smart contract, transfer hook and network failures may delay or prevent transfers or distributions.
- Regulatory treatment of this instrument is uncertain and may change.

## 10. Termination and amendments

This agreement ends when the Issuer winds up, or earlier by an amendment approved as described here. Amendments take effect only as a new agreement version that Participants accept; the version and hash of the accepted agreement are recorded in the registry.

## 11. Governing law

This agreement is governed by the laws of [GOVERNING LAW — to be completed; placeholder for ${terms.issuerJurisdiction}].
`;
}

/** Normalize line endings to \n, trim trailing whitespace per line, drop trailing blank lines. */
export function canonicalizeAgreement(markdown: string): string {
  return markdown
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Hex sha256 of the canonicalized agreement text. */
export function agreementHash(markdown: string): string {
  return sha256Hex(canonicalizeAgreement(markdown));
}

export interface CashFlowReport {
  issuanceId: string;
  periodLabel: string;
  /** USDC base units. */
  dcf: bigint;
  reportUrl?: string;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function toCanonical(value: unknown): Json | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value.toString(10);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in canonical JSON");
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => toCanonical(v) ?? null);
  if (typeof value === "object") {
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = toCanonical((value as Record<string, unknown>)[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  throw new Error(`unsupported value in canonical JSON: ${typeof value}`);
}

/** Canonical JSON: keys sorted recursively, bigint as decimal string, undefined omitted. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonical(value) ?? null);
}

/** Hex sha256 of the report's canonical JSON (SPEC R2 `reportHash`). */
export function reportHash(report: CashFlowReport): string {
  return sha256Hex(canonicalJson(report));
}
