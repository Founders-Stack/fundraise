import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { POST as previewPOST } from "@/app/api/issuances/preview/route";
import { GET as listGET } from "@/app/api/issuances/route";
import { GET as issuanceGET } from "@/app/api/issuances/[id]/route";
import { GET as marketGET } from "@/app/api/issuances/[id]/market/route";
import { GET as holdersGET } from "@/app/api/issuances/[id]/holders/route";
import { POST as participantsPOST } from "@/app/api/issuances/[id]/participants/route";
import { GET as quoteGET } from "@/app/api/issuances/[id]/quote/route";
import { POST as swapPOST } from "@/app/api/issuances/[id]/swap/route";
import { agreementAcceptanceMessage } from "@/lib/server/agreement-message";
import { ACME, AUTH, create, ctx, launch, post, preview } from "./helpers";

describe("preview", () => {
  it("derives pricing from cash flow (Acme: $1.6M DCF, 10%, 16% → $1 / token)", async () => {
    const p = await preview();
    expect(p.status).toBe(201);
    expect(p.body.previewId).toBeTypeOf("string");
    expect(p.body.pricing.expectedAnnualRightsPool.baseUnits).toBe("160000000000");
    expect(p.body.pricing.startingMarketCap.display).toBe("$1,000,000");
    expect(p.body.pricing.startingPricePerToken.baseUnits).toBe("1000000");
    expect(p.body.pricing.graduationMarketCap.display).toBe("$3,000,000");
    expect(p.body.projectedGraduation.split).toEqual({ issuerPct: 48, platformPct: 2, liquidityPct: 50 });
    expect(p.body.fees.tradingFeeSplit).toEqual({ startupPct: 50, founderStackPct: 50 });
    expect(p.body.agreement.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.body.custody).toBe("Demo custody (devnet)");
  });

  it("rejects invalid terms with a list of errors", async () => {
    const p = await preview({ ...ACME, poolPercentageBps: 0, expectedAnnualDcf: "abc" });
    expect(p.status).toBe(400);
    expect(p.body.error).toBe("invalid_terms");
    expect(p.body.details.errors.length).toBeGreaterThan(0);
  });

  it("requires the issuer bearer token", async () => {
    const res = await previewPOST(post(ACME, { "content-type": "application/json" }));
    expect(res.status).toBe(401);
  });
});

