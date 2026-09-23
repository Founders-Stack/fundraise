// Distribution engine tests in CHAIN_MODE=fake, reproducing SPEC section 10 exactly.
// Run: pnpm --filter web exec tsx --test lib/server/distribution.test.ts
// Uses a throwaway SQLite DB + fake-chain file in a temp dir (never touches dev.db).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WEB = process.cwd();
const TMP = mkdtempSync(join(tmpdir(), "fs-dist-test-"));
process.env.DATABASE_URL = `file:${join(TMP, "test.db")}`;
process.env.CHAIN_MODE = "fake";
execSync("npx prisma db push --skip-generate --accept-data-loss", {
  cwd: WEB,
  env: { ...process.env },
  stdio: "ignore",
});
process.chdir(TMP); // fake chain persists to <cwd>/.fake-chain.json

const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const USDC = 1_000_000n;
const TOK = 1_000_000n;

type Svc = typeof import("./distribution");
let svc: Svc;
let prisma: typeof import("@/lib/db").prisma;
let fake: typeof import("@/lib/chain/fake");
let chain: import("@/lib/chain").ChainPorts;

const fakeState = () => JSON.parse(readFileSync(join(TMP, ".fake-chain.json"), "utf8"));
function setIssuerUsdc(baseUnits: bigint) {
  const s = fakeState();
  s.issuerUsdc = baseUnits.toString();
  writeFileSync(join(TMP, ".fake-chain.json"), JSON.stringify(s));
}
const usdcOf = (wallet: string) => BigInt(fakeState().usdc[wallet] ?? "0");

async function createIssuance(symbol: string) {
  const pool = await chain.market.createIssuancePool({
    name: `${symbol} test`,
    symbol,
    uri: "data:,",
    tokenSupply: 1_000_000n,
    tokenDecimals: 6,
    startingMarketCap: 1_000_000n * USDC,
    graduationMarketCap: 3_000_000n * USDC,
    fees: {} as never,
    creatorLockedLiquidityPercentage: 100,
  });
  return prisma.issuance.create({
    data: {
      issuerName: "Acme SaaS, Inc.",
      poolPercentageBps: 1000,
      tokenSupply: 1_000_000n,
      symbol,
      name: `${symbol} units`,
      distributionFrequency: "QUARTERLY",
      nextRecordDate: new Date("2026-09-30T00:00:00Z"),
      expectedAnnualDcf: 1_600_000n * USDC,
      targetInitialYieldBps: 1600,
      agreementVersion: "cf-1.0",
      agreementHash: "test",
      agreementText: "test agreement",
      startingMarketCap: 1_000_000n * USDC,
      graduationMarketCap: 3_000_000n * USDC,
      quoteMint: chain.payout.quoteMint(),
      baseMint: pool.baseMint,
      dbcConfig: JSON.stringify({ address: pool.dbcConfig, poolOwners: pool.poolOwners }),
      dbcPool: pool.dbcPool,
      monetization: "{}",
    },
  });
}

async function onboard(issuanceId: string, baseMint: string, wallet: string, displayName: string) {
  await prisma.participant.create({
    data: { issuanceId, wallet, displayName, verifiedAt: new Date(), eligibleAt: new Date(), agreementAcceptedAt: new Date(), agreementSig: "sig" },
  });
  await chain.registry.allowWallet(baseMint, wallet);
}

before(async () => {
  svc = await import("./distribution");
  prisma = (await import("@/lib/db")).prisma;
  fake = await import("@/lib/chain/fake");
  chain = await (await import("@/lib/chain")).getChain();
});
after(async () => {
  await prisma.$disconnect();
  rmSync(TMP, { recursive: true, force: true });
});

const ALICE = "AliceWa11et1111111111111111111111111111111";
const BOB = "BobWa11et11111111111111111111111111111111";

