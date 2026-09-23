#!/usr/bin/env node
// Insert or delete ONE temporary demo issuance so the smoke test has something to list.
// Usage: node scripts/agent-smoke/demo-row.mjs add|remove
// Uses the Prisma client generated for apps/web (same DB as the dev server).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "../../apps/web");
process.chdir(webDir); // so prisma resolves DATABASE_URL (file:./dev.db) relative to apps/web
const require = createRequire(path.join(webDir, "package.json"));
const { PrismaClient } = require("@prisma/client");

const ID = "agent-smoke-demo";
const prisma = new PrismaClient();
const mode = process.argv[2];
try {
  if (mode === "add") {
    await prisma.issuance.upsert({
      where: { id: ID },
      update: {},
      create: {
        id: ID,
        issuerName: "Smoke Test Coffee Co (demo row)",
        poolPercentageBps: 1000,
        tokenSupply: 1_000_000n,
        symbol: "SMOKE",
        name: "Smoke Test Cash Flow Rights",
        distributionFrequency: "QUARTERLY",
        nextRecordDate: new Date("2026-12-31T00:00:00Z"),
        expectedAnnualDcf: 120_000_000_000n,
        targetInitialYieldBps: 1200,
        agreementVersion: "smoke",
        agreementHash: "0".repeat(64),
        agreementText: "temporary smoke-test row",
        startingMarketCap: 100_000_000_000n,
        graduationMarketCap: 250_000_000_000n,
        monetization: JSON.stringify({ mode: "DEMO_PROTOCOL", graduation: { issuerPct: 48, platformPct: 2, liquidityPct: 50 }, dbcTradingFees: { creatorPct: 50, partnerPct: 50 } }),
      },
    });
    console.log(`added ${ID}`);
  } else if (mode === "remove") {
    const r = await prisma.issuance.deleteMany({ where: { id: ID } });
    console.log(`removed ${r.count} row(s)`);
  } else {
    console.error("usage: demo-row.mjs add|remove");
    process.exitCode = 2;
  }
} finally {
  await prisma.$disconnect();
}
