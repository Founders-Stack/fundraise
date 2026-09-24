// Pure helpers for the /issuance/new form (unit-tested). The form speaks percent; the API speaks bps.

export interface IssuanceFormValues {
  issuerName: string;
  symbol: string;
  /** USDC decimal string. */
  expectedAnnualDcf: string;
  poolPercent: string;
  targetYieldPercent: string;
  tokenSupply: string;
  distributionFrequency: "QUARTERLY" | "MONTHLY" | string;
  graduationMultiple: string;
}

/** "10" → 1000, "12.5" → 1250. Returns the raw string when it isn't a clean percent (the API reports the error). */
export function percentToBps(v: string): number | string {
  const s = v.trim().replace(/%$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return v;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** Body for POST /api/issuances/preview. */
export function previewBody(v: IssuanceFormValues) {
  return {
    issuerName: v.issuerName.trim(),
    symbol: v.symbol.trim().toUpperCase(),
    expectedAnnualDcf: v.expectedAnnualDcf.replace(/[,$\s]/g, ""),
    poolPercentageBps: percentToBps(v.poolPercent),
    targetInitialYieldBps: percentToBps(v.targetYieldPercent),
    tokenSupply: v.tokenSupply.replace(/[,_\s]/g, ""),
    distributionFrequency: v.distributionFrequency,
    graduationMultiple: Number(v.graduationMultiple),
  };
}

/** An issuer-authenticated JSON POST. */
export function issuerRequest(url: string, token: string, body: unknown): { url: string; init: RequestInit } {
  return {
    url,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token.trim()}` },
      body: JSON.stringify(body),
    },
  };
}
