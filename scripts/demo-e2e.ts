#!/usr/bin/env -S npx tsx
// A20 — Headless E2E run of SPEC.md section 10 ("Demo (single video, <= 3 min)"), driven entirely
// over the real Next.js HTTP API (the same routes the fstack MCP server / skills call), against
// CHAIN_MODE=fake (no devnet secrets needed).
//
//   launch (preview -> create) -> Carol fails (NotEligible) -> Alice onboards + buys 100k
//   -> Q3 report/snapshot/execute ($4,000 to Alice) -> trade (Alice sells 40k, Bob buys 40k)
//   -> Q4 report/snapshot/execute ($2,700 to Alice, $1,800 to Bob) -> market/history summary
//   -> reset (delete everything this run created)
//
// Usage:
//   pnpm demo:e2e                              # from the repo root
//   apps/web/node_modules/.bin/tsx scripts/demo-e2e.ts
//   npx tsx scripts/demo-e2e.ts                # if tsx is resolvable on your machine
//
// Env (all optional):
//   PORT           dev server port to use/start (default 3123)
//   FS_API_TOKEN   issuer bearer token (default "dev-local-token", matches scripts/agent-smoke)
//   DEMO_SCALE     scales supply, DCF, buys and payouts (default 1 = pitch example, 1,000,000 supply).
//                  DEMO_SCALE=0.001 is the mainnet pilot (SPEC section 10): 1,000 supply, Alice buys
//                  100, payouts $4.00 / $2.70 / $1.80. Per-token prices, payouts and yields are unchanged.
//
// --dry-run  (A29): does NOT start a server or run the HTTP flow. Against the configured cluster
//   (SOLANA_CLUSTER, RPC_URL, QUOTE_MINT, FS_ALLOWLIST_PROGRAM_ID, FS_AUTHORITY_KEYPAIR, ISSUER_KEYPAIR)
//   it derives the pilot-scale pool (terms -> pricing -> DBC curve), checks the graduation threshold
//   sits far above the pilot buys, builds the exact createConfigAndPoolWithTransferHook tx and the
//   fs_allowlist initialize + add_allow tx, and SIMULATES the first one (sigVerify off). Nothing is
//   signed with a funded key and nothing is sent: the connection's send methods are disabled.
//     DEMO_SCALE=0.001 scripts/chain/run.sh ../demo-e2e.ts --dry-run    (or see docs/mainnet-pilot.md)
//
// If nothing is listening on PORT, this script starts `next dev` itself (apps/web, CHAIN_MODE=fake)
// against a throwaway SQLite file in the OS temp dir, and stops it on exit. If a server is ALREADY
// listening on PORT (e.g. `pnpm dev`), the script reuses it and only deletes the rows it created.
//
// Note on the fake chain: CHAIN_MODE=fake's `buildSwapTx`/`swap` HTTP endpoints return a static
// unsigned "transaction" (there is nothing to actually sign/send locally). The fake chain's control
// handle (`createFakeChain().control.swap`, apps/web/lib/chain/fake.ts) is the fake-mode equivalent
// of "the investor's wallet signs and sends the tx"; it reads and writes the same
// apps/web/.fake-chain.json as the dev server. So each trade below is exercised twice, exactly
// mirroring what a real devnet run does (scripts/chain/ports-smoke.ts): first the real HTTP
// quote/swap endpoints (fee breakdown, the NotEligible warning, the unsigned tx), then `fakeSwap`
// standing in for "the wallet signed and the validator confirmed it" — which is also where the
// fs_allowlist hook's NotEligible failure actually happens in fake mode.

import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLUSTERS, parseClusterName } from "../packages/core/src/cluster";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(ROOT, "apps", "web");

const PORT = Number(process.env.PORT) || 3123;
const FS_API_TOKEN = process.env.FS_API_TOKEN || "dev-local-token";
const BASE = `http://localhost:${PORT}/api`;

const DRY_RUN = process.argv.includes("--dry-run");

