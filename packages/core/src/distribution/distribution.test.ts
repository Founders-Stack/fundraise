import { describe, expect, it } from "vitest";
import {
  allocate,
  batchTransfers,
  computeRightsPool,
  perTokenDisplay,
  yieldMetrics,
  type AllocationResult,
  type HolderBalance,
  type Snapshot,
} from "./index";

const U = 1_000_000n; // 6 dp for both USDC and token
const SUPPLY = 1_000_000n * U;

function checkInvariants(r: AllocationResult) {
  expect(r.totalAllocated + r.unallocated).toBe(r.rightsPool);
  const b = r.unallocatedBreakdown;
  expect(b.pool + b.unregistered + b.unsold + b.dust).toBe(r.unallocated);
  expect(b.dust >= 0n).toBe(true);
  expect(r.rows.reduce((s, x) => s + x.payout, 0n)).toBe(r.totalAllocated);
}

const h = (owner: string, tokens: bigint, kind: HolderBalance["kind"] = "PARTICIPANT", acct = `${owner}-ata`): HolderBalance => ({
  owner,
  tokenAccount: acct,
  amount: tokens,
  kind,
  ...(kind === "PARTICIPANT" ? { participantId: `p-${owner}` } : {}),
});

describe("computeRightsPool", () => {
  it("10% of 400k = 40k", () => {
    expect(computeRightsPool(400_000n * U, 1000)).toBe(40_000n * U);
  });
  it("validates bps", () => {
    expect(() => computeRightsPool(1n, 0)).toThrow();
    expect(() => computeRightsPool(1n, 10_001)).toThrow();
    expect(() => computeRightsPool(1n, 12.5)).toThrow();
    expect(computeRightsPool(7n, 10_000)).toBe(7n);
  });
});

describe("SPEC demo", () => {
  it("Q3: Alice 100k of 1M, pool 40k -> Alice 4,000, unallocated 36,000", () => {
    const pool = computeRightsPool(400_000n * U, 1000);
    const snap: Snapshot = {
      slot: 100,
      tokenSupply: SUPPLY,
      holders: [h("Alice", 100_000n * U), h("DBCpool", 300_000n * U, "POOL")],
    };
    const r = allocate(snap, pool);
    expect(r.rows).toEqual([{ owner: "Alice", participantId: "p-Alice", tokens: 100_000n * U, payout: 4_000n * U }]);
    expect(r.totalAllocated).toBe(4_000n * U);
    expect(r.unallocated).toBe(36_000n * U);
    expect(r.unallocatedBreakdown).toEqual({ pool: 12_000n * U, unregistered: 0n, unsold: 24_000n * U, dust: 0n });
    expect(r.excluded).toEqual([{ owner: "DBCpool", kind: "POOL", tokens: 300_000n * U, retainedShare: 12_000n * U }]);
    expect(perTokenDisplay(pool, SUPPLY)).toBe("0.04");
    checkInvariants(r);
  });

  it("Q4: Alice 60k, Bob 40k, pool 45k -> 2,700 / 1,800", () => {
    const pool = computeRightsPool(450_000n * U, 1000);
    expect(pool).toBe(45_000n * U);
    const r = allocate(
      { slot: 200, tokenSupply: SUPPLY, holders: [h("Bob", 40_000n * U), h("Alice", 60_000n * U), h("DBCpool", 340_000n * U, "POOL")] },
      pool,
    );
    expect(r.rows.map((x) => [x.owner, x.payout])).toEqual([
      ["Alice", 2_700n * U],
      ["Bob", 1_800n * U],
    ]);
    expect(r.unallocated).toBe(40_500n * U);
    expect(perTokenDisplay(pool, SUPPLY)).toBe("0.045");
    checkInvariants(r);
  });

  it("yield: 0.04 + 0.045, price 1.00, quarterly", () => {
    const now = new Date("2026-12-31T00:00:00Z");
    const m = yieldMetrics(
      [
        { periodLabel: "2026-Q4", executedAt: new Date("2026-12-30T00:00:00Z"), rightsPool: 45_000n * U, tokenSupply: SUPPLY },
        { periodLabel: "2026-Q3", executedAt: new Date("2026-10-01T00:00:00Z"), rightsPool: 40_000n * U, tokenSupply: SUPPLY },
      ],
      1n * U,
      4,
      now,
    );
    expect(m.lastPerToken).toBe(45_000n); // 0.045 USDC
    expect(m.ttmPerToken).toBe(85_000n);
    expect(m.trailingYieldBps).toBe(850);
    expect(m.annualizedRunRatePerToken).toBe(180_000n); // 0.18
    expect(m.annualizedYieldBps).toBe(1800);
    expect(m.periodsCounted).toBe(2);
    expect(m.isAnnualized).toBe(true);
  });
});

