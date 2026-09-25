import { afterEach, describe, expect, it, vi } from "vitest";
import { appUrl, handle, HttpError } from "@/lib/server/http";
import { signUrl } from "@/lib/server/signing";
import { POST as swapPOST } from "@/app/api/issuances/[id]/swap/route";
import { POST as reportPOST } from "@/app/api/issuances/[id]/distributions/route";
import { GET as quoteGET } from "@/app/api/issuances/[id]/quote/route";
import { call, ctx, launch, post, signer } from "./helpers";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("deployment links", () => {
  it.each([
    ["http://localhost:3000", "", "http://localhost:3000"],
    ["https://f-stack.ai", "/fundraise", "https://f-stack.ai/fundraise"],
    ["https://f-stack.ai/fundraise/", "/fundraise", "https://f-stack.ai/fundraise"],
  ])("builds links from %s with prefix %s", async (origin, prefix, expected) => {
    vi.stubEnv("PUBLIC_APP_URL", origin);
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", prefix);
    expect(appUrl()).toBe(expected);
    expect(signUrl("request")).toBe(`${expected}/sign/request`);
    const issuance = await launch();
    expect(issuance.onboardUrl).toBe(`${expected}/onboard/${issuance.issuanceId}?invite=${issuance.inviteCode}`);
  });
});

describe("API error boundary", () => {
  it("does not expose unexpected server errors to callers", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("database credentials: secret; /private/server/path");
    const response = await handle(async () => { throw error; });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error", message: "An unexpected server error occurred" });
    expect(log).toHaveBeenCalledWith(error);
  });
  it("preserves actionable expected errors", async () => {
    const response = await handle(async () => { throw new HttpError(409, "conflict", "Already reported", { id: "d" }); });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict", message: "Already reported", details: { id: "d" } });
  });
});

describe("swap input validation", () => {
  it("rejects ambiguous amount inputs for both quote and swap", async () => {
    const request = new Request("http://test/api?side=BUY&amountIn=1&amountOut=2");
    expect((await quoteGET(request, ctx("unused"))).status).toBe(400);
    for (const body of [{ amountIn: "1", amountOut: "2" }, { amountIn: "1", mode: 42 }]) {
      const response = await call(swapPOST, post({ side: "BUY", ...body }, {}), "unused");
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("invalid_input");
    }
  });
  it("rejects bad owners and slippage before building a transaction", async () => {
    const { wallet } = signer("id", "hash");
    for (const values of [{ owner: "not-a-wallet" }, { owner: wallet, slippageBps: "10001" }, { owner: wallet, slippageBps: "-1" }]) {
      const response = await call(swapPOST, post({ side: "BUY", amountOut: "1", ...values }, {}), "unused");
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("invalid_input");
    }
  });
  it("keeps exact-output swaps working at zero and maximum slippage", async () => {
    const issuance = await launch();
    const { wallet } = signer(issuance.issuanceId, issuance.agreementHash);
    for (const bps of ["0", "10000"]) {
      const result = await call(swapPOST, post({ owner: wallet, side: "BUY", amountOut: "1000000", slippageBps: bps }, {}), issuance.issuanceId);
      expect(result.status).toBe(200);
      const quoted = BigInt(result.body.quote.raw.amountIn);
      expect(BigInt(result.body.maxAmountIn)).toBe(bps === "0" ? quoted : 2n * quoted);
    }
  });
});

describe("supporting report links", () => {
  it.each(["https://[bad", "https://user:secret@example.com/report", "javascript:alert(1)", "https://exa mple.com", "https://?"])("rejects invalid or credential-bearing URL %s", async (reportUrl) => {
    const result = await call(reportPOST, post({ periodLabel: "2026-Q3", dcf: "100", reportUrl }), "unused");
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_report_url");
  });
  it("preserves valid report URL, including signed query parameters", async () => {
    const issuance = await launch();
    const reportUrl = "https://example.com/report.pdf?signature=abc%2F123#page=2";
    const result = await call(reportPOST, post({ periodLabel: "2026-Q3", dcf: "100", reportUrl }), issuance.issuanceId);
    expect(result.status).toBe(201);
    expect(result.body.distribution.reportUrl).toBe(reportUrl);
  });
});
