// UI / skill microcopy (SPEC section 13) and a tiny forbidden-term linter.

export const COPY = {
  positioning: {
    claim:
      "Contractual cash-flow participation rights. The agreement creates the claim, and the token represents participation units.",
    reported: "Distributions are based on issuer-reported Distributable Cash Flow.",
    eligibility: "Eligibility is enforced at the token level by a Token-2022 transfer hook.",
    meteora: "Meteora DBC provides distribution, price discovery and liquidity.",
    economics:
      "Protocol economics shown are illustrative. The production model is software fees (one config switch).",
  },
  illustrativeEconomics: "Illustrative protocol economics",
  trailingYield: "Trailing distribution yield (informational, based on issuer-reported cash flow)",
  annualizedFromPeriods: (n: number) => `annualized from ${n} period${n === 1 ? "" : "s"}`,
  unallocated: "Unallocated (retained by issuer)",
  marketCap: "Token market cap — not company valuation",
  demoCustody: "Demo custody (devnet)",
  demoBanner: "DEMO — devnet prototype, not an offer of securities",
  nextRecordDate: "Next record date",
  onboardingSteps: {
    verifyIdentity: "Verify identity",
    confirmEligibility: "Confirm eligibility",
    acceptAgreement: "Accept agreement",
    tradingEnabled: "Trading enabled",
  },
} as const;

export const ONBOARDING_STEP_LABELS = [
  COPY.onboardingSteps.verifyIdentity,
  COPY.onboardingSteps.confirmEligibility,
  COPY.onboardingSteps.acceptAgreement,
  COPY.onboardingSteps.tradingEnabled,
] as const;

export const FORBIDDEN_TERMS = [
  "dividend",
  "shares",
  "equity ownership",
  "company valuation",
  "guaranteed",
] as const;

export interface CopyLintHit {
  term: (typeof FORBIDDEN_TERMS)[number];
  /** Character offset of the hit in the input text. */
  index: number;
  /** The sentence containing the hit (trimmed). */
  sentence: string;
}

const NEGATION_RE = /\b(not|no)\s|does not represent/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns forbidden-term hits (case-insensitive, word-boundary, plural "dividends" included).
 * A hit is allowed when, earlier in the same sentence, the text contains "not ", "no " or
 * "does not represent" (e.g. "does not represent shares", "no guaranteed returns").
 * Sentences are split on . ! ? and newlines. Deliberately simple.
 */
export function lintCopy(text: string): CopyLintHit[] {
  const hits: CopyLintHit[] = [];
  for (const term of FORBIDDEN_TERMS) {
    const re = new RegExp(`\\b${escapeRe(term)}s?\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const idx = m.index;
      let start = idx;
      while (start > 0 && !/[.!?\n]/.test(text[start - 1]!)) start--;
      let end = idx;
      while (end < text.length && !/[.!?\n]/.test(text[end]!)) end++;
      const before = text.slice(start, idx);
      if (NEGATION_RE.test(before)) continue;
      hits.push({ term, index: idx, sentence: text.slice(start, end).trim() });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}