test("SPEC section 10: Q3 Alice 4,000; trade 40k; Q4 Alice 2,700 / Bob 1,800; yield after 2 periods", async () => {
  const iss = await createIssuance("ACME-CF");
  await onboard(iss.id, iss.baseMint!, ALICE, "Alice");
  fake.fakeSwap(iss.dbcPool!, ALICE, "BUY", 100_000n * TOK);

  // --- Q3 report
  const r3 = await svc.reportPeriod(iss.id, { periodLabel: "2026-Q3", dcf: "400000", reportUrl: "https://acme.example/q3.pdf" });
  assert.equal(r3.status, 201, j(r3.body));
  const d3 = (r3.body.distribution as Record<string, unknown>);
  assert.equal(d3.rightsPool, "40000");
  assert.equal(d3.perToken, "0.04");
  assert.equal(d3.status, "DRAFT");
  assert.match(d3.reportHash as string, /^[0-9a-f]{64}$/);

  // duplicate period + second open distribution rejected
  assert.equal((await svc.reportPeriod(iss.id, { periodLabel: "2026-Q3", dcf: "1" })).status, 409);
  const open = await svc.reportPeriod(iss.id, { periodLabel: "2026-Q4", dcf: "1" });
  assert.equal(open.status, 409);
  assert.equal(open.body.error, "open_distribution_exists");
  assert.equal((await svc.reportPeriod(iss.id, { periodLabel: "x", dcf: "-5" })).status, 400);

  // execute before snapshot rejected
  const early = await svc.executeDistribution(d3.id as string, { confirmTotal: "4000" });
  assert.equal(early.status, 409);

  // --- snapshot
  const s3 = await svc.snapshotDistribution(d3.id as string);
  assert.equal(s3.status, 200, j(s3.body));
  const rows3 = s3.body.rows as { wallet: string; displayName: string; payout: string; tokens: string; pctOfSupply: string }[];
  assert.equal(rows3.length, 1);
  assert.deepEqual(
    { w: rows3[0].wallet, n: rows3[0].displayName, p: rows3[0].payout, t: rows3[0].tokens, pct: rows3[0].pctOfSupply },
    { w: ALICE, n: "Alice", p: "4000", t: "100,000", pct: "10.00%" },
  );
  assert.equal(s3.body.confirmTotal, "4000");
  const un3 = s3.body.unallocated as { label: string; total: string; breakdown: Record<string, string> };
  assert.equal(un3.label, "Unallocated (retained by issuer)");
  assert.equal(un3.total, "36000");
  assert.equal(un3.breakdown.marketPool, "36000");
  const ex3 = s3.body.excluded as { kind: string; tokens: string }[];
  assert.deepEqual(ex3.map((e) => [e.kind, e.tokens]), [["POOL", "900,000"]]);
  assert.equal((s3.body.balance as { sufficient: boolean }).sufficient, true);

  // re-snapshot allowed while not executed (replaces allocations)
  assert.equal((await svc.snapshotDistribution(d3.id as string)).status, 200);
  assert.equal(await prisma.allocation.count({ where: { distributionId: d3.id as string } }), 1);

  // --- confirmTotal gate
  const missing = await svc.executeDistribution(d3.id as string, {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "confirm_total_required");
  const wrong = await svc.executeDistribution(d3.id as string, { confirmTotal: "40000" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, "confirm_total_mismatch");
  assert.equal(wrong.body.expected, undefined, "must not leak the expected total");
  const baseUnitsTyped = await svc.executeDistribution(d3.id as string, { confirmTotal: "4000000000" });
  assert.equal(baseUnitsTyped.body.error, "confirm_total_mismatch", "base units are not accepted as confirmTotal");

  // --- insufficient balance -> 409 with shortfall
  setIssuerUsdc(1_000n * USDC);
  const poor = await svc.executeDistribution(d3.id as string, { confirmTotal: "4000" });
  assert.equal(poor.status, 409);
  assert.equal(poor.body.error, "insufficient_balance");
  assert.equal(poor.body.shortfall, "3000");
  assert.equal(usdcOf(ALICE), 0n);
  setIssuerUsdc(1_000_000n * USDC);

  // --- execute (typed with separators is fine)
  const e3 = await svc.executeDistribution(d3.id as string, { confirmTotal: "4,000.00" });
  assert.equal(e3.status, 200, j(e3.body));
  assert.equal((e3.body.distribution as { status: string }).status, "EXECUTED");
  const sigs3 = e3.body.signatures as { signature: string; fake: boolean; explorerUrl: string | null }[];
  assert.equal(sigs3.length, 1);
  assert.equal(sigs3[0].fake, true);
  assert.equal(usdcOf(ALICE), 4_000n * USDC);
  const issAfterQ3 = await prisma.issuance.findUniqueOrThrow({ where: { id: iss.id } });
  assert.equal(issAfterQ3.nextRecordDate?.toISOString(), "2026-12-30T00:00:00.000Z");

  // --- execute twice is idempotent: no second transfer
  const issuerBefore = BigInt(fakeState().issuerUsdc);
  const again = await svc.executeDistribution(d3.id as string, { confirmTotal: "4000" });
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyExecuted, true);
  assert.equal(BigInt(fakeState().issuerUsdc), issuerBefore);
  assert.equal(usdcOf(ALICE), 4_000n * USDC);
  assert.equal((await svc.snapshotDistribution(d3.id as string)).status, 409, "snapshot immutable after execution");

  // --- trade: Alice sells 40k, Bob onboards and buys 40k
  fake.fakeSwap(iss.dbcPool!, ALICE, "SELL", 40_000n * TOK);
  await onboard(iss.id, iss.baseMint!, BOB, "Bob");
  fake.fakeSwap(iss.dbcPool!, BOB, "BUY", 40_000n * TOK);

  // --- Q4
  const r4 = await svc.reportPeriod(iss.id, { periodLabel: "2026-Q4", dcf: "450000.00" });
  assert.equal(r4.status, 201, j(r4.body));
  const d4 = r4.body.distribution as { id: string; rightsPool: string; perToken: string };
  assert.equal(d4.rightsPool, "45000");
  assert.equal(d4.perToken, "0.045");
  const s4 = await svc.snapshotDistribution(d4.id);
  const rows4 = (s4.body.rows as { displayName: string; payout: string; tokens: string }[]).map((r) => [r.displayName, r.tokens, r.payout]);
  assert.deepEqual(rows4, [
    ["Alice", "60,000", "2700"],
    ["Bob", "40,000", "1800"],
  ]);
  assert.equal(s4.body.confirmTotal, "4500");
  assert.equal((s4.body.unallocated as { total: string }).total, "40500");
  const e4 = await svc.executeDistribution(d4.id, { confirmTotal: "4500" });
  assert.equal(e4.status, 200, j(e4.body));
  assert.equal(usdcOf(ALICE), 6_700n * USDC);
  assert.equal(usdcOf(BOB), 1_800n * USDC);

  // --- public history + yield after two periods
  const h = await svc.listDistributions(iss.id);
  assert.equal(h.status, 200);
  const dists = h.body.distributions as { periodLabel: string; status: string; signatures: unknown[] }[];
  assert.deepEqual(dists.map((d) => [d.periodLabel, d.status, d.signatures.length]), [
    ["2026-Q3", "EXECUTED", 1],
    ["2026-Q4", "EXECUTED", 1],
  ]);
  const y = h.body.yield as Record<string, unknown>;
  assert.equal(y.periods, 2);
  assert.equal(y.lastPerToken, "0.045");
  assert.equal(y.ttmPerToken, "0.085");
  assert.equal(y.annualizedRunRatePerToken, "0.18");
  assert.equal(y.isAnnualized, true);
  assert.equal(y.annualizedNote, "annualized from 2 periods");
  assert.equal(typeof y.trailingYield, "string");
  console.log("yield after 2 periods:", j(y));
  const issuanceInfo = h.body.issuance as { dcfDefinition: string };
  assert.match(issuanceInfo.dcfDefinition, /operating expenses/);
});

test("partial failure: completed batches persist, retry pays only unpaid rows", async () => {
  const iss = await createIssuance("PART-CF");
  const wallets = Array.from({ length: 12 }, (_, i) => `Holder${String(i).padStart(2, "0")}`.padEnd(44, "x"));
  for (const [i, w] of wallets.entries()) {
    await onboard(iss.id, iss.baseMint!, w, `H${i}`);
    fake.fakeSwap(iss.dbcPool!, w, "BUY", 10_000n * TOK);
  }
  const r = await svc.reportPeriod(iss.id, { periodLabel: "2026-Q3", dcf: "100000" });
  const id = (r.body.distribution as { id: string }).id;
  const s = await svc.snapshotDistribution(id);
  assert.equal(s.body.confirmTotal, "1200"); // 12 x 10k tokens x 0.01

  const original = chain.payout.transferBatch;
  let calls = 0;
  chain.payout.transferBatch = async (rows) => {
    calls++;
    if (calls === 2) throw new Error("simulated RPC timeout");
    return original(rows);
  };
  try {
    const failed = await svc.executeDistribution(id, { confirmTotal: "1200" });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error, "partial_execution");
    assert.equal(failed.body.batchesCompleted, 1);
    assert.equal(await prisma.allocation.count({ where: { distributionId: id, txSignature: { not: null } } }), 10);
    assert.equal((await prisma.distribution.findUniqueOrThrow({ where: { id } })).status, "SNAPSHOTTED");
    assert.equal((await svc.snapshotDistribution(id)).status, 409, "no re-snapshot once rows are paid");

    const retry = await svc.executeDistribution(id, { confirmTotal: "1200" });
    assert.equal(retry.status, 200, j(retry.body));
    assert.equal((retry.body.newSignatures as string[]).length, 1);
    assert.equal((retry.body.signatures as unknown[]).length, 2);
  } finally {
    chain.payout.transferBatch = original;
  }
  for (const w of wallets) assert.equal(usdcOf(w), 100n * USDC, `each holder paid exactly once (${w})`);
});
