// A26: /issuance/new form helpers against the real preview/create handlers, and the price chart geometry.
import { describe, expect, it } from "vitest";
import { POST as previewPOST } from "@/app/api/issuances/preview/route";
import { POST as createPOST } from "@/app/api/issuances/route";
import { issuerRequest, percentToBps, previewBody } from "@/lib/view/issuance-form";
import { priceChartGeometry } from "@/lib/view/price-chart";
import { call } from "./helpers";

const form = {
  issuerName: "Formco Inc.",
  symbol: "form-cf",
  expectedAnnualDcf: "$1,600,000",
  poolPercent: "10",
  targetYieldPercent: "16%",
  tokenSupply: "1,000,000",
  distributionFrequency: "QUARTERLY",
  graduationMultiple: "3",
};

const asRequest = (r: { url: string; init: RequestInit }) => new Request(`http://test${r.url}`, r.init);

describe("/issuance/new form", () => {
  it("converts percent to bps", () => {
    expect(percentToBps("10")).toBe(1000);
    expect(percentToBps("12.5")).toBe(1250);
    expect(percentToBps("16%")).toBe(1600);
    expect(percentToBps("abc")).toBe("abc");
  });

  it("previews, then creates only with the previewId", async () => {
    const p = await call(previewPOST, asRequest(issuerRequest("/api/issuances/preview", "test-token", previewBody(form))));
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body.terms.symbol).toBe("FORM-CF");
    expect(p.body.terms.poolPercentageBps).toBe(1000);
    expect(p.body.pricing.derivation).toHaveLength(4);
    expect(p.body.agreement.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.body.fees.description.lines.length).toBeGreaterThan(0);

    const bad = await call(previewPOST, asRequest(issuerRequest("/api/issuances/preview", "wrong", previewBody(form))));
    expect(bad.status).toBe(401);

    const c = await call(createPOST, asRequest(issuerRequest("/api/issuances", "test-token", { previewId: p.body.previewId })));
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.agreementHash).toBe(p.body.agreement.hash);
    const again = await call(createPOST, asRequest(issuerRequest("/api/issuances", "test-token", { previewId: p.body.previewId })));
    expect(again.status).toBe(409);
  });
});

describe("price chart geometry", () => {
  it("places now at curve progress and reports change since launch", () => {
    const g = priceChartGeometry({ startPrice: 1_000_000n, currentPrice: 1_500_000n, graduationPrice: 3_000_000n, progressBps: 2500 });
    expect(g.now.x).toBe(150);
    expect(g.changeBps).toBe(5000);
    expect(g.traded.startsWith("M0,")).toBe(true);
    expect(g.remaining.endsWith(`,${g.ticks[2].y}`)).toBe(true);
    // higher price is higher on screen (smaller y)
    expect(g.ticks[2].y).toBeLessThan(g.ticks[0].y);
    expect(g.now.y).toBeLessThan(g.ticks[0].y);
  });

  it("handles a fresh pool (no trades)", () => {
    const g = priceChartGeometry({ startPrice: 250_000n, currentPrice: 250_000n, graduationPrice: 750_000n, progressBps: 0 });
    expect(g.now.x).toBe(0);
    expect(g.changeBps).toBe(0);
    expect(g.traded).not.toContain("NaN");
  });
});