describe("allocate edge cases", () => {
  it("rounding dust: 3 holders of 1 token each, odd pool", () => {
    const r = allocate({ slot: 1, tokenSupply: 3n, holders: [h("a", 1n), h("b", 1n), h("c", 1n)] }, 100n);
    expect(r.rows.map((x) => x.payout)).toEqual([33n, 33n, 33n]);
    expect(r.rows.map((x) => x.owner)).toEqual(["a", "b", "c"]);
    expect(r.totalAllocated).toBe(99n);
    expect(r.unallocated).toBe(1n);
    expect(r.unallocatedBreakdown).toEqual({ pool: 0n, unregistered: 0n, unsold: 0n, dust: 1n });
    checkInvariants(r);
  });

  it("merges multiple token accounts of the same owner", () => {
    const r = allocate(
      {
        slot: 1,
        tokenSupply: SUPPLY,
        holders: [h("Alice", 30_000n * U, "PARTICIPANT", "a1"), h("Bob", 50_000n * U), h("Alice", 70_000n * U, "PARTICIPANT", "a2")],
      },
      40_000n * U,
    );
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toEqual({ owner: "Alice", participantId: "p-Alice", tokens: 100_000n * U, payout: 4_000n * U });
    expect(r.rows[1]!.payout).toBe(2_000n * U);
    checkInvariants(r);
  });

  it("unregistered holders are unallocated", () => {
    const r = allocate({ slot: 1, tokenSupply: 100n, holders: [h("a", 50n), h("carol", 50n, "UNREGISTERED")] }, 1000n);
    expect(r.totalAllocated).toBe(500n);
    expect(r.unallocatedBreakdown.unregistered).toBe(500n);
    checkInvariants(r);
  });

  it("rejects balances exceeding supply and conflicting kinds", () => {
    expect(() => allocate({ slot: 1, tokenSupply: 1n, holders: [h("a", 2n)] }, 1n)).toThrow();
    expect(() => allocate({ slot: 1, tokenSupply: 10n, holders: [h("a", 1n), h("a", 1n, "POOL")] }, 1n)).toThrow();
  });

  it("ordering is by payout desc then owner", () => {
    const r = allocate({ slot: 1, tokenSupply: 100n, holders: [h("z", 10n), h("b", 20n), h("a", 10n)] }, 100n);
    expect(r.rows.map((x) => x.owner)).toEqual(["b", "a", "z"]);
  });

  it("property: invariants hold over random inputs", () => {
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const kinds: HolderBalance["kind"][] = ["PARTICIPANT", "PARTICIPANT", "POOL", "UNREGISTERED"];
    for (let i = 0; i < 500; i++) {
      const supply = BigInt(rnd() % 10_000_000) + 1n;
      let remaining = supply;
      const holders: HolderBalance[] = [];
      const n = rnd() % 12;
      for (let j = 0; j < n && remaining > 0n; j++) {
        const amt = BigInt(rnd()) % (remaining + 1n);
        remaining -= amt;
        const owner = `o${rnd() % 6}`;
        const kind = kinds[Number(owner.slice(1)) % kinds.length]!; // stable kind per owner
        holders.push(h(owner, amt, kind, `acct${j}`));
      }
      const pool = BigInt(rnd()) * BigInt(rnd() % 1000);
      const r = allocate({ slot: i, tokenSupply: supply, holders }, pool);
      checkInvariants(r);
      for (const row of r.rows) expect(row.payout).toBe((row.tokens * pool) / supply);
    }
  });
});

describe("perTokenDisplay", () => {
  it("formats with up to 6 decimals, floored", () => {
    expect(perTokenDisplay(1n * U, 3n * U)).toBe("0.333333");
    expect(perTokenDisplay(2_000_000n * U, SUPPLY)).toBe("2");
    expect(perTokenDisplay(0n, SUPPLY)).toBe("0");
  });
});

describe("yieldMetrics", () => {
  it("excludes periods older than 365 days and handles zero price", () => {
    const now = new Date("2027-12-31T00:00:00Z");
    const m = yieldMetrics(
      [
        { periodLabel: "old", executedAt: new Date("2026-01-01T00:00:00Z"), rightsPool: 40_000n * U, tokenSupply: SUPPLY },
        { periodLabel: "new", executedAt: new Date("2027-06-01T00:00:00Z"), rightsPool: 10_000n * U, tokenSupply: SUPPLY },
      ],
      0n,
      4,
      now,
    );
    expect(m.periodsCounted).toBe(1);
    expect(m.ttmPerToken).toBe(10_000n);
    expect(m.lastPerToken).toBe(10_000n);
    expect(m.trailingYieldBps).toBeNull();
    expect(m.annualizedYieldBps).toBeNull();
  });

  it("isAnnualized false with a full year of periods", () => {
    const now = new Date("2027-12-31T00:00:00Z");
    const history = ["2027-03-01", "2027-06-01", "2027-09-01", "2027-12-01"].map((d, i) => ({
      periodLabel: `Q${i + 1}`,
      executedAt: new Date(`${d}T00:00:00Z`),
      rightsPool: 40_000n * U,
      tokenSupply: SUPPLY,
    }));
    const m = yieldMetrics(history, 1n * U, 4, now);
    expect(m.isAnnualized).toBe(false);
    expect(m.trailingYieldBps).toBe(1600);
  });

  it("empty history", () => {
    const m = yieldMetrics([], 1n * U, 4, new Date());
    expect(m).toMatchObject({ lastPerToken: 0n, ttmPerToken: 0n, periodsCounted: 0, isAnnualized: true, trailingYieldBps: 0 });
  });
});

describe("batchTransfers", () => {
  it("chunks and skips zero payouts", () => {
    const rows = Array.from({ length: 23 }, (_, i) => ({ owner: `o${i}`, tokens: 1n, payout: i % 5 === 0 ? 0n : 1n }));
    const batches = batchTransfers(rows);
    expect(batches.map((b) => b.length)).toEqual([10, 8]);
    expect(batches.flat().every((r) => r.payout > 0n)).toBe(true);
    expect(batchTransfers(rows, 7).map((b) => b.length)).toEqual([7, 7, 4]);
    expect(batchTransfers([])).toEqual([]);
    expect(() => batchTransfers(rows, 0)).toThrow();
  });
});