describe("create gate", () => {
  it("rejects a missing previewId", async () => {
    const c = await create(undefined);
    expect(c.status).toBe(400);
    expect(c.body.error).toBe("preview_required");
  });

  it("rejects an unknown previewId", async () => {
    const c = await create("does-not-exist");
    expect(c.status).toBe(400);
    expect(c.body.error).toBe("preview_not_found");
  });

  it("creates once, then rejects reuse of the same previewId with 409", async () => {
    const p = await preview();
    const c = await create(p.body.previewId);
    expect(c.status).toBe(201);
    expect(c.body.baseMint).toBeTruthy();
    expect(c.body.dbcPool).toBeTruthy();
    expect(c.body.signatures.length).toBeGreaterThan(0);
    expect(c.body.marketUrl).toBe(`http://localhost:3000/market/${c.body.issuanceId}`);
    expect(c.body.onboardUrl).toBe(`http://localhost:3000/onboard/${c.body.issuanceId}`);
    expect(new Date(c.body.nextRecordDate).getTime()).toBeGreaterThan(Date.now());

    const again = await create(p.body.previewId);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("preview_already_used");
    expect(again.body.details.issuanceId).toBe(c.body.issuanceId);
  });

  it("GET /api/issuances/:id is public and lists include the new issuance", async () => {
    const { issuanceId, agreementHash } = await launch();
    const res = await issuanceGET(new Request("http://test"), ctx(issuanceId));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("LIVE");
    expect(body.agreement.hash).toBe(agreementHash);
    expect(body.agreement.text).toContain("Acme SaaS");
    expect(body.dcfDefinition).toMatch(/^Cash receipts from the Issuer's operations/);
    expect(body.agreement.text).toContain(body.dcfDefinition);
    expect(body.terms.poolPercentageBps).toBe(1000);
    expect(body.nextRecordDate).toBeTruthy();

    const list = await (await listGET(new Request("http://test", { headers: AUTH }))).json();
    expect(list.issuances.some((i: { id: string }) => i.id === issuanceId)).toBe(true);
  });

  it("keeps the launch terms on the issuance (detail and list agree)", async () => {
    const { issuanceId } = await launch({ symbol: "WYO", issuerJurisdiction: "Wyoming, USA" });
    const body = await (await issuanceGET(new Request("http://test"), ctx(issuanceId))).json();
    expect(body.terms.issuerJurisdiction).toBe("Wyoming, USA");
    expect(body.terms.tokenDecimals).toBe(6);
    expect(body.agreement.text).toContain("Wyoming, USA");
    expect(body.fees.mode).toBe("DEMO_PROTOCOL");
    expect(body.chain.poolOwners.length).toBeGreaterThan(0);

    const list = await (await listGET(new Request("http://test", { headers: AUTH }))).json();
    const listed = list.issuances.find((i: { id: string }) => i.id === issuanceId);
    expect(listed.terms).toEqual(body.terms);
    expect(listed.dcfDefinition).toBe(body.dcfDefinition);
    expect(listed.agreement.text).toBeUndefined();
  });
});

describe("participants", () => {
  it("accepts a valid agreement signature and allowlists the wallet", async () => {
    const { issuanceId, agreementHash } = await launch();
    const kp = nacl.sign.keyPair();
    const wallet = bs58.encode(kp.publicKey);
    const msg = new TextEncoder().encode(agreementAcceptanceMessage(agreementHash, issuanceId));
    const signature = bs58.encode(nacl.sign.detached(msg, kp.secretKey));

    const res = await participantsPOST(
      post({ wallet, displayName: "Alice", verified: true, eligible: true, agreementHash, signature }, {}),
      ctx(issuanceId),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("Trading enabled");
    expect(body.participant.allowlistTx).toBeTruthy();

    // idempotent re-registration
    const again = await participantsPOST(
      post({ wallet, verified: true, eligible: true, agreementHash, signature }, {}),
      ctx(issuanceId),
    );
    expect(again.status).toBe(200);

    // display names only for the issuer
    const pub = await (await holdersGET(new Request("http://test"), ctx(issuanceId))).json();
    expect(pub.participants).toBeUndefined();
    const iss = await (await holdersGET(new Request("http://test", { headers: AUTH }), ctx(issuanceId))).json();
    expect(iss.participants[0].displayName).toBe("Alice");
    expect(iss.holders[0].kind).toBe("POOL");
    expect(iss.holders[0].tokens).toEqual({ baseUnits: "1000000000000", amount: "1000000", display: "1,000,000" });
    expect(iss.holders[0].pctOfSupply).toBe("100%");
  });

  it("rejects a signature over the wrong message or by another key", async () => {
    const { issuanceId, agreementHash } = await launch();
    const kp = nacl.sign.keyPair();
    const other = nacl.sign.keyPair();
    const wallet = bs58.encode(kp.publicKey);
    const wrongMsg = nacl.sign.detached(new TextEncoder().encode("I accept"), kp.secretKey);
    const otherKey = nacl.sign.detached(
      new TextEncoder().encode(agreementAcceptanceMessage(agreementHash, issuanceId)),
      other.secretKey,
    );
    for (const sig of [wrongMsg, otherKey]) {
      const res = await participantsPOST(
        post({ wallet, verified: true, eligible: true, agreementHash, signature: bs58.encode(sig) }, {}),
        ctx(issuanceId),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_signature");
    }
  });

  it("rejects a mismatched agreement hash and missing verification", async () => {
    const { issuanceId, agreementHash } = await launch();
    const kp = nacl.sign.keyPair();
    const wallet = bs58.encode(kp.publicKey);
    const signature = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(agreementAcceptanceMessage(agreementHash, issuanceId)), kp.secretKey),
    );
    const bad = await participantsPOST(
      post({ wallet, verified: true, eligible: true, agreementHash: "00".repeat(32), signature }, {}),
      ctx(issuanceId),
    );
    expect((await bad.json()).error).toBe("agreement_mismatch");
    const unverified = await participantsPOST(
      post({ wallet, verified: false, eligible: true, agreementHash, signature }, {}),
      ctx(issuanceId),
    );
    expect((await unverified.json()).error).toBe("not_verified");
  });
});

describe("market", () => {
  it("returns price, progress, yield, holders, economics with the market-cap disclaimer", async () => {
    const { issuanceId } = await launch();
    const res = await marketGET(new Request("http://test"), ctx(issuanceId));
    const m = await res.json();
    expect(res.status).toBe(200);
    expect(m.price.baseUnits).toBe("1000000");
    expect(m.tokenMarketCap.label).toBe("Token market cap — not company valuation");
    expect(m.progress.bar).toMatch(/^\[[█░]{20}\] /);
    expect(m.yield.periodsExecuted).toBe(0);
    expect(m.yield.periodsPerYear).toBe(4);
    expect(m.holders).toEqual({ count: 0, participants: 0, unregistered: 0 });
    expect(m.economics.split).toEqual({ issuerPct: 48, platformPct: 2, liquidityPct: 50 });
    expect(m.accruedTradingFees.startup).toHaveProperty("display");
    expect(m.distributionDue).toBe(false);
    expect(m.marketUrl).toContain(`/market/${issuanceId}`);
  });

  it("404s for an unknown issuance", async () => {
    const res = await marketGET(new Request("http://test"), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("quotes a buy with the fee breakdown", async () => {
    const { issuanceId } = await launch();
    const res = await quoteGET(new Request("http://test/q?side=BUY&amountIn=1000000000"), ctx(issuanceId));
    const q = await res.json();
    expect(res.status).toBe(200);
    expect(q.pay.asset).toBe("USDC");
    expect(q.receive.asset).toBe("ACME");
    // Meteora's protocol fee + startup share + Founder Stack share = total pool fee.
    expect(
      BigInt(q.fees.meteoraProtocolFee.baseUnits) +
        BigInt(q.fees.startupShare.baseUnits) +
        BigInt(q.fees.founderStackFee.baseUnits),
    ).toBe(BigInt(q.fees.poolFee.baseUnits));
    expect(BigInt(q.fees.meteoraProtocolFee.baseUnits)).toBeGreaterThan(0n);
    expect(q.fees.networkFee.lamports).toBeTruthy();
    const bad = await quoteGET(new Request("http://test/q?side=HOLD&amountIn=1"), ctx(issuanceId));
    expect(bad.status).toBe(400);
  });

  it("quotes and builds an exact-output buy (receive exactly N tokens)", async () => {
    const { issuanceId } = await launch();
    const res = await quoteGET(new Request("http://test/q?side=BUY&amountOut=100000000000"), ctx(issuanceId));
    const q = await res.json();
    expect(res.status).toBe(200);
    expect(q.mode).toBe("EXACT_OUT");
    expect(q.receive.baseUnits).toBe("100000000000");
    const needed = BigInt(q.pay.baseUnits);
    expect(needed).toBeGreaterThan(100_000_000_000n); // ~$1/token plus fees

    const swap = await swapPOST(post({ owner: "Buyer1111111111111111111111111111111111111", side: "BUY", amountOut: "100000000000" }, {}), ctx(issuanceId));
    const body = await swap.json();
    expect(swap.status).toBe(200);
    expect(body.mode).toBe("EXACT_OUT");
    expect(body.amountOut).toBe("100000000000");
    expect(BigInt(body.maxAmountIn)).toBe((needed * 10_100n + 9_999n) / 10_000n); // default 1% slippage

    const bad = await quoteGET(new Request("http://test/q?side=BUY&amountOut=1&mode=EXACT_SIDEWAYS"), ctx(issuanceId));
    expect(bad.status).toBe(400);
  });
});
