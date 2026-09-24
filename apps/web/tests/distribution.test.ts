// Distribution lifecycle through the API routes against the in-memory fake chain, reproducing SPEC section 10 exactly.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as historyGET, POST as reportPOST } from "@/app/api/issuances/[id]/distributions/route";
import { GET as detailGET } from "@/app/api/distributions/[id]/route";
import { POST as snapshotPOST } from "@/app/api/distributions/[id]/snapshot/route";
import { POST as executePOST } from "@/app/api/distributions/[id]/execute/route";
import { fake } from "./fake-chain";
import { AUTH, call, get, launch, onboard, post, type Json } from "./helpers";

const USDC = 1_000_000n;
const TOK = 1_000_000n;
const { swap, setIssuerUsdc, usdcBalance: usdcOf } = fake.control;
const payout = fake.ports.payout;

const report = (issuanceId: string, body: unknown) => call(reportPOST, post(body), issuanceId);
const snapshot = (id: string) => call(snapshotPOST, post(undefined), id);
const execute = (id: string, confirmTotal?: string) => call(executePOST, post(confirmTotal === undefined ? {} : { confirmTotal }), id);
const history = (issuanceId: string) => call(historyGET, get(), issuanceId);

beforeAll(() => {
  // Launch in the middle of Q3 2026 so record dates are deterministic.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-15T12:00:00Z"));
});
afterAll(() => vi.useRealTimers());