// ---- DEMO_SCALE (SPEC section 10): pitch example x scale. 0.001 = mainnet pilot.
const DEMO_SCALE = Number(process.env.DEMO_SCALE ?? "1");
const PITCH_SUPPLY = 1_000_000n;
const SUPPLY = BigInt(Math.round(1_000_000 * DEMO_SCALE));
if (!(DEMO_SCALE > 0 && DEMO_SCALE <= 1) || Number(SUPPLY) !== 1_000_000 * DEMO_SCALE) {
  throw new Error(`DEMO_SCALE must be in (0, 1] and give a whole-token supply (e.g. 1, 0.01, 0.001); got ${process.env.DEMO_SCALE}`);
}
/** A whole-number pitch amount (tokens or whole USDC) at the current scale. Exact when divisible. */
const sc = (pitch: bigint) => (pitch * SUPPLY) / PITCH_SUPPLY;
/** A pitch USDC amount at scale, as the API's decimal string ("4000", "2.7"). */
function scUsdc(pitchWhole: bigint): string {
  const base = (pitchWhole * 1_000_000n * SUPPLY) / PITCH_SUPPLY;
  const whole = base / 1_000_000n;
  const frac = (base % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
const grouped = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const USDC_UNIT = 10n ** 6n;
const TOKEN_UNIT = 10n ** 6n; // ACME-CF also has 6 decimals (SPEC section 5)
const usdcBaseUnits = (whole: bigint) => (whole * USDC_UNIT).toString();

// ---------------------------------------------------------------- reporting

let stepNum = 0;
let failed = false;

function step(title: string) {
  stepNum += 1;
  console.log(`\n== step ${stepNum}: ${title}`);
}

class AssertionError extends Error {}

function pass(label: string, extra?: unknown) {
  console.log(`  PASS  ${label}${extra !== undefined ? ` = ${JSON.stringify(extra)}` : ""}`);
}

function fail(label: string, detail?: unknown): never {
  console.log(`  FAIL  ${label}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ""}`);
  throw new AssertionError(label);
}

function assertEqual<T>(label: string, actual: T, expected: T) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) fail(label, { expected, actual });
  pass(label, actual);
}

function assertTrue(label: string, cond: boolean, detail?: unknown) {
  if (!cond) fail(label, detail);
  pass(label);
}

async function assertThrows(label: string, fn: () => unknown, matches: (msg: string) => boolean) {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!matches(msg)) fail(label, { unexpectedError: msg });
    pass(label, msg);
    return;
  }
  fail(label, "did not throw");
}

// ---------------------------------------------------------------- demo wallets (no deps)

// bs58-compatible base58 (Bitcoin alphabet) — encode only, just enough to mint Solana-looking
// wallet addresses from ed25519 public keys without pulling in the `bs58` package here.
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(buf: Buffer): string {
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let num = 0n;
  for (const b of buf) num = (num << 8n) | BigInt(b);
  let out = "";
  while (num > 0n) {
    const rem = num % 58n;
    num /= 58n;
    out = B58_ALPHABET[Number(rem)] + out;
  }
  return "1".repeat(zeros) + out;
}

/** A demo investor wallet: a real ed25519 keypair (Node's built-in crypto), Solana-style base58
 * address, and a `signMessage` matching what a wallet's `signMessage(agreementHash)` produces
 * (SPEC section 6) — verified server-side by apps/web/lib/server/market.ts's `verifyAcceptanceSignature`. */
function makeWallet(label: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const pub = Buffer.from(jwk.x, "base64url");
  const address = base58Encode(pub);
  const signMessage = (message: string) => Buffer.from(edSign(null, Buffer.from(message), privateKey)).toString("base64");
  return { label, address, signMessage };
}

// ---------------------------------------------------------------- HTTP helpers

async function api(method: string, urlPath: string, opts: { auth?: boolean; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth) headers.authorization = `Bearer ${FS_API_TOKEN}`;
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------- dev server lifecycle

let serverProc: ChildProcess | null = null;
let startedServer = false;
let isolatedDbPath: string | null = null;
let dbUrl = "";

/** Tiny .env parser (no dotenv dependency): reads one KEY from a KEY=VALUE file, skipping comments. */
function readEnvVar(filePath: string, key: string): string | null {
  if (!existsSync(filePath)) return null;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1] !== key) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  }
  return null;
}

