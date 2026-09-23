// Cash Flow Rights terms, validation and launch pricing (SPEC sections 2 and 5).
// All money amounts are bigint USDC base units (6 dp). Pure, no I/O.

export type DistributionFrequency = "QUARTERLY" | "MONTHLY";

export const AGREEMENT_VERSION = "cf-1.0" as const;
export const DEMO_ISSUER_JURISDICTION = "Delaware, USA";

export const DEFAULT_DCF_DEFINITION =
  "Cash receipts from the Issuer's operations during the period, less cash operating expenses, " +
  "taxes paid, debt service and capital expenditures, and less reasonable reserves determined " +
  "in good faith by the Issuer, as reported by the Issuer for that period.";

export const DEFAULT_RECORD_DATE_RULE =
  "snapshot taken at the time the issuer executes the distribution after period close";

export interface CashFlowTerms {
  issuerName: string;
  /** Free text, e.g. "Delaware, USA". */
  issuerJurisdiction: string;
  symbol: string;
  tokenName: string;
  /** Whole tokens (not base units). */
  tokenSupply: bigint;
  tokenDecimals: number;
  /** Share of each period's DCF that forms the Rights Pool, in basis points (1000 = 10%). */
  poolPercentageBps: number;
  distributionFrequency: DistributionFrequency;
  distributableCashFlowDefinition: string;
  recordDateRule: string;
  agreementVersion: typeof AGREEMENT_VERSION;
  /** Informational only. USDC base units (6 dp). */
  expectedAnnualDcf: bigint;
  /** Informational only, used to derive the starting price. Basis points (1600 = 16%). */
  targetInitialYieldBps: number;
}

type RequiredTermFields = Pick<
  CashFlowTerms,
  "issuerName" | "symbol" | "tokenName" | "poolPercentageBps" | "expectedAnnualDcf" | "targetInitialYieldBps"
>;

/** Build terms with sensible demo defaults for everything not supplied. */
export function makeCashFlowTerms(
  input: RequiredTermFields & Partial<CashFlowTerms>,
): CashFlowTerms {
  return {
    issuerJurisdiction: DEMO_ISSUER_JURISDICTION,
    tokenSupply: 1_000_000n,
    tokenDecimals: 6,
    distributionFrequency: "QUARTERLY",
    distributableCashFlowDefinition: DEFAULT_DCF_DEFINITION,
    recordDateRule: DEFAULT_RECORD_DATE_RULE,
    agreementVersion: AGREEMENT_VERSION,
    ...input,
  };
}

/** Demo issuance from SPEC section 10: 10% of quarterly DCF, 1,000,000 ACME-CF, $1.6M/yr, 16%. */
export const ACME_DEMO_TERMS: CashFlowTerms = makeCashFlowTerms({
  issuerName: "Acme SaaS, Inc.",
  symbol: "ACME-CF",
  tokenName: "Acme SaaS Cash Flow Participation Unit",
  poolPercentageBps: 1000,
  expectedAnnualDcf: 1_600_000_000_000n,
  targetInitialYieldBps: 1600,
});

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9-]{1,11}$/;

export function validateCashFlowTerms(terms: CashFlowTerms): string[] {
  const errors: string[] = [];
  const nonEmpty = (v: unknown, field: string) => {
    if (typeof v !== "string" || v.trim() === "") errors.push(`${field} is required`);
  };
  nonEmpty(terms.issuerName, "issuerName");
  nonEmpty(terms.issuerJurisdiction, "issuerJurisdiction");
  nonEmpty(terms.tokenName, "tokenName");
  nonEmpty(terms.distributableCashFlowDefinition, "distributableCashFlowDefinition");
  nonEmpty(terms.recordDateRule, "recordDateRule");

  if (typeof terms.symbol !== "string" || !SYMBOL_RE.test(terms.symbol)) {
    errors.push("symbol must be 2-12 chars of A-Z, 0-9 or '-' (starting with a letter or digit)");
  }
  if (typeof terms.tokenName === "string" && terms.tokenName.length > 64) {
    errors.push("tokenName must be at most 64 characters");
  }
  if (typeof terms.tokenSupply !== "bigint" || terms.tokenSupply <= 0n) {
    errors.push("tokenSupply must be a positive bigint (whole tokens)");
  }
  if (!Number.isInteger(terms.tokenDecimals) || terms.tokenDecimals < 0 || terms.tokenDecimals > 9) {
    errors.push("tokenDecimals must be an integer between 0 and 9");
  }
  if (
    !Number.isInteger(terms.poolPercentageBps) ||
    terms.poolPercentageBps <= 0 ||
    terms.poolPercentageBps > 10_000
  ) {
    errors.push("poolPercentageBps must be an integer in (0, 10000]");
  }
  if (terms.distributionFrequency !== "QUARTERLY" && terms.distributionFrequency !== "MONTHLY") {
    errors.push("distributionFrequency must be QUARTERLY or MONTHLY");
  }
  if (terms.agreementVersion !== AGREEMENT_VERSION) {
    errors.push(`agreementVersion must be ${AGREEMENT_VERSION}`);
  }
  if (typeof terms.expectedAnnualDcf !== "bigint" || terms.expectedAnnualDcf <= 0n) {
    errors.push("expectedAnnualDcf must be a positive bigint (USDC base units)");
  }
  if (
    !Number.isInteger(terms.targetInitialYieldBps) ||
    terms.targetInitialYieldBps <= 0 ||
    terms.targetInitialYieldBps > 10_000
  ) {
    errors.push("targetInitialYieldBps must be an integer in (0, 10000]");
  }
  return errors;
}

export interface LaunchPricing {
  /** expectedAnnualDcf × pool%. USDC base units. */
  expectedAnnualRightsPool: bigint;
  /** Token market cap (supply × price) at curve start. NOT company valuation (R6). USDC base units. */
  startingMarketCap: bigint;
  /** Token market cap at which the DBC graduates. NOT company valuation (R6). USDC base units. */
  graduationMarketCap: bigint;
  /** USDC base units per whole token. */
  startingPricePerToken: bigint;
  /** UI label to use next to the market cap figures. */
  marketCapLabel: string;
}

const BPS = 10_000n;

/**
 * SPEC section 5 derivation. Floors at each step (USDC base units).
 * `graduationMultiple` may be fractional (e.g. 2.5); it is applied at 1e-4 precision.
 * Market cap here = token supply × token price. It is not a company valuation.
 */
export function deriveLaunchPricing(terms: CashFlowTerms, graduationMultiple: number): LaunchPricing {
  if (!Number.isFinite(graduationMultiple) || graduationMultiple <= 1) {
    throw new Error("graduationMultiple must be a finite number > 1");
  }
  if (terms.targetInitialYieldBps <= 0) throw new Error("targetInitialYieldBps must be > 0");
  if (terms.tokenSupply <= 0n) throw new Error("tokenSupply must be > 0");

  const expectedAnnualRightsPool = (terms.expectedAnnualDcf * BigInt(terms.poolPercentageBps)) / BPS;
  const startingMarketCap = (expectedAnnualRightsPool * BPS) / BigInt(terms.targetInitialYieldBps);
  const multipleBps = BigInt(Math.round(graduationMultiple * 10_000));
  const graduationMarketCap = (startingMarketCap * multipleBps) / BPS;
  const startingPricePerToken = startingMarketCap / terms.tokenSupply;

  return {
    expectedAnnualRightsPool,
    startingMarketCap,
    graduationMarketCap,
    startingPricePerToken,
    marketCapLabel: "Token market cap — not company valuation",
  };
}
