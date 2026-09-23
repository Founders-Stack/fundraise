// Creates one fresh demo issuance per H11 run (CHAIN_MODE=fake) and prints their ids as JSON.
// Run from apps/web so the dev server and this script share .fake-chain.json and dev.db:
//   cd apps/web && pnpm exec tsx ../../demo/finance/seed-h11.ts
import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chain";
import { ACME_DEMO_TERMS, agreementHash, renderAgreement } from "@fstack/core";

const USDC = 1_000_000n;

async function main() {
  const chain = await getChain();
  if (chain.mode !== "fake") throw new Error("seed-h11 is for CHAIN_MODE=fake only");
  const out: Record<string, string> = {};
  for (const label of ["stripe", "bank", "pnl"]) {
    const symbol = `H11${label.slice(0, 2).toUpperCase()}${Date.now().toString().slice(-4)}`;
    const pool = await chain.market.createIssuancePool({
      name: `Acme SaaS ${label}`,
      symbol,
      uri: "data:,",
      tokenSupply: 1_000_000n,
      tokenDecimals: 6,
      startingMarketCap: 1_000_000n * USDC,
      graduationMarketCap: 3_000_000n * USDC,
      fees: {} as never,
      creatorLockedLiquidityPercentage: 100,
    });
    const agreement = renderAgreement(ACME_DEMO_TERMS);
    const iss = await prisma.issuance.create({
      data: {
        issuerName: "Acme SaaS, Inc.",
        poolPercentageBps: 1000,
        tokenSupply: 1_000_000n,
        symbol,
        name: `Acme SaaS Cash Flow Rights (${label})`,
        distributionFrequency: "QUARTERLY",
        nextRecordDate: new Date("2026-09-30T00:00:00Z"),
        expectedAnnualDcf: 1_600_000n * USDC,
        targetInitialYieldBps: 1600,
        agreementVersion: "cf-1.0",
        agreementHash: agreementHash(agreement),
        agreementText: agreement,
        startingMarketCap: 1_000_000n * USDC,
        graduationMarketCap: 3_000_000n * USDC,
        quoteMint: chain.payout.quoteMint(),
        baseMint: pool.baseMint,
        dbcConfig: JSON.stringify({ address: pool.dbcConfig, poolOwners: pool.poolOwners }),
        dbcPool: pool.dbcPool,
        monetization: "{}",
      },
    });
    out[label] = iss.id;
  }
  console.log(JSON.stringify(out));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