/** Next.js's own precedence for local env files (highest first), so we guess the SAME
 * DATABASE_URL an already-running `next dev` is using when we reuse rather than start it. */
function resolveReusedServerDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL ||
    readEnvVar(path.join(WEB_DIR, ".env.local"), "DATABASE_URL") ||
    readEnvVar(path.join(WEB_DIR, ".env"), "DATABASE_URL") ||
    "file:./dev.db"
  );
}

async function isServerUp(): Promise<boolean> {
  try {
    await fetch(`${BASE}/issuances`, { headers: { authorization: `Bearer ${FS_API_TOKEN}` } });
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, intervalMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function ensureServer() {
  if (await isServerUp()) {
    dbUrl = resolveReusedServerDatabaseUrl();
    console.log(`  server already listening on :${PORT} — reusing it (${dbUrl}); this run's rows are removed on exit`);
    startedServer = false;
    return;
  }
  console.log(`  nothing listening on :${PORT} — starting apps/web's dev server (CHAIN_MODE=fake, throwaway SQLite db)`);
  isolatedDbPath = path.join(os.tmpdir(), `fstack-demo-e2e-${process.pid}.db`);
  dbUrl = `file:${isolatedDbPath}`;
  const env = {
    ...process.env,
    DATABASE_URL: dbUrl,
    CHAIN_MODE: "fake",
    FS_API_TOKEN,
    NEXT_TELEMETRY_DISABLED: "1",
    CHECKPOINT_DISABLE: "1",
  };
  execFileSync(path.join(WEB_DIR, "node_modules", ".bin", "prisma"), ["db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: WEB_DIR,
    env,
    stdio: "inherit",
  });
  serverProc = spawn(path.join(WEB_DIR, "node_modules", ".bin", "next"), ["dev", "-p", String(PORT)], {
    cwd: WEB_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  serverProc.stdout?.on("data", (d) => (log += d.toString()));
  serverProc.stderr?.on("data", (d) => (log += d.toString()));
  const up = await waitFor(isServerUp, 90_000, 1000);
  if (!up) {
    console.error(log);
    throw new Error(`dev server did not become ready on :${PORT} within 90s`);
  }
  startedServer = true;
  console.log(`  dev server ready on :${PORT} (pid ${serverProc.pid})`);
}

async function stopServer() {
  if (!startedServer || !serverProc || !serverProc.pid) return;
  const pid = serverProc.pid;
  try {
    execFileSync("pkill", ["-P", String(pid)]);
  } catch {
    /* no children, or pkill unavailable — fine */
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 500));
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------- reset (idempotent re-runs)

const fakeChainPath = path.join(WEB_DIR, ".fake-chain.json");
let fakeChainBackup: string | null = null;

function backupFakeChain() {
  fakeChainBackup = existsSync(fakeChainPath) ? readFileSync(fakeChainPath, "utf8") : null;
}

function restoreFakeChain() {
  try {
    if (fakeChainBackup === null) {
      if (existsSync(fakeChainPath)) rmSync(fakeChainPath);
    } else {
      writeFileSync(fakeChainPath, fakeChainBackup);
    }
  } catch (e) {
    console.error(`  warning: could not restore .fake-chain.json: ${(e as Error).message}`);
  }
}

/** Mirrors scripts/agent-smoke/demo-row.mjs: delete exactly the rows this run created via Prisma. */
async function cleanupDb(issuanceId: string | null, previewId: string | null) {
  if (!issuanceId && !previewId) return;
  process.chdir(WEB_DIR);
  if (dbUrl) process.env.DATABASE_URL = dbUrl;
  const require = createRequire(path.join(WEB_DIR, "package.json"));
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  try {
    if (issuanceId) {
      // Cascades to Participant, Distribution -> Allocation (prisma/schema.prisma onDelete: Cascade).
      const r = await prisma.issuance.deleteMany({ where: { id: issuanceId } });
      console.log(`  removed ${r.count} issuance row(s) (cascades to participants/distributions/allocations)`);
    }
    if (previewId) {
      const r = await prisma.issuancePreview.deleteMany({ where: { id: previewId } });
      console.log(`  removed ${r.count} issuance-preview row(s)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

let cleanedUp = false;
async function cleanup(issuanceId: string | null, previewId: string | null) {
  if (cleanedUp) return;
  cleanedUp = true;
  step("Reset state (idempotent re-runs, safe to run again before recording)");
  try {
    await cleanupDb(issuanceId, previewId);
  } catch (e) {
    console.error(`  warning: DB cleanup failed: ${(e as Error).message}`);
  }
  restoreFakeChain();
  await stopServer();
  if (isolatedDbPath) {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try {
        rmSync(isolatedDbPath + suffix);
      } catch {
        /* not present */
      }
    }
  }
  console.log("  cleanup complete.");
}

// ---------------------------------------------------------------- main

async function main() {
  process.chdir(WEB_DIR); // fake.ts persists to <cwd>/.fake-chain.json, same cwd the dev server uses

  let issuanceId: string | null = null;
  let previewId: string | null = null;

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      await cleanup(issuanceId, previewId);
      process.exit(130);
    });
  }

  try {
    backupFakeChain();
    step(`Ensure a dev server is up on :${PORT}`);
    await ensureServer();

    const fakeChain = await import(pathToFileURL(path.join(WEB_DIR, "lib/chain/fake.ts")).href);
    // File-backed (cwd = apps/web), so swaps land in the same .fake-chain.json the dev server reads.
    const fakeSwap: (dbcPool: string, owner: string, side: "BUY" | "SELL", tokens: bigint) => { signature: string } =
      fakeChain.createFakeChain().control.swap;
    const agreementMessage = await import(pathToFileURL(path.join(WEB_DIR, "lib/server/agreement-message.ts")).href);
    const agreementAcceptanceMessage: (p: { issuanceId: string; wallet: string; agreementHash: string }) => string =
      agreementMessage.agreementAcceptanceMessage;

    // ---- 1. Launch: preview ----
    step(`Launch, in Claude Code (simulated over HTTP): Acme SaaS, 10% of quarterly DCF, ${grouped(SUPPLY)} ACME-CF (DEMO_SCALE=${DEMO_SCALE})`);
    const previewBody = {
      issuerName: "Acme SaaS, Inc.",
      symbol: "ACME-CF",
      tokenName: "Acme SaaS Cash Flow Participation Unit",
      poolPercentageBps: 1000,
      expectedAnnualDcf: sc(1_600_000n).toString(), // $1.6M/yr x scale
      tokenSupply: SUPPLY.toString(),
      targetInitialYieldBps: 1600, // 16%
      distributionFrequency: "QUARTERLY",
    };
    const preview = await api("POST", "/issuances/preview", { auth: true, body: previewBody });
    assertEqual("preview status 201", preview.status, 201);
    previewId = preview.body.previewId;
    assertTrue("previewId issued", typeof previewId === "string" && previewId.length > 0);
    assertEqual("expected annual rights pool = $160,000 x scale", preview.body.pricing.expectedAnnualRightsPool.baseUnits, (sc(160_000n) * USDC_UNIT).toString());
    assertEqual("starting market cap = $1,000,000 x scale", preview.body.pricing.startingMarketCap.display, `$${grouped(sc(1_000_000n))}`);
    assertEqual("starting price ~= $1.00/token", preview.body.pricing.startingPricePerToken.baseUnits, "1000000");
    assertEqual("graduation market cap = $3,000,000 x scale", preview.body.pricing.graduationMarketCap.display, `$${grouped(sc(3_000_000n))}`);
    assertEqual("graduation split 48/2/50", preview.body.projectedGraduation.split, { issuerPct: 48, platformPct: 2, liquidityPct: 50 });
    assertEqual("trading fee split 50/50", preview.body.fees.tradingFeeSplit, { startupPct: 50, founderStackPct: 50 });
    assertTrue("agreement hash is a sha256 hex digest", /^[0-9a-f]{64}$/.test(preview.body.agreement.hash), preview.body.agreement.hash);
    assertEqual("custody label (lib/cluster)", preview.body.custody, CLUSTERS[parseClusterName(process.env.SOLANA_CLUSTER)].copy.custody);
    const agreementHash: string = preview.body.agreement.hash;
    console.log(`  preview: $1.00/token, 48/2/50 graduation, 50/50 trading fees, agreement ${agreementHash.slice(0, 12)}...`);

    // ---- 1. Launch: create (the explicit "yes") ----
    step('Founder says "yes" — create the issuance (mint + hook + DBC pool)');
    const create = await api("POST", "/issuances", { auth: true, body: { previewId } });
    assertEqual("create status 201", create.status, 201);
    issuanceId = create.body.issuanceId;
    const baseMint: string = create.body.baseMint;
    const dbcPool: string = create.body.dbcPool;
    assertTrue("issuanceId present", typeof issuanceId === "string" && issuanceId.length > 0);
    assertTrue("baseMint present", typeof baseMint === "string" && baseMint.length > 0);
    assertTrue("dbcPool present", typeof dbcPool === "string" && dbcPool.length > 0);
    assertEqual("agreement hash unchanged from preview", create.body.agreementHash, agreementHash);
    assertEqual("status LIVE", create.body.status, "LIVE");
    const inviteCode: string = create.body.inviteCode;
    assertTrue("invite link carries the invite code", create.body.onboardUrl.endsWith(`?invite=${inviteCode}`));
    console.log(`  issuanceId ${issuanceId}`);
    console.log(`  market:  ${create.body.marketUrl}`);
    console.log(`  onboard: ${create.body.onboardUrl}`);

    // ---- 2. Hook moment: Carol, not onboarded, fails ----
    step("Hook moment, in the browser: Carol (not onboarded) tries to buy");
    const carol = makeWallet("Carol");
    const carolSwap = await api("POST", `/issuances/${issuanceId}/swap`, {
      body: { owner: carol.address, side: "BUY", amountIn: usdcBaseUnits(sc(10_000n)) },
    });
    assertEqual("swap route still returns a quote + unsigned tx (200)", carolSwap.status, 200);
    assertEqual("Carol is not a registered participant", carolSwap.body.registered, false);
    assertTrue(
      "swap response warns the buy will fail on-chain with NotEligible",
      typeof carolSwap.body.warning === "string" && carolSwap.body.warning.includes("NotEligible"),
      carolSwap.body.warning,
    );
    await assertThrows(
      "Carol's buy is rejected on-chain with NotEligible (fs_allowlist hook; fake chain's equivalent)",
      () => fakeSwap(dbcPool, carol.address, "BUY", 1_000n * TOKEN_UNIT),
      (msg) => msg.includes("NotEligible"),
    );

    // ---- 3. Buy: Alice onboards and buys 100k ----
    step(`Buy, in the browser: Alice onboards and buys ${grouped(sc(100_000n))} ACME-CF`);
    const alice = makeWallet("Alice");
    const aliceAgreementSig = alice.signMessage(agreementAcceptanceMessage({ issuanceId, wallet: alice.address, agreementHash }));
    const aliceOnboard = await api("POST", `/issuances/${issuanceId}/participants`, {
      body: { wallet: alice.address, displayName: "Alice", eligible: true, agreementHash, signature: aliceAgreementSig, invite: inviteCode },
    });
    assertEqual("Alice onboarding status 200", aliceOnboard.status, 200);
    assertEqual('Alice: "Trading enabled"', aliceOnboard.body.status, "Trading enabled");
    assertTrue("Alice allowlisted on-chain (allowlistTx recorded)", Boolean(aliceOnboard.body.participant.allowlistTx));

    const aliceQuote = await api("GET", `/issuances/${issuanceId}/quote?side=BUY&amountIn=${usdcBaseUnits(sc(100_000n))}`);
    assertEqual("quote status 200", aliceQuote.status, 200);
    assertEqual("quote pays USDC, receives ACME-CF", `${aliceQuote.body.pay.asset}->${aliceQuote.body.receive.asset}`, "USDC->ACME-CF");
    const aliceSwap = await api("POST", `/issuances/${issuanceId}/swap`, {
      body: { owner: alice.address, side: "BUY", amountIn: usdcBaseUnits(sc(100_000n)) },
    });
    assertEqual("Alice's swap route status 200", aliceSwap.status, 200);
    assertEqual("Alice is a registered participant", aliceSwap.body.registered, true);
    assertEqual("no NotEligible warning for Alice", aliceSwap.body.warning, null);
    await fakeSwap(dbcPool, alice.address, "BUY", sc(100_000n) * TOKEN_UNIT);
    pass("Alice's buy confirmed on-chain", `${grouped(sc(100_000n))} ACME-CF`);

    const holders1 = await api("GET", `/issuances/${issuanceId}/holders`, { auth: true });
    assertEqual("holders status 200", holders1.status, 200);
    const aliceRow1 = holders1.body.holders.find((h: { wallet: string }) => h.wallet === alice.address);
    assertTrue("Alice appears in the holders table", Boolean(aliceRow1));
    assertEqual("Alice holds 100,000 x scale tokens", aliceRow1.tokens.display, grouped(sc(100_000n)));
    assertEqual("Alice classified as a registered participant", aliceRow1.kind, "PARTICIPANT");
    assertEqual("Alice = 10% of supply", aliceRow1.pctOfSupply, "10%");

    // ---- 4. Q3, in Codex (simulated over HTTP) ----
    step(`Q3, in Codex: DCF $${grouped(sc(400_000n))} -> $${scUsdc(40_000n)} pool, $0.04/token`);
    const q3Report = await api("POST", `/issuances/${issuanceId}/distributions`, {
      auth: true,
      body: { periodLabel: "2026-Q3", dcf: sc(400_000n).toString(), reportUrl: "https://founderstack.dev/demo/finance/q3-2026.csv" },
    });
    assertEqual("Q3 report status 201", q3Report.status, 201);
    const q3Id: string = q3Report.body.distribution.id;
    assertEqual("Q3 rights pool = $40,000 x scale", q3Report.body.distribution.rightsPool.usdc, scUsdc(40_000n));
    assertEqual("Q3 per token = $0.04", q3Report.body.distribution.perToken.usdc, "0.04");
    assertEqual("Q3 status DRAFT", q3Report.body.distribution.status, "DRAFT");
    assertTrue("Q3 reportHash is a sha256 hex digest", /^[0-9a-f]{64}$/.test(q3Report.body.distribution.reportHash));

    const q3Snapshot = await api("POST", `/distributions/${q3Id}/snapshot`, { auth: true });
    assertEqual("Q3 snapshot status 200", q3Snapshot.status, 200);
    assertEqual("Q3 confirmTotal = 4000 x scale", q3Snapshot.body.confirmTotal, scUsdc(4_000n));
    assertEqual("Q3 unallocated (pool) = $36,000 x scale", q3Snapshot.body.unallocated.total.usdc, scUsdc(36_000n));
    const q3AliceSnap = q3Snapshot.body.rows.find((r: { wallet: string }) => r.wallet === alice.address);
    assertTrue("Alice is in the Q3 snapshot", Boolean(q3AliceSnap));
    assertEqual("Q3 snapshot: Alice previewed payout = 4000 x scale", q3AliceSnap.payout.usdc, scUsdc(4_000n));
    assertEqual("Q3 snapshot: Alice tokens = 100,000 x scale", q3AliceSnap.tokens.display, grouped(sc(100_000n)));

    const q3Execute = await api("POST", `/distributions/${q3Id}/execute`, { auth: true, body: { confirmTotal: scUsdc(4_000n) } });
    assertEqual("Q3 execute status 200", q3Execute.status, 200);
    assertEqual("Q3 distribution EXECUTED", q3Execute.body.distribution.status, "EXECUTED");
    const q3AlicePaid = q3Execute.body.rows.find((r: { wallet: string }) => r.wallet === alice.address);
    assertTrue("Alice's Q3 payout row found", Boolean(q3AlicePaid));
    assertEqual("Alice receives $4,000 x scale USDC for Q3", q3AlicePaid.payout.usdc, scUsdc(4_000n));
    assertTrue("Alice's Q3 payout is paid with a signature", q3AlicePaid.paid === true && Boolean(q3AlicePaid.txSignature));
    assertEqual("Q3: one payout signature", q3Execute.body.signatures.length, 1);
    assertTrue("Q3 signature is fake (CHAIN_MODE=fake)", q3Execute.body.signatures[0].fake === true);

    // ---- 5. Trade, in the browser ----
    step(`Trade, in the browser: Bob onboards; Alice sells ${grouped(sc(40_000n))} into the pool, Bob buys ${grouped(sc(40_000n))}`);
    await fakeSwap(dbcPool, alice.address, "SELL", sc(40_000n) * TOKEN_UNIT);
    const bob = makeWallet("Bob");
    const bobAgreementSig = bob.signMessage(agreementAcceptanceMessage({ issuanceId, wallet: bob.address, agreementHash }));
    const bobOnboard = await api("POST", `/issuances/${issuanceId}/participants`, {
      body: { wallet: bob.address, displayName: "Bob", eligible: true, agreementHash, signature: bobAgreementSig, invite: inviteCode },
    });
    assertEqual("Bob onboarding status 200", bobOnboard.status, 200);
    assertEqual('Bob: "Trading enabled"', bobOnboard.body.status, "Trading enabled");
    const bobSwap = await api("POST", `/issuances/${issuanceId}/swap`, {
      body: { owner: bob.address, side: "BUY", amountIn: usdcBaseUnits(sc(40_000n)) },
    });
    assertEqual("Bob's swap route status 200", bobSwap.status, 200);
    assertEqual("Bob is a registered participant", bobSwap.body.registered, true);
    await fakeSwap(dbcPool, bob.address, "BUY", sc(40_000n) * TOKEN_UNIT);

    const holders2 = await api("GET", `/issuances/${issuanceId}/holders`, { auth: true });
    const aliceRow2 = holders2.body.holders.find((h: { wallet: string }) => h.wallet === alice.address);
    const bobRow2 = holders2.body.holders.find((h: { wallet: string }) => h.wallet === bob.address);
    assertEqual("holders table: Alice now holds 60,000 x scale", aliceRow2.tokens.display, grouped(sc(60_000n)));
    assertEqual("holders table: Bob now holds 40,000 x scale", bobRow2.tokens.display, grouped(sc(40_000n)));

    // ---- 6. Q4, in Claude Code (simulated over HTTP) ----
    step(`Q4, in Claude Code: DCF $${grouped(sc(450_000n))} -> $${scUsdc(45_000n)} pool, $0.045/token`);
    const q4Report = await api("POST", `/issuances/${issuanceId}/distributions`, {
      auth: true,
      body: { periodLabel: "2026-Q4", dcf: sc(450_000n).toString(), reportUrl: "https://founderstack.dev/demo/finance/q4-2026.csv" },
    });
    assertEqual("Q4 report status 201", q4Report.status, 201);
    const q4Id: string = q4Report.body.distribution.id;
    assertEqual("Q4 rights pool = $45,000 x scale", q4Report.body.distribution.rightsPool.usdc, scUsdc(45_000n));
    assertEqual("Q4 per token = $0.045", q4Report.body.distribution.perToken.usdc, "0.045");

    const q4Snapshot = await api("POST", `/distributions/${q4Id}/snapshot`, { auth: true });
    assertEqual("Q4 snapshot status 200", q4Snapshot.status, 200);
    assertEqual("Q4 confirmTotal = 4500 x scale", q4Snapshot.body.confirmTotal, scUsdc(4_500n));
    const q4AliceSnap = q4Snapshot.body.rows.find((r: { wallet: string }) => r.wallet === alice.address);
    const q4BobSnap = q4Snapshot.body.rows.find((r: { wallet: string }) => r.wallet === bob.address);
    assertEqual("Q4 snapshot: Alice tokens = 60,000 x scale", q4AliceSnap.tokens.display, grouped(sc(60_000n)));
    assertEqual("Q4 snapshot: Bob tokens = 40,000 x scale", q4BobSnap.tokens.display, grouped(sc(40_000n)));

    const q4Execute = await api("POST", `/distributions/${q4Id}/execute`, { auth: true, body: { confirmTotal: scUsdc(4_500n) } });
    assertEqual("Q4 execute status 200", q4Execute.status, 200);
    const q4AlicePaid = q4Execute.body.rows.find((r: { wallet: string }) => r.wallet === alice.address);
    const q4BobPaid = q4Execute.body.rows.find((r: { wallet: string }) => r.wallet === bob.address);
    assertEqual("Alice receives $2,700 x scale USDC for Q4 (60%)", q4AlicePaid.payout.usdc, scUsdc(2_700n));
    assertEqual("Bob receives $1,800 x scale USDC for Q4 — the units Alice sold now pay Bob", q4BobPaid.payout.usdc, scUsdc(1_800n));
    assertTrue("both Q4 payouts are paid with signatures", Boolean(q4AlicePaid.txSignature) && Boolean(q4BobPaid.txSignature));

    // ---- 7. Market page / status summary ----
    step("Market page: history shows 2 periods, yield stats (matches /market/[id] and `fundraise` status)");
    const history = await api("GET", `/issuances/${issuanceId}/distributions`);
    assertEqual("history status 200", history.status, 200);
    const executedPeriods = history.body.distributions.filter((d: { status: string }) => d.status === "EXECUTED");
    assertEqual("2 periods executed", executedPeriods.length, 2);
    assertEqual(
      "period labels in order",
      executedPeriods.map((d: { periodLabel: string }) => d.periodLabel),
      ["2026-Q3", "2026-Q4"],
    );
    assertEqual("yield.periods = 2", history.body.yield.periods, 2);
    assertEqual("yield.lastPerToken = 0.045", history.body.yield.lastPerToken.usdc, "0.045");
    assertEqual("yield.ttmPerToken = 0.085", history.body.yield.ttmPerToken.usdc, "0.085");
    assertEqual("yield.annualizedRunRatePerToken = 0.18", history.body.yield.annualizedRunRatePerToken.usdc, "0.18");
    assertTrue("yield is annualized (fewer than 4 periods)", history.body.yield.isAnnualized === true);
    assertEqual("yield.annualizedNote", history.body.yield.annualizedNote, "annualized from 2 periods");

    const market = await api("GET", `/issuances/${issuanceId}/market`);
    assertEqual("market status 200", market.status, 200);
    assertEqual("market: 2 periods executed", market.body.yield.periodsExecuted, 2);
    assertEqual("market holders: 2 non-pool holders (Alice + Bob)", market.body.holders.count, 2);
    assertEqual("market holders: 2 registered participants", market.body.holders.participants, 2);
    assertEqual("market: token market cap label", market.body.tokenMarketCap.label, "Token market cap — not company valuation");

    console.log(`
  ${"-".repeat(64)}
  ${create.body.symbol}  price ${market.body.price.display}   ${market.body.progress.bar}
  Holders: ${market.body.holders.count} (participants ${market.body.holders.participants}, unregistered ${market.body.holders.unregistered})
  Trailing distribution yield: ${market.body.yield.trailingYield} (${market.body.yield.annualizedNote ?? "n/a"})
  History: ${executedPeriods.map((d: { periodLabel: string; totalAllocated: { display: string } }) => `${d.periodLabel} EXECUTED ${d.totalAllocated.display}`).join("  |  ")}
  ${"-".repeat(64)}`);

    console.log(`\nDEMO E2E: PASS (DEMO_SCALE=${DEMO_SCALE}) — Alice $${scUsdc(4_000n)} (Q3), Alice $${scUsdc(2_700n)} / Bob $${scUsdc(1_800n)} (Q4) confirmed end to end over HTTP.`);
  } catch (e) {
    failed = true;
    console.error(`\nDEMO E2E: FAIL — ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await cleanup(issuanceId, previewId);
  }

  process.exitCode = failed ? 1 : 0;
}

if (DRY_RUN) {
  import("./demo-e2e-dry-run")
    .then((m) => m.dryRun({ scale: DEMO_SCALE, supply: SUPPLY, sc }))
    .catch((e) => {
      console.error(`\nDRY RUN: FAIL — ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    });
} else main().catch((e) => {
  console.error("DEMO E2E: FAIL (unhandled)", e);
  process.exitCode = 1;
});
