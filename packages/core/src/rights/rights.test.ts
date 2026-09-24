import { describe, expect, it } from "vitest";
import {
  ACME_DEMO_TERMS,
  COPY,
  FORBIDDEN_TERMS,
  agreementHash,
  canonicalizeAgreement,
  deriveLaunchPricing,
  lintCopy,
  makeCashFlowTerms,
  renderAgreement,
  reportHash,
  validateCashFlowTerms,
  type CashFlowTerms,
} from "./index";

const USDC = 1_000_000n;

describe("validateCashFlowTerms", () => {
  it("accepts the Acme demo terms", () => {
    expect(validateCashFlowTerms(ACME_DEMO_TERMS)).toEqual([]);
  });

  it("applies defaults", () => {
    expect(ACME_DEMO_TERMS.issuerJurisdiction).toBe("Delaware, USA");
    expect(ACME_DEMO_TERMS.agreementVersion).toBe("cf-1.0");
    expect(ACME_DEMO_TERMS.recordDateRule).toBe(
      "snapshot taken at the time the issuer executes the distribution after period close",
    );
    expect(ACME_DEMO_TERMS.distributionFrequency).toBe("QUARTERLY");
  });

  it("reports each invalid field", () => {
    const bad = {
      ...ACME_DEMO_TERMS,
      issuerName: " ",
      symbol: "acme cf!",
      tokenSupply: 0n,
      tokenDecimals: 12,
      poolPercentageBps: 0,
      distributionFrequency: "WEEKLY",
      agreementVersion: "cf-2.0",
      expectedAnnualDcf: -1n,
      targetInitialYieldBps: 1.5,
    } as unknown as CashFlowTerms;
    const errors = validateCashFlowTerms(bad);
    for (const field of [
      "issuerName",
      "symbol",
      "tokenSupply",
      "tokenDecimals",
      "poolPercentageBps",
      "distributionFrequency",
      "agreementVersion",
      "expectedAnnualDcf",
      "targetInitialYieldBps",
    ]) {
      expect(errors.some((e) => e.startsWith(field))).toBe(true);
    }
  });

  it("rejects pool > 100%", () => {
    expect(validateCashFlowTerms({ ...ACME_DEMO_TERMS, poolPercentageBps: 10_001 })).toHaveLength(1);
  });
});

describe("deriveLaunchPricing", () => {
  it("matches SPEC section 5: $1.6M DCF, 10%, 16% → $1.0M start, $1.00/token, 3x → $3.0M", () => {
    const p = deriveLaunchPricing(ACME_DEMO_TERMS, 3);
    expect(p.expectedAnnualRightsPool).toBe(160_000n * USDC);
    expect(p.startingMarketCap).toBe(1_000_000n * USDC);
    expect(p.startingPricePerToken).toBe(1_000_000n); // 1.000000 USDC
    expect(p.graduationMarketCap).toBe(3_000_000n * USDC);
    expect(p.marketCapLabel).toBe("Token market cap — not company valuation");
  });

  it("supports fractional multiples and floors", () => {
    const t = makeCashFlowTerms({ ...ACME_DEMO_TERMS, tokenSupply: 3n });
    const p = deriveLaunchPricing(t, 2.5);
    expect(p.graduationMarketCap).toBe(2_500_000n * USDC);
    expect(p.startingPricePerToken).toBe((1_000_000n * USDC) / 3n);
  });

  it("rejects multiple <= 1", () => {
    expect(() => deriveLaunchPricing(ACME_DEMO_TERMS, 1)).toThrow();
  });
});

describe("agreement", () => {
  const md = renderAgreement(ACME_DEMO_TERMS);

  it("has the DEMO header and key terms", () => {
    expect(md).toContain("DEMO — devnet prototype, not an offer of securities");
    expect(md.split("\n")[0]).toContain("DEMO");
    expect(md).toContain("Cash Flow Participation Agreement");
    expect(md).toContain("10% of Distributable Cash Flow");
    expect(md).toContain("1/1,000,000");
    expect(md).toContain("cf-1.0");
    expect(md).toContain("Delaware, USA");
    expect(md).toContain("remains with the Issuer");
    expect(md.toLowerCase()).toContain("distribution");
  });

  it("passes lintCopy and never says dividend", () => {
    expect(lintCopy(md)).toEqual([]);
    expect(md.toLowerCase()).not.toContain("dividend");
    expect(md.toLowerCase()).not.toContain("valuation");
  });

  it("hash is deterministic and line-ending / trailing-space insensitive", () => {
    const h = agreementHash(md);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(agreementHash(renderAgreement(ACME_DEMO_TERMS))).toBe(h);
    expect(agreementHash(md.replace(/\n/g, "\r\n"))).toBe(h);
    expect(agreementHash(md.replace(/\n/g, "   \n"))).toBe(h);
    expect(canonicalizeAgreement("a \r\nb\t\r\n")).toBe("a\nb");
  });

  it("hash changes when a term changes", () => {
    const h = agreementHash(md);
    expect(agreementHash(renderAgreement({ ...ACME_DEMO_TERMS, poolPercentageBps: 1100 }))).not.toBe(h);
    expect(agreementHash(renderAgreement({ ...ACME_DEMO_TERMS, distributionFrequency: "MONTHLY" }))).not.toBe(h);
  });
});

describe("reportHash", () => {
  it("is key-order independent and bigint-safe", () => {
    const a = reportHash({ issuanceId: "iss_1", periodLabel: "2026-Q3", dcf: 400_000n * USDC, reportUrl: "https://x/r.pdf" });
    const b = reportHash({ reportUrl: "https://x/r.pdf", dcf: 400_000n * USDC, periodLabel: "2026-Q3", issuanceId: "iss_1" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with content; undefined reportUrl equals omitted", () => {
    const base = { issuanceId: "iss_1", periodLabel: "2026-Q3", dcf: 1n };
    expect(reportHash(base)).not.toBe(reportHash({ ...base, dcf: 2n }));
    expect(reportHash(base)).toBe(reportHash({ ...base, reportUrl: undefined }));
  });
});

describe("COPY / lintCopy", () => {
  it("all COPY strings lint clean", () => {
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") strings.push(v);
      else if (typeof v === "function") strings.push((v as (n: number) => string)(3));
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(COPY);
    expect(strings.length).toBeGreaterThan(10);
    for (const s of strings) expect(lintCopy(s)).toEqual([]);
    // SPEC 6.1: no simulated identity step; verification is labeled self-attested.
    expect(Object.keys(COPY.onboardingSteps)).toEqual(["connectWallet", "acceptAgreement", "tradingEnabled"]);
    expect(COPY.selfAttested).toBe("Self-attested (pilot)");
  });

  it("flags forbidden terms, allows negated ones", () => {
    expect(FORBIDDEN_TERMS).toContain("dividend");
    expect(lintCopy("Quarterly Dividends paid to holders.").map((h) => h.term)).toEqual(["dividend"]);
    expect(lintCopy("Buy shares now. Guaranteed yield!").map((h) => h.term)).toEqual(["shares", "guaranteed"]);
    expect(lintCopy("Token market cap = company valuation")).toHaveLength(1);
    expect(lintCopy("This does not represent shares or equity ownership.")).toEqual([]);
    expect(lintCopy("There are no guaranteed returns.")).toEqual([]);
    // negation in a previous sentence does not carry over
    expect(lintCopy("Not advice. Guaranteed returns.")).toHaveLength(1);
  });
});
