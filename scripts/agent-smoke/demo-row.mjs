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
        poolPercentage: 0.1,
        tokenSupply: 1_000_000n,
        symbol: "SMOKE",
        name: "Smoke Test Cash Flow Rights",
        distributionFrequency: "QUARTERLY",
        nextRecordDate: new Date("2026-12-31T00:00:00Z"),
        expectedAnnualDcf: 120000,
        targetInitialYield: 0.12,
        agreementVersion: "smoke",
        agreementHash: "0".repeat(64),
        agreementText: "temporary smoke-test row",
        startingMarketCap: 100000,
        graduationMarketCap: 250000,
        monetization: "{}",
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