describe("distribution lifecycle", () => {
  it("SPEC section 10: Q3 Alice 4,000; trade 40k; Q4 Alice 2,700 / Bob 1,800; yield after 2 periods", async () => {
    const iss = await launch({ symbol: "ACME-CF" });
    expect(iss.nextRecordDate).toBe("2026-09-30T23:59:59.999Z");
    const alice = await onboard(iss, "Alice");
    swap(iss.dbcPool, alice, "BUY", 100_000n * TOK);

    // --- Q3 report (label is normalized to the canonical form)
    const r3 = await report(iss.issuanceId, { periodLabel: "2026-q3", dcf: "400000", reportUrl: "https://acme.example/q3.pdf" });
    expect(r3.status, JSON.stringify(r3.body)).toBe(201);
    const d3 = r3.body.distribution;
    expect(d3.periodLabel).toBe("2026-Q3");
    expect(d3.rightsPool).toBe("40000");
    expect(d3.perToken).toBe("0.04");
    expect(d3.status).toBe("DRAFT");
    expect(d3.reportHash).toMatch(/^[0-9a-f]{64}$/);

    // duplicate period, second open distribution, bad input
    expect((await report(iss.issuanceId, { periodLabel: "2026-Q3", dcf: "1" })).status).toBe(409);
    const open = await report(iss.issuanceId, { periodLabel: "2026-Q4", dcf: "1" });
    expect(open.status).toBe(409);
    expect(open.body.error).toBe("open_distribution_exists");
    expect(open.body.details.distributionId).toBe(d3.id);
    expect((await report(iss.issuanceId, { periodLabel: "2026-Q4", dcf: "-5" })).body.error).toBe("invalid_dcf");

    // execute before snapshot rejected; auth required
    expect((await execute(d3.id, "4000")).status).toBe(409);
    expect((await call(executePOST, post({ confirmTotal: "4000" }, {}), d3.id)).status).toBe(401);

    // --- snapshot
    const s3 = await snapshot(d3.id);
    expect(s3.status, JSON.stringify(s3.body)).toBe(200);
    const rows3 = s3.body.rows;
    expect(rows3.map((r: Json) => [r.wallet, r.displayName, r.payout, r.tokens, r.pctOfSupply])).toEqual([
      [alice, "Alice", "4000", "100,000", "10.00%"],
    ]);
    expect(s3.body.confirmTotal).toBe("4000");
    expect(s3.body.unallocated.label).toBe("Unallocated (retained by issuer)");
    expect(s3.body.unallocated.total).toBe("36000");
    expect(s3.body.unallocated.breakdown.marketPool).toBe("36000");
    expect(s3.body.excluded.map((e: Json) => [e.kind, e.tokens])).toEqual([["POOL", "900,000"]]);
    expect(s3.body.balance.sufficient).toBe(true);

    // re-snapshot allowed while not executed (replaces allocations)
    expect((await snapshot(d3.id)).status).toBe(200);
    expect((await call(detailGET, get(AUTH), d3.id)).body.rows).toHaveLength(1);

    // --- confirmTotal gate
    const missing = await execute(d3.id);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("confirm_total_required");
    const wrong = await execute(d3.id, "40000");
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("confirm_total_mismatch");
    expect(JSON.stringify(wrong.body)).not.toContain('"4000"'); // must not leak the expected total
    const baseUnitsTyped = await execute(d3.id, "4000000000");
    expect(baseUnitsTyped.body.error, "base units are not accepted as confirmTotal").toBe("confirm_total_mismatch");

    // --- insufficient balance -> 409 with shortfall
    setIssuerUsdc(1_000n * USDC);
    const poor = await execute(d3.id, "4000");
    expect(poor.status).toBe(409);
    expect(poor.body.error).toBe("insufficient_balance");
    expect(poor.body.details.shortfall).toBe("3000");
    expect(usdcOf(alice)).toBe(0n);
    setIssuerUsdc(1_000_000n * USDC);

    // --- execute (typed with separators is fine)
    const e3 = await execute(d3.id, "4,000.00");
    expect(e3.status, JSON.stringify(e3.body)).toBe(200);
    expect(e3.body.distribution.status).toBe("EXECUTED");
    expect(e3.body.signatures).toHaveLength(1);
    expect(e3.body.signatures[0].fake).toBe(true);
    expect(usdcOf(alice)).toBe(4_000n * USDC);
    expect(e3.body.nextRecordDate).toBe("2026-12-31T23:59:59.999Z");

    // --- execute twice is idempotent: no second transfer; snapshot is immutable
    const issuerBefore = fake.control.issuerUsdc();
    const again = await execute(d3.id, "4000");
    expect(again.status).toBe(200);
    expect(again.body.alreadyExecuted).toBe(true);
    expect(fake.control.issuerUsdc()).toBe(issuerBefore);
    expect(usdcOf(alice)).toBe(4_000n * USDC);
    expect((await snapshot(d3.id)).body.error).toBe("already_executed");

    // --- trade: Alice sells 40k, Bob onboards and buys 40k
    swap(iss.dbcPool, alice, "SELL", 40_000n * TOK);
    const bob = await onboard(iss, "Bob");
    swap(iss.dbcPool, bob, "BUY", 40_000n * TOK);

    // --- Q4: the server says which period is next
    const before = await history(iss.issuanceId);
    expect(before.body.issuance.nextPeriod.label).toBe("2026-Q4");
    const r4 = await report(iss.issuanceId, { periodLabel: before.body.issuance.nextPeriod.label, dcf: "450000.00" });
    expect(r4.status, JSON.stringify(r4.body)).toBe(201);
    const d4 = r4.body.distribution;
    expect(d4.rightsPool).toBe("45000");
    expect(d4.perToken).toBe("0.045");
    const s4 = await snapshot(d4.id);
    expect(s4.body.rows.map((r: Json) => [r.displayName, r.tokens, r.payout])).toEqual([
      ["Alice", "60,000", "2700"],
      ["Bob", "40,000", "1800"],
    ]);
    expect(s4.body.confirmTotal).toBe("4500");
    expect(s4.body.unallocated.total).toBe("40500");
    const e4 = await execute(d4.id, "4500");
    expect(e4.status, JSON.stringify(e4.body)).toBe(200);
    expect(usdcOf(alice)).toBe(6_700n * USDC);
    expect(usdcOf(bob)).toBe(1_800n * USDC);

    // --- public history + yield after two periods
    const h = await history(iss.issuanceId);
    expect(h.status).toBe(200);
    expect(h.body.distributions.map((d: Json) => [d.periodLabel, d.status, d.signatures.length])).toEqual([
      ["2026-Q3", "EXECUTED", 1],
      ["2026-Q4", "EXECUTED", 1],
    ]);
    expect(h.body.issuance.nextRecordDate).toBe("2027-03-31T23:59:59.999Z");
    expect(h.body.issuance.nextPeriod.label).toBe("2027-Q1");
    const y = h.body.yield;
    expect(y.periods).toBe(2);
    expect(y.lastPerToken).toBe("0.045");
    expect(y.ttmPerToken).toBe("0.085");
    expect(y.annualizedRunRatePerToken).toBe("0.18");
    expect(y.isAnnualized).toBe(true);
    expect(y.annualizedNote).toBe("annualized from 2 periods");
    expect(typeof y.trailingYield).toBe("string");
    expect(h.body.issuance.dcfDefinition).toMatch(/operating expenses/);
  });

  it("rejects period labels that don't match the issuance's frequency, and says which period is next", async () => {
    const iss = await launch({ symbol: "LBL-CF" });
    for (const periodLabel of ["Q3", "2026-09", "2026-Q5", ""]) {
      const r = await report(iss.issuanceId, { periodLabel, dcf: "1" });
      expect(r.status, periodLabel).toBe(400);
      expect(r.body.error).toBe("invalid_period_label");
    }
    const r = await report(iss.issuanceId, { periodLabel: "2026-09", dcf: "1" });
    expect(r.body.details.nextPeriod.label).toBe("2026-Q3");
    expect((await report("nope", { periodLabel: "2026-Q3", dcf: "1" })).status).toBe(404);
  });

  it("partial failure: completed batches persist, retry pays only unpaid rows", async () => {
    const iss = await launch({ symbol: "PART-CF" });
    const wallets: string[] = [];
    for (let i = 0; i < 12; i++) {
      const w = await onboard(iss, `H${i}`);
      swap(iss.dbcPool, w, "BUY", 10_000n * TOK);
      wallets.push(w);
    }
    const r = await report(iss.issuanceId, { periodLabel: "2026-Q3", dcf: "100000" });
    const id = r.body.distribution.id;
    const s = await snapshot(id);
    expect(s.body.confirmTotal).toBe("1200"); // 12 x 10k tokens x 0.01

    const original = payout.transferBatch;
    let calls = 0;
    payout.transferBatch = async (rows) => {
      calls++;
      if (calls === 2) throw new Error("simulated RPC timeout");
      return original(rows);
    };
    try {
      const failed = await execute(id, "1200");
      expect(failed.status).toBe(502);
      expect(failed.body.error).toBe("partial_execution");
      expect(failed.body.details.batchesCompleted).toBe(1);
      const detail = (await call(detailGET, get(AUTH), id)).body;
      expect(detail.rows.filter((row: Json) => row.paid)).toHaveLength(10);
      expect(detail.distribution.status).toBe("SNAPSHOTTED");
      expect(detail.executionInProgress, "a failed execute releases its lease").toBe(false);
      expect((await snapshot(id)).body.error, "no re-snapshot once rows are paid").toBe("payout_in_progress");

      const retry = await execute(id, "1200");
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(retry.body.newSignatures).toHaveLength(1);
      expect(retry.body.signatures).toHaveLength(2);
    } finally {
      payout.transferBatch = original;
    }
    for (const w of wallets) expect(usdcOf(w), `each holder paid exactly once (${w})`).toBe(100n * USDC);
  });

  it("concurrent executes: one pays, the other is refused; snapshot is refused while paying", async () => {
    const iss = await launch({ symbol: "RACE-CF" });
    const alice = await onboard(iss, "Alice");
    swap(iss.dbcPool, alice, "BUY", 100_000n * TOK);
    const id = (await report(iss.issuanceId, { periodLabel: "2026-Q3", dcf: "400000" })).body.distribution.id;
    expect((await snapshot(id)).body.confirmTotal).toBe("4000");

    const original = payout.transferBatch;
    payout.transferBatch = async (rows) => {
      await new Promise((r) => setTimeout(r, 100));
      return original(rows);
    };
    try {
      const later = <T>(fn: () => Promise<T>) => new Promise<T>((r) => setTimeout(() => r(fn()), 30));
      const [a, b, snap] = await Promise.all([execute(id, "4000"), later(() => execute(id, "4000")), later(() => snapshot(id))]);
      expect([a.status, b.status]).toEqual([200, 409]);
      expect(b.body.error).toBe("execution_in_progress");
      expect(snap.status).toBe(409);
      expect(snap.body.error).toBe("execution_in_progress");
    } finally {
      payout.transferBatch = original;
    }
    expect(usdcOf(alice)).toBe(4_000n * USDC);
  });
});
